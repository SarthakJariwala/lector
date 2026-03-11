# Sync Protocol V1

This document defines the cross-device sync contract for Lector.

## Scope

- One user with multiple personal devices.
- Desktop first, iPhone later.
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

Each mutation must include:

- `deviceId`
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

`POST /v1/sync`

Single round-trip endpoint for push + pull:

- Request sends local mutations and last pulled cursor.
- Response returns acknowledged mutation IDs and remote changes after cursor.

## Local Client Guarantees

- Writes apply locally first.
- Sync is asynchronous.
- Outbox retries are idempotent.
- Local outbox entries are only removed after server ack.

## Versioning

- This file is the source of truth for V1 sync behavior.
- Any breaking change requires a new protocol version.
