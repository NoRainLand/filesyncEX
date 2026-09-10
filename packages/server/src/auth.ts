import { randomBytes, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * 本机管理端点（/api/sys/*、/api/data/export、/api/app/download）的访问控制。
 *
 * 背景：这些端点能在桌面端机器上**关机、清空全部数据、改开机自启、导出全部聊天记录**。
 * 「只在局域网」不构成安全边界：运行 exe 的人会浏览外网页面，任意页面都能向
 * http://127.0.0.1:<port> 发起跨站请求（CORS 只拦读取响应，不拦请求发出）。
 *
 * 两道防线：
 *  1. **令牌**：进程启动时随机生成，浏览器首屏通过 GET /api/auth 取得（同源，跨站读不到），
 *     之后所有管理请求带 `X-FSEX-Token`。跨站页面拿不到令牌，也无法携带自定义头。
 *  2. **来源校验**：带 Origin/Sec-Fetch-Site 的浏览器请求，必须是本机来源
 *     （同 Host，或 localhost / 127.0.0.1 / [::1] —— 开发模式 Vite 代理跨端口需要）。
 *     无 Origin 且无 Sec-Fetch-Site 的请求（curl / 打包工具如 QuickSendTool）视为非浏览器客户端，
 *     仅凭令牌放行。
 */

/** 进程级管理令牌（每次启动重新生成，不落盘） */
const ADMIN_TOKEN = randomBytes(24).toString("hex");

/** 供前端 GET /api/auth 取得（同源可读，跨站被 CORS 拦住） */
export function adminToken(): string {
  return ADMIN_TOKEN;
}

/** 恒定时间比较，避免令牌比较被计时侧信道探测 */
function tokenEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** 从请求头 / query 取令牌（query 形式用于 <a download> 直接触发下载的场景） */
function readToken(req: Request): string | null {
  const h = req.get("x-fsex-token");
  if (h) return h;
  const q = req.query?.token;
  return typeof q === "string" && q ? q : null;
}

/** 本机来源白名单：同 Host，或 localhost / 127.0.0.1 / [::1]（任意端口，兼容开发模式 Vite 代理） */
function isLocalOrigin(req: Request, origin: string): boolean {
  let host: string;
  try {
    host = new URL(origin).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return false; // Origin 非法（如 "null"）→ 拒绝
  }
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
  // 同 Host：局域网设备直接访问桌面端地址（Origin 与 Host 同）
  const self = (req.get("host") ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  return !!self && host === self;
}

/** 是否是浏览器发起的站外请求（Origin/Sec-Fetch-Site 判定；两者都无 = 非浏览器客户端） */
function isCrossSiteBrowserRequest(req: Request): boolean {
  const site = req.get("sec-fetch-site");
  if (site) return site !== "same-origin" && site !== "same-site" && site !== "none";
  const origin = req.get("origin");
  if (origin) return !isLocalOrigin(req, origin);
  return false; // 无任何来源信息 → 非浏览器（curl / 工具）
}

/** 解析令牌：浏览器请求额外做来源校验 */
function reject(req: Request): string | null {
  const token = readToken(req);
  if (!token || !tokenEquals(token, ADMIN_TOKEN)) {
    return "缺少或无效的访问令牌（请通过网页界面 / NiarApp 接口操作，或携带 X-FSEX-Token 头）";
  }
  if (isCrossSiteBrowserRequest(req)) {
    return "拒绝跨站来源的本机管理请求（仅允许同源 / localhost 调用）";
  }
  return null;
}

/**
 * 管理端点守卫：令牌 + 来源校验，失败返回 403 JSON。
 * 令牌可通过 `X-FSEX-Token` 头或 `?token=` 查询参数提供。
 */
export const requireAdmin: RequestHandler = (req: Request, res: Response, next: NextFunction): void => {
  const err = reject(req);
  if (err) {
    console.warn(`[auth] 拒绝管理请求 ${req.method} ${req.originalUrl}（来自 ${req.ip}）：${err}`);
    res.status(403).json({ error: err });
    return;
  }
  next();
};
