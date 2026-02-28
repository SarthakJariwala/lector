import { useState, useEffect, useCallback, useRef } from "react";
import { open } from "@tauri-apps/plugin-shell";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { initDb, listFeeds, addFeed as dbAddFeed, removeFeed as dbRemoveFeed, listArticles, upsertArticles, markRead as dbMarkRead, toggleRead as dbToggleRead, toggleStar as dbToggleStar, markAllRead as dbMarkAllRead, importFromLocalStorageIfNeeded } from "./db";

function parseRSS(xmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "text/xml");
  const isAtom = !!doc.querySelector("feed");
  const items = [];
  if (isAtom) {
    const feedTitle = doc.querySelector("feed > title")?.textContent || "Untitled";
    doc.querySelectorAll("entry").forEach((entry) => {
      items.push({
        title: entry.querySelector("title")?.textContent || "Untitled",
        link: entry.querySelector("link[rel='alternate']")?.getAttribute("href") || entry.querySelector("link")?.getAttribute("href") || "",
        published: entry.querySelector("published")?.textContent || entry.querySelector("updated")?.textContent || "",
        content: entry.querySelector("content")?.textContent || entry.querySelector("summary")?.textContent || "",
        author: entry.querySelector("author > name")?.textContent || "",
      });
    });
    return { feedTitle, items };
  }
  const channel = doc.querySelector("channel");
  const feedTitle = channel?.querySelector("title")?.textContent || "Untitled";
  doc.querySelectorAll("item").forEach((item) => {
    items.push({
      title: item.querySelector("title")?.textContent || "Untitled",
      link: item.querySelector("link")?.textContent || "",
      published: item.querySelector("pubDate")?.textContent || item.querySelector("dc\\:date")?.textContent || "",
      content: item.getElementsByTagName("content:encoded")[0]?.textContent || item.querySelector("description")?.textContent || "",
      author: item.getElementsByTagName("dc:creator")[0]?.textContent || item.querySelector("author")?.textContent || "",
    });
  });
  return { feedTitle, items };
}

