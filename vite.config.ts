import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// Standalone web chat client. Served separately from the OpenClaw gateway;
// the app connects to the gateway over WebSocket (ws:// or wss://).
export default defineConfig({
  base: "./",
  plugins: [vue()],
  server: {
    port: 5174,
    // The browser cannot sign the device challenge unless crypto.subtle is
    // available (secure context). For local dev over http://localhost the
    // context is still secure, so a plain `vite` dev server is fine. If you
    // serve from a non-localhost origin, serve over https.
  },
});
