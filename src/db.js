import Database from "@tauri-apps/plugin-sql";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

let db = null;

const ARTICLE_STATE_BACKFILLED_META_KEY = "article_state_backfilled_v1";
const LEGACY_MIGRATED_META_KEY = "migrated_from_localstorage";
const SYNC_DEVICE_ID_META_KEY = "sync_device_id";
const SYNC_NEXT_MUTATION_ID_META_KEY = "sync_next_mutation_id";
const SYNC_LAST_CURSOR_META_KEY = "sync_last_pulled_cursor";
const SYNC_LOGICAL_CLOCK_META_KEY = "sync_logical_clock_ms";
const SYNC_ENDPOINT_META_KEY = "sync_endpoint";
const SYNC_TOKEN_META_KEY = "sync_token";

const BACKFILL_ACTOR = "migration";
const DEV_SYNC_ENDPOINT = import.meta.env.DEV
  ? (import.meta.env.VITE_SYNC_ENDPOINT || "").trim()
  : "";
const DEV_SYNC_TOKEN = import.meta.env.DEV
  ? (import.meta.env.VITE_SYNC_TOKEN || "").trim()
  : "";
const MAX_SYNC_MUTATIONS = 200;
const MAX_SYNC_CHANGES = 500;
let runtimeSyncConfig = {
  endpoint: "",
  token: "",
};

// Simple mutex to serialize all write operations
let writeLock = Promise.resolve();
function withWriteLock(fn) {
  const next = writeLock.then(() => fn()).catch((e) => {
    throw e;
  });
  writeLock = next.catch(() => {});
  return next;
}

export function isSyncConfigured() {
  return !!runtimeSyncConfig.endpoint && !!runtimeSyncConfig.token;
}

export async function getSyncConfig() {
  if (!db) await initDb();
  return { ...runtimeSyncConfig };
}

export async function setSyncConfig({ endpoint, token }) {
  if (!db) await initDb();

  const normalizedEndpoint = normalizeEndpoint(endpoint);
  const normalizedToken = (token || "").trim();

  await withWriteLock(async () => {
    if (normalizedEndpoint) {
      await setMetaValue(SYNC_ENDPOINT_META_KEY, normalizedEndpoint);
    } else {
      await deleteMetaValue(SYNC_ENDPOINT_META_KEY);
    }

    if (normalizedToken) {
      await setMetaValue(SYNC_TOKEN_META_KEY, normalizedToken);
    } else {
      await deleteMetaValue(SYNC_TOKEN_META_KEY);
    }
  });

  runtimeSyncConfig = {
    endpoint: normalizedEndpoint,
    token: normalizedToken,
  };

  return { ...runtimeSyncConfig };
}

export async function initDb() {
  if (db) return db;
  db = await Database.load("sqlite:lector.db");
  await backfillArticleStateIfNeeded();
  await ensureSyncMetaDefaults();
  await loadRuntimeSyncConfig();
  return db;
}

export async function listFeeds() {
  const rows = await db.select("SELECT url, name, added_at FROM feeds WHERE subscribed = 1 ORDER BY added_at ASC");
  return rows.map((r) => ({ url: r.url, name: r.name, addedAt: new Date(r.added_at).toISOString() }));
}

export async function addFeed({ url, name, addedAt }) {
  const ts = new Date(addedAt).getTime();
  return withWriteLock(async () => {
    const deviceId = await getOrCreateDeviceId();
    const changedAt = await nextLogicalTimestamp();

    await db.execute(
      `INSERT INTO feeds (
         url, name, added_at, subscribed,
         subscription_changed_at, subscription_changed_by,
         name_changed_at, name_changed_by
       ) VALUES ($1, $2, $3, 1, $4, $5, $4, $5)
       ON CONFLICT(url) DO UPDATE SET
         name = excluded.name,
         added_at = CASE WHEN feeds.subscribed = 0 THEN excluded.added_at ELSE feeds.added_at END,
         subscribed = 1,
         subscription_changed_at = excluded.subscription_changed_at,
         subscription_changed_by = excluded.subscription_changed_by,
         name_changed_at = excluded.name_changed_at,
         name_changed_by = excluded.name_changed_by`,
      [url, name, ts, changedAt, deviceId]
    );

    await enqueueMutation(
      "feed_upsert",
      url,
      { feedUrl: url, name, subscribed: true, addedAt: ts, changedAt },
      deviceId
    );
  });
}

