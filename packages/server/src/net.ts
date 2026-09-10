import os from "node:os";

/** 虚拟网卡常见关键字（VMware / VirtualBox / Hyper-V / WSL / Docker / VPN / 回环桥接等） */
const VIRTUAL_HINTS = [
  "vmware",
  "virtualbox",
  "vethernet",
  "hyper-v",
  "wsl",
  "docker",
  "br-",
  "veth",
  "tap",
  "tun",
  "tailscale",
  "zerotier",
  "radmin",
  "hamachi",
  "npcap",
  "loopback",
  "bluetooth",
];

/** 地址优先级：192.168 > 10. > 172.16-31 > 其它；169.254 链路本地最后 */
function addressScore(ip: string): number {
  if (ip.startsWith("192.168.")) return 0;
  if (ip.startsWith("10.")) return 1;
  const m = /^172\.(\d+)\./.exec(ip);
  if (m) {
    const second = Number(m[1]);
    if (second >= 16 && second <= 31) return 2;
  }
  if (ip.startsWith("169.254.")) return 9; // 链路本地：基本不可用
  return 3;
}

/**
 * 列出本机全部可用的局域网 IPv4（物理网卡优先、私网段优先）。
 * 多网卡机器（装了 VMware / Hyper-V / WSL / VPN 等虚拟网卡）上「取第一个非回环地址」很容易
 * 拿到手机根本连不上的虚拟地址（二维码扫了打不开），故这里排序后返回全部候选。
 */
export function lanAddresses(): string[] {
  const nets = os.networkInterfaces();
  const candidates: { ip: string; virtual: boolean; score: number; name: string }[] = [];
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] ?? []) {
      if (ni.family !== "IPv4" || ni.internal) continue;
      const lower = name.toLowerCase();
      candidates.push({
        ip: ni.address,
        virtual: VIRTUAL_HINTS.some((h) => lower.includes(h)),
        score: addressScore(ni.address),
        name,
      });
    }
  }
  candidates.sort((a, b) => Number(a.virtual) - Number(b.virtual) || a.score - b.score || a.name.localeCompare(b.name));
  const ips = candidates.map((c) => c.ip);
  return ips.length > 0 ? ips : ["127.0.0.1"];
}

/** 获取本机首个局域网 IPv4（物理网卡/私网段优先）；取不到回退 127.0.0.1 */
export function lanAddress(): string {
  return lanAddresses()[0] ?? "127.0.0.1";
}
