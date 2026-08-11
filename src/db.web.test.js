import "fake-indexeddb/auto";
import { beforeAll, describe, expect, it, vi } from "vitest";

const syncRequest = vi.hoisted(() => vi.fn());
vi.mock("./platform", () => ({ syncRequest }));

import {
  addFeed,
  initDb,
  listArticles,
  listFeeds,
  markAllRead,
  markRead,
  syncStateWithServer,
  toggleStar,
  upsertArticles,
} from "./db.web";
import { MAX_SYNC_REQUEST_BYTES } from "./sync-request";

describe("browser database", () => {
  beforeAll(async () => {
    await initDb();
  });

  it("persists local mutations and overlays remote state received before a body", async () => {
    const feedUrl = "https://example.com/feed.xml";
    const firstArticleId = `${feedUrl}::https://example.com/first`;
    const remoteArticleId = `${feedUrl}::https://example.com/remote`;
    const serverTime = Date.now() + 10000;

    await addFeed({
      url: feedUrl,
      name: "Example",
      addedAt: "2026-08-10T00:00:00.000Z",
    });
    await upsertArticles(feedUrl, "Example", [{
      title: "First",
      link: "https://example.com/first",
      published: "2026-08-10T00:00:00.000Z",
      content: "<p>First body</p>",
      author: "Author",
    }]);
    await markRead(firstArticleId);

    syncRequest.mockImplementation(async (request) => ({
      ackedMutationIds: request.mutations.map((mutation) => mutation.mutationId),
      changes: [{
        seq: 1,
        type: "article_state",
        articleId: remoteArticleId,
        feedUrl,
        read: true,
        readChangedAt: Date.now() + 1000,
        readChangedBy: "remote-device",
        starred: true,
        starredChangedAt: Date.now() + 1000,
        starredChangedBy: "remote-device",
      }],
      nextCursor: 1,
      hasMore: false,
      serverTime,
    }));

    const result = await syncStateWithServer();
    expect(result).toMatchObject({ ackedMutations: 2, appliedChanges: 1, nextCursor: 1 });
    expect(syncRequest).toHaveBeenCalledWith(expect.objectContaining({
      lastPulledCursor: 0,
      mutations: [
        expect.objectContaining({ type: "feed_upsert", subscribed: true }),
        expect.objectContaining({ type: "article_read_set", articleId: firstArticleId, value: true }),
      ],
    }));

    await upsertArticles(feedUrl, "Example", [{
      title: "Remote",
      link: "https://example.com/remote",
      published: "2026-08-10T01:00:00.000Z",
      content: "<p>Remote body</p>",
      author: "Author",
    }]);

    expect(await listFeeds()).toEqual([expect.objectContaining({ url: feedUrl, name: "Example" })]);
    expect(await listArticles()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: firstArticleId, is_read: true }),
      expect.objectContaining({ id: remoteArticleId, is_read: true, is_starred: true }),
    ]));

    await toggleStar(remoteArticleId);
    syncRequest.mockResolvedValue({
      ackedMutationIds: [3],
      changes: [],
      nextCursor: 1,
      hasMore: false,
      serverTime,
    });
    await syncStateWithServer();
    expect(syncRequest).toHaveBeenLastCalledWith(expect.objectContaining({
      mutations: [expect.objectContaining({
        type: "article_star_set",
        changedAt: expect.any(Number),
      })],
    }));
    expect(syncRequest.mock.calls.at(-1)[0].mutations[0].changedAt)
      .toBeGreaterThan(serverTime);
  });

  it("drains a multibyte outbox through byte-bounded request batches", async () => {
    const feedUrl = "https://large.example.com/feed.xml";
    const suffix = "界".repeat(7500);
    const items = Array.from({ length: 201 }, (_, index) => ({
      title: `Article ${index}`,
      link: `https://large.example.com/${index}/${suffix}`,
      published: "2026-08-10T00:00:00.000Z",
      content: "",
      author: "",
    }));
    const articleIds = items.map((item) => `${feedUrl}::${item.link}`);

    await addFeed({
      url: feedUrl,
      name: "Large",
      addedAt: "2026-08-10T00:00:00.000Z",
    });
    await upsertArticles(feedUrl, "Large", items);
    await markAllRead(articleIds);

    syncRequest.mockClear();
    const submittedMutationIds = [];
    const submittedArticleIds = [];
    syncRequest.mockImplementation(async (request) => {
      expect(new TextEncoder().encode(JSON.stringify(request)).byteLength)
        .toBeLessThanOrEqual(MAX_SYNC_REQUEST_BYTES);
      submittedMutationIds.push(...request.mutations.map((mutation) => mutation.mutationId));
      submittedArticleIds.push(...request.mutations
        .filter((mutation) => mutation.type === "article_read_set")
        .map((mutation) => mutation.articleId));
      return {
        ackedMutationIds: request.mutations.map((mutation) => mutation.mutationId),
        changes: [],
        nextCursor: request.lastPulledCursor,
        hasMore: false,
        serverTime: Date.now(),
      };
    });

    let result;
    for (let attempt = 0; attempt < 10; attempt++) {
      result = await syncStateWithServer();
      if (!result.hasPendingMutations) break;
    }

    expect(syncRequest.mock.calls.length).toBeGreaterThan(1);
    expect(result.hasPendingMutations).toBe(false);
    expect(new Set(submittedMutationIds).size).toBe(202);
    expect(new Set(submittedArticleIds)).toEqual(new Set(articleIds));
  }, 20000);
});