export async function removeFeed(url) {
  return withWriteLock(async () => {
    const rows = await db.select("SELECT name, added_at FROM feeds WHERE url = $1", [url]);
    if (rows.length === 0) return;

    const deviceId = await getOrCreateDeviceId();
    const changedAt = await nextLogicalTimestamp();
    const name = rows[0].name || "Untitled";
    const addedAt = Number(rows[0].added_at) || changedAt;

    await db.execute(
      "UPDATE feeds SET subscribed = 0, subscription_changed_at = $2, subscription_changed_by = $3 WHERE url = $1",
      [url, changedAt, deviceId]
    );
    await db.execute("DELETE FROM articles WHERE feed_url = $1", [url]);
    await db.execute("DELETE FROM article_state WHERE feed_url = $1", [url]);

    await enqueueMutation(
      "feed_upsert",
      url,
      { feedUrl: url, name, subscribed: false, addedAt, changedAt },
      deviceId
    );
  });
}

export async function renameFeed(url, newName) {
  return withWriteLock(async () => {
    const existing = await db.select("SELECT added_at, subscribed FROM feeds WHERE url = $1", [url]);
    if (existing.length === 0) return;

    const deviceId = await getOrCreateDeviceId();
    const changedAt = await nextLogicalTimestamp();
    const subscribed = !!existing[0].subscribed;
    const addedAt = Number(existing[0].added_at) || changedAt;

    await db.execute(
      "UPDATE feeds SET name = $1, name_changed_at = $3, name_changed_by = $4 WHERE url = $2",
      [newName, url, changedAt, deviceId]
    );
    await db.execute("UPDATE articles SET feed_name = $1 WHERE feed_url = $2", [newName, url]);

    await enqueueMutation(
      "feed_upsert",
      url,
      { feedUrl: url, name: newName, subscribed, addedAt, changedAt },
      deviceId
    );
  });
}

export async function listArticles({ feedUrl, filter } = {}) {
  const readExpr = "COALESCE(s.read_value, a.is_read, 0)";
  const starredExpr = "COALESCE(s.starred_value, a.is_starred, 0)";
  let sql = `SELECT
    a.id,
    a.feed_url,
    a.feed_name,
    a.title,
    a.link,
    a.published,
    a.published_ts,
    a.content,
    a.author,
    ${readExpr} AS is_read,
    ${starredExpr} AS is_starred,
    a.fetched_at
  FROM articles a
  LEFT JOIN article_state s ON s.article_id = a.id`;
  const conditions = [];
  const params = [];
  let paramIdx = 1;

  if (feedUrl) {
    conditions.push(`a.feed_url = $${paramIdx++}`);
    params.push(feedUrl);
  }
  if (filter === "unread") {
    conditions.push(`${readExpr} = 0`);
  } else if (filter === "starred") {
    conditions.push(`${starredExpr} = 1`);
  }

  if (conditions.length > 0) {
    sql += " WHERE " + conditions.join(" AND ");
  }
  sql += " ORDER BY a.published_ts DESC, a.fetched_at DESC";

  const rows = await db.select(sql, params);
  return rows.map(rowToArticle);
}

function rowToArticle(r) {
  return {
    id: r.id,
    feedUrl: r.feed_url,
    feedName: r.feed_name,
    title: r.title,
    link: r.link,
    published: r.published,
    content: r.content,
    author: r.author,
    is_read: !!r.is_read,
    is_starred: !!r.is_starred,
  };
}

export async function upsertArticles(feedUrl, feedName, items) {
  return withWriteLock(async () => {
    const now = Date.now();
    for (const item of items) {
      const id = `${feedUrl}::${item.link || item.title}`;
      const publishedTs = item.published ? new Date(item.published).getTime() || 0 : 0;
      await db.execute(
        `INSERT INTO articles (id, feed_url, feed_name, title, link, published, published_ts, content, author, fetched_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT(id) DO UPDATE SET
           feed_name = $3, title = $4, link = $5, published = $6, published_ts = $7,
           content = $8, author = $9, fetched_at = $10`,
        [id, feedUrl, feedName, item.title, item.link, item.published, publishedTs, item.content, item.author, now]
      );
    }

    // Prune per-feed (not globally) so adding/refreshing one feed can't wipe another
    await db.execute(
      `DELETE FROM articles
       WHERE is_starred = 0
         AND feed_url = $1
         AND id NOT IN (
           SELECT id FROM articles
           WHERE is_starred = 0 AND feed_url = $1
           ORDER BY published_ts DESC, fetched_at DESC
           LIMIT 500
         )`,
      [feedUrl]
    );
  });
}

