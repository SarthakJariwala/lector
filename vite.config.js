import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { fileURLToPath } from "node:url";

export default defineConfig(({ mode }) => {
  const isTauriTarget = mode === "tauri";

  return {
    plugins: [
    react(),
    !isTauriTarget && VitePWA({
      injectRegister: null,
      registerType: "prompt",
      includeAssets: ["apple-touch-icon.png"],
      manifest: {
        id: "/",
        name: "Lector",
        short_name: "Lector",
        description: "A private, local-first RSS reader.",
        start_url: "/",
        scope: "/",
        display: "standalone",
        background_color: "#faf7f2",
        theme_color: "#8b5e3c",
        icons: [
          {
            src: "/icon-192.png",
            sizes: "192x192",
            type: "image/png",
          },
          {
            src: "/icon-512.png",
            sizes: "512x512",
            type: "image/png",
          },
          {
            src: "/icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        cleanupOutdatedCaches: true,
        globPatterns: ["**/*.{html,js,css,woff,woff2,png,svg,ico}"],
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [],
      },
    }),
    ].filter(Boolean),
    resolve: {
      alias: {
        "lector-db-backend": fileURLToPath(new URL(
          isTauriTarget ? "./src/db.tauri.js" : "./src/db.web.js",
          import.meta.url,
        )),
        "lector-pwa": fileURLToPath(new URL(
          isTauriTarget ? "./src/pwa.tauri.js" : "./src/pwa.web.js",
          import.meta.url,
        )),
      },
    },
    clearScreen: false,
    server: {
      port: 1420,
      strictPort: true,
    },
    envPrefix: ["VITE_", "TAURI_"],
    build: {
      target: "es2020",
      minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
      sourcemap: !!process.env.TAURI_DEBUG,
    },
  };
});
