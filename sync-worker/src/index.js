const MAX_MUTATIONS_PER_REQUEST = 500;
const MAX_CHANGES_PER_REQUEST = 1000;

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return withCors(new Response(null, { status: 204 }));

    const url = new URL(request.url);
    if (url.pathname !== "/v1/sync" || request.method !== "POST") {
      return json({ error: "not_found" }, 404);
    }

    const authHeader = request.headers.get("authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!env.SYNC_TOKEN || token !== env.SYNC_TOKEN) {
      return json({ error: "unauthorized" }, 401);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid_json" }, 400);
    }

    const deviceId = typeof body.deviceId === "string" ? body.deviceId.trim() : "";
    if (!deviceId) {
      return json({ error: "device_id_required" }, 400);
    }

    const lastPulledCursor = toInt(body.lastPulledCursor, 0);
    const maxChanges = clamp(toInt(body.maxChanges, 500), 1, MAX_CHANGES_PER_REQUEST);
    const mutations = Array.isArray(body.mutations)
      ? body.mutations.slice(0, MAX_MUTATIONS_PER_REQUEST)
      : [];
    const now = Date.now();

    await upsertDevice(env.DB, {
      deviceId,
      deviceName: typeof body.deviceName === "string" ? body.deviceName : null,
      platform: typeof body.platform === "string" ? body.platform : null,
      appVersion: typeof body.appVersion === "string" ? body.appVersion : null,
      now,
    });

    const ackedMutationIds = [];
    const sortedMutations = [...mutations].sort((a, b) => toInt(a.mutationId, 0) - toInt(b.mutationId, 0));

    for (const mutation of sortedMutations) {
      const mutationId = toInt(mutation.mutationId, -1);
      if (mutationId < 1) continue;

      const seen = await env.DB.prepare(
        "SELECT 1 FROM applied_mutations WHERE device_id = ?1 AND mutation_id = ?2"
      ).bind(deviceId, mutationId).first();
      if (seen) {
        ackedMutationIds.push(mutationId);
        continue;
      }

      await applyMutation(env.DB, mutation, deviceId, now);
      await env.DB.prepare(
        "INSERT INTO applied_mutations (device_id, mutation_id, applied_at) VALUES (?1, ?2, ?3)"
      ).bind(deviceId, mutationId, now).run();
      ackedMutationIds.push(mutationId);
    }

    const rows = await env.DB.prepare(
      `SELECT seq, payload_json
       FROM change_log
       WHERE seq > ?1
       ORDER BY seq ASC
       LIMIT ?2`
    ).bind(lastPulledCursor, maxChanges).all();

    const changes = [];
    let nextCursor = lastPulledCursor;
    for (const row of rows.results || []) {
      const seq = toInt(row.seq, lastPulledCursor);
      nextCursor = Math.max(nextCursor, seq);
      let payload = {};
      try {
        payload = row.payload_json ? JSON.parse(row.payload_json) : {};
      } catch {
        payload = {};
      }
      changes.push({ seq, ...payload });
    }

    return json({
      ackedMutationIds,
      changes,
      nextCursor,
      hasMore: changes.length === maxChanges,
      serverTime: now,
      reset: false,
    });
  },
};

async function applyMutation(db, mutation, deviceId, now) {
  const type = typeof mutation.type === "string" ? mutation.type : "";
  if (type === "feed_upsert") {
    await applyFeedMutation(db, mutation, deviceId, now);
    return;
  }
  if (type === "article_read_set" || type === "article_star_set") {
    await applyArticleStateMutation(db, mutation, deviceId, now);
  }
}