export async function markRead(articleId) {
  return withWriteLock(async () => {
    const deviceId = await getOrCreateDeviceId();
    const changedAt = await nextLogicalTimestamp();
    await ensureArticleStateRows([articleId]);
    await db.execute(
      "UPDATE article_state SET read_value = 1, read_changed_at = $2, read_changed_by = $3 WHERE article_id = $1",
      [articleId, changedAt, deviceId]
    );
    await db.execute("UPDATE articles SET is_read = 1 WHERE id = $1", [articleId]);
    await enqueueArticleMutation(articleId, "article_read_set", true, changedAt, deviceId);
  });
}

export async function toggleRead(articleId) {
  return withWriteLock(async () => {
    const deviceId = await getOrCreateDeviceId();
    const changedAt = await nextLogicalTimestamp();
    await ensureArticleStateRows([articleId]);
    await db.execute(
      `UPDATE article_state
       SET read_value = CASE WHEN read_value = 1 THEN 0 ELSE 1 END,
           read_changed_at = $2,
           read_changed_by = $3
       WHERE article_id = $1`,
      [articleId, changedAt, deviceId]
    );

    const rows = await db.select("SELECT read_value FROM article_state WHERE article_id = $1", [articleId]);
    const isRead = !!rows[0]?.read_value;
    await db.execute("UPDATE articles SET is_read = $2 WHERE id = $1", [articleId, isRead ? 1 : 0]);
    await enqueueArticleMutation(articleId, "article_read_set", isRead, changedAt, deviceId);
  });
}

export async function toggleStar(articleId) {
  return withWriteLock(async () => {
    const deviceId = await getOrCreateDeviceId();
    const changedAt = await nextLogicalTimestamp();
    await ensureArticleStateRows([articleId]);
    await db.execute(
      `UPDATE article_state
       SET starred_value = CASE WHEN starred_value = 1 THEN 0 ELSE 1 END,
           starred_changed_at = $2,
           starred_changed_by = $3
       WHERE article_id = $1`,
      [articleId, changedAt, deviceId]
    );

    const rows = await db.select("SELECT starred_value FROM article_state WHERE article_id = $1", [articleId]);
    const isStarred = !!rows[0]?.starred_value;
    await db.execute("UPDATE articles SET is_starred = $2 WHERE id = $1", [articleId, isStarred ? 1 : 0]);
    await enqueueArticleMutation(articleId, "article_star_set", isStarred, changedAt, deviceId);
  });
}

export async function markAllRead(articleIds) {
  if (articleIds.length === 0) return;

  return withWriteLock(async () => {
    const deviceId = await getOrCreateDeviceId();
    const changedAt = await nextLogicalTimestamp();
    await ensureArticleStateRows(articleIds);

    const placeholders = articleIds.map((_, i) => `$${i + 1}`).join(",");
    await db.execute(
      `UPDATE article_state
       SET read_value = 1,
           read_changed_at = $${articleIds.length + 1},
           read_changed_by = $${articleIds.length + 2}
       WHERE article_id IN (${placeholders})`,
      [...articleIds, changedAt, deviceId]
    );
    await db.execute(`UPDATE articles SET is_read = 1 WHERE id IN (${placeholders})`, articleIds);

    const stateRows = await db.select(
      `SELECT article_id, feed_url
       FROM article_state
       WHERE article_id IN (${placeholders})`,
      articleIds
    );
    for (const row of stateRows) {
      await enqueueMutation(
        "article_read_set",
        row.article_id,
        { articleId: row.article_id, feedUrl: row.feed_url, value: true, changedAt },
        deviceId
      );
    }
  });
}

