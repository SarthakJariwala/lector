import { openDB } from "idb";
import { syncRequest } from "./platform";
import { buildSyncRequestBody, MAX_SYNC_MUTATIONS } from "./sync-request";

const DB_NAME = "lector";
const DEVICE = "sync_device_id";
const NEXT_MUTATION = "sync_next_mutation_id";
const CURSOR = "sync_last_pulled_cursor";
const CLOCK = "sync_logical_clock_ms";
const MIGRATED = "migrated_from_localstorage";
const MANAGED_CONFIG = Object.freeze({
  mode: "cloudflare-access", configured: true, endpoint: "/api/v1/sync", token: "",
});
let dbPromise;
let writeLock = Promise.resolve();

function locked(fn) {
  const result = writeLock.then(fn);
  writeLock = result.catch(() => {});
  return result;
}

export function initDb() {
  if (!dbPromise) dbPromise = openDB(DB_NAME, 1, {
    upgrade(db) {
      const feeds = db.createObjectStore("feeds", { keyPath: "url" });
      const articles = db.createObjectStore("articles", { keyPath: "id" });
      articles.createIndex("feedUrl", "feedUrl");
      const state = db.createObjectStore("articleState", { keyPath: "articleId" });
      state.createIndex("feedUrl", "feedUrl");
      const outbox = db.createObjectStore("outbox", { keyPath: ["deviceId", "mutationId"] });
      outbox.createIndex("deviceId", "deviceId");
      db.createObjectStore("meta", { keyPath: "key" });
      void feeds;
    },
  });
  return dbPromise;
}

export function isSyncConfigured() { return true; }
export async function getSyncConfig() { return { ...MANAGED_CONFIG }; }
export async function setSyncConfig() { return { ...MANAGED_CONFIG }; }

const integer = (v, fallback = 0) => Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : fallback;
const newer = (at, by, oldAt, oldBy) => at > oldAt || (at === oldAt && String(by) > String(oldBy));
const metaGet = async (store, key) => (await store.get(key))?.value;
const metaPut = (store, key, value) => store.put({ key, value: String(value) });

