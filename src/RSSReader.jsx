import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  initDb,
  listFeeds,
  addFeed as dbAddFeed,
  removeFeed as dbRemoveFeed,
  renameFeed as dbRenameFeed,
  reorderFeeds as dbReorderFeeds,
  listArticles,
  upsertArticles,
  markRead as dbMarkRead,
  toggleRead as dbToggleRead,
  toggleStar as dbToggleStar,
  markAllRead as dbMarkAllRead,
  importFromLocalStorageIfNeeded,
  syncStateWithServer,
  getSyncConfig,
  setSyncConfig,
} from "./db";
import {
  canConfigureSync,
  fetchFeedText,
  openExternal,
} from "./platform";
import { sanitizeArticleHtml } from "./article-content";

const YOUTUBE_EMBED_HOSTS = new Set([
  "www.youtube.com",
  "youtube.com",
  "m.youtube.com",
  "www.youtube-nocookie.com",
  "youtube-nocookie.com",
  "youtu.be",
]);

const YOUTUBE_EMBED_ALLOW =
  "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";

const YOUTUBE_EMBED_QUERY_PARAMS = new Set([
  "autoplay",
  "cc_load_policy",
  "controls",
  "end",
  "index",
  "list",
  "loop",
  "modestbranding",
  "mute",
  "playlist",
  "playsinline",
  "rel",
  "si",
  "start",
]);

const YOUTUBE_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

function parseYouTubeTimeToSeconds(value) {
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number(value);
  const match = value.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i);
  if (!match) return null;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  const total = hours * 3600 + minutes * 60 + seconds;
  return total > 0 ? total : null;
}

function copyAllowedYouTubeParams(fromParams, toParams) {
  for (const [key, value] of fromParams.entries()) {
    if (YOUTUBE_EMBED_QUERY_PARAMS.has(key)) {
      toParams.set(key, value);
    }
  }
}

function parseYouTubeVideoId(value) {
  if (!value) return null;
  const videoId = value.trim();
  if (!YOUTUBE_VIDEO_ID_PATTERN.test(videoId)) return null;
  return videoId;
}

function normalizeYouTubeEmbedSrc(src) {
  if (!src) return null;

  let parsed;
  try {
    parsed = new URL(src, "https://reader.local");
  } catch {
    return null;
  }

  if (parsed.protocol !== "https:") return null;
  const host = parsed.hostname.toLowerCase();
  if (!YOUTUBE_EMBED_HOSTS.has(host)) return null;

  let embedUrl;
  if (host === "youtu.be") {
    const videoId = parseYouTubeVideoId(
      parsed.pathname.replace(/^\/+/, "").split("/")[0]
    );
    if (!videoId) return null;
    embedUrl = new URL(`https://www.youtube.com/embed/${videoId}`);
  } else if (parsed.pathname === "/watch") {
    const videoId = parseYouTubeVideoId(parsed.searchParams.get("v"));
    if (!videoId) return null;
    embedUrl = new URL(`https://www.youtube.com/embed/${videoId}`);
  } else if (parsed.pathname.startsWith("/embed/")) {
    const parts = parsed.pathname.split("/").filter(Boolean);
    const videoId = parts.length === 2 ? parseYouTubeVideoId(parts[1]) : null;
    if (!videoId) return null;
    const embedHost = host.includes("youtube-nocookie.com")
      ? "www.youtube-nocookie.com"
      : "www.youtube.com";
    embedUrl = new URL(`https://${embedHost}/embed/${videoId}`);
  } else {
    return null;
  }

  copyAllowedYouTubeParams(parsed.searchParams, embedUrl.searchParams);
  if (!embedUrl.searchParams.has("start")) {
    const start = parseYouTubeTimeToSeconds(parsed.searchParams.get("t"));
    if (start !== null) embedUrl.searchParams.set("start", String(start));
  }
  return embedUrl.toString();
}

function extractAtomEntryContent(entry) {
  const node = entry.querySelector("content") || entry.querySelector("summary");
  if (!node) return "";

  const type = (node.getAttribute("type") || "").toLowerCase();
  if (type === "xhtml" && node.children.length > 0) {
    const serializer = new XMLSerializer();
    return Array.from(node.children)
      .map((child) => serializer.serializeToString(child))
      .join("");
  }

  return node.textContent || "";
}

function parseRSS(xmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "text/xml");
  if (doc.querySelector("parsererror")) {
    throw new Error("Feed response was not valid XML");
  }
  const isAtom = !!doc.querySelector("feed");
  const items = [];
  if (isAtom) {
    const feedTitle =
      doc.querySelector("feed > title")?.textContent || "Untitled";
    Array.from(doc.querySelectorAll("entry")).slice(0, 500).forEach((entry) => {
      items.push({
        title: boundedText(entry.querySelector("title")?.textContent, 2000) || "Untitled",
        link:
          boundedText(
            entry.querySelector("link[rel='alternate']")?.getAttribute("href") ||
              entry.querySelector("link")?.getAttribute("href"),
            4096,
          ),
        published:
          boundedText(
            entry.querySelector("published")?.textContent ||
              entry.querySelector("updated")?.textContent,
            500,
          ),
        content: boundedText(extractAtomEntryContent(entry), 500000),
        author: boundedText(entry.querySelector("author > name")?.textContent, 1000),
      });
    });
    return { feedTitle: boundedText(feedTitle, 2000), items };
  }
  const channel = doc.querySelector("channel");
  const feedTitle = channel?.querySelector("title")?.textContent || "Untitled";
  Array.from(doc.querySelectorAll("item")).slice(0, 500).forEach((item) => {
    items.push({
      title: boundedText(item.querySelector("title")?.textContent, 2000) || "Untitled",
      link: boundedText(item.querySelector("link")?.textContent, 4096),
      published:
        boundedText(
          item.querySelector("pubDate")?.textContent ||
            item.querySelector("dc\\:date")?.textContent,
          500,
        ),
      content:
        boundedText(
          item.getElementsByTagName("content:encoded")[0]?.textContent ||
            item.querySelector("description")?.textContent,
          500000,
        ),
      author:
        boundedText(
          item.getElementsByTagName("dc:creator")[0]?.textContent ||
            item.querySelector("author")?.textContent,
          1000,
        ),
    });
  });
  return { feedTitle: boundedText(feedTitle, 2000), items };
}