export async function syncStateWithServer({
  maxMutations = MAX_SYNC_MUTATIONS,
  maxChanges = MAX_SYNC_CHANGES,
} = {}) {
  await initDb();

  const syncConfig = await getSyncConfig();
  if (!syncConfig.endpoint || !syncConfig.token) {
    return { skipped: true, reason: "not_configured" };
  }

  const deviceId = await getOrCreateDeviceId();
  const lastCursor = toInt(await getMetaValue(SYNC_LAST_CURSOR_META_KEY), 0);
  const outboxRows = await db.select(
    `SELECT mutation_id, type, payload_json
     FROM sync_outbox
     WHERE device_id = $1
     ORDER BY mutation_id ASC
     LIMIT $2`,
    [deviceId, maxMutations]
  );

  const mutations = outboxRows.map((row) => {
    let payload = {};
    try {
      payload = row.payload_json ? JSON.parse(row.payload_json) : {};
    } catch {
      payload = {};
    }
    return { mutationId: row.mutation_id, type: row.type, ...payload };
  });

  const resp = await tauriFetch(syncConfig.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${syncConfig.token}`,
    },
    body: JSON.stringify({
      deviceId,
      lastPulledCursor: lastCursor,
      maxChanges,
      mutations,
    }),
    connectTimeout: 12000,
  });
  if (!resp.ok) throw new Error(`Sync failed with HTTP ${resp.status}`);

  let payload = {};
  try {
    const text = await resp.text();
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new Error("Sync response was not valid JSON");
  }

  const ackedMutationIds = Array.isArray(payload.ackedMutationIds)
    ? payload.ackedMutationIds.map((id) => toInt(id, -1)).filter((id) => id > 0)
    : [];
  const changes = Array.isArray(payload.changes) ? payload.changes : [];
  const nextCursor = toInt(payload.nextCursor, lastCursor);

  await withWriteLock(async () => {
    if (ackedMutationIds.length > 0) {
      const placeholders = ackedMutationIds.map((_, i) => `$${i + 2}`).join(",");
      await db.execute(
        `DELETE FROM sync_outbox
         WHERE device_id = $1 AND mutation_id IN (${placeholders})`,
        [deviceId, ...ackedMutationIds]
      );
    }

    for (const change of changes) {
      await applyRemoteChange(change);
    }

    await setMetaValue(SYNC_LAST_CURSOR_META_KEY, String(nextCursor));
  });

  return {
    skipped: false,
    ackedMutations: ackedMutationIds.length,
    appliedChanges: changes.length,
    nextCursor,
  };
}

export async function importFromLocalStorageIfNeeded() {
  const rows = await db.select("SELECT value FROM meta WHERE key = $1", [LEGACY_MIGRATED_META_KEY]);
  if (rows.length > 0 && rows[0].value === "1") return;

  const legacyFeeds = getLocalStorage("rss-feeds");
  const legacyArticles = getLocalStorage("rss-articles");
  const legacyRead = getLocalStorage("rss-read");
  const legacyStarred = getLocalStorage("rss-starred");

  const hasData =
    (legacyFeeds && legacyFeeds.length > 0) ||
    (legacyArticles && legacyArticles.length > 0);
  if (!hasData) {
    await withWriteLock(() =>
      db.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ($1, '1')", [LEGACY_MIGRATED_META_KEY])
    );
    return;
  }

  return withWriteLock(async () => {
    if (legacyFeeds) {
      for (const feed of legacyFeeds) {
        const ts = new Date(feed.addedAt || new Date().toISOString()).getTime();
        await db.execute(
          `INSERT OR IGNORE INTO feeds (
             url, name, added_at, subscribed,
             subscription_changed_at, subscription_changed_by,
             name_changed_at, name_changed_by
           ) VALUES ($1, $2, $3, 1, $4, $5, $4, $5)`,
          [feed.url, feed.name, ts, ts, BACKFILL_ACTOR]
        );
      }
    }

    if (legacyArticles) {
      const now = Date.now();
      for (const a of legacyArticles) {
        const publishedTs = a.published ? new Date(a.published).getTime() || 0 : 0;
        const isRead = legacyRead && legacyRead[a.id] ? 1 : 0;
        const isStarred = legacyStarred && legacyStarred[a.id] ? 1 : 0;

        await db.execute(
          `INSERT OR IGNORE INTO articles (
             id, feed_url, feed_name, title, link, published,
             published_ts, content, author, is_read, is_starred, fetched_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            a.id,
            a.feedUrl,
            a.feedName,
            a.title,
            a.link,
            a.published,
            publishedTs,
            a.content,
            a.author,
            isRead,
            isStarred,
            now,
          ]
        );

        if (isRead || isStarred) {
          await db.execute(
            `INSERT OR IGNORE INTO article_state (
               article_id, feed_url,
               read_value, read_changed_at, read_changed_by,
               starred_value, starred_changed_at, starred_changed_by
             ) VALUES ($1, $2, $3, $4, $5, $6, $4, $5)`,
            [a.id, a.feedUrl, isRead, now, BACKFILL_ACTOR, isStarred]
          );
        }
      }
    }

    await db.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ($1, '1')", [ARTICLE_STATE_BACKFILLED_META_KEY]);
    await db.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ($1, '1')", [LEGACY_MIGRATED_META_KEY]);

    try {
      localStorage.removeItem("rss-feeds");
      localStorage.removeItem("rss-articles");
      localStorage.removeItem("rss-read");
      localStorage.removeItem("rss-starred");
    } catch {}
  });
}