async function mutationContext(tx) {
  const meta = tx.objectStore("meta");
  let deviceId = await metaGet(meta, DEVICE);
  if (!deviceId) {
    deviceId = globalThis.crypto?.randomUUID?.() || `device-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    await metaPut(meta, DEVICE, deviceId);
  }
  const mutationId = integer(await metaGet(meta, NEXT_MUTATION), 1);
  await metaPut(meta, NEXT_MUTATION, mutationId + 1);
  const changedAt = Math.max(Date.now(), integer(await metaGet(meta, CLOCK), 0) + 1);
  await metaPut(meta, CLOCK, changedAt);
  return { deviceId, mutationId, changedAt };
}

function enqueue(tx, ctx, type, entityId, payload) {
  return tx.objectStore("outbox").put({
    deviceId: ctx.deviceId, mutationId: ctx.mutationId, type, entityId, payload,
    createdAt: Date.now(),
  });
}

export async function listFeeds() {
  const db = await initDb();
  return (await db.getAll("feeds")).filter(f => f.subscribed)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.addedAt - b.addedAt)
    .map(({ url, name, addedAt }) => ({ url, name, addedAt: new Date(addedAt).toISOString() }));
}

export async function addFeed({ url, name, addedAt }) {
  return locked(async () => {
    const db = await initDb();
    const tx = db.transaction(["feeds", "outbox", "meta"], "readwrite");
    const store = tx.objectStore("feeds");
    const old = await store.get(url);
    const all = await store.getAll();
    const ctx = await mutationContext(tx);
    const ts = new Date(addedAt).getTime();
    await store.put({ ...old, url, name, addedAt: old?.subscribed ? old.addedAt : ts,
      sortOrder: old?.subscribed ? old.sortOrder : Math.max(-1, ...all.map(f => integer(f.sortOrder, 0))) + 1,
      subscribed: true, subscriptionChangedAt: ctx.changedAt, subscriptionChangedBy: ctx.deviceId,
      nameChangedAt: ctx.changedAt, nameChangedBy: ctx.deviceId });
    await enqueue(tx, ctx, "feed_upsert", url, { feedUrl: url, name, subscribed: true, addedAt: ts, changedAt: ctx.changedAt });
    await tx.done;
  });
}

export async function reorderFeeds(urls) {
  return locked(async () => {
    const db = await initDb(); const tx = db.transaction("feeds", "readwrite"); const s = tx.store;
    for (let i = 0; i < urls.length; i++) { const f = await s.get(urls[i]); if (f?.subscribed) await s.put({ ...f, sortOrder: i }); }
    await tx.done;
  });
}

async function deleteByFeed(tx, storeName, feedUrl) {
  const index = tx.objectStore(storeName).index("feedUrl");
  for (let cursor = await index.openKeyCursor(IDBKeyRange.only(feedUrl)); cursor; cursor = await cursor.continue())
    await tx.objectStore(storeName).delete(cursor.primaryKey);
}

export async function removeFeed(url) {
  return locked(async () => {
    const db = await initDb(); const tx = db.transaction(["feeds", "articles", "articleState", "outbox", "meta"], "readwrite");
    const s = tx.objectStore("feeds"); const feed = await s.get(url); if (!feed) { await tx.done; return; }
    const ctx = await mutationContext(tx);
    await s.put({ ...feed, subscribed: false, subscriptionChangedAt: ctx.changedAt, subscriptionChangedBy: ctx.deviceId });
    await deleteByFeed(tx, "articles", url); await deleteByFeed(tx, "articleState", url);
    await enqueue(tx, ctx, "feed_upsert", url, { feedUrl: url, name: feed.name || "Untitled", subscribed: false, addedAt: feed.addedAt || ctx.changedAt, changedAt: ctx.changedAt });
    await tx.done;
  });
}

export async function renameFeed(url, newName) {
  return locked(async () => {
    const db = await initDb(); const tx = db.transaction(["feeds", "articles", "outbox", "meta"], "readwrite");
    const feeds = tx.objectStore("feeds"); const feed = await feeds.get(url); if (!feed) { await tx.done; return; }
    const ctx = await mutationContext(tx); await feeds.put({ ...feed, name: newName, nameChangedAt: ctx.changedAt, nameChangedBy: ctx.deviceId });
    const ai = tx.objectStore("articles").index("feedUrl");
    for (let c = await ai.openCursor(IDBKeyRange.only(url)); c; c = await c.continue()) await c.update({ ...c.value, feedName: newName });
    await enqueue(tx, ctx, "feed_upsert", url, { feedUrl: url, name: newName, subscribed: !!feed.subscribed, addedAt: feed.addedAt || ctx.changedAt, changedAt: ctx.changedAt });
    await tx.done;
  });
}

export async function listArticles({ feedUrl, filter } = {}) {
  const db = await initDb(); const tx = db.transaction(["articles", "articleState"]);
  const rows = feedUrl ? await tx.objectStore("articles").index("feedUrl").getAll(feedUrl) : await tx.objectStore("articles").getAll();
  const result = [];
  for (const a of rows) {
    const s = await tx.objectStore("articleState").get(a.id); const read = s ? !!s.readValue : !!a.is_read; const star = s ? !!s.starredValue : !!a.is_starred;
    if ((filter === "unread" && read) || (filter === "starred" && !star)) continue;
    result.push({ id: a.id, feedUrl: a.feedUrl, feedName: a.feedName, title: a.title, link: a.link, published: a.published, content: a.content, author: a.author, is_read: read, is_starred: star, _ts: a.publishedTs, _fetched: a.fetchedAt });
  }
  await tx.done; result.sort((a,b) => b._ts-a._ts || b._fetched-a._fetched); return result.map(({_ts,_fetched,...a}) => a);
}

export async function upsertArticles(feedUrl, feedName, items) {
  return locked(async () => {
    const db = await initDb(); const tx = db.transaction(["articles", "articleState"], "readwrite"); const as = tx.objectStore("articles"); const now = Date.now();
    for (const item of items) {
      const id = `${feedUrl}::${item.link || item.title}`; const old = await as.get(id); const state = await tx.objectStore("articleState").get(id);
      await as.put({ ...old, id, feedUrl, feedName, title:item.title, link:item.link, published:item.published,
        publishedTs:item.published ? new Date(item.published).getTime() || 0 : 0, content:item.content, author:item.author,
        is_read: state ? !!state.readValue : !!old?.is_read, is_starred: state ? !!state.starredValue : !!old?.is_starred, fetchedAt:now });
    }
    const cached = await as.index("feedUrl").getAll(feedUrl); const removable = cached.filter(a => !a.is_starred)
      .sort((a,b) => b.publishedTs-a.publishedTs || b.fetchedAt-a.fetchedAt).slice(500);
    for (const a of removable) await as.delete(a.id);
    await tx.done;
  });
}

async function setArticleField(articleIds, field, forced) {
  if (!articleIds.length) return;
  return locked(async () => {
    const db = await initDb(); const tx = db.transaction(["articles", "articleState", "outbox", "meta"], "readwrite");
    for (const id of articleIds) {
      const article = await tx.objectStore("articles").get(id); const old = await tx.objectStore("articleState").get(id);
      if (!old && !article) continue;
      const ctx = await mutationContext(tx); const feedUrl = old?.feedUrl || article.feedUrl;
      const key = field === "read" ? "readValue" : "starredValue"; const value = forced === undefined ? !((old?.[key]) ?? article[`is_${field}`]) : forced;
      const state = old || { articleId:id, feedUrl, readValue:!!article?.is_read, readChangedAt:0, readChangedBy:"migration", starredValue:!!article?.is_starred, starredChangedAt:0, starredChangedBy:"migration" };
      state[key] = value; state[`${field}ChangedAt`] = ctx.changedAt; state[`${field}ChangedBy`] = ctx.deviceId;
      await tx.objectStore("articleState").put(state); if (article) await tx.objectStore("articles").put({ ...article, [`is_${field}`]:value });
      await enqueue(tx, ctx, field === "read" ? "article_read_set" : "article_star_set", id, { articleId:id, feedUrl, value, changedAt:ctx.changedAt });
    }
    await tx.done;
  });
}
export const markRead = id => setArticleField([id], "read", true);
export const toggleRead = id => setArticleField([id], "read");
export const toggleStar = id => setArticleField([id], "starred");
export const markAllRead = ids => setArticleField(ids, "read", true);

async function applyChange(tx, c) {
  if (c?.type === "feed" && typeof c.feedUrl === "string" && c.feedUrl) {
    const s=tx.objectStore("feeds"), old=await s.get(c.feedUrl), byN=String(c.nameChangedBy??c.changedBy??""), byS=String(c.subscriptionChangedBy??c.changedBy??"");
    const atN=integer(c.nameChangedAt??c.changedAt), atS=integer(c.subscriptionChangedAt??c.changedAt); let f=old || {url:c.feedUrl, name:c.name||"Untitled", addedAt:integer(c.addedAt,Date.now()), sortOrder:(await s.getAll()).length, subscribed:!!c.subscribed, nameChangedAt:atN,nameChangedBy:byN,subscriptionChangedAt:atS,subscriptionChangedBy:byS};
    if (old && newer(atN,byN,integer(old.nameChangedAt),old.nameChangedBy)) f={...f,name:typeof c.name==="string"?c.name:"Untitled",nameChangedAt:atN,nameChangedBy:byN};
    if (old && newer(atS,byS,integer(old.subscriptionChangedAt),old.subscriptionChangedBy)) f={...f,subscribed:!!c.subscribed,addedAt:!old.subscribed&&c.subscribed?integer(c.addedAt,old.addedAt):old.addedAt,subscriptionChangedAt:atS,subscriptionChangedBy:byS};
    await s.put(f); if (!f.subscribed) { await deleteByFeed(tx,"articles",c.feedUrl); await deleteByFeed(tx,"articleState",c.feedUrl); }
  } else if (c?.type === "article_state" && typeof c.articleId === "string" && c.articleId) {
    const ss=tx.objectStore("articleState"), old=await ss.get(c.articleId); let s=old||{articleId:c.articleId,feedUrl:c.feedUrl||"",readValue:!!c.read,readChangedAt:integer(c.readChangedAt??c.changedAt),readChangedBy:String(c.readChangedBy??c.changedBy??""),starredValue:!!c.starred,starredChangedAt:integer(c.starredChangedAt??c.changedAt),starredChangedBy:String(c.starredChangedBy??c.changedBy??"")};
    const ra=integer(c.readChangedAt??c.changedAt), rb=String(c.readChangedBy??c.changedBy??""); if(old&&newer(ra,rb,integer(old.readChangedAt),old.readChangedBy)) s={...s,readValue:!!c.read,readChangedAt:ra,readChangedBy:rb};
    const sa=integer(c.starredChangedAt??c.changedAt), sb=String(c.starredChangedBy??c.changedBy??""); if(old&&newer(sa,sb,integer(old.starredChangedAt),old.starredChangedBy)) s={...s,starredValue:!!c.starred,starredChangedAt:sa,starredChangedBy:sb};
    if(c.feedUrl) s.feedUrl=c.feedUrl; await ss.put(s); const a=await tx.objectStore("articles").get(c.articleId); if(a) await tx.objectStore("articles").put({...a,is_read:s.readValue,is_starred:s.starredValue});
  }
}

function newestSyncTimestamp(response, changes) {
  let latest = integer(response?.serverTime, 0);
  const timestampFields = [
    "changedAt",
    "nameChangedAt",
    "subscriptionChangedAt",
    "readChangedAt",
    "starredChangedAt",
  ];
  for (const change of changes) {
    for (const field of timestampFields) {
      latest = Math.max(latest, integer(change?.[field], 0));
    }
  }
  return latest;
}

export async function syncStateWithServer({ maxMutations=MAX_SYNC_MUTATIONS, maxChanges=500 }={}) {
  const db=await initDb(); const rtx=db.transaction(["meta","outbox"]); const meta=rtx.objectStore("meta"); let deviceId=await metaGet(meta,DEVICE);
  if(!deviceId) { await rtx.done; await locked(async()=>{const t=db.transaction("meta","readwrite"); deviceId=await metaGet(t.store,DEVICE)||globalThis.crypto?.randomUUID?.()||`device-${Date.now()}`; await metaPut(t.store,DEVICE,deviceId); await t.done;}); }
  const lastCursor=integer(await db.get("meta",CURSOR).then(x=>x?.value)); const all=await db.getAllFromIndex("outbox","deviceId",deviceId); all.sort((a,b)=>a.mutationId-b.mutationId);
  const mutations=all.slice(0,Math.min(maxMutations,MAX_SYNC_MUTATIONS)).map(({mutationId,type,payload})=>({mutationId,type,...payload}));
  const requestBody=buildSyncRequestBody({deviceId,lastPulledCursor:lastCursor,maxChanges,mutations,maxMutations});
  let response=await syncRequest(requestBody);
  if (response?.ok !== undefined) { if(!response.ok) throw new Error(`Sync failed with HTTP ${response.status}`); try { response=await response.json(); } catch { throw new Error("Sync response was not valid JSON"); } }
  const acked=(Array.isArray(response?.ackedMutationIds)?response.ackedMutationIds:[]).map(x=>integer(x,-1)).filter(x=>x>0); const changes=Array.isArray(response?.changes)?response.changes:[]; const nextCursor=integer(response?.nextCursor,lastCursor); const hasMore=!!response?.hasMore; const remoteClock=newestSyncTimestamp(response,changes);
  if(hasMore && nextCursor<=lastCursor) throw new Error("Sync returned a non-advancing cursor while more changes remain");
  await locked(async()=>{const tx=db.transaction(["feeds","articles","articleState","outbox","meta"],"readwrite"); const metaStore=tx.objectStore("meta"); for(const id of acked) await tx.objectStore("outbox").delete([deviceId,id]); for(const c of changes) await applyChange(tx,c); await metaPut(metaStore,CURSOR,nextCursor); await metaPut(metaStore,CLOCK,Math.max(integer(await metaGet(metaStore,CLOCK),0),remoteClock)); await tx.done;});
  const hasPendingMutations=(await db.countFromIndex("outbox","deviceId",deviceId))>0;
  return {skipped:false,ackedMutations:acked.length,appliedChanges:changes.length,nextCursor,hasMore,hasPendingMutations};
}

function legacy(key) { try { const v=localStorage.getItem(key); return v?JSON.parse(v):null; } catch { return null; } }
export async function importFromLocalStorageIfNeeded() {
  const db=await initDb(); if((await db.get("meta",MIGRATED))?.value==="1") return;
  const feeds=legacy("rss-feeds")||[], articles=legacy("rss-articles")||[], read=legacy("rss-read")||{}, starred=legacy("rss-starred")||{};
  await locked(async()=>{const tx=db.transaction(["feeds","articles","articleState","meta"],"readwrite"); let order=(await tx.objectStore("feeds").getAll()).length;
    for(const f of feeds) if(f?.url && !(await tx.objectStore("feeds").get(f.url))) { const ts=new Date(f.addedAt||Date.now()).getTime(); await tx.objectStore("feeds").put({url:f.url,name:f.name||"Untitled",addedAt:ts,sortOrder:order++,subscribed:true,subscriptionChangedAt:ts,subscriptionChangedBy:"migration",nameChangedAt:ts,nameChangedBy:"migration"}); }
    const now=Date.now(); for(const a of articles) { if(!a?.id) continue; const rv=!!read[a.id], sv=!!starred[a.id]; if(!(await tx.objectStore("articles").get(a.id))) await tx.objectStore("articles").put({...a,publishedTs:a.published?new Date(a.published).getTime()||0:0,fetchedAt:now,is_read:rv,is_starred:sv}); if(rv||sv) await tx.objectStore("articleState").put({articleId:a.id,feedUrl:a.feedUrl,readValue:rv,readChangedAt:now,readChangedBy:"migration",starredValue:sv,starredChangedAt:now,starredChangedBy:"migration"}); }
    await metaPut(tx.objectStore("meta"),MIGRATED,"1"); await tx.done;
  });
  try { for(const k of ["rss-feeds","rss-articles","rss-read","rss-starred"]) localStorage.removeItem(k); } catch {}
}
