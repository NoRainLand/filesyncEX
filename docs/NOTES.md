# filesyncEX 开发笔记

> README 的补充材料：**踩过的坑、做过的优化与实测数据、设计取舍**。
> 偏「维护者视角」，按主题归档；时间线流水账见 [../PROJECT_LOG.md](../PROJECT_LOG.md)。

---

## 一、踩过的坑

### 打包 / 原生模块

1. **better-sqlite3 打包进 exe 报 `Invalid host defined options`**
   根因是 server 用动态 `import("better-sqlite3")`，pkg 的 V8 快照环境下 ModuleWrap 校验失败（`module_wrap.cc:604`）。
   **改为静态 `import Database from "better-sqlite3"`**（esbuild `--external` 转 require，走 CJS）后解决。

2. **打包后 `Cannot find module 'bindings'` / `'file-uri-to-path'`**
   better-sqlite3 运行时依赖 `bindings` 查找 `.node` 文件，但其自身依赖链未打进 exe。需把 `bindings` + `file-uri-to-path` 一并作为 pkg assets 复制。

3. **`fs.cpSync` 带 filter 时整目录被 SKIP（复制后目录不存在）**
   Windows 下 `cpSync` 会把路径转成 `\\?\` 长路径前缀，导致 `path.relative(src, s)` 匹配失败、根目录被 filter 跳过且**偶发**。
   规避：先整目录复制，再删除不需要的子目录（`deps`/`src`/`node_modules`），并校验 `.node` 存在。

4. **rcedit 改图标会破坏 pkg payload（94MB → 42MB，报 `Pkg: Error reading from file`）**
   pkg 把快照数据追加在 exe 中间，rcedit 重写 PE 会丢弃；且修补 pkg 缓存基础 exe 会被完整性校验覆盖。
   最终方案：`fix-icon.mjs` 解析 exe 内 `PAYLOAD_POSITION/PRELUDE_POSITION` 占位符 → 提取 payload+prelude → rcedit → 更新占位符 → 拼回。

5. **pkg `--no-bytecode` 报 `no source breaks final executable`**
   pkg 5.16.1 的 bug：入口被标记为 bytecode（STORE_BLOB）且无源码副本。`--public` 可绕过但体积更大（81MB > 76.6MB），
   最终选择 `--compress GZip` 不动 bytecode。

6. **esbuild 把中文字符转成 `\uXXXX`**
   打包后 exe 里搜中文提示搜不到，误以为代码没打进。**诊断时应用 ASCII 标识符**（如函数名 `findFreePort`）搜索。

7. **`--define:` 的值不能拼在 shell 命令行里**（2026-09 实际踩到）
   `--define:__APP_VERSION__=${JSON.stringify(version)}` 生成的引号会被 shell 吃掉（Windows cmd / POSIX sh 都会剥外层引号，
   用 `\"` 转义在 cmd 下会变成 `\6.2.0\`）→ esbuild 报 `Invalid define value (must be an entity name or valid JSON syntax)`，**打包直接失败**。
   修复：`scripts/bundle.mjs` 用 `spawnSync(可执行文件, 参数数组)` 调用 esbuild —— 参数数组不过 shell，引号原样保留。
   顺带发现 `pnpm exec esbuild` 会解析到**全局安装的旧版**（0.19.5，甚至不支持 `--define`），故 shell 包显式声明 `esbuild` 并优先用仓库内的。

8. **改完 CSS 忘记重新构建**（2026-09 实际踩到）
   构建命令路径写错导致 `vite build` 静默失败，于是拿**旧产物**验证，得出「规则没生效」的错误结论。
   规矩：改前端后先确认产物 hash 变化，再验证。

### 浏览器 / 前端

9. **局域网 HTTP 非安全上下文没有 `crypto.subtle`**
   秒传 / 断点续传需要 SHA-256，但 `http://192.168.x.x` 下 Web Crypto 不可用，故用**纯 JS 增量 SHA-256**（`IncrementalSha256`）。
   代价：大文件上传前哈希计算耗时（这也是引入直传阈值的原因）。

