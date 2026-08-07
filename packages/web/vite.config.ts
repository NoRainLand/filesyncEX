import { defineConfig } from "vite";

// 开发模式代理到本地 server（HTTP 4100 / WS 4200）
export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://127.0.0.1:4100", changeOrigin: true },
      "/ws": { target: "ws://127.0.0.1:4200", ws: true },
    },
  },
  build: {
    outDir: "dist",
    target: "es2022",
  },
});