function boundedText(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

async function fetchFeed(url) {
  return parseRSS(await fetchFeedText(url));
}

async function drainSync() {
  let appliedChanges = 0;
  let page = 0;
  let previousCursor = -1;
  while (true) {
    const result = await syncStateWithServer();
    appliedChanges += result?.appliedChanges || 0;
    if (!result?.hasMore && !result?.hasPendingMutations) return { appliedChanges };
    if (result.hasMore && result.nextCursor <= previousCursor) {
      throw new Error("Sync cursor did not advance");
    }
    if (result.hasPendingMutations && result.ackedMutations <= 0) {
      throw new Error("Sync did not acknowledge pending mutations");
    }
    if (result.hasMore) previousCursor = result.nextCursor;
    page += 1;
    if (page % 20 === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
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
    return d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
    });
  } catch {
    return dateStr;
  }
}

function stripHtml(html) {
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  return tmp.textContent || tmp.innerText || "";
}

function topLevelAncestor(node, root) {
  let cur = node;
  while (cur && cur.parentNode && cur.parentNode !== root) {
    cur = cur.parentNode;
  }
  return cur && cur.parentNode === root ? cur : null;
}

function wrapAsideMarkers(doc) {
  const body = doc.body;
  const collectTextNodes = () => {
    const walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT, null);
    const out = [];
    let n;
    while ((n = walker.nextNode())) out.push(n);
    return out;
  };

  let nodes = collectTextNodes();
  for (let i = 0; i < nodes.length; i++) {
    const openText = nodes[i];
    if (!openText.parentNode || !/<aside>/i.test(openText.nodeValue)) continue;

    let closeText = null;
    for (let j = i + 1; j < nodes.length; j++) {
      const candidate = nodes[j];
      if (!candidate.parentNode) continue;
      if (/<\/aside>/i.test(candidate.nodeValue)) {
        closeText = candidate;
        break;
      }
    }
    if (!closeText) {
      openText.nodeValue = openText.nodeValue.replace(/<aside>/gi, "");
      continue;
    }

    const openBlock = topLevelAncestor(openText, body);
    const closeBlock = topLevelAncestor(closeText, body);
    if (!openBlock || !closeBlock) continue;

    openText.nodeValue = openText.nodeValue.replace(/<aside>/i, "");
    closeText.nodeValue = closeText.nodeValue.replace(/<\/aside>/i, "");

    const aside = doc.createElement("aside");
    aside.className = "callout";
    openBlock.before(aside);

    let cursor = openBlock;
    while (cursor) {
      const next = cursor.nextSibling;
      aside.appendChild(cursor);
      if (cursor === closeBlock) break;
      cursor = next;
    }

    [openBlock, closeBlock].forEach((block) => {
      if (
        block &&
        block.nodeName === "P" &&
        !block.textContent.trim() &&
        block.children.length === 0
      ) {
        block.remove();
      }
    });

    nodes = collectTextNodes();
    i = -1;
  }
}

function processArticleContent(html) {
  if (!html) return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  wrapAsideMarkers(doc);
  doc.querySelectorAll("aside").forEach((aside) => {
    if (!aside.classList.contains("callout")) aside.classList.add("callout");
  });
  doc.querySelectorAll("textarea").forEach((textarea) => {
    const wrapper = doc.createElement("div");
    wrapper.className = "embed-block";
    const lang =
      textarea.getAttribute("data-language") ||
      textarea.className.replace(/^language-/, "").replace(/^lang-/, "") ||
      "";
    if (lang) {
      const label = doc.createElement("span");
      label.className = "embed-block-label";
      label.textContent = lang.toUpperCase();
      wrapper.appendChild(label);
    }
    const content = doc.createElement("div");
    content.className = "embed-block-content";
    content.innerHTML = textarea.value || textarea.textContent;
    wrapper.appendChild(content);
    textarea.replaceWith(wrapper);
  });

  doc.querySelectorAll("iframe").forEach((iframe) => {
    const normalizedSrc = normalizeYouTubeEmbedSrc(iframe.getAttribute("src") || "");
    if (!normalizedSrc) {
      iframe.remove();
      return;
    }

    iframe.setAttribute("src", normalizedSrc);
    iframe.setAttribute("loading", "lazy");
    iframe.setAttribute("allow", YOUTUBE_EMBED_ALLOW);
    iframe.setAttribute("allowfullscreen", "");
    iframe.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
    iframe.removeAttribute("srcdoc");
    Array.from(iframe.attributes).forEach((attr) => {
      if (attr.name.toLowerCase().startsWith("on")) {
        iframe.removeAttribute(attr.name);
      }
    });

    const wrapper = doc.createElement("div");
    wrapper.className = "video-embed";
    iframe.replaceWith(wrapper);
    wrapper.appendChild(iframe);
  });

  doc.querySelectorAll("img").forEach((image) => {
    image.setAttribute("loading", "lazy");
    image.setAttribute("referrerpolicy", "no-referrer");
  });
  doc.querySelectorAll("a").forEach((anchor) => {
    anchor.setAttribute("rel", "noopener noreferrer");
    anchor.removeAttribute("target");
  });

  return sanitizeArticleHtml(doc.body.innerHTML);
}

const SAMPLE_FEEDS = [
  { url: "https://hnrss.org/frontpage", name: "Hacker News" },
  {
    url: "https://feeds.arstechnica.com/arstechnica/index",
    name: "Ars Technica",
  },
  { url: "https://www.theverge.com/rss/index.xml", name: "The Verge" },
  { url: "https://feeds.bbci.co.uk/news/rss.xml", name: "BBC News" },
  { url: "https://lucumr.pocoo.org/feed.xml", name: "Armin Ronacher" },
];

const ARTICLE_GROUPS = ["Today", "Yesterday", "This week", "Earlier"];
const DATE_DIVIDER_ROW_HEIGHT = 42;
const ARTICLE_ROW_HEIGHT_DESKTOP = 176;
const ARTICLE_ROW_HEIGHT_MOBILE = 192;
const LIST_OVERSCAN_PX = 1100;

const FEED_COLORS = [
  "#8b5e3c",
  "#5b7a8e",
  "#6b7a4c",
  "#a36b4e",
  "#7b6a8c",
  "#b67a5a",
  "#5e8068",
  "#6b6052",
  "#9a6e7f",
  "#4e6b8b",
];

const articleMetadataCache = new Map();