async function applyRemoteChange(change) {
  if (!change || typeof change !== "object") return;
  if (change.type === "feed") {
    await applyRemoteFeedChange(change);
    return;
  }
  if (change.type === "article_state") {
    await applyRemoteArticleStateChange(change);
  }
}

async function applyRemoteFeedChange(change) {
  const feedUrl = typeof change.feedUrl === "string" ? change.feedUrl : "";
  if (!feedUrl) return;

  const incomingName = typeof change.name === "string" ? change.name : "Untitled";
  const incomingAddedAt = toInt(change.addedAt, Date.now());
  const incomingSubscribed = change.subscribed ? 1 : 0;

  const incomingNameChangedAt = toInt(change.nameChangedAt ?? change.changedAt, 0);
  const incomingNameChangedBy = String(change.nameChangedBy ?? change.changedBy ?? "");
  const incomingSubChangedAt = toInt(change.subscriptionChangedAt ?? change.changedAt, 0);
  const incomingSubChangedBy = String(change.subscriptionChangedBy ?? change.changedBy ?? "");

  const existingRows = await db.select(
    `SELECT
       name,
       added_at,
       subscribed,
       name_changed_at,
       name_changed_by,
       subscription_changed_at,
       subscription_changed_by
     FROM feeds
     WHERE url = $1`,
    [feedUrl]
  );

  let finalSubscribed = incomingSubscribed;

  if (existingRows.length === 0) {
    await db.execute(
      `INSERT INTO feeds (
         url, name, added_at, subscribed,
         subscription_changed_at, subscription_changed_by,
         name_changed_at, name_changed_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        feedUrl,
        incomingName,
        incomingAddedAt,
        incomingSubscribed,
        incomingSubChangedAt,
        incomingSubChangedBy,
        incomingNameChangedAt,
        incomingNameChangedBy,
      ]
    );
  } else {
    const existing = existingRows[0];

    let nextName = existing.name;
    let nextNameChangedAt = toInt(existing.name_changed_at, 0);
    let nextNameChangedBy = existing.name_changed_by || "";
    if (isIncomingNewer(incomingNameChangedAt, incomingNameChangedBy, nextNameChangedAt, nextNameChangedBy)) {
      nextName = incomingName;
      nextNameChangedAt = incomingNameChangedAt;
      nextNameChangedBy = incomingNameChangedBy;
    }

    let nextSubscribed = toInt(existing.subscribed, 1);
    let nextSubChangedAt = toInt(existing.subscription_changed_at, 0);
    let nextSubChangedBy = existing.subscription_changed_by || "";
    if (isIncomingNewer(incomingSubChangedAt, incomingSubChangedBy, nextSubChangedAt, nextSubChangedBy)) {
      nextSubscribed = incomingSubscribed;
      nextSubChangedAt = incomingSubChangedAt;
      nextSubChangedBy = incomingSubChangedBy;
    }

    const existingAddedAt = toInt(existing.added_at, incomingAddedAt);
    const nextAddedAt = nextSubscribed === 1 && toInt(existing.subscribed, 1) === 0
      ? incomingAddedAt
      : existingAddedAt;

    await db.execute(
      `UPDATE feeds
       SET name = $2,
           added_at = $3,
           subscribed = $4,
           subscription_changed_at = $5,
           subscription_changed_by = $6,
           name_changed_at = $7,
           name_changed_by = $8
       WHERE url = $1`,
      [
        feedUrl,
        nextName,
        nextAddedAt,
        nextSubscribed,
        nextSubChangedAt,
        nextSubChangedBy,
        nextNameChangedAt,
        nextNameChangedBy,
      ]
    );

    finalSubscribed = nextSubscribed;
  }

  if (finalSubscribed === 0) {
    await db.execute("DELETE FROM articles WHERE feed_url = $1", [feedUrl]);
    await db.execute("DELETE FROM article_state WHERE feed_url = $1", [feedUrl]);
  }
}

async function applyRemoteArticleStateChange(change) {
  const articleId = typeof change.articleId === "string" ? change.articleId : "";
  if (!articleId) return;

  const feedUrl = typeof change.feedUrl === "string" ? change.feedUrl : "";
  const incomingReadValue = change.read ? 1 : 0;
  const incomingStarredValue = change.starred ? 1 : 0;
  const incomingReadChangedAt = toInt(change.readChangedAt ?? change.changedAt, 0);
  const incomingReadChangedBy = String(change.readChangedBy ?? change.changedBy ?? "");
  const incomingStarChangedAt = toInt(change.starredChangedAt ?? change.changedAt, 0);
  const incomingStarChangedBy = String(change.starredChangedBy ?? change.changedBy ?? "");

  const existingRows = await db.select(
    `SELECT
       feed_url,
       read_value,
       read_changed_at,
       read_changed_by,
       starred_value,
       starred_changed_at,
       starred_changed_by
     FROM article_state
     WHERE article_id = $1`,
    [articleId]
  );

  if (existingRows.length === 0) {
    await db.execute(
      `INSERT INTO article_state (
         article_id, feed_url,
         read_value, read_changed_at, read_changed_by,
         starred_value, starred_changed_at, starred_changed_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        articleId,
        feedUrl,
        incomingReadValue,
        incomingReadChangedAt,
        incomingReadChangedBy,
        incomingStarredValue,
        incomingStarChangedAt,
        incomingStarChangedBy,
      ]
    );
    await db.execute("UPDATE articles SET is_read = $2, is_starred = $3 WHERE id = $1", [
      articleId,
      incomingReadValue,
      incomingStarredValue,
    ]);
    return;
  }

  const existing = existingRows[0];

  let nextReadValue = toInt(existing.read_value, 0);
  let nextReadChangedAt = toInt(existing.read_changed_at, 0);
  let nextReadChangedBy = existing.read_changed_by || "";
  if (isIncomingNewer(incomingReadChangedAt, incomingReadChangedBy, nextReadChangedAt, nextReadChangedBy)) {
    nextReadValue = incomingReadValue;
    nextReadChangedAt = incomingReadChangedAt;
    nextReadChangedBy = incomingReadChangedBy;
  }

  let nextStarValue = toInt(existing.starred_value, 0);
  let nextStarChangedAt = toInt(existing.starred_changed_at, 0);
  let nextStarChangedBy = existing.starred_changed_by || "";
  if (isIncomingNewer(incomingStarChangedAt, incomingStarChangedBy, nextStarChangedAt, nextStarChangedBy)) {
    nextStarValue = incomingStarredValue;
    nextStarChangedAt = incomingStarChangedAt;
    nextStarChangedBy = incomingStarChangedBy;
  }

  await db.execute(
    `UPDATE article_state
     SET feed_url = $2,
         read_value = $3,
         read_changed_at = $4,
         read_changed_by = $5,
         starred_value = $6,
         starred_changed_at = $7,
         starred_changed_by = $8
     WHERE article_id = $1`,
    [
      articleId,
      feedUrl || existing.feed_url,
      nextReadValue,
      nextReadChangedAt,
      nextReadChangedBy,
      nextStarValue,
      nextStarChangedAt,
      nextStarChangedBy,
    ]
  );
  await db.execute("UPDATE articles SET is_read = $2, is_starred = $3 WHERE id = $1", [
    articleId,
    nextReadValue,
    nextStarValue,
  ]);
}

