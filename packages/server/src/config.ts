import { z } from "zod";
import fs from "node:fs";
import path from "node:path";

/** 默认单文件上限：16 GiB（0 = 不限制） */
export const DEFAULT_MAX_FILE_SIZE = 16 * 1024 * 1024 * 1024;
/** 分片大小上下限：按文件大小动态取（1 MiB 起步，最大 8 MiB） */
export const DEFAULT_CHUNK_SIZE_MIN = 1024 * 1024; // 1 MiB
export const DEFAULT_CHUNK_SIZE_MAX = 8 * 1024 * 1024; // 8 MiB
/** 目标分片数：动态切片按「文件大小 / 该值」取最近的 2 的幂，再收敛到上下限 */
export const TARGET_CHUNK_COUNT = 4096;
/** 分片数硬上限：按上面规则算完后再兜一层，防止 maxFileSize 调得极大时分片数爆炸 */
export const MAX_CHUNK_COUNT = 32768;
/** 默认直传阈值：≤ 8 MiB 的文件整块直传（跳过整文件 SHA-256 与分片） */
export const DEFAULT_DIRECT_LIMIT = 8 * 1024 * 1024;

/** 单文件对应的切片大小（服务端权威：客户端一律按 init 返回值切分） */
export function computeChunkSize(fileSize: number, min = DEFAULT_CHUNK_SIZE_MIN, max = DEFAULT_CHUNK_SIZE_MAX): number {
  const lo = Math.max(1, Math.min(min, max));
  const hi = Math.max(lo, max);
  if (!Number.isFinite(fileSize) || fileSize <= 0) return lo;
  // 按「文件大小 / TARGET_CHUNK_COUNT」取最近的 2 的幂（下面用位运算实现），再收敛到 [lo, hi]
  const ideal = Math.round(fileSize / TARGET_CHUNK_COUNT);
  const pow2 = 2 ** Math.round(Math.log2(Math.max(1, ideal)));
  return Math.min(hi, Math.max(lo, pow2));
}

/** 分片数（含硬上限兜底：超出则按需放大切片） */
export function computeChunkPlan(fileSize: number, min?: number, max?: number): { chunkSize: number; chunkCount: number } {
  let chunkSize = computeChunkSize(fileSize, min, max);
  let chunkCount = Math.max(1, Math.ceil(Math.max(0, fileSize) / chunkSize));
  if (chunkCount > MAX_CHUNK_COUNT) {
    // 极端情况（上限被调得很大 + 上下限被设得很小）：放大到 2 的幂直到分片数受控
    while (chunkCount > MAX_CHUNK_COUNT && chunkSize < Number.MAX_SAFE_INTEGER) {
      chunkSize *= 2;
      chunkCount = Math.max(1, Math.ceil(fileSize / chunkSize));
    }
  }
  return { chunkSize, chunkCount };
}

export const ServerConfigSchema = z.object({
  /** HTTP 端口（WebSocket 复用同端口，path /ws）；0 = 交由系统分配空闲端口（测试用） */
  httpPort: z.number().int().min(0).max(65535).default(4100),
  dataDir: z.string().default("./data"),
  /** 前端静态资源目录（构建后）。exe 打包时由 shell 注入实际路径 */
  webDir: z.string().default("../web/dist"),
  dbFile: z.string().optional(),
  uploadDir: z.string().optional(),
  historyLimit: z.number().int().positive().default(500),
  /** 单个文件大小上限（字节，默认 16 GiB；0 = 不限制）。超限时 init 直接拒绝，客户端也会先本地预检 */
  maxFileSize: z.number().int().nonnegative().default(DEFAULT_MAX_FILE_SIZE),
  /** 分片大小**下限**（字节，默认 1 MiB）：小文件用这个粒度 */
  chunkSizeMin: z.number().int().positive().default(DEFAULT_CHUNK_SIZE_MIN),
  /** 分片大小**上限**（字节，默认 8 MiB）：超大文件最多放大到这里；与 min 相同即固定切片 */
  chunkSizeMax: z.number().int().positive().default(DEFAULT_CHUNK_SIZE_MAX),
  /** 直传阈值（字节，默认 8 MiB）：≤ 该值走 /api/upload/direct，跳过哈希与分片；必须 ≤ maxFileSize */
  directUpload: z.number().int().positive().default(DEFAULT_DIRECT_LIMIT),
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
      const raw = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
      // 旧配置兼容：早期版本用固定的 `chunkSize`，现在改为按文件大小动态切片（chunkSizeMin/Max）。
      // 迁移语义：显式配过 chunkSize 的用户通常是想「固定切片」，故同时作为上下限，行为与旧版一致。
      if (typeof raw.chunkSize === "number" && raw.chunkSize > 0) {
        if (raw.chunkSizeMin === undefined) raw.chunkSizeMin = raw.chunkSize;
        if (raw.chunkSizeMax === undefined) raw.chunkSizeMax = raw.chunkSize;
        console.warn(`[config] 检测到旧配置 chunkSize=${raw.chunkSize}，已迁移为 chunkSizeMin/Max（固定切片）；如需动态切片请删除该项`);
        delete raw.chunkSize;
      }
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
  // 一致性校验 ①：直传阈值不能超过单文件上限（否则 > 上限的文件会走进直传再被拒，错误信息自相矛盾）
  if (cfg.maxFileSize > 0 && cfg.directUpload > cfg.maxFileSize) {
    console.warn(`[config] directUpload(${cfg.directUpload}) > maxFileSize(${cfg.maxFileSize})，已把直传阈值收敛到单文件上限`);
    cfg.directUpload = cfg.maxFileSize;
  }
  // 一致性校验 ②：分片大小为 [min, max]；min > max 时以 min 为准（等价固定切片）
  if (cfg.chunkSizeMin > cfg.chunkSizeMax) {
    console.warn(`[config] chunkSizeMin(${cfg.chunkSizeMin}) > chunkSizeMax(${cfg.chunkSizeMax})，已把上限抬到下限（等价固定切片）`);
    cfg.chunkSizeMax = cfg.chunkSizeMin;
  }
  return {
    ...cfg,
    dataDir,
    dbFile: abs(cfg.dbFile ?? path.join(dataDir, "filesync.db")),
    uploadDir: abs(cfg.uploadDir ?? path.join(dataDir, "uploads")),
    webDir: abs(cfg.webDir),
    wsPort: cfg.httpPort,
  };
}
