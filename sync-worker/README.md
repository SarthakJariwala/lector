# Lector Sync Worker

Cloudflare Worker + D1 backend for single-user sync.

## What It Syncs

- Feed subscriptions (`name`, `subscribed`, change timestamps)
- Article state (`read`, `starred`, per-field timestamps)

## API

- `POST /v1/sync`

Request body shape:

```json
{
  "deviceId": "uuid",
  "lastPulledCursor": 0,
  "maxChanges": 500,
  "mutations": [
    {
      "mutationId": 1,
      "type": "feed_upsert",
      "feedUrl": "https://example.com/feed.xml",
      "name": "Example",
      "subscribed": true,
      "addedAt": 1731000000000,
      "changedAt": 1731000000000
    }
  ]
}
```

Response shape:

```json
{
  "ackedMutationIds": [1],
  "changes": [],
  "nextCursor": 0,
  "hasMore": false,
  "serverTime": 1731000001111,
  "reset": false
}
```

## Setup

1. Create a D1 database.
1. Replace `database_id` in `wrangler.toml`.
1. Run `wrangler d1 execute lector-sync --file schema.sql`.
1. Set the sync token secret: `wrangler secret put SYNC_TOKEN`.
1. Deploy: `wrangler deploy`.

## App Configuration

Set these env vars for the desktop app build:

- `VITE_SYNC_ENDPOINT`
- `VITE_SYNC_TOKEN`
