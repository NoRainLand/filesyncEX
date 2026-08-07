import type { DeviceInfoT, PlatformT } from "@filesyncex/protocol";

const STORAGE_KEY = "fsex_device";

/** FNV-1a 32bit 哈希 → 8 位 hex */
function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function detectPlatform(): PlatformT {
  const ua = navigator.userAgent;
  if (/android/i.test(ua)) return "android";
  if (/iphone|ipad|ipod/i.test(ua)) return "ios";
  if (/mac/i.test(ua)) return "macos";
  if (/linux/i.test(ua)) return "linux";
  if (/win/i.test(ua)) return "windows";
  return "other";
}

/** 设备指纹：UA+语言+平台+屏幕+时区+核数 → FNV-1a hash（只存 hash，不上传原始信号） */
export function deviceFingerprint(): string {
  const parts = [
    navigator.userAgent,
    navigator.language,
    detectPlatform(),
    `${screen.width}x${screen.height}`,
    new Date().getTimezoneOffset(),
    navigator.hardwareConcurrency ?? 0,
  ];
  return fnv1a(parts.join("|"));
}

/** miku 色板（按 hash 取模，稳定头像色） */
const PALETTE = ["#047878", "#86cecb", "#e12885", "#4a90d9", "#e5a53d", "#7a5fd0"];

/** 昵称规则：仅大小写字母/下划线/数字，最长 10 位（与协议 rename 帧一致） */
const NICK_RE = /^[A-Za-z0-9_]{1,10}$/;

/** 生成默认昵称 user_XXXX（四位数字，按设备指纹哈希取模） */
function defaultName(id: string): string {
  return `user_${String(Number.parseInt(id.slice(0, 4), 16) % 10000).padStart(4, "0")}`;
}

/** 读取/创建本机设备身份（localStorage 持久化） */
export function getDevice(): DeviceInfoT {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const d = JSON.parse(raw) as DeviceInfoT;
      // 兼容旧昵称（用户-XXXX 等不符合新规则）：重置为 user_XXXX
      if (d && d.deviceId) {
        if (!NICK_RE.test(d.deviceName ?? "")) {
          d.deviceName = defaultName(d.deviceId);
          saveDevice(d);
        }
        return d;
      }
    }
  } catch {
    /* noop */
  }
  const id = deviceFingerprint();
  const device: DeviceInfoT = {
    deviceId: id,
    deviceName: defaultName(id),
    color: PALETTE[Number.parseInt(id.slice(0, 2), 16) % PALETTE.length] ?? PALETTE[0]!,
    platform: detectPlatform(),
  };
  saveDevice(device);
  return device;
}

export function saveDevice(d: DeviceInfoT): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(d));
  } catch {
    /* noop */
  }
}
