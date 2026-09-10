import { defineConfig } from "vite";

/**
 * 开发代理：Vite 5173 → 本地 server。
 * 注意 HTTP 与 WebSocket **复用同一端口**（server 在 /ws 路径上挂 WS，见 packages/server/src/index.ts），
 * 所以 /api 与 /ws 都必须代理到 4100 —— 早期配置把 /ws 指到 4200，导致 dev 模式实时同步失效。
 * server 端口可用 FSEX_HTTP_PORT 覆盖；被占用时 server 会自动向后切换并打印实际端口。
 */
const SERVER_PORT = Number(process.env.FSEX_HTTP_PORT ?? 4100);

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      "/api": { target: `http://127.0.0.1:${SERVER_PORT}`, changeOrigin: true },
      "/ws": { target: `ws://127.0.0.1:${SERVER_PORT}`, ws: true },
    },
  },
  build: {
    outDir: "dist",
    target: "es2022",
  },
});
