import { z } from "zod";
import fs from "node:fs";
import path from "node:path";

export const ServerConfigSchema = z.object({
  /** HTTP 端口（WebSocket 复用同端口，path /ws） */
  httpPort: z.number().int().min(1).max(65535).default(4100),
  dataDir: z.string().default("./data"),
  /** 前端静态资源目录（构建后）。exe 打包时由 shell 注入实际路径 */
  webDir: z.string().default("../web/dist"),
  dbFile: z.string().optional(),
  uploadDir: z.string().optional(),
  historyLimit: z.number().int().positive().default(500),
  /** 存储实现：sqlite（默认）| memory（降级/测试） */
  store: z.enum(["sqlite", "memory"]).default("sqlite"),
  /** 启动时是否打印二维码/地址等（非交互 exe 场景关闭） */
  quiet: z.boolean().default(false),
});
export type ServerConfig = z.infer<typeof ServerConfigSchema>;

/** 解析后的配置：关键路径已归一化为绝对路径且必填 */
export type ResolvedConfig = ServerConfig & {
  dataDir: string;
  dbFile: string;
  uploadDir: string;
  webDir: string;
  wsPort: number;
};

/** 从 serverConfig.json（cwd）读取并合并默认值，归一化相对路径为绝对路径 */
export function loadConfig(overrides?: Partial<ServerConfig>): ResolvedConfig {
  let file: Partial<ServerConfig> = {};
  try {
    const p = path.resolve(process.cwd(), "serverConfig.json");
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, "utf8"));
      file = ServerConfigSchema.parse({ ...raw, ...overrides }) as Partial<ServerConfig>;
    }
  } catch (e) {
    console.warn("[config] 读取 serverConfig.json 失败，使用默认配置:", e);
  }
  // 环境变量覆盖端口（测试/多实例场景便捷入口）
  const envPort = (v: string | undefined, d: number) => (v ? Number(v) : d);
  const cfg = ServerConfigSchema.parse({
    ...file,
    ...overrides,
    ...(process.env.FSEX_HTTP_PORT ? { httpPort: envPort(process.env.FSEX_HTTP_PORT, 4100) } : {}),
  });
  const abs = (p: string) => path.resolve(process.cwd(), p);
  const dataDir = abs(cfg.dataDir);
  return {
    ...cfg,
    dataDir,
    dbFile: abs(cfg.dbFile ?? path.join(dataDir, "filesync.db")),
    uploadDir: abs(cfg.uploadDir ?? path.join(dataDir, "uploads")),
    webDir: abs(cfg.webDir),
    wsPort: cfg.httpPort,
  };
}