async function fetchFeed(url) {
  const resp = await tauriFetch(url, {
    method: "GET",
    headers: {
      "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
      "User-Agent": "Lector/1.0",
    },
    connectTimeout: 12000,
    maxRedirections: 10,
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return parseRSS(await resp.text());
}

function formatDate(dateStr) {
  if (!dateStr) return "";
  try {
    const d = new Date(dateStr);
    if (isNaN(d)) return dateStr;
    const now = new Date();
    const diff = now - d;
    if (diff < 3600000) return `${Math.max(1, Math.floor(diff / 60000))}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined });
  } catch { return dateStr; }
}

function stripHtml(html) {
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  return tmp.textContent || tmp.innerText || "";
}

const SAMPLE_FEEDS = [
  { url: "https://hnrss.org/frontpage", name: "Hacker News" },
  { url: "https://feeds.arstechnica.com/arstechnica/index", name: "Ars Technica" },
  { url: "https://www.theverge.com/rss/index.xml", name: "The Verge" },
  { url: "https://feeds.bbci.co.uk/news/rss.xml", name: "BBC News" },
  { url: "https://lucumr.pocoo.org/feed.xml", name: "Armin Ronacher" },
];

function useIsMobile() {
  const [m, setM] = useState(window.innerWidth < 768);
  useEffect(() => {
    const h = () => setM(window.innerWidth < 768);
    window.addEventListener("resize", h);
    return () => window.removeEventListener("resize", h);
  }, []);
  return m;
}

export default function RSSReader() {
  const isMobile = useIsMobile();
  const [feeds, setFeeds] = useState([]);
  const [articles, setArticles] = useState([]);
  const [selectedFeed, setSelectedFeed] = useState(null);
  const [selectedArticle, setSelectedArticle] = useState(null);
  const [newFeedUrl, setNewFeedUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [showAddFeed, setShowAddFeed] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(!isMobile);
  const [viewFilter, setViewFilter] = useState("all");
  const [hydrated, setHydrated] = useState(false);
  const readerRef = useRef(null);
  const loadSeq = useRef(0);

  const reloadArticles = useCallback(async () => {
    const seq = ++loadSeq.current;
    const arts = await listArticles();
    if (seq !== loadSeq.current) return; // stale request, ignore
    setArticles(arts);
  }, []);

  // Hydrate from DB on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await initDb();
      await importFromLocalStorageIfNeeded();
      const dbFeeds = await listFeeds();
      if (cancelled) return;
      setFeeds(dbFeeds);
      const dbArticles = await listArticles();
      if (cancelled) return;
      setArticles(dbArticles);
      setHydrated(true);
    })();
    return () => { cancelled = true; };
  }, []);

  const refreshAllFeeds = useCallback(async () => {
    if (feeds.length === 0) return;
    setRefreshing(true);
    const results = await Promise.allSettled(feeds.map(async (feed) => ({ feed, result: await fetchFeed(feed.url) })));
    for (const r of results) {
      if (r.status === "fulfilled") {
        const { feed, result } = r.value;
        await upsertArticles(feed.url, feed.name || result.feedTitle, result.items);
      }
    }
    await reloadArticles();
    setRefreshing(false);
  }, [feeds, reloadArticles]);

  // Auto-refresh on hydration
  useEffect(() => {
    if (hydrated && feeds.length > 0) refreshAllFeeds();
  }, [hydrated]);

  const addFeed = async () => {
    if (!newFeedUrl.trim()) return;
    let url = newFeedUrl.trim();
    if (!url.startsWith("http")) url = "https://" + url;
    if (feeds.some((f) => f.url === url)) { setError("Already subscribed."); return; }
    setLoading(true); setError("");
    try {
      const result = await fetchFeed(url);
      const nf = { url, name: result.feedTitle, addedAt: new Date().toISOString() };
      await dbAddFeed(nf);
      await upsertArticles(url, result.feedTitle, result.items);
      setFeeds(await listFeeds());
      await reloadArticles();
      setNewFeedUrl(""); setShowAddFeed(false);
    } catch (e) { console.error("addFeed error:", e); setError("Could not fetch feed. Check the URL and try again."); }
    setLoading(false);
  };

  const removeFeed = async (url) => {
    await dbRemoveFeed(url);
    setFeeds(await listFeeds());
    if (selectedFeed === url) setSelectedFeed(null);
    if (selectedArticle?.feedUrl === url) setSelectedArticle(null);
    await reloadArticles();
  };

  const addSampleFeed = async (sample) => {
    if (feeds.some((f) => f.url === sample.url)) return;
    setLoading(true); setError("");
    try {
      const result = await fetchFeed(sample.url);
      await dbAddFeed({ url: sample.url, name: sample.name || result.feedTitle, addedAt: new Date().toISOString() });
      await upsertArticles(sample.url, sample.name || result.feedTitle, result.items);
      setFeeds(await listFeeds());
      await reloadArticles();
    } catch { setError(`Could not fetch ${sample.name}.`); }
    setLoading(false);
  };

  const handleMarkRead = async (id) => {
    await dbMarkRead(id);
    setArticles((prev) => prev.map((a) => a.id === id ? { ...a, is_read: true } : a));
  };

  const handleToggleRead = async (id) => {
    await dbToggleRead(id);
    setArticles((prev) => prev.map((a) => a.id === id ? { ...a, is_read: !a.is_read } : a));
  };

  const handleToggleStar = async (id) => {
    await dbToggleStar(id);
    setArticles((prev) => prev.map((a) => a.id === id ? { ...a, is_starred: !a.is_starred } : a));
    setSelectedArticle((prev) => prev && prev.id === id ? { ...prev, is_starred: !prev.is_starred } : prev);
  };

  const handleMarkAllRead = async () => {
    const ids = getFilteredArticles().map((a) => a.id);
    await dbMarkAllRead(ids);
    setArticles((prev) => {
      const idSet = new Set(ids);
      return prev.map((a) => idSet.has(a.id) ? { ...a, is_read: true } : a);
    });
  };

  const openArticle = (article) => {
    setSelectedArticle(article); handleMarkRead(article.id);
    if (isMobile) setSidebarOpen(false);
    setTimeout(() => { if (readerRef.current) readerRef.current.scrollTop = 0; }, 0);
  };

  const getFilteredArticles = () => {
    let f = selectedFeed ? articles.filter((a) => a.feedUrl === selectedFeed) : articles;
    if (viewFilter === "unread") f = f.filter((a) => !a.is_read);
    if (viewFilter === "starred") f = f.filter((a) => a.is_starred);
    return f;
  };

  const unreadCount = (feedUrl) => {
    const fa = feedUrl ? articles.filter((a) => a.feedUrl === feedUrl) : articles;
    return fa.filter((a) => !a.is_read).length;
  };

  const selectNav = (feed, filter) => { setSelectedFeed(feed); setSelectedArticle(null); setViewFilter(filter); if (isMobile) setSidebarOpen(false); };
  const filteredArticles = getFilteredArticles();

  if (!hydrated) {
    return (
      <div style={{ display: "flex", height: "100vh", alignItems: "center", justifyContent: "center", fontFamily: "'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif", background: "#faf7f2", color: "#8a7e6e" }}>
        <style>{cssText}</style>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 48, color: "#c9b99a", marginBottom: 16 }}>◈</div>
          <p style={{ fontSize: 14 }}>Loading…</p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", height: "100vh", width: "100%", fontFamily: "'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif", background: "#faf7f2", color: "#2a2520", overflow: "hidden", position: "relative" }}>
      <style>{cssText}</style>

      {isMobile && sidebarOpen && <div onClick={() => setSidebarOpen(false)} style={{ position: "fixed", inset: 0, background: "rgba(30,25,18,0.35)", zIndex: 90, backdropFilter: "blur(2px)", WebkitBackdropFilter: "blur(2px)" }} />}

      {/* Sidebar */}
      <div style={{
        background: "#f0ebe3", borderRight: isMobile ? "none" : "1px solid #ddd5c8",
        display: "flex", flexDirection: "column", flexShrink: 0, overflow: "hidden",
        ...(isMobile
          ? { position: "fixed", top: 0, left: 0, bottom: 0, width: "min(290px, 85vw)", zIndex: 100, transform: sidebarOpen ? "translateX(0)" : "translateX(-100%)", transition: "transform 0.28s cubic-bezier(.4,0,.2,1)", boxShadow: sidebarOpen ? "4px 0 24px rgba(0,0,0,0.15)" : "none" }
          : { width: sidebarOpen ? 272 : 0, minWidth: sidebarOpen ? 272 : 0, transition: "all 0.25s ease" })
      }}>
        <div style={{ padding: "18px 18px 14px", borderBottom: "1px solid #ddd5c8", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
          <h1 style={{ fontFamily: "'Newsreader', Georgia, serif", fontSize: 21, fontWeight: 500, color: "#2a2520", display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ color: "#8b5e3c", fontSize: 19 }}>◈</span> Lector
          </h1>
          {isMobile && <button onClick={() => setSidebarOpen(false)} style={{ background: "none", border: "none", fontSize: 24, color: "#8a7e6e", cursor: "pointer", padding: "2px 6px", lineHeight: 1 }}>×</button>}
        </div>

        <div style={{ padding: "10px 10px 6px", borderBottom: "1px solid #ddd5c8", flexShrink: 0 }}>
          {[
            { label: "All Articles", icon: "⊞", filter: "all", count: unreadCount(null) },
            { label: "Unread", icon: "○", filter: "unread" },
            { label: "Starred", icon: "☆", filter: "starred" },
          ].map((nav) => (
            <button key={nav.filter} onClick={() => selectNav(null, nav.filter)} className="nav-item" style={{
              display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "10px 12px", border: "none",
              background: !selectedFeed && viewFilter === nav.filter ? "#e8e0d4" : "transparent",
              cursor: "pointer", borderRadius: 8, fontSize: 14, fontFamily: "inherit",
              color: !selectedFeed && viewFilter === nav.filter ? "#2a2520" : "#5a5040",
              fontWeight: !selectedFeed && viewFilter === nav.filter ? 500 : 400, textAlign: "left",
            }}>
              <span style={{ fontSize: 14, width: 20, textAlign: "center", opacity: 0.7 }}>{nav.icon}</span>
              {nav.label}
              {nav.count > 0 && <span className="badge">{nav.count}</span>}
            </button>
          ))}
        </div>

        <div style={{ flex: 1, overflow: "auto", padding: 10, WebkitOverflowScrolling: "touch" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "4px 12px 8px" }}>
            <span style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: "#8a7e6e" }}>Feeds</span>
            <button onClick={() => setShowAddFeed(!showAddFeed)} style={{ width: 28, height: 28, border: "1px solid #c9b99a", background: "none", cursor: "pointer", borderRadius: 6, fontSize: 18, color: "#8b5e3c", display: "flex", alignItems: "center", justifyContent: "center" }}>+</button>
          </div>

          {showAddFeed && (
            <div style={{ padding: "6px 4px 12px" }}>
              <input type="url" value={newFeedUrl} onChange={(e) => { setNewFeedUrl(e.target.value); setError(""); }} onKeyDown={(e) => e.key === "Enter" && addFeed()} placeholder="Paste RSS feed URL…" className="feed-input" autoFocus />
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button onClick={addFeed} disabled={loading || !newFeedUrl.trim()} className="primary-btn" style={{ opacity: loading || !newFeedUrl.trim() ? 0.5 : 1 }}>
                  {loading ? "Adding…" : "Subscribe"}
                </button>
                <button onClick={() => { setShowAddFeed(false); setError(""); }} className="ghost-btn">Cancel</button>
              </div>
              {error && <div style={{ color: "#b54a30", fontSize: 12, marginTop: 6 }}>{error}</div>}
              {feeds.length === 0 && (
                <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", gap: 6 }}>
                  <span style={{ fontSize: 11, color: "#8a7e6e", width: "100%", marginBottom: 2 }}>Quick add:</span>
                  {SAMPLE_FEEDS.map((s) => (
                    <button key={s.url} onClick={() => addSampleFeed(s)} disabled={feeds.some((f) => f.url === s.url) || loading} className="sample-btn" style={{ opacity: feeds.some((f) => f.url === s.url) ? 0.4 : 1 }}>
                      {s.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            {feeds.map((feed) => (
              <div key={feed.url} className="feed-item" style={{ display: "flex", alignItems: "center", borderRadius: 8, background: selectedFeed === feed.url ? "#e8e0d4" : "transparent" }}>
                <button onClick={() => selectNav(selectedFeed === feed.url ? null : feed.url, "all")} style={{ flex: 1, display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", border: "none", background: "none", cursor: "pointer", fontSize: 14, fontFamily: "inherit", color: "#2a2520", textAlign: "left", borderRadius: 8, overflow: "hidden", minWidth: 0 }}>
                  <span style={{ fontSize: 8, color: "#8b5e3c", flexShrink: 0 }}>●</span>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{feed.name}</span>
                  {unreadCount(feed.url) > 0 && <span className="badge">{unreadCount(feed.url)}</span>}
                </button>
                <button onClick={(e) => { e.stopPropagation(); removeFeed(feed.url); }} className="remove-btn" title="Unsubscribe">×</button>
              </div>
            ))}
          </div>

          {feeds.length === 0 && !showAddFeed && (
            <div style={{ textAlign: "center", padding: "24px 12px" }}>
              <p style={{ fontSize: 13, color: "#8a7e6e", marginBottom: 12 }}>No feeds yet</p>
              <button onClick={() => setShowAddFeed(true)} className="primary-btn">Add your first feed</button>
            </div>
          )}
        </div>
      </div>

      {/* Main */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: isMobile ? "10px 12px" : "12px 20px", borderBottom: "1px solid #e8e0d4", background: "#faf7f2", flexShrink: 0, minHeight: 50, gap: 6 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, flex: 1 }}>
            <button onClick={() => setSidebarOpen(!sidebarOpen)} className="icon-btn" style={{ flexShrink: 0 }}>☰</button>
            {selectedArticle && <button onClick={() => setSelectedArticle(null)} className="back-btn">←{!isMobile && " Back"}</button>}
            <h2 style={{ fontFamily: "'Newsreader', Georgia, serif", fontSize: isMobile ? 15 : 17, fontWeight: 500, color: "#2a2520", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {selectedArticle ? selectedArticle.feedName : selectedFeed ? feeds.find((f) => f.url === selectedFeed)?.name : viewFilter === "unread" ? "Unread" : viewFilter === "starred" ? "Starred" : "All Articles"}
            </h2>
          </div>
          <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
            {!selectedArticle && filteredArticles.length > 0 && !isMobile && <button onClick={handleMarkAllRead} className="topbar-btn">Mark all read</button>}
            <button onClick={refreshAllFeeds} disabled={refreshing} className="topbar-btn" style={{ opacity: refreshing ? 0.5 : 1 }}>{refreshing ? "…" : "↻"}</button>
          </div>
        </div>

        {selectedArticle ? (
          <div ref={readerRef} style={{ flex: 1, overflow: "auto", padding: isMobile ? "20px 14px 56px" : "32px 20px 64px", WebkitOverflowScrolling: "touch" }}>
            <article style={{ maxWidth: 680, margin: "0 auto" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
                <span className="feed-tag">{selectedArticle.feedName}</span>
                {selectedArticle.author && <span style={{ fontSize: 13, color: "#5a5040" }}>{selectedArticle.author}</span>}
                <span style={{ fontSize: 13, color: "#b0a690" }}>{formatDate(selectedArticle.published)}</span>
              </div>
              <h1 style={{ fontFamily: "'Newsreader', Georgia, serif", fontSize: isMobile ? 24 : 32, fontWeight: 500, lineHeight: 1.25, color: "#1a1510", marginBottom: 14, letterSpacing: "-0.015em" }}>{selectedArticle.title}</h1>
              <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 24, paddingBottom: 18, borderBottom: "1px solid #e8e0d4", flexWrap: "wrap" }}>
                <button onClick={() => handleToggleStar(selectedArticle.id)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 14, fontFamily: "inherit", display: "flex", alignItems: "center", gap: 4, padding: "6px 0", color: selectedArticle.is_starred ? "#d4a847" : "#888" }}>
                  {selectedArticle.is_starred ? "★ Starred" : "☆ Star"}
                </button>
                {selectedArticle.link && <a href={selectedArticle.link} onClick={(e) => { e.preventDefault(); open(selectedArticle.link); }} style={{ fontSize: 13, color: "#8b5e3c", textDecoration: "none", fontFamily: "inherit", cursor: "pointer" }}>Open original ↗</a>}
              </div>
              <div className="article-body" onClick={(e) => { const anchor = e.target.closest("a"); if (anchor?.href) { e.preventDefault(); open(anchor.href); } }} dangerouslySetInnerHTML={{ __html: selectedArticle.content || "<p>No content available. Open the original article to read more.</p>" }} />
            </article>
          </div>
        ) : (
          <div style={{ flex: 1, overflow: "auto", padding: isMobile ? "2px 8px 16px" : "4px 16px 16px", WebkitOverflowScrolling: "touch" }}>
            {filteredArticles.length === 0 ? (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", padding: 28, textAlign: "center" }}>
                {feeds.length === 0 ? (
                  <>
                    <div style={{ fontSize: 48, color: "#c9b99a", marginBottom: 16 }}>◈</div>
                    <h3 style={{ fontFamily: "'Newsreader', Georgia, serif", fontSize: 22, fontWeight: 500, color: "#2a2520", marginBottom: 8 }}>Welcome to Lector</h3>
                    <p style={{ fontSize: 14, color: "#8a7e6e", marginBottom: 20, maxWidth: 300, lineHeight: 1.5 }}>Your personal reading space. Add an RSS feed to get started.</p>
                    <button onClick={() => { setSidebarOpen(true); setTimeout(() => setShowAddFeed(true), 150); }} className="primary-btn" style={{ padding: "10px 20px", fontSize: 14 }}>+ Add a feed</button>
                  </>
                ) : (
                  <>
                    <div style={{ fontSize: 48, color: "#c9b99a", marginBottom: 16 }}>✓</div>
                    <h3 style={{ fontFamily: "'Newsreader', Georgia, serif", fontSize: 22, fontWeight: 500, marginBottom: 8 }}>All caught up</h3>
                    <p style={{ fontSize: 14, color: "#8a7e6e" }}>{viewFilter === "unread" ? "No unread articles." : viewFilter === "starred" ? "No starred articles." : "No articles to show."}</p>
                  </>
                )}
              </div>
            ) : (
              filteredArticles.map((article) => (
                <button key={article.id} onClick={() => openArticle(article)} className="article-card" style={{ background: article.is_read ? "#faf7f2" : "#fff", borderColor: article.is_read ? "#ede6db" : "#e8e0d4" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 5 }}>
                    <span className="feed-tag">{article.feedName}</span>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                      <span style={{ fontSize: 11, color: "#b0a690" }}>{formatDate(article.published)}</span>
                      <span
                        role="button"
                        title={article.is_read ? "Mark as unread" : "Mark as read"}
                        className={`read-toggle-btn${article.is_read ? "" : " unread"}`}
                        onClick={(e) => { e.stopPropagation(); handleToggleRead(article.id); }}
                        style={{ fontSize: 10, color: "#8b5e3c", cursor: "pointer", padding: "2px 4px", borderRadius: 4, lineHeight: 1 }}
                      >
                        {article.is_read ? "○" : "●"}
                      </span>
                    </div>
                  </div>
                  <h3 style={{
                    fontFamily: "'Newsreader', Georgia, serif", fontSize: isMobile ? 15 : 17,
                    fontWeight: article.is_read ? 400 : 500, lineHeight: 1.35,
                    color: article.is_read ? "#6a6050" : "#1a1510", marginBottom: 5,
                  }}>
                    {article.title}
                  </h3>
                  {!isMobile && (
                    <p style={{ fontSize: 13, color: "#8a7e6e", lineHeight: 1.5, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                      {stripHtml(article.content).slice(0, 180)}
                    </p>
                  )}
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 5 }}>
                    {article.author && <span style={{ fontSize: 11, color: "#b0a690" }}>{article.author}</span>}
                    {article.is_starred && <span style={{ color: "#d4a847", fontSize: 13 }}>★</span>}
                  </div>
                </button>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const cssText = `
  @import url('https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,300;0,6..72,400;0,6..72,500;0,6..72,600;1,6..72,400&family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;1,9..40,400&display=swap');
  * { margin: 0; padding: 0; box-sizing: border-box; -webkit-tap-highlight-color: transparent; }

  .badge { margin-left: auto; background: #8b5e3c; color: #faf7f2; font-size: 11px; font-weight: 600; padding: 1px 7px; border-radius: 10px; min-width: 20px; text-align: center; flex-shrink: 0; }
  .feed-tag { font-size: 11px; font-weight: 600; color: #8b5e3c; text-transform: uppercase; letter-spacing: 0.04em; }

  .primary-btn { padding: 9px 16px; background: #8b5e3c; color: #faf7f2; border: none; border-radius: 8px; font-size: 13px; font-weight: 500; cursor: pointer; font-family: inherit; transition: filter 0.15s; }
  .primary-btn:hover { filter: brightness(1.08); }
  .primary-btn:active { filter: brightness(0.95); }

  .ghost-btn { padding: 9px 12px; background: none; color: #8a7e6e; border: none; border-radius: 8px; font-size: 13px; cursor: pointer; font-family: inherit; }

  .feed-input { width: 100%; padding: 10px 12px; border: 1px solid #c9b99a; border-radius: 8px; font-size: 14px; font-family: inherit; background: #faf7f2; color: #2a2520; outline: none; transition: border-color 0.15s; }
  .feed-input:focus { border-color: #8b5e3c; }

  .sample-btn { padding: 7px 12px; background: #e8e0d4; border: none; border-radius: 6px; font-size: 12px; cursor: pointer; font-family: inherit; color: #5a5040; transition: background 0.12s; }
  .sample-btn:hover { background: #ddd5c8; }

  .nav-item { transition: background 0.12s; }
  .nav-item:hover { background: #e8e0d4; }

  .feed-item:hover .remove-btn { opacity: 1; }
  .remove-btn { background: none; border: none; cursor: pointer; font-size: 18px; color: #b0a690; padding: 4px 10px 4px 4px; font-family: inherit; opacity: 0; transition: opacity 0.15s; }

  .icon-btn { background: none; border: none; cursor: pointer; font-size: 16px; color: #8a7e6e; padding: 6px 8px; border-radius: 6px; font-family: inherit; transition: background 0.12s; }
  .icon-btn:hover { background: #f0ebe3; }

  .back-btn { background: none; border: none; cursor: pointer; font-size: 14px; color: #8b5e3c; padding: 6px 8px; font-family: inherit; flex-shrink: 0; }

  .topbar-btn { background: none; border: 1px solid #ddd5c8; cursor: pointer; font-size: 12px; color: #5a5040; padding: 5px 12px; border-radius: 6px; font-family: inherit; white-space: nowrap; transition: background 0.12s; }
  .topbar-btn:hover { background: #f0ebe3; }

  .article-card { display: block; width: 100%; text-align: left; padding: 14px 16px; border: 1px solid; border-radius: 10px; cursor: pointer; margin-top: 8px; font-family: inherit; transition: box-shadow 0.15s, transform 0.12s; }
  .article-card:hover { box-shadow: 0 2px 12px rgba(0,0,0,0.06); transform: translateY(-1px); }
  .article-card:active { transform: translateY(0); box-shadow: none; }

  .read-toggle-btn { opacity: 0; transition: opacity 0.15s; }
  .read-toggle-btn.unread { opacity: 1; }
  .article-card:hover .read-toggle-btn { opacity: 1; }
  .read-toggle-btn:hover { background: #e8e0d4; }

  .article-body { font-family: 'Newsreader', Georgia, serif; font-size: 17px; line-height: 1.75; color: #2a2520; word-wrap: break-word; overflow-wrap: break-word; }
  .article-body p { margin-bottom: 1.2em; }
  .article-body a { color: #8b5e3c; text-decoration: underline; text-underline-offset: 2px; word-break: break-all; }
  .article-body img { max-width: 100%; height: auto; border-radius: 6px; margin: 1em 0; }
  .article-body h1, .article-body h2, .article-body h3 { font-family: 'Newsreader', Georgia, serif; margin: 1.4em 0 0.5em; color: #1a1510; }
  .article-body blockquote { border-left: 3px solid #c9b99a; padding-left: 1.2em; margin: 1.2em 0; color: #5a5040; font-style: italic; }
  .article-body pre { background: #f5f0e8; padding: 1em; border-radius: 6px; overflow-x: auto; font-size: 13px; margin: 1em 0; white-space: pre-wrap; word-break: break-all; }
  .article-body code { background: #f5f0e8; padding: 2px 5px; border-radius: 3px; font-size: 0.88em; }
  .article-body ul, .article-body ol { padding-left: 1.5em; margin-bottom: 1.2em; }
  .article-body li { margin-bottom: 0.4em; }

  @media (max-width: 767px) {
    .remove-btn { opacity: 0.5 !important; }
    .article-body { font-size: 16px; line-height: 1.7; }
    .article-card { padding: 12px 14px; }
  }
`;
