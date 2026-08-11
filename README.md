# Lector — Private, Local-First RSS Reader

A clean, fast RSS feed reader built with React and Tauri, with an installable
private PWA for phones and browsers.

## Prerequisites

- **Node.js** (v20+) — [nodejs.org](https://nodejs.org)
- **Rust** — [rustup.rs](https://rustup.rs)
- **Tauri v2 CLI** — install after Rust:
  ```bash
  cargo install tauri-cli --version "^2"
  ```
- **Platform dependencies** (Linux only):
  ```bash
  sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
  ```

## Setup

```bash
# Install JS dependencies
npm install

# Run in development mode (hot reload)
cargo tauri dev

# Build macOS .app bundle
make build

# Build and install/update app in /Applications (macOS)
make build-install

# Direct Tauri build (all platforms)
cargo tauri build
```

The production binary will be in `src-tauri/target/release/`.

## Browser development

Run the frontend locally with:

```bash
npm install
npm run dev
```

The browser build uses IndexedDB and never stores the desktop sync token. Feed
fetching and sync use the same-origin Cloudflare Worker APIs at `/api/v1/feed`
and `/api/v1/sync`, so those operations require the deployed Worker and a valid
Cloudflare Access session. The local Vite server is primarily useful for UI and
offline-storage development.

## Features

- Subscribe to any RSS/Atom feed
- Read articles inline with a clean serif reading view
- Mark read/unread, star favorites
- Filter: All, Unread, Starred
- Data persists in local SQLite across sessions
- Private installable PWA with an IndexedDB cache and offline app shell
- Cloudflare Access authentication for the web app
- Mobile-responsive layout
- Quick-add popular feeds (HN, Ars Technica, The Verge, BBC News)

## Cloud Sync

Configure desktop sync inside the Tauri app via **Sync Settings** (top-right
action in the main view):

- Paste `https://sync.lector.sarthakjariwala.com/v1/sync`
- Paste your `SYNC_TOKEN`

You can rotate/update token values anytime from that same dialog.

For Tauri development only, you can still provide default values via env:

- `VITE_SYNC_ENDPOINT`
- `VITE_SYNC_TOKEN`

Do not use either variable for browser credentials. Vite build variables are
public, and the PWA authenticates through Cloudflare Access instead.

The Cloudflare Worker + D1 backend lives in `sync-worker/`. It serves two
strictly separated hosts:

- `lector.sarthakjariwala.com` — Access-protected PWA and browser APIs
- `sync.lector.sarthakjariwala.com/v1/sync` — bearer-authenticated desktop sync

The browser bundle does not contain `SYNC_TOKEN`, Access assertions, or feed
data. Subscriptions, read state, and starred state synchronize through D1;
article bodies remain in each device's local cache.

See [`sync-worker/README.md`](sync-worker/README.md) for the initial deployment
and Cloudflare Access setup.

## Web Build and Tests

```bash
npm test
npm run build:web
```

The production build includes the PWA manifest, icons, and an app-shell-only
service worker. API responses, raw feed XML, article bodies, and remote images
are deliberately not cached by the service worker.

## Project Structure

```
lector-app/
├── index.html          # HTML entry
├── package.json        # JS dependencies
├── vite.config.js      # Vite bundler config
├── src/
│   ├── main.jsx        # React entry
│   ├── App.jsx         # App wrapper
│   ├── RSSReader.jsx   # Main RSS reader component
│   ├── db.js           # Runtime storage facade
│   ├── db.tauri.js     # Desktop SQLite storage and sync
│   ├── db.web.js       # Browser IndexedDB storage and sync
│   └── platform.js     # Browser/Tauri network and link adapters
├── public/             # PWA icons
├── sync-worker/        # Cloudflare Worker, D1 schema, and deployment config
└── src-tauri/
    ├── Cargo.toml      # Rust dependencies
    ├── tauri.conf.json  # Tauri window/app config
    ├── build.rs        # Tauri build script
    └── src/
        ├── main.rs     # Rust entry
        └── lib.rs      # Tauri app builder
```
