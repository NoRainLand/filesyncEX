/**
 * 上传消息 id 生成（本机预生成，服务端沿用）。
 *
 * 为什么由客户端生成：同一次上传的消息会经**两条路径**到达本机 —— WS 广播与 HTTP 响应，
 * 顺序不确定。若 id 只由服务端生成，客户端在广播先到时无法把自己的占位卡与真实消息对应起来，
 * 结果就是「同一条消息插两次」（上传一个文件出现两条相同消息，刷新后只剩一条）。
 * 预生成 id 后，占位卡 id = `upload-<msgId>`，两条路径都能认领它（见 app.ts 的 promote()）。
 *
 * 局域网 HTTP 不是安全上下文，`crypto.randomUUID` 可能不存在，故带回退实现。
 */
export function uploadMsgId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === "function") {
    try {
      return c.randomUUID();
    } catch {
      /* 极老实现可能抛错，走回退 */
    }
  }
  // RFC4122 v4 形态的随机 id（与服务端 randomUUID 的输出格式一致，便于日志比对）
  const rnd = (n: number): string => Math.floor(Math.random() * n).toString(16);
  const hex = (len: number): string => Array.from({ length: len }, () => rnd(16)).join("");
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${(8 + Math.floor(Math.random() * 4)).toString(16)}${hex(3)}-${hex(12)}`;
}