async function backfillArticleStateIfNeeded() {
  const rows = await db.select("SELECT value FROM meta WHERE key = $1", [ARTICLE_STATE_BACKFILLED_META_KEY]);
  if (rows.length > 0 && rows[0].value === "1") return;

  await withWriteLock(async () => {
    await db.execute(
      `INSERT OR IGNORE INTO article_state (
        article_id, feed_url,
        read_value, read_changed_at, read_changed_by,
        starred_value, starred_changed_at, starred_changed_by
      )
      SELECT id, feed_url, is_read, 0, $1, is_starred, 0, $1
      FROM articles
      WHERE is_read = 1 OR is_starred = 1`,
      [BACKFILL_ACTOR]
    );

    await db.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ($1, '1')", [ARTICLE_STATE_BACKFILLED_META_KEY]);
  });
}

async function ensureArticleStateRows(articleIds) {
  if (articleIds.length === 0) return;
  const placeholders = articleIds.map((_, i) => `$${i + 1}`).join(",");
  await db.execute(
    `INSERT OR IGNORE INTO article_state (
      article_id, feed_url,
      read_value, read_changed_at, read_changed_by,
      starred_value, starred_changed_at, starred_changed_by
    )
    SELECT id, feed_url, is_read, 0, $${articleIds.length + 1}, is_starred, 0, $${articleIds.length + 1}
    FROM articles
    WHERE id IN (${placeholders})`,
    [...articleIds, BACKFILL_ACTOR]
  );
}