10. **Prism 语法高亮拆模块后打包报 `Prism is not defined`**
    把 Prism 与语法组件 import 拆到 `helpers.ts` 后，模块初始化顺序被打散。
    修复：把 Prism 相关代码集中到单一 `ui/prism.ts`（副作用 import 与使用者同模块）。

11. **`*:focus-visible`（零特异性）不生效**
    浏览器默认焦点环会压过它，实测连 `button:focus-visible`、`.btn:focus-visible{… !important}` 都被压过；
    最终只有**组件类选择器**版本稳定生效（`.iconbtn:focus-visible` 生效而 `.btn:focus-visible` 不生效就是这种差异）。

12. **验证焦点样式时读到「假失败」**
    `.btn { transition: .15s }` 会把 `outline` 一起补间，需**等过渡结束（≥260ms）再读计算值**，否则读到 3px / offset 0 的中间值。

13. **移动端 `100dvh` 兼容性**
    `dvh` 只被较新浏览器支持，不支持的手机会忽略该声明导致宿主高度塌陷、输入框随消息移动。
    修复：`:host { height: 100vh; height: 100dvh; }` 双声明兜底。

### 依赖 / 环境

14. **npm 镜像 502 / 本地代理卡死**
    环境 npmmirror 502 + 代理未启动导致 `pnpm install` 卡住。绕过：临时 `npm_config_registry=https://registry.npmjs.org` 并清空 proxy。

15. **pnpm store 与版本不一致**（2026-09）
    仓库 `node_modules` 由 pnpm 10 链接自 `G:\.pnpm-store\v10`，用 pnpm 11 会报 `ERR_PNPM_UNEXPECTED_STORE`；
    装依赖时用 `--store-dir G:\.pnpm-store\v10`（或直接让 pnpm 按 `packageManager` 字段自取 10.15.0）。

---

## 二、做过的优化与实测数据

### 体积 / 打包速度

| 优化 | 结果 |
|---|---|
| **pkg `--compress GZip`** | exe 体积 106.9MB → **74.3MB（-30.5%）**；已验证与图标修补兼容（当前版本产物约 **71 MB**） |
| **better-sqlite3 精简** | 删掉 sqlite C 编译源码（deps 9.5MB）→ 打包数据 12.96MB → **1.67MB** |
| **增量构建** | 重复打包 46.5s → **38.1s**（源未变的包跳过构建） |
| **版本号内联**（打包时 `--define`） | 产物内不再需要运行时读文件；`/api/health`、banner、控制台版本号与产物名永远一致 |

### 上传可靠性

| 优化 | 结果 |
|---|---|
| **动态切片**（按文件大小 1–8 MiB） | 目标分片数约 4096：4 GiB 内 1 MiB、16 GiB 4 MiB、32 GiB 以上 8 MiB |
| 分片重试 / 超时 | 单片 30s 超时 + 指数退避重试 4 次 + 服务端 keep-alive 调大，解决 WiFi 中途断连 |
| **上传前预检** | 超限文件在**发请求前**就被拒（不白算 SHA-256、不消耗流量），并给出可操作文案 |
| **服务端 sha256 校验** | `complete` 重算摘要并与客户端声明比对，避免「续传 key 永久对不上、每次都重传全文」 |
| **背压** | 组装写盘 `await out.write(data, cb)`，磁盘慢于读时不会把整文件堆在内存 |

**动态切片基准**（256 MiB 数据、本地回环、同一台机器）：

| 配置 | 实际切片 | 分片数 | 总耗时 | 吞吐 | 单片 p95 | 服务端 RSS 峰值 |
|---|---|---|---|---|---|---|
| 固定 1 MiB | 1 MiB | 256 | 3.49s | 73.3 MB/s | 10.8ms | 397 MB |
| 固定 4 MiB | 4 MiB | 64 | 2.46s | 103.9 MB/s | 31.4ms | 381 MB |
| 固定 8 MiB | 8 MiB | 32 | 3.87s | 66.1 MB/s | 53.8ms | 397 MB |
| 动态 1–8 MiB | 1 MiB | 256 | 2.56s | 100.0 MB/s | 10.3ms | 377 MB |

