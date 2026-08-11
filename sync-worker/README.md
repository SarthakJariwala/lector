# Lector Cloudflare Worker

Cloudflare Worker + D1 backend for Lector's single-user desktop sync and private
PWA. The Worker also serves the built web app through Workers Static Assets.

## Host and Authentication Boundaries

| Host and path | Authentication | Purpose |
| --- | --- | --- |
| `lector.sarthakjariwala.com/*` | Cloudflare Access | PWA static assets |
| `lector.sarthakjariwala.com/api/v1/sync` | Access plus Worker JWT verification | Browser V1 sync |
| `lector.sarthakjariwala.com/api/v1/feed` | Access plus Worker JWT verification | Browser RSS/Atom fetch proxy |
| `sync.lector.sarthakjariwala.com/v1/sync` | `Authorization: Bearer <SYNC_TOKEN>` | Desktop V1 sync |

The browser API and desktop API share the same V1 sync implementation and D1
database. The browser never receives `SYNC_TOKEN`. Unknown hosts, Workers.dev,
and preview URLs cannot serve either the app or APIs.

## What Syncs

- Feed subscriptions (`name`, `subscribed`, change timestamps)
- Article state (`read`, `starred`, per-field timestamps)

Article bodies remain in local SQLite or IndexedDB. The feed proxy returns a
bounded live feed response but does not persist it in Cloudflare.

## Initial Cloudflare Setup

Run Wrangler commands from the repository root so the `../dist` assets path is
resolved correctly.

1. Ensure the D1 database ID in `wrangler.toml` is the intended production
   database. Apply `schema.sql` only when creating a new database:

   ```bash
   npx wrangler d1 execute lector-sync --file sync-worker/schema.sql --remote
   ```

2. In Cloudflare Zero Trust, create a **Self-hosted Access application** for
   `lector.sarthakjariwala.com`:

   - Protect the entire hostname.
   - Do not include `sync.lector.sarthakjariwala.com`; desktop clients
     authenticate that host with the bearer token instead.
   - Add an Allow policy for only your exact email address.
   - Leave the default behavior as deny.
   - Do not create an Everyone or bypass policy.

3. Record the Access team domain and the application's audience (`AUD`) tag.

4. Store all runtime authentication values as Worker secrets. Although the
   Access values are configuration rather than cryptographic secrets, using
   Worker secrets keeps the authorized identity out of the repository:

   ```bash
   npx wrangler secret put SYNC_TOKEN --config sync-worker/wrangler.toml
   npx wrangler secret put ACCESS_TEAM_DOMAIN --config sync-worker/wrangler.toml
   npx wrangler secret put ACCESS_AUD --config sync-worker/wrangler.toml
   npx wrangler secret put ACCESS_EMAIL --config sync-worker/wrangler.toml
   ```

   `ACCESS_TEAM_DOMAIN` may be entered as either
   `your-team.cloudflareaccess.com` or its HTTPS URL. `ACCESS_EMAIL` must match
   the identity allowed by the Access policy.

5. Build and deploy:

   ```bash
   npm test
   npm run deploy:web
   ```

   Wrangler creates the two custom-domain routes declared in `wrangler.toml`.
   DNS for both hostnames must be in the same Cloudflare account/zone.

6. Configure a modest Cloudflare rate limit for
   `lector.sarthakjariwala.com/api/v1/feed`. The Worker already enforces Access,
   HTTPS-only public targets, redirect validation, a ten-second timeout, and a
   two-MiB response limit.

7. In each desktop app, update Sync Settings to:

   ```text
   https://sync.lector.sarthakjariwala.com/v1/sync
   ```

   Keep the same `SYNC_TOKEN` that was stored for the new Worker, then verify a
   desktop push/pull and a PWA push/pull before retiring an older Worker.

## Safe Migration from the Existing Worker

The new config deploys as Worker `lector`, while the previous config used
`lector-sync`. This intentionally leaves the old Workers.dev endpoint available
during migration.

1. Deploy `lector` and verify both custom hosts.
2. Move every desktop installation to the new desktop sync URL.
3. Confirm subscriptions and read/star state round-trip on desktop and PWA.
4. Only then disable or delete the old `lector-sync` Worker.

Deleting or disabling the old Worker is a separate, destructive infrastructure
action and is not performed by repository scripts.

## Feed Proxy Policy

`POST /api/v1/feed` accepts:

```json
{ "url": "https://example.com/feed.xml" }
```

Only public HTTPS URLs on normal port 443 are accepted. Credentials, fragments,
IP literals, local/special-use names, custom ports, private DNS destinations,
and redirects to those targets are rejected. Caller cookies, authorization
headers, and Access assertions are never forwarded upstream.

HTTP-only feeds may continue to work in the desktop app but are intentionally
unsupported by the PWA.

## Security Notes

- Never put `SYNC_TOKEN` or Access values in a `VITE_*` variable.
- Cloudflare Access must protect the full PWA hostname; Worker JWT validation is
  defense in depth for browser API calls.
- `workers_dev = false`, `preview_urls = false`, and the Worker's host allowlist
  prevent alternate-host Access bypasses.
- Static responses receive a strict CSP and other browser security headers.
- Feed HTML is sanitized in the client before rendering.
- The D1 schema contains subscriptions and read/star metadata, not article
  bodies.
