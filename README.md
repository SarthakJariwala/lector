# Lector — Personal RSS Reader

A clean, fast RSS feed reader built with React + Tauri.

## Prerequisites

- **Node.js** (v18+) — [nodejs.org](https://nodejs.org)
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

# Build for production
cargo tauri build
```

The production binary will be in `src-tauri/target/release/`.

## Running without Tauri (browser only)

If you just want to run it in the browser:

```bash
npm install
npm run dev
```

Then open http://localhost:1420. Note: some feeds may fail due to CORS
when running in a browser. In the Tauri desktop app, all feeds work
because there are no CORS restrictions.

## Features

- Subscribe to any RSS/Atom feed
- Read articles inline with a clean serif reading view
- Mark read/unread, star favorites
- Filter: All, Unread, Starred
- Data persists in localStorage across sessions
- Mobile-responsive layout
- Quick-add popular feeds (HN, Ars Technica, The Verge, BBC News)

## Project Structure

```
lector-app/
├── index.html          # HTML entry
├── package.json        # JS dependencies
├── vite.config.js      # Vite bundler config
├── src/
│   ├── main.jsx        # React entry
│   ├── App.jsx         # App wrapper
│   └── RSSReader.jsx   # Main RSS reader component
└── src-tauri/
    ├── Cargo.toml      # Rust dependencies
    ├── tauri.conf.json  # Tauri window/app config
    ├── build.rs        # Tauri build script
    └── src/
        ├── main.rs     # Rust entry
        └── lib.rs      # Tauri app builder
```
