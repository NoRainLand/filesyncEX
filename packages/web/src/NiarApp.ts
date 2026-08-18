export class NiarApp {
    /** 冷笑话 API（旧版 ProjectConfig.jokeAPI，已内联） */
    private static readonly JOKE_API = "https://v2.jokeapi.dev/joke/Any";

    /** 添加一个 joke 接口 */
    public static joke(): void {
        fetch(NiarApp.JOKE_API)
            .then((res) => res.json())
            .then((data: any) => {
                if (data.joke) {
                    console.log(`%cJoke: %c${data.joke}`, `color: #ff0000;`, `color: #000000;`);
                } else if (data.setup && data.delivery) {
                    console.log(`%cQ: %c${data.setup}`, `color: #ff0000;`, `color: #000000;`);
                    console.log(`%cA: %c${data.delivery}`, `color: #ff0000;`, `color: #000000;`);
                } else {
                    console.log("%cUnheihei: %cToday is so heihei that I don't want to tell you a joke.", `color: #ff0000;`, `color: #000000;`);
                }
            })
            .catch(() => {
                /* 网络失败静默 */
            });
        console.log("Joke is coming...");
    }

    /**
     * aboutMe
     */
    public static execute(owner: string): any {
        if (owner === "me") {
            const name: string = "病雨";
            const age: number = NaN;
            const common_langs: string[] = ["HTML", "JS", "TS", "PY"];
            const interest: string[] = ["听歌", "电子游戏", "看小说", "看设定", "看涩图", "下厨"];
            const learning = ["unity3d", "Laya", "node.js", "blender"];
            const email: string = "d3V4aW5ydWZlbmdAcXEuY29t";
            const obj = {
                name,
                age,
                common_langs,
                interest,
                learning,
                email,
            };
            return obj;
        }
        return undefined;
    }

    /**
     * 1. 操作当前 exe 开机自启（HKCU Run 键）。action：1=开启，0=取消。
     * 自动等待服务器完成并打印结果（不返回 Promise）。仅打包为 exe 后可用。
     */
    public static autostart(action: 0 | 1 = 1): void {
        const label = action === 1 ? "开启" : "取消";
        fetch("/api/sys/autostart", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action }),
        })
            .then((r) => r.json().catch(() => ({})) as Promise<Record<string, unknown>>)
            .then((d) => {
                if (d.ok) {
                    console.log(`%c[开机自启] %c${label}成功`, "color:#0f9d58;", "color:#047878;");
                } else {
                    console.warn(`%c[开机自启] %c${label}失败：${String(d.error ?? "")}`, "color:#e5484d;", "color:#047878;");
                }
            })
            .catch((e: unknown) => {
                console.warn(`%c[开机自启] %c请求失败：${String(e)}`, "color:#e5484d;", "color:#047878;");
            });
    }

    /**
     * 1b. 查询当前 exe 开机自启状态。自动等待服务器完成并打印结果（不返回 Promise）。仅打包为 exe 后可用。
     */
    public static autostartStatus(): void {
        fetch("/api/sys/autostart")
            .then((r) => r.json().catch(() => ({})) as Promise<Record<string, unknown>>)
            .then((d) => {
                if (d.ok) {
                    console.log(`%c[开机自启] %c${d.enabled ? "已开启" : "未开启"}（${String(d.exe ?? "")}）`, "color:#0f9d58;", "color:#047878;");
                } else {
                    console.warn(`%c[开机自启] %c查询失败：${String(d.error ?? "")}`, "color:#e5484d;", "color:#047878;");
                }
            })
            .catch((e: unknown) => {
                console.warn(`%c[开机自启] %c请求失败：${String(e)}`, "color:#e5484d;", "color:#047878;");
            });
    }

    /**
     * 2. 打包当前所有数据（消息数据库 + 全部文件）为 zip，以日期命名并下载。
     */
    public static async exportData(): Promise<Record<string, unknown>> {
        return NiarApp.downloadBlob("/api/data/export", "filesyncEX-backup.zip");
    }

    /**
     * 3. 下载服务器本体（当前打包出来的 exe）。开发模式返回失败。
     */
    public static async downloadApp(): Promise<Record<string, unknown>> {
        return NiarApp.downloadBlob("/api/app/download", "filesyncEX.exe");
    }

    /**
     * 4. 关闭服务器（优雅关闭并退出进程）。自动等待并打印结果。
     */
    public static shutdown(): void {
        NiarApp.sysAction("/api/sys/shutdown", "关闭服务器");
    }

    /**
     * 5. 重置服务器：清空全部聊天记录与文件并软重启。自动等待并打印结果。
     */
    public static reset(): void {
        NiarApp.sysAction("/api/sys/reset", "重置服务器");
    }

    /** 通用系统操作：POST 后自动打印结果（不返回 Promise） */
    private static sysAction(url: string, label: string): void {
        fetch(url, { method: "POST" })
            .then((r) => r.json().catch(() => ({})) as Promise<Record<string, unknown>>)
            .then((d) => {
                if (d.ok) {
                    console.log(`%c[${label}] %c已执行`, "color:#0f9d58;", "color:#047878;");
                } else {
                    console.warn(`%c[${label}] %c失败：${String(d.error ?? "")}`, "color:#e5484d;", "color:#047878;");
                }
            })
            .catch((e: unknown) => {
                console.warn(`%c[${label}] %c请求失败：${String(e)}`, "color:#e5484d;", "color:#047878;");
            });
    }

    /** 通用：fetch 拿 blob → 触发浏览器下载；非 2xx 返回失败 */
    private static async downloadBlob(url: string, fallbackName: string): Promise<Record<string, unknown>> {
        try {
            const r = await fetch(url);
            if (!r.ok) {
                let error = "下载失败";
                try {
                    const d = (await r.json()) as { error?: string };
                    if (d?.error) error = d.error;
                } catch {
                    /* 非 JSON 忽略 */
                }
                return { ok: false, error };
            }
            const blob = await r.blob();
            const cd = r.headers.get("content-disposition") ?? "";
            let name = fallbackName;
            const m = /filename\*=UTF-8''([^;]+)/i.exec(cd) ?? /filename="?([^";]+)"?/i.exec(cd);
            if (m?.[1]) {
                try {
                    name = decodeURIComponent(m[1]);
                } catch {
                    name = m[1];
                }
            }
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = name;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(a.href), 2000);
            return { ok: true, name };
        } catch (e) {
            return { ok: false, error: String(e) };
        }
    }

    /**
     * help：打印所有接口名及作用
     */
    public static help(): string {
        const items: Array<[string, string]> = [
            ["NiarApp.joke()", "获取一条冷笑话"],
            ["NiarApp.autostart(0|1)", "开机自启：1 开启 / 0 取消，完成后打印结果（仅打包模式）"],
            ["NiarApp.autostartStatus()", "查询开机自启状态并打印（仅打包模式）"],
            ["NiarApp.exportData()", "打包所有数据（消息数据库 + 全部文件）为 zip 并下载"],
            ["NiarApp.downloadApp()", "下载服务器本体 exe（仅打包模式）"],
            ["NiarApp.shutdown()", "关闭服务器（优雅关闭并退出）"],
            ["NiarApp.reset()", "重置服务器：清空全部聊天记录与文件"],
            ["NiarApp.help()", "打印所有接口名及作用"],
        ];
        console.log("%cNiarApp 接口一览：", "color:#e12885;font-size:14px;font-weight:bold;");
        for (const [name, desc] of items) {
            // 每行单个 %c，保证不同环境下着色稳定（多 %c 并存可能被某些环境当字面处理）
            console.log(`%c  ${name}`, "color:#047878;font-weight:bold;");
            console.log(`%c    ${desc}`, "color:#6f7a82;");
        }
        return "NiarApp 接口已列出";
    }
}