const ICON_PATHS = {
  inbox: (
    <>
      <path d="M3 12h4l2 3h6l2-3h4" />
      <path d="M3 7l2-3h14l2 3v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
    </>
  ),
  circle: <circle cx="12" cy="12" r="7" />,
  star: (
    <polygon points="12 3 14.5 9.3 21 9.8 16 14.2 17.6 20.6 12 17.2 6.4 20.6 8 14.2 3 9.8 9.5 9.3" />
  ),
  starFill: (
    <polygon
      fill="currentColor"
      points="12 3 14.5 9.3 21 9.8 16 14.2 17.6 20.6 12 17.2 6.4 20.6 8 14.2 3 9.8 9.5 9.3"
    />
  ),
  plus: (
    <>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </>
  ),
  menu: (
    <>
      <path d="M4 7h16" />
      <path d="M4 12h16" />
      <path d="M4 17h16" />
    </>
  ),
  arrowLeft: (
    <>
      <path d="M19 12H5" />
      <path d="M12 19l-7-7 7-7" />
    </>
  ),
  refresh: (
    <>
      <path d="M21 12a9 9 0 1 1-3-6.7" />
      <path d="M21 4v5h-5" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 0 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 0 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 0 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 0 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </>
  ),
  external: (
    <>
      <path d="M14 4h6v6" />
      <path d="M10 14 20 4" />
      <path d="M19 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h6" />
    </>
  ),
  check: <polyline points="20 6 9 17 4 12" />,
  close: (
    <>
      <path d="M6 6l12 12" />
      <path d="M18 6 6 18" />
    </>
  ),
};

function Icon({ name, className = "icon" }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      {ICON_PATHS[name]}
    </svg>
  );
}

