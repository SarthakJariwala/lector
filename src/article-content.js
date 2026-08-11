import DOMPurify from "dompurify";

const ALLOWED_TAGS = [
  "a", "abbr", "aside", "b", "blockquote", "br", "caption", "code", "col",
  "colgroup", "dd", "del", "details", "div", "dl", "dt", "em", "figcaption",
  "figure", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "iframe", "img",
  "kbd", "li", "mark", "ol", "p", "picture", "pre", "q", "s", "samp",
  "small", "source", "span", "strong", "sub", "summary", "sup", "table", "tbody",
  "td", "tfoot", "th", "thead", "time", "tr", "u", "ul", "var",
];

const ALLOWED_ATTR = [
  "alt", "allow", "allowfullscreen", "aria-label", "class", "colspan", "datetime",
  "height", "href", "loading", "open", "referrerpolicy", "rel", "role", "rowspan",
  "scope", "src", "target", "title", "type", "width",
];

const YOUTUBE_EMBED_HOSTS = new Set([
  "www.youtube.com",
  "www.youtube-nocookie.com",
]);
const ARTICLE_CLASSES = new Set([
  "callout",
  "video-embed",
  "embed-block",
  "embed-block-label",
  "embed-block-content",
]);

function isSafeYouTubeIframe(iframe) {
  try {
    const url = new URL(iframe.getAttribute("src") || "");
    return url.protocol === "https:"
      && YOUTUBE_EMBED_HOSTS.has(url.hostname.toLowerCase())
      && /^\/embed\/[A-Za-z0-9_-]{11}$/.test(url.pathname)
      && !iframe.hasAttribute("srcdoc");
  } catch {
    return false;
  }
}

export function sanitizeArticleHtml(html) {
  const sanitized = DOMPurify.sanitize(html || "", {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: true,
    ALLOW_UNKNOWN_PROTOCOLS: false,
    FORBID_TAGS: [
      "base", "button", "embed", "form", "input", "link", "math", "meta", "object",
      "script", "select", "style", "svg", "textarea",
    ],
    FORBID_ATTR: ["id", "srcdoc", "srcset", "style"],
  });
  const doc = new DOMParser().parseFromString(sanitized, "text/html");
  doc.querySelectorAll("iframe").forEach((iframe) => {
    if (!isSafeYouTubeIframe(iframe)) iframe.remove();
  });
  doc.querySelectorAll("[class]").forEach((element) => {
    const classes = Array.from(element.classList)
      .filter((className) => ARTICLE_CLASSES.has(className));
    if (classes.length > 0) {
      element.setAttribute("class", classes.join(" "));
    } else {
      element.removeAttribute("class");
    }
  });
  return doc.body.innerHTML;
}
