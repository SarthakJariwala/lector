import { createRemoteJWKSet, jwtVerify } from "jose";

const MAX_BODY_BYTES = 3 * 1024 * 1024;
const MAX_MUTATIONS_PER_REQUEST = 200;
const MAX_CHANGES_PER_REQUEST = 1000;
const MAX_FEED_BYTES = 2 * 1024 * 1024;
const MAX_STRING = 2048;
const MAX_ARTICLE_ID = 8192;
const ACCESS_JWKS = new Map();
const MUTATION_TYPES = new Set(["feed_upsert", "article_read_set", "article_star_set"]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const host = url.host.toLowerCase();

    if (host === normalizedHost(env.APP_HOST)) return handleAppRequest(request, url, env);
    if (host === normalizedHost(env.DESKTOP_SYNC_HOST)) return handleDesktopRequest(request, url, env);
    return json({ error: "not_found" }, 404);
  },
};

async function handleAppRequest(request, url, env) {
  if (request.method === "POST" && (url.pathname === "/api/v1/sync" || url.pathname === "/api/v1/feed")) {
    if (request.headers.get("origin") !== env.APP_ORIGIN) return json({ error: "forbidden_origin" }, 403);
    const authError = await authenticateAccess(request, env);
    if (authError) return authError;
    if (url.pathname === "/api/v1/feed") return handleFeed(request);
    return handleSync(request, env);
  }

  if (url.pathname.startsWith("/api/")) return json({ error: "not_found" }, 404);
  if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "not_found" }, 404);
  const response = await env.ASSETS.fetch(request);
  return withSecurityHeaders(response);
}

async function handleDesktopRequest(request, url, env) {
  if (request.method !== "POST" || url.pathname !== "/v1/sync") return json({ error: "not_found" }, 404);
  const authorization = request.headers.get("authorization") || "";
  const match = authorization.match(/^Bearer (.+)$/);
  if (!env.SYNC_TOKEN || !match || match[1] !== env.SYNC_TOKEN) return json({ error: "unauthorized" }, 401);
  return handleSync(request, env);
}

async function authenticateAccess(request, env) {
  const assertion = request.headers.get("cf-access-jwt-assertion");
  if (!assertion || !env.ACCESS_AUD || !env.ACCESS_EMAIL) return json({ error: "unauthorized" }, 401);
  try {
    const teamUrl = normalizeTeamDomain(env.ACCESS_TEAM_DOMAIN);
    let jwks = ACCESS_JWKS.get(teamUrl.origin);
    if (!jwks) {
      jwks = createRemoteJWKSet(new URL("/cdn-cgi/access/certs", teamUrl));
      ACCESS_JWKS.set(teamUrl.origin, jwks);
    }
    const { payload } = await jwtVerify(assertion, jwks, {
      issuer: teamUrl.origin,
      audience: env.ACCESS_AUD,
    });
    if (!Number.isFinite(payload.exp) || typeof payload.email !== "string" || payload.email.toLowerCase() !== env.ACCESS_EMAIL.toLowerCase()) {
      return json({ error: "unauthorized" }, 401);
    }
    return null;
  } catch {
    return json({ error: "unauthorized" }, 401);
  }
}

function normalizeTeamDomain(value) {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash) throw new Error("invalid Access team domain");
  return url;
}

async function handleSync(request, env) {
  const parsed = await readJson(request, MAX_BODY_BYTES);
  if (parsed.error) return parsed.error;
  const validation = validateSyncBody(parsed.value);
  if (validation.error) return json({ error: validation.error }, 400);
  const { body, deviceId, mutations } = validation;
  const lastPulledCursor = toInt(body.lastPulledCursor, 0);
  const maxChanges = clamp(toInt(body.maxChanges, 500), 1, MAX_CHANGES_PER_REQUEST);
  const now = Date.now();

  await upsertDevice(env.DB, {
    deviceId,
    deviceName: nullableString(body.deviceName),
    platform: nullableString(body.platform),
    appVersion: nullableString(body.appVersion),
    now,
  });

  const ackedMutationIds = [];
  for (const mutation of [...mutations].sort((a, b) => a.mutationId - b.mutationId)) {
    const statements = mutationStatements(env.DB, mutation, deviceId, now);
    await env.DB.batch(statements);
    ackedMutationIds.push(mutation.mutationId);
  }

  const rows = await env.DB.prepare(
    "SELECT seq, payload_json FROM change_log WHERE seq > ?1 ORDER BY seq ASC LIMIT ?2"
  ).bind(lastPulledCursor, maxChanges).all();
  const changes = [];
  let nextCursor = lastPulledCursor;
  for (const row of rows.results || []) {
    const seq = toInt(row.seq, lastPulledCursor);
    nextCursor = Math.max(nextCursor, seq);
    let payload = {};
    try { payload = row.payload_json ? JSON.parse(row.payload_json) : {}; } catch { /* preserve cursor */ }
    changes.push({ seq, ...payload });
  }
  return json({ ackedMutationIds, changes, nextCursor, hasMore: changes.length === maxChanges, serverTime: now, reset: false });
}

function validateSyncBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "invalid_payload" };
  const deviceId = cleanRequiredString(body.deviceId, 128);
  if (!deviceId) return { error: "invalid_device_id" };
  for (const field of ["deviceName", "platform", "appVersion"]) {
    if (body[field] != null && (typeof body[field] !== "string" || body[field].length > 256)) return { error: `invalid_${field}` };
  }
  if (body.lastPulledCursor != null && !isNonnegativeInteger(body.lastPulledCursor)) return { error: "invalid_cursor" };
  if (body.maxChanges != null && !isPositiveInteger(body.maxChanges)) return { error: "invalid_max_changes" };
  if (body.mutations != null && !Array.isArray(body.mutations)) return { error: "invalid_mutations" };
  const mutations = body.mutations || [];
  if (mutations.length > MAX_MUTATIONS_PER_REQUEST) return { error: "too_many_mutations" };
  const ids = new Set();
  for (const mutation of mutations) {
    const error = validateMutation(mutation, ids);
    if (error) return { error };
  }
  return { body, deviceId, mutations };
}

function validateMutation(mutation, ids) {
  if (!mutation || typeof mutation !== "object" || Array.isArray(mutation)) return "invalid_mutation";
  if (!MUTATION_TYPES.has(mutation.type)) return "unknown_mutation_type";
  if (!isPositiveInteger(mutation.mutationId) || ids.has(mutation.mutationId)) return "invalid_mutation_id";
  ids.add(mutation.mutationId);
  if (!isNonnegativeInteger(mutation.changedAt)) return "invalid_changed_at";
  if (mutation.feedUrl != null && !cleanRequiredString(mutation.feedUrl, MAX_STRING)) return "invalid_feed_url";
  if (mutation.type === "feed_upsert") {
    if (!cleanRequiredString(mutation.feedUrl, MAX_STRING) || typeof mutation.subscribed !== "boolean") return "invalid_feed_mutation";
    if (mutation.name != null && (typeof mutation.name !== "string" || mutation.name.length > 2000)) return "invalid_feed_name";
    if (mutation.addedAt != null && !isNonnegativeInteger(mutation.addedAt)) return "invalid_added_at";
  } else {
    if (!cleanRequiredString(mutation.articleId, MAX_ARTICLE_ID) || !cleanRequiredString(mutation.feedUrl, MAX_STRING) || typeof mutation.value !== "boolean") return "invalid_article_mutation";
  }
  return null;
}

function mutationStatements(db, mutation, deviceId, now) {
  return mutation.type === "feed_upsert"
    ? feedMutationStatements(db, mutation, deviceId, now)
    : articleMutationStatements(db, mutation, deviceId, now);
}

