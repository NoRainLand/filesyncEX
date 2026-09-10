/** 管理接口鉴权：令牌由服务器启动时生成，网页首屏通过 GET /api/auth 取得（同源可读，跨站被 CORS 拦住）。
 *  /api/sys/*、/api/data/export、/api/app/download 等本机管理端点均需携带 X-FSEX-Token。 */

let tokenPromise: Promise<string> | null = null;

/** 取管理令牌（共享 Promise，多次调用只请求一次；失败回退空串 → 管理端点会 403 并打印可读错误） */
export function fetchToken(): Promise<string> {
  if (!tokenPromise) {
    tokenPromise = fetch("/api/auth")
      .then((r) => (r.ok ? (r.json() as Promise<{ token?: string }>) : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => d.token ?? "")
      .catch(() => "");
  }
  return tokenPromise;
}

/** 清空缓存的令牌，下次调用重新获取（令牌随服务器重启变化；页面不刷新时用这个恢复） */
export function resetToken(): void {
  tokenPromise = null;
}

/**
 * 带鉴权的 fetch：自动附加 `X-FSEX-Token`；遇 403（令牌失效，如服务器重启过）
 * 自动重新取令牌并重试一次。
 */
export async function authFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const withToken = async (tk: string): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (tk) headers.set("X-FSEX-Token", tk);
    return fetch(input, { ...init, headers });
  };
  let r = await withToken(await fetchToken());
  if (r.status === 403) {
    resetToken();
    r = await withToken(await fetchToken());
  }
  return r;
}
