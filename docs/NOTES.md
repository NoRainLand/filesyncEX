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
   `http://192.168.x.x` 下 Web Crypto 不可用（只有 localhost / HTTPS 才有），故前端只能用**纯 JS SHA-256**。
   由此引出的性能坑见 §3.1：**不要让浏览器算整文件摘要**。

9.1 **`node:sqlite` 绑定含 NUL 的字符串会截断**（2026-09 实际踩到）
  秒传索引键最初用 `name + "\u0000" + size`，写入 `node:sqlite` 后读回只剩 `name` ——
  索引列与查找键对不上，秒传**静默失效**（不报错，只是永远不命中）。`better-sqlite3` 无此问题，
  两套驱动混用时会表现不一致。修复：分隔符改用 `\u0001`（文件名里不可能出现），并在测试里断言该列的分隔符码位。

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
| **上传前预检** | 超限文件在**发请求前**就被拒（不白读 1 MiB 算特征值、不消耗流量），并给出可操作文案 |
| **不在浏览器算整文件摘要** | 整文件 SHA-256 交给服务端组装时流式算出；客户端只读前 1 MiB 算特征值（500 MB 从 3~7s 降到 ~20ms，见 §3.1） |
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

### 3.1 大文件「上传前 0% 停顿」的根因与实测（2026-09）

**现象**：500 MB 文件点上传后，进度环停在 0% 约 3 秒才开始动。