function feedMutationStatements(db, mutation, deviceId, now) {
  const changedAt = mutation.changedAt ?? now;
  const incomingName = mutation.name ?? "Untitled";
  const incomingSubscribed = mutation.subscribed ? 1 : 0;
  const incomingAddedAt = mutation.addedAt ?? changedAt;
  const bindings = [
    mutation.feedUrl,
    incomingName,
    changedAt,
    deviceId,
    incomingSubscribed,
    incomingAddedAt,
    mutation.mutationId,
  ];
  const state = db.prepare(
    `INSERT INTO feeds (
       feed_url, name, name_changed_at, name_changed_by,
       subscribed, subscription_changed_at, subscription_changed_by, added_at
     )
     SELECT ?1, ?2, ?3, ?4, ?5, ?3, ?4, ?6
     WHERE NOT EXISTS (
       SELECT 1 FROM applied_mutations WHERE device_id = ?4 AND mutation_id = ?7
     )
     ON CONFLICT(feed_url) DO UPDATE SET
       name = CASE
         WHEN excluded.name_changed_at > feeds.name_changed_at
           OR (excluded.name_changed_at = feeds.name_changed_at AND excluded.name_changed_by > feeds.name_changed_by)
         THEN excluded.name ELSE feeds.name END,
       name_changed_at = CASE
         WHEN excluded.name_changed_at > feeds.name_changed_at
           OR (excluded.name_changed_at = feeds.name_changed_at AND excluded.name_changed_by > feeds.name_changed_by)
         THEN excluded.name_changed_at ELSE feeds.name_changed_at END,
       name_changed_by = CASE
         WHEN excluded.name_changed_at > feeds.name_changed_at
           OR (excluded.name_changed_at = feeds.name_changed_at AND excluded.name_changed_by > feeds.name_changed_by)
         THEN excluded.name_changed_by ELSE feeds.name_changed_by END,
       added_at = CASE
         WHEN (
           excluded.subscription_changed_at > feeds.subscription_changed_at
           OR (excluded.subscription_changed_at = feeds.subscription_changed_at
             AND excluded.subscription_changed_by > feeds.subscription_changed_by)
         ) AND feeds.subscribed = 0 AND excluded.subscribed = 1
         THEN excluded.added_at ELSE feeds.added_at END,
       subscribed = CASE
         WHEN excluded.subscription_changed_at > feeds.subscription_changed_at
           OR (excluded.subscription_changed_at = feeds.subscription_changed_at
             AND excluded.subscription_changed_by > feeds.subscription_changed_by)
         THEN excluded.subscribed ELSE feeds.subscribed END,
       subscription_changed_at = CASE
         WHEN excluded.subscription_changed_at > feeds.subscription_changed_at
           OR (excluded.subscription_changed_at = feeds.subscription_changed_at
             AND excluded.subscription_changed_by > feeds.subscription_changed_by)
         THEN excluded.subscription_changed_at ELSE feeds.subscription_changed_at END,
       subscription_changed_by = CASE
         WHEN excluded.subscription_changed_at > feeds.subscription_changed_at
           OR (excluded.subscription_changed_at = feeds.subscription_changed_at
             AND excluded.subscription_changed_by > feeds.subscription_changed_by)
         THEN excluded.subscription_changed_by ELSE feeds.subscription_changed_by END`
  ).bind(...bindings);
  const change = db.prepare(
    `INSERT INTO change_log (
       entity_type, entity_id, payload_json, changed_at, source_device_id
     )
     SELECT
       'feed', feed_url,
       json_object(
         'type', 'feed',
         'feedUrl', feed_url,
         'name', name,
         'subscribed', CASE WHEN subscribed = 1 THEN json('true') ELSE json('false') END,
         'addedAt', added_at,
         'nameChangedAt', name_changed_at,
         'nameChangedBy', name_changed_by,
         'subscriptionChangedAt', subscription_changed_at,
         'subscriptionChangedBy', subscription_changed_by
       ),
       ?3, ?4
     FROM feeds
     WHERE feed_url = ?1
       AND NOT EXISTS (
         SELECT 1 FROM applied_mutations WHERE device_id = ?4 AND mutation_id = ?7
       )`
  ).bind(...bindings);
  return [state, change, appliedMutationStatement(db, deviceId, mutation.mutationId, now)];
}

