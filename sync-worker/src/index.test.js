import { describe, expect, it, vi } from "vitest";
import worker, { validateFeedUrl } from "./index";

const baseEnv = {
  APP_HOST: "lector.sarthakjariwala.com",
  DESKTOP_SYNC_HOST: "sync.lector.sarthakjariwala.com",
  APP_ORIGIN: "https://lector.sarthakjariwala.com",
  ASSETS: {
    fetch: vi.fn(async () => new Response("<html>Lector</html>", {
      headers: { "content-type": "text/html" },
    })),
  },
};

describe("worker routing", () => {
  it("serves only the app host and adds browser security headers", async () => {
    const response = await worker.fetch(
      new Request("https://lector.sarthakjariwala.com/"),
      baseEnv,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy"))
      .toContain("script-src 'self'");
  });

  it("rejects alternate hosts and unauthenticated desktop requests", async () => {
    const alternate = await worker.fetch(
      new Request("https://lector.example.workers.dev/"),
      baseEnv,
    );
    const desktop = await worker.fetch(
      new Request("https://sync.lector.sarthakjariwala.com/v1/sync", {
        method: "POST",
      }),
      baseEnv,
    );

    expect(alternate.status).toBe(404);
    expect(desktop.status).toBe(401);
  });

  it("rejects browser mutations without the exact app origin", async () => {
    const response = await worker.fetch(
      new Request("https://lector.sarthakjariwala.com/api/v1/sync", {
        method: "POST",
        headers: { origin: "https://evil.example" },
      }),
      baseEnv,
    );

    expect(response.status).toBe(403);
  });
});

describe("validateFeedUrl", () => {
  it("accepts public HTTPS feed URLs", () => {
    expect(validateFeedUrl("https://feeds.example.com/rss.xml").href)
      .toBe("https://feeds.example.com/rss.xml");
  });

  it.each([
    "http://feeds.example.com/rss.xml",
    "https://user:pass@feeds.example.com/rss.xml",
    "https://feeds.example.com:8443/rss.xml",
    "https://localhost/rss.xml",
    "https://reader.local/rss.xml",
    "https://service.internal/rss.xml",
    "https://127.0.0.1/rss.xml",
    "https://[::1]/rss.xml",
  ])("rejects unsafe target %s", (url) => {
    expect(() => validateFeedUrl(url)).toThrow();
  });
});
