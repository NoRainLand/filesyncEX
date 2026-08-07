import os from "node:os";

/** 获取本机局域网 IPv4（非回环、非虚拟网卡优先）；取不到回退 127.0.0.1 */
export function lanAddress(): string {
  const nets = os.networkInterfaces();
  const candidates: string[] = [];
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] ?? []) {
      if (ni.family === "IPv4" && !ni.internal) candidates.push(ni.address);
    }
  }
  return candidates[0] ?? "127.0.0.1";
}
