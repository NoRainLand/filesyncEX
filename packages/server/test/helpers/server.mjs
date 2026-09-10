import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { run } from "../../dist/index.js";

/** 仓库根（packages/server/test/helpers/ → ../../../..） */
export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

/**
 * 启动一个测试用服务器（随机端口 + 独立临时数据目录）。
 * 默认 sqlite（与打包环境一致，能验证引用计数/物理文件回收）；内存模式用于不关心持久化的用例。
 */
export async function startServer(opts = {}) {
  const label = opts.label ?? `run-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const dataDir = path.join(rootDir, "_dev", "test-tmp", label);
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const srv = await run({
    config: {
      httpPort: 0, // 系统分配空闲端口
      webDir: path.join(rootDir, "_dev", "empty-web"),
      dataDir,
      store: opts.store ?? "sqlite",
      quiet: true,
      // 允许用例覆盖限制项（如把 maxFileSize 调小以验证超限拒绝）
      ...(opts.config ?? {}),
    },
    verbose: false,
  });
  const port = srv.httpPort;
  const base = `http://127.0.0.1:${port}`;
  const stop = async () => {
    await srv.close();
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* Windows 下 sqlite 句柄释放略有延迟，删不掉不影响测试结论 */
    }
  };
  let auth;
  for (let attempt = 0; ; attempt++) {
    try {
      auth = await (await fetch(base + "/api/auth")).json();
      break;
    } catch (e) {
      if (attempt >= 20) {
        throw new Error(`测试服务器未就绪（${base}）：${e?.cause?.message ?? e?.message ?? e}`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const token = auth.token;
  const adminFetch = (p, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set("X-FSEX-Token", token);
    return fetch(base + p, { ...init, headers });
  };
  return { base, wsUrl: `ws://127.0.0.1:${port}/ws`, srv, dataDir, uploadDir: path.join(dataDir, "uploads"), token, adminFetch, stop };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 测试用设备身份 */
export const device = (id = "dev-a", name = "user_test") => ({
  deviceId: id,
  deviceName: name,
  color: "#047878",
  platform: "other",
});

/** 直传一个小文件（≤ 8MiB 走 direct 路径） */
export async function uploadDirect(s, name, data, mime = "application/octet-stream", coverKey) {
  const q = new URLSearchParams({ name, mime, device: JSON.stringify(device()) });
  if (coverKey) q.set("coverKey", coverKey);
  const r = await fetch(`${s.base}/api/upload/direct?${q.toString()}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: data,
  });
  return { status: r.status, json: await r.json() };
}

/** 分片上传（init → chunk × N → complete 全链路） */
export async function uploadChunked(s, name, data, mime = "application/octet-stream", sha256) {
  const init = await (
    await fetch(`${s.base}/api/upload/init`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, size: data.length, mime, sha256, device: device() }),
    })
  ).json();
  for (let i = 0; i < init.chunkCount; i++) {
    const start = i * init.chunkSize;
    await fetch(`${s.base}/api/upload/chunk/${init.uploadId}/${i}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: data.subarray(start, Math.min(start + init.chunkSize, data.length)),
    });
  }
  const r = await fetch(`${s.base}/api/upload/complete/${init.uploadId}`, { method: "POST" });
  return { status: r.status, json: await r.json() };
}

/** 打开 WS 客户端并记录收到的帧（供断言 peers/del/add 广播） */
export async function openWs(s) {
  const { WebSocket } = await import("ws");
  const ws = new WebSocket(s.wsUrl);
  const frames = [];
  ws.on("message", (d) => frames.push(JSON.parse(d.toString())));
  await new Promise((res, rej) => {
    ws.on("open", () => res());
    ws.on("error", (e) => rej(e));
  });
  const waitFor = async (type, ms = 1500) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const hit = [...frames].reverse().find((f) => f.type === type);
      if (hit) return hit;
      await sleep(25);
    }
    return undefined;
  };
  return {
    frames,
    send: (f) => ws.send(JSON.stringify(f)),
    waitFor,
    close: () => ws.close(),
  };
}