function hashString(value) {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function getFeedInitials(name = "") {
  const words = name
    .replace(/https?:\/\//, "")
    .split(/[\s./_-]+/)
    .filter(Boolean);
  if (words.length === 0) return "LF";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0]}${words[1][0]}`.toUpperCase();
}

function getFeedColor(feed) {
  const key = feed?.url || feed?.name || "lector";
  return FEED_COLORS[hashString(key) % FEED_COLORS.length];
}

function estimateReadTime(content = "") {
  const words = stripHtml(content).trim().split(/\s+/).filter(Boolean).length;
  return `${Math.max(1, Math.ceil(words / 225))} min`;
}

function getDateGroup(dateStr) {
  const published = new Date(dateStr);
  if (!dateStr || Number.isNaN(published.getTime())) return "Earlier";

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfPublished = new Date(
    published.getFullYear(),
    published.getMonth(),
    published.getDate(),
  );
  const diffDays = Math.floor(
    (startOfToday.getTime() - startOfPublished.getTime()) / 86400000,
  );

  if (diffDays <= 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return "This week";
  return "Earlier";
}

function groupArticleRowsByDate(rows) {
  return rows.reduce((groups, row) => {
    const group = getDateGroup(row.published);
    groups[group] = groups[group] || [];
    groups[group].push(row);
    return groups;
  }, {});
}

function getArticleExcerpt(article) {
  const text = stripHtml(article.content).replace(/\s+/g, " ").trim();
  return text || article.link || "Open the original article to read more.";
}

function getArticleMetadata(article) {
  const cached = articleMetadataCache.get(article.id);
  if (cached?.content === article.content) return cached.metadata;

  const metadata = {
    excerpt: getArticleExcerpt(article),
    readTime: estimateReadTime(article.content),
  };
  articleMetadataCache.set(article.id, {
    content: article.content,
    metadata,
  });
  return metadata;
}

function buildVirtualRows(groupedArticles) {
  return ARTICLE_GROUPS.flatMap((group) => {
    const articles = groupedArticles[group] || [];
    if (articles.length === 0) return [];
    return [
      { id: `divider:${group}`, type: "divider", label: group },
      ...articles.map((article) => ({
        id: article.id,
        type: "article",
        article,
      })),
    ];
  });
}

function addVirtualLayout(rows, articleRowHeight) {
  let offset = 0;
  const items = rows.map((row) => {
    const height =
      row.type === "divider" ? DATE_DIVIDER_ROW_HEIGHT : articleRowHeight;
    const item = { ...row, offset, height };
    offset += height;
    return item;
  });
  return { items, totalHeight: offset };
}

function firstRowEndingAfter(items, y) {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (items[mid].offset + items[mid].height <= y) low = mid + 1;
    else high = mid;
  }
  return low;
}

function firstRowStartingAtOrAfter(items, y) {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (items[mid].offset < y) low = mid + 1;
    else high = mid;
  }
  return low;
}

function getVisibleVirtualRows(items, scrollTop, viewportHeight) {
  if (items.length === 0) return [];
  const startY = Math.max(0, scrollTop - LIST_OVERSCAN_PX);
  const endY = scrollTop + viewportHeight + LIST_OVERSCAN_PX;
  const start = Math.max(0, firstRowEndingAfter(items, startY) - 2);
  const end = Math.min(items.length, firstRowStartingAtOrAfter(items, endY) + 2);
  return items.slice(start, end);
}

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
  const syncSettingsAvailable = canConfigureSync();
  const [feeds, setFeeds] = useState([]);
  const [articles, setArticles] = useState([]);
  const [selectedFeed, setSelectedFeed] = useState(null);
  const [selectedArticle, setSelectedArticle] = useState(null);
  const [newFeedUrl, setNewFeedUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [showAddFeed, setShowAddFeed] = useState(false);
  const [editingFeed, setEditingFeed] = useState(null);
  const [editingName, setEditingName] = useState("");
  const [draggedFeed, setDraggedFeed] = useState(null);
  const [feedDropTarget, setFeedDropTarget] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(!isMobile);
  const [viewFilter, setViewFilter] = useState("all");
  const [hydrated, setHydrated] = useState(false);
  const [syncConfigured, setSyncConfigured] = useState(false);
  const [showSyncConfig, setShowSyncConfig] = useState(false);
  const [syncEndpointInput, setSyncEndpointInput] = useState("");
  const [syncTokenInput, setSyncTokenInput] = useState("");
  const [syncConfigError, setSyncConfigError] = useState("");
  const [syncSaving, setSyncSaving] = useState(false);
  const [readerProgress, setReaderProgress] = useState(0);
  const readerRef = useRef(null);
  const listRef = useRef(null);
  const lastListScrollTopRef = useRef(0);
  const [listViewport, setListViewport] = useState({
    scrollTop: 0,
    height: typeof window === "undefined" ? 800 : window.innerHeight,
  });
  const loadSeq = useRef(0);
  const syncInFlight = useRef(false);

  const reloadArticles = useCallback(async () => {
    const seq = ++loadSeq.current;
    const arts = await listArticles();
    if (seq !== loadSeq.current) return; // stale request, ignore
    setArticles(arts);
  }, []);

  const runSync = useCallback(async () => {
    if (!syncConfigured || syncInFlight.current) return;
    syncInFlight.current = true;
    try {
      const { appliedChanges } = await drainSync();
      if (appliedChanges > 0) {
        setFeeds(await listFeeds());
        await reloadArticles();
      }
    } catch (e) {
      console.error("sync error:", e);
    } finally {
      syncInFlight.current = false;
    }
  }, [reloadArticles, syncConfigured]);

  const openSyncConfigDialog = useCallback(async () => {
    const cfg = await getSyncConfig();
    setSyncEndpointInput(cfg.endpoint || "");
    setSyncTokenInput(cfg.token || "");
    setSyncConfigError("");
    setShowSyncConfig(true);
  }, []);

  const handleSaveSyncConfig = async () => {
    setSyncSaving(true);
    setSyncConfigError("");
    const endpoint = syncEndpointInput.trim();
    const token = syncTokenInput.trim();
    if ((endpoint && !token) || (!endpoint && token)) {
      setSyncConfigError("Enter both endpoint and token, or use Disable Sync.");
      setSyncSaving(false);
      return;
    }

    try {
      const cfg = await setSyncConfig({
        endpoint,
        token,
      });
      const configured = cfg.configured ?? (!!cfg.endpoint && !!cfg.token);
      setSyncConfigured(configured);
      if (configured) {
        await runSync();
      }
      setShowSyncConfig(false);
    } catch (e) {
      console.error("save sync config error:", e);
      setSyncConfigError("Could not save sync settings.");
    } finally {
      setSyncSaving(false);
    }
  };

  const handleDisableSync = async () => {
    setSyncSaving(true);
    setSyncConfigError("");
    try {
      await setSyncConfig({ endpoint: "", token: "" });
      setSyncConfigured(false);
      setSyncEndpointInput("");
      setSyncTokenInput("");
      setShowSyncConfig(false);
    } catch (e) {
      console.error("disable sync error:", e);
      setSyncConfigError("Could not disable sync.");
    } finally {
      setSyncSaving(false);
    }
  };

  // Hydrate from DB on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await initDb();
      await importFromLocalStorageIfNeeded();
      const syncCfg = await getSyncConfig();
      const configured = syncCfg.configured ?? (!!syncCfg.endpoint && !!syncCfg.token);
      if (configured && navigator.onLine) {
        try {
          await drainSync();
        } catch (e) {
          console.error("initial sync error:", e);
        }
      }
      const dbFeeds = await listFeeds();
      if (cancelled) return;
      setSyncConfigured(configured);
      setSyncEndpointInput(syncCfg.endpoint || "");
      setSyncTokenInput(syncCfg.token || "");
      setFeeds(dbFeeds);
      const dbArticles = await listArticles();
      if (cancelled) return;
      setArticles(dbArticles);
      setHydrated(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshAllFeeds = useCallback(async () => {
    if (feeds.length === 0) return;
    setRefreshing(true);
    const results = await Promise.allSettled(
      feeds.map(async (feed) => ({ feed, result: await fetchFeed(feed.url) })),
    );
    for (const r of results) {
      if (r.status === "fulfilled") {
        const { feed, result } = r.value;
        await upsertArticles(
          feed.url,
          feed.name || result.feedTitle,
          result.items,
        );
      }
    }
    await reloadArticles();
    setRefreshing(false);
  }, [feeds, reloadArticles]);

  // Auto-refresh on hydration
  useEffect(() => {
    if (hydrated && feeds.length > 0) refreshAllFeeds();
  }, [hydrated, feeds.length]);

  useEffect(() => {
    const el = readerRef.current;
    if (!selectedArticle || !el) {
      setReaderProgress(0);
      return undefined;
    }

    const updateProgress = () => {
      const max = el.scrollHeight - el.clientHeight;
      setReaderProgress(max > 0 ? Math.min(100, (el.scrollTop / max) * 100) : 0);
    };

    el.addEventListener("scroll", updateProgress);
    updateProgress();
    return () => el.removeEventListener("scroll", updateProgress);
  }, [selectedArticle]);

  useEffect(() => {
    if (selectedArticle) return undefined;
    const el = listRef.current;
    if (!el) return undefined;

    const restoredTop = Math.min(
      lastListScrollTopRef.current,
      Math.max(0, el.scrollHeight - el.clientHeight),
    );
    if (Math.abs(el.scrollTop - restoredTop) > 1) {
      el.scrollTop = restoredTop;
    }

    const measure = () => {
      setListViewport((prev) => {
        const next = {
          scrollTop: el.scrollTop,
          height: el.clientHeight || prev.height,
        };
        return prev.scrollTop === next.scrollTop && prev.height === next.height
          ? prev
          : next;
      });
    };

    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }

    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [selectedArticle]);

  useEffect(() => {
    if (!hydrated || !syncConfigured) return;
    const tick = () => {
      void runSync();
    };
    const onOnline = () => {
      void runSync();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void runSync();
    };

    tick();
    const interval = setInterval(tick, 30000);
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      clearInterval(interval);
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [hydrated, runSync, syncConfigured]);

  const addFeed = async () => {
    if (!newFeedUrl.trim()) return;
    let url = newFeedUrl.trim();
    if (!url.startsWith("http")) url = "https://" + url;
    if (feeds.some((f) => f.url === url)) {
      setError("Already subscribed.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const result = await fetchFeed(url);
      const nf = {
        url,
        name: result.feedTitle,
        addedAt: new Date().toISOString(),
      };
      await dbAddFeed(nf);
      await upsertArticles(url, result.feedTitle, result.items);
      setFeeds(await listFeeds());
      await reloadArticles();
      void runSync();
      setNewFeedUrl("");
      setShowAddFeed(false);
    } catch (e) {
      console.error("addFeed error:", e);
      setError("Could not fetch feed. Check the URL and try again.");
    }
    setLoading(false);
  };

  const removeFeed = async (url) => {
    await dbRemoveFeed(url);
    setFeeds(await listFeeds());
    if (selectedFeed === url) setSelectedFeed(null);
    if (selectedArticle?.feedUrl === url) setSelectedArticle(null);
    await reloadArticles();
    void runSync();
  };

  const handleRenameFeed = async (url, newName) => {
    const trimmed = newName.trim().slice(0, 2000);
    if (!trimmed) {
      setEditingFeed(null);
      return;
    }
    await dbRenameFeed(url, trimmed);
    setFeeds(await listFeeds());
    setArticles((prev) =>
      prev.map((a) => (a.feedUrl === url ? { ...a, feedName: trimmed } : a)),
    );
    if (selectedArticle?.feedUrl === url)
      setSelectedArticle((prev) =>
        prev ? { ...prev, feedName: trimmed } : prev,
      );
    setEditingFeed(null);
    void runSync();
  };

  const commitFeedOrder = async (nextFeeds) => {
    setFeeds(nextFeeds);
    try {
      await dbReorderFeeds(nextFeeds.map((feed) => feed.url));
    } catch (e) {
      console.error("reorder feeds error:", e);
      setFeeds(await listFeeds());
    }
  };

  const moveFeed = (sourceUrl, targetUrl, edge = "before") => {
    if (!sourceUrl || sourceUrl === targetUrl) return;
    const source = feeds.find((feed) => feed.url === sourceUrl);
    const remaining = feeds.filter((feed) => feed.url !== sourceUrl);
    const targetIndex = remaining.findIndex((feed) => feed.url === targetUrl);
    if (!source || targetIndex < 0) return;
    const insertIndex = targetIndex + (edge === "after" ? 1 : 0);
    const nextFeeds = [...remaining];
    nextFeeds.splice(insertIndex, 0, source);
    void commitFeedOrder(nextFeeds);
  };

  const handleFeedDragOver = (event, targetUrl) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const bounds = event.currentTarget.getBoundingClientRect();
    const edge = event.clientY < bounds.top + bounds.height / 2 ? "before" : "after";
    setFeedDropTarget({ url: targetUrl, edge });
  };

  const handleFeedDrop = (event, targetUrl) => {
    event.preventDefault();
    const sourceUrl = draggedFeed || event.dataTransfer.getData("text/plain");
    const bounds = event.currentTarget.getBoundingClientRect();
    const edge = event.clientY < bounds.top + bounds.height / 2 ? "before" : "after";
    moveFeed(sourceUrl, targetUrl, edge);
    setDraggedFeed(null);
    setFeedDropTarget(null);
  };

  const addSampleFeed = async (sample) => {
    if (feeds.some((f) => f.url === sample.url)) return;
    setLoading(true);
    setError("");
    try {
      const result = await fetchFeed(sample.url);
      await dbAddFeed({
        url: sample.url,
        name: sample.name || result.feedTitle,
        addedAt: new Date().toISOString(),
      });
      await upsertArticles(
        sample.url,
        sample.name || result.feedTitle,
        result.items,
      );
      setFeeds(await listFeeds());
      await reloadArticles();
      void runSync();
    } catch {
      setError(`Could not fetch ${sample.name}.`);
    }
    setLoading(false);
  };

  const handleMarkRead = async (id) => {
    await dbMarkRead(id);
    setArticles((prev) =>
      prev.map((a) => (a.id === id ? { ...a, is_read: true } : a)),
    );
    void runSync();
  };

  const handleToggleRead = async (id) => {
    await dbToggleRead(id);
    setArticles((prev) =>
      prev.map((a) => (a.id === id ? { ...a, is_read: !a.is_read } : a)),
    );
    void runSync();
  };

  const handleToggleStar = async (id) => {
    await dbToggleStar(id);
    setArticles((prev) =>
      prev.map((a) => (a.id === id ? { ...a, is_starred: !a.is_starred } : a)),
    );
    setSelectedArticle((prev) =>
      prev && prev.id === id ? { ...prev, is_starred: !prev.is_starred } : prev,
    );
    void runSync();
  };

  const handleMarkAllRead = async () => {
    const ids = filteredArticles.map((a) => a.id);
    await dbMarkAllRead(ids);
    setArticles((prev) => {
      const idSet = new Set(ids);
      return prev.map((a) => (idSet.has(a.id) ? { ...a, is_read: true } : a));
    });
    void runSync();
  };

  const openArticle = (article) => {
    setSelectedArticle(article);
    handleMarkRead(article.id);
    if (isMobile) setSidebarOpen(false);
    setTimeout(() => {
      if (readerRef.current) readerRef.current.scrollTop = 0;
    }, 0);
  };

  const handleListScroll = useCallback((event) => {
    const el = event.currentTarget;
    lastListScrollTopRef.current = el.scrollTop;
    setListViewport((prev) => {
      const next = {
        scrollTop: el.scrollTop,
        height: el.clientHeight || prev.height,
      };
      return prev.scrollTop === next.scrollTop && prev.height === next.height
        ? prev
        : next;
    });
  }, []);

  const filteredArticles = useMemo(() => {
    let f = selectedFeed
      ? articles.filter((a) => a.feedUrl === selectedFeed)
      : articles;
    if (viewFilter === "unread") f = f.filter((a) => !a.is_read);
    if (viewFilter === "starred") f = f.filter((a) => a.is_starred);
    return f;
  }, [articles, selectedFeed, viewFilter]);

  const articleRows = useMemo(
    () =>
      filteredArticles.map((article) => {
        const metadata = getArticleMetadata(article);
        return {
          ...article,
          ...metadata,
        };
      }),
    [filteredArticles],
  );

  const selectedArticleReadTime = useMemo(
    () => (selectedArticle ? getArticleMetadata(selectedArticle).readTime : ""),
    [selectedArticle],
  );

  const selectedArticleContent = useMemo(
    () =>
      selectedArticle
        ? processArticleContent(selectedArticle.content) ||
          "<p>No content available. Open the original article to read more.</p>"
        : "",
    [selectedArticle],
  );

  const unreadCount = (feedUrl) => {
    const fa = feedUrl
      ? articles.filter((a) => a.feedUrl === feedUrl)
      : articles;
    return fa.filter((a) => !a.is_read).length;
  };

  const selectNav = (feed, filter) => {
    lastListScrollTopRef.current = 0;
    if (listRef.current) listRef.current.scrollTop = 0;
    setSelectedFeed(feed);
    setSelectedArticle(null);
    setViewFilter(filter);
    if (isMobile) setSidebarOpen(false);
  };
  const selectedFeedRecord = feeds.find((feed) => feed.url === selectedFeed);
  const totalUnread = unreadCount(null);
  const starredCount = articles.filter((article) => article.is_starred).length;
  const groupedArticles = useMemo(
    () => groupArticleRowsByDate(articleRows),
    [articleRows],
  );
  const rawVirtualRows = useMemo(
    () => buildVirtualRows(groupedArticles),
    [groupedArticles],
  );
  const articleRowHeight = isMobile
    ? ARTICLE_ROW_HEIGHT_MOBILE
    : ARTICLE_ROW_HEIGHT_DESKTOP;
  const { items: virtualRows, totalHeight: virtualListHeight } = useMemo(
    () => addVirtualLayout(rawVirtualRows, articleRowHeight),
    [articleRowHeight, rawVirtualRows],
  );
  const visibleRows = useMemo(
    () =>
      getVisibleVirtualRows(
        virtualRows,
        Math.min(listViewport.scrollTop, Math.max(0, virtualListHeight - listViewport.height)),
        listViewport.height,
      ),
    [listViewport.height, listViewport.scrollTop, virtualListHeight, virtualRows],
  );
  const listTitle = selectedFeedRecord
    ? selectedFeedRecord.name
    : viewFilter === "unread"
      ? "Unread"
      : viewFilter === "starred"
        ? "Starred"
        : "All Articles";
  const listSubtitle = selectedFeedRecord
    ? `${filteredArticles.length} article${filteredArticles.length === 1 ? "" : "s"}`
    : viewFilter === "unread"
      ? `${filteredArticles.length} unread`
      : viewFilter === "starred"
        ? `${filteredArticles.length} saved`
        : `${totalUnread} unread`;
  const topbarTitle = selectedArticle ? selectedArticle.feedName : listTitle;
  const topbarMeta = selectedArticle
    ? formatDate(selectedArticle.published)
    : listSubtitle;
  const sidebarState = isMobile ? "full" : sidebarOpen ? "full" : "hidden";

  if (!hydrated) {
    return (
      <div className="loading-screen">
        <div className="loading-mark">L</div>
        <p>Loading...</p>
      </div>
    );
  }

  return (
    <div
      className="app"
      data-sidebar={sidebarState}
      data-mobile-sidebar={sidebarOpen ? "open" : "closed"}
      data-density="comfortable"
    >
      {isMobile && sidebarOpen && (
        <button
          className="sidebar-scrim"
          aria-label="Close sidebar"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {syncSettingsAvailable && showSyncConfig && (
        <div className="modal-backdrop" onClick={() => setShowSyncConfig(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-heading">
              <div>
                <h2>Sync <em>settings</em></h2>
                <p className="modal-sub">
                  Enter your Worker endpoint and token for this computer.
                </p>
              </div>
              <button
                className="icon-btn"
                type="button"
                onClick={() => setShowSyncConfig(false)}
                title="Close"
              >
                <Icon name="close" />
              </button>
            </div>

            <label className="field-label" htmlFor="sync-endpoint">
              Sync endpoint
            </label>
            <input
              id="sync-endpoint"
              type="url"
              value={syncEndpointInput}
              onChange={(e) => setSyncEndpointInput(e.target.value)}
              placeholder="https://sync.lector.sarthakjariwala.com/v1/sync"
            />

            <label className="field-label" htmlFor="sync-token">
              Sync token
            </label>
            <input
              id="sync-token"
              type="password"
              value={syncTokenInput}
              onChange={(e) => setSyncTokenInput(e.target.value)}
              placeholder="Paste your SYNC_TOKEN"
              autoComplete="off"
            />

            {syncConfigError && <div className="form-error">{syncConfigError}</div>}

            <div className="modal-actions split">
              <button
                type="button"
                className="ghost-btn danger"
                onClick={handleDisableSync}
                disabled={syncSaving}
              >
                Disable Sync
              </button>
              <div className="action-row">
                <button
                  type="button"
                  className="ghost-btn"
                  onClick={() => setShowSyncConfig(false)}
                  disabled={syncSaving}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="primary-btn rust"
                  onClick={handleSaveSyncConfig}
                  disabled={syncSaving}
                >
                  {syncSaving ? "Saving..." : "Save"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="mark">L</span>
          <span className="name">
            L<em>e</em>ctor
          </span>
          {isMobile && (
            <button
              className="icon-btn mobile-close"
              type="button"
              onClick={() => setSidebarOpen(false)}
              title="Close sidebar"
            >
              <Icon name="close" />
            </button>
          )}
        </div>

        <div className="sidebar-section">
          <button
            className="nav-item"
            aria-current={!selectedFeed && viewFilter === "all" ? "true" : "false"}
            onClick={() => selectNav(null, "all")}
          >
            <Icon name="inbox" className="icon nav-icon" />
            <span className="nav-label">All Articles</span>
            {totalUnread > 0 && <span className="count">{totalUnread}</span>}
          </button>
          <button
            className="nav-item"
            aria-current={!selectedFeed && viewFilter === "unread" ? "true" : "false"}
            onClick={() => selectNav(null, "unread")}
          >
            <Icon name="circle" className="icon nav-icon" />
            <span className="nav-label">Unread</span>
            {totalUnread > 0 && <span className="count">{totalUnread}</span>}
          </button>
          <button
            className="nav-item"
            aria-current={!selectedFeed && viewFilter === "starred" ? "true" : "false"}
            onClick={() => selectNav(null, "starred")}
          >
            <Icon name="star" className="icon nav-icon" />
            <span className="nav-label">Starred</span>
            {starredCount > 0 && <span className="count">{starredCount}</span>}
          </button>
        </div>

        <div className="sidebar-section feed-section">
          <div className="sidebar-heading">
            <span>Feeds</span>
            <button
              className="add"
              type="button"
              onClick={() => setShowAddFeed((open) => !open)}
              title="Add feed"
            >
              <Icon name="plus" className="icon-sm" />
            </button>
          </div>

          {showAddFeed && (
            <div className="add-feed-panel">
              <input
                type="url"
                value={newFeedUrl}
                onChange={(e) => {
                  setNewFeedUrl(e.target.value);
                  setError("");
                }}
                onKeyDown={(e) => e.key === "Enter" && addFeed()}
                placeholder="Paste RSS feed URL..."
                className="feed-input"
                autoFocus
              />
              <div className="action-row">
                <button
                  type="button"
                  onClick={addFeed}
                  disabled={loading || !newFeedUrl.trim()}
                  className="primary-btn rust"
                >
                  {loading ? "Adding..." : "Subscribe"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowAddFeed(false);
                    setError("");
                  }}
                  className="ghost-btn"
                >
                  Cancel
                </button>
              </div>
              {error && <div className="form-error">{error}</div>}
              {feeds.length === 0 && (
                <div className="sample-feeds">
                  <span>Quick add</span>
                  <div>
                    {SAMPLE_FEEDS.map((sample) => (
                      <button
                        key={sample.url}
                        type="button"
                        onClick={() => addSampleFeed(sample)}
                        disabled={feeds.some((feed) => feed.url === sample.url) || loading}
                        className="sample-btn"
                      >
                        {sample.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="feed-list">
            {feeds.map((feed) => {
              const count = unreadCount(feed.url);
              const active = selectedFeed === feed.url;
              return (
                <div
                  key={feed.url}
                  className={`feed-row${draggedFeed === feed.url ? " dragging" : ""}`}
                  data-drop-edge={feedDropTarget?.url === feed.url ? feedDropTarget.edge : undefined}
                  onDragOver={(event) => handleFeedDragOver(event, feed.url)}
                  onDrop={(event) => handleFeedDrop(event, feed.url)}
                >
                  <span
                    className="feed-drag-handle"
                    role="button"
                    tabIndex={0}
                    draggable={editingFeed !== feed.url}
                    aria-label={`Reorder ${feed.name}`}
                    title="Drag to reorder"
                    onDragStart={(event) => {
                      setDraggedFeed(feed.url);
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData("text/plain", feed.url);
                    }}
                    onDragEnd={() => {
                      setDraggedFeed(null);
                      setFeedDropTarget(null);
                    }}
                    onKeyDown={(event) => {
                      const index = feeds.findIndex((item) => item.url === feed.url);
                      if (event.key === "ArrowUp" && index > 0) {
                        event.preventDefault();
                        moveFeed(feed.url, feeds[index - 1].url, "before");
                      } else if (event.key === "ArrowDown" && index < feeds.length - 1) {
                        event.preventDefault();
                        moveFeed(feed.url, feeds[index + 1].url, "after");
                      }
                    }}
                  >
                    <span />
                    <span />
                    <span />
                    <span />
                    <span />
                    <span />
                  </span>
                  {editingFeed === feed.url ? (
                    <div className="feed-edit">
                      <span
                        className="avatar"
                        style={{ background: getFeedColor(feed) }}
                      >
                        {getFeedInitials(feed.name)}
                      </span>
                      <input
                        autoFocus
                        value={editingName}
                        onChange={(e) => setEditingName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleRenameFeed(feed.url, editingName);
                          if (e.key === "Escape") setEditingFeed(null);
                        }}
                        onBlur={() => handleRenameFeed(feed.url, editingName)}
                      />
                    </div>
                  ) : (
                    <button
                      className="nav-item feed-item"
                      aria-current={active ? "true" : "false"}
                      onClick={() =>
                        selectNav(active ? null : feed.url, active ? "all" : "unread")
                      }
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        setEditingFeed(feed.url);
                        setEditingName(feed.name);
                      }}
                    >
                      <span
                        className="avatar"
                        style={{ background: getFeedColor(feed) }}
                      >
                        {getFeedInitials(feed.name)}
                      </span>
                      <span className="nav-label">{feed.name}</span>
                      {count > 0 ? <span className="count">{count}</span> : <span className="dot" />}
                    </button>
                  )}
                  <button
                    type="button"
                    className="remove-btn"
                    title="Unsubscribe"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeFeed(feed.url);
                    }}
                  >
                    <Icon name="close" className="icon-sm" />
                  </button>
                </div>
              );
            })}
          </div>

          {feeds.length === 0 && !showAddFeed && (
            <div className="sidebar-empty">
              <p>No feeds yet</p>
              <button
                type="button"
                className="primary-btn rust"
                onClick={() => setShowAddFeed(true)}
              >
                <Icon name="plus" className="icon-sm" />
                Add a feed
              </button>
            </div>
          )}
        </div>

        <div className="sidebar-footer">
          <span>
            <span className={`sync-dot ${syncConfigured ? "on" : ""}`} />
            <span className="sync-label">
              {syncConfigured
                ? (syncSettingsAvailable ? "Sync enabled" : "Private sync")
                : "Local only"}
            </span>
          </span>
          {syncSettingsAvailable && (
            <button
              type="button"
              className="footer-btn"
              title="Sync settings"
              onClick={() => void openSyncConfigDialog()}
            >
              <Icon name="settings" className="icon-sm" />
            </button>
          )}
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="topbar-left">
            <button
              type="button"
              className="icon-btn"
              onClick={() => setSidebarOpen((open) => !open)}
              title="Toggle sidebar"
            >
              <Icon name="menu" />
            </button>
            {selectedArticle && (
              <button
                type="button"
                className="icon-btn"
                onClick={() => setSelectedArticle(null)}
                title="Back"
              >
                <Icon name="arrowLeft" />
              </button>
            )}
            <div className="topbar-title">
              {topbarTitle}
              {topbarMeta && <span className="meta">{topbarMeta}</span>}
            </div>
          </div>

          <div className="topbar-right">
            {!selectedArticle && selectedFeed && (
              <div className="segmented" aria-label="Feed filter">
                {["all", "unread"].map((filter) => (
	                  <button
	                    type="button"
	                    key={filter}
	                    aria-current={viewFilter === filter ? "true" : "false"}
	                    onClick={() => {
	                      lastListScrollTopRef.current = 0;
	                      if (listRef.current) listRef.current.scrollTop = 0;
	                      setViewFilter(filter);
	                    }}
	                  >
                    {filter === "all" ? "All" : "Unread"}
                  </button>
                ))}
              </div>
            )}
            {!selectedArticle && filteredArticles.length > 0 && !isMobile && (
              <button type="button" onClick={handleMarkAllRead} className="pill-btn">
                <Icon name="check" className="icon-sm" />
                Mark all read
              </button>
            )}
            {selectedArticle?.link && (
              <button
                type="button"
                className="pill-btn"
                onClick={() => void openExternal(selectedArticle.link)}
              >
                <Icon name="external" className="icon-sm" />
                Open original
              </button>
            )}
            {syncSettingsAvailable && (
              <button
                type="button"
                onClick={() => void openSyncConfigDialog()}
                className="icon-btn"
                title={syncConfigured ? "Sync settings" : "Setup sync"}
              >
                <Icon name="settings" />
              </button>
            )}
            {!selectedArticle && (
              <button
                type="button"
                onClick={refreshAllFeeds}
                disabled={refreshing}
                className="icon-btn"
                title="Refresh"
              >
                <Icon name="refresh" />
              </button>
            )}
          </div>
        </header>

        {selectedArticle ? (
          <div className="reader-wrap" ref={readerRef}>
            <div className="progress-bar">
              <div style={{ "--p": `${readerProgress}%` }} />
            </div>
            <article className="reader">
              <div className="reader-meta">
                <span>{selectedArticle.feedName}</span>
                {selectedArticle.author && (
                  <>
                    <span className="sep">.</span>
                    <span className="author">{selectedArticle.author}</span>
                  </>
                )}
                <span className="time">
                  {formatDate(selectedArticle.published)} · {selectedArticleReadTime}
                </span>
              </div>
              <h1 className="reader-title">{selectedArticle.title}</h1>
              <div className="reader-actions">
                <button
                  type="button"
                  className={`action ${selectedArticle.is_starred ? "active" : ""}`}
                  onClick={() => handleToggleStar(selectedArticle.id)}
                >
                  <Icon
                    name={selectedArticle.is_starred ? "starFill" : "star"}
                    className="icon-sm"
                  />
                  {selectedArticle.is_starred ? "Starred" : "Star"}
                </button>
                {selectedArticle.link && (
                  <button
                    type="button"
                    className="action"
                    onClick={() => void openExternal(selectedArticle.link)}
                  >
                    <Icon name="external" className="icon-sm" />
                    Open original
                  </button>
                )}
              </div>
              <div
                className="article-body reader-body"
                onClick={(e) => {
                  const anchor = e.target.closest("a");
                  const href = anchor?.getAttribute("href");
                  if (href) {
                    e.preventDefault();
                    void openExternal(
                      href,
                      selectedArticle.link || selectedArticle.feedUrl,
                    );
                  }
                }}
                dangerouslySetInnerHTML={{
                  __html:
                    selectedArticleContent,
                }}
              />
            </article>
          </div>
        ) : (
          <div className="list-wrap" ref={listRef} onScroll={handleListScroll}>
            {filteredArticles.length === 0 ? (
              <div className="empty">
                <div className="ornament">{feeds.length === 0 ? "¶" : "✦"}</div>
                {feeds.length === 0 ? (
                  <>
                    <h2>
                      A quiet <em>library</em>, waiting for its first volume.
                    </h2>
                    <p>
                      Subscribe to your first feed to start reading. Lector will refresh,
                      sync, and keep the articles close at hand.
                    </p>
                    <div className="actions">
                      <button
                        type="button"
                        className="primary-btn rust"
                        onClick={() => {
                          setSidebarOpen(true);
                          setShowAddFeed(true);
                        }}
                      >
                        <Icon name="plus" className="icon-sm" />
                        Add your first feed
                      </button>
                    </div>
                  </>
                ) : viewFilter === "starred" ? (
                  <>
                    <h2>
                      Nothing <em>starred</em> yet.
                    </h2>
                    <p>Star an article from the reader to keep it within reach.</p>
                  </>
                ) : (
                  <>
                    <h2>
                      Inbox <em>zero</em>.
                    </h2>
                    <p>
                      {viewFilter === "unread"
                        ? "No unread articles."
                        : "No articles to show."}
                    </p>
                    <div className="actions">
                      <button
                        type="button"
                        className="ghost-btn"
                        onClick={refreshAllFeeds}
                        disabled={refreshing}
                      >
                        <Icon name="refresh" className="icon-sm" />
                        Check for updates
                      </button>
                    </div>
                  </>
                )}
              </div>
            ) : (
              <div className="list-inner">
                <div className="list-header">
                  <h1>
                    {selectedFeedRecord ? selectedFeedRecord.name : listTitle}
                  </h1>
                  <span className="count-meta">{listSubtitle}</span>
                </div>
                <div
                  className="virtual-list"
                  style={{
                    "--article-row-height": `${articleRowHeight}px`,
                    height: `${virtualListHeight}px`,
                  }}
                >
                  {visibleRows.map((row) =>
                    row.type === "divider" ? (
                      <div
                        key={row.id}
                        className="virtual-row divider-row"
                        style={{ "--row-y": `${row.offset}px` }}
                      >
                        <div className="date-divider">{row.label}</div>
                      </div>
                    ) : (
                      <div
                        key={row.id}
                        className="virtual-row article-row"
                        style={{ "--row-y": `${row.offset}px` }}
                      >
                        {(() => {
                          const article = row.article;
                          return (
                      <article
                        key={article.id}
                        className={`article-card ${article.is_read ? "read" : ""}`}
                        role="button"
                        tabIndex={0}
                        onClick={() => openArticle(article)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            openArticle(article);
                          }
                        }}
                      >
                        {!article.is_read && <span className="unread-dot" />}
                        <div className="a-content">
                          <div className="a-meta">
                            <span className="feed-name">{article.feedName}</span>
                            {article.author && (
                              <>
                                <span className="sep">.</span>
                                <span className="author">{article.author}</span>
                              </>
                            )}
                            <span className="time">{formatDate(article.published)}</span>
                          </div>
                          <div className="a-title">{article.title}</div>
                          <div className="a-excerpt">{article.excerpt}</div>
                          <div className="a-footer">
                            <span className="read-time">
                              {article.readTime}
                            </span>
                            {article.is_starred && (
                              <span className="star-chip">
                                <Icon name="starFill" className="icon-sm" />
                              </span>
                            )}
                            <span className="spacer" />
                            <button
                              type="button"
                              title={article.is_read ? "Mark as unread" : "Mark as read"}
                              className={`read-toggle-btn${article.is_read ? "" : " unread"}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleToggleRead(article.id);
                              }}
                            >
                              {article.is_read ? "Mark unread" : "Mark read"}
                            </button>
                          </div>
                        </div>
                      </article>
                          );
                        })()}
                      </div>
                    ),
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );

}
