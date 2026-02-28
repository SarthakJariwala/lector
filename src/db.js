import Database from "@tauri-apps/plugin-sql";

let db = null;

// Simple mutex to serialize all write operations
let writeLock = Promise.resolve();
function withWriteLock(fn) {
  const next = writeLock.then(() => fn()).catch((e) => { throw e; });
  writeLock = next.catch(() => {});
  return next;
}

export async function initDb() {
  if (db) return db;
  db = await Database.load("sqlite:lector.db");
  return db;
}

export async function listFeeds() {
  const rows = await db.select("SELECT url, name, added_at FROM feeds ORDER BY added_at ASC");
  return rows.map((r) => ({ url: r.url, name: r.name, addedAt: new Date(r.added_at).toISOString() }));
}

export async function addFeed({ url, name, addedAt }) {
  const ts = new Date(addedAt).getTime();
  return withWriteLock(() =>
    db.execute("INSERT OR IGNORE INTO feeds (url, name, added_at) VALUES ($1, $2, $3)", [url, name, ts])
  );
}

export async function removeFeed(url) {
  return withWriteLock(() =>
    db.execute("DELETE FROM feeds WHERE url = $1", [url])
  );
}

export async function listArticles({ feedUrl, filter } = {}) {
  let sql = "SELECT id, feed_url, feed_name, title, link, published, published_ts, content, author, is_read, is_starred, fetched_at FROM articles";
  const conditions = [];
  const params = [];
  let paramIdx = 1;

  if (feedUrl) {
    conditions.push(`feed_url = $${paramIdx++}`);
    params.push(feedUrl);
  }
  if (filter === "unread") {
    conditions.push("is_read = 0");
  } else if (filter === "starred") {
    conditions.push("is_starred = 1");
  }

  if (conditions.length > 0) {
    sql += " WHERE " + conditions.join(" AND ");
  }
  sql += " ORDER BY published_ts DESC, fetched_at DESC";

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
  return withWriteLock(() =>
    db.execute("UPDATE articles SET is_read = 1 WHERE id = $1", [articleId])
  );
}

export async function toggleRead(articleId) {
  return withWriteLock(() =>
    db.execute("UPDATE articles SET is_read = CASE WHEN is_read = 1 THEN 0 ELSE 1 END WHERE id = $1", [articleId])
  );
}

export async function toggleStar(articleId) {
  return withWriteLock(() =>
    db.execute("UPDATE articles SET is_starred = CASE WHEN is_starred = 1 THEN 0 ELSE 1 END WHERE id = $1", [articleId])
  );
}

export async function markAllRead(articleIds) {
  if (articleIds.length === 0) return;
  return withWriteLock(() => {
    const placeholders = articleIds.map((_, i) => `$${i + 1}`).join(",");
    return db.execute(`UPDATE articles SET is_read = 1 WHERE id IN (${placeholders})`, articleIds);
  });
}

export async function importFromLocalStorageIfNeeded() {
  const rows = await db.select("SELECT value FROM meta WHERE key = 'migrated_from_localstorage'");
  if (rows.length > 0 && rows[0].value === "1") return;

  const legacyFeeds = getLocalStorage("rss-feeds");
  const legacyArticles = getLocalStorage("rss-articles");
  const legacyRead = getLocalStorage("rss-read");
  const legacyStarred = getLocalStorage("rss-starred");

  const hasData = (legacyFeeds && legacyFeeds.length > 0) || (legacyArticles && legacyArticles.length > 0);
  if (!hasData) {
    await withWriteLock(() =>
      db.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('migrated_from_localstorage', '1')")
    );
    return;
  }

  return withWriteLock(async () => {
    if (legacyFeeds) {
      for (const feed of legacyFeeds) {
        const ts = new Date(feed.addedAt || new Date().toISOString()).getTime();
        await db.execute("INSERT OR IGNORE INTO feeds (url, name, added_at) VALUES ($1, $2, $3)", [feed.url, feed.name, ts]);
      }
    }

    if (legacyArticles) {
      const now = Date.now();
      for (const a of legacyArticles) {
        const publishedTs = a.published ? new Date(a.published).getTime() || 0 : 0;
        const isRead = legacyRead && legacyRead[a.id] ? 1 : 0;
        const isStarred = legacyStarred && legacyStarred[a.id] ? 1 : 0;
        await db.execute(
          `INSERT OR IGNORE INTO articles (id, feed_url, feed_name, title, link, published, published_ts, content, author, is_read, is_starred, fetched_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [a.id, a.feedUrl, a.feedName, a.title, a.link, a.published, publishedTs, a.content, a.author, isRead, isStarred, now]
        );
      }
    }

    await db.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('migrated_from_localstorage', '1')");

    try {
      localStorage.removeItem("rss-feeds");
      localStorage.removeItem("rss-articles");
      localStorage.removeItem("rss-read");
      localStorage.removeItem("rss-starred");
    } catch {}
  });
}

function getLocalStorage(key) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : null;
  } catch {
    return null;
  }
}