**测量方法**：真实 Chrome（局域网 `http://192.168.x.x`，非安全上下文，6 核）读真实文件，拆开「读盘」与「算 SHA-256」两项成本
（`_dev/_hash_bench3.mjs`，源文件放在 **机械硬盘** `G:\` 上）：

| 环节 | 500 MB 耗时 | 吞吐 |
|---|---|---|
| 纯读（1 并发 4 MiB 块） | 706 ms | 708 MB/s |
| 纯读（6 并发 4 MiB 块） | 352 ms | 1422 MB/s |
| 纯读（12 并发 32 MiB 块） | 278 ms | 1799 MB/s |
| **单 Worker 顺序 SHA-256** | **5320 ms** | **94 MB/s** |
| 6 Worker × 32 MiB 并行 | 4875 ms | 103 MB/s |
| 6 Worker × 8 MiB 并行 | 4776 ms | 105 MB/s |

> 结论：**瓶颈 100% 是纯 JS SHA-256 的 CPU 吞吐（~100 MB/s），不是磁盘**（读盘快 7~19 倍）。
> 而且**多 Worker 并行几乎无用**（94 → 105 MB/s，仅 1.1 倍）：Web Crypto 不可用时无法用 SIMD/原生，
> 6 个 Worker 抢同一批核心也只把单核上限摊开一点点；32 KiB 消息与 32 MiB 块都一样。
> 早先一次「6×32 MiB 快 5 倍（1.39s）」的测值不可复现 —— 那次文件是 fetch 得到的**内存 Blob**且未跨进程竞争。

**修复**：浏览器**不再算整文件摘要**。

| 项 | 修复前 | 修复后 |
|---|---|---|
| 客户端读盘量（500 MB 文件） | 整文件（哈希）+ 整文件（上传） | **1 MiB**（特征值）+ 整文件（上传） |
| 0% 阶段耗时 | 3~7 s（哈希） | **~20 ms** |
| 整文件 SHA-256 | 客户端算，服务端再算一遍校验 | **只有服务端算**（组装分片时流式，本来就要读一遍） |
| 秒传判定键 | 首片摘要 + 大小 | **文件名 + 大小 + 前 1 MiB 特征值**（客户端只读 1 MiB，零额外成本） |

实测（`_dev/_e2e_upload.mjs`，真实浏览器 + 真实服务端，300 MB）：占位卡在 **27 ms** 出现「正在上传…」，
首个非 0% 进度在 **106~182 ms**；服务端落库 `sha256` 与本地独立计算结果完全一致。

**为什么判定键里要带特征值**：只用「文件名 + 大小」时，**同名同大小的不同内容**会被判成同一文件、直接复用已有物理文件（用户拿到错文件）。
特征值由内容决定，这类误判即消失，而客户端本来就要读这 1 MiB 来算特征值，成本不变。
（代价：同名同大小但内容确实变了的文件不再秒传，会正常重传一遍 —— 这是安全的一侧。）

### 3.2 上传进度反馈与「占位卡 → 真实消息」不闪（2026-09）

**问题一：100% 之后像卡住。** 分片传完 ≠ 上传结束：服务端还要**组装 + 流式校验 SHA-256 + 改名落盘**，
大文件在机械盘上要 1~5 秒，而客户端此时停在 100%（`stroke-dashoffset` 恒为 0，进度环纹丝不动）。

- 浏览器侧新增阶段 `finishing`（`UploadService.complete` 调用前上报），界面把进度环换成**旋转缺口弧** + 「正在完成上传…」；
- 服务端未回推消息时的兜底文案是「已上传完成」（`saved`），不会一直转圈。

**问题二：切到真实消息时闪一下。** 根因不是「删掉再插入」（那一步在同一帧完成），而是**两种卡片高度不一致**，
切换瞬间整个列表被顶上/推下。逐帧测量（`_dev/_e2e_swap.mjs`，真实浏览器 + 真实服务端，组装延时 0.6~2.5s 放大观察窗口）：

| 类型 | 修复前占位卡 / 真实卡 | 高度跳变 | 修复后 | 跳变 |
|---|---|---|---|---|
| 图片 | 423 / 351 | 72px | 351 / 351 | **0** |
| 视频 | 423 / 351 | 72px | 351 / 351 | **0** |
| 音频 | 117 / 146 | 29px | 146 / 146 | **0** |
| 文件 | 150 / 121 | 29px | 121 / 121 | **0** |

差异来源与修法：
1. 占位卡把「信息行 + 操作行」放在**流内**，而真实卡（图片/视频）把它们放在**绝对定位的 .ovl** 里、文件/音频卡则是「主体 + .ops」两段 —— 占位卡因此多出一行高度。改为照抄真实卡的排布（图片/视频绝对定位；文件/音频不再渲染信息行）。
2. 占位按钮用了 `.btn.secondary`（多 1px 边框 → 高 33px），真实卡是 `.btn`（31px）。统一成 `.btn`。
3. 图片/视频的 `::after` 居中放大镜/播放图标与占位卡的图标骨架会出现「两层图标」，用 `.ph-cover`（与 `.ph-body` 同 z-index、后渲染）盖住真实卡内容，并在这两个阶段隐藏装饰图标。

**揭层动画**：真实缩略图解码完成前（`readyThumbs` 未登记）保持占位外观，解码完成后 `.ph-blur` / `.ph-cover` 在 220ms 内淡出，
把「占位 → 真实」变成一次揭开而不是硬切；3 秒兜底（解码失败/网速慢也不会一直挂占位卡）。

**验证**（`_dev/_e2e_swap.mjs` 四种类型 + `_dev/_e2e_fail.mjs` 失败续传）：
逐帧 300+ 帧采样，`gapFrames === 0`（没有任何一帧卡片消失/高度塌陷）、`cardJump === 0`（高度零跳变）；
「正在完成上传…」与旋转弧按预期出现；失败分支仍显示「上传中断 · 点击续传」且卡片高度与真实卡一致。

### 3.3 「上传一个文件出现两条相同消息」的竞态（2026-09，已修）

**现象**：上传一个文件后消息列表出现**两条内容完全相同**的消息，**刷新后只剩一条**（说明第二条只存在于内存，是幽灵消息）。

**根因**：同一次上传的**同一条消息**会经两条路径到达本机，且顺序不确定 ——
服务端在 `complete()` 里**先 `addMessage`（WS 广播）再**返回 HTTP 响应。客户端两条路径各插了一次：

| 时序 | 旧行为 |
|---|---|
| 响应先到 | `finishUpload()` 把占位卡落成真实消息（旧占位卡 id 是 `upload-<时间戳>-<随机>`，**与真实消息 id 无关**）|
| 广播后到 | `onAdd` 找不到「`realId === msg.id` 的占位卡」（此时占位卡已是真实消息、`realId` 也没设），于是**当成新消息再 append 一次** |

逐帧复现（`_dev/_e2e_ghost.mjs`，真实浏览器 + 真实服务端）：`stateMsgCount` 由 1 变 3，
`duplicateStateIds` 出现同一个 id 两次，而服务端库里只有 1 条 —— 与用户描述完全一致。

**修复**：让**客户端预生成消息 id**（`web/src/msgid.ts`，`crypto.randomUUID` 不可用时回退，局域网 HTTP 非安全上下文），
占位卡 id = `upload-<msgId>`，服务端沿用该 `msgId`（`UploadInitReq.msgId` / `upload/direct?msgId=`），
于是两条路径无论谁先到都能认领同一个占位卡；插入收敛到**唯一入口** `app.ts promote()`。

服务端侧的防护：`newMessageId(preferred)` 会先查该 id 是否已存在，冲突时改用服务端生成的 id ——
否则 `saveMessage` 的 `INSERT OR REPLACE` 会**覆盖历史消息**（客户端不可信）。会话表新增 `uploads.msg_id`（含旧库迁移），续传后仍能认领。

**验证**（`_dev/_e2e_ghost.mjs`，客户端与服务端各查一遍）：

| 场景 | 结果 |
|---|---|
| 分片上传（图片）、广播先到（响应延迟 1.5s） | 客户端 1 条文件消息，`duplicateStateIds` 空，与服务端 id 一致 |
| 分片上传（普通文件）、广播先到 | 同上 |
| 分片上传（图片）、响应先到 | 同上 |
| 直传路径（≤ 直传阈值） | 响应里的 id == 客户端预生成 id，只 1 条 |
| 连传 3 次 | 每次 +1（2→3→4），无重复 id，刷新前后一致，与服务端条数相同 |

**回归用例**（`packages/server/test/upload.test.mjs`）：分片路径「响应 id == 广播 id 且只广播一次」、
直传路径沿用预生成 id、**id 冲突时不覆盖历史消息**。Node 18 / Node 25 均 **79 通过 0 失败**。

### 3.4 消息「永远显示占位卡 / 卡在 0%」的原因（2026-09，已修）

**现象**：用真实文件（音频 / 视频 / 图片 / 压缩包）上传后，消息一直显示占位卡（0%、「正在上传…」），
刷新一下才变成正常消息 —— 截图里能看到真实卡片其实已经渲染过，只是被占位外观盖住了。

**定位过程**（`_dev/_e2e_real.mjs`）：在页面里打印上传记录与消息列表的**逐帧时间线**，看到

```
t=0     uploads=["upload-<id>|0|preparing"]   msgs=[...,"upload-<id>"]
t=251   uploads=["upload-<id>|100|-|S"]       msgs=[...,"upload-<id>"]     ← 已进入揭层，但消息 id 没换
t=3145  uploads=[]                             msgs=[...,"upload-<id>"]     ← 记录被收掉，消息 id 仍是占位 id
```

**根因**：占位卡的 id 只在 `finishUpload()` 的 **340ms 定时器**里被换成真实 id，
而「揭层」是等真实缩略图 `onload` 完成的 —— **图片解码往往比 340ms 快**，`markThumbReady()` 先把上传记录收掉了，
定时器再跑时已经找不到记录（旧代码里 `if (!this.uploads.includes(rec)) return;`），于是**消息永远带着 `upload-` 前缀的 id**。
`renderMsg` 只按「id 以 `upload-` 开头」判断占位卡，所以这条已经拿到真实内容的消息被当成占位卡渲染，
而记录又不存在 → 按 `pct=0 / phase=uploading` 兜底渲染，看起来就是「卡在 0%」。
（`testRes` 里的 0.3MB 图片最容易命中；大文件因为 atempo 更慢反而偶尔正常。）

**修复**：
1. `promote()` 认领占位卡时**同一帧内**就把消息 id 换成真实 id，并同步改 `rec.key`；
   「占位外观」只由 `rec.settling` 控制，不再依赖 id 前缀 —— 于是 id 与内容永远不会脱节。
2. `finishUpload(realId)` 分支不再用定时器赌时序：立刻换 id，且只在「消息仍带占位 id」时收尾（广播已到就交给 `promote()`）。
3. `markThumbReady(url)` 改为**只收「等的就是这张图」的记录**（`UploadRec.thumbUrl` 相同）；
   此前它会把所有 `settling` 记录一起收掉，导致另一个上传的图片 `onload` 误伤还在揭层的记录。

**验证**（`_dev/_e2e_real.mjs` 直接上传 `testRes/` 下的真实文件，客户端 + 服务端双向核对）：

| 文件 | 上传耗时 | 结果 |
|---|---|---|
| `7pm.wav`（38.6 MB） | 6.5s | `card audio`（真实卡片），无占位残留 |
| `9371…fd23.jpg`（0.3 MB） | 6.3s | 消息 id 在 **~250ms** 内从 `upload-<id>` 变为真实 id |
| `gode.zip`（213.2 MB） | 7.2s | `card file`（真实卡片） |
| `最忧郁的两人.mp4`（4.3 MB） | 6.3s | `card video`（真实卡片） |

四种类型的「不闪烁 / 正在完成上传」几何回归仍为 `gap=0 / jump=0`（占位与真实卡高：图片视频 351、音频 146、文件 121）；
服务端消息列表与客户端一致，客户端控制台无 error/warning。

> 教训：**「外观状态」不要用「id 的形态」来表达**。把占位外观绑在 `upload-` 前缀上，等于让「换 id 的时机」
> 与「揭层的时机」必须精确配合；一旦某个回调提前或滞后，消息就会退化成占位卡。现在外观只看显式状态位 `settling`。

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

---

## 四、Bun compile 与 pkg 的实测对比（2026-09，Bun 1.4.2）

结论先说：**继续用 pkg**。Bun compile 在这套项目里能做出来、功能也跑得通，但在「单文件分发」这个核心诉求上反而更弱，
且要额外维护一条 Bun 专用链路。下面全部是实测数据（同一台机器、同一份代码）。

### 4.1 体积与形式

| | pkg（当前） | Bun compile |
|---|---|---|
| 产物 | `filesyncex-6.4.0.exe` **71.21 MB** | `filesyncex-bun.exe`（`--minify`）**93.61 MB** |
| 静态资源（web/dist，含 6.03 MB 字体） | **内嵌在快照里**，单文件即可分发 | **未内嵌**，需与 exe 并列放 6.26 MB（总计 **99.87 MB**） |
| 版本信息 / 图标 | rcedit 写入：ProductName `filesyncEX`、FileVersion `6.4.0`、OriginalFilename、图标全部正确 | **完全没有**：仍是 `ProductName: Bun` / `FileVersion: 1.4.2` / `CompanyName: Oven` / `OriginalFilename: bun.exe`；图标也是 Bun 的 |
| 打包耗时 | 全流程约 40s（含构建/精简/捆绑/pkg/rcedit） | `bun build --compile` **约 1.3s**（254 模块） |

> 内嵌体积差主要来自运行时本身：Bun 运行时 **82.1 MB**（未压缩，`--minify` 只省 0.5 MB），
> pkg 用的 Node 18 基础二进制 40.5 MB 且 GZip 压缩后进包。

### 4.2 运行表现

| | pkg | Bun compile |
|---|---|---|
| 冷启动 | 572 / 638 / 2366 ms（中位 **638 ms**） | 638 / 4266 / 4292 / 4293 / 4800 ms（中位 **4292 ms**） |
| 健康检查 / 直传 / 下载 | ✓ | ✓ |
| 管理接口鉴权（403 / 200） | ✓ | ✓ |
| 音频转码（WASM 解码 → WAV 流） | ✓ | ✓（两者输出字节数一致 16044） |
| `health.version` | `6.4.0` | **`unknown`** —— 编译后 `import.meta.url` 指向 `$bunfs`，`version.ts` 里「向上找根 package.json」的兜底路径失效；要修得改用 `--define` 或嵌入 assets |
| sqlite 持久化 | better-sqlite3（原生模块，ABI 需匹配） | 必须换成 `bun:sqlite`（Bun **不支持 N-API**，`better-sqlite3` 直接加载失败） |

> Bun 那个 4.3s 中位大概率是**运行时被杀软反复扫描**（紧凑重启同一批 exe / 首次执行）；即便如此，它也**没有更快**。

### 4.3 关键可行性验证：`bun:sqlite` 能顶替 `better-sqlite3`

实测（`_dev/bun-probe.mts`，Bun 1.4.2 + 真实 web/dist）：把 `bun:sqlite` 的 `Database` 注入 `SqliteStore` 后，
**health / 直传落库 / 消息读回 / 文件下载 / 分片上传 + 流式组装 / 同一文件二次上传 refs=2 / 流式导出 zip** 全部通过。

为此做的两处**通用性改造**（与 Bun 无关，长期都有价值，已并入主线）：
- `SqliteStore` 的句柄类型放宽为鸭子类型 `SqliteLike`（`exec` / `prepare().{run,get,all}`），
  pragma 兼容两种调用形式，事务走 `withTransaction()`（有 `transaction()` 用它，没有就退化为直接执行）；
- `run({ store })` 支持**注入 Store**（便于测试与非 Node 运行时）。

### 4.4 各自的优势与代价

**Bun compile 的优势**
- 编译极快（1.3s vs 全流程 40s），零第三方打包依赖：`pkg` + `rcedit` + `fix-icon.mjs`（payload 修补）+ esbuild bundle 这一整套都可以不要；
- **原生交叉编译**：`--target=bun-linux-x64|bun-windows-x64|bun-darwin-arm64` 直接在 Windows 上出 Linux/macOS 产物
  （本项目当前的痛点：Linux 版必须在 Linux 机器上 `pnpm install` 才能拿到可用的 better-sqlite3）；
- 内置 `bun:sqlite`：不再有「原生模块 ABI 与 Node 版本绑定」这类问题（当前最烦的一类故障）；
- 运行时是新的 JSC，长期维护风险比「已停止维护的 @yao-pkg/pkg + 已 EOL 的 node18」低。

**Bun compile 的代价**
- **不是「单文件可分发」**：静态资源要另外处理（`Bun.embeddedFiles` / `import … with { type: "file" }` 需要**代码生成**把目录逐文件 import 进去，再写一层资产路由），
  否则就回到「exe + web/ 目录」两件套；
- **exe 资源元数据全无**：图标与版本信息仍是 Bun 的，需要额外接一个 `rcedit` 之类的资源编辑器（好在 Bun 的 PE 没有「payload 被重写」问题，这步比 pkg 简单）；
- **体积更大**（+28.7 MB，含外置资源），冷启动没有优势；
- **运行时语义换了**：JSC 而非 V8，`process`/Node 兼容层的边角行为需要逐项回归（本项目用了 `child_process` 调 `reg`、手写 zip、WASM 解码器等）；
- **pkg 那条「动态 import better-sqlite3 会崩」的坑会重新出现**：Bun 下必须换成 `bun:sqlite`，即**要么放弃 pkg 要么维护两条入口**；
- 生态/工具仍在大步演进，企业内网的分发签名、杀软白名单经验都比 Node 少。

### 4.5 如果将来真要迁

优先顺序（按投入产出）：
1. **先拿到「资产内嵌 + exe 资源」这两块**：写一个 codegen（扫 `web/dist` → 生成 `import x from "./web/dist/…" with { type: "file" }` 清单），运行时用 `Bun.embeddedFiles` 做静态路由；再用 rcedit 补图标/版本；
2. **`BunStore`**：`bun:sqlite` 的薄封装（今天的注入能力已经是现成的地基），并去掉 `better-sqlite3` 依赖与 ABI 预检逻辑；
3. 用一个 feature flag 保留 pkg 入口一段时间（两条入口共用 `packages/server`，只是 store 与资产路由不同）；
4. 逐项回归：`reg` 开机自启、手写 zip 导出、五个音频解码器、`child_process` 相关、WebSocket 心跳。

---

## 五、其它打包方案的信息评估（未实测，基于官方文档）

> 面向本项目的三个硬需求来评估：**① 单文件可分发**（含 web/dist 静态资源）、**② exe 图标/版本信息**、**③ SQLite 怎么办**。
> 触发这次调研的背景：现役 pkg 已归档（`@yao-pkg/pkg` 属维护状态、目标 node18 已 EOL）。

### 5.1 结论速览

| 方案 | 单文件（含静态资源） | exe 图标/版本 | SQLite 方案 | 跨平台构建 | 成熟度 | 对本项目的适配判断 |
|---|---|---|---|---|---|---|
| **@hakobu/hakobu** 1.0.1 | ✅ `assets` 字段，**兼容旧 `pkg` 字段** | ✅ 内置（`--icon`/`--product-name`/`--file-version`） | better-sqlite3 照旧（原生模块作为 assets） | ✅ node24 全平台 + AppImage/AppDir | ⚠️ 很新（2 个版本） | **最优先候选**：迁移成本≈改配置字段 |
| **Node SEA**（`--build-sea`） | ✅ `assets` 字典 + `sea.getAsset()` | ❌ 无（需另接资源编辑器） | 内嵌 `.node` 到临时文件 + `process.dlopen`，或换 `node:sqlite` | ⚠️ 需自己准备目标平台 node 二进制 + postject | ✅ 官方维护（Node 25.5+ 内置 `--build-sea`） | **中期最稳的官方路径**，但要自己写一层资产路由 |
| **Astra** | ✅ 号称单文件（未说明资产目录细节） | ✅ 内置 | 未说明 | ❌ 目前**只出 Windows** | ⚠️ 个人项目、较新 | 观望；它自己也不保证资产内嵌 |
| **deno compile** | ⚠️ `--include-as-is ./dist` 可内嵌目录（2.1+） | ✅ Windows `--icon`（版本信息未提及） | Node-API addon 需**本地 node_modules + `--allow-ffi`**；或换 `node:sqlite` | ✅ **任意目标，官方支持交叉编译** | ✅ 成熟（Deno 2.x） | 交叉编译最强，但 Express/原生模块兼容面要逐项验证 |
| **Bun compile**（已实测） | ⚠️ 需自建 `Bun.embeddedFiles` 资产路由 | ❌ 无 | 换 `bun:sqlite`（已验证可行） | ✅ 全平台交叉 | ⚠️ 新但迭代快 | 功能已跑通；体积/启动/元数据三项都吃亏 |

### 5.2 逐项说明

**① @hakobu/hakobu（最值得先试）**
- 自我定位就是 **`@yao-pkg/pkg` 的继任者**（“The modern Node.js packager — the successor to @yao-pkg/pkg”），MIT。
- **迁移几乎零成本**：`package.json` 里把 `"pkg"` 字段改名 `"hakobu"`（旧字段仍被接受，只打迁移警告），
  `assets` 语义保留 —— 我们现有的 `"assets": ["../web/dist/**/*", "node_modules/better-sqlite3/**/*", …]` 可直接沿用。
- **内置元数据编辑**（`--icon app.ico --product-name "filesyncex" --file-version 6.4.0`）→ 目前那套 `rcedit` + `fix-icon.mjs`（解析 payload 占位符再拼回）**可能整体不再需要**，这是最大吸引力。
- 目标 **node24**（比现役 node18 新两代），支持 `--target all` 跨平台、`--bytecode`、`--compress Brotli/GZip`、`--bundle`（内部用 Rolldown，正好解决我们 ESM→CJS 的 bundle 步骤）、Linux AppDir/AppImage、macOS 签名/公证。
- 风险：**1.0.1 且只有 2 个版本发布**，缺少大规模使用验证；原生模块（better-sqlite3）仍需按目标平台准备 `.node`（与 pkg 同样的限制）。
- **行动建议**：值得花半天做一次 PoC（改 `href` 字段 + 去掉 fix-icon 步骤），但先别删 pkg 链路。

**② Node SEA（官方，`--build-sea`）**
- Node **25.5.0+** 内置 `node --build-sea sea-config.json`（此前是 `--experimental-sea-config` + `npx postject` 两步）；稳定性标注仍是 *Active development (1.1)*。
- **静态资源有官方方案**：配置里 `assets: { "index.html": "./web/dist/index.html", … }`，运行时 `sea.getAsset(key)` / `getAssetAsBlob()` / `getAssetKeys()`（v22.20+/v24.8+）—— 我们要把 `express.static(webDir)` 换成一个「从 assets 取、按路径匹配」的小路由（约 30–50 行）。
- **原生模块可行但要绕**：把 `.node` 作为 asset 内嵌，启动时写到临时文件再 `process.dlopen()`（官方文档给了示例）。或者干脆换 **`node:sqlite`**（Node 22.5+ 内置；本机实测 Node 25.9 `require('node:sqlite')` 通过）—— 后者能把 better-sqlite3 与 ABI 问题一起彻底拿掉，`Store` 抽象正好接得上。
- **已知坑**：注入的脚本**不能 `require` 文件系统上的模块**（必须先 bundle 成单文件，我们已有 esbuild 这步）；`useCodeCache: true` 时 `import()` 不可用；跨平台生成时要关掉 `useCodeCache`/`useSnapshot`；Linux arm64 容器里 postject 产物 `process.dlopen` 会崩（官方 caveat）。
- **体积**：内嵌的是完整 `node.exe`（本机实测 Node 18 66.6 MB / Node 22 80.5 MB / **Node 25 91.2 MB**），比 pkg 压缩后的运行时（40.5 MB）大 —— 最终 exe 大概率落在 **90–100 MB**，是本表里最大的。
- 好处是**完全官方、无第三方归档风险**，且能顺手升级到 LTS 运行时。

**③ Astra（`astra-cli`）**
- 定位「js-to-exe 编译器」，**esbuild bundle → 生成 blob → postject 注入 node.exe → 改元数据**，本质是**把 SEA 那套流程封装好**（它自己也说「有 workaround 绕开 Node SEA 的限制」）。
- 官方对比表写：支持 Node 24、支持 ESM、内置元数据编辑、产物 ~75 MB、用 UPX 可压到 ~30 MB。
- 但它**目前只支持 Windows**（macOS/Linux 在计划中），且没说明「静态资源目录怎么内嵌」—— 对我们这种要靠 `web/dist` 的项目是关键未知数。
- 个人项目、体量小；作为「SEA 的便利前端」可以观望，不作为主线。

**④ deno compile**
- **交叉编译最强**：`--target x86_64-pc-windows-msvc | x86_64-unknown-linux-gnu | aarch64-apple-darwin …`，官方说「无论宿主平台都能编到所有目标」，并且**编译时下载对应 `denort`**（启动器只含运行所需，体积更小）—— 直接解决我们「Linux 版必须在 Linux 打包」的痛点。
- **静态资源有正规方案**：`--include-as-is ./dist`（2.1+）把已构建的前端产物原样内嵌，运行时用 `import.meta.dirname + "/…"` 读取（官方示例正是「Vite/webpack 产物」场景）。
- **图标**：Windows 有 `--icon icon.ico`；但**没有提到版本信息（ProductName/FileVersion）**，这块大概率仍要外部工具。
- **SQLite**：Deno 2.0+ 支持 **Node-API addon**，但要求**本地 `node_modules` + `--allow-ffi`**（`--allow-ffi` 可在编译时固化）—— 也就是说 better-sqlite3 也许能跑，但会引入「必须带 node_modules」的约束，和「单文件分发」相冲突。更干净的路是换 `node:sqlite`（Deno 也实现了 `node:` 兼容层）。
- 其余风险：Express 是 CJS 依赖树（Deno 对 CJS 支持好，但 `.cjs` 解析需要本地 node_modules，同样与单文件相斥）；本项目还用了 `child_process` 调 `reg`、手写 zip、WASM 音频解码器，这些都要逐项回归。

### 5.3 如果要动手，建议的顺序

1. **hakobu PoC（半天）**：改 `"pkg"` → `"hakobu"` 字段，`hakobu doctor` 看体检结果，试着去掉 `fix-icon.mjs`；跑通就基本等于「pkg 的现代化续命」。
2. **Node SEA PoC（1–2 天）**：把 `webDir` 改成 assets 路由 + 用 `node:sqlite` 替掉 better-sqlite3（`Store` 注入能力已经就绪），Node 25 跑 `--build-sea`；这条能顺手把运行时升级到现代 Node、并摆脱所有原生模块问题。
3. deno compile / Bun compile：只在前两条都不满意时再投入（Bun 已验证「能做但要额外维护资产与元数据」，Deno 的 Node-API 约束对单文件分发不友好）。



### 5.4 hakobu 实测结论（2026-09，@hakobu/hakobu 1.0.1 —— **暂不迁移**）

用户要求「先试 hakobu，没问题就迁移」。实测下来**能跑通但没法整体替代 pkg**，故**保持 pkg**。以下是全部证据。

**做成的部分（90% 管线打通）**
- 打包成功：`hakobu . --entry dist/bundle.cjs --assets "web/**/*" --target node24-win-x64`，产物 **107 MB**（内含 Node 24.14.0 运行时）。
- 产物**功能验收 16/16 通过**：health（version 6.4.0）、静态首页/前端资源/字体/夜鹭页、WebSocket、直传、引用计数与物理回收、分片 + 流式 SHA、动态切片、SQLite 落盘、管理接口鉴权（403/200）、跨站拦截、导出 zip、正常退出。
- **运行时升到 Node 24 + 用内置 `node:sqlite`**（见下），彻底不需要 better-sqlite3。

**三处硬阻塞（都有可复现证据）**
1. **自带 PE 元数据/图标注入会破坏 payload → exe 直接起不来**：
   `hakobu ... --icon FS.ico --product-name ... --file-version ...` 打包「成功且日志显示 Injected PE metadata」，但运行报
   `pkg/prelude/bootstrap.js:1 SyntaxError: Invalid or unexpected token`（payload 被改坏）。不带 `--icon`/`--product-name` 时产物完全正常。
   这与本项目当年踩过的 rcedit 坑同源：**任何重写 PE 资源的工具都会丢弃 pkg 快照数据**（我们有 `fix-icon.mjs` 专门处理它）。
   试过替代方案：用 `rcedit` 在打包后补元数据/图标 → 报 `Pkg: Error reading from file`，同样破坏 payload。
2. **`--compress GZip` 与元数据注入进一步冲突**：同一组合会直接报 `EBUSY: resource busy or locked`（不压缩时能成功，但体积 +8 MB）。
3. **静态资源没进快照**：`hakobu inspect .` 显示 `Files (2 total)`，即 `--assets` / `package.json` 的 `"hakobu"` 字段都**未被采纳**
   （1.0.1 里 hakobu 只按 `package.json.main` 找入口，文档描述的字段支持属于比 npm 上更新的版本）。
   实测加 `--assets "web/**/*"` 后产物仍只有 2 个文件，`/assets/*.js`、`/fonts/*.woff2`、`/night-heron-ride.html` 全部 404，
   首页走 SPA 兜底文案「前端未构建」。**单文件可分发这一核心诉求无法满足**。
   （官方 doctor 也自认：`[legacy-pkg-config] Hakobu does not yet read legacy pkg config fields (scripts, assets)`）
4. 体积：**107 MB vs pkg 71.18 MB**（+36 MB，因为内嵌完整 Node 24 运行时；pkg 用的是 GZip 压缩后的 node18 基础二进制）。

**这次迁移尝试里净赚的通用改进（已并入主线，与迁不迁 hakobu 无关）**
- 服务端 SQLite 打开顺序改为 **优先 Node 内置 `node:sqlite`**（Node 22.5+ 实验、24 起稳定），拿不到才回退 better-sqlite3：
  - 彻底消除「原生模块 ABI 与 Node 版本绑定」这类故障；
  - 打包目标升到 node24 时不再需要 better-sqlite3 的预编译包（Node 24 的 ABI 137 包当时还没发布）。
- 新增 `getRequire()` 多级回退（`__filename` → `import.meta.url` → 全局 require），修复了「CJS bundle 里 `import.meta.url` 被置空 → createRequire 报 filename 必须为绝对路径」的问题。
- 测试辅助改为**按运行时选驱动**（`makeSqliteStore` / `openRawDb` / `sqliteGet`），于是 Node 18（better-sqlite3）与 Node 25（node:sqlite）下**都能跑满 70 条测试**（此前 Node 24+ 会跳过 27 条 sqlite 用例）。
- `SqliteStore` 句柄类型放宽为鸭子类型 `SqliteLike`（见第四节），可换任意 SQLite 驱动。

**结论与重启条件**
- 结论：**保持 pkg**。hakobu 的「自带元数据编辑、省掉 rcedit/fix-icon」正是最吸引人的点，但它恰好被自己的 payload 格式挡住了；
  叠加静态资源未内嵌与 +36 MB 体积，迁移目前是净亏。
- 何时值得再看：① 上游修掉「PE 元数据注入破坏 payload」；② `assets`/`hakobu` 字段在**已发布版本**里真正生效（可用 `hakobu inspect` 一行验证：`Files` 数应远大于 2）；
  ③ 那时只需改 `package.json` 的 `pkg` → `hakobu` 字段（我们已确认 `SqliteStore` 注入与 node:sqlite 这两块地基就绪）。
