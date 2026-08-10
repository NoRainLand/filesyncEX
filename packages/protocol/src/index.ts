import type { z } from "zod";

export {
  Platform,
  DeviceInfo,
  Sender,
  MsgKind,
  FileMeta,
  CodeMeta,
  MsgData,
  MsgInput,
  UploadInitReq,
  UploadInitRes,
  UploadChunkRes,
  UploadCompleteRes,
  ClientFrame,
  ServerFrame,
} from "./schema.js";
export type {
  Platform as PlatformT,
  DeviceInfo as DeviceInfoT,
  FileMeta as FileMetaT,
  MsgData as MsgDataT,
  UploadInitRes as UploadInitResT,
  UploadCompleteRes as UploadCompleteResT,
  ClientFrame as ClientFrameT,
  ServerFrame as ServerFrameT,
} from "./schema.js";

/** 校验辅助：解析失败抛错（返回推断输出类型） */
export function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  return schema.parse(value);
}
