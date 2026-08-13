import "./app.js";
import { NiarApp } from "./NiarApp.js";
import { fetchHealth } from "./api.js";

// 控制台彩蛋：暴露 window.NiarApp（NiarApp.execute("me") 查作者信息）+ window.joke()（冷笑话）
NiarApp.init();
(window as unknown as { NiarApp: typeof NiarApp }).NiarApp = NiarApp;

/** 调试面板：仅当 URL 带 ?vc=1 时通过 CDN 动态加载 vConsole（不打包进应用，无 vc=1 零开销） */
function initVConsole(): void {
  if (new URLSearchParams(location.search).get("vc") !== "1") return;
  const s = document.createElement("script");
  s.src = "https://unpkg.com/vconsole@3.15.1/dist/vconsole.min.js";
  s.async = true;
  s.onload = () => {
    try {
      const V = (window as unknown as { VConsole?: new (opts?: { maxLogNumber?: number }) => void }).VConsole;
      if (V) new V({ maxLogNumber: 1000 });
    } catch {
      /* noop */
    }
  };
  document.head.appendChild(s);
}
initVConsole();

/**
 * 控制台信息打印（移植旧版 filesync index.printMsg）。
 * 项目名 / 版本取自 /api/health，作者与描述为常量。
 */
async function printMsg(): Promise<void> {
  let name = "filesyncEX";
  let version = "6.0.1";
  try {
    const d = await fetchHealth();
    name = d?.name || name;
    version = d?.version || version;
  } catch {
    /* 保持默认值 */
  }
  const description = "一个简单的局域网文件/文字同步服务";
  console.log(`%c${name}：%c${description}`, "color:#e12885;font-size:large;", "color:#047878;");
  console.log("%c作者：%cNoRain", "color:#0f9d58;", "color:#047878;");
  console.log(`%c当前版本：%c${version}`, "color:#0f9d58;", "color:#047878;");
}
void printMsg();
