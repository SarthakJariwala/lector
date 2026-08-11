# Sync Protocol V1

This document defines the cross-device sync contract for Lector.

## Scope

- One user with multiple personal devices.
- Desktop and private PWA clients.
- Local-first UX on every device.
- Cloud sync stores feed subscriptions and article read/star state only.

## Non-Goals

- No multi-user accounts in v1.
- No server-side RSS ingestion in v1.
- No syncing article content/body blobs.

## Canonical Article Identity

All clients must compute article IDs using the exact same rule:

`articleId = feedUrl + "::" + (link || title)`

If both `link` and `title` are empty, the article cannot be synced.

## Sync Data Model

### Feed State

- `feedUrl` (stable key)
- `name`
- `subscribed` (`true`/`false`)
- `addedAt`
- `nameChangedAt`, `nameChangedBy`
- `subscriptionChangedAt`, `subscriptionChangedBy`

### Article State

- `articleId` (canonical key)
- `feedUrl`
- `read` (`true`/`false`)
- `starred` (`true`/`false`)
- `readChangedAt`, `readChangedBy`
- `starredChangedAt`, `starredChangedBy`

## Mutations

Only explicit set-style mutations are allowed:

- `feed_upsert`
- `article_read_set`
- `article_star_set`

Toggle-style network mutations are forbidden.

Each sync request must include:

- `deviceId`

Each mutation must include:

- `mutationId` (monotonic per device)
- `changedAt` (logical clock timestamp)

## Conflict Resolution

Conflict resolution is field-level Last Write Wins (LWW).

Incoming field wins when:

1. `incoming.changedAt > stored.changedAt`, or
2. timestamps are equal and `incoming.changedBy` is lexicographically larger.

Fields resolve independently:

- feed `name` and `subscribed`
- article `read` and `starred`

## Transport API

The V1 body and response are available through two authenticated transports:

- Desktop: `POST /v1/sync` with `Authorization: Bearer <SYNC_TOKEN>`
- Private PWA: `POST /api/v1/sync` with a Cloudflare Access session

Single round-trip endpoint for push + pull:

- Request sends local mutations and last pulled cursor.
- Response returns acknowledged mutation IDs and remote changes after cursor.
- Clients must continue pulling while `hasMore` is `true`.

On a fresh device, the client pulls subscriptions and article state before
fetching the current contents of each subscribed feed. Article state may exist
locally before the matching article body is available.

## Local Client Guarantees

- Writes apply locally first.
- Sync is asynchronous.
- Outbox retries are idempotent.
- Local outbox entries are only removed after server ack.
- Article bodies and feed ordering remain local to each device.

## Versioning

- This file is the source of truth for V1 sync behavior.
- Any breaking change requires a new protocol version.