> 结论：**切片越大越快**（省每请求的 HTTP/JSON/SQLite 往返），**但服务端内存几乎不变**（落盘逐片处理，任意时刻只有一片在内存里；
> RSS 380–400 MB 是 Node + 解码器底座）。瓶颈是**分片数**，且单片过大会让 WiFi 抖动的重传粒度变差 —— 故按「分片数 ≈ 4096」取切片。

### 内存 / 事件循环

| 优化 | 结果 |
|---|---|
| **异步文件 IO** | 分片写盘 / 音频解码 / 分片流式组装（边读边写 + 流式 SHA）改异步，大文件不阻塞事件循环、不整块入内存 |
| **音频转码 LRU 缓存** | `streamCache` 上限 8 个，防止大音频常驻内存 |
| **数据导出改流式 zip** | 自研 `ZipWriter`（本地头 → 数据 → 中央目录，增量 CRC32 + utf8 标志）；数据目录多大都不整块进内存（此前会 OOM） |

### 正确性 / 安全（2026-09 一轮大修）

| 修复 | 说明 |
|---|---|
| **文件引用计数** | 原「同一文件传两次 → refs 卡在 1 → 删一条消息就把另一条还在用的文件物理删除」；改为 `createFile` + `addFileRef`（`file_refs` 表）+ 启动时按 `messages` 全量重算修正旧库 |
| **管理接口鉴权** | `/api/sys/*`、`/api/data/export`、`/api/app/download` 加令牌 + 来源校验，防局域网内任意网页跨站关服/清库 |
| **磁盘卫生** | 启动 + 每 6h 回收废弃分片会话、孤儿封面/附件、`.tmp-*`；历史裁剪不再连带删附件 |
| **express 错误中间件** | 畸形 JSON / 超限统一返回 JSON 错误体（不再吐 Express 默认 HTML 错误页含栈与源码路径） |
| **ABI 不匹配不再静默降级** | 原生模块与 Node 版本不匹配时**直接报错退出**并给修复办法（静默降级内存存储会让「数据重启即丢」被当成正常现象） |

### 其它

| 优化 | 结果 |
|---|---|
| **端口自动切换** | 默认端口被占自动向后探测空闲端口并打印提示（最多 20 个） |
| **多网卡地址探测** | 按「物理网卡 + 私网段」优先排序，二维码面板列出备用地址（装了 VMware/Hyper-V/WSL/VPN 的机器上首个地址常连不上） |
| **移动端 UI** | 频谱图指示条化、长按删除（描边 / 浮起 / 遮罩）、header 压缩、toast 实底、设置面板可滚动且隐藏滚动条 |
| **无障碍** | 支持 `prefers-reduced-motion`；键盘焦点统一为品牌色 `:focus-visible`；logo 可键盘操作 |
| **zod v3 → v4** | 协议校验库升级 v4（更小更快）；为 protocol/core/server 显式声明 typescript 依赖，统一 TS 版本 |
| **死代码清理** | 删除 `/api/wave` 链路（前端已改模拟频谱）、未使用的 API / 常量 / 导出 / 依赖 |

---

## 三、设计取舍备忘

- **为什么直传阈值是 8 MiB**：≤ 该值走整块上传可跳过「整文件 SHA-256 + 分片」两项开销，小文件几乎无等待；
  更大的文件才值得付哈希与分片的成本（换来秒传 / 续传能力）。
- **为什么切片大小由服务端定**：它属于协议字段（客户端必须按 `init` 返回值切分），服务端才能随文件大小与配置动态调整；
  客户端硬编码会与服务端漂移（本项目踩过一次，已统一为「服务器下发 + 客户端跟随」）。
- **为什么历史裁剪不删附件**：裁剪的是「消息列表」，而附件被引用计数保护；直接连带删除会让用户觉得「历史图片莫名消失」。
- **为什么测试用自研 runner**：`node --test` 默认给每个测试文件 spawn 子进程（受限环境 EPERM），vitest 依赖 esbuild 子进程加载配置；
  自研进程内 runner 零依赖、无子进程，受限沙箱 / CI 都能跑。
- **为什么原生模块失败要「报错而不是降级」**：降级成内存存储后功能看似正常、数据却在重启后消失，属于最危险的一类静默故障。