function articleMutationStatements(db, mutation, deviceId, now) {
  const changedAt = mutation.changedAt ?? now;
  const value = mutation.value ? 1 : 0;
  const isRead = mutation.type === "article_read_set";
  const bindings = [
    mutation.articleId,
    mutation.feedUrl,
    value,
    changedAt,
    deviceId,
    mutation.mutationId,
  ];
  const incomingValues = isRead
    ? "?3, ?4, ?5, 0, 0, ''"
    : "0, 0, '', ?3, ?4, ?5";
  const fieldUpdates = isRead
    ? `read_value = CASE
         WHEN excluded.read_changed_at > article_state.read_changed_at
           OR (excluded.read_changed_at = article_state.read_changed_at
             AND excluded.read_changed_by > article_state.read_changed_by)
         THEN excluded.read_value ELSE article_state.read_value END,
       read_changed_at = CASE
         WHEN excluded.read_changed_at > article_state.read_changed_at
           OR (excluded.read_changed_at = article_state.read_changed_at
             AND excluded.read_changed_by > article_state.read_changed_by)
         THEN excluded.read_changed_at ELSE article_state.read_changed_at END,
       read_changed_by = CASE
         WHEN excluded.read_changed_at > article_state.read_changed_at
           OR (excluded.read_changed_at = article_state.read_changed_at
             AND excluded.read_changed_by > article_state.read_changed_by)
         THEN excluded.read_changed_by ELSE article_state.read_changed_by END`
    : `starred_value = CASE
         WHEN excluded.starred_changed_at > article_state.starred_changed_at
           OR (excluded.starred_changed_at = article_state.starred_changed_at
             AND excluded.starred_changed_by > article_state.starred_changed_by)
         THEN excluded.starred_value ELSE article_state.starred_value END,
       starred_changed_at = CASE
         WHEN excluded.starred_changed_at > article_state.starred_changed_at
           OR (excluded.starred_changed_at = article_state.starred_changed_at
             AND excluded.starred_changed_by > article_state.starred_changed_by)
         THEN excluded.starred_changed_at ELSE article_state.starred_changed_at END,
       starred_changed_by = CASE
         WHEN excluded.starred_changed_at > article_state.starred_changed_at
           OR (excluded.starred_changed_at = article_state.starred_changed_at
             AND excluded.starred_changed_by > article_state.starred_changed_by)
         THEN excluded.starred_changed_by ELSE article_state.starred_changed_by END`;
  const state = db.prepare(
    `INSERT INTO article_state (
       article_id, feed_url,
       read_value, read_changed_at, read_changed_by,
       starred_value, starred_changed_at, starred_changed_by
     )
     SELECT ?1, ?2, ${incomingValues}
     WHERE NOT EXISTS (
       SELECT 1 FROM applied_mutations WHERE device_id = ?5 AND mutation_id = ?6
     )
     ON CONFLICT(article_id) DO UPDATE SET
       feed_url = excluded.feed_url,
       ${fieldUpdates}`
  ).bind(...bindings);
  const change = db.prepare(
    `INSERT INTO change_log (
       entity_type, entity_id, payload_json, changed_at, source_device_id
     )
     SELECT
       'article_state', article_id,
       json_object(
         'type', 'article_state',
         'articleId', article_id,
         'feedUrl', feed_url,
         'read', CASE WHEN read_value = 1 THEN json('true') ELSE json('false') END,
         'readChangedAt', read_changed_at,
         'readChangedBy', read_changed_by,
         'starred', CASE WHEN starred_value = 1 THEN json('true') ELSE json('false') END,
         'starredChangedAt', starred_changed_at,
         'starredChangedBy', starred_changed_by
       ),
       ?4, ?5
     FROM article_state
     WHERE article_id = ?1
       AND NOT EXISTS (
         SELECT 1 FROM applied_mutations WHERE device_id = ?5 AND mutation_id = ?6
       )`
  ).bind(...bindings);
  return [state, change, appliedMutationStatement(db, deviceId, mutation.mutationId, now)];
}

function appliedMutationStatement(db, deviceId, mutationId, now) {
  return db.prepare(
    `INSERT OR IGNORE INTO applied_mutations (device_id, mutation_id, applied_at)
     VALUES (?1, ?2, ?3)`
  ).bind(deviceId, mutationId, now);
}

