import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

// Tauri sets TAURI_ENV_PLATFORM while running `tauri dev` / `tauri build`.
// The service worker is pointless (and gets in the way) inside the desktop shell,
// so the PWA layer only ships in the plain web build.
const isTauri = !!process.env.TAURI_ENV_PLATFORM;
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      disable: isTauri,
      registerType: "autoUpdate",
      includeAssets: ["icon.svg", "wallpapers/*.jpg"],
      manifest: {
        name: "Agentic OS Command Center",
        short_name: "Tony",
        description: "Agentic OS command center: agents, voice, telemetry.",
        theme_color: "#0b0d11",
        background_color: "#0b0d11",
        display: "standalone",
        orientation: "any",
        start_url: "./",
        scope: "./",
        icons: [
          { src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
        ],
        // Long-press the home-screen icon → "Talk". Also the target for a
        // hardware-button launch (Samsung side key / Android Routines / Shortcuts app).
        shortcuts: [
          {
            name: "Talk to Tony",
            short_name: "Talk",
            description: "Open straight into listening",
            url: "./?voice=1",
            icons: [{ src: "icons/icon-192.png", sizes: "192x192", type: "image/png" }],
          },
          {
            // Samsung Modes & Routines → "Open app shortcut" lands straight in the Lockdown HUD.
            name: "Lockdown Command Center",
            short_name: "Lockdown",
            description: "Distraction-free mobile HUD",
            url: "./?view=hud&mode=lockdown",
            icons: [{ src: "icons/icon-192.png", sizes: "192x192", type: "image/png" }],
          },
        ],
        launch_handler: { client_mode: "navigate-existing" },
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,woff2,jpg,webp}"],
        // The System Map's three.js chunk (~1 MB) is desktop-only (not in the phone nav, and
        // the page never loads it below md): don't make every phone precache it.
        globIgnores: ["**/HoloViewport-*.js"],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        // Never cache API / gateway traffic.
        navigateFallbackDenylist: [/^\/api\//],
      },
    }),
  ],
  // Relative base: the same build runs at / (Tauri) and at /cc/ when the gateway
  // serves it to phones. Routing is hash-based, so this is safe.
  base: "./",
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // ort's "extern wasm" build: loads the runtime from public/vad/ (wasmPaths) instead of
      // emitting a second 15 MB hashed copy into assets/.
      "onnxruntime-web/wasm": fileURLToPath(new URL("./node_modules/onnxruntime-web/dist/ort.wasm.min.mjs", import.meta.url)),
    },
  },
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_ENV_"],
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
    // Spotify's redirect URI is http://127.0.0.1:1420/callback. In dev Vite owns
    // :1420, so hand the redirect to the gateway, where Rust picks it up.
    proxy: {
      "/callback": {
        target: "http://127.0.0.1:8080",
        rewrite: (path) => path.replace(/^\/callback/, "/api/spotify/callback"),
        // Registered before Vite's own proxy error logger (which prints req.url), so if the
        // gateway is down the OAuth code/state never reach the dev terminal.
        configure: (proxy) => {
          proxy.on("error", (_err, req) => {
            if (req && typeof req.url === "string") req.url = req.url.split("?")[0];
          });
        },
      },
    },
  },
  build: {
    target: isTauri ? (process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari15") : "es2022",
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
