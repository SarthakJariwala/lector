const IS_TAURI_TARGET = import.meta.env.MODE === "tauri";

export function isTauriRuntime() {
  return IS_TAURI_TARGET;
}

export function canConfigureSync() {
  return isTauriRuntime();
}

export async function fetchFeedText(url) {
  if (isTauriRuntime()) {
    const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
    const response = await tauriFetch(url, {
      method: "GET",
      headers: {
        Accept:
          "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
        "User-Agent": "Lector/1.0",
      },
      connectTimeout: 12000,
      maxRedirections: 10,
    });
    if (!response.ok) throw new Error(`Feed request failed with HTTP ${response.status}`);
    return response.text();
  }

  const response = await fetch("/api/v1/feed", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  const contentType = response.headers.get("content-type") || "";
  if (!response.ok) {
    let detail = "";
    if (contentType.includes("application/json")) {
      try {
        detail = (await response.json())?.error || "";
      } catch {}
    }
    throw new Error(detail || `Feed request failed with HTTP ${response.status}`);
  }
  if (!contentType.includes("xml")) {
    throw new Error("Your private session expired. Reload Lector to sign in again.");
  }
  return response.text();
}

export function syncRequest(body) {
  return fetch("/api/v1/sync", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function openExternal(value, baseUrl) {
  let url;
  try {
    url = new URL(value, baseUrl);
  } catch {
    return;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return;

  if (isTauriRuntime()) {
    const { open } = await import("@tauri-apps/plugin-shell");
    await open(url.toString());
    return;
  }

  window.open(url.toString(), "_blank", "noopener,noreferrer");
}
