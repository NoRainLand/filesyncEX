import { z } from "zod";

/* =========================================================
 * filesyncEX 协议 schema（单一起源）
 * 设备身份 / 消息 / 文件分片上传 / WebSocket 帧
 * ========================================================= */

/* ---------- 设备 ---------- */
export const Platform = z.enum(["windows", "macos", "linux", "android", "ios", "other"]);
export type Platform = z.infer<typeof Platform>;

export const DeviceInfo = z.object({
  deviceId: z.string().min(1),
  deviceName: z.string().min(1).max(40),
  color: z.string(), // 头像色（十六进制）
  platform: Platform,
});
export type DeviceInfo = z.infer<typeof DeviceInfo>;

/* ---------- 消息 ---------- */
export const Sender = z.object({
  deviceId: z.string().min(1),
  deviceName: z.string().min(1),
  color: z.string(),
  platform: Platform,
});
export type Sender = z.infer<typeof Sender>;

export const MsgKind = z.enum(["text", "file", "image", "audio", "video", "code"]);
export type MsgKind = z.infer<typeof MsgKind>;

/** 文件/图片/音频/视频消息的附件信息 */
export const FileMeta = z.object({
  name: z.string(),
  size: z.number().int().nonnegative(),
  mime: z.string().optional(),
  /** 存储对象 key（服务端分配，例如 uploads/<id>） */
  key: z.string().optional(),
  /** 供下载的相对路径 /api/file/<key> */
  url: z.string().optional(),
  /** 图片/视频缩略图数据（dataURL，小图预览用） */
  thumb: z.string().optional(),
  /** 文件 SHA-256（秒传去重用） */
  sha256: z.string().optional(),
});
export type FileMeta = z.infer<typeof FileMeta>;

/** 代码消息 */
export const CodeMeta = z.object({
  lang: z.string().default("ts"),
  content: z.string(),
});
export type CodeMeta = z.infer<typeof CodeMeta>;

export const MsgData = z.object({
  id: z.string().min(1), // 服务端生成，全局唯一
  kind: MsgKind,
  sender: Sender,
  ts: z.number().int(), // epoch ms
  text: z.string().optional(),
  code: CodeMeta.optional(),
  file: FileMeta.optional(),
  /** 若为回复/被删除等状态，可扩展 */
});
export type MsgData = z.infer<typeof MsgData>;

/** 发送草稿：客户端只需提供内容，id/sender/ts 由服务端补全 */
export const MsgInput = z.object({
  kind: MsgKind,
  text: z.string().optional(),
  code: CodeMeta.optional(),
  file: FileMeta.optional(),
});
export type MsgInput = z.infer<typeof MsgInput>;

/* ---------- 文件分片上传（HTTP） ---------- */
export const UploadInitReq = z.object({
  name: z.string().min(1),
  size: z.number().int().nonnegative(),
  mime: z.string().optional(),
  sha256: z.string().optional(), // 用于秒传校验
  device: DeviceInfo, // 上传者设备身份（用于文件消息的 sender）
  /** 断点续传：客户端持久化的上次 uploadId，匹配 name/size 则复用会话并返回已传分片 */
  uploadId: z.string().optional(),
});
export type UploadInitReq = z.infer<typeof UploadInitReq>;

export const UploadInitRes = z.object({
  uploadId: z.string(),
  chunkSize: z.number().int().positive(),
  chunkCount: z.number().int().positive(),
  /** 已收到的分片下标（断点续传：客户端跳过已完成） */
  done: z.array(z.number().int().nonnegative()),
  /** 秒传命中时 true（文件已存在，无需上传） */
  existed: z.boolean().default(false),
  /** 秒传命中时的附件 */
  file: FileMeta.optional(),
});
export type UploadInitRes = z.infer<typeof UploadInitRes>;

export const UploadChunkRes = z.object({
  ok: z.boolean(),
  index: z.number().int().nonnegative().optional(),
});
export type UploadChunkRes = z.infer<typeof UploadChunkRes>;

export const UploadCompleteRes = z.object({
  ok: z.boolean(),
  msg: MsgData.optional(), // 上传完成后的广播消息
});
export type UploadCompleteRes = z.infer<typeof UploadCompleteRes>;

/* ---------- WebSocket 帧 ---------- */
export const ClientFrame = z.discriminatedUnion("type", [
  /** 客户端上报设备身份 */
  z.object({ type: z.literal("hello"), device: DeviceInfo }),
  /** 客户端发送一条消息（text / code；文件类走 HTTP 分片上传） */
  z.object({ type: z.literal("send"), msg: MsgInput }),
  /** 删除消息 */
  z.object({ type: z.literal("del"), id: z.string() }),
  /** 修改昵称 */
  z.object({ type: z.literal("rename"), name: z.string().min(1).max(40) }),
  z.object({ type: z.literal("ping") }),
]);
export type ClientFrame = z.infer<typeof ClientFrame>;

export const ServerFrame = z.discriminatedUnion("type", [
  /** 连接欢迎：自身设备 + 全量历史 + 在线设备 */
  z.object({ type: z.literal("welcome"), self: DeviceInfo, msgs: z.array(MsgData), peers: z.array(DeviceInfo) }),
  /** 新增/广播消息 */
  z.object({ type: z.literal("add"), msg: MsgData }),
  /** 删除消息（广播） */
  z.object({ type: z.literal("del"), id: z.string() }),
  /** 在线设备列表变化 */
  z.object({ type: z.literal("peers"), peers: z.array(DeviceInfo) }),
  /** 某设备改名 */
  z.object({ type: z.literal("renamed"), device: DeviceInfo }),
  z.object({ type: z.literal("pong") }),
]);
export type ServerFrame = z.infer<typeof ServerFrame>;