async function handleFeed(request) {
  const parsed = await readJson(request, MAX_BODY_BYTES);
  if (parsed.error) return parsed.error;
  let target;
  try { target = validateFeedUrl(parsed.value?.url); } catch { return json({ error: "invalid_feed_url" }, 400); }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    let response;
    for (let redirects = 0; redirects <= 3; redirects++) {
      response = await fetch(target, { redirect: "manual", signal: controller.signal, headers: { Accept: "application/atom+xml, application/rss+xml, application/xml, text/xml;q=0.9", "User-Agent": "LectorFeedProxy/1.0" } });
      if (response.status >= 300 && response.status < 400) {
        if (redirects === 3 || !response.headers.get("location")) return json({ error: "too_many_redirects" }, 502);
        target = validateFeedUrl(new URL(response.headers.get("location"), target).href);
        continue;
      }
      break;
    }
    if (!response.ok) return json({ error: "upstream_error" }, 502);
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_FEED_BYTES) return json({ error: "feed_too_large" }, 413);
    const bytes = await readLimitedResponse(response, MAX_FEED_BYTES);
    if (!looksLikeFeed(response.headers.get("content-type") || "", bytes)) return json({ error: "invalid_feed_content" }, 415);
    return new Response(bytes, { headers: { "content-type": "application/xml", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  } catch (error) {
    if (error instanceof FeedTooLargeError) return json({ error: "feed_too_large" }, 413);
    return json({ error: error?.name === "AbortError" ? "upstream_timeout" : "feed_fetch_failed" }, 502);
  } finally { clearTimeout(timeout); }
}

export function validateFeedUrl(value) {
  if (typeof value !== "string" || value.length > MAX_STRING) throw new Error("invalid URL");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port) throw new Error("invalid URL");
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host.includes(".") || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".home") || host.endsWith(".lan") || isIpLiteral(host)) throw new Error("invalid host");
  return url;
}

function isIpLiteral(host) {
  if (host.includes(":")) return true;
  if (/^\d+(?:\.\d+){3}$/.test(host)) return true;
  return /^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host);
}

async function readLimitedResponse(response, maximum) {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximum) { await reader.cancel(); throw new FeedTooLargeError(); }
    chunks.push(value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

function looksLikeFeed(contentType, bytes) {
  const type = contentType.split(";", 1)[0].trim().toLowerCase();
  if (type === "text/html") return false;
  const allowed = type === "application/rss+xml" || type === "application/atom+xml" || type === "application/xml" || type === "text/xml" || type === "text/plain" || type === "application/octet-stream" || !type;
  if (!allowed) return false;
  let prefix = new TextDecoder().decode(bytes.subarray(0, 4096))
    .replace(/^\uFEFF/, "")
    .trimStart()
    .toLowerCase();
  prefix = prefix.replace(/^<\?xml[^>]*\?>/, "").trimStart();
  while (prefix.startsWith("<!--")) {
    const commentEnd = prefix.indexOf("-->");
    if (commentEnd < 0) return false;
    prefix = prefix.slice(commentEnd + 3).trimStart();
  }
  return /^<(rss|feed|rdf:rdf)(?:\s|>)/.test(prefix);
}

async function readJson(request, maximum) {
  const type = (request.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
  if (type !== "application/json") return { error: json({ error: "unsupported_media_type" }, 415) };
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum) return { error: json({ error: "payload_too_large" }, 413) };
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > maximum) return { error: json({ error: "payload_too_large" }, 413) };
  try { return { value: JSON.parse(new TextDecoder().decode(bytes)) }; } catch { return { error: json({ error: "invalid_json" }, 400) }; }
}

async function upsertDevice(db, { deviceId, deviceName, platform, appVersion, now }) {
  return db.prepare(
    `INSERT INTO devices (
       device_id, name, platform, app_version, created_at, last_seen_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
     ON CONFLICT(device_id) DO UPDATE SET
       name = COALESCE(excluded.name, devices.name),
       platform = COALESCE(excluded.platform, devices.platform),
       app_version = COALESCE(excluded.app_version, devices.app_version),
       last_seen_at = excluded.last_seen_at`
  ).bind(deviceId, deviceName, platform, appVersion, now).run();
}

function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; img-src 'self' https: data:; frame-src https://www.youtube.com https://www.youtube-nocookie.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; worker-src 'self'; manifest-src 'self'");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

function normalizedHost(value) { return String(value || "").trim().toLowerCase().replace(/\.$/, ""); }
class FeedTooLargeError extends Error {}
function cleanRequiredString(value, max) { return typeof value === "string" && value.trim() && value.length <= max ? value.trim() : ""; }
function nullableString(value) { return typeof value === "string" ? value : null; }
function isPositiveInteger(value) { return Number.isSafeInteger(value) && value > 0; }
function isNonnegativeInteger(value) { return Number.isSafeInteger(value) && value >= 0; }
function toInt(value, fallback = 0) { const parsed = Number(value); return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback; }
function clamp(value, min, max) { return Math.min(Math.max(value, min), max); }
