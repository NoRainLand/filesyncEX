import "./app.js";
import { NiarApp } from "./NiarApp.js";
import { fetchHealth } from "./api.js";

// 控制台彩蛋：暴露 window.NiarApp（NiarApp.execute("me") 查作者信息）+ window.joke()（冷笑话）
NiarApp.init();
(window as unknown as { NiarApp: typeof NiarApp }).NiarApp = NiarApp;

/**
 * 控制台信息打印（移植旧版 filesync index.printMsg）。
 * 项目名 / 版本取自 /api/health，作者与描述为常量。
 */
async function printMsg(): Promise<void> {
  let name = "filesyncEX";
  let version = "6.0.0";
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