async function applyFeedMutation(db, mutation, deviceId, now) {
  const feedUrl = typeof mutation.feedUrl === "string" ? mutation.feedUrl : "";
  if (!feedUrl) return;

  const changedAt = toInt(mutation.changedAt, now);
  const incomingName = typeof mutation.name === "string" ? mutation.name : "Untitled";
  const incomingSubscribed = mutation.subscribed ? 1 : 0;
  const incomingAddedAt = toInt(mutation.addedAt, changedAt);

  const existing = await db.prepare(
    `SELECT
       name,
       added_at,
       subscribed,
       name_changed_at,
       name_changed_by,
       subscription_changed_at,
       subscription_changed_by
     FROM feeds
     WHERE feed_url = ?1`
  ).bind(feedUrl).first();

  let nextRow;
  if (!existing) {
    nextRow = {
      feedUrl,
      name: incomingName,
      addedAt: incomingAddedAt,
      subscribed: incomingSubscribed,
      nameChangedAt: changedAt,
      nameChangedBy: deviceId,
      subscriptionChangedAt: changedAt,
      subscriptionChangedBy: deviceId,
    };
    await db.prepare(
      `INSERT INTO feeds (
         feed_url, name, name_changed_at, name_changed_by,
         subscribed, subscription_changed_at, subscription_changed_by, added_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
    ).bind(
      nextRow.feedUrl,
      nextRow.name,
      nextRow.nameChangedAt,
      nextRow.nameChangedBy,
      nextRow.subscribed,
      nextRow.subscriptionChangedAt,
      nextRow.subscriptionChangedBy,
      nextRow.addedAt
    ).run();
  } else {
    const currentNameChangedAt = toInt(existing.name_changed_at, 0);
    const currentNameChangedBy = existing.name_changed_by || "";
    const currentSubChangedAt = toInt(existing.subscription_changed_at, 0);
    const currentSubChangedBy = existing.subscription_changed_by || "";

    const takeName = isIncomingNewer(changedAt, deviceId, currentNameChangedAt, currentNameChangedBy);
    const takeSubscription = isIncomingNewer(changedAt, deviceId, currentSubChangedAt, currentSubChangedBy);

    const nextName = takeName ? incomingName : existing.name;
    const nextNameChangedAt = takeName ? changedAt : currentNameChangedAt;
    const nextNameChangedBy = takeName ? deviceId : currentNameChangedBy;

    const nextSubscribed = takeSubscription ? incomingSubscribed : toInt(existing.subscribed, 1);
    const nextSubChangedAt = takeSubscription ? changedAt : currentSubChangedAt;
    const nextSubChangedBy = takeSubscription ? deviceId : currentSubChangedBy;

    const currentAddedAt = toInt(existing.added_at, incomingAddedAt);
    const nextAddedAt = nextSubscribed === 1 && toInt(existing.subscribed, 1) === 0
      ? incomingAddedAt
      : currentAddedAt;

    nextRow = {
      feedUrl,
      name: nextName,
      addedAt: nextAddedAt,
      subscribed: nextSubscribed,
      nameChangedAt: nextNameChangedAt,
      nameChangedBy: nextNameChangedBy,
      subscriptionChangedAt: nextSubChangedAt,
      subscriptionChangedBy: nextSubChangedBy,
    };

    await db.prepare(
      `UPDATE feeds
       SET name = ?2,
           name_changed_at = ?3,
           name_changed_by = ?4,
           subscribed = ?5,
           subscription_changed_at = ?6,
           subscription_changed_by = ?7,
           added_at = ?8
       WHERE feed_url = ?1`
    ).bind(
      nextRow.feedUrl,
      nextRow.name,
      nextRow.nameChangedAt,
      nextRow.nameChangedBy,
      nextRow.subscribed,
      nextRow.subscriptionChangedAt,
      nextRow.subscriptionChangedBy,
      nextRow.addedAt
    ).run();
  }

  await appendChange(db, {
    entityType: "feed",
    entityId: nextRow.feedUrl,
    changedAt,
    sourceDeviceId: deviceId,
    payload: {
      type: "feed",
      feedUrl: nextRow.feedUrl,
      name: nextRow.name,
      subscribed: nextRow.subscribed === 1,
      addedAt: nextRow.addedAt,
      nameChangedAt: nextRow.nameChangedAt,
      nameChangedBy: nextRow.nameChangedBy,
      subscriptionChangedAt: nextRow.subscriptionChangedAt,
      subscriptionChangedBy: nextRow.subscriptionChangedBy,
    },
  });
}

async function applyArticleStateMutation(db, mutation, deviceId, now) {
  const articleId = typeof mutation.articleId === "string" ? mutation.articleId : "";
  const feedUrl = typeof mutation.feedUrl === "string" ? mutation.feedUrl : "";
  if (!articleId || !feedUrl) return;

  const changedAt = toInt(mutation.changedAt, now);
  const value = mutation.value ? 1 : 0;
  const isReadMutation = mutation.type === "article_read_set";

  const existing = await db.prepare(
    `SELECT
       read_value,
       read_changed_at,
       read_changed_by,
       starred_value,
       starred_changed_at,
       starred_changed_by
     FROM article_state
     WHERE article_id = ?1`
  ).bind(articleId).first();

  let nextRow;
  if (!existing) {
    nextRow = {
      articleId,
      feedUrl,
      readValue: isReadMutation ? value : 0,
      readChangedAt: isReadMutation ? changedAt : 0,
      readChangedBy: isReadMutation ? deviceId : "",
      starredValue: isReadMutation ? 0 : value,
      starredChangedAt: isReadMutation ? 0 : changedAt,
      starredChangedBy: isReadMutation ? "" : deviceId,
    };
    await db.prepare(
      `INSERT INTO article_state (
         article_id, feed_url,
         read_value, read_changed_at, read_changed_by,
         starred_value, starred_changed_at, starred_changed_by
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
    ).bind(
      nextRow.articleId,
      nextRow.feedUrl,
      nextRow.readValue,
      nextRow.readChangedAt,
      nextRow.readChangedBy,
      nextRow.starredValue,
      nextRow.starredChangedAt,
      nextRow.starredChangedBy,
    ).run();
  } else {
    let readValue = toInt(existing.read_value, 0);
    let readChangedAt = toInt(existing.read_changed_at, 0);
    let readChangedBy = existing.read_changed_by || "";
    let starredValue = toInt(existing.starred_value, 0);
    let starredChangedAt = toInt(existing.starred_changed_at, 0);
    let starredChangedBy = existing.starred_changed_by || "";

    if (isReadMutation && isIncomingNewer(changedAt, deviceId, readChangedAt, readChangedBy)) {
      readValue = value;
      readChangedAt = changedAt;
      readChangedBy = deviceId;
    }
    if (!isReadMutation && isIncomingNewer(changedAt, deviceId, starredChangedAt, starredChangedBy)) {
      starredValue = value;
      starredChangedAt = changedAt;
      starredChangedBy = deviceId;
    }

    nextRow = {
      articleId,
      feedUrl,
      readValue,
      readChangedAt,
      readChangedBy,
      starredValue,
      starredChangedAt,
      starredChangedBy,
    };

    await db.prepare(
      `UPDATE article_state
       SET feed_url = ?2,
           read_value = ?3,
           read_changed_at = ?4,
           read_changed_by = ?5,
           starred_value = ?6,
           starred_changed_at = ?7,
           starred_changed_by = ?8
       WHERE article_id = ?1`
    ).bind(
      nextRow.articleId,
      nextRow.feedUrl,
      nextRow.readValue,
      nextRow.readChangedAt,
      nextRow.readChangedBy,
      nextRow.starredValue,
      nextRow.starredChangedAt,
      nextRow.starredChangedBy,
    ).run();
  }

  await appendChange(db, {
    entityType: "article_state",
    entityId: nextRow.articleId,
    changedAt,
    sourceDeviceId: deviceId,
    payload: {
      type: "article_state",
      articleId: nextRow.articleId,
      feedUrl: nextRow.feedUrl,
      read: nextRow.readValue === 1,
      readChangedAt: nextRow.readChangedAt,
      readChangedBy: nextRow.readChangedBy,
      starred: nextRow.starredValue === 1,
      starredChangedAt: nextRow.starredChangedAt,
      starredChangedBy: nextRow.starredChangedBy,
    },
  });
}

async function appendChange(db, { entityType, entityId, payload, changedAt, sourceDeviceId }) {
  await db.prepare(
    `INSERT INTO change_log (entity_type, entity_id, payload_json, changed_at, source_device_id)
     VALUES (?1, ?2, ?3, ?4, ?5)`
  ).bind(entityType, entityId, JSON.stringify(payload), changedAt, sourceDeviceId).run();
}

async function upsertDevice(db, { deviceId, deviceName, platform, appVersion, now }) {
  const existing = await db.prepare("SELECT device_id FROM devices WHERE device_id = ?1").bind(deviceId).first();
  if (existing) {
    await db.prepare(
      `UPDATE devices
       SET name = COALESCE(?2, name),
           platform = COALESCE(?3, platform),
           app_version = COALESCE(?4, app_version),
           last_seen_at = ?5
       WHERE device_id = ?1`
    ).bind(deviceId, deviceName, platform, appVersion, now).run();
    return;
  }

  await db.prepare(
    `INSERT INTO devices (device_id, name, platform, app_version, created_at, last_seen_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?5)`
  ).bind(deviceId, deviceName, platform, appVersion, now).run();
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

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function json(payload, status = 200) {
  return withCors(new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  }));
}

function withCors(response) {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-headers", "authorization, content-type");
  headers.set("access-control-allow-methods", "POST, OPTIONS");
  return new Response(response.body, { status: response.status, headers });
}