async function enqueueArticleMutation(articleId, type, value, changedAt, deviceId) {
  const rows = await db.select("SELECT feed_url FROM article_state WHERE article_id = $1", [articleId]);
  const feedUrl = rows[0]?.feed_url;
  if (!feedUrl) return;

  await enqueueMutation(
    type,
    articleId,
    { articleId, feedUrl, value: !!value, changedAt },
    deviceId
  );
}

async function enqueueMutation(type, entityId, payload, deviceId = null) {
  const resolvedDeviceId = deviceId || await getOrCreateDeviceId();
  const mutationId = await nextMutationId();
  const createdAt = Date.now();
  await db.execute(
    `INSERT INTO sync_outbox (device_id, mutation_id, type, entity_id, payload_json, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [resolvedDeviceId, mutationId, type, entityId, JSON.stringify(payload), createdAt]
  );
}

async function ensureSyncMetaDefaults() {
  await withWriteLock(async () => {
    await ensureMetaValue(SYNC_NEXT_MUTATION_ID_META_KEY, "1");
    await ensureMetaValue(SYNC_LAST_CURSOR_META_KEY, "0");
    await ensureMetaValue(SYNC_LOGICAL_CLOCK_META_KEY, "0");
    await getOrCreateDeviceId();
  });
}

async function getOrCreateDeviceId() {
  const existing = await getMetaValue(SYNC_DEVICE_ID_META_KEY);
  if (existing) return existing;

  const generated = globalThis.crypto?.randomUUID?.()
    || `device-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await setMetaValue(SYNC_DEVICE_ID_META_KEY, generated);
  return generated;
}

async function nextMutationId() {
  const current = toInt(await ensureMetaValue(SYNC_NEXT_MUTATION_ID_META_KEY, "1"), 1);
  await setMetaValue(SYNC_NEXT_MUTATION_ID_META_KEY, String(current + 1));
  return current;
}

async function nextLogicalTimestamp() {
  const now = Date.now();
  const current = toInt(await ensureMetaValue(SYNC_LOGICAL_CLOCK_META_KEY, "0"), 0);
  const next = Math.max(now, current + 1);
  await setMetaValue(SYNC_LOGICAL_CLOCK_META_KEY, String(next));
  return next;
}

async function loadRuntimeSyncConfig() {
  const storedEndpoint = (await getMetaValue(SYNC_ENDPOINT_META_KEY) || "").trim();
  const storedToken = (await getMetaValue(SYNC_TOKEN_META_KEY) || "").trim();
  runtimeSyncConfig = {
    endpoint: normalizeEndpoint(storedEndpoint || DEV_SYNC_ENDPOINT),
    token: storedToken || DEV_SYNC_TOKEN,
  };
}

async function getMetaValue(key) {
  const rows = await db.select("SELECT value FROM meta WHERE key = $1", [key]);
  return rows.length > 0 ? rows[0].value : null;
}

async function setMetaValue(key, value) {
  await db.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ($1, $2)", [key, String(value)]);
}

async function deleteMetaValue(key) {
  await db.execute("DELETE FROM meta WHERE key = $1", [key]);
}

async function ensureMetaValue(key, defaultValue) {
  const value = await getMetaValue(key);
  if (value !== null && value !== undefined) return value;
  await setMetaValue(key, defaultValue);
  return defaultValue;
}

function isIncomingNewer(incomingAt, incomingBy, currentAt, currentBy) {
  if (incomingAt > currentAt) return true;
  if (incomingAt < currentAt) return false;
  return String(incomingBy) > String(currentBy);
}

function toInt(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function normalizeEndpoint(endpoint) {
  const trimmed = (endpoint || "").trim();
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

function getLocalStorage(key) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : null;
  } catch {
    return null;
  }
}
