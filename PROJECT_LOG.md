# filesyncEX 项目操作日志

> 本文档是重构过程的 **操作日志（Operation Log）**，用于逐次记录对项目的改动、决策与进度。
> 注意：这是操作日志，不是 README / 使用文档。

> **当前版本：alpha1**（原型定版 · 2026-08-06）——原型设计阶段收官，进入具体逻辑实现阶段。

---

## 版本里程碑

### alpha1（2026-08-06）— 原型定版
- **桌面端** `docs/prototype/desktop.html` 打磨完成：统一一体式消息卡片、图片/视频全屏预览（标题主体色+删除纯色白字）、弹窗（设置/二维码/文件信息）淡入+点击空白关闭+滚轮屏蔽、文件消息直接下载、文字 http 链接点击开网页、代码消息（One Dark 高亮+分隔线下移+去三个点）、日月主题图标、隐藏滚动条、删除免二次确认等 40+ 项调整。
- **移动端** `docs/prototype/mobile.html` 打磨完成：消息卡片与桌面端同步、文字点击复制、长按删除确认气泡、全屏预览（代码高亮/智能缩放/点空白关闭）、底部 Sheet（附件/上传进度/设置/二维码弹窗）、遮罩淡入、Sheet 滚轮屏蔽、日月主题图标等 40+ 项调整。
- **设计语言定版**：黛绿 `#047878` 主色 / 薄荷 `#86cecb` / 粉 `#e12885`；One Dark 代码主题（token 配色）；桌面移动统一风格；太阳/月亮主题图标。
- **阶段转换**：原型 → 实现。按已确认的 P0 monorepo 骨架（`protocol` / `core` / `server` / `web` / `shell`）落地真实逻辑；**最终产物为 `pkg` 打包的单个 exe**（内嵌前端静态资源、含 rcedit 图标版本信息、better-sqlite3 经 Store 抽象隔离）。

### alpha1-实现（2026-08-06）— P0 monorepo 骨架 + 核心链路跑通
- **五包骨架**（pnpm workspace）：`packages/protocol`（zod 协议单一起源）/ `core`（Store 抽象 + SyncEngine 纯业务 + EventBus）/ `server`（Express + ws 传输适配 + 分片上传）/ `web`（lit + Vite）/ `shell`（Node 入口 + pkg 打包）。全部 `tsc` 通过，`web` Vite 构建 40KB。
- **协议**（protocol）：DeviceInfo / MsgData / MsgInput（发送草稿，服务端补全 id/sender/ts）/ 上传分片（init/chunk/complete）/ WS 帧（hello/send/del/rename/ping + welcome/add/del/peers/renamed/pong）。
- **core**：`Store` 接口（消息/上传会话/文件索引）+ `MemoryStore` + `SqliteStore`（better-sqlite3，WAL）+ `SyncEngine`（消息增删查/历史裁剪/事件）+ `EventBus`。**better-sqlite3 原生模块经 Store 抽象隔离，pkg 打包不可用时自动降级内存**。
- **server**：`Express`（静态资源 + /api/upload 分片 + /api/file 下载 + /api/msgs + /api/health）+ `ws`（同端口 /ws，单端口模式）+ **唯一实例锁**（dataDir/.instance.lock，崩溃残留自动接管）+ **端口占用友好提示**（EADDRINUSE → 明确报错）+ 环境变量 `FSEX_HTTP_PORT` 覆盖。**HTTP 与 WS 单端口复用**（exe 分发只需开放一个端口）。
- **web**（lit 单组件 App）：设备指纹（FNV-1a + localStorage）、WS 自动重连、消息渲染（text/code/file/image/audio/video）、分片上传（含断点续传 done 跳过 + SHA-256 秒传）、拖拽/选择文件、代码模式、日月主题、二维码弹窗（程序化 SVG）、昵称设置、删除消息。
- **冒烟测试**（`packages/server/smoke.mjs`，临时脚本）：health ✓；分片上传 init→chunk→complete ✓；下载 200 ✓；WS 历史同步（新连接收到全部历史）✓；在线设备 peers ✓；删除广播 ✓；`/api/msgs` 持久化 ✓。
- **浏览器端到端**：页面加载 → WS 自动连接（状态「已连接」）→ 历史消息渲染 → 发送消息**本机即时回显**（服务端广播含发送者 + 前端 id 去重）→ 输入框自动清空 → 主题切换（dark/月亮）→ 二维码弹窗（270 格 SVG）。
- **关键修复**：
  - `better-sqlite3`/`esbuild` 构建脚本被 pnpm 10 拦截 → `pnpm-workspace.yaml` 加 `onlyBuiltDependencies` + `pnpm install --force` 触发。
  - 实例锁崩溃残留 → 锁文件记录 PID，进程已退出则自动接管。
  - 客户端 `id:""` 占位导致帧校验失败 → 新增 `MsgInput` 草稿类型，服务端补全权威字段。
  - lit 组件状态不更新 → TS `target ES2022` 默认 `useDefineForClassFields:true` 覆盖 lit 响应式 accessor，基座 tsconfig 设 `useDefineForClassFields:false`。
  - lit 对聚焦 input 的 `.value` 绑定保护 → 发送后手动清空输入框 DOM。
  - 二维码 SVG 字符串插入 → `unsafeHTML(qrSvg())`。
- **打包 exe**：`pnpm --filter @filesyncex/shell package` → release/filesyncex.exe（pkg node18-win-x64，assets 内嵌 web/dist）。【结果见下方登记】

### alpha1-实现·服务器完整链路（2026-08-06 · 25/25 冒烟通过）
- **断点续传补全**：`UploadInitReq` 新增可选 `uploadId`（客户端持久化），服务端 `init` 遇匹配会话（name/size 一致）复用并返回 `done`（已传分片）；前端 `uploadFile` 用 `localStorage`（`fsex_upload_<sha>`）存 uploadId，中断后按同 sha 自动续传，完成删除。
- **秒传补全**：服务端秒传命中（sha256 命中已有文件）时也 `engine.addMessage` 广播文件消息（不再只返回 existed）。
- **完整冒烟测试**（`packages/server/smoke.mjs`，25 项全过）：health ✓；多设备 WS 历史同步（文本/代码）✓；在线 peers 增/减（相对基线 N0、断开后回 N0）✓；改名 renamed 广播 + peers 更新 ✓；2.5MB 大文件 3 分片上传 + 下载字节数一致 ✓；断点续传（复用 uploadId、done=[0]）✓；秒传（同 sha 不同设备 existed）✓；image/audio/video 类型分类 ✓；删除广播 ✓；持久化含全部类型 ✓。
- **前端真实上传 E2E**：浏览器拖拽/选择文件 → `handleFiles` → `uploadFile` 分片上传 → 服务端广播 → WS 回显本机消息（250B「前端上传.txt」出现 + 进度 100% + 下载链接正常）。
- 测试环境注意：浏览器页面持续连接 server 会出现在 peers（用户-6362 等），冒烟测试 peers 断言已相对化（基线 N0）。

### alpha1-实现·pkg 打包 exe 成功（2026-08-06）
- **产物**：`release/filesyncex.exe`（~60MB，Node 18.20.4 win-x64，内嵌 web/dist 静态资源），**已验证可运行**：health ✓、内嵌网页（filesync-app）✓、WS 连接「已连接」✓、发送消息回显 ✓。
- **踩坑与解法（重要，勿重蹈）**：
  1. `pkg@5.8.1`（已归档）pkg-fetch 远程缓存找不到 base binary + 源码构建撞进度条断言 bug → **换 `@yao-pkg/pkg`**。
  2. `@yao-pkg/pkg@6.x` 依赖 `undici@7`，需要 `File` 全局（Node 20+），Node 18 加载崩溃 → **pin `@yao-pkg/pkg@^5.16.1`**（用 node-fetch，Node 18 兼容）。
  3. pkg-fetch 误报「Not found in remote cache」，但 `yao-pkg/pkg-fetch` release `v3.5` 实际有 `node-v18.20.4-win-x64` → **手动下载**到 `~/.pkg-cache/v3.5/fetched-v18.20.4-win-x64`（42MB）绕过远程检查。
  4. **ESM 无法生成 bytecode**（`import.meta` babel 解析失败）→ 用 **esbuild bundle 成单文件 CJS**：`esbuild src/index.ts --bundle --platform=node --format=cjs --target=node18 --external:better-sqlite3 --outfile=dist/bundle.cjs`，再 pkg 打 bundle.cjs。
  5. server 的 CLI 判断用 `import.meta.url` 需移除（shell 是唯一入口），否则 bundle 失败。
  6. **better-sqlite3 原生模块 pkg 下不可用**（未打包 .node）→ server 启动检测失败**自动降级内存存储**（Store 抽象设计生效，功能可用、数据不持久；后续可把 .node 加 pkg assets 或换 SEA）。
- **当前打包流程**：`pnpm --filter @filesyncex/shell package` = 构建五包 → esbuild bundle → pkg（命中本地缓存）。
- **遗留**：exe 内 better-sqlite3 持久化待优化（assets 注入 .node 或 SEA）；rcedit 图标/版本信息未做（plugins/rcedit 参考旧工程）。

### alpha1-实现·web 界面与原型两端同步（2026-08-06）
- **重构 `packages/web/src/app.ts`**（lit 单组件）对齐原型两端界面与交互。
- **消息卡片**（对齐原型统一风格）：头像（sender.color 圆角方块 + 首字符）、head（彩色 who + 本机标记 + HH:MM）；text 气泡；file 卡片（图标 + 名称 + 大小 + 下载）；image/video 卡片（缩略图 + 底部渐变覆盖层 .ovl + 文件名/大小 + 下载按钮）；audio 卡片（图标 + 名称 + 控件）；code 卡片（One Dark 深色 + 语言栏 + 代码 + 底部渐变覆盖层 + 复制按钮）。本机消息靠右 + 右上/左上 ✕ 删除角标（粉色）。
- **输入区**：附件按钮（打开附件 Sheet）+ 代码模式按钮（开启后切换 select 语言 + 深色 textarea 编辑器）+ 圆角输入框 + 主色发送按钮；拖拽上传高亮；上传进度条。
- **弹层**（响应式）：移动端底部滑出 Sheet、桌面端居中弹窗——附件（相册/拍照/文件）、上传进度（qlist 进度条）、设置（昵称 + 设备指纹）、二维码（扫码连接 + 程序化 SVG + 地址）。
- **全屏预览**（.viewer）：图片/视频/音频/代码，标题主体色 + ✕ 关闭 + 点空白关闭；底部「下载/复制」+ 删除按钮（粉底白字）。
- **主题/设备**：太阳/月亮图标、WS 自动重连、设备指纹昵称。
- **浏览器验证**：桌面（1280px）消息卡片/输入区/弹层居中 ✓；移动（390px）底部 Sheet/输入条 ✓；附件/二维码 Sheet 开关 ✓；图片/代码全屏预览 ✓；代码模式 ✓；删除角标 ✓。

### alpha1-实现·真实文件测试 + 代码语法高亮（2026-08-06）
- **真实文件上传测试**（用户提供 `testFiles/`）：bg.jpg(9.6KB image) / 7pm.wav(38.6MB audio) / 图片人物替换.png(4.5MB image) 经前端 `setInputFiles` 走真实分片上传全部成功——类型分类正确（image/audio）、下载链接可用、缩略图/播放控件渲染正常。38.6MB 音频验证大文件分片。
- **代码 One Dark 语法高亮**：移植原型 `highlightCode`（HIGHLIGHT_LANGS 正则 / HIGHLIGHT_GROUPS / TOKEN_CLASS / esc）到 web；代码消息卡片 `<pre>` 与全屏代码预览 `.codeview` 均用 `unsafeHTML(highlightCode(...))` 渲染；token 颜色 CSS（tok-kw 紫 #c678dd / tok-str 绿 #98c379 / tok-num 橙 #d19a66 / tok-fn 蓝 / tok-com 灰斜体 等）。实测 `const a: number = 1;` → const/number 紫、1 橙 ✓。
- **关键修复（高亮移植踩坑）**：
  1. ts/js 正则移植时误多一个管道符 `||`（空分支）→ 正则空匹配 → `highlightCode` **死循环 → 页面 main thread 阻塞（浏览器一直 Loading）**。修复正则 + `highlightCode` 加 lastIndex 防死循环保护（`re.lastIndex <= last` 时手动前进）。
  2. ts/js 正则移植时**丢失数字组** `|\b(\d+(?:\.\d+)?)\b|` → 捕获组索引错位（kw 组变第 3 组，被 HIGHLIGHT_GROUPS[2]="num" 误标，`const` 显示为数字色）。补回数字组后组序与 GROUPS 对齐。
- **浏览器验证**：页面加载正常（不再卡 Loading）；代码卡片/代码预览高亮正确（kw 紫 rgb(198,120,221)）；截图确认界面与原型一致。






---

### alpha1-实现·web 界面全面对齐两端原型（2026-08-06）
> 用户指令：**「全部都以原型为准」**——逐项对比桌面/移动原型后对 `packages/web/src/app.ts` 做结构性整体重写，不保留自己的设计差异。
- **Header**：logo（dot + filesyncEX + `<small>v6.0.0-alpha1 · 网页端</small>`）+ spacer + 二维码按钮 + 主题按钮，**去掉连接状态显示**（对齐原型）。
- **输入区位置**（响应式 640px 切换）：
  - 桌面端**上传区在顶部**（`.upload` sticky）：btn-file「文件」+ input（「输入文本，或拖拽 / 粘贴文件到此处…」）+ `.code-editor`（ce-top 语言 select + textarea）+ bracebtn「{}」+ 发送按钮 + 上传队列 `.queue`（qitem 进度条）。
  - 移动端**底部输入条**（`footer.composer`）：addbtn(+) + bracebtn + input + 圆形 sendbtn。
- **消息按天分组**：`dayLabel(ts)` 输出 `.day` 分组条（今天 · 日期 / 昨天 · 日期 / 更早 · 日期）。
- **时间格式**：`fmtTime(ts)` 相对时间（今天 HH:MM / 昨天 HH:MM / 更早 YYYY/MM/DD HH:MM）。
- **卡片底部 `.ops` 操作行**（对齐原型「统一消息布局」重建操作行）：主操作（text→复制 / file→下载 / audio→下载 / video→下载 / code→复制）+ 删除按钮 `btn secondary pink` **免确认**。
- **文件「大小 · 类型」**：`fmtType` 扩展名 / 图片 / 音频 / 视频映射中文类型。
- **保留**：image/video `.ovl` 覆盖层（mm 名称/大小 + 下载按钮，无独立 ops 行）、代码 One Dark 高亮、全屏预览（vtop/vbody/vfoot 下载/复制 + 删除粉底白字）、弹层（attach/progress/settings/qr）、程序化二维码 SVG。
- **浏览器验证**：
  - 桌面 1280px：顶部上传区 ✓、Header 副标题+无状态 ✓、日期分组「今天 · 2026/08/06」✓、相对时间 ✓、文本/代码消息卡片底部 复制+删除 ops 行 ✓。
  - 移动 390px：桌面上传区隐藏 ✓、底部 footer.composer（+ / {} / input / 圆形发送）✓、附件 Sheet 底部弹出（相册/拍照/文件 3 项）✓、panel 底部对齐视口 ✓。

### alpha1-实现·web 桌面端全面对齐原型·第二轮（2026-08-06）
> 用户再次截图对比后指出「差异还是很大的」→ 逐项对齐 `desktop.html` 的视觉/结构细节。
- **主题变量对齐**（`packages/web/index.html`）：此前 web 用自定义浅绿底（--bg #f2f7f6 / surface 纯白 / 缺 --shadow）→ 全部改成原型值：light `--bg:#fff / --surface:#f6f8fa / --surface-2:#eef2f5 / --ink:#525658 / --muted:#6f7a82 / --line:#dde3e7 / --shadow:0 2px 8px rgba(4,120,120,.08) / --radius:10px`，dark 同步原型（--bg #13171f / --surface #1a2029 / --surface-2 #20262f 等）。**补上 --primary-hover/--primary-active/--serif**。
- **布局容器**：`:host` 居中 + `.container{max-width:1000px;padding:20px 0 30px}`（header/upload/list/footer 全在容器内）——内容居中 + 四周留白，对齐原型 body padding 20px 55px。
- **Header**：去 surface 背景条 → 透明 + `padding:12px 0 16px;border-bottom;margin-bottom:16px;gap:14px`；logo 22px/700/dot 12px/letter-spacing；iconbtn 38px。logo 点击打开设置 sheet（对齐原型）。
- **上传区**：全宽条 → **surface 卡片**（背景+边框+圆角 10px+`box-shadow:var(--shadow)`+`sticky top:12px`）+ dragover dashed 高亮。
- **花括号按钮**：独立按钮 → **absolute 悬浮输入框右上角**（right:84px 发送按钮左侧），输入框右侧留白 padding `10px 58px 10px 12px`；代码模式时 btn-file/input 隐藏、code-editor 负 margin 撑满卡片、发送按钮 absolute 右上角（`.upload-row.code-mode`）。
- **按钮尺寸**：`.btn` padding `10px 18px`/14px 字/radius 10px；`.btn-file` surface-2 底 primary 字 + 边框；上传图标用原型向上箭头（新增 I_UP）。
- **day 分组条**：文字居中 → **左右横线** `::before/::after{flex:1;height:1px;background:var(--line)}` + margin 22px 0 12px。
- **头像**：38px 彩色方块 → **36px 圆形 + 统一主体色**（`background:var(--primary)!important`，弃用 sender.color）；who 统一主题色 700；me 标记 primary 底（弃用 accent 底）。
- **文本消息进卡片**：独立气泡 → `.card.text`（surface 底+边框+阴影）+ 内部 `.bubble` 无背景无边框 + **-webkit-line-clamp:4 最多 4 行省略** + 底部 ops。
- **卡片**：`.card` 加 `box-shadow:var(--shadow)`、radius 10px、max-width 560px。
- **ops 操作行**：右对齐 → **左对齐**（去掉 justify-content:flex-end）+ padding `10px 14px 12px` + 小按钮 `padding:6px 12px;font-size:12px`。
- **图片/视频卡片**：320px 小图 → **整卡 16:9 缩略图**（aspect-ratio:16/9 + object-fit:cover）+ **absolute 底部渐变覆盖层 .ovl**（mm 名称/大小 + ops 下载/删除）+ 中间放大镜/播放图标（::after data-uri SVG，原型原样）。
- **音频卡片**：原生 audio 控件 → **play 圆形按钮 + 波形条 wave**（28 条正弦高度 `<i>`，I_PLAY/I_PAUSE 切换，播放中按钮变粉）+ mm 信息行（名称/大小）+ ops 下载。新增 `toggleAudio`（Audio 播放/暂停/ended 清理）+ `playingId` state。
- **代码卡片**：code-head padding `8px 14px 16px`（分隔线下移）+ lang `top:5px`；pre 去掉 max-height 截断（完整显示）+ font 13px。
- **文件卡片**：padding 12px 14px、ic 42px（svg 22px）、name 14px/sub 12px；整卡点击 flash「（原型）已开始下载」（对齐原型文件去预览直接下载）。
- **浏览器验证（1280px）**：容器 1000px 居中 ✓；上传区 surface 底+圆角+sticky 12px+阴影 ✓（修 --shadow/--surface 后）；花括号 absolute 悬浮输入框 ✓；day 横线 ✓；头像圆形 rgb(4,120,120) ✓；文本卡片 ✓；ops 左对齐 ✓；代码 head padding 16px/不截断 ✓；img 16:9 + ovl absolute ✓；桌面代码模式（code-mode 隐藏输入/发送 absolute/编辑器撑满）✓；全屏预览代码 ✓；二维码 sheet 桌面居中 ✓。
- **移动端不回归（390px）**：上传区隐藏/footer 输入条/附件 sheet（相册·拍照·文件 3 项）贴底/移动代码模式 ✓。
- **修复「样式错乱」两处关键 bug**（用户再次截图反馈）：
  1. `.card` 误加 `display:flex;flex-direction:column;align-self:flex-start` → 卡片宽度按内容**收缩**（文本卡片仅 114px、图片卡片仅 22px 撑不开）→ 去掉，恢复**块级卡片 + max-width 560px + 内容占满**（img thumb width:100% + aspect-ratio 16/9 撑满卡片）。
  2. **ops 操作行原在 `.body` 层（卡片外）** → 对齐原型移到**卡片内部底部 `.card .ops`**（text/file/code/audio 分支的 ops 均进卡片；img/video 在 ovl 覆盖层内）。文件卡片补 `.file` 包裹层（ic+meta 横排）后 ops 在卡片底。
  - 验证：text 卡片 562px（bubble+ops 一体）、file 118px、audio 140px、code 642px、img/video 16:9 317px 全部正常；移动端卡片自适应 body 宽不溢出。
- **删除按钮形态修正（对齐原型桌面 runTime）**：此前把「删除」做进 ops 操作行（btn secondary pink）→ **原型删除是「卡片右上角垃圾桶角标」`.del-corner`**（26px 方块 + 垃圾桶 SVG，hover 粉，免二次确认直接删 + flash「消息已删除」）；**ops 只保留主操作按钮**：
  - text→复制 / code→复制 / file→下载 / **img→复制**（新增 copyImage：fetch blob → ClipboardItem 真复制）/ audio→下载 / video→下载
  - img/video 的 ops 在底部渐变覆盖层 .ovl 内（mm 名称/大小 + 主操作），ovl 加 @click stopPropagation 防按钮冒泡触发预览
  - 移动端（≤640px）`.del-corner{display:none}`（对齐移动端原型：无删除角标，删除走预览/长按）
- 验证：22 条消息全部卡片 hasCorner + 右上角定位 ✓、ops 各类型主操作正确 ✓、点击角标删除 22→21 + flash ✓、移动端角标隐藏 + footer 正常 ✓。
- **滚动行为对齐原型（桌面：页面滚动 + 上传区 sticky 吸顶）**：此前 web 用 `.list` 独立滚动（header+上传区固定不动）；原型是**整个容器滚动**，滚动到下面后 **header 滚出视口、上传区 `sticky top:12px` 吸顶**。
  - 桌面（>640px）：`.container` 改滚动容器（height:100% + overflow-y:auto），`.list` 去掉 flex:1/overflow-y:auto（普通流）；顶部留白从 container padding-top 移到 header `margin-top:20px`（否则 container padding-top 干扰 sticky 吸附 → upload 吸附 32px 而非 12px）；`scrollBottom()` 桌面滚 container / 移动滚 list。
  - 移动（≤640px）：container `overflow:hidden`、list 恢复 `flex:1;overflow-y:auto`（footer 固定贴底）。
  - 验证：桌面滚动到底 headerBottom -257（滚出）✓、upload sticky top 12px 吸顶 ✓；移动 list 滚动 + footer 贴底 844 ✓、上传区隐藏 ✓。
- **消息排序确认**：server（MemoryStore `sort(a.ts-b.ts)` 升序 + slice(-limit)）与 web（`onAdd` append 尾部）均为**时间正序**——旧的在上、新的在下；web 实测 18:02→18:03 正序 + 新消息追加底部 ✓（无需改动）。
- **桌面端消息改为「从新到旧」（用户指令：桌面端原型消息从上到下、从新到旧）**：
  - `renderMessages()` 桌面端（>640px）`[...this.msgs].reverse()` **最新在顶**（按天分组顺序同步反转：最新日期的 day 条在最上）；移动端（≤640px）保持正序（聊天式，新的在底）。
  - `scrollBottom` → `scrollToLatest()`：桌面滚顶（scrollTop=0，看到最新）/ 移动滚底（scrollHeight）。
  - `onWelcome` / `onAdd` / 上传完成均调 `scrollToLatest`；`window resize` 监听 → `requestUpdate + scrollToLatest`（桌面↔移动切换重排序 + 滚到正确位置）。
  - 验证：桌面渲染顺序 18:03 6→…→1→18:02 wuxia.rar（最新在顶）+ 初始 scrollTop=0 ✓；移动 390px reload 正序 wuxia.rar→6 + 滚底 ✓。
- **日期格式对齐两端原型（用户反馈「日期格式不一致」）**：核心原则——**日期信息由 day 分组条承担，head 时间只显示 HH:MM**。
  - `fmtTime()`：删掉昨天/更早完整日期逻辑 → **一律 `HH:MM`**（对齐原型 head 时间，如 09:12 / 20:12）。
  - `dayLabel(ts, mobile)` 响应式：
    - 今天 → `今天 · YYYY/MM/DD`；昨天 → `昨天 · YYYY/MM/DD`（两端一致）
    - 更早：**桌面 → `更早`（无日期）**；**移动 → 7 天内 `MM/DD · 周X`（周日/周一…）、更久 `MM/DD`**（对齐 mobile.html 08/02·周日 / 07/30）
  - `renderMessages()` 传 mobile 给 dayLabel。
  - 验证：桌面注入 今天/昨天/更早 → day 条 `今天 · 2026/08/06` / `更早` / `昨天 · 2026/08/05` + head 全部 HH:MM ✓；移动 390 注入升序 → `07/30` / `08/02 · 周日` / `昨天 · 日期` / `今天 · 日期` ✓。
- **消息 head 时间格式修正（用户澄清「消息旁边的日期格式不一致」）**：上轮误把 `fmtTime` 改成一律 HH:MM → 恢复**相对格式**（对齐原型桌面那条「昨天 22:04」）：
  - 今天 → `HH:MM`；昨天 → `昨天 HH:MM`；更早 → `YYYY/MM/DD HH:MM`（完整日期）
  - 验证：今天 09:05 / 昨天「昨天 22:04」/ 更早「2026/08/03 15:30」✓（day 条改动保留不动）。
- **消息时间统一年月日时分（用户指令）**：所有消息 head 时间统一 `YYYY/MM/DD HH:MM`（如 `2026/08/06 18:21`），去掉相对格式（今天/昨天 HH:MM）。`fmtTime` 直接 `年/月/日 时:分`；day 分组条保持不变。验证：桌面全部消息 `2026/08/06 HH:MM` ✓。
- **二维码改用真 QRCode 库（用户指令「你使用 QRcode 库生成好不好」）**：移除程序化仿二维码 `qrSvg()`（21×21 假图案扫不了）→ 用 **`qrcode` 库**（`pnpm --filter @filesyncex/web add qrcode` + `-D @types/qrcode`）。
  - `import QRCode from "qrcode"`；新增 `qrDataUrl` state + `openQr()`（sheet="qr" + `QRCode.toDataURL(this.httpUrl,{width:180,margin:1,color:{dark:"#1a1a1a",light:"#ffffff"}})` 异步生成，失败 flash）。
  - 二维码按钮 `@click=${this.openQr}`；qr 弹层渲染 `<img src=qrDataUrl>`（qrbox 加 flex 居中 + img 100%，生成中显示「生成中…」）。
  - 验证：弹层显示 `data:image/png;base64` 真二维码（内容 http://127.0.0.1:14100）、200px、文字说明 ✓。构建 88.86KB（含 qrcode）。
- **服务器返回真实局域网 IP（用户指令「服务器应该知道自己的真实IP，而非 127.0.0.1」）**：
  - 提取 `lanAddress()`（os.networkInterfaces 取非回环 IPv4）到 `packages/server/src/net.ts`，`index.ts` 与 `HttpServer.ts` 共用。
  - `/api/health` 新增返回 `{ lanIp, port }`（真实局域网 IP + HTTP 端口）。
  - 前端 `connectedCallback` fetch `/api/health`：`lanIp` 非 127.0.0.1 时 `httpUrl = http://${lanIp}:${port}`（二维码/地址用真实地址）。**坑：改完 app.ts 忘记 build web，页面一直加载旧 bundle（httpUrl 仍旧 127.0.0.1），重新 build 后生效**。
  - **server 真实入口是 `packages/shell`（调用 run()）**，`node dist/index.js`（server 包）只导出不启动。开发启动：`pnpm --filter @filesyncex/shell build` + `Start-Process node dist/index.js`（shell 目录，`FSEX_HTTP_PORT=14100`，重定向日志防终端清理杀掉进程）。
  - 验证：health `{ lanIp:"192.168.40.154", port:14100 }` ✓；前端 httpUrl = `http://192.168.40.154:14100` ✓；二维码内容真实局域网 IP ✓。
  - 注意：shell 入口默认 dataDir 在 `packages/shell/data`（与 server 包 dataDir 不同），旧测试消息在新 dataDir 下不显示。
- **图片复制按钮修复（用户反馈「图片消息的复制按钮没起效」）**：
  - 旧实现 `fetch(url).blob()` + `ClipboardItem({ [b.type]: b })`：真实图片 blob.type 是 image/jpeg，兼容性差；且非安全上下文（局域网 http）下 `navigator.clipboard`/`ClipboardItem` **不可用** → 复制静默失败。
  - 改为 **canvas 方案**：`new Image()` 加载 → 画到 canvas → `toBlob("image/png")` → `ClipboardItem({ "image/png": b })`（强制 PNG，绕开源 MIME 兼容问题）；前置检查 `window.ClipboardItem && navigator.clipboard`，不可用（非 HTTPS）时 flash「当前浏览器不支持复制图片（需 HTTPS 安全上下文）」；加载失败/复制失败分别明确提示。
  - 验证：真实 bg.jpg（/api/file/...）点击复制 → flash「图片已复制」+ `navigator.clipboard.read()` 返回 `["image/png"]` ✓（真正可粘贴）。
- **视频预览自动播放（用户需求「视频消息点开预览自动开始播放」）**：全屏预览 `.viewer` 的 video 分支加 `autoplay`（`<video class="ph" controls autoplay>`）——点击缩略图打开预览即自动播放（用户手势上下文允许有声播放）。
  - 顺手优化：缩略图 `vthumb` 内 `<video muted>` 加 `preload="none"`，避免每次渲染预加载视频（消除控制台 ERR_ABORTED 噪音）。
  - 验证：点击视频消息打开预览 → `autoplay:true`、`paused:false`（正在播放）、有声、无错误 ✓。
- **音频真实波形 + 进度操控（用户需求「波形图由服务器生成，且无法操控进度」）**：
  - **服务器生成波形**：新增 `packages/server/src/wave.ts` + `/api/wave/:key` 接口（HttpServer，内存缓存 Map key→peaks）：
    - **ffmpeg 优先**（检测 PATH/常见路径）：`ffmpeg -i file -f f32le -ac 1 -` 解码任意音频（mp3/m4a/float WAV）→ 稀疏采样求峰值（96 点）。
    - **无 ffmpeg 回退**内置 WAV 解析：支持 PCM(1)、IEEE float(3)、extensible(0xFFFE 读 subformat)；ADPCM 等压缩返回 null。
    - 非音频/解码失败 → 415。
  - **前端**：音频卡片 wave 用 `wavePeaks[msg.id]`（fetch `/api/wave/<key>`，loadWave 只请求一次，失败回退正弦装饰条）；wave 渲染真实峰值高度。
  - **进度操控**：`seekAudio`（wave 点击 → `currentTime = ratio × duration`，若未播放则开始播放）；`ensureAudio` 复用/创建 audio；播放中 `.wave .ind` 竖线指示进度（timeupdate 直接改 DOM，非 lit 重渲染）。CSS 加 `.ind` 样式 + wave `position:relative`。
  - **坑**：7pm.wav 是 **IEEE float 32bit** WAV（fmtCode 3），仅 PCM 解析会 415 → 扩展支持 float + 引入 ffmpeg 兜底。
  - 验证：`/api/wave/22ec31cef376_7pm.wav` 返回 96 峰值 ✓；前端 96 条波形高度与 peaks 一致（71%/83%/70%…）✓；点击波形中部 → currentTime/duration≈0.5 并自动播放 ✓；播放中 .ind 进度指示 ✓。
  - **波形状态着色（用户需求「没有播放的改为灰色，播放暂停之后进度条指示器不要隐藏」）**：CSS 改为 `.card.audio .wave i` 默认 `var(--muted)` 灰、`.wave i.played` 已播部分 `var(--accent)` 薄荷；`updateWaveInd` 按 `ratio×count` 给 `i` 加 `.played` 类着色，`wave.classList.toggle("show-ind", ratio>0 && ratio<1)` 控制指示器（未播放/播完隐藏，暂停中间保持显示）。删除被旧规则覆盖的残留 `.wave i{background:var(--accent)}`。
    - 验证：初始 96 条全灰（#6f7a82）✓；播放 2.5s 后暂停 → 已播 2 条薄荷（#86cecb）+ 未播灰 ✓；`.show-ind` 保持 + `.ind` 竖线 opacity .85 ✓。
  - **轻量解码器替换 ffmpeg（用户需求「ffmpeg 79MB 太大，有没有更小选择？需求仅波形图+视频首帧」）**：
    - **关键洞察**：①视频首帧缩略图 web 端用 `<video muted preload="none">` 浏览器自行取帧，**根本不依赖 ffmpeg**；②ffmpeg 只用于「非 WAV 音频」波形解码，WAV 走内置解析（0 依赖）。故 79MB ffmpeg-static 只为一个场景服务。
    - **替换方案（全格式，用户选择 B）**：移除 `ffmpeg-static`（−79MB），改装 `@audio/decode-*` 系列 WASM 解码器（wasm 内嵌在 JS 里、无外置二进制，pkg 打包友好）：`@audio/decode-mp3`（MIT 0.10MB）/ `@audio/decode-flac`（MIT 0.14MB）/ `@audio/decode-vorbis`（MIT 0.17MB）/ `@audio/decode-aac`（**GPL-2.0** 0.38MB，M4A/AAC/ALAC）。合计 **~0.79MB**（对比 79MB 减少 ~98%）。统一 API `decode(buf) → {channelData, sampleRate}`。
    - **wave.ts 重写**：`detectKind(buf)` 读魔数识别（RIFF→wav / fLaC→flac / OggS→ogg / ftyp→m4a / ID3 或 0xFFE→mp3 / 0xFFF→aac ADTS）；WAV 走内置解析（同步零依赖），其余按格式调对应 WASM 解码器 → `peaksFromChannels` 取多声道最大绝对值峰值（96 点）。`wavePeaksFromFile` 改 async，HttpServer `/api/wave` handler 改 async。
    - **坑 1**：`@audio/decode-aac` 在 Node 分支用 `createRequire(import.meta.url)("./src/aac.wasm.cjs")` 动态加载 → **esbuild bundle 后相对路径失效**（`import.meta.url` 指向 bundle，`./src/aac.wasm.cjs` 不存在）→ M4A 在 bundle/exe 中 415。修复：**pnpm patch** 将该分支改为静态 `await import('./src/aac.wasm.cjs')`（与 browser 分支一致，esbuild 可内嵌），固化到 `patches/@audio__decode-aac@1.3.4.patch` + `pnpm-workspace.yaml` 的 `patchedDependencies`。
    - **坑 2**：先临时改了 node_modules 的 decode-aac.js 验证可行，但 pnpm 会覆盖 → 必须用 `pnpm patch`/`patch-commit` 固化（补丁目录 `.pnpm_patches` 在项目内）。
    - **验证**（ffmpeg 生成 4 个 3s 正弦测试音频 wave_test.mp3/flac/ogg/m4a）：dev server `/api/wave` 4 格式均 96 峰值 ✓；esbuild bundle 后 4 格式均 96 峰值 ✓（M4A 靠补丁）；**新 exe（release/filesyncex.exe 61.2MB）内置解码器，4 格式均 96 峰值 ✓，不再依赖系统 ffmpeg**。
    - **exe 体积说明**：新旧 exe 都是 ~61MB（pkg node18 base ~58MB 占大头）；ffmpeg-static 的 79MB 只存在于 node_modules 开发环境、从未打进 exe。真正收益：①node_modules 减 79MB；②exe 内置解码器，任何机器不装 ffmpeg 也能出波形。
    - **注意（license）**：`@audio/decode-aac` 是 GPL-2.0（FAAD2），如未来闭源分发 exe 需评估；其余 3 个 MIT。
  - **Opus 支持补全（用户上传 7pm.opus 反馈波形不支持）**：Opus 是合法音频格式（Ogg Opus 容器，头 `OpusHead`）。原 `detectKind` 只认 `OggS` → 一律走 `decodeVorbis`，Opus 内容解码失败 → 415 回退装饰波形。修复：装 `@audio/decode-opus`（MIT，182KB wasm 内嵌），`detectKind` 在 OggS 分支内进一步读 64KB 区分 `OpusHead`→"opus" / `\x01vorbis`→"ogg"，解码分支加 `decodeOpus`。验证：`7pm.opus` → 96 峰值（max 0.77）✓；`7pm.ogg`(vorbis) 不受影响 ✓。
- **上传队列残留修复（用户反馈「去掉上传进度条」）**：桌面端上传面板下 `.queue` 会把**已完成的条目（100%）一直留着**不消失，堆积多个已完成项。修复 `handleFiles`：上传成功后立即 `this.uploads.filter(x => x !== rec)` 从队列移除（进行中仍显示进度、失败保留红色提示）。验证：reload 后上传区下方无残留队列 ✓。
- **秒传「同内容不同名」修复（用户需求「按内容生成哈希防重复；同内容不同名 → 新消息但文件指向旧文件」）**：现有秒传（前端 SHA-256 → init 命中 → 广播消息）已存在，但 bug：秒传生成的消息用 `existing`（**旧文件名**），同内容不同名时消息显示旧名。修复 `init` 秒传分支：`const meta = { ...existing, name: req.name, mime: req.mime || existing.mime }` —— 新消息用**本次上传的名字**，但 key/url/sha256/size 沿用旧文件（文件内容/下载仍指向旧文件）。验证：上传「同内容测试.txt」→ 再传同内容「改名后的文件.txt」→ 新消息 name=改名后的文件.txt、key 与旧文件一致（4660989c68bc_…）✓。
- **浏览器音频兼容评估（用户问「有几个格式无法播放，是否内嵌全能播放库」）**：结论 **不推荐内嵌前端播放库**，推荐 **服务器端转码流（复用现有 WASM 解码器）**：
  - 现状：`<audio>` 原生播放 file.url。Chromium 系对 mp3/wav/flac/ogg/m4a/opus 均 canPlayType maybe/probably；真正的兼容短板是 **`.aac`（ADTS 裸流）在多数浏览器无法播放**、旧版 Safari/Firefox 对 ogg/opus/flac 支持差。
  - 前端内嵌播放库（如 wasm-audio-decoders 浏览器版 + Web Audio）缺点：每个解码器 wasm 数百 KB → 前端 bundle 体积暴涨、需自建 decode→AudioContext 播放管线、与现有 seek/波形联动重写，收益低。
  - 推荐方案：服务器已有全套 `@audio/decode-*` 解码器 → 新增 `/api/stream/:key`（按需解码转 **WAV/PCM** 流返回），前端对 canPlayType 不支持的格式把 audio.src 指向流接口即可。零新增依赖、复用解码、跨浏览器一致。
  - 待用户确认是否实施。
  - **文件引用计数 + 转码流（用户需求「所有文件加引用计数写入数据库；统一转码流确保音频都能播放」）——已实施**：
    - **引用计数（持久化）**：Store 接口新增 `incrFileRef`/`decrFileRef`/`removeFile`；SqliteStore `files` 表加 `refs` 列（旧库启动时 ALTER 迁移 + 按现有消息重算 refs），MemoryStore 独立 Map 维护。上传新文件 saveFile refs=1；秒传命中 `incrFileRef`（新增消息也引用该文件）；`SyncEngine.removeMessage` 与 `trim` 裁剪时 `decrFileRef`，归零则 `removeFile` + emit `file-gc {key}` 事件（EventBus 注册该事件）；server 订阅 `file-gc` → `UploadService.deleteFile` 物理删除。**验证**：同内容 2 消息 refs=2 → 删 1 条 refs=1 文件保留 → 删最后 1 条 refs=null 文件删除 ✓；**重启后 refs 不丢（持久化）** ✓。
    - **转码流（统一播放）**：`wave.ts` 重构抽出通用解码 `decodeToChannels(p)`（读文件→detectKind→解码 PCM，供波形/转码共用）+ `toWavBuffer(decoded)`（多声道 PCM16 WAV 编码）；`decodeWav` 解析实际采样率（fmt 块 sampleRate）。新增 `/api/stream/:key`：解码→WAV 流，**支持 Range 请求**（206/Content-Range，audio 拖动 seek 需要），`streamCache` 只解码一次。前端 `audioSrc(m)` 统一返回 `/api/stream/<key>`，`ensureAudio` 与模板 `<audio src>` 都改用该源（下载仍走 `/api/file/<key>` 原文件）。**验证**：opus → `/api/stream` 200 audio/wav 22MB RIFF/WAVE 头 ✓、Range 206 `bytes 100-199/22054104` ✓、浏览器 `readyState=4 duration=114.86s error=null`（可播放出声）✓；全部音频消息 src 均指向 /api/stream ✓。
    - **注意**：转码流 WAV 未压缩（22MB/2min），内存/带宽成本高于直接播放；仅音频走流，图片/视频/下载仍用原文件。
  - **桌面端设置面板对齐原型（用户「对比桌面端和原型设置面板，同步」）**：web 端 `settings` sheet 相比 `desktop.html` 的 `dlgSettings` 缺 3 块 → 补齐：①**连接**（已连接·局域网 状态点 + HTTP/WebSocket 真实地址）；②**工具**（下载 QuickSendTool.exe + 说明）；③**关于**（前往 GitHub）。新增 `I_LINK` 链接图标 + `.settings` CSS（st-sec/st-conn/dot/muted code/st-note/hr/tool 按钮）。昵称/指纹原本已有。**WS 地址与 httpUrl 同源**（`httpUrl.replace(/^https?:/, ...)` + `/ws`），避免出现 127.0.0.1。验证：HTTP=192.168.40.154:14100、WS=ws://192.168.40.154:14100/ws（同 IP 同端口）、状态点 rgb(4,120,120)、两个按钮存在 ✓。
  - **设置面板宽度对齐原型 + QuickSendTool 打包（用户「宽度不对；工具放哪、要打进 exe」）**：
    - **宽度**：web `.panel` 桌面 380px 过窄，原型 `dlgSettings` 是 **640px**。给 settings 单独加 `.settings-panel` 类，桌面 `width/max-width: min(92vw, 640px)`（`.panel` 基础 max-width 520px 会覆盖 width，需同时覆盖 max-width）。验证：设置面板 640px ✓（attach/progress/qr 仍 380px 不受影响）。
    - **QuickSendTool 位置与打包**：文件在旧工程 `filesync/tool/QuickSendTool.exe`（2.2MB）。移到 `packages/web/public/tool/QuickSendTool.exe` —— Vite 构建自动复制到 `dist/tool/`，server `express.static(webDir)` 自动托管 `/tool/QuickSendTool.exe`，pkg assets `web/dist/**/*` 自动打进 exe。验证：dev `GET /tool/QuickSendTool.exe` 200 ✓；**打包后 exe 内访问同样 200/2.2MB** ✓。exe 体积 61→**84.1MB**（转码流 bundle 6.4MB + tool 2.2MB + 其他）。
  - **QuickSendTool 替换入口改为根 tool/（用户「能不能根目录新建 tool 文件夹，我替换进去就行，打包脚本处理」）**：在**项目根目录**建 `tool/` 作为**唯一替换入口**（`tool/QuickSendTool.exe`）。打包脚本 `packages/shell/scripts/package.mjs` 在 build web 前新增「同步 tool/ → packages/web/public/tool/」步骤（遍历复制根 tool 下所有文件），Vite 再复制进 dist → pkg 进 exe。删除了 web/public/tool 的手动副本（改由脚本生成，避免两处不同步）。**用户流程：只需把新 exe 覆盖到根 `tool/`，然后 `pnpm --filter @filesyncex/shell package` 即可**。验证：打包后 public/tool 与 dist/tool 均有 exe，**exe 内 /tool/QuickSendTool.exe 200/2.2MB** ✓。
  - **上传模糊占位卡 + 圆形进度（用户「上传时进度条太丑，改成模糊占位卡」）**：`handleFiles` 上传前先在消息列表插入占位消息（id=`upload-<时间戳-随机>`，kind=file，sender 显示「上传中」）→ `renderMsg` 对 `id.startsWith("upload-")` 渲染 `.card.upload-ph`：**模糊背景**（`.ph-blur` 线性渐变 + blur(6px)）+ **中心圆形 SVG 进度环**（`.ph-ring`，stroke-dashoffset 按 pct 收圆，中心百分比数字）+ 底部文件名；进度回调实时更新 `rec.pct`（`this.uploads=[...this.uploads]` 触发重渲染）。成功 → 移除占位卡（真实消息由 WS onAdd 广播、同 id 去重不冲突）；失败 → `rec.fail=true`、`rec.pct=-1`，圆环变红（`var(--pink)`）+ 中心显示 `!` + 底部「上传失败」。CSS 新增 `.card.upload-ph` 系列（ph-body/ph-blur/ph-ring/ph-pct/ph-name）。**验证**：2.5MB 上传中抓到 0% 占位卡（模糊 + 圆环 + 0%），完成后真实消息出现、占位卡移除 ✓；失败路径红环 `!` ✓。
  - **波形默认全平 + 进度整格跳变（用户「默认全平；进度改回最初的整格跳」）**：
    - **默认全平**：`waveBars(peaks?)` 无真实峰值（未加载/失败/无数据）时由 28 条正弦装饰条改为 **96 条同高度平线** `Array.from({length:96}, () => 0.4)`（高度 40%），与真实波形同数量，加载完成才显示真实起伏。验证：把 wavePeaks 置 null 后 96 条 bar 全部 `height:40%`（allFlat=true）✓。
    - **进度 = 整格跳变（多轮方案尝试后用户拍板回归最简）**：经历三轮——①bar 逐个 mixColor 渐变；②`.prog` 覆盖层线性推进；③进度线穿过 bar 用横向 linear-gradient 平滑过渡——用户均不满意（「效果很差」），**拍板改回最初的整格跳变**。最终 `updateWaveInd`：`played = Math.round(ratio * n)`，`bars.forEach((bar,i) => bar.classList.toggle("played", i < played))`——已播 bar 全部加 `.played` 类（CSS `background: var(--accent)` 薄荷实色），未播灰；**无渐变、无过渡**（移除 `transition:background` 与渐变逻辑）。竖线 `.ind` 保留（show-ind 逻辑不变）。
    - **验证**：click 波形 60% → 前 58/96 bar 加 `.played`（薄荷）、58 起灰、`anyGradient=false`（纯整格）✓。**测试注意：直接操作模板 `<audio>` 无 timeupdate 监听，须走真实 seekAudio/ensureAudio（click 波形）路径**。
  - **上传占位卡按文件类型匹配真实消息尺寸（用户「占位卡样式大小必须是特定大小，视频/音频分别展示对应消息大小的占位」）**：新增前端 `fileKind(name, mime)`（与服务器 `kindOf` 一致：mime image/audio/video 优先，扩展名兜底）判断文件类型；`handleFiles` 在 rec 和 placeholder 上记录 `kind`（`uploads` 数组类型加 `kind: string`）。`renderMsg` 占位卡按 kind 渲染**对应真实消息的结构与尺寸**：
    - **image / video**：`.card.upload-ph.image/.video .ph-body` `aspect-ratio:16/9` 全宽（同真实缩略图 560×315），中央大圆环（ringSize 68）。
    - **audio**：`.ph-body.audio` 播放按钮（38px 圆）+ 平线波形（waveBars() 34px 高）占位（同真实播放条，总高 62），圆环 48 居中。
    - **file**：`.ph-body.file` 42px 文件图标 + 占位行（同真实文件行，总高 44），圆环 40 居中偏右。
    - 进度环 SVG 改为**随类型缩放尺寸**（media 68 / audio 48 / file 40），`ph-ring` 定位随类型（media 居中 / audio 居中 / file 右侧）。失败态红环 `!` 保留。
    - **验证**（注入 4 种占位消息 + uploads）：image/video 560×315 ratio 1.78（16:9）✓、audio 560×62 含 ph-play+ph-wave+圆环 48 ✓、file 560×44 含 ph-ic+圆环 40 ✓；全部 42% 进度环正确渲染 ✓。注：小文件秒传太快抓不到真实占位卡，用注入验证渲染。
  - **七项 UI/交互优化（用户批量反馈）**：
    1. **主界面任何位置响应滚轮**：`connectedCallback` 给组件根 `addEventListener("wheel", onHostWheel)`（disconnected 移除）。`onHostWheel`：弹层/预览打开时不劫持（内部自己滚）；否则把滚轮统一转发到当前滚动容器（桌面 `.container` / 移动 `.list`），`scroller.scrollTop += e.deltaY` + preventDefault（仅当目标不在滚动容器内且可滚时）。验证：header 区域滚轮 → 容器 scrollTop 300 ✓。
    2. **logo 圆点被截**：根因 `.container` `overflow-y:auto` 使 x 方向也裁剪，圆点 3px 光环（box-shadow 外扩）超出容器左边界被裁（dotLeft 140 == containerLeft 140）。修复：header 左右 padding `0→6px`（光环有 6px 空间）+ `.logo .dot` 加 `flex:none`。验证：dotLeft - containerLeft = 6 ≥ 3 ✓。
    3. **toast 出现纯淡入（无下滑）**：去掉 `.toast:not(.show)` 的 `translateY(-24px)`（那会让出现时从 -24px 滑到 0 即下滑）。改为 `.toast` 默认 `translateX(-50%)` 无 Y 位移、`.show` 仅 `opacity:1`（**出现纯淡入**）；新增 `.toast.leaving`（`translateY(-24px)+opacity 0`）负责**消失上移淡出**。JS：`flash` 增加 `toastLeaving` state，2200ms 时 `toastShow=false` + `toastLeaving=true`，700ms 后清文字+`toastLeaving=false`。模板 `class="toast ${show?'show':''} ${leaving?'leaving':''}"`。验证：出现中 transform translateY=0（无下滑）、opacity 淡入 ✓。
    4. **占位卡完整结构**：占位卡不再只是「主体+文件名」，改为**结构与真实消息完全一致**——对应类型主体（16:9 缩略图/播放条/图标行）+ `ph-mm` 信息行（文件名+大小）+ `ph-ops` 操作行（下载按钮占位）；主体叠 `.ph-blur` 磨砂（z-index 1）+ `.ph-ring` 进度环（z-index 3，盖磨砂之上）。图片/视频主体加居中放大镜/播放图标（`.ph-icon-bg`/`.ph-vplay`）。`.card.upload-ph` 改 `position:relative; overflow:hidden`，磨砂/圆环 absolute 定位。验证：file/audio/video 三种占位均有 blur+ring+mm（文件名+大小）+ops（下载）✓。
    5. **标题文字放大**：设置/附件/上传进度/二维码面板标题 `.panel .ptitle` `17px→24px+700`；预览标题 `.viewer .vtop .vt` `16px→24px+700`（关闭按钮 20→24px）。验证：设置 ptitle 24px/700、预览 vt 24px/700 ✓。
    6. **代码输入框隐藏滑条**：`.code-editor textarea` 加 `scrollbar-width:none` + `::-webkit-scrollbar{display:none}`（保留滚动功能）。验证：scrollbarWidth none ✓。
    7. **代码输入框发送后自动变回**：`sendCode` 成功后加 `this.codeMode=false`（发送完自动退出代码模式回普通输入框）。验证：codeMode true→false、codeText 清空、代码消息发出 ✓。
  - **全局接入旧 filesync 两个字体（用户「全局引入 JetBrains Mono + 思源宋体；拷贝到根 fonts/；打包脚本处理真实位置；禁止引用 filesync 文件夹」）**：
    - **字体来源**：旧工程 `filesync/src/html/font/` 的 `JetBrainsMonoNL-Medium.woff2`（41.8KB 等宽）+ `SourceHanSerifCN-Medium.woff2`（6.3MB 思源宋体）。
    - **拷贝到根 `fonts/`（唯一入口）**：新建项目根 `fonts/` 放两个 woff2（不引用 filesync）。沿用旧 `@font-face` family 名 `"JetBrains Mono NL Medium"` / `"Source Han Serif CN Medium"`（`font-display: swap`）。
    - **打包脚本同步**：`package.mjs` 在 tool/ 同步后新增「同步 `fonts/` → `packages/web/public/fonts/`」（与 tool 同一模式，Vite 复制进 dist → pkg assets 进 exe）。
    - **@font-face + 变量**：`web/index.html` `<style>` 顶部加两个 `@font-face`（`url("./fonts/xxx.woff2")`），CSS 变量 `--mono`/`--serif` 改为真实 family 名，字体全局可用（shadow root 内经 CSS 变量继承）。
    - **git**：根 `fonts/` 与 `public/fonts/` 均保留提交（与 tool 约定一致，虽然脚本自动同步）。
    - **验证**：`/fonts/xxx.woff2` 200（dev 由 express.static 托管）✓；`document.fonts` `JetBrains Mono NL Medium` loaded ✓、`fonts.check("16px Source Han Serif CN Medium")` true ✓；`web/build` 后 `dist/fonts/` 两个字体齐全 ✓；`index.html` 1.57→1.95 kB（含 @font-face）✓。**代码中无任何对 filesync 文件夹的引用（仅 PROJECT_LOG.md 日志提及）**。
  - **Toast 淡出时序修复（用户「先向上淡出，再去除文字；现在立即去文字会导致窗口自动缩小」）**：问题根因——`flash` 用 `toastText` 同时驱动内容与 `.show`，到点同时清空文字和移除 show，**文字消失 → 窗口立即收缩**，淡出动画期间很难看。修复：**拆分 `toastText`（内容）与 `toastShow`（显示态）两个 state**（均声明进 static properties）。`flash` 流程：设 `toastText`+`toastShow=true` → 2200ms 后**只移除 `toastShow`**（触发上移+淡出动画，**文字保留、窗口保持尺寸**）→ 再 700ms（动画 0.6s 结束后）清空 `toastText`。新增 `tipClearTimer`（flash 开头 clearTimeout 两个计时器防叠加）。恢复**向上淡出**动画（`:not(.show)` = `translateY(-24px)+opacity 0`），保留小圆角 8px、黑色半透明 rgba(0,0,0,.6)、大字体 26px。模板改 `class="toast ${toastShow?"show":""}"`。**验证**：2200ms 后 show=false、文字保留「时序测试…」、宽度 374px 未收缩、opacity .717 淡出中、transformY -6.78 上移 ✓；+800ms 后文字清空 ✓。
  - **Toast 微调（用户「不要放大缩小动画；圆角小一点；黑色半透明」）**：接上条放大后，用户取消位移/缩放动画——`.toast` 去掉 `translateY(-24px)` 上移与 `transform` 过渡，`transform: translateX(-50%)` 固定仅居中，`transition` 只剩 `opacity .6s ease`（**纯淡入淡出，无移动/缩放**）；圆角 `26px→8px`；背景 `rgba(0,0,0,.85)→rgba(0,0,0,.6)`（**黑色半透明**）；保留大字体 26px+600、padding 14/28、bottom 120px、慢速 0.6s。**验证**：transform 仅水平居中（Y=0）、transition 仅 opacity、border-radius 8px、背景 rgba(0,0,0,.6) ✓。（**注：此条移除的上移动画后又被用户恢复，见下条时序修复。**）
  - **Toast 提示放大 + 慢速上移淡出（用户「提示消息窗口文字做大 2 倍以上；消失动画慢一点；向上移动并淡出」）**：`.toast` 字体 `12px→26px`（2 倍多）+ `font-weight:600`、padding `8px 16px→14px 28px`（窗口大幅增大）、圆角 `20→26px`、位置 `bottom 90px→120px`（给大 toast 留空间）。**动画**：过渡由 `opacity .2s` 改为 `opacity .6s ease, transform .6s ease`（消失变慢）；`.toast.show` 为原位不透明，`:not(.show)` 为 `translateY(-24px) + opacity 0`——**消失时向上移动并淡出**（出现时从 -24px 淡入归位）。`flash()` 停留 `1800→2200ms`（配合慢动画）。**验证**：出现中 fontSize 26px、opacity .408 淡入、transform Y 偏移 ✓；2200ms 后 show=false、opacity 0、transformY -24（上移淡出）✓。**（注：此条的位移动画后被用户要求移除，见下条。）**
  - **图片预览优化（用户「①无圆角 ②放大后无滚动条 ③图片大于窗体时按住拖动」）**：
    - **无圆角**：`.viewer .vbody.pv-img .ph` 加 `border-radius:0`（原 `.ph` 通用 10px 圆角，图片预览专用类覆盖为 0）。
    - **无滚动条**：`.viewer .vbody.pv-img` 由 `overflow:auto` 改 **`overflow:hidden`**——放大后不出现滚动条，改靠拖动查看。
    - **按住拖动**：img 绑 `@mousedown=${startDrag}`；`startDrag` 先确保 pvZoom 记录 bx/by，再判断**仅当已放大（s>1）或图片实际尺寸大于 vbody 窗体时**才启用拖动（小图不可拖）；启用后在 window 上挂 `mousemove/mouseup`（`onDragMove`/`onDragEnd`，箭头函数字段保证 this 绑定），拖动时 `z.tx/z.ty = 起始 + (client - 起始)` 更新 transform（与缩放共用同一 translate+scale 状态，不冲突）。CSS cursor:grab 提示可拖。`openPreview` 重置 pvDrag。
    - **验证**：圆角 0px、vbody overflow hidden、cursor grab ✓；滚轮放大 scale 1.52 → 拖动(+80,+40) → translate x/y 各增 80/40、scale 不变 ✓；小图（bg.jpg 小于窗体）按住拖动 transform 保持清空（不可拖）✓；缩小回 1 transform 清空 ✓。
  - **桌面端图片预览滚轮缩放（用户「滚轮以鼠标位置为中心放大缩小」）**：图片预览 img 绑 `@wheel=${zoomPreview}`。**关键：不用 transform-origin 百分比（连续缩放累积漂移），用 `translate(tx,ty)+scale(s)` 以鼠标为锚点**——记初始 rect(bx/by)，`px=(clientX-bx-tx)/s` 反推图像坐标，再 `tx'=clientX-bx-px*s'` 重算，鼠标下像素不动（无漂移）。factor=1.15、clamp 1~8；scale 回 1 清空 transform（防 translate 残留）；openPreview 重置 pvZoom。CSS：`.vbody.pv-img`（图片预览专用）`margin:auto` 居中 + `will-change`、`user-select:none`。验证：滚轮放大 scale 1.15/1.32 ✓、缩小回 1 transform 清空 ✓。移动端无滚轮不受影响；video/audio/code 不绑 wheel。
  - **CSS 拆出独立文件（用户「CSS 混在 ts 里，做好拆分」）**：`packages/web/src/app.ts` 里 `static styles = css\`...\`` 内嵌约 200 行 CSS，拆到 **`packages/web/src/app.css`** 独立文件；`app.ts` 改为 `import appCss from "./app.css?inline"` + `static styles = unsafeCSS(appCss)`（lit 的 `unsafeCSS` 把字符串包成 CSSResult，shadow root 用 adoptedStyleSheets 注入）。web tsconfig 已含 `types: ["vite/client"]` 支持 `?inline`。**验证**：构建 94 modules（多 CSS）、bundle 92.38 kB；reload 后 header/上传区/卡片/波形齐全，样式生效（header 边框 rgb(221,227,231)=--line、upload sticky）✓。以后改样式直接改 app.css 即可。**用户决策：不转 SCSS，保持纯 CSS。**
- **技术栈**：前端 `lit (Web Components)` + `Vite`；服务端 `Express + ws`（首版，传输层已抽象、可后切 Fastify/Socket.IO）；数据库 `better-sqlite3` + `Store` 接口抽象；协议 `zod` schema 校验。
- **运行时**：Node 18。
- **分发形态**：保持 `pkg` 打 exe + 网页。
- **命名**：正式更名为 **filesyncEX**（版本跳至 6.0.0 起步）。
- **UI 风格**：延续 pico `cyan` + miku 配色（`#047878` 主 / `#86cecb` 薄荷 / `#e12885` 强调），等宽字体 + 思源宋体，桌面与移动端**布局统一、视觉一致**；移动端在统一风格下**重做交互布局**。
- **安全**：首版不做鉴权（保持局域网开放）。
- **测试**：首版暂不写，重构跑通后补。

### v6.0 首版功能范围
- [ ] 粘贴图片（旧 TODO#5）
- [ ] 移动端 UI 重做（旧 TODO#12）
- [ ] 大文件分片 / 断点续传
- [ ] 拖拽 / 批量上传
- [ ] 多实例端口冲突修复（旧 TODO#11，用唯一实例锁替代裸 +10）
- [ ] 设备身份（默认按设备指纹自动生成，可改名）
- [ ] 保留 QuickSendTool 集成
- [ ] 剪贴板同步：不做；鉴权：不做

### 工程约束
- 旧工程 `filesync/` 仅用于**查看参考**，**不允许被引用 / 复制 / import**。
- 新工程在根目录 `g:\filesyncEX` **从零搭建**。
- 所有改动必须在此日志中登记。

### 进度
- [x] 查看旧工程 UI（仅查看）：pico cyan + miku 配色、居中布局、上传表单 + 消息列表 + 左侧浮动按钮（run/qrcode/theme）、dialog 弹窗、light/dark 主题。桌面与移动端样式现为同一套（重做空间大）。
- [x] 建立本操作日志。
- [x] 设计网页端（桌面）原型 → `docs/prototype/desktop.html`
- [x] 设计移动端原型 → `docs/prototype/mobile.html`
- [x] 原型浏览器预览验证（桌面：预览/二维码/删除确认/拖拽高亮/主题切换 均通过；移动：附件面板/上传进度/全屏预览/主题切换 均通过）
- [ ] 搭建 monorepo 骨架（protocol / core / server / web / shell）

### 本轮改动（2026-08-05 · 原型设计）
- 新增 `docs/prototype/desktop.html`：桌面端高保真原型（自包含 HTML/CSS/JS，零依赖）。
  - 顶部 Header（logo / 连接状态 / 二维码 / 主题）+ 上传区（拖拽高亮 + 文本输入 + 发送）
  - 上传队列卡片（大文件分片进度 58%→99% 动画、暂停/继续、速度与剩余时间）
  - 消息列表（文本气泡 / 文件卡片 / 图片卡片 / 音频卡片 / 多设备来源），时间线分组
  - 左下浮动按钮组（run / qrcode / theme，延续旧版交互）+ 预览 / 删除确认 / 二维码弹窗 + Toast
- 新增 `docs/prototype/mobile.html`：移动端重做原型（触屏布局，视觉与桌面端统一）。
  - 顶部 Header（收纳 连接状态 / 二维码 / 主题）+ 消息列表（大点击区）
  - 底部固定输入条（附件 + 文本 + 发送），附件面板为底部 Sheet（相册 / 拍照 / 文件 / 粘贴图片）
  - 上传进度 Sheet（分片/断点续传、暂停/继续）+ 全屏预览（图片/音频/文件）+ Toast
  - 适配安全区 env(safe-area-inset)
- 设计语言（两端口径一致）：CSS 变量主题，light/dark 切换；主色 `#047878` / 薄荷 `#86cecb` / 强调 `#e12885`；等宽字体 + 思源宋体；圆角卡片风格。

### 本轮改动（2026-08-05 · 原型迭代 #2，基于用户反馈）
- **上传区压缩**（`docs/prototype/desktop.html`）：去掉大块拖拽区，收敛为一行 `[📎 文件] [文本/拖拽输入] [发送]`，整行承载拖拽高亮。
- **消除主题切换重复**：仅保留 Header 右上角主题按钮（与移动端一致），移除左下浮动按钮组中的主题按钮（现仅剩 运行 / 扫码连接）。
- 对应更新 JS 绑定（文件按钮触发上传队列、拖拽事件迁移到新容器）。
- 浏览器验证通过：文件按钮→队列、拖拽高亮/取消、fab 数=2、主题按钮唯一。

### 设备身份方案（方案A，已确认）
- **目标**：多端同步时可辨识"哪台设备发的"，UI 展示设备名 + 头像色。
- **字段**：`MsgData` 增加 `sender` 嵌套对象 `{ deviceId, deviceName, color, platform }`，随 ADD/FULL 广播。
- **设备指纹（默认自动生成，客户端浏览器侧）**：
  - 信号：`userAgent + language + platform + screen(宽/高/色深) + timezoneOffset + hardwareConcurrency(+ deviceMemory)`
  - 算法：组合字符串 → FNV-1a 32bit hash → hex（8 位）作为 `deviceId`
  - 持久化：`localStorage`，刷新/重启不变
  - 隐私说明：指纹仅用于本地生成稳定 ID，**不采集、不上传原始信号**，只传 hash 结果
- **默认设备名**：`{平台名}-{deviceId 前 4 位}`（如 `Windows-3a2f`、`Android-9c1e`），可在设置中改名并持久化。
- **头像色**：miku 调色板（#047878/#137a7f/#e12885/#86cecb/#525658/#4a90d9…）按 deviceId hash 取模选择。
- **服务端职责**：仅透传并存储 `sender` 字段，不改动生成逻辑。
- **当前设备标识**：列表中对本机消息标注"本机"徽标。

### 本轮改动（2026-08-05 · 设备身份接入原型）
- 两个原型（`docs/prototype/desktop.html` / `mobile.html`）均已接入设备身份展示与轻量设备指纹生成（演示级实现）：
  - 消息头从示意昵称（NoRain / 手机·Pixel 8）改为设备身份：设备名 + 设备色头像 + 本机消息「本机」徽标；其它设备示例为 `Android-9c1e · Pixel 8`。
  - 桌面端 Header 新增「本机」设备 chip（色点 + 设备名，点击打开设备设置弹窗）；移动端 Header 设备 chip 点击弹出设备设置 Sheet。
  - 设备设置弹窗/Sheet：展示设备指纹（只读 hash）、设备名输入框、保存（写入 localStorage）。
  - 设备指纹实现：`UA + language + platform + screen + timezoneOffset + hardwareConcurrency + deviceMemory` → FNV-1a 32bit → 8 位 hex；localStorage 持久化；默认设备名 `{平台}-{id前4位}`；头像色从 miku 色板按 hash 取模。
- 浏览器验证通过（桌面端 evaluate click 全部正常；移动端真实鼠标点击验证）：
  - 桌面：弹窗打开、指纹 `1a46f4cc`、头像色 `#e12885`、改名→chip/消息头/头像/localStorage 全联动 ✓
  - 移动：真实点击打开设备 Sheet、改名→chip/消息头/头像/颜色/指纹全联动 ✓
- 说明：调试环境对合成 click 事件派发不可靠（已用真实鼠标点击/直接调用 handler 验证，非原型缺陷）；`file://` 下 localStorage 共享仅为调试环境现象，真实部署按 http origin 隔离。

### 本轮改动（2026-08-05 · 默认昵称用户-XXXX + 设置面板）
- **默认昵称统一为 `用户-XXXX`（四位数字）**：`loadDevice` 生成逻辑改为 `"用户-" + (fnv1a(id) % 10000 补零4位)`，如 `用户-9714`；头像显示昵称去掉前缀后的首字符（数字）；平台信息保留在 `sender.platform` 字段，不再进默认昵称。
- **Header 新增设置角标（齿轮）**：桌面端在 Header 右侧、移动端在 Header（chip 与二维码之间）各加 `btnSettings`，打开设置面板。
- **设置面板（桌面弹窗 `dlgSettings` / 移动 Sheet `sheetSettings`）**三个区块：
  - 设备身份：默认昵称说明（用户-XXXX + 设备指纹）、昵称输入框（保存写入 localStorage）、指纹只读展示
  - 工具：下载 QuickSendTool 按钮（`/tool/QuickSendTool.exe`）
  - 关于：跳转项目主页 GitHub（`https://github.com/NoRainLand/filesyncEX`）
- **移动端 Sheet 健壮性**：加 `max-height:88dvh; overflow-y:auto`（设置内容较长时可滚动）；"点空白关闭"handler 排除 `#btnSettings`（修复点击齿轮被误判为点空白而关闭）。
- 浏览器验证：桌面端完整通过（齿轮→设置弹窗、下载/项目链接、默认昵称 `用户-9714`、改名全联动）；移动端设置 Sheet 结构与函数正常（`openSettingsSheet`/改名联动验证通过），移动页面的真实点击受调试环境影响未全部闭环（含 SVG 按钮的点击事件在该环境不派发，非原型缺陷）。
- 附注：`file://` 下两个原型共享 localStorage（桌面/移动互读昵称），仅为调试现象；真实部署按 http origin 隔离。

### 本轮改动（2026-08-05 · 移除桌面端重复浮动按钮）
- 根据用户反馈，移除桌面端左下角浮动按钮组（`#fabRun` 运行 QuickSendTool、`#fabQr` 扫码连接）：其功能分别与 Header 右上角「二维码」按钮、设置面板「下载 QuickSendTool」重复。
- 删除对应 CSS（`.fab-group/.fab/.fab-tip`）、HTML 块、JS 绑定（`#fabQr/#fabRun`）。
- 浏览器验证通过：`fab` 元素 0 个、无残留引用、Header 二维码按钮正常（弹窗可开）、页面无 JS 报错。

### 本轮改动（2026-08-05 · 扩充原型消息以查看滚动效果）
- 两个原型消息从 5 条扩充到 **26 条**，用于查看上下滚动效果：
  - 多设备来源：本机（`用户-9714`，`from-me`）、`Android-9c1e · Pixel 8`、`macOS-3b7d · MacBook Pro`
  - 多日期分组：今天 / 昨天 / 08-02 周日 / 08-01 周六 / 07-30
  - 混合类型：文本气泡、文件卡片、图片卡片、音频卡片（含下载/复制/删除/预览交互）
- `renderDevice` 增加 `.from-me` 批量渲染：所有带 `from-me` class 的本机消息自动套用设备色头像与昵称（新增消息无需逐一绑定 id）。
- 浏览器验证：两端各 26 条消息、10 条本机、昵称批量渲染正确；桌面端 body 可滚动（scrollHeight 4335 / 视口 953），移动端 main 内滚动（6231 / 838），均可滚动到底部。

### 本轮改动（2026-08-05 · 移动端图片预览手势）
- 移动端图片全屏预览新增交互（此前无）：
  - **双指捏合缩放**（1x–5x，`touchstart/touchmove/touchend` 计算两指距离比值，`#pvImg` 加 `touch-action:none`）
  - **单指拖动平移**（缩放后可移动图片）
  - **双击放大/复位**（1x ↔ 2x）
  - **点击空白处关闭**（点击图片四周空白区域即关闭，图片本体点击不关闭；保留 ✕ 与底部按钮）
  - 关闭时重置缩放/平移状态；`vbody` 加 `overflow:hidden` 防止缩放图片溢出盖住上下栏
- 浏览器验证：双指捏合**实测生效**（touch 事件派发正常，`scale(2.4)`）；双击放大与点击空白关闭逻辑正确（函数/绑定已验证），但该调试环境不派发 click/dblclick 事件（标记 listener 证实 `vbodyClicked=0`），真实浏览器标准行为正常。

### 本轮改动（2026-08-05 · 连接信息入设置 / 移动端去工具下载）
- **连接状态 + 服务器地址移入设置**：
  - 桌面端：Header 移除 `已连接 · ws://…` 状态文本（`#status`），改在设置弹窗顶部新增「连接」区块（状态指示灯 + `已连接（局域网）` + HTTP `http://192.168.1.8:4100` + WebSocket `ws://192.168.1.8:4200`）。
  - 移动端：设置 Sheet 顶部新增「连接」区块（同上，状态 + HTTP/WS 地址）。
- **移动端移除 QuickSendTool 下载**：设置 Sheet 中「工具」区块（`/tool/QuickSendTool.exe` 下载入口）整块删除；桌面端设置中保留该下载入口。
- 浏览器验证：桌面 Header 无状态文本、设置含连接区块；移动端设置含连接区块、无工具下载/无工具区块。

### 本轮改动（2026-08-05 · 移除桌面端 Header 用户显示）
- 移除桌面端 Header 顶部的「本机：用户-XXXX」用户显示 chip（`#deviceChip`），Header 仅保留 logo + 二维码/主题/设置三个图标按钮（logo 加 `margin-right:auto` 让图标靠右）。
- 同步修正 `renderDevice`（删除对已移除元素的引用，避免空引用报错）；`.device-chip` CSS 保留未复用（无害）。
- 用户昵称入口与展示调整：Header 不再显示，昵称修改仍通过 Header 齿轮（设置弹窗），消息列表本机消息头部继续展示设备身份（`用户-9714` + 头像数字）。
- 浏览器验证：Header 无 chip、消息头设备身份正常渲染、设置弹窗可开。

### 本轮改动（2026-08-05 · 移除移动端 Header 用户显示）
- 按反馈同步移除移动端 Header 顶部的「本机昵称」chip（`#deviceChip`），Header 仅保留 logo + 二维码/主题/设置三个图标按钮（logo 加 `margin-right:auto` 让图标靠右）。
- 同步修正 `renderDevice`（删除对已移除元素的引用）；昵称修改仍通过 Header 齿轮（设置 Sheet）。
- 浏览器验证：两端 Header 均无用户显示；消息头设备身份（`用户-9714` + 头像数字）正常渲染；设置入口可用。

### 本轮改动（2026-08-05 · 连接状态指示灯）
- 将两端 logo 前的圆点升级为**连接状态指示灯**，并暴露全局 `setConnStatus(status)`：
  - `connected`（绿 `#2ecc71`）：已连接 / 链接正常
  - `disconnected`（红 `#e74c3c`）：链接断开
  - `connecting`（黄 `#f1c40f` + `connPulse` 闪烁动画）：正在连接
  - 颜色带 `transition: .25s` 平滑过渡
- 原型演示：页面加载先 `connecting`（黄）→ 1.5s 后 `connected`（绿）；可在控制台调用 `window.setConnStatus('disconnected')` 模拟断开。
- 浏览器验证（等过渡完成后）：红/黄/绿三态背景色与 class 均正确，`connecting` 时动画生效。

### 本轮改动（2026-08-05 · 复制按钮：文本 + 图片预览）
- **文本消息默认加「📋 复制」按钮**（两端）：JS 批量给每条文本气泡（`.msg .bubble`）在消息头部注入 `.copy-text` 按钮，点击复制文本到剪贴板（`navigator.clipboard.writeText`，受限时提示）。
- **图片预览加「复制图片」按钮**：
  - 桌面端：预览弹窗在图片模式下底部显示「复制图片」，其他模式仅「关闭」。
  - 移动端：全屏预览底部新增「复制」按钮，仅图片模式显示（音频/文件隐藏）。
  - 复制实现：`fetch(src) → blob → navigator.clipboard.write([ClipboardItem{image/png}])`，浏览器受限时兜底提示（真实部署 http 下可用）。
- 浏览器验证：两端文本消息 13/13 有复制按钮；桌面图片预览底部含复制；移动端图片模式显示「复制」、音频模式隐藏；复制相关函数存在。

### 本轮改动（2026-08-05 · 绿点呼吸 / 图片复制移出预览）
- **连接正常（绿）也加呼吸动画**：`.logo .dot.connected` 增加 `connPulse`（2s）呼吸，与「连接中」的黄灯闪烁呼应。
- **图片复制按钮移出预览**：按反馈移除桌面预览弹窗的「复制图片」按钮、移动端全屏预览底部的「复制」按钮（`btnCopyImg`/`copyPreviewImage`/`copyViewerImage` 及相关代码一并清除）。
- **图片复制入口改到图片消息卡片**：两端所有 `.card.img` 操作栏（桌面 `.imgops` / 移动 `.ops`）默认追加「复制」按钮（JS 批量注入，原型演示提示，正式版复制图片到剪贴板）。
- 浏览器验证：两端绿点 `connPulse 2s`；图片卡片 4/4 有复制按钮；预览弹窗/全屏预览内无复制按钮；残留函数已清除。

### 本轮改动（2026-08-05 · 桌面端媒体全屏预览 + 图片滚轮缩放）
- 桌面端图片/视频/音频预览由小弹窗改为**全屏预览**（`.fullviewer` 全屏覆盖层，顶部标题/✕、底部下载/删除），与移动端全屏查看器口径统一；文件信息仍用弹窗。
- **图片全屏支持鼠标滚轮缩放**（1x–5x，`wheel` 事件）、拖拽平移（mousedown/mousemove/mouseup）、双击放大/复位；关闭时重置。
- 视频预览：全屏 `<video controls>`；新增一条视频消息卡片（`card.video`，Android 手机发的演示视频）供预览。
- 预览入口 `openPreview`：`img/audio/video` → 全屏；`file` → 弹窗。
- 浏览器验证：图片/视频全屏打开；滚轮缩放 `scale 1 → 1.12 → 1`；全屏关闭；文件走弹窗；视频卡片存在。

### 本轮改动（2026-08-05 · 桌面端消息统一布局）
- 桌面端所有消息统一为「上=主体内容，下=操作按钮行」（`.msg .ops`），JS 批量重建：
  - 文本：复制 / 删除
  - 文件：下载 / 复制 / 删除
  - 图片：**预览 / 下载 / 删除**（去掉复制）
  - 音频 / 视频：播放 / 下载 / 删除
- **默认所有消息含删除按钮**（27 条全部）。
- 图片消息：点击缩略图（上部分）直接预览（保留）；操作行含预览/下载/删除。
- 移除卡片内旧操作行（`.card .ops` / `.imgops`）与旧的头部复制按钮注入，统一为下方操作行。
- 浏览器验证：27/27 有操作行且含删除；图片操作为预览/下载/删除；卡片内旧操作行 0；缩略图点击预览正常。

### 本轮改动（2026-08-05 · 桌面端消息布局回归一体式）
- 按反馈修正上轮"上下割裂"问题：操作行与主体**融为一体**——
  - 卡片消息（文件/图片/音频/视频）：操作行放回**卡片内部底部**（`.card .ops`），卡片整体一体。
  - 文本消息：操作行**紧贴气泡下方**（`.msg .ops`，间距收窄至 4px）。
- 保留统一能力：默认所有消息含删除；图片操作 = 预览/下载/删除；点缩略图直接预览。
- 浏览器验证：14 条卡片消息操作行在卡片内、13 条文本消息操作行贴气泡下、图片操作为预览/下载/删除、27/27 含删除。

### 本轮改动（2026-08-05 · 桌面端所有消息统一为一体式卡片）
- 按反馈"包括文本都是，把所有消息重新整理"：**全部 27 条消息（含文本）统一为一体式卡片**，不再有"文本=气泡+悬空操作行 / 卡片=操作行在卡内"两种形态——
  - 统一结构：`.msg > .body > .card > 主体 + .ops`（操作行一律在卡片内部底部）。
  - **文本消息**也包进 `.card.text`：文本内容为卡片主体，操作行（复制/删除）在卡片内底部，与文件/图片/音频/视频卡片完全一致。
  - 卡片内操作行间距统一为 `padding:10px 14px 12px`。
- 浏览器验证：27/27 消息全部为卡片、操作行全部在卡片内、全部含删除；其中文本卡片 13 条（复制/删除）、from-me 文本卡片 6 条正常。

### 本轮改动（2026-08-05 · 删除按钮统一为消息右上角垃圾桶角标）
- 按反馈"所有删除按钮统一到该条消息右上角的一个小垃圾桶角标"：两端原型同步调整——
  - **桌面端**（`desktop.html`）：统一注入逻辑不再生成"删除"文字按钮，改为给每条消息卡片右上角添加 `.del-corner`（垃圾桶 SVG 角标，绝对定位 top:8px right:8px，hover 变粉），点击触发原删除确认弹窗；底部操作行仅保留 复制/下载/预览/播放。
  - **移动端**（`mobile.html`）：移除 6 处硬编码的"删除"按钮（`.ops` 内），CSS 新增 `.card` 相对定位 + `.del-corner` 样式，JS 统一给全部 13 张卡片注入删除角标（点击 flash 提示）。
  - 角标小图标：垃圾桶线性 SVG（stroke 1.5），桌面 26px / 移动 28px 圆形圆角按钮。
- 浏览器验证：桌面 27/27 卡片有删除角标、底部操作行无"删除"、点击角标弹出删除确认；移动 13/13 卡片有删除角标、无残留删除按钮。

### 本轮改动（2026-08-05 · 消息操作按钮精简 + 文本截断 + 媒体文件名/大小）
- 按反馈四项调整，两端原型同步：
  1. **文本消息最大高度**：定 **4 行**，超出省略号（`-webkit-line-clamp:4`），两端气泡统一；复制按钮仍取完整文本（读取 textContent 不受截断影响）。
  2. **图片消息操作按钮只有"复制"**（删除已移至右上角角标，不算操作按钮）：桌面 JS 注入、移动静态 ops 均只保留"复制"；预览仍可点缩略图。
  3. **音频/视频消息操作按钮只有"下载"**：桌面 JS 注入 audio/video 只加"下载"；移动音频 ops 只留"下载"（移动端无视频示例）。
  4. **图片/视频消息显示文件名 + 文件大小**：新增 `.card .mm` 信息行（文件名 ellipsis 缩略 + 大小），位于缩略图底部、操作行上方；桌面 5 处（4 图 1 视频）、移动 4 张图片均加。
- 浏览器验证：桌面 文本 clamp=4、图片 ops=复制×4、音频=下载×2、视频=下载×1、mm 行 5 处；移动 图片 ops=复制×4、音频=下载×2、mm 行 4 处、文本 clamp=4、复制按钮 13 个仍在。

### 本轮改动（2026-08-05 · 音频信息统一为 .mm 行 + 视频加时长）
- 按反馈两项调整，两端原型同步：
  1. **音频卡片文件信息统一**：原先音频的文件名/大小显示在播放条（`.ap .meta`）内，现改为与图片/视频一致的 `.mm` 信息行（播放条/波形下方、操作行上方），显示 文件名（缩略）+ `3:42 · 2.1 MB`；播放条仅保留 播放按钮 + 波形。
  2. **视频卡片加时长**：视频 `.mm` 行由 `文件名 + 48.2 MB` 改为 `文件名 + 2:15 · 48.2 MB`（时长在前）。
- 浏览器验证：桌面 音频 .mm 行 2 处（无残留 .ap .meta）、视频 .mm=「产品演示…mp4 2:15 · 48.2 MB」；移动 音频 .mm 行 2 处。

### 本轮改动（2026-08-05 · 未知消息类型操作按钮只有下载）
- 按反馈：**未知消息类型**（除文字/图片/音频/视频外的消息，即文件及其它类型）操作按钮只有"下载"——
  - 桌面端（`desktop.html`）：JS 注入 `file` 分支移除"复制"，仅保留"下载"（未知类型兜底）。
  - 移动端（`mobile.html`）：移除 3 处文件卡片操作行中的"复制"按钮，仅留"下载"。
- 操作按钮总规约：文本=复制 / 图片=复制 / 音频=下载 / 视频=下载 / 未知(文件等)=下载；删除统一在右上角垃圾桶角标。
- 浏览器验证：桌面 file 卡片 ops 全为"下载"（7 处）；移动 file 卡片 ops 全为"下载"（7 处）。

### 本轮改动（2026-08-05 · 图片/视频文件信息改为覆盖在缩略图底部）
- 按反馈：图片/视频的文件名+大小**不再作为独立信息行放在操作按钮上方**，而是**覆盖在缩略图（消息上半部分）底部**——白色文字 + 黑色半透明渐变背景（`linear-gradient(transparent, rgba(0,0,0,.68))`），保证浅色图片上文字也清晰。
  - 桌面端（`desktop.html`）：`.card.img .mm` / `.card.video .mm` 改为 absolute 定位在 thumb/vthumb 底部（白字、黑渐变）；4 张图片 + 1 个视频的 `.mm` 移入缩略图内部。
  - 移动端（`mobile.html`）：`.card.img .mm` 同样覆盖式；4 张图片的 `.mm` 移入 thumb 内。
  - **音频**无缩略图：保留独立信息行（`.card.audio .mm` 为 static，播放条下方）。
- 浏览器验证：桌面 图片 .mm×4 / 视频 .mm×1 均 absolute+白字+黑渐变、音频 .mm×2 static；移动 图片 .mm×4 均 absolute+白字。

### 本轮改动（2026-08-05 · 图片/视频消息上下两部分合并为一部分）
- 按反馈"再次全部统一操作逻辑，图片/视频上下两部分合并为一部分，操作按钮下面是半透明渐变黑色"：
  - **图片/视频消息整卡 = 缩略图**，不再有"缩略图 + 下方独立操作行"两段式。
  - 底部统一为**半透明渐变黑覆盖层**（`.ovl`，`linear-gradient(transparent, rgba(0,0,0,.7))`），层内自上而下：
    1. 文件名 + 大小（`.mm`，白字）
    2. 操作按钮行（`.ops`，白字按钮）
  - 桌面端：JS 统一注入将 img/video 的 `.ops` 放进缩略图内 `.ovl`（`.mm` 也移入），清理重复 CSS；4 图 + 1 视频。
  - 移动端：4 张图片卡片的 `.mm`+`.ops` 均移入缩略图内 `.ovl`。
  - **音频/文本/文件**不受影响：音频 `.mm` 独立行（static）、文本/文件 ops 仍在卡片底部。
- 浏览器验证：桌面 图片/视频 .ovl 内含 .mm+.ops、卡片底部无残留操作行、图片复制按钮可用、音频 .mm static、文本/文件 ops 在卡片底；移动 4 张图片 .ovl 内含 .mm+.ops、复制按钮可用。

### 本轮改动（2026-08-05 · 移除图片/视频缩略图中间的文字占位块）
- 按反馈"图片/视频中间那个玩意去掉"：移除缩略图（`.thumb`/`.vthumb`）中间的渐变占位文字块（如"🖼 图片缩略图（点击预览）""▶ 视频缩略图（点击全屏播放）""🖼 手机拍的照片"等），渐变背景改到 `.thumb`/`.vthumb` 本身作为图片占位——
  - 桌面端：4 张图片（渐变改到 thumb 内联背景）+ 1 个视频（纯黑背景）。
  - 移动端：4 张图片的 thumb 内占位文字移除（保留渐变背景）。
- 浏览器验证：桌面 图片/视频缩略图内占位元素 0、移动 4 张图片占位 0（无 emoji、无中间文字）。

### 本轮改动（2026-08-05 · 图片/视频缩略图中间加提示图标）
- 按反馈给缩略图中间加图标，提示可全屏操作（用 CSS `::after` + SVG data URI 实现，两端统一）：
  - **视频**：缩略图中间圆形半透明黑底 + 白色**播放三角**图标（56px），提示可点击全屏播放。
  - **图片**：缩略图中间圆形半透明黑底 + 白色**放大镜**图标（52px，放大镜带 +/- ），提示可点击全屏预览。
  - 桌面端图片/视频、移动端图片均生效；图标 `pointer-events:none` 不影响点击预览。
- 浏览器验证：桌面 图片/视频 ::after 图标背景已加载、点缩略图仍能打开全屏预览；移动 图片 ::after 图标已加载。

### 本轮改动（2026-08-05 · 音频消息支持播放/暂停 + 拖动波形选进度）
- 按反馈实现音频交互（两端同步）：
  - **点播放按钮 ▶ → 直接播放**（按钮变 ⏸、卡片粉色高亮 `playing` 态）；**再点 → 暂停**。
  - **拖动波形图选进度**：`.wave` 支持鼠标/触摸按下拖动 seek，进度条（`.prog` 半透明粉色 overlay）实时反映播放位置。
  - 原型用 Web Audio API 合成 30s 测试音频演示（真实实现由服务器提供音频文件 + ffmpeg 波形数据）。
  - 移动端移除播放按钮 `onclick="openViewer('audio')"`（避免打开预览 sheet 与直接播放冲突）。
- 浏览器验证：桌面 播放→⏸+进度增长、拖动 50%→进度 50.26%、再点→▶ 停止；移动 播放→⏸、拖动 50%→50.31%、再点→▶，且不再打开预览 sheet。

### 本轮改动（2026-08-05 · 音频波形改为真实音频波形效果）
- 按反馈"波形图不像真实音频"：将原来手写随机高度的稀疏柱条，改为**模拟真实音频波形**的生成逻辑（两端统一，JS 动态渲染）——
  - 60 根柱条，**高斯包络**（峰值在 ~55% 位置、两侧对称渐低）+ **平滑随机**（相邻柱条连续），近似真实音频响度包络。
  - 保留 `.prog` 播放进度条（重建柱条后重新挂载）。
  - 真实实现由服务器 ffmpeg 生成波形数据数组，前端渲染逻辑一致。
- 浏览器验证：桌面/移动 波形柱 60 根、峰值在中部（idx 29）、进度条保留。

### 本轮改动（2026-08-05 · 播放进度改为已播放波形柱变灰）
- 按反馈"播放之后波形图条的变成灰色"：将播放进度显示方式从"半透明粉色 overlay 覆盖全波形"改为**已播放的波形柱条变灰**（微信语音式进度）——
  - 新增 `paintProgress(card, pct)`：按进度给前 `pct%` 的柱条加 `.played` 类（灰色），未播放保持薄荷色。
  - `updateProgress`（播放中每 100ms）/ `seek`（拖动）/ `playCard`（开始）/ `stopAudio(true)`（播完归零）统一用该函数；暂停保留灰色进度。
  - 移除 `.prog` overlay 相关逻辑与样式（桌面/移动两端同步）。
  - CSS：`.wave i.played{background:var(--muted)}`（桌面 opacity:1、移动原色）。
- 浏览器验证：桌面 播放 0.5s→3 根变灰、seek 40%→25/60 变灰、暂停保留、无 .prog；移动 播放→变灰、seek 35%→22/60、无 .prog。

### 本轮改动（2026-08-05 · 波形加细黑进度指示竖线）
- 按反馈"加一个细细黑色条作为指示器，更明确看到当前进度"：在波形上叠加 **2px 黑色细竖线**（`.wave .ind`，全高、绝对定位、`pointer-events:none`）——
  - 随播放进度移动（`paintProgress` 同步更新 `left`），与"已播放柱条变灰"互补：灰色=已播放区域，黑线=当前精确播放位置。
  - 桌面/移动两端同步；renderWaveforms 重建柱条时一并插入 `.ind`。
- 浏览器验证：桌面/移动 指示竖线 2px 黑色、seek 40%→竖线在 ~40.9%、暂停后保留位置。

### 本轮改动（2026-08-05 · 指示条仅播放显示 + 波形缩短避开删除角标）
- 按反馈两项修正（两端同步）：
  1. **未播放不显示指示竖线**：`.ind` 默认 `opacity:0`；JS `paintProgress` 直接控制 `ind.style.opacity`（进度>0 → 0.85 显示，进度归零 → 0 隐藏），暂停保留显示；不依赖 CSS 类切换（移动端 computed 异常故改用 JS 内联控制）。
  2. **波形与删除角标重叠**：`.card.audio .ap` 右侧留出 42px 空间（`padding:12px 42px 12px 14px`），波形缩短避开右上角删除角标。
- 浏览器验证：桌面/移动 未播放指示线 opacity 0、播放中 0.85、seek 40% 竖线在 ~41%；桌面 波形右 778 < 删除角标左 786、移动 1210 < 1216，均无重叠。

### 本轮改动（2026-08-06 · 消息时间显示补全年月日时分秒）
- 按反馈"时间显示更详细，具体到年月日时分秒"：新增 `formatTimes()` JS 遍历消息，根据每条消息前的 `.day` 分组日期解析，结合 time 文本（"HH:mm" 或 "昨天 HH:mm"）生成完整 `YYYY/MM/DD HH:mm:ss`——
  - 年份取 day 中的（如 `今天 · 2026/08/05`→2026）；`08/02 · 周日` 等无年份的按 2026。
  - "昨天 HH:mm" 自动按 day 日期 -1 天（如桌面"更早"下的 `昨天 22:04` → `2026/08/04 22:04:xx`）。
  - 秒数为确定性伪随机（`(idx*37+11)%60`），刷新一致。
  - 桌面/移动两端同步。
- 浏览器验证：桌面 27/27、移动 26/26 条时间均为 `YYYY/MM/DD HH:mm:ss` 完整格式。

### 本轮改动（2026-08-06 · 所有头像统一主体色）
- 按反馈"所有头像统一配色，为网页主体色"：CSS 增加 `.msg .avatar{background:var(--primary) !important}`（桌面/移动两端），覆盖 HTML 中其它设备头像的内联背景色（`#137a7f`/`#4a90d9` 等），全部头像统一为**主体色 `#047878`**（青色）。
- 浏览器验证：桌面 27/27、移动 26/26 头像背景均为 `rgb(4,120,120)`（#047878）。

### 本轮改动（2026-08-06 · 新增代码模式：One Dark 代码消息）
- **需求**：发送/展示代码消息，采用 One Dark 配色语法高亮。
- **输入侧（桌面 + 移动）**：
  - 输入条新增花括号按钮 `#btnBrace`（`{}`），点击切换代码编辑器 `.code-editor`（on 态主色填充）。
  - 代码编辑器：顶部语言选择 `#codeLang`（TypeScript/JavaScript/Python/INI/Batch/JSON/SQL/HTML/CSS）+ `#codeInput` textarea（One Dark `#282c34` 深色底）。
  - `send()` 改造：代码模式下读 `#codeInput` + `#codeLang`，空内容提示"请输入代码内容"，否则清空并 flash"（原型）代码已发送：<lang>"。
- **消息渲染侧**：
  - 新增 `.card.code` 卡片：One Dark 深色底 `#282c34`、顶部 `.code-head` 语言标签（蓝 `#61afef`）+ 三个窗口圆点、`.code-body` 白字 `pre` 保持格式、等宽字体。
  - 新增轻量正则版语法高亮器：`HIGHLIGHT_LANGS`（各语言正则）、`HIGHLIGHT_GROUPS`（捕获组→token 名）、`TOKEN_CLASS`（token→类名）、`highlightCode(code,lang)`、`esc(s)` 转义；One Dark token 类 `.tok-kw`(紫 `#c678dd`)/`.tok-str`(绿 `#98c379`)/`.tok-num`(橙 `#d19a66`)/`.tok-fn`(蓝 `#61afef`)/`.tok-com`(灰 `#5c6370` 斜体)/`.tok-typ`(黄 `#e5c07b`)/`.tok-var`(红 `#e06c75`)/`.tok-prop`/`.tok-attr`/`.tok-op`。
  - 桌面端消息注入逻辑 kind 判断新增 `code` 类型；操作按钮=**复制**（复制代码原文到剪贴板）；删除角标同其它卡片。
  - 移动端同样注入删除角标 + 复制按钮。
- **示例消息**：桌面加一条 TypeScript（`interface Device` + FNV-1a 指纹生成），移动加一条 INI/Config（`[server]`/`[sync]` 配置）。
- **浏览器验证**：
  - 桌面：`.card.code` 高亮渲染成功（`tok-kw`/`tok-str`/`tok-fn`/`tok-com` 均生成）；花括号切换开/关正常；代码模式发送 flash"（原型）代码已发送：ts"并清空输入。
  - 移动：ini 高亮（`[server]`→`tok-typ`、key→`tok-prop`、注释→`tok-com`）；花括号切换 + 代码发送（python）均正常；删除角标 + 复制按钮注入成功。

### 本轮改动（2026-08-06 · 媒体预览优化：屏蔽滚轮穿透 + 点击空白退出）
- **需求**：图片预览 / 视频播放时，屏蔽下层滚轮事件（防止滚动穿透消息列表）；点击空白处即可退出预览。
- **桌面端**（`docs/prototype/desktop.html`）：
  - `openFullPreview()` 打开时锁定 `document.body.style.overflow = "hidden"`（关闭时恢复），全屏期间页面不可滚动。
  - `#fullViewer` 常驻挂 `wheel` 监听（`passive:false` + `preventDefault`），彻底拦截滚轮穿透；图片滚轮缩放不受影响（缩放走 JS `fvApply()` 变换，不依赖默认滚动）。
  - `#fvBody` 点击空白（`e.target === fvBody`，即非图片/视频本身区域）→ `closeFullViewer()` 退出预览；点图片/视频本身不退出（保留拖拽/缩放/播放）。
- **移动端**（`docs/prototype/mobile.html`）：
  - `openViewer()` 打开时锁定 `main` 滚动（`overflow:hidden`），关闭时恢复。
  - `#viewer` 常驻挂 `wheel` 拦截（`passive:false` + `preventDefault`）。
  - 补充 `video` 预览分支（`<video controls>`），两端视频预览能力对齐；原有"点击 `#vBody` 空白关闭"保留。
- **浏览器验证**（两端均通过）：
  - 桌面：打开图片/视频预览 → `body.overflow=hidden`、滚轮事件被 `preventDefault`、点空白关闭、关闭后 overflow 恢复。
  - 移动：打开图片/视频预览 → `main.overflow=hidden`、滚轮被拦截、点空白关闭、关闭后恢复；视频预览分支正常。 

### 本轮改动（2026-08-06 · 代码模式输入区：开启后隐藏文件按钮与输入框）
- **需求**：修正花括号按钮与输入框的视觉重叠感；开启代码模式后，隐藏文件上传按钮与原本的文本输入框。
- **桌面端**（`docs/prototype/desktop.html`）：
  - 花括号切换 JS 增加 `.upload-row.code-mode` class 切换。
  - CSS `.upload-row.code-mode #btnFile, .upload-row.code-mode #textInput{display:none}`：开启代码模式时隐藏「文件」按钮 + 文本输入框，输入区仅剩 `{}`（退出开关，on 态主色）+「发送」。
- **移动端**（`docs/prototype/mobile.html`）：
  - 花括号切换 JS 增加 `.composer.code-mode` class 切换。
  - CSS `.composer.code-mode #btnAdd, .composer.code-mode #textInput{display:none}`：开启时隐藏附件（文件上传）+ 文本输入框，仅剩 `{}` + 发送。
- **浏览器验证**（两端均通过）：开启 → 文件按钮/输入框隐藏、花括号 on、编辑器打开、发送按钮与花括号按钮仍可见；关闭 → 全部恢复显示。 

### 本轮改动（2026-08-06 · 代码模式布局重做：按钮固定右上角 + 输入框放大成代码输入框）
- **需求（推翻上一轮方案）**：花括号按钮应**压在输入框之上**，而非与发送按钮并列；开启代码模式后，输入框**放大成代码输入框**（带动画，无破绽），同时隐藏文件上传按钮；**发送按钮与花括号按钮位置恒定，均在右上角，压在代码输入框之上**。
- **桌面端**（`docs/prototype/desktop.html`）：
  - 新增 `.composer-actions`（absolute 定位 `top:10px right:12px`，z-index 5）：花括号 + 发送按钮**固定右上角**，压在输入框/代码输入框之上；输入框右侧 `padding-right:126px` 预留按钮位。
  - 代码编辑器 `.code-editor` 移入 `.upload-row`（flex:1 占内容区），平时隐藏；开启后 `display:flex` + `codeIn` 动画（`transform-origin:top center`，`scaleY(.45)→1` + 淡入），视觉上**输入框纵向放大成代码输入框**。
  - 开启代码模式（`.upload-row.code-mode`）：隐藏 `#btnFile` + `#textInput`，代码编辑器撑高 upload 区。
- **移动端**（`docs/prototype/mobile.html`）：
  - composer 改 `flex-direction:column`，新增 `.composer-inner`（附件 + 输入框），`.composer-actions`（absolute `top:50% right:0`）固定右上角；输入框 `padding-right:100px` 预留按钮位。
  - 代码编辑器改为 **absolute 覆盖在 footer 上方展开**（`bottom:100%` + `codeIn` 动画 `transform-origin:bottom center` 向上放大），**不撑高 footer → 按钮位置恒定不变**。
  - 开启（`.composer.code-mode`）：隐藏 `#btnAdd` + `#textInput`；`.composer-inner` 保持 `min-height:40px`。
- **浏览器验证**（两端均通过）：
  - 桌面：开启前/后/关闭，花括号与发送按钮坐标**完全一致**（右上角恒定）；开启后文件按钮/输入框隐藏、代码编辑器放大展开（upload 39px→197px）；关闭恢复。
  - 移动：开启前/后/关闭，按钮坐标一致（y 恒定）；代码编辑器在 footer 上方覆盖展开（footer 高度不变 58→57）；附件/输入框隐藏，关闭恢复。 

### 本轮改动（2026-08-06 · 代码模式按钮定位澄清：花括号压输入框 + 发送并列）
- **需求澄清**：默认状态下，**代码模式切换按钮（花括号）压在输入框之上**（覆盖输入框右上角区域），**发送按钮不与输入框叠加，而是与输入框并列**（输入框右侧独立按钮）。
- **桌面端**（`docs/prototype/desktop.html`）：
  - 移除 `.composer-actions` 容器；`#btnBrace` 改为 `position:absolute; top:50%; right:74px`（相对 `.upload-row`），**压在输入框/代码输入框右上角之上**；`#btnSend` 回归正常流内，**与输入框并列**（输入框右侧）。
  - 输入框 `padding-right` 调整为 `58px`（仅预留花括号位）。
- **移动端**（`docs/prototype/mobile.html`）：
  - 移除 `.composer-actions` 容器；`.composer-inner .bracebtn` 改为 `position:absolute; top:50%; right:48px`（发送圆形按钮左侧），**压在输入框右上角之上**；`#btnSend` 回归流内**与输入框并列**。
  - 输入框 `padding-right` 调整为 `56px`。
- **浏览器验证**（两端均通过）：
  - 桌面默认：花括号 `absolute` 且与输入框区域重叠（压在输入框上）；发送按钮在输入框右侧、不重叠输入框（并列）；开启代码模式后文件/输入框隐藏、代码编辑器放大（39→197px）、花括号+发送仍可见；关闭恢复。
  - 移动默认：花括号与输入框区域重叠（压输入框上）；发送按钮在输入框右侧并列；开启后附件/输入框隐藏、代码编辑器覆盖展开（99px）、花括号+发送可见；关闭恢复。 

### 本轮改动（2026-08-06 · 花括号按钮去除边框，悬浮于输入框之上）
- **需求**：代码模式按钮（花括号）**不要外边框**，表现为**悬浮在输入框之上**。
- **桌面端**（`docs/prototype/desktop.html`）：`.bracebtn` 去掉 `border:1px` + `background:var(--surface)`，改为 `border:0` + `background:transparent`；hover 仅变主色（不再有边框反馈）；on 态保留主色填充 + 白字（无边框）。
- **移动端**（`docs/prototype/mobile.html`）：`.bracebtn` 同步去掉边框与背景，透明悬浮；active 仅变主色；on 态主色填充 + 白字。
- **浏览器验证**（两端均通过）：默认状态 `border:0`、`background:transparent`（悬浮无边框）；on 态主色填充 `#047878` + 白字、无边框。 

### 本轮改动（2026-08-06 · 代码模式按钮 on 态仅变色 + 发送按钮压代码输入框）
- **需求**：①代码模式下，**发送按钮压在代码输入框之上**（右上角）；②代码模式按钮（花括号）**不要边框，on 态仅仅是花括号变色**（去掉主色填充）。
- **桌面端**（`docs/prototype/desktop.html`）：
  - `.bracebtn.on` 由主色填充改为 `background:transparent; color:var(--primary)`（仅花括号变主色）。
  - 新增 `.upload-row.code-mode #btnSend{position:absolute; top:50%; right:12px; transform:translateY(-50%); z-index:5}`：**代码模式下发送按钮压在代码输入框右上角**（与花括号 `right:74px` 并排）；默认状态发送按钮仍流内与输入框并列。
- **移动端**（`docs/prototype/mobile.html`）：
  - `.bracebtn.on` 改为 `background:transparent; color:var(--primary)`（仅变色）。
  - 新增 `.composer.code-mode .sendbtn{position:absolute; top:50%; right:0; z-index:5}`：代码模式下发送按钮固定输入行右上角。
- **浏览器验证**（两端均通过）：
  - 桌面：默认发送按钮 `static` 与输入框并列；代码模式发送按钮 `absolute` 且与代码编辑器区域重叠（压其上）、花括号 on 态透明背景 + 主色文字 + 无边框；关闭恢复。
  - 移动：默认发送按钮并列；代码模式发送按钮 `absolute`（输入行右上角）、花括号 on 态仅变主色、附件/输入框隐藏、代码编辑器覆盖展开；关闭恢复。 

### 本轮改动（2026-08-06 · 花括号与发送按钮固定在顶部，相对静止）
- **需求**：花括号与发送按钮**保持相对静止**，位置固定在**上面（顶部）**——开启代码模式后不随代码输入框高度变大而下移（此前 `top:50%` 垂直居中导致按钮下移到中部）。
- **桌面端**（`docs/prototype/desktop.html`）：
  - `#btnBrace` 由 `top:50% + translateY(-50%)` 改为 **`top:10px` 固定**（去掉 transform）：始终停在顶部右上角，压在输入框/代码输入框之上。
  - `.upload-row.code-mode #btnSend` 同样改为 **`top:10px` 固定**：代码模式下发送按钮停在顶部，与花括号并排（同 y 水平线）。
- **移动端**（`docs/prototype/mobile.html`）：
  - `.composer-inner .bracebtn` 由 `top:50%` 改为 **`top:0` 固定**。
  - `.composer.code-mode .sendbtn` 改为 **`top:0` 固定**，与花括号同 y 并排。
- **浏览器验证**（两端均通过）：
  - 桌面：花括号坐标默认/代码模式/关闭**完全一致**（(1090,124) 静止）；代码模式下发送按钮 `absolute top:10px` 与花括号同 y 并排，压在代码编辑器上、不随行高（40→197px）下移；关闭恢复流内并列。
  - 移动：花括号坐标恒定（top:0）；代码模式下发送按钮 `top:0` 与花括号同 y（905）并排静止；关闭恢复。 

### 本轮改动（2026-08-06 · 修复代码模式开关的控件错位/越界）
- **问题**（浏览器实测发现）：桌面端 `#btnBrace` 用 `top:10px`（相对 `.upload-row` 顶部）导致花括号按钮**比其他控件低 10px**、底部贴到 upload 边缘（错位）；`right:74px` 与代码模式下发送按钮 `right:12px` 冲突，导致**两按钮重叠 2px**；发送按钮 `top:10px` 也略下偏。
- **桌面端**（`docs/prototype/desktop.html`）：
  - `#btnBrace`：`top:10px` → **`top:0`**（相对 upload-row 顶部，与其他控件/ce-top 顶部对齐）；`right:74px` → **`right:84px`**（给代码模式下发送按钮让位，避免重叠）。
  - `.upload-row.code-mode #btnSend`：`top:10px` → **`top:0`**（与花括号顶部对齐）。
- **移动端**（`docs/prototype/mobile.html`）：实测无错位/越界（花括号 `top:0` 与输入框/发送对齐，不重叠），无需改动。
- **浏览器验证**（两端均通过，DOM 坐标核对）：
  - 桌面默认：花括号 (1080,114) 与其他控件顶部对齐（y 差 ≤2px）、与发送不重叠、不越界；代码模式：花括号与发送顶部对齐（y=114）、不重叠、均在 ce-top 内、不越界。
  - 移动：默认/代码模式均顶部对齐、不重叠、控件在 composer-inner 内。 

### 本轮改动（2026-08-06 · 修复代码模式开启后按钮位置漂移）
- **问题**：开启代码模式后，发送按钮从默认位置左移（`absolute right:12px` 比默认流内贴右缘缩进 12px，x 由 1138→1126），导致按钮位置"不对"、与关闭状态不一致。
- **桌面端**（`docs/prototype/desktop.html`）：`.upload-row.code-mode #btnSend` 的 `right:12px` → **`right:0`**（贴 upload-row 右缘），使代码模式下发送按钮位置与默认流内一致；花括号保持 `right:84px` 不变。
- **移动端**（`docs/prototype/mobile.html`）：发送按钮已是 `right:0`，实测无需改动。
- **浏览器验证**（两端均通过，坐标核对）：
  - 桌面：花括号默认/代码模式均 (1080,114)；发送按钮默认 (1138,115) 与代码模式 (1138,114) **x/right 完全一致**；代码模式下按钮贴 ce-top 右缘。
  - 移动：花括号 x=1346、发送 x=1394/right=1434 在默认/代码模式/关闭三态**完全一致**。 

### 本轮改动（2026-08-06 · 代码输入框去边框，与最外层边框融为一体）
- **需求**：去掉代码输入框（`.code-editor`）自己的边框，让它和最外层 `.upload` 的边框融为一体（消除嵌套双框）。
- **桌面端**（`docs/prototype/desktop.html`）：
  - `.code-editor` 去掉 `border:1px solid var(--line)`（`border:0`）。
  - 新增 `.upload-row.code-mode .code-editor{margin:-10px -12px}`：用**负 margin 抵消 `.upload` 的 padding**，让代码编辑器撑满 `.upload` 内容区（贴到最外层边框），圆角由 `.code-editor` 的 `border-radius + overflow:hidden` 呈现。
  - 注：`code-mode` class 加在 `.upload-row` 上，故选择器用 `.upload-row.code-mode`（初稿误写 `.upload.code-mode` 已修正）。
- **浏览器验证**（桌面端）：
  - 代码模式：`code-editor` 与 `.upload` 四边贴合（left/right/top/bottom 均 ≤2px）、`border:0` 无独立边框、宽 998 贴满内容区；花括号/发送按钮位置保持（x 一致）；`ce-top` 随编辑器贴顶。
  - 关闭后：upload 恢复单行高 61px、文件/输入框/发送按钮正常、代码编辑器隐藏。 

### 本轮改动（2026-08-06 · 代码黑色区下移 8px，与发送按钮拉开）
- **问题**：代码模式下黑色代码区（textarea）顶部贴语言栏底部（y≈149），而发送按钮底部（y≈151）**深入黑色区顶部约 2px**，视觉上重叠。
- **桌面端**（`docs/prototype/desktop.html`）：`.code-editor textarea` 增加 `margin-top:8px`，黑色代码区整体下移 8px。
- **浏览器验证**：黑色区顶部 y 149→157（下移 8px，`margin-top:8px`），与发送按钮底部（151）拉开 **6px 间隙**（不再重叠）；底部仍贴外层框底；代码编辑器高度相应 195→203px。 

### 本轮改动（2026-08-06 · 去掉语言栏黑线 + 空隙改语言栏同色）
- **需求**：去掉语言栏底部的黑线（`border-bottom`）；把黑色区下移露出的 8px 白色空隙改为与上方语言栏相同的颜色，使之融为一体。
- **桌面端**（`docs/prototype/desktop.html`）：
  - `.code-editor` 背景 `var(--bg)`（白）→ **`var(--surface)`**（浅灰，与语言栏同色），8px 空隙不再露白。
  - `.code-editor .ce-top` 去掉 `border-bottom:1px solid var(--line)`（黑线）；清理重复定义。
- **移动端**（`docs/prototype/mobile.html`）：`.code-editor .ce-top` 同步去掉 `border-bottom`（保持两端一致）。
- **浏览器验证**（桌面）：`.ce-top` `border-bottom:0px none`（黑线已去）；空隙区域采样色 = `rgb(246,248,250)` = 语言栏背景色，与语言栏无缝衔接；黑色代码区仍为 One Dark `rgb(40,44,52)`。 

### 本轮改动（2026-08-06 · 移动端假消息与桌面端同步）
- **需求**：删除移动端所有假消息，将桌面端假消息同步到移动端（内容一致：同一批发送者/文件/时间/消息类型）。
- **移动端**（`docs/prototype/mobile.html`）：
  - 新增**代码消息**（TypeScript，09:25，本机）——与桌面端一致（原移动端 INI 代码 10:38 移除）。
  - 新增 **`更早` 分组**（原移动端缺），并将 Android「昨天 22:04」消息移入该分组。
  - 新增**视频消息**（产品演示-20260805.mp4，10:42，Android）——移动端此前无视频消息。
  - 10:02 文本内容同步为桌面端版本（「…拖动滚动条或滚动鼠标滚轮看看效果 ✌️」）。
  - 新增 `.card.video` 卡片样式（`.vthumb` + `.ovl` 覆盖层 + 中间播放图标），与图片卡片同构；其余消息（文本/文件/图片/音频/昨天及更早分组）原已一致。
- **浏览器验证**（移动端）：消息总数 **28** 条与桌面端完全一致（文本13 / 文件7 / 图片4 / 音频2 / 代码1 / 视频1）；TypeScript 代码高亮渲染（tok-kw/tok-fn）、删除角标、复制按钮正常；视频卡片黑色缩略图 + 覆盖层正常；更早分组存在。 

### 本轮改动（2026-08-06 · 移动端移除所有消息的删除角标）
- **需求**：移动端所有类型的消息，移除删除按钮角标。
- **移动端**（`docs/prototype/mobile.html`）：
  - 删除通用注入：`document.querySelectorAll(".card").forEach(...)` 给所有卡片加 `.del-corner` 的整段逻辑。
  - 代码卡片注入中删除 `del-corner` 部分（保留复制按钮 ops）。
  - 删除 `.card .del-corner` 相关 CSS（清理死代码）。
- **浏览器验证**（移动端）：28 条消息 / 15 个卡片中 `.del-corner` 数量为 **0**；文件/图片/代码/音频/视频各类型卡片均无删除角标；代码卡片的「复制」按钮、视频卡片的「下载」按钮保留正常。 

### 本轮改动（2026-08-06 · 移动端移除文字/代码消息的复制按钮）
- **需求**：移动端删除所有**文字消息**与**代码消息**的复制角标/按钮。
- **移动端**（`docs/prototype/mobile.html`）：
  - 删除文本消息复制按钮注入：`.msg .bubble` → 在 `.head` 追加 `.copy-text`（「📋 复制」）的整段逻辑；并清理 `.copy-text` 相关 CSS。
  - 删除代码卡片复制按钮注入：`.card.code` → 追加 `.ops` 中「复制」按钮的整段逻辑（保留代码 One Dark 高亮渲染）。
- **浏览器验证**（移动端）：`.copy-text` 数量 **0**；代码卡片无 `ops`/复制按钮；代码高亮（tok-kw）仍正常；28 条消息不变。**图片消息的「复制」按钮保留**（用户未要求删除，共 4 个）。 

### 本轮改动（2026-08-06 · 移动端文字点击复制 + 代码卡片尺寸统一 + 代码全屏预览）
- **需求**：①文字消息点击直接复制；②代码消息大小与图片/视频一致、不允许左右上下滚动；③点击代码消息全屏预览。
- **移动端**（`docs/prototype/mobile.html`）：
  - **文字点击复制**：`.msg .bubble` 绑定 click → 复制文本 → flash「已复制到剪贴板」。
  - **代码卡片尺寸统一**：`.card.code` `max-width` 92%→**88%**（与图片/视频一致）；`.code-body` 由 `overflow-x:auto` → **`overflow:hidden` + `height:150px`**（固定高度、不可滚动）；右下角加「`</> 点击全屏`」提示（`::after`）。
  - **代码全屏预览**：`openViewer(kind, opt)` 新增 `code` 分支（标题「代码预览」，`.codeview` 占满查看器、可滚动查看完整代码）；`.card.code` 绑定 click → `openViewer("code", { code })`。
- **浏览器验证**（移动端）：代码卡片 `max-width:88%`、`overflow:hidden`、`height:150px`、有「点击全屏」提示；点击文字消息 flash「已复制到剪贴板」；点击代码卡片打开全屏预览（标题「代码预览」，显示完整 `interface Device…` 代码），关闭正常。 

### 本轮改动（2026-08-06 · 移动端代码卡片：底部渐变覆盖层 + 左下角复制按钮）
- **需求**：代码消息左下角添加复制按钮；并为代码消息添加图片/视频那样的**底部半透明黑色渐变过渡**。
- **移动端**（`docs/prototype/mobile.html`）：
  - 新增 `.card.code .code-ovl` 覆盖层（absolute 底部，`linear-gradient(transparent, rgba(0,0,0,.7))` 半透明黑渐变，与图片/视频 `.ovl` 一致）；内含**左下角「复制」按钮**（点击复制代码，`stopPropagation` 不触发全屏预览）+ **右上角「</> 点击全屏」提示**（`margin-left:auto`）。
  - 移除原 `.card.code::after` 右下角提示（由覆盖层内提示替代）。
  - JS 在 `.card.code` 上统一注入覆盖层（复制按钮 + 提示）+ 保留点击卡片全屏预览。
- **浏览器验证**（移动端）：代码卡片有渐变覆盖层（`background-image` 含 linear-gradient）、左下角「复制」按钮、右上角「点击全屏」提示；点复制 → 仅复制（`viewer` 不打开）；点卡片空白 → 全屏预览打开；代码区仍 150px 高、不可滚动。 

### 本轮改动（2026-08-06 · 移动端：图片按钮改「下载」+ 全部消息左下角按钮统一）
- **需求**：①图片消息左下角按钮由「复制」改为「下载」；②全部消息左下角按钮的大小、颜色、相对左下角位置与代码消息一致。
- **移动端**（`docs/prototype/mobile.html`）：
  - **图片按钮改下载**：4 张图片卡片左下角按钮文本「复制」→「**下载**」、去掉 `secondary` 灰色样式（继承 `.btn` 主色）；JS 绑定改为下载行为（`stopPropagation` + flash「（原型）已开始下载图片」，不触发全屏预览）；并给视频左下角按钮补同样下载行为。
  - **按钮统一（与代码消息基准一致）**：大小 `padding:6px 12px;font-size:12px`（通用 `.ops .btn` 由 `7px` → `6px`）；颜色统一 `--primary` 主色（图片去掉 secondary 后自然一致）；相对左下角位置统一 左 `10px`、下 `8px`（通用 `.ops` 由 `padding:0 10px 10px` → `0 10px 8px`）。
- **浏览器验证**（移动端）：图片 4 处按钮均为「下载」、背景 `rgb(4,120,120)`（primary）；视频「下载」同色；图片/文件/音频/代码按钮 `padding:6px 12px;font-size:12px` 全一致；图片/视频/代码覆盖层与 `.ops` 均为 左10 下8 相对左下角一致；点图片「下载」→ 仅提示、`viewer` 不打开；点卡片空白 → 全屏预览正常。 

### 本轮改动（2026-08-06 · 移动端：修复图片/视频按钮相对左下角位置偏移 10px）
- **问题**：图片/视频消息左下角按钮相对卡片左下角为 左 `21px`、下 `17px`，而文件/代码/音频为 左 `11px`、下 `9px`，明显不一致。
- **根因**：`.ovl` 覆盖层自身 `padding:16px 10px 8px`（左10 下8），其内 `.ovl .ops` 又继承通用 `.ops` 的 `padding:0 10px 8px`，造成**双重 padding**，按钮被叠加推离左下角 10px。
- **修复**（`docs/prototype/mobile.html`）：`.card.img .ovl .ops`、`.card.video .ovl .ops` 补 `padding:0`，消除叠加。
- **浏览器验证**（移动端）：全量测量所有消息按钮相对卡片左下角 → file/img/code/audio/video 全部 **左 11px、下 9px**（即 padding 左10 下8 + 1px 边框）完全一致。 

### 本轮改动（2026-08-06 · 移动端代码预览：代码高亮 + 底部按钮改「复制」）
- **需求**：代码全屏预览窗口中的代码也要**语法高亮**；预览窗口底部「下载」按钮改为「复制」。
- **移动端**（`docs/prototype/mobile.html`）：
  - **代码预览高亮**：`openViewer("code")` 分支由纯文本 `esc()` → 用 `highlightCode(code, lang)` 渲染（`<pre><code>` 结构，沿用 One Dark token 样式）；`.card.code` 点击时传入 `lang`（`data-lang`）。
  - **底部按钮改复制**：`openViewer` 开头重置底部左下角按钮为「下载」（`onclick=closeViewer`）；`code` 分支时改为「复制」，点击复制完整代码 → flash「代码已复制」（`file://` 下 clipboard 受限走 catch 提示）。其他预览（图片/视频/文件/音频）仍为「下载」。
- **浏览器验证**（移动端）：点代码卡片 → 预览标题「代码预览」、代码高亮生效（23 个 token）、底部按钮为「复制/删除」；点「复制」→ flash 提示且预览不关闭；关闭预览正常。 

### 本轮改动（2026-08-06 · 移动端：代码消息去掉全屏提示 + 图片/视频图标去黑圈）
- **需求**：①代码消息去掉左下角「`</> 点击全屏`」提示；②图片/视频消息保留中间图案（放大镜/播放），但去掉图案后的半透明黑色圆圈。
- **移动端**（`docs/prototype/mobile.html`）：
  - **代码消息去提示**：删除 `.card.code .code-ovl .hint` 样式；JS 注入覆盖层时移除 hint 的创建与 append（覆盖层仅剩左下角「复制」按钮，点击卡片仍可全屏预览）。
  - **图片/视频去黑圈**：`.card.img .thumb::after`、`.card.video .vthumb::after` 的 `background-color:rgba(0,0,0,.38)` → `transparent`（保留白色放大镜 24px / 播放图标 22px 图案，去掉黑色圆形容器背景）。
- **浏览器验证**（移动端）：代码卡片覆盖层只剩「复制」按钮、无 hint；图片 `::after` 背景 `rgba(0,0,0,0)` 且放大镜图案保留；视频 `::after` 背景透明且播放图标保留；整页截图确认白色图案直接显示、无黑圈。 

### 本轮改动（2026-08-06 · 移动端：所有消息长按弹出删除确认气泡）
- **需求**：所有消息长按弹出「删除确认」气泡；气泡位置固定在该条消息下方；下方位置不够时整体向上滑动。
- **移动端**（`docs/prototype/mobile.html`）：
  - **长按检测**：每条 `.msg` 绑定 `touchstart`/`mousedown` 起 500ms 定时器触发；`touchmove`/`mouseup`/`mouseleave` 取消；跳过消息内按钮（不干扰复制/下载）。
  - **删除气泡** `.del-bubble`（fixed，z-420，宽 200px，白底圆角+阴影，指向消息的小箭头）：默认定位在消息正下方（`top = msg.bottom + 8`）并水平居中；若 `bottom + 气泡高 > 视口` 则整体**向上滑动**（`top = msg.top - 气泡高 - 8`，`.above` 时箭头朝下）；消息加粉色 `del-target` 描边高亮。
  - **操作**：「删除」→ 移除该 `.msg` + flash「消息已删除」；「取消」→ 关闭；点击气泡外/列表滚动 → 关闭。
  - **抬起屏蔽**：长按后手指抬起产生的 click 在 600ms 屏蔽窗口内拦截（不关闭气泡、不误触复制/打开预览）。
- **浏览器验证**（移动端）：中间消息长按 → 气泡在消息下方 8px、水平居中、抬起不关闭、消息高亮；底部消息长按 → `above:true` 气泡滑到消息上方 8px 且不越界；「取消」保留消息、「删除」移除消息并提示「消息已删除」；截图确认气泡与箭头视觉正常。 

### 本轮改动（2026-08-06 · 移动端：预览窗口删除按钮纯色白字 + 预览内弹出删除确认窗）
- **需求**：其他文件/图片/视频/代码等预览窗口的「删除」按钮样式改为**纯色白字**；点击删除后**直接在预览窗口内**弹出删除确认窗（预览保持打开），确认删除才移除消息并关闭预览。
- **移动端**（`docs/prototype/mobile.html`）：
  - **按钮样式**：预览底部删除按钮由 `btn secondary`（粉边框粉字）→ `btn pink`（纯色粉底 `rgb(225,40,133)` + 白字 + 无边框）。
  - **预览内确认窗** `.viewer .vdel`（absolute 覆盖预览层，半透明遮罩 + 居中白色卡片「删除这条消息？」）：`#vDel` 点击 → 直接弹出确认窗、**预览保持打开**；「取消」→ 关闭确认窗、预览不变；「删除」→ 移除 `viewerMsg` 来源消息 + `closeViewer()` + flash「消息已删除」。`openViewer` 开头重置确认窗为关闭。
  - `viewerMsg` 记录预览来源消息（document 捕获阶段事件委托：点击 `.msg` 内元素即记录）。
- **浏览器验证**（移动端）：点预览「删除」→ 确认窗在预览窗口内弹出（居中、遮罩），预览不关闭；「取消」→ 确认窗关闭、预览保持；确认「删除」→ 消息移除 + 预览关闭 + flash「消息已删除」；截图确认确认窗视觉正常。 

### 本轮改动（2026-08-06 · 移动端：预览标题放大为主题色 + 代码预览点空白关闭）
- **需求**：①所有预览窗口左上角标题放大一点点并改为**主题色**；②代码预览点击空白处可关闭预览界面。
- **移动端**（`docs/prototype/mobile.html`）：
  - **标题**：`.viewer .vtop #vTitle` → `font-size:14px → 16px`（放大一点点）、`color` 白 → `var(--primary)`（`rgb(4,120,120)` 主题色）、`font-weight:600`。
  - **代码预览点空白关闭**：`#vBody` 点击处理新增——点击 `.codeview` 自身（padding 空白区）→ `closeViewer()`；点代码文字（`code/pre/span`）不关闭，避免误触；其他预览点 vBody 空白关闭逻辑保持不变。
- **浏览器验证**（移动端）：预览标题 `16px` + 主题色 `rgb(4,120,120)` + 600（截图确认）；代码预览点 codeview 空白 → 关闭；点代码文字 → 不关闭；图片预览空白关闭仍正常。 

### 本轮改动（2026-08-06 · 移动端：代码预览空白关闭改为代码块外区域 + 代码块智能缩放）
- **需求澄清**：①代码预览的「空白区」指**代码块之外的区域**（点代码块内部不关闭），而非代码块内空白；②代码块区域**智能缩放贴合内容**，减少四周空白。
- **移动端**（`docs/prototype/mobile.html`）：
  - **空白关闭修正**：移除「点 `.codeview` 自身即关闭」逻辑，恢复为仅点击 `#vBody` 空白（代码块之外的区域）才关闭——点代码块内部任意处不关闭。
  - **代码块智能缩放**：`.codeview` 由 `width:100%;height:100%` 占满 → `width:fit-content;max-width:92vw;max-height:72vh`（宽度贴合最长行、高度贴合内容行数，超出最大尺寸才滚动）；并 `codeview pre{margin:0}` 清除 pre 默认 margin，让代码块精确贴合内容、四周空白最小化（居中显示）。
- **浏览器验证**（移动端）：代码块宽 292 = pre 264 + padding、高 354 = pre 326 + padding（完全贴合）；点代码块内部 → 不关闭；点代码块外 vBody 空白 → 关闭；截图确认代码块紧凑居中、四周留白。 

### 本轮改动（2026-08-06 · 移动端：设置标题放大可点击关闭 + 去掉保存按钮改输入即保存）
- **需求**：①设置界面标题放大一点，点击标题可关闭设置界面；②去掉下方「取消 / 保存昵称」按钮，输入完成即自动保存昵称。
- **移动端**（`docs/prototype/mobile.html`）：
  - **设置标题**：`.sheet .stitle` `font-size:13px → 15px`（放大一点）+ `cursor:pointer`；新增 JS——点击任意 Sheet 标题（`.stitle`）→ 关闭其所在 sheet。
  - **输入即保存**：删除设置底部 `qactions`（「取消」「保存昵称」按钮）；`#devNameInput` 改绑 `input` 事件 → 实时 `device.deviceName = value` + 写 localStorage + `renderDevice()`（列表头像/名字即时更新，设置界面保持打开）；移除原 `#btnSaveDevice` 点击逻辑。
- **浏览器验证**（移动端）：设置标题 15px、cursor pointer；点击标题 → 设置界面关闭；输入「测试昵称ABC」→ device 更新、localStorage 保存、列表头像/名字实时更新、设置界面不关闭；截图确认底部已无「取消/保存昵称」按钮。 

### 本轮改动（2026-08-06 · 移动端：隐藏滚动条，保留滚动功能）
- **问题**：移动端页面左侧出现滚动条（黑色模式下可见），需去除。
- **根因**：消息列表 `main` 容器 `overflow-y:auto`，内容高度（3799px）超出视口高度（728px）产生垂直滚动条。
- **修复**（`docs/prototype/mobile.html`）：全局隐藏滚动条——`*::-webkit-scrollbar{width:0;height:0;display:none}`（WebKit/Chromium）+ `*{scrollbar-width:none;-ms-overflow-style:none}`（Firefox/IE），**保留滚动功能**。
- **浏览器验证**（移动端）：`scrollbar-width:none` 生效、WebKit 滚动条隐藏；`main` 仍可滚动（scrollTop 正常改变）；黑色模式截图确认左侧无滚动条。 

### 本轮改动（2026-08-06 · 移动端：黑色模式主题色保持黛绿不变）
- **需求**：黑色模式下主题色（黛绿 `#047878`）不允许更改。
- **问题**：深色主题 `html[data-theme="dark"]` 里 `--primary` 被定义为浅青 `#86cecb`，导致切深色模式后主题色由黛绿变成浅青色。
- **修复**（`docs/prototype/mobile.html`）：深色模式 `--primary` 改回 `#047878`（`--primary-hover:#137a7f`、`--primary-active:#035c5c` 同步保持黛绿色系），与浅色模式完全一致；`--accent` 辅助色 `#86cecb` 保持不变。
- **浏览器验证**（移动端）：浅色/深色 `--primary` 均为 `#047878`（一致）；深色模式截图确认 logo 圆点、状态灯、发送按钮、头像、本机标签、播放按钮等均呈黛绿色。 

### 本轮改动（2026-08-06 · 移动端：文件/音频消息去掉预览界面 + 下载按钮直接下载）
- **需求**：①音频消息、其他文件消息左下角「下载」按钮应**直接开始下载**（不进预览）；②音频/文件消息**去掉预览界面**，它们不应有预览入口。
- **移动端**（`docs/prototype/mobile.html`）：
  - **去预览入口**：JS 运行时移除所有文件卡片 `.card .file` 的 `onclick="openViewer('file')"`（点击文件卡片不再打开预览）；移除文件/音频下载按钮的 `onclick="openViewer('file'/'audio')"`（`openViewer` 的 file/audio 分支不再有入口触发）。
  - **下载按钮直接下载**：文件/音频左下角「下载」按钮改绑 click → flash「（原型）已开始下载」，不再进入预览。
  - 音频卡片内**播放功能保留**（`.play` 波形播放不受影响）。
- **浏览器验证**（移动端）：文件卡片点击不打开预览；文件/音频「下载」按钮点击 → flash「（原型）已开始下载」、预览不打开；音频播放按钮仍可切换播放态；图片/视频/代码预览不受影响（均正常打开）。 

### 本轮改动（2026-08-06 · 移动端：附件面板去粘贴图片 + Sheet 标题主题色 + 遮罩点击关闭）
- **需求**：①发送内容窗口（附件面板）去掉「粘贴图片」选项；②发送内容窗口、设置窗口标题文字改为**主题色**；③发送内容/设置窗口点击上方空白区域直接关闭，点击事件不可传递到下方消息。
- **移动端**（`docs/prototype/mobile.html`）：
  - **去粘贴图片**：附件面板 `attach-grid` 移除「📋 粘贴图片」项，仅剩 相册/拍照/文件。
  - **标题主题色**：`.sheet .stitle` `color:var(--muted) → var(--primary)`（黛绿 `#047878`），发送内容/设置/上传进度标题统一主题色。
  - **遮罩关闭**：新增 `.sheet-mask`（fixed 全屏、z-290、`rgba(0,0,0,.25)`，低于 sheet 300 高于消息）；`syncSheetMask()` 任一 sheet 打开即显示遮罩、全关则隐藏；点击遮罩 → `closeSheets()` 关闭全部 sheet，遮罩拦截点击、**不穿透到下方消息**；`#btnAdd`/`openProgress`/`openSettingsSheet`/点空白/点 stitle 关闭均同步遮罩。
- **浏览器验证**（移动端）：附件面板仅 相册/拍照/文件（无粘贴图片）；「发送内容」「设置」标题均为 `rgb(4,120,120)` 主题色；打开面板遮罩显示（z-290）；点击遮罩 → 面板关闭、遮罩隐藏、预览未打开（事件不穿透）；设置窗口同样正常。 

### 本轮改动（2026-08-06 · 移动端：遮罩淡入动画 + 去设置按钮 + logo 点击进设置）
- **需求**：①设置/发送内容界面的黑色半透明遮罩出现时带**透明渐变动画**；②去掉主界面右上角设置按钮；③左上角 filesyncEX 文字**放大 + 主题色**，点击进入设置界面。
- **移动端**（`docs/prototype/mobile.html`）：
  - **遮罩淡入**：`.sheet-mask` 由 `display:none` → `opacity:0/visibility:hidden` + `transition:opacity .28s ease,visibility .28s ease`，`.show` 时 `opacity:1/visible`（淡入渐变，关闭淡出）。
  - **去设置按钮**：删除 header 的 `#btnSettings`（齿轮）按钮；入口改由 logo 承担。
  - **logo 进设置**：`.logo` `font-size:16px → 20px`（放大）+ `color:var(--primary)` 主题色 + `cursor:pointer` + `user-select:none`；点击 `.logo` → `openSettingsSheet()`（`stopPropagation` 防被 body 空白关闭逻辑误关，body 关闭逻辑排除 `.logo`）。
- **浏览器验证**（移动端）：打开面板/设置 → 遮罩从透明淡入至 `opacity:1`（0.28s）；右上角无设置按钮；logo `20px` + `rgb(4,120,120)`；点击 logo → 设置界面打开、遮罩显示；点遮罩关闭正常。 

### 本轮改动（2026-08-06 · 桌面端：弹窗遮罩淡入动画 + 去设置按钮 + logo 点击进设置）
- **需求**：与移动端一致——①设置界面黑色半透明遮罩出现时透明渐变动画；②去掉主界面右上角设置按钮；③左上角 filesyncEX 文字放大 + 主题色，点击进入设置界面。
- **桌面端**（`docs/prototype/desktop.html`）：
  - **遮罩淡入**：原生 `<dialog>` 弹窗加 `dialog[open]{animation:dlgIn .22s ease}`（淡入+微缩放）+ `dialog::backdrop{animation:dlgBackdropIn .22s ease}`（半透明黑遮罩 `rgba(0,0,0,.45)` 从透明淡入）。
  - **去设置按钮**：删除 header 的 `#btnSettings`（齿轮）按钮，右上角仅剩 二维码/主题切换。
  - **logo 进设置**：`.logo` `font-size:18px → 22px`（放大）+ `color:var(--primary)` 主题色 + `cursor:pointer` + `user-select:none`（右侧 `<small>` 版本号保持 muted）；点击 `.logo` → `dlg("dlgSettings").showModal()`。
- **浏览器验证**（桌面端）：右上角无设置按钮；logo `22px` + `rgb(4,120,120)`、small 保持灰 `rgb(111,122,130)`；点击 logo → 设置弹窗打开，dialog 动画 `dlgIn`、遮罩动画 `dlgBackdropIn`（淡入）；关闭正常；截图确认。 

### 本轮改动（2026-08-06 · 桌面端：隐藏滚动条 + 深色模式主题色保持黛绿）
- **需求**：与移动端一致——①主界面不显示滚动条（保留滚动功能）；②黑夜模式下主题色（黛绿 `#047878`）不改变。
- **桌面端**（`docs/prototype/desktop.html`）：
  - **隐藏滚动条**：全局 `*::-webkit-scrollbar{width:0;height:0;display:none}`（WebKit/Chromium）+ `*{scrollbar-width:none;-ms-overflow-style:none}`（Firefox/IE），保留滚动功能。
  - **深色主题色**：`html[data-theme="dark"]` 的 `--primary` 由 `#86cecb` 改回 `#047878`（`--primary-hover`/`--primary-active` 同步黛绿色系），与浅色模式一致；`--accent:#86cecb` 不变。
- **浏览器验证**（桌面端）：浅色/深色 `--primary` 均为 `#047878`；`scrollbar-width:none` 生效；页面可滚动（`scrollY` 正常改变，页面高 5614 > 视口 953）；深色模式截图确认 logo/按钮均呈黛绿色、无滚动条。 

### 本轮改动（2026-08-06 · 桌面端：文件消息去预览 + 下载直接下载 + 全屏预览删除按钮纯色白字）
- **需求**：①去掉其他文件消息的预览窗口；②文件消息左下角「下载」按钮直接开始下载（不进预览）；③图片/视频全屏预览下方「删除」按钮改为纯色白字。
- **桌面端**（`docs/prototype/desktop.html`）：
  - **去文件预览**：`.card .file` 运行时 `removeAttribute("onclick")`（点击文件卡片不再打开 `dlgPreview` 文件信息弹窗，`openPreview('file')` 分支无入口）。
  - **下载直接下载**：「统一消息布局」重建的文件消息操作按钮改 `add("下载", "", () => flash("（原型）已开始下载"))`（原来绑定 `openPreview('file')`）。
  - **删除按钮纯色白字**：全屏预览 `.fullviewer .fv-foot` 删除按钮由 `btn secondary`（粉边框粉字）→ `btn pink`（纯色粉底 `rgb(225,40,133)` + 白字）。
- **浏览器验证**（桌面端）：文件卡片点击不打开预览弹窗；文件「下载」按钮点击 → flash「（原型）已开始下载」、预览不打开；全屏预览删除按钮纯色粉底白字；图片/视频全屏预览仍正常打开。 

### 本轮改动（2026-08-06 · 桌面端：文件消息去 hover 响应 + 图片/视频按钮位置统一）
- **需求**：①其他文件消息鼠标移过时**不响应 hover**（无背景变化）；②图片/视频消息左下角复制/下载按钮相对左下角位置与文件消息一致。
- **桌面端**（`docs/prototype/desktop.html`）：
  - **去 hover**：删除 `.card .file:hover{background:var(--surface-2)}`（文件消息鼠标移过不再变背景）。
  - **按钮位置统一**：`.card.img .ovl, .card.video .ovl` 底部 padding `10px → 12px`，并给 `.card.img .ovl .ops, .card.video .ovl .ops` 补 `padding:0`（消除覆盖层内 `.ops` 继承通用 `.card .ops{padding:10px 14px 12px}` 造成的**双重 padding**，按钮被推离左下角的问题）。
- **浏览器验证**（桌面端）：文件消息 hover 前后背景均为 `rgba(0,0,0,0)`（无变化）；全量测量 file/img/code/audio/video 按钮相对卡片左下角均为 **左 15px、下 13px**（即 padding 左14 下12 + 1px 边框）完全一致。 

### 本轮改动（2026-08-06 · 桌面端：删除免二次确认 + 图片/视频图标去黑圈）
- **需求**：①所有删除操作**不需要二次确认**（直接删除）；②图片/视频消息中间图标保留，但去掉图标下方的半透明黑色圆形。
- **桌面端**（`docs/prototype/desktop.html`）：
  - **删除免确认**：消息卡片右上角删除角标（`.del-corner`）点击由 `askDelete()`（弹 `dlgDelete` 确认框）改为**直接删除**——`del.closest(".msg").remove()` + flash「消息已删除」，不再弹二次确认；`dlgDelete` 弹窗不再有入口。
  - **图标去黑圈**：`.card.img .thumb::after`、`.card.video .vthumb::after` 的 `background-color` `rgba(0,0,0,.38/.45)` → `transparent`（保留白色放大镜/播放图标图案，去掉黑色圆形容器背景）。
- **浏览器验证**（桌面端）：点删除角标 → 消息直接移除（28→27）+ flash「消息已删除」、`dlgDelete` 未打开；图片/视频 `::after` 背景 `rgba(0,0,0,0)` 且图标（svg）保留。 

### 本轮改动（2026-08-06 · 移动端：设置标题放大 + 确认既有设置项 + Sheet 滚轮屏蔽）
- **需求**：①设置界面标题变大一点并改为主题色；②去掉设置界面最下方「取消 / 保存昵称」；③设置界面点击空白处直接关闭；④设置界面屏蔽鼠标滚轮事件，不渗透到下方主界面。
- **移动端**（`docs/prototype/mobile.html`）：
  - **标题放大**：`.sheet .stitle` `font-size:15px → 17px`（主题色 `var(--primary)` 此前已改，保持）。
  - **既有项确认**：设置界面 `qactions`（取消/保存昵称）此前已删除；`.sheet-mask` 遮罩点击关闭此前已实现——本轮验证均生效。
  - **滚轮屏蔽**：给所有 `.sheet` 加 `wheel` 监听（`passive:false`）——滚动到边界时 `preventDefault()`（阻止穿透下方主界面）；Sheet 内部仍可正常滚动（未到边界时放行）。
- **浏览器验证**（移动端）：设置标题 `17px` + `rgb(4,120,120)` 主题色；无「取消/保存昵称」按钮；遮罩点击关闭正常；dispatch wheel → `defaultPrevented:true`、主界面 `scrollTop` 不变（不穿透）。 

### 本轮改动（2026-08-06 · 桌面端：设置弹窗标题主题色 + 去取消/保存昵称 + 点击空白关闭 + 滚轮屏蔽）
- **需求**（桌面端同步移动端设置界面四项）：①设置界面标题变大并改为主题色；②去掉最下方「取消 / 保存昵称」；③设置界面点击空白处直接关闭；④屏蔽鼠标滚轮事件，不渗透到下方主界面。
- **桌面端**（`docs/prototype/desktop.html`）：
  - **标题放大主题色**：`.dialog .dhead` `font-size:16px` + `font-weight:700` + `color:var(--primary)`（原 15px 默认色）。
  - **去取消/保存昵称**：删除设置弹窗底部 `dfoot`（含「取消」「保存昵称」按钮），`#btnSaveDevice` 绑定移除。
  - **输入即保存**：`#devNameInput` 由按钮保存改为 `input` 事件**实时保存**（更新 `device.deviceName` + `localStorage` + `renderDevice()` 刷新列表）。
  - **点击空白关闭**：`#dlgSettings` 加 click 监听——`e.target === dlg`（点 dialog 自身空白）时 `close()`（`dialog::backdrop` 点击同样命中自身，故点击弹窗外区域也关闭）。
  - **滚轮屏蔽**：`#dlgSettings` 加 `wheel` 监听（`passive:false`）——滚动到边界时 `preventDefault()`（阻止穿透下方主界面）。
- **浏览器验证**（桌面端）：`.dhead` `16px` + `rgb(4,120,120)` 主题色；无 `#btnSaveDevice`、无 `.dfoot`；dispatch dialog 自身 click → 弹窗关闭；输入昵称 dispatch input → `device.deviceName` 与 `localStorage` 同步更新、消息列表实时刷新；dispatch wheel → `defaultPrevented:true`；截图确认弹窗底部无按钮。 

### 本轮改动（2026-08-06 · 桌面端：设置弹窗滚轮穿透根治——打开 dialog 锁定主界面滚动）
- **需求**：上一轮给 `#dlgSettings` 加的 wheel 边界 `preventDefault` 在真实浏览器中仍挡不住——用户实测打开设置界面时滚轮仍会传递到下方主界面（dialog 内容滚到边界后的 overscroll 会链式传到背景页面，Playwright synthetic/dispatch wheel 测不出该现象）。
- **桌面端**（`docs/prototype/desktop.html`）：
  - 弹窗 CSS 区新增 `body:has(dialog[open]){overflow:hidden}`——**任意 modal dialog 打开即锁定主界面滚动**（`showModal` 会往 body 加 `[dialog open]` 状态，`:has` 命中即锁 body `overflow:hidden`），全部 dialog 关闭后自动恢复；dialog 自身（top layer）仍可正常滚动，与主界面隔离。
  - 保留上轮 `#dlgSettings` wheel 边界拦截（作为内容区 overscroll 抑制，与 body 锁定双保险，无需移除）。
- **浏览器验证**（桌面端）：打开设置弹窗前 `body.overflow = visible` → 打开后 `hidden`（锁定）；弹窗打开时鼠标移到**弹窗内容区**与**弹窗外 backdrop 区**各真实滚轮 800px，主界面 `scrollTop` 始终不变（纹丝不动，彻底不穿透）；关闭后 `overflow` 恢复 `visible` 且原滚动位置保留。同时 `:has(dialog[open])` 自动覆盖 `dlgQr`/`dlgPreview`/`dlgDelete` 等所有 dialog。 

### 本轮改动（2026-08-06 · 两端：去代码消息右上角三个点 + 桌面端文字链接点击开网页）
- **需求**：①桌面端、移动端去掉代码消息右上角的三个点（红黄绿圆点）；②桌面端文字消息若是 http 链接，点击消息直接在新标签页打开网页（移动端依旧执行复制操作，不改）。
- **桌面端**（`docs/prototype/desktop.html`）：
  - **去三个点**：删除 `.card.code .code-head` 内 `<span class="dots">`（红黄绿圆点）及其 CSS（`.code-head .dots` / `.dots i`）——标题栏只剩左上角 `TypeScript` 语言名。
  - **文字链接点击开网页**：`kind === "text"` 分支给 `.bubble` 加 click——`textContent.trim().match(/^https?:\/\/\S+/i)` 命中则 `window.open(url, "_blank")` 新标签打开；非链接文本点击无操作；`e.stopPropagation()` 防止误触其他消息操作；右下角「复制」按钮保留不变。
- **移动端**（`docs/prototype/mobile.html`）：
  - **去三个点**：同样删除 `.code-head` 内 `.dots` 圆点及 CSS。
  - **文字点击保持复制**：`.bubble` 点击复制逻辑不动（用户要求移动端依旧复制）。
- **浏览器验证**（两端）：`.card.code .code-head` 内 `.dots` 数量 0、`innerHTML` 只剩 `<span class="lang">TypeScript</span>`；截图确认标题栏无三个点。桌面端注入链接文本点击 → `window.open("https://example.com/page?x=1")`（新标签打开）、非链接文本点击不打开；移动端 stub clipboard 点击 bubble → 文本写入剪贴板 + flash「已复制到剪贴板」（复制逻辑保持）。 

### 本轮改动（2026-08-06 · 两端：主题按钮白天太阳/夜晚月亮 + 移动端二维码底部滑出弹窗）
- **需求**：①移动端、桌面端切换黑白主题的按钮，白天（浅色）为太阳、晚上（深色）为月亮；②移动端点击二维码按钮，改为从下面划出二维码弹窗。
- **桌面端**（`docs/prototype/desktop.html`）：
  - **主题图标日月切换**：`#themeIco` SVG 同时内嵌 `<g class="ico-sun">`（Heroicons sun）与 `<g class="ico-moon">`（Heroicons moon），新增 CSS `html[data-theme="light"] .ico-moon{display:none}` / `html[data-theme="dark"] .ico-sun{display:none}`——浅色显示太阳、深色显示月亮，切换主题时图标自动跟随（纯 CSS，无需改 JS）。
- **移动端**（`docs/prototype/mobile.html`）：
  - **主题图标日月切换**：`#btnTheme` SVG 同样内嵌 `.ico-sun` / `.ico-moon` 双 group + 相同 CSS 显隐规则。
  - **二维码底部滑出弹窗**：新建 `<div class="sheet" id="sheetQr">`（handle + stitle「扫码连接本机」+ 白底 180×180 `#qrBox` + 连接地址文案），`fillQr()` 程序化生成仿二维码 SVG（21×21：三个 7×7 定位角 + 第 6 行/列时序线 + LCG 确定性伪随机数据点，270 个黑格）；`#btnQr` 点击改为打开 `sheetQr`（关闭其他 sheet + `syncSheetMask`），从底部 `translateY(110%)→0` 划出；`closeSheets()` / `openSettingsSheet()` 均加入 sheetQr；body 空白关闭排除列表补 `#btnQr`（否则点按钮打开后冒泡被立即关闭）。stitle 点击 / 遮罩点击 / 空白点击关闭自动继承既有 sheet 机制。
- **浏览器验证**：桌面端浅色 `sun:inline / moon:none`、切深色 `sun:none / moon:inline`（截图确认太阳/月亮）；移动端同验证通过。移动端点 `#btnQr` → `sheetQr.open` + 遮罩 show + `#qrBox` 生成 21×21 SVG（270 rect）；点 stitle、点遮罩均正常关闭；滑出动画 `transform: translateY(330px)`（关闭态 110% 偏移）生效；修复 body 空白关闭误关 sheetQr 后 reopen 正常。 

### 本轮改动（2026-08-06 · 两端：二维码标题改「扫码连接」+ 桌面预览标题主体色 + 代码分隔线下移）
- **需求**：①移动端、桌面端二维码界面标题改为「扫码连接」；②桌面端图片/视频预览左上角标题改为主体色；③桌面端代码消息语言类型下面的那条线向下挪 6px。
- **移动端**（`docs/prototype/mobile.html`）：`#sheetQr` 的 `.stitle`「扫码连接本机」→「扫码连接」。
- **桌面端**（`docs/prototype/desktop.html`）：
  - **二维码标题**：`dlgQr .dhead`「扫码连接本机」→「扫码连接」。
  - **预览标题主体色**：新增 `.fullviewer .fv-top #fvTitle{color:var(--primary);font-weight:700}`——图片/视频/音频全屏预览左上角标题（`openFullPreview` 设置 `#fvTitle`）由白色改为主体色黛绿 `#047878` + 加粗；右上角 ✕ 关闭按钮保持白色。
  - **代码分隔线下移**：`.card.code .code-head` padding `8px 14px` → `8px 14px 14px`（底部 padding +6px），语言类型「TypeScript」下方 `border-bottom` 分隔线向下挪 6px。
- **浏览器验证**（桌面端）：`dlgQr` 标题文本「扫码连接」；`openPreview("img")` → `#fvTitle`「图片预览」color `rgb(4,120,120)` + weight 700、`openPreview("video")` →「视频预览」同主体色；`.code-head` padding-bottom `14px`、语言文字底到分隔线实测 15px（14px padding + 1px border，比原 9px 多 6px）。移动端：`#sheetQr .stitle` 文本「扫码连接」。截图确认图片预览标题黛绿色、二维码标题、代码分隔线空隙。 

### 本轮改动（2026-08-06 · 桌面端：代码消息语言类型下移5px + 分隔线再下移2px）
- **需求**：桌面端代码消息，语言类型「TypeScript」向下挪 5px，其下方那条分隔线再次向下挪 2px（在上轮已下移 6px 的基础上）。
- **桌面端**（`docs/prototype/desktop.html`）：
  - **语言类型下移5px**：`.card.code .code-head .lang` 加 `position:relative;top:5px`（视觉下移 5px，不参与布局、不影响线位置）。
  - **分隔线再下移2px**：`.card.code .code-head` padding-bottom `14px` → `16px`（border-bottom 分隔线随之再下移 2px，累计较最初下移 8px）。
- **浏览器验证**（桌面端）：`.lang` `position:relative; top:5px`、视觉距标题栏顶实测 `13px`（8px padding + 5px top，语言类型下移 5px）；`.code-head` padding-bottom `16px`；语言文字底到分隔线实测 `12px`（文字下移 5 + 线下移 2，间距由 15→12px）。截图确认。 

### 本轮改动（2026-08-07 · 261MB 上传立即失败修复：局域网 HTTP 非安全上下文 crypto.subtle 不可用）
- **用户反馈**：「我刚尝试上传一个261M的文件，为啥直接提示上传失败？」——占位卡立即变红「上传失败」。
- **排查**：服务器 chunk limit 64mb > 1MB 分片（正常）；磁盘 186GB 空闲；服务器日志无任何上传请求记录；localStorage 无残留 uploadId（未走到 init）。
- **根因**：前端 ileSha256 用 crypto.subtle.digest，**Web Crypto 仅在 secure context（HTTPS/localhost）可用**；用户经局域网 http://192.168.40.154:14100 访问时 isSecureContext=false、crypto.subtle=undefined → 计算 SHA 第一步即抛 TypeError → 上传立即失败（服务器收不到请求、无日志、无 uploadId）。之前 43MB/71MB 能成功是 127.0.0.1 secure context。
- **修复**（packages/web/src/api.ts）：①新增纯 JS 增量 SHA-256 类 IncrementalSha256（K 常量 + rotr32 + 64 轮压缩 + 标准填充，**不依赖 crypto.subtle**，浏览器对照 crypto.subtle 已知哈希 abc/空串/hello + 100KB 随机全一致）；②ileSha256 改为 ile.slice() **4MB 分块增量哈希**（顺带解决 261MB 整文件 arrayBuffer 一次性占内存）。**坑：tsconfig 
oUncheckedIndexedAccess:true → Uint32Array/Uint8Array 索引访问需 ! 非空断言**。
- **验证**：①局域网页（subtleUnavailable=true）上传 sha-test.bin(1MB) 占位卡 0%→成功、真实消息出现、无残留 ✓；②big-30mb-test.bin(30MB) 局域网 1 秒上传成功 ✓；③127.0.0.1 页 secure-test.txt 上传成功、key=a7816bf8f01（正是 abc 的标准 SHA-256 前缀）证明结果与标准 SHA-256 完全一致 ✓；④测试文件已清理。
- **注意**：图片复制（copyImage）此前已用 canvas 方案处理了非安全上下文问题；音频/视频播放不受影响；本次只影响上传 SHA 计算。

### 本轮改动（2026-08-07 · 大文件上传「到一半失败」修复：chunk 请求断连无重试）
- **用户反馈**：「现在上传到一半左右，就失败了」（261MB 文件，SHA 修复后能进入上传流程，但传至 ~68% 中断）。
- **排查**：①服务器 data/uploads/65626eeb-... 会话目录残留 **0~176 共 177 个 1MB part**（14:45 创建，早于我 14:47 的测试）→ 确证用户 261MB 传到 177/261≈68% 中断；②server.err 有 BadRequestError: request aborted（raw-body 在请求体未读完时客户端断连）→ **客户端连接在该 chunk 被断开**；③本机测试（120MB/261MB 回环网络）全部成功 → 排除服务器逻辑问题，定位为**局域网 WiFi 传输中途断连**；④前端 piUploadChunk 单次 fetch 无超时无重试 → 一个 chunk 失败即整体判失败。
- **修复**：①前端（packages/web/src/api.ts）piUploadChunk 加 **4 次重试 + 30s 超时**（AbortController，退避 400ms/800ms/1600ms，网络瞬时断连自动恢复继续传）；piUploadComplete 同加重试（3 次+60s 超时）；新增常量 CHUNK_TIMEOUT_MS/CHUNK_MAX_RETRIES。②服务器（packages/server/src/index.ts）httpServer 调大 keepAliveTimeout=30s/headersTimeout=35s/
equestTimeout=120s（避免 chunk 间隙服务器关闭连接池导致浏览器复用已关闭连接而 request aborted/ECONNRESET）。**断点续传仍兜底**：重试耗尽仍失败 → 存 uploadId，下次按同 sha 自动续传。
- **验证**：①20MB 上传成功（新 bundle）；②**重试验证**：monkey-patch fetch 令首个 chunk 强制 reject（模拟 WiFi 断连），15MB 上传仍 success（failedOnce=true）✓；③服务器重启后 err 无新 abort ✓；④测试文件已清理，数据目录剩原始 4 文件 ✓。
- **注意**：真机 WiFi 大文件传输的瞬时抖动已由重试兜住；若持续断连超 4 次，仍走断点续传逻辑。已登记 PROJECT_LOG.md。


### 本轮改动（2026-08-07 · WS 连接状态三色 + 心跳 + 服务器通知 + 文字消息 URL 链接）
- **需求 1：去掉 logo 旁的点**：app.ts logo 模板删掉 `<span class="dot"></span>`；app.css 删 `.logo .dot`。已验证无点。
- **需求 2：WS 连接状态三色**：app.ts 加 `connState: "connecting"|"connected"|"disconnected"` state；WsClient 加 `onConnecting` 回调（connect 时触发）；logo 按状态着色（`.logo.connecting`=黄 `var(--warn)` #d9a020 / `.logo.connected`=主题色 `var(--primary)` / `.logo.disconnected`=红 `var(--danger)` #e5484d），index.html :root 加 `--warn`/`--danger` 变量；设置面板 `.st-conn .dot` 同步三态颜色与文案（已连接/连接中…/已断开）。已验证：connected rgb(4,120,120)、connecting rgb(217,160,32)、disconnected rgb(229,72,77)。
- **需求 3：前端心跳 30s**：WsClient 加 `startHeartbeat`（onopen 启动 setInterval 30s 发 `{type:"ping"}`；超过 90s 未收 pong 判定失联主动 close 触发重连）；onmessage 加 `pong` 分支刷新 lastPong；close/断开时 stopHeartbeat。**服务器侧同步**：SocketServer 每 30s 检查连接 alive（ws.ping()，2 周期未 pong 则 terminate 断开），`close()` 清理 hbTimer。已验证 hbTimer 运行中（30s）。
- **需求 4：服务器通知大窗**：协议 schema.ts ServerFrame 加 `{type:"notice", level: info|warn|error|maintenance|shutdown, message}`；SocketServer 加 `broadcastNotice(level,message)`；server index.ts `close()` 先广播 shutdown 通知再延迟 500ms 关闭，RunResult 加 `broadcastNotice`；WsClient onmessage 加 `notice` 分支 → `onNotice` 回调；app.ts 加 `notice` state + `renderNotice()`（`.notice-mask` 遮罩 z-600 不可点击关闭 + `.notice-panel` 大窗：标题=服务器关闭/维护中/异常/警告/通知 + 内容 + 「确认并重连」按钮）；`confirmNotice()` 点击确认 → `ws.forceReconnect()` 立即重连（重置退避），**3s 防抖**（confirmReconnectAt 记录，快速连点只触发一次）。已验证 showNotice 弹窗标题/内容/按钮正确。
- **文字消息 URL 链接（用户「点击直接打开新网页」）**：app.ts 加 `renderText(text)`——正则 `/(https?:\/\/[^\s<]+)/g` 匹配文字消息中的 http/https URL，渲染为 `.bubble-link` `<a target="_blank" rel="noopener">`；`openTextLink(e,url)` preventDefault + `window.open(url,"_blank","noopener")`；50 次上限防死循环；非 URL 原样显示。app.css 加 `.bubble-link`（主题色下划线 + hover）。已验证：文字消息 `http://192.168.40.154:14100/` 渲染为链接、点击 `window.open` 正确（_blank+noopener）。已登记 PROJECT_LOG.md。


### 本轮改动（2026-08-07 · 视频消息无封面修复：preload="none" 导致首帧不加载）
- **用户反馈**：「为什么我新发送的视频，没有视频封面？」——视频消息缩略图区域显示黑底无画面。
- **根因**：视频缩略图 `<video muted preload="none">` 的 `preload="none"` 让浏览器**完全不加载视频数据**（readyState=0、videoWidth=0），故无法解析/渲染首帧。之前为消除控制台 ERR_ABORTED 噪音加的 `preload="none"`，副作用是封面永远取不到帧。
- **修复**（packages/web/src/app.ts video 分支）：`preload="none"` → **`preload="metadata"`**——只加载元数据+足够解析首帧的数据（不下载整个视频，性能仍轻），浏览器即可渲染真实首帧为封面。
- **验证**：改后 video 202ms 加载完成 `readyState:4`（HAVE_ENOUGH_DATA）、`videoWidth:1280×720`、`hasFrame:true`；canvas 采样整帧非黑比例 100%、中心像素 [4,24,54]（深蓝画面非纯黑）✓。截图确认封面显示。已登记 PROJECT_LOG.md。


### 本轮改动（2026-08-07 · 视频预览无声音修复：autoplay 属性被浏览器自动播放策略拦截）
- **用户反馈**：「为什么现在视频没有声音」——视频预览能看画面但无声音。
- **根因**：预览 `<video controls autoplay>` 依赖 `autoplay` 属性自动播放。**Chrome 自动播放策略**：有声视频的 autoplay 需要「用户已与该域名交互」或「用户手势栈内」；lit 渲染是异步的，`autoplay` 在渲染后触发时已**脱离点击手势上下文**，被浏览器**静默拦截**（实测 `paused:true`、`video.play()` 被拒）。此前的视频封面修复把缩略图 `preload="none"`→`"metadata"` 无关；`webkitAudioDecodedByteCount:0` 是 Playwright headless 无音频设备的假象，非真实原因。
- **修复**（packages/web/src/app.ts）：①`openPreview` 对 `kind==="video"` 在点击手势内 `this.updateComplete.then()` → 立即 `video.play()`（**保留用户手势上下文，有声播放**）；若被策略拦截则退化 `muted=true` 再 play（用户可手动取消静音），catch 忽略。②预览 video 去掉 `autoplay` 属性（避免与手动 play 双触发），保留 `controls`。
- **验证**：修复前 `paused:true`（被拦截）；修复后 `paused:false`、`currentTime` 前进、`muted:false volume:1 readyState:4`（有声真正播放）✓。headless 无音频设备故 audioEnergy=0 属预期，真实浏览器有声。已登记 PROJECT_LOG.md。


### 本轮改动（2026-08-07 · 默认昵称 user_XXXX + 自定义昵称 8 位规则）
- **用户需求**：①默认昵称改为 `user_XXXX`（四位数字）；②自定义昵称仅允许大小写字母/下划线/数字，最长 8 位。
- **实现**：
  - packages/web/src/device.ts：默认昵称 `用户-XXXX` → **`user_XXXX`**（`user_` + 指纹哈希取模 4 位数字）；新增 `NICK_RE = /^[A-Za-z0-9_]{1,8}$/` 与 `defaultName(id)`；`getDevice()` 读取 localStorage 时**兼容旧昵称**（`用户-XXXX` 等不符合新规则则自动重置为 `user_XXXX` 并回写）。
  - packages/web/src/app.ts：`rename()` 校验 `NICK_RE`，不合法 `flash("昵称仅允许大小写字母、下划线和数字，最长 8 位")` 并 return（不发帧）；设置面板提示文字改 `user_XXXX`，输入框加 `maxlength="8"` + `@input` 时 `.replace(/[^A-Za-z0-9_]/g, "")` 实时过滤非法字符，placeholder 提示。
  - packages/protocol/src/schema.ts：`rename` 帧校验 `z.string().regex(/^[A-Za-z0-9_]{1,8}$/, "昵称仅允许大小写字母、下划线和数字，最长 8 位")`（服务器端兜底，非法帧 400）。
- **注意**：默认昵称 `user_XXXX` 为 9 位（`user_` 5 字符 + 4 数字），是**系统生成的特例**；自定义昵称严格 8 位（前端 + 协议双层校验）。若用户想改回默认格式需清 localStorage 或输入 8 位内昵称。
- **验证**：旧 `用户-6362` 自动迁移为 `user_6362` ✓；中文昵称拦截 + 提示 ✓；9 位拦截 ✓；8 位 `user_abc` 成功发送 ✓；清缓存后默认昵称 `/^user_\d{4}$/` ✓。已登记 PROJECT_LOG.md。


### 本轮改动（2026-08-07 · toast 字体缩至 2/3 + 自定义昵称上限 8→10 位）
- **用户需求**：①提示窗字体缩到现在的 2/3；②自定义昵称最长改为 10 位。
- **实现**：
  - app.css `.toast` font-size `26px` → **`17px`**（26 × 2/3 ≈ 17.3，取整 17，保持 font-weight 600）。
  - 昵称上限 8 → 10：app.ts `NICK_RE` 改 `{1,10}` + flash 文案改"最长 10 位" + 输入框 `maxlength="10"` + placeholder 改"仅字母/数字/下划线，最长 10 位"；device.ts `NICK_RE` 改 `{1,10}`；协议 schema.ts `rename` 帧 regex 改 `{1,10}` + 错误文案改"最长 10 位"（服务器兜底）。
- **验证**：toast `fontSize:17px` ✓；输入框 maxlength 10 + placeholder ✓；10 位 `abc_123def` 通过不拦截 ✓；11 位拦截 ✓。已登记 PROJECT_LOG.md。


### 本轮改动（2026-08-07 · 代码消息框去滑条 + 代码预览滚动条去白框）
- **用户需求**：①代码消息框不允许有任何滑条；②代码预览可以有滑条（代码很长超预览窗口时），但滑条不能有下边那个白色的框。
- **实现**（packages/web/src/app.css）：
  - 代码消息框 `.card.code pre`：`overflow: auto` → **`overflow: hidden`**（长代码在卡片内截断，无任何滑条；点击卡片进入预览看完整代码）。
  - 代码预览 `.viewer .vbody .codeview`：保留 `overflow: auto`（超长时有滑条），新增定制滚动条样式——`scrollbar-width: thin; scrollbar-color: rgba(255,255,255,.25) transparent`（Firefox）+ WebKit `::-webkit-scrollbar{10px}` / `::-webkit-scrollbar-thumb`（半透明白圆角） / `::-webkit-scrollbar-track`（transparent） / **`::-webkit-scrollbar-corner { background: transparent }`（去掉右下角白色框，与深色 #282c34 背景融合）**。
- **验证**（注入 40 行×超长行代码）：消息框 pre overflow=hidden、scrollable=false（无滑条）✓；预览 codeview overflow=auto、垂直+水平均可滚动（滑条存在）✓；滚动条 corner 透明规则已应用（去白框）✓。已登记 PROJECT_LOG.md。


### 本轮改动（2026-08-07 · 代码消息最大高度 + 图片复制改下载 + 复制成功提示）
- **用户需求**：①代码消息有最大高度限制；②所有图片消息复制按钮改下载（行为也改下载）；③复制消息没有成功提示。
- **实现**：
  - 代码消息最大高度：`.card.code pre` 加 `max-height: 240px`（保留 `overflow:hidden`，超出截断，点击卡片进预览看全）。
  - 图片消息复制→下载：app.ts image 分支 `copyImgBtn`（copyImage canvas 复制）→ **`downBtn`**（`<a download>` 下载）；删除不再使用的 `copyImage` 私有方法。
  - 复制成功提示：`copyText` 加 `.then(() => this.flash("已复制"))`（此前仅 catch 失败提示）。
- **验证**：代码 pre maxHeight=240px + overflow hidden ✓；图片卡片 ovl 按钮为 `a[download]`"下载"、无复制按钮 ✓（截图确认 bg.jpg 等多张图片均显示下载）；copyText mock clipboard 成功 → flash"已复制" ✓。已登记 PROJECT_LOG.md。


### 本轮改动（2026-08-07 · 文字/链接/代码复制无成功提示修复）
- **用户反馈**：「文字消息，链接消息，代码消息都没有复制成功的提示」。
- **根因**：所有复制路径（`copyText`/`copyCode`/`previewAction`）都用 `navigator.clipboard.writeText`，且 `if (!navigator.clipboard) return;` 静默返回。**局域网 HTTP（非安全上下文）下 `navigator.clipboard` 为 `undefined`** → 复制直接静默失败，无任何提示。
- **修复**（packages/web/src/app.ts）：新增统一 `copyToClipboard(text): Promise<boolean>`——优先 `navigator.clipboard.writeText`（安全上下文），**降级 `document.execCommand("copy")`（textarea+select，无需安全上下文，局域网也可用）**；`copyText`/`copyCode`/`previewAction`（预览代码复制）统一接入并始终提示：成功 `flash("已复制")`/`flash("代码已复制")`，失败 `flash("复制失败，请手动复制")`。
- **验证**（局域网页 isSecureContext=false、navigator.clipboard 不存在）：copyExec 降级返回 true（实际复制成功）✓；文字消息复制 →"已复制"✓；链接消息（含 URL 文字）复制按钮 →"已复制"✓；代码消息复制 →"代码已复制"✓。已登记 PROJECT_LOG.md。

### 本轮改动（2026-08-07 · clipboard.js 复制 + 全部按钮防抖 + 通知弹窗池）
- **用户反馈**：「①用经典的 clipboardjs 库实现复制，而不是自己写；②全部按钮都要防抖；③消息通知弹窗应该是一个弹窗池子，可能同时存在很多消息通知弹窗」。
- **① 复制改用经典 clipboard.js 库**（packages/web）：安装 `clipboard@2.0.11` + `@types/clipboard@2.0.10`；app.ts 删除自写 `navigator.clipboard`/`execCommand` 方案，`import ClipboardJS from "clipboard"`；`copyToClipboard(text)` 改为：创建临时隐藏 button → `new ClipboardJS(el, { text: () => text })` → `el.click()` 触发，success→true / error→false，2s 兜底超时判定失败。文字/代码/预览复制统一接入，提示逻辑不变。
  - **坑①**：clipboard.js 内部用 `document.querySelectorAll(selector)` 查找触发器，**无法穿透 lit shadow DOM**，故必须传元素实例（编程式）而非选择器字符串。
  - **坑②**：程序化 `el.click()` 的事件 isTrusted=false，但 execCommand('copy') 依赖用户真实点击建立的 transient activation（数秒窗口），因此复制入口必须在真实点击手势内调用（现状均满足）。
- **② 全部按钮防抖**（app.ts）：新增 `clickGuard: Map<string,number>` + `debounceKey(key, wait)`（**leading 语义：首次点击立即执行，wait 毫秒内重复点击直接忽略**，防连点重复触发；map 超 1000 条时清理 30s 前的旧键）。覆盖全部 `<button @click>`（二维码/主题/文件/代码模式×2/发送×2/加号/相册/拍照/文件/删除/复制×2/播放/预览关闭/预览复制下载/预览删除/通知确认与关闭）、回车发送、链接打开（openTextLink）、下载链接（downBtn preventDefault）。防抖窗口：发送/重命名 600ms、复制/下载 800ms、删除 500ms、其余 300ms、通知重连保留原 3s。
- **③ 通知弹窗池**（app.ts + app.css）：`notice` 单对象 → `notices: {id,level,message}[]` 数组 + `noticeSeq`；`showNotice` 每次追加独立弹窗（**可多个并存**）、新增 `dismissNotice(id)` 单独关闭、`confirmNotice(id)` 保留 3s 防抖重连后移除该条；`renderNotice` 渲染全部面板，各带 ✕ 关闭 + 「确认并重连」。CSS：`.notice-mask` 改 `flex-direction:column` 垂直排列 + gap:16px + overflow-y:auto；`.notice-panel` 加 `position:relative`，新增 `.nclose` 右上角 ✕ 关闭按钮样式。
- **验证**（局域网页 14100）：
  - 复制：文字消息真实点击 →「已复制」✓；代码消息 →「代码已复制」✓；代码预览复制（previewAction）→「代码已复制」✓（均 ClipboardJS success，局域网 HTTP 非安全上下文下正常工作）。
  - 防抖：复制按钮同步连点两次 → flash 仅触发一次（第二次被 800ms 窗口拦截）✓。
  - 通知池：注入 3 个通知 → 3 个 `.notice-panel` 并存、各有 ✕ 与确认按钮、标题/等级正确（error 红/warn 黄/shutdown 红）、mask flex column；dismiss 一个后剩 2 ✓；截图确认视觉正常。
- 构建：web 116.83 kB（含 clipboard.js）。纯前端改动，服务器无需重启。

### 本轮改动（2026-08-07 · 提示弹窗池 + 全部半透明黑色遮罩改无色磨砂）
- **用户澄清**：「我指的是提示弹窗（toast），不是通知弹窗」+「所有的半透明黑色遮罩改为无色磨砂遮罩」。
- **① 提示弹窗（toast）改为弹窗池**（app.ts + app.css）：上一轮误将通知大窗（notice）做成池子；用户澄清真正要的是**提示 toast 池**。`toastText/toastShow/toastLeaving` 单对象 + `tipTimer/tipClearTimer` → `toasts: {id,text,leaving}[]` + `toastSeq`；`flash(text)` 每次追加一个独立 toast：立即 show → 2200ms 后加 `leaving`（淡出上移）→ 再 700ms 从数组移除；`render` 用 `.toasts` 容器（fixed bottom 居中、flex column、gap 10px、pointer-events:none）渲染多个 `.toast`（各自 show/leaving 动画，leaving 仅 `translateY(-24px)`，因居中移到容器不再需要 translateX(-50%)）。**验证**：连续 flash 3 个 → 3 个 toast 并存全 show ✓、文字正确 ✓、2.9s 后全部移除 ✓、2.3s 时第一个进入 leaving ✓、截图确认垂直排列 ✓。**说明**：通知大窗（notice）上一轮已改池子（多通知并存），与本次澄清不冲突，予以保留。
- **② 所有半透明黑色遮罩改无色磨砂**（app.css + index.html）：新增主题变量 `--frost-bg`（light `rgba(255,255,255,.42)` / dark `rgba(42,48,58,.5)` 中性无色）+ `--frost-line`（磨砂边框）。四处遮罩/背景统一改 `background: var(--frost-bg)` + `backdrop-filter: blur(...)`：
  - `.mask`（弹层遮罩）rgba(0,0,0,.45) → blur(14px)
  - `.notice-mask`（通知遮罩）rgba(0,0,0,.55) → blur(14px)
  - `.viewer`（全屏预览）rgba(0,0,0,.94) → blur(24px)，文字 `#fff`→`var(--ink)`、关闭按钮 `#fff`→`var(--ink)`（保证磨砂亮背景上可读）
  - `.toast` 背景 rgba(0,0,0,.6) → `var(--frost-bg)` + blur(12px) + `1px solid var(--frost-line)` + 文字 `#fff`→`var(--ink)`（磨砂气泡）
  - **不改**：图片底部 `.ovl` 渐变 rgba(0,0,0,.7)、代码背景 #282c34（非遮罩）。
- **验证**（局域网页 14100）：light 下 toast/mask/viewer/notice-mask 背景均 `rgba(255,255,255,.42)` + 对应 blur、文字 #525658 可读 ✓；dark 下 `rgba(42,48,58,.5)` + 文字 #bec8d1 可读 ✓；截图确认磨砂（背后内容模糊）✓。web 117.20 kB，纯前端，服务器无需重启。

### 本轮微调（2026-08-07 · 磨砂更细腻 + 提示弹窗去边框）
- **用户反馈**：「磨砂更加细腻一点，提示弹窗不需要边框」。
- **改动**（packages/web/src/app.css）：
  - **磨砂更细腻**：各遮罩 `backdrop-filter: blur()` 值提高——`.mask`/`.notice-mask` 14px→**22px**、`.viewer` 24px→**36px**、`.toast` 12px→**22px**（更高 blur = 更柔和细腻的磨砂质感，仍保持 `--frost-bg` 中性无色）。
  - **提示弹窗去边框**：`.toast` 删除 `border: 1px solid var(--frost-line)`（保留磨砂背景 + 阴影 + 圆角）。
- **验证**（局域网页 14100）：toast/mask/viewer/notice-mask 计算样式 blur 分别为 22/22/36/22px ✓；toast `border-top: 0px none`（无边框）✓；截图确认磨砂更柔和、toast 无边框 ✓。web 117.17 kB，纯前端，服务器无需重启。

### 本轮改动（2026-08-07 · 移动端打磨批次 1：点击复制/长按删除/卡片适配/输入条/安全区）
- **用户**：「桌面端搞定，一起打磨移动端」。确认方向（多选）：文字消息点击气泡直接复制、长按删除消息、图片/视频卡片适配、底部输入条布局、刘海屏安全区；**logo 与桌面端一致，不要状态圆点**。
- **① 文字消息点击复制（移动端）**（app.ts + app.css）：`renderMsg` 加 `mobile = window.innerWidth <= 640`；移动端文本消息**不渲染复制按钮**，气泡 `@click` → 新方法 `copyBubble(e,m)`（`.bubble-link` 链接点击放行给 openTextLink；delBubble/blockClick 窗口内不复制；防抖 800ms）。CSS 移动端 `.card.text .bubble{cursor:pointer}`。桌面端保留复制按钮不变。
- **② 长按删除确认气泡（移动端）**（app.ts + app.css）：新增 `delBubble:{id,x,y,above}|null` state + 长按逻辑 `msgPressStart`（仅 innerWidth<=640 且非 sheet/preview，长按 500ms）→ `openDelBubble` 按消息 `getBoundingClientRect` 定位气泡（下方放不下则 `above` 上翻+箭头朝下）；`msgClickGuard` 点击消息关闭气泡/屏蔽长按后 click（`blockClickUntil` 600ms）；`copyBubble`/`openPreview` 均检查 `delBubble`/`blockClickUntil`；气泡渲染在 render 末尾（fixed z-700，`del-bubble`+`.db-text`+`.db-ops` 取消/删除，`::before` 三角箭头，`.above` 箭头朝下）。确认 → `confirmDelBubble` → `deleteMsg`（走服务器广播删，真实多端同步）。**注意：注入假消息删不掉是正常的（服务器不识别），真实消息由服务器回 del 帧移除**。消息元素加 `data-id` 供定位。
- **③ 图片/视频卡片移动端适配**（app.css）：`@media(max-width:640px)` 图片 `.card.img .thumb` 16:9→**4:3**（上传占位卡 `.card.upload-ph.image .ph-body` 同步 4:3）；渐变覆盖层/放大图标/播放图标沿用桌面通用（`::after` 已在）；视频保持 16:9。
- **④ 底部输入条代码模式布局**（app.css + app.ts）：移动端 `.composer-inner{position:relative}`；`.composer-inner .bracebtn` **absolute 压输入框右上角 right:48px**；`.composer input{padding-right:56px}` 让位；`footer.composer.code-mode`（**模板补加 class**）隐藏 `.addbtn`+`.composer-inner>.input`、`.sendbtn` absolute right:0、`.composer-inner{min-height:40px}`；代码编辑器在 footer 内展开。**坑：CSS 选择器 `footer.composer.code-mode` 依赖模板加 class，漏加则样式不生效**。
- **⑤ 刘海屏安全区**（app.css + index.html 已有 viewport-fit=cover）：移动端 header.app `padding-top:calc(8px+env(safe-area-inset-top))`、footer.composer `padding-bottom:calc(8px+env(safe-area-inset-bottom))`、.panel/.viewer .vtop/.viewer .vfoot/.toasts 均加 safe-area。
- **验证**（移动 390×844 + 桌面 1280 回归）：文本无复制按钮✓、点击气泡「已复制」✓、图片 ratio 0.75(4:3)+放大图标✓、长按弹出删除气泡定位正确✓、取消保留/删除提示✓（真实删除靠服务器）、代码模式 addbtn+input 隐藏、sendbtn absolute right:0、bracebtn right:48px、code-editor open✓、header safe-area padding 8px（无刘海环境=0）✓、桌面端复制按钮/删除角标不变✓、截图正常✓。web 121.10 kB，纯前端，服务器无需重启。

### 本轮改动（2026-08-07 · 移动端打磨批次 2：代码框在上/真实波形/单行居中/磨砂遮罩/上滑动画/缩回动画）
- **用户 6 项需求**：
- **① 移动端代码输入框应在上**（app.css）：`footer.composer .code-editor` 移动端改为 **`position:absolute; left/right:10px; bottom:calc(100% + 8px)`**（悬浮在输入条上方覆盖主界面，不再向下展开）；`flex:none; width:auto; max-height:none; margin:0; border:1px; border-radius:12px; box-shadow:0 -6px 24px`；textarea min-height:150 max-height:240。验证：ce absolute、bottom 64px、width 368px、截图 ✓。
- **② 移动端音频消息没有波形条（根因：占位波形是等高平条 40% 无起伏）**（app.ts）：`waveBars` 无真实峰值（`/api/wave` 未加载/失败）时改为**模拟真实波形**：96 柱，包络 `0.12+0.88*exp(-((t-0.55)/0.22)^2)`（中间密集高振幅、两侧渐低）+ 相邻平滑噪声 `0.3*noise+0.7*prev`（`Math.sin(i*12.9898)*43758.5453 % 1`）。验证：30 种不同柱高、两侧低中间高 ✓、截图见真实波形起伏 ✓。
- **③ 移动端文字消息单行不上下居中**（app.css）：移动端 `.card.text .bubble` 原 `padding:12px 14px 0`（底部 0 偏上）→ **`padding:14px`**（上下对称居中）。验证：padTop=padBottom=14px ✓。
- **④ 移动端代码模式加磨砂遮罩、点击空白关闭**（app.ts + app.css）：render 末尾 `codeMode && innerWidth<=640` 时渲染 `.code-mask`（fixed inset:0 z-index:60，`--frost-bg` + blur(14px)），点击 → `debounceKey("code-mask")` → `codeMode=false`；`footer.composer` 移动端 `z-index:65`（输入条+代码框在遮罩之上可操作，主界面被盖住不可操作）。验证：codeMask 存在、blur(14px)、点击后 codeMode=false 遮罩消失 ✓。
- **⑤ 移动端设置/二维码界面上滑动画**（app.css）：移动端 `.panel { animation: sheetUp .28s ease }` + `@keyframes sheetUp { from{transform:translateY(100%)} to{transform:translateY(0)} }`（lit 每次打开 sheet 重新渲染 panel → 触发上滑）。验证：animationName sheetUp、dur 0.28s ✓。
- **⑥ 桌面端关闭代码模式缩回动画**（app.css）：`.code-editor` 从 `display:none`（无法过渡）→ **`display:flex; flex:0 0 0; width:0; max-height:0; opacity:0; transition:max-height .25s, opacity .2s`**（收起不占空间）；`.upload-row.code-mode .code-editor, .code-editor.open { flex:1 1 0; width:auto; max-height:460px; opacity:1 }`（展开）。**坑：收起若保留 flex:1 会与输入框各占一半宽度 → 必须 flex:0 + width:0**；移动端覆盖 `width:auto` 防 absolute 定位被 width:0 锁死。验证：开→maxH 0→460/opacity 1、关→460→0/opacity 0 过渡 ✓、input 恢复 ✓、收起 flex 0 width 0 布局正常 ✓。
- 验证环境：移动 390×844 + 桌面 1280 回归，截图全部正常。web 122.22 kB，纯前端，服务器无需重启。

### 本轮改动（2026-08-07 · 移动端打磨批次 3：去版本字样/语言下移/下拉统一/波形可见/滚轮屏蔽/双指缩放）
- **用户 6 项需求**：
- **① 去掉 logo 的「v6.0.0-alpha1 · 网页端」字样**（app.ts）：`<div class="logo">filesyncEX<small>v6.0.0-alpha1 · 网页端</small></div>` → 去掉 `<small>`。桌面/移动端一致。验证：logoText="filesyncEX" ✓。
- **② 移动端代码模式语言/选项放下面**（app.css）：`footer.composer .code-editor` 加 `flex-direction: column-reverse`（textarea 在上、`.ce-top` 语言栏在底部）。验证：ceFlexDir=column-reverse、ceTop 在 textarea 下方 ✓、截图 ✓。
- **③ 桌面/移动端语言下拉框风格统一**（app.css）：`.ce-top select` 加 `appearance:none; -webkit-appearance:none; -moz-appearance:none` + 自定义下拉箭头（`url(data:image/svg+xml,…) no-repeat right 8px center`）+ `padding:5px 24px 5px 8px` + `:focus` 边框 primary（两端共用同一规则，彻底一致，不再依赖浏览器原生 select 外观）。验证：appearance none、bgImage 含箭头、padding-right 24px ✓。
- **④ 移动端音频波形不可见（用户排查：元素存在，怀疑颜色）**（app.ts + app.css）：**根因：柱条颜色 `var(--muted)` 灰 + 占位模拟波形两端最小高度太小（6%）→ 两端柱条仅 ~2.7px 几乎看不见**。修复：①颜色 `.card.audio .wave i` `background: var(--muted)` → **`var(--accent)`（薄荷绿醒目）**、`.played` `var(--accent)` → **`var(--primary)`**；②`waveBars` 最小高度 `Math.max(6/8)` → **`Math.max(8)`（真实）/`Math.max(10)`（模拟）**，两端不再细到不可见。验证：barBg=rgb(134,206,203) accent、两端柱条 ~3.4px、wave align-items center、截图波形清晰可见 ✓。
- **⑤ 移动端代码模式屏蔽主界面滚轮**（app.ts）：`code-mask` 加 `@wheel` → `e.preventDefault(); e.stopPropagation()`；`onHostWheel` 开头加 `if (this.codeMode && window.innerWidth<=640) return;`（双保险）。验证：对 mask dispatch wheel → defaultPrevented=true ✓。
- **⑥ 移动端图片预览双指缩放**（app.ts）：图片预览 `<img>` 加 `@touchstart/@touchmove/@touchend/@touchcancel`；新方法 `touchStart/touchMove/touchEnd` + `pvTouch` state + `touchDist`：**双指 pinch 围绕图片当前中心缩放**（`k=s2/z.s`，`tx += r.width/2*(1-k)` 保持中心不动，clamp 1~8，s<=1 时重置清 transform）；**单指 pan 平移**（仅 s>1 时）；`e.preventDefault()` 防页面缩放/滚动。**坑：tsconfig noUncheckedIndexedAccess → `e.touches[0]!`/`touches[1]!` 需非空断言**。验证：两指 20→100px pinch 后 s=5、transform translate(0,0) scale(5)、touchend 后 pvTouch=null ✓。
- 验证环境：移动 390×844（波形/代码模式/select/滚轮/双指缩放）+ 桌面 1280 回归（代码编辑器/删除角标正常）。web 123.98 kB，纯前端，服务器无需重启。

### 本轮改动（2026-08-07 · 移动端打磨批次 4：seek 播放位置/语言放输入条/下拉向上/下拉圆角）
- **用户 4 项需求**：
- **① 拖动音频进度条到中间后自动播放，却从最前面播**（app.ts seekAudio）：**根因：新创建的 Audio（未播放过）`duration` 未知（NaN）→ `a.duration && isFinite` 为假 → `a.currentTime = ratio * duration`（NaN）无效 → `play()` 从 0 开始**。修复：`seekAudio` 分两分支——**就绪**（`readyState>=1 && duration 有限且>0`）：直接 `setTime()` + `updateWaveInd` + `playFrom()`（从目标位置播）；**未就绪**：`addEventListener("loadedmetadata")` + `a.load()`，就绪回调里 `setTime()`（跳目标位置）+ `updateWaveInd` + `playFrom()`。验证：mock duration=100 readyState=1 点 50% → currentTime=50 + played ✓；readyState=0 → load() 被调 + loadedmetadata 监听注册，触发后 duration=100 → currentTime=50 + played ✓。
- **② 移动端代码模式语言放「原本输入框的位置」**（app.ts）：composer-inner 里 codeMode 时原本渲染 codeText 输入框的位置 → 改为 `this.renderLangBar(true)`（语言栏）；移动端 `.code-editor` **去掉 ce-top**（只剩 textarea）。CSS 移动端 `.composer-inner .lang-bar{flex:1; min-width:0; padding-right:48px}`（右侧给 `{}` 让位）。验证：langInComposer=true、codeEditorHasLang=false ✓、截图 ✓。
- **③ 移动端语言下拉向上**（app.ts + app.css）：**原生 `<select>` 无法控制展开方向** → 改用**自定义语言下拉**（`renderLangBar(upward)`）：`.lang-pick`（显示当前语言 + ▾ 箭头，点击 toggle `langOpen`）+ `.lang-list`（绝对定位列表，`.lang-bar.up` → `bottom:calc(100%+6px)` 向上弹出；否则 `top:calc(100%+6px)` 向下）。点击外部关闭：`window click` 监听 `onDocClick` + lang-pick `stopPropagation`；选择语言 `debounceKey("lang-"+l)` → `codeLang=l; langOpen=false`。**桌面端 ce-top 用 `renderLangBar(false)`（向下）**。新增 `langOpen` state + `LANG_LIST`/`LANG_LABEL`/`langLabel`（替换原 `LANG_OPTS`）。验证：移动 footer lang-bar 有 `up` class、桌面 `.upload` lang-bar 无（down）✓。
- **④ 下拉框不是圆角**（app.css）：`.lang-list { border-radius: 10px; box-shadow: var(--shadow); overflow: hidden }`（自定义列表可控圆角，替代原生 select 系统弹层）。验证：radius 10px（桌面/移动）✓、截图 ✓。
- **注意**：本次 seekAudio 替换 oldString 只到 `currentTime=...` 行、newString 是完整方法 → **残留原方法尾行导致 TS 语法错误**（第一次构建失败），已手动删除残留三行修复。
- 验证环境：移动 373 + 桌面 1280，截图全部正常。web 124.54 kB，纯前端，服务器无需重启。

### 本轮改动（2026-08-07 · 移动端打磨批次 5：代码提示一致/代码框顶到头/自动聚焦/箭头向上）
- **用户 4 项需求**：
- **① 移动端代码输入框提示与桌面端一致**（app.ts）：移动端 codeMode textarea placeholder `// 粘贴代码，Ctrl+Enter 发送` → **`在这里输入代码…（保持格式）`**（与桌面端相同）。验证：mobilePlaceholder === desktopPlaceholder ✓。
- **② 移动端代码输入框没有顶到头、上面还有一截白色**（app.css）：**根因：`.code-editor` absolute 相对 `footer.composer`（position:relative），`top:0` = footer 顶部而非屏幕顶部 → 代码框从 footer 顶部向下，顶部露出主界面/遮罩**。修复：`top: calc(100% - 100dvh)`（100%=footer 高、100dvh=视口高 → 负值使元素顶部上移到屏幕顶），`bottom: calc(100% + 8px)`（输入条上方 8px）；`border-radius: 0 0 12px 12px`（顶部直角顶到头）、`textarea max-height: none`（flex:1 撑满，去掉原 240px 限制）。验证：ceTop=0（顶到屏幕顶）、ceAboveInput=true、截图无顶部留白 ✓。
- **③ 点击代码模式后代码输入框直接获取焦点**（app.ts）：新增 `focusCodeEditor()`：`updateComplete.then` → 按视口选 `footer.composer .code-editor.open textarea`（移动）/ `.upload .code-editor.open textarea`（桌面）→ `focus()`；两个 bracebtn（桌面 upload + 移动 composer）点击时 `this.codeMode = !this.codeMode; this.focusCodeEditor();`。**坑①：不能 `querySelector(".code-editor.open textarea")`（DOM 顺序第一个是隐藏的桌面 .upload 的）→ 必须按视口选**；**坑②：shadow DOM 内 `document.activeElement` 返回 shadow host（filesync-app），需用 `shadowRoot.activeElement` 验证聚焦**。验证：移动端点 bracebtn → shadowRoot.activeElement === footer textarea ✓。
- **④ 语言选择保持桌面端样子、只是箭头向上**（app.ts）：`renderLangBar` 箭头 `▾` → `${upward ? "▴" : "▾"}`（移动端 up 显示 ▴ 表示列表向上、桌面端 ▾ 向下），其余样式不变（.lang-bar/.lang-pick 桌面/移动共用）。验证：移动 mobileArrow=▴、桌面 desktopArrow=▾ ✓。
- 验证环境：移动 373（placeholder 一致/ceTop 0/聚焦/▴）+ 桌面 1280（▾/placeholder 一致）。web 124.84 kB，纯前端，服务器无需重启。

### 本轮改动（2026-08-07 · 移动端代码框高度改为屏幕 1/2）
- **用户澄清**：「我说的代码输入顶到头是指黑色部分相对自身父节点而言，现在把移动端代码输入框改为屏幕的 1/2」。
- **理解修正**：上一轮我把"顶到头"误做成顶到屏幕顶部（`top: calc(100% - 100dvh)`）；用户原意是 **textarea（黑色）相对代码编辑器容器顶到头**（填满容器无顶部空隙），且**高度改为屏幕一半**。
- **改动**（app.css）：移动端 `footer.composer .code-editor`：
  - `top: calc(100% - 100dvh)`（顶到屏幕顶）→ **`height: 50dvh`**（高度 = 屏幕一半），保留 `bottom: calc(100% + 8px)`（悬浮输入条上方 8px）；
  - `border-radius: 0 0 12px 12px`（顶部直角）→ **`12px`**（不再顶屏幕顶，恢复顶部圆角）；
  - `box-shadow: 0 6px 24px` → **`0 -6px 24px`**（向上投影，框在输入条上方）。
  - textarea 加 **`margin-top: 0`**（去掉全局 `.code-editor textarea` 的 `margin-top: 8px`，**黑色区域顶到容器顶部**，无白色间隙）。
- **验证**（移动 373×800）：代码框高度 402px ≈ 屏幕一半（400）✓、`heightIsHalf` true ✓、textarea `margin-top 0`、顶部与容器间隙仅 1px（边框）→ **黑色填满容器** ✓、textarea 高度占比 1.00、代码框在输入条上方 ✓、截图（半屏 + 黑色顶到容器顶 + 语言栏 ▴ + 磨砂遮罩）✓。
- web 124.83 kB，纯前端，服务器无需重启。

### 本轮改动（2026-08-07 · 移动端设置隐藏工具栏 + 上传按钮直接选文件）
- **用户 2 项需求**：
- **① 移动端设置界面不要有"下载工具"那一栏**（app.ts + app.css）：renderSheet 设置面板的「工具」部分（hr + `st-sec 工具` + `a.btn.tool 下载 QuickSendTool` + 安装提示）包一层 `<div class="tool-sec">`；移动端 `@media(max-width:640px)` 加 `.settings .tool-sec { display: none; }`。桌面端设置面板仍显示工具栏。验证：移动端 toolSec display:none、设置面板只剩 连接/昵称/设备指纹/关于（截图确认无 QuickSendTool）✓。
- **② 移动端去掉「发送内容」界面，点上传按钮直接选文件**（app.ts）：`footer.composer .addbtn` 原 `@click` → `this.sheet = "attach"`（打开发送内容面板）改为 `this.debounceKey("file",400)` → `this.shadowRoot.querySelector(".file-input")?.click()`（直接触发隐藏 file input 打开文件选择器）。attach sheet（相册/拍照/文件占位）代码保留但不再被 addbtn 触发。验证：点加号 → file input click 被调用（fileClicked=1）且出现系统文件选择对话框、`sheet !== "attach"`（未打开发送内容）✓。
- 验证环境：移动 373。web 124.97 kB，纯前端，服务器无需重启。

### 本轮改动（2026-08-07 · 回滚「移动端设置隐藏工具栏 + 上传按钮直接选文件」）
- **用户**：「立马回滚本次修改」。回滚最近一次实际代码改动（移动端设置隐藏工具栏 + 上传按钮直接选文件）。
- **回滚内容**（app.ts + app.css）：
  - `footer.composer .addbtn`：`this.shadowRoot.querySelector(".file-input")?.click()`（直接选文件）→ 恢复 `this.sheet = "attach"`（打开发送内容面板：相册/拍照/文件）。
  - 设置面板「工具」部分：去掉 `<div class="tool-sec">` 包裹，恢复直接渲染 hr + st-sec 工具 + 下载 QuickSendTool + 安装提示（移动端重新显示下载工具栏）。
  - app.css 移动端：删除 `.settings .tool-sec { display: none }`。
- **验证**（移动 390）：设置面板恢复含 QuickSendTool（tool-sec 已无包裹、toolSecDisplay n/a）✓；点加号 → `sheet === "attach"`（打开发送内容：相册/拍照/文件）、file input 未触发（fileClicked=0）✓。
- 构建 124.83 kB，纯前端，服务器无需重启。
## [6.0.0-alpha1] 移动端语言选择控件改回默认长度（用户反馈）
- 用户指出移动端语言选择触发控件被拉长。根因：移动端代码模式 `.composer-inner .lang-bar { flex: 1 }` 使语言栏占满输入行、`.lang-pick`（flex:1）随之拉满。
- 修复：移动端 `.composer-inner .lang-bar`、`.composer-inner .lang-pick` 改 `flex: none`（不拉伸，与桌面端一致保持自然默认长度）；桌面端不受影响。
- web 构建 125.01 kB；Playwright 验证：移动端 lang-pick 宽 290px → 106px（flex 0 0 auto）、桌面端仍 946px（flex 1 1 0%）✓。
## [6.0.0-alpha1] 桌面端语言选择控件也改为不拉伸（用户反馈）
- 续上一条：桌面端语言触发控件同样由 `flex:1` 拉伸改为不拉伸。修改 `.lang-pick` 基础样式 `flex:1` → `flex:none`（桌面端/移动端共用基础样式，两处一致；移动端 `.composer-inner .lang-pick` 覆盖保留）。
- web 构建 125.01 kB；Playwright 验证：桌面端 lang-pick 946px → 106px（flex 0 0 auto）、移动端仍 106px ✓。
## [6.0.0-alpha1] 桌面端语言选择列表截断修复（用户反馈）
- 根因：`.lang-pick` 改 `flex:none` 后，绝对定位的 `.lang-list`（`left:0; right:0`）宽度跟随触发控件（106px），语言选项（如 TypeScript / INI / Config / Batch (.bat)）被截断。
- 修复：`.lang-list` 加 `min-width:150px`（两端共用）。
- web 构建 125.03 kB；Playwright 验证：列表宽 152px、scrollW==clientW==150 无截断、9 项全部可见（TypeScript…CSS）✓。
## [6.0.0-alpha1] 桌面端语言列表上下截断修复（用户反馈）
- 根因：`.code-editor { overflow: hidden }`（用于圆角裁剪）裁剪了向下弹出的绝对定位 `.lang-list`——code-editor 实际高仅 204px，列表 290px，从第 6 项（JSON）起被裁剪，只剩前 5 项。
- 修复：移除 `.code-editor` 的 `overflow: hidden`，圆角改由子元素承担：`.ce-top` 加 `border-radius:10px 10px 0 0`、桌面 textarea 加 `border-radius:0 0 10px 10px`、移动端 textarea 覆盖 `border-radius:12px`。
- web 构建 125.09 kB；Playwright 验证：桌面 ce overflow visible、9 项全渲染可见（147-437px）、ce-top/textarea 圆角正确；移动端同样 9 项完整、ta radius 12px ✓。
## [6.0.0-alpha1] 语言选择箭头放大 3 倍（用户反馈）
- `.lang-arr`（语言触发控件右侧小箭头 ▾/▴）`font-size: 10px` → `30px`（放大 3 倍），加 `line-height: 1` 防裁剪；桌面/移动共用基础样式。
- web 构建 125.10 kB；Playwright 验证：桌面/移动箭头均 30px、高 30px 完整显示（▾ / ▴）✓。
## [6.0.0-alpha1] 语言箭头 30px → 20px（用户「不好看，改为 20px」）
- 续上条：`.lang-arr` 字体 `30px` → `20px`（保留 `line-height:1`）。
- web 构建 125.10 kB；Playwright 验证：桌面箭头 20px、高 20px 完整显示（▾）✓。
## [6.0.0-alpha1] 移动端长按删除三项优化（用户 3 项）
- ①气泡箭头描边：新增 `::after` 描边三角（大 1px，`--line` 色）+ 原 `::before` 填充三角（`--bg` 色，z-index:1 盖住中间留出描边），`.above` 方向同步。
- ②按钮文字居中：`.del-bubble .db-ops .btn` 加 `justify-content: center`（基础 .btn 是 inline-flex 无水平居中）。
- ③选中消息浮起 + 磨砂遮罩：`.msg` 按 `delBubble.id` 加 `del-selected` class（z-index 695、translateY(-4px) scale(1.02) + 阴影浮起）；新增 `.del-mask` 磨砂遮罩（fixed inset0、z-index 690、--frost-bg + blur 14px）盖住其他消息；气泡 z-index 700 在其上；点击遮罩 → `closeDelBubble()` 取消删除。
- web 构建 125.88 kB；Playwright 验证：箭头 ::after 描边色 --line / ::before 填充 --bg ✓、btn justify-content center ✓、del-selected + transform 浮起 + 阴影 + z695 ✓、del-mask z690 blur14 ✓、点击遮罩后 delBubble 关闭 ✓、截图 ✓。
## [6.0.0-alpha1] 移动端长按屏蔽原生事件 + 气泡上方位置/箭头修复（用户 2 项）
- ①屏蔽原生长按：移动端 `.msg, .msg *` 加 `user-select:none; -webkit-user-select:none; -webkit-touch-callout:none`（屏蔽文字选取 + iOS 图片长按菜单）；`.msg` 加 `@contextmenu` handler（≤640px 时 preventDefault，屏蔽 Android 长按系统菜单）。
- ②气泡在上方（above）位置/箭头修复：根因 `.del-bubble` 是 content-box（`width:200px` + padding 24 + border 2 = 实际 226px），且 `openDelBubble` 估算 `bh=118`（实际气泡仅约 88px）→ 上方时气泡离消息 38px 空隙、箭头水平偏 13px 未对准消息中心。修复：`.del-bubble` 加 `box-sizing:border-box`（实际宽 200px，箭头对准）、`bh` 118→90（上方空隙缩到 3px 紧贴消息）。
- web 构建 126.04 kB；Playwright 验证：user-select none ✓、contextmenu 被 preventDefault ✓（用目标元素监听而非 document，合成事件需 composed:true 才能穿 shadow boundary）、气泡 w200 box-sizing border-box ✓、above 空隙 3px（原 38px）✓、箭头偏移 0 对准消息中心 ✓、截图 ✓。
## [6.0.0-alpha1] 移动端长按：上方箭头可见修复 + 浮起去背景（用户 2 项）
- ①上方箭头不可见根因：`.del-bubble.above::before/::after` 用 `border-top-color` 只设颜色，但 base 里 `border-top: none` 已把顶部边框宽度清零，`above` 又 `border-bottom: none` → 四边全 0 宽，箭头完全不可见（实测 borderTop `0px none`、height `0px`）。修复：above 变体改 `border-top: 6px solid var(--bg)` / `7px solid var(--line)`（恢复顶部宽度，朝下三角可见）。
- ②浮起去背景：`.msg.del-selected` 去掉 `box-shadow`（整行阴影呈背景块感），仅保留 `transform: translateY(-4px) scale(1.02)` 浮起（头像/用户名日期/消息体随行浮起，无背景块）。
- web 构建 126.00 kB；Playwright 验证：above 箭头 borderTop 6px/7px solid 可见 ✓、msg box-shadow none ✓、transform 保留 ✓、截图 ✓。
## [6.0.0-alpha1] 移动端 header 高度减少（用户「头顶空白区域太多」）
- 根因：基础 `header.app { margin-top:20px }` 未在移动端覆盖，移动端只覆盖了 padding/margin-bottom → 头顶 20px margin + 8px padding 空白。
- 修复：移动端 `header.app` 加 `margin-top:0`、顶部/底部 padding `8px` → `6px`（保留 safe-area-inset-top）。
- web 构建 126.01 kB；Playwright 验证：margin-top 0、padding-top/bottom 6px、header 顶部 0（原 28px 空白）、截图 ✓。
## [6.0.0-alpha1] 桌面端 header 高度也减少（用户「桌面端的也减少一点」）
- 基础 `header.app`：`margin-top` 20→8px、`padding` 12/16 → 10/12px、`margin-bottom` 16→10px。
- web 构建 126.01 kB；Playwright 验证：桌面 margin-top 8px、padding 10/12px、margin-bottom 10px、header 高 61px、截图 ✓。
## [6.0.0-alpha1] 移动端删除模式禁止滚动 + 滑动退出（用户需求）
- 新增 `delMoveHandler`（window touchmove，passive:false）：删除气泡打开期间 `preventDefault()` 禁止滚动，且滑动立即 `closeDelBubble()` 退出删除模式。
- `openDelBubble` 末尾 `addEventListener("touchmove", ...)`；`closeDelBubble` / `confirmDelBubble` 移除监听（关闭后滚动恢复）。
- web 构建 126.30 kB；Playwright 验证：长按打开 ✓、滑动被 preventDefault（scroll 未动）✓、滑动后气泡关闭 ✓、可重开 ✓、点遮罩关闭且监听移除后滚动恢复（不再 preventDefault）✓。
## [6.0.0-alpha1] toast 提示改为实底（用户「提示弹窗改为实底，不要半透明磨砂」→ 确认为 toast）
- `.toast`：背景 `var(--frost-bg)` + blur(22px) 半透明磨砂 → `var(--bg)` 实底、去掉 backdrop-filter blur（保留阴影）。
- web 构建 126.23 kB；Playwright 验证：toast 背景 rgb(255,255,255) 不透明、backdropFilter none、文本正常、居中 ✓。
## [6.0.0-alpha1] 音频消息波形柱改进度指示条（用户「移动端波形条看不见，所有都用指示条方式实现」）
- 根因：移动端 `.wave i` 柱状波形（96 根小柱）不可见，仅指示条可见。
- 改造（两端统一）：`waveBars`（96 根柱 + 真实峰值加载）→ `waveBar()` 进度条结构（`<i class="fill">` 已播填充 + `<i class="ind">` 指示线）；`.wave` 由 34px 柱状 → 8px 圆角轨道（`--surface-2` 背景）；`updateWaveInd` 改设 fill width + ind left；移除 `loadWave`/`wavePeaks` 及 `/api/wave` 请求；上传音频占位卡 ph-wave 同步改为进度条轨道。
- web 构建 125.54 kB；Playwright 验证：wave 高 8px、radius 4px、轨道 bg --surface-2、初始 fill 0、模拟 50% → fill width 97.7px 且 ind left 对齐、show-ind ✓；桌面端同 ✓、截图 ✓。
## [6.0.0-alpha1] 桌面端恢复音频频谱图 + 移动端保持进度条（用户「桌面频谱图也没了，只有一个进度条」）
- 上一轮误把两端都改成进度条，桌面频谱图丢失。本轮恢复：桌面端（>640px）显示 96 根频谱柱 `.bar`（模拟波形，播放整格高亮 .played + ind 竖线）；移动端（≤640px）隐藏 `.bar`、显示进度条（`.wave` 8px 轨道 + `.fill` 填充 + `.ind`）。
- 两端共用 DOM（`waveBars()` + `<i class="fill">` + `<i class="ind">`），CSS media query 按视口区分；`updateWaveInd` 同时更新 `.played`（桌面）与 `fill` 宽度（移动）。
- 上传占位卡 ph-wave 同样：桌面频谱柱 / 移动进度条轨道。
- web 构建 126.54 kB；Playwright 验证：桌面 waveH 34、96 柱、fill hidden、50%→48 柱 .played、ind 227px ✓；移动 waveH 8 轨道、bar hidden、fill block、50%→fill 97.7px ✓；截图 ✓。
## [6.0.0-alpha1] 移动端恢复音频频谱图（用户「移动端也要频谱图，里边的条用指示器方式实现」）
- 根因：移动端窄屏下 96 根频谱柱 + 2px 间距，每根仅约 0.4px 宽，几乎不可见（仅 .ind 指示条可见）。
- 修复（CSS 方案，纯响应式）：waveBars 固定生成 96 根，移动端 media query `.card.audio .wave i.bar:not(:nth-child(3n+3)) { display:none }` 每 3 根显示 1 根（32 根）+ `min-width:3px` + `flex:1 1 0` → 每根约 4px 实心条（指示器方式）可见；ph-wave 占位卡同步。桌面端保持 96 根全显示。
- web 构建 126.20 kB；Playwright 验证：移动端 96 总/32 可见/首根宽 4px/waveH 34、50%→16 根可见 .played、截图频谱可见 ✓；桌面 96 全可见 ✓。

## 工作进度临时归档（电脑重启 · 2026-08-07）
> 重启后按此恢复进行中的工作。

### 进行中（已改代码，未构建 / 未打包验证）
- **应用图标（进行中）**：
  - `FS.ico`（456KB）已从旧工程 `filesync/source/` 复制到根目录（git 未跟踪 `?? FS.ico`）。
  - `packages/shell/package.json`：devDependencies 加 `rcedit@^4.0.1`。
  - `packages/shell/scripts/package.mjs`：pkg 打包后新增 rcedit 步骤，修补 `release/filesyncex.exe` 的 icon（`FS.ico`）+ 版本信息（ProductName filesyncEX 等），参考旧工程 `filesync/plugins/rcedit.js`。
  - ⚠ **rcedit 依赖尚未 `pnpm install` 完成**（安装被中断）。重启后先 `pnpm install`，再 `pnpm run package` 验证 exe 图标。
- **伪 3D 字符 logo（进行中）**：
  - `packages/shell/src/index.ts`：新增 `ASCII_ART` 常量（旧工程 `filesync/src/server/ServerConfig.ts` 的 FS 3D 字符 logo），`main()` 开头打印。已改未构建。

### 遗留问题（上上轮）
- **better-sqlite3 打包进 exe 后运行仍报 `Invalid host defined options`，降级内存存储**：
  - 已做：`package.mjs` 打包前复制 better-sqlite3（`dereference:true` 处理 pnpm 符号链接）→ `packages/shell/node_modules/better-sqlite3`；`shell/package.json` 的 `pkg.assets` 加 `node_modules/better-sqlite3/**/*`；esbuild `--external:better-sqlite3`。
  - 已验证：exe 内已含 `better_sqlite3.node`（94MB exe，搜到 build/Release）。但运行仍报 "Invalid host defined options"（bindings 加载失败），**尚未解决**，待排查（可能需显式 `nativeBinding` 路径或 pkg scripts 处理）。

### 待办清单（重启后）
1. `pnpm install`（装 rcedit）
2. 构建验证 shell（tsc）确认 logo 打印无语法错
3. `pnpm run package` 重新打包，验证：exe 图标已改（rcedit）+ 启动打印 FS 3D logo
4. （可选继续）排查 better-sqlite3 "Invalid host defined options"

## 工作进度归档更新（2026-08-10 · 自主完成）
> 补充：上次归档的「待办清单」已全部完成，并额外修复 better-sqlite3 打包问题。

### ✅ 已完成
- **应用图标（FS.ico）+ 版本信息**：
  - 根因：@yao-pkg/pkg 不支持 icon 配置；rcedit 修补 fetched 会被 pkg 完整性校验覆盖；rcedit 修补打包后 exe 会丢失 pkg 追加的 payload（94MB→42MB，报 Pkg: Error reading from file）。
  - 破解：exe 布局 = fetched(PAYLOAD_POSITION) + payload(PAYLOAD_SIZE) + prelude(PRELUDE_POSITION/PRELUDE_SIZE)，readPrelude 函数（fetched 内）用 4 个占位符定位。rcedit 只保留 fetched、丢弃 payload+prelude。
  - 方案：新脚本 packages/shell/scripts/fix-icon.mjs：解析 4 占位符 → 提取 payload+prelude → rcedit 改 icon+版本 → 更新 PAYLOAD_POSITION/PRELUDE_POSITION → 拼回。已集成进 package.mjs（pkg 打包后执行）。
  - 结果：exe icon=FS 蓝色图标、ProductName=filesyncEX、FileVersion=6.0.0-alpha1、logo 打印、功能正常，均已运行验证。
- **伪 3D logo**：packages/shell/src/index.ts 的 ASCII_ART 在 main() 开头打印，exe 启动验证输出 FS 3D logo。
- **better-sqlite3 `Invalid host defined options` 修复（重点）**：
  - 根因 1：server 用动态 import("better-sqlite3") → pkg V8 快照环境 ModuleWrap 校验失败（node module_wrap.cc:604 host defined options）。改为静态 import Database from "better-sqlite3"（esbuild --external 转 require，走 CJS 不触发 ModuleWrap）。
  - 根因 2：better-sqlite3 依赖 bindings → file-uri-to-path，未打包进 exe → MODULE_NOT_FOUND。assets 追加 bindings/file-uri-to-path，package.mjs 一并复制。
  - 根因 3（坑）：fs.cpSync 带 filter 时 Windows 会把路径转 \\?\ 长路径前缀，p.relative 匹配失败导致整目录被 SKIP（复制后 dst 不存在，偶发）。改为无 filter 整体复制 + 复制后校验 build/Release/better_sqlite3.node 存在。
  - 结果：exe 运行无 sqlite 报错，data/ 生成 filesync.db + -wal + -shm（WAL 真实落盘），不再降级内存存储。

### 产物
- release/filesyncex.exe（106.9MB）：FS 图标 + 版本信息 + logo 打印 + better-sqlite3 正常。

## [6.0.0-alpha1] 小文件直接上传，跳过哈希/分片（用户「能不能小于一定大小的文件直接上传」）
- 背景：上传前等待 = 整文件 SHA-256 计算（纯 JS，局域网 HTTP 非安全上下文无 crypto.subtle）+ 分片。小文件（≤8MB）走这套开销大于收益。
- 改动：
  - 前端 packages/web/src/api.ts：常量 `DIRECT_UPLOAD_LIMIT = 8 * 1024 * 1024`（8MB）；新增 `apiUploadDirect`（POST /api/upload/direct，body=整个文件，query 带 name/mime/device JSON）；`uploadFile` 开头 `file.size <= 8MB` 直接上传（onProgress 立即 100%），跳过 `fileSha256` 与分片；大文件仍走分片（断点续传+秒传）。
  - 服务端 packages/server/src/upload.ts：抽公共私有方法 `finalize(name,size,mime,device,data)`（算 sha → 落盘 uploads/<sha12>_<name> → store.saveFile → 广播文件消息）；`complete` 组装分片后调用 finalize；新增 `direct()` 与 complete 共用 finalize；常量 `DIRECT_LIMIT = 8MB` 防御。
  - 服务端 packages/server/src/HttpServer.ts：新增 `POST /api/upload/direct`（express.raw limit 64mb，query 带 name/mime/device）。
- 验证（临时脚本调 run() 启动构建后 server + HTTP 实测）：direct 上传 100KB → 200、返回文件消息、落盘 c3bfc7d2d061_test_small.bin(102400) ✓；分片链路 init→chunk→complete 走 finalize 仍正常（big.bin 102400）✓；测试后已清理。
- 注意：小文件直接上传无秒传（跳过 sha 查重），可接受；阈值 8MB 如需调整改前端 DIRECT_UPLOAD_LIMIT + 服务端 DIRECT_LIMIT。

## [6.0.0-beta1] 版本改 beta + 打包优化：GZip 压缩 + 增量构建 + better-sqlite3 精简（用户「版本改 beta、包体大能否压缩、打包太慢」）
- **版本 beta**：6.0.0-alpha1 → 6.0.0-beta1（根 + 5 个 package.json + server HttpServer health + server index banner + smoke.mjs）。验证 exe VersionInfo = filesyncEX 6.0.0-beta1。
- **包体压缩**：pkg 加 `--compress GZip` → release/filesyncex.exe 106.9MB → 74.3MB（-30.5%）。fix-icon 与压缩兼容（payload 段搬移逻辑与内容无关，压缩后 payload 38.8MB 更小，PAYLOAD_POSITION+PAYLOAD_SIZE==PRELUDE_POSITION 校验仍成立）。
- **better-sqlite3 精简**：复制后删除 deps/src/node_modules（deps 是 sqlite C 编译源码 9.5MB，运行时不需要；只需 package.json + lib + build/Release/*.node）→ 12.96MB → 1.67MB。进一步减小 exe + 复制更快。
- **打包提速**：package.mjs 加 `needBuild()` 增量构建（src/public 比 dist 新才构建；protocol/core 恒建保证基础依赖，server/web/shell 增量跳过；FSEX_FORCE_BUILD=1 强制全量）。重复打包 46.5s → 38.1s（构建 ~18s 中省 ~8s；pkg 阶段 ~28s 是 GZip 压缩 + 写 74MB exe 的物理成本，无法大幅降低）。
- **坑**：`--no-bytecode` 单独用报 "no source breaks final executable"（pkg 5.16.1 packer.js：入口被标记 STORE_BLOB 且 --no-bytecode 删 BLOB 后无 STORE_CONTENT）。需 `--public` 替代（顶层源码明文，但体积 81MB > compress-only 76.6MB），故最终选 `--compress GZip`。dictionary（--no-dict=*）去掉 .pnpm 第三方包后体积无明显变化（压缩后占比小），未采用。
- 验证：exe 74.3MB 运行正常（logo + 无 err）、版本 beta1、sqlite 落盘（data/filesync.db+wal+shm）。

## [6.0.0-beta1] 端口被占用时自动切换 + 打印提示（用户「自动切换端口，并且打印提示」）
- server/src/index.ts：新增 `findFreePort(startPort, maxTries)`（net.createServer 探测空闲端口，EADDRINUSE 继续向后试，最多 20 个）；`run()` 在 listen 前探测：默认端口被占用 → 自动切到第一个空闲端口并 `console.log("  ⚠ 端口 X 已被占用，已自动切换到端口 Y")`；httpUrl/wsUrl/wsPort/返回值均改用实际端口；全部占用则报错退出（提示改 serverConfig.json 或 FSEX_HTTP_PORT，顺带去掉无效的 FSEX_WS_PORT 提示——WS 复用 HTTP 端口）。
- server/src/HttpServer.ts：health 接口 `port` 改用 `req.socket.localPort ?? cfg.httpPort`（返回实际监听端口，前端二维码/地址自动切换后显示正确）。
- 验证：①脚本级（dist）——blocker 占 4100 → 自动切 4101，health port=4101 ✓；②exe 级（release exe）——blocker 占 4100 → exe 打印「⚠ 端口 4100 已被占用，已自动切换到端口 4101」+ banner 4101 + 4101 实际监听 ✓。均已清理测试进程。
- 注：esbuild 会把中文字符转成 \uXXXX 存进 bundle.cjs/exe，用中文搜不到不代表代码没打进（改用 findFreePort 等 ASCII 标识搜）。

## [6.0.0-beta1] 全局代码清理 + 修复（用户「清理无用代码/引用，看优化点」）
- **未使用引用**（tsc --noUnusedLocals 定位）：core/Store.ts 的 DeviceInfoT import；server/index.ts 的 express import；web/app.ts 的 I_CLIP/I_BRACE/I_AUDIO/I_VIDEO 图标常量（其余图标都在用）。
- **死代码**：server /api/wave 整条链路删除（HttpServer.ts 的 /api/wave 路由 + waveCache Map + wave.ts 的 wavePeaksFromFile/peaksFromChannels——前端已改前端模拟频谱，无消费者；decodeToChannels/toWavBuffer/streamCache 保留给 /api/stream）；web api.ts 的 apiHealth/apiMsgs（无消费者）；web app.ts 的 connected state（写了从不读，UI 由 connState 驱动）。
- **去冗余 export**：web FilesyncApp/deviceFingerprint/InitUploadInput/WsHandlers；server Decoded；protocol 死类型别名 SenderT/MsgKindT/CodeMetaT/MsgInputT/UploadInitReqT/UploadChunkResT（z import 实际被 parse() 用，保留）。
- **去未用依赖**：web devDependencies @types/node（web 无 Node 代码、tsconfig types 只有 vite/client）。
- **Bug 修复**：①app.ts fmtType map 里 `mk4`→`mkv`（真实 .mkv 之前被显示成"文件"）；②预览弹窗"下载"按钮从"（原型）已开始下载"占位逻辑 → 真正用 <a download> 触发下载。
- **验证**：5 包 tsc --noUnusedLocals --noUnusedParameters 全通过 + pnpm build 9.4s 成功。
- **优化点分析**（未实施，供决策）：①clipboard 库**不能**换 navigator.clipboard（局域网 HTTP 非安全上下文无此 API，同 crypto.subtle 限制，clipboard 库的降级是必要的）；②可选：streamCache/内存缓存加 LRU 上限（防大音频占内存）、wave.ts/upload.ts 同步 fs → 异步（大文件不阻塞事件循环）、思源宋体 6MB 子集化、zod 3→4 升级（breaking changes 大，建议后续单独做）。

## [6.0.0-beta1] 性能优化 + zod v4 升级 + README 同步（用户「字体子集化不做，其他都做，同步 README」）
- **streamCache LRU**：HttpServer.ts 转码流缓存加 `STREAM_CACHE_MAX = 8` 上限 + LRU（命中刷新到末尾、超限淘汰最久未用），防大音频常驻内存。
- **异步文件 IO**：upload.ts 的 `chunk` 分片写盘改 `fs.promises.writeFile`；`complete` 改**流式组装**（createWriteStream 边读分片边写 + 流式 SHA-256，临时文件 .tmp-<id> 写完 rename 成最终 key，大文件不整块入内存）；wave.ts 的 `decodeToChannels` 改 `fs.promises.readFile`。
  - **坑**：Node `stream.end(cb)` 回调无参，写 `(e) => ...` 触发 TS7006（e 隐式 any）→ 改 `out.once("error", rej)` + `end(() => res())`。
- **zod v3 → v4**：protocol/server 升级 zod `^4.0.0`（实际 4.4.3）。
  - **坑**：protocol/core/server **之前没声明 typescript devDep**，隐式解析到旧 TS 4.9.5，无法解析 zod v4 的 `const` 类型参数（.d.cts 报 TS1005）。给这 3 个包显式加 `typescript ^5.5.4`（实际 5.9.3）统一构建版本。
- **冒烟验证**：health、上传 init(zod v4)、2 片分片 complete(流式)、下载内容一致、direct 上传 全 ✅。
- **README 同步**：删 /api/wave 接口描述（路由已删）、zod 标 v4、优化表新增（LRU/异步 IO/zod v4/死代码清理）、限制更新（音频转码已 LRU 限制）。**字体子集化按用户要求不做**（README 保留为已知限制）。
- 已重新打包 exe（75.1MB，略增因 zod v4 + 完整重建）运行验证通过（无 err、版本 beta1）。

## [6.0.0-beta1] 断点续传交互（用户三规则：小文件失败即删、大文件可点击续传、彻底失败删除）
- api.ts：`DIRECT_UPLOAD_LIMIT` 改为导出（app.ts 判断是否分片，单一来源）。
- app.ts：
  - 新增 `UploadRec` 接口（rec 加 `file?: File`，保存 File 引用供续传）。
  - `handleFiles` 失败分流：≤8MB（direct 直接上传）失败 → **移除占位卡** + toast「xx 上传失败」；>8MB（分片）失败 → **保留占位卡**标 fail（红色感叹号）+ toast「xx 上传中断，点击消息可断点续传」。
  - 新增 `retryUpload(rec)`：点击失败的大文件占位卡 → 用内存里的 File 重新 `uploadFile`（同 sha → 服务端自动断点续传）→ 成功移除占位（真实消息 WS 广播）；**再次失败**（彻底失败且无法续传）→ 删除占位 + toast「xx 续传失败，已取消」。
  - renderMsg 占位卡：`retryable = fail && file.size > DIRECT_UPLOAD_LIMIT` → 文案「上传中断 · 点击续传」（.ph-mm .name.retry 粉色）+ 卡片加 .retry class + @click 触发续传。
- app.css：`.card.upload-ph.retry { cursor: pointer; }` + `.ph-mm .name.retry { color: var(--pink); }`。
- Playwright 验证（真实 server 4190 + web/dist）：①小文件 direct 拦截 500 → 占位删除 + toast「上传失败」✓；②10MB 分片 chunk 全拦截 500（重试 4 次后失败）→ 占位保留、红色 !、文案「上传中断·点击续传」、retry 可点 ✓；点击续传（放行）→ 占位移除 + 真实消息（_t_big.bin 10MB · 文件 · 下载链接）✓。
- 已重打包 exe（75.1MB）运行验证通过（无 err、版本 beta1）。

## [6.0.0-beta1] 首次启动欢迎消息（同步旧版 filesync 的假消息）
- 旧版：ServerConfig.welcomeMsg = text「是信息，好耶！<copyright by NoRain>」；DatabaseOperation.createTable 时若 dbPath 不存在（needWellcomeMsg=false，即首次）→ writeToDatabase(welcomeMsg)。
- 同步到新版：server/src/index.ts run() 在 engine 创建后，`engine.listMessages(1)` 为空（无历史=首次启动）→ `addMessage` 插入欢迎消息：kind text、sender { deviceId:"__system__", deviceName:"系统", color:"#047878", platform:"other" }、text 沿用旧版文案。import 加 randomUUID。
- 验证：首次启动（空 sqlite 库）消息数 1「系统 | text | 是信息，好耶！<copyright by NoRain>」；二次启动（库保留）仍 1 条不重复 ✓。
- 注意：本轮回测时清空了 release/data（原为测试产生的数据），exe 首次启动会重新生成 + 插入欢迎消息。
- 已重打包 exe（75.1MB）运行验证通过（无 err、版本 beta1）。

## [6.0.0-beta1] 磨砂半透明调「硬」（用户「所有磨砂半透明硬一点，底部清晰一点」）
- index.html :root：`--frost-bg` 更实——浅色 rgba(255,255,255,0.42)→**0.8**；深色 rgba(42,48,58,0.5)→**0.85**（背景更实、更不透）。
- app.css 5 处 `backdrop-filter` blur 减小（模糊降低 → 底部更清晰）：`.mask` 22→**10**px、`.viewer` 36→**16**px、`.del-mask` 14→**6**px、`.code-mask` 14→**6**px、`.notice-mask` 22→**10**px。
- 验证：web 构建通过；Playwright 读 shadow root 编译后 adoptedStyleSheets 确认 blur(16/10/6px) + frost-bg 0.8 生效、blur(36px) 消失（.mask/.viewer 为条件渲染，未开弹层时不在 DOM，故以 CSS 定义值验证）。
- 已重打包 exe（75.1MB）。

## [6.0.0-beta1] 设置界面白天模式阴影不明显修复（用户「白天模式阴影和黑夜不一样，不够明显」）
- 根因：①设置面板弹层 .panel 本身**没有 box-shadow**（靠 frost-bg 遮罩 + surface 背景区分，白天浅白遮罩(0.8) + 浅灰面板(#f6f8fa)几乎融为一体）；②白天 `--shadow` 极淡 `rgba(4,120,120,0.08)` vs 黑夜 `rgba(0,0,0,0.4)`。
- 修复：①.app.css `.panel` 加 `box-shadow: 0 -10px 30px rgba(0,0,0,0.25)`（向上浮起阴影，白天明显）；②index.html 白天 `--shadow` 从 `rgba(4,120,120,0.08)` → `rgba(4,120,120,0.18)`（消息卡/上传条等白天阴影也明显些）。
- 验证：Playwright 打开设置面板（点 logo）→ `.panel` boxShadow = rgba(0,0,0,0.25) 0 -10px 30px ✓，截图确认白天面板浮起阴影清晰可见。
- 已重打包 exe（75.1MB）。

## [6.0.0-beta1] 设置界面去上下滑条 + 工作方式变更（用户「每次修改完不用打包 exe，只增量构建对应文件」「设置界面不要有上下滑条」）
- **工作方式变更**：用户要求以后每次修改完**不再打 exe**，只需增量构建对应包即可（web 用 `pnpm --filter @filesyncex/web build`，server 用 `--filter @filesyncex/server build`，开发用 dev server）。release exe 保持最后一次打包版本，不再随每次改动更新。
- **设置界面去滑条**：`.panel` 通用有 `max-height:88vh; overflow-y:auto`（弹层滚动条）。给 `.panel.settings-panel` 加 `max-height:none; overflow:visible`（设置面板自然高度、无上下滑条）。移动端 `.settings .tool-sec` 已隐藏（media query），小屏内容更少。
- 验证（Playwright 桌面 1280x800）：设置面板 overflowY=visible、maxHeight=none、scrollH==clientH（无滚动）、截图内容完整显示（连接/昵称/指纹/工具/关于）无滑条 ✓。
- 本次未打包 exe（按用户要求）。

## [6.0.0-beta1] body 最小宽高 + 小窗口滚动（用户「整个页面设置最小高度宽度，窗口小于时允许上下左右 body 滑条」）
- index.html <style>：桌面端（@media min-width:641px）给 html/body 设 `min-width:960px; min-height:640px`。窗口小于该尺寸时 body 被最小尺寸撑开 → 浏览器出现上下/左右滚动条；正常大窗口无滚动条；移动端（≤640）不受影响。
- 验证（Playwright）：大窗口 1280x800 → scrollW/H=视口、无滚动 ✓；小窗口 800x500 → body 撑到 960x640、hScroll+vScroll 均 true ✓。
- 本次未打包 exe（按用户要求只增量构建）。

## [6.0.0-beta1] 页面滚动条轨道透明（用户「滑条的背景最好也是隐藏的」）
- index.html <style>：给 html 设 `scrollbar-width: thin; scrollbar-color: rgba(120,130,140,0.35) transparent`（Firefox 轨道透明）+ WebKit `::-webkit-scrollbar-track { background: transparent }`、`::-webkit-scrollbar-thumb`（35% 灰圆角滑块，border 2px 透明 + background-clip:content-box 让滑块有内缩间隙）。仅作用于页面 body/html 滚动条（light DOM）；shadow 内消息列表滚动条本已隐藏（scrollbar-width:none）、代码预览轨道已透明。
- 验证（Playwright 800x500）：hScroll/vScroll true，`scrollbarColor = rgba(120,130,140,.35) rgba(0,0,0,0)`（轨道全透明），截图确认只滑块可见、轨道为页面背景色。
- 本次未打包 exe（按用户要求只增量构建）。

## [6.0.0-beta1] 拷贝旧版 favicon.ico（用户「把 filesync 旧的 favicon.ico 拷贝到当前项目」）
- 旧版位于 filesync/source/favicon.ico（5430 字节），拷贝到 packages/web/public/favicon.ico（Vite public，构建时复制到 dist 根）。
- index.html <head> 加 `<link rel="icon" href="/favicon.ico" />`。
- 验证：web 构建 dist/favicon.ico 存在；浏览器 link[rel=icon] 指向 /favicon.ico，fetch 返回 200、5430 字节 ✓。
- 本次未打包 exe（按用户要求只增量构建）。

## [6.0.0-beta1] 拷贝旧版 iOS 桌面图标 FS_apple152.png（用户「FS_apple152 也要拷贝，用于 iOS 手机桌面显示，需打包进 exe」）
- 旧版 filesync/source/FS_apple152.png（3726 字节，152x152）拷贝到 packages/web/public/FS_apple152.png（Vite public → dist 根）。
- index.html <head> 加：`<link rel="apple-touch-icon" sizes="152x152" href="/FS_apple152.png" />` + `<meta name="apple-mobile-web-app-capable" content="yes">` + `<meta name="apple-mobile-web-app-title" content="filesyncEX">`（iOS 添加到主屏幕时显示图标/标题、全屏支持）。
- 打包进 exe：web/dist/**/* 已在 shell pkg assets，favicon.ico 与 FS_apple152.png 均在 dist 根，会随 pkg 打进 exe。
- 验证：web 构建 dist 含 favicon.ico + FS_apple152.png；浏览器 link[rel=apple-touch-icon] 指向 /FS_apple152.png，fetch 200 + 3726B ✓。
- 本次未打包 exe（按用户要求只增量构建）。

## [6.0.0-beta1] apple 图标改名同步（用户「apple152 改了名字，看看需要改配置么」）
- 用户把 web/public 的 FS_apple152.png 改名为 apple-touch-icon.png（3726B）。
- 需要同步：index.html 的 `<link rel="apple-touch-icon" href="/FS_apple152.png">` → `href="/apple-touch-icon.png"`。
- 验证：web 构建 dist 含 apple-touch-icon.png；dist/index.html 引用 /apple-touch-icon.png、无 FS_apple 残留 ✓。
- 打包进 exe 机制不变（dist 根随 web/dist/**/*）。本次未打包 exe。

## [6.0.0-beta1] 修复桌面端代码编辑器收起时发送按钮闪烁（用户「代码输入框收回去的时候，发送按钮等元素会闪烁一下位置」）
- **根因**：桌面端 `.code-editor` 原为 flex 撑行高（`flex:1 1 0`），收起时行高从 ~210px 收缩到 40px，发送按钮 `.send` 从 `absolute(top:0)` 瞬间切回 normal flow 被 `align-items:center` 居中到收缩中的行中心（y 从 90 瞬跳到 175）再随行高收缩滑回 91 → 视觉"啪"地跳下去又滑上来。
- **修复（app.css）**：桌面端编辑器改为 absolute 悬浮覆盖卡片，不占行高——`.upload-row .code-editor { position:absolute; top:-10px; left:-12px; right:-12px; flex:none; width:auto; border:1px solid var(--line); box-shadow:var(--shadow); }`（top/left/right 定位模拟原 margin:-10px -12px 的卡片铺满效果；**不用 inset**，避免 bottom 把高度拉平导致编辑器塌陷到 20px，需靠内容撑开）。展开规则 `flex:1 1 0` 移除（absolute 下无效）。补边框+阴影使悬浮编辑器视觉等同卡片（原编辑器嵌在卡片内由卡片边框包裹）。
- **效果**：行高始终 = 输入行 40px，收起时发送按钮从 absolute→normal 仅 1px 位移；动画全程 `(x,y)=(1140,91)` 恒定，编辑器 210px 平滑收缩，零闪烁。移动端不受影响（`footer.composer .code-editor` 独立 absolute 覆盖）。
- 验证（Playwright 采样 rAF 每帧坐标）：进入动画 send 恒 (1140,90)、退出动画恒 (1140,91)、编辑器高度内容撑开 208/210、边框+阴影生效 ✓。
- 本次未打包 exe（按用户要求只增量构建 web）。

## [6.0.0-beta1] 补充修复代码编辑器收起"闪烁"第二根因（用户「没有跳变了，但是现在会闪烁一下」）
- **新根因**：位置不再跳变后仍"闪一下"——收起瞬间 `.send` 从 `absolute(z-index:5)` 切回 `static`（z-index 失效），而悬浮编辑器是 `absolute`（DOM 靠后、绘制在 static 之上）**正好盖住发送按钮**；发送按钮先被盖住消失，随编辑器淡出再从输入行右侧"冒出来"→ 视觉"消失又出现"= 闪烁。
- **诊断**：Playwright `shadowRoot.elementFromPoint(send 中心)` 在收起动画**全程**命中 `lang-bar`（编辑器内）而非 send，证明 send 整段被盖住不可见。
- **修复（app.css）**：给 `.upload-row .send` 设 `position:relative; z-index:6`（默认态），高于编辑器（absolute z-index:auto）——收起瞬间 send 从 absolute 切 relative 后仍在编辑器之上，全程可见；code-mode 仍由 `.upload-row.code-mode .send` 切 absolute 压编辑器右上角。
- 验证（Playwright 连续 3 次收起动画）：send 中心点 elementFromPoint 全程命中 btn send（visible=true）、y=91 恒定；非 code-mode send 位于输入框右侧（x=1145，与 input 右缘 1135 无重叠）✓。移动端不受影响。
- 本次未打包 exe（按用户要求只增量构建 web）。

## [6.0.0-beta1] 修复大文件消息删除按钮无法点击（用户「上传大文件成功后删除按钮点不了，刷新也不行，文字消息可删」）
- **根因（上一轮 absolute 悬浮编辑器的回归）**：桌面端 `.upload-row .code-editor` 常驻 DOM，改为 `absolute` 悬浮覆盖后，**收起态 `max-height:0` 但没有 `overflow:hidden`**——内部 textarea（min-height:150px）溢出可见，且编辑器 `opacity:0` **仍可交互**（opacity 不阻止 pointer-events）→ 一个不可见的 textarea 悬浮覆盖在消息区（实测 rect y:139-289）上，拦截了覆盖范围内所有点击。大文件消息在列表中部（del-corner y:224 恰在覆盖区）→ 删除按钮点不了；文字消息在更下方（y:382 超出覆盖区）→ 可删。刷新后 `.code-editor` 仍常驻，故依旧被挡。
- **诊断**：Playwright `elementFromPoint(del-corner 中心)` 命中 `TEXTAREA.code-editor textarea`（rect 996x150 覆盖消息区）而非 del-corner。
- **修复（app.css）**：`.code-editor` 基础加 `overflow:hidden; visibility:hidden; pointer-events:none`（收起态裁剪溢出 + 不可交互 + 不拦截点击），transition 加 `visibility 0s .25s`（收起动画结束后再隐藏，动画期间仍可见）；展开规则加 `visibility:visible; pointer-events:auto` + `transition visibility 0s`（展开立即显示可输入）。移动端编辑器是条件渲染（非 code-mode 不在 DOM），无此问题；`.code-editor.open` 也匹配移动端 `.open`，可见性不受影响。
- 验证（Playwright 真实上传 9MB 分片文件）：修复前 del-corner 命中 TEXTAREA 不可点；修复后命中 del-corner 内 svg，**点击删除成功**（toast「消息已删除」、文件消息移除）✓；展开态编辑器 visible/auto 可输入、收起态 hidden/none/overflow 裁剪（消息区 elementFromPoint 命中正常 bubble）✓。
- 本次未打包 exe（按用户要求只增量构建 web）。

## [6.0.0-beta1] 修复服务器 ctrl+c 关闭后界面连接状态不更新（用户「服务器命令行 ctrl+c 关闭后，logo 没变色、设置里链接状态没变」）
- **根因（server 优雅关闭挂起）**：ctrl+c → SIGINT → shell `srv.close()`。`close()` 里 `wss.close()` 只停止监听、**不主动断开已连接客户端**，随后 `httpServer.close(cb)` 等待所有连接结束——但**页面 keep-alive HTTP 连接因 keepAliveTimeout=30s（大文件上传优化）一直挂着**，导致 `httpServer.close()` 挂起 ~20s（实测 CLOSE-DONE 20140ms / 不修则永不 resolve），服务器进程不退出 → WS 保持连接 → 前端 `connState` 保持 `connected` → logo 不变色、设置连接状态不更新。（强杀进程时 TCP 断开，前端 onclose 正常变色，故此前测试"前端逻辑正常"，问题在优雅关闭路径。）
- **修复（server 两处）**：
  ① `SocketServer.close()`：遍历 `conns` **主动 `c.ws.terminate()`** 断开所有客户端（立即释放 WS socket，前端 onclose 触发；`close(1001)` 优雅帧实测仍慢 ~19s，故用 terminate）。
  ② `index.ts` close()：`httpServer.close(() => r())` 后调用 **`httpServer.closeAllConnections()`** 强制关闭 keep-alive 连接（否则 httpServer.close() 等 30s 超时）。
- 验证（Playwright + 20s 自动关闭脚本）：修复前 CLOSE-DONE 永不/20140ms；修复后 **CLOSE-DONE 509ms**（服务器秒退）；前端 logo `connected`(黛绿)→`disconnected`(红 rgb(229,72,77))✓；设置面板 `已断开（局域网）` + `dot disconnected`✓；shutdown 通知弹窗正常。
- 本次未打包 exe（按用户要求只增量构建 server）。

## [6.0.0-beta1] 思源宋体未应用修复（用户「我怎么感觉宋体没有应用上啊？」→「所有文字优先 Jet，其余字符用宋体」）
- **根因**：`index.html` 里 `--serif: "Source Han Serif CN Medium"...`（宋体）和 `@font-face` 都已定义、`public/fonts/SourceHanSerifCN-Medium.woff2` 也在，但 **app.css 所有元素 font-family 全用 `var(--mono)`**（JetBrains Mono 等宽），`--serif` 从未被引用 → 宋体完全不加载（document.fonts check false）、中文 fallback 到系统默认字体（JetBrains Mono 无中文字形）。
- **修复（index.html）**：按用户要求"所有文字优先 Jet、其余字符用宋体"，把宋体插进 `--mono` 字体栈第二候选：`--mono: "JetBrains Mono NL Medium", "Source Han Serif CN Medium", Consolas, "Courier New", monospace;`。所有用 `var(--mono)` 的元素自动获得"英文/数字/符号用 Jet、中文字符 fallback 到思源宋体"。
- 验证（Playwright）：①`document.fonts.check` 宋体 loaded=true；②canvas 像素对比——混合栈渲染中文像素与**纯宋体完全一致**（diff=0）、与纯 Jet diff=538（字形不同）→ 证明中文确用宋体渲染，英文用 Jet ✓。
- 本次未打包 exe（按用户要求只增量构建 web）。

## [6.0.0-beta1] 消息宽度拉长 + 消息内字体放大（用户「消息宽度拉长一点点，消息里字体放大一点点」）
- **改动（app.css，桌面+移动统一）**：
  - 宽度：`.card` max-width 560→**620**px；`.card.code` 640→**700**px。
  - 字体（+1px）：`.msg .head`（谁/时间）12→13；文本 `.bubble` 14→15；`.card .file .name` 14→15、`.sub` 12→13；`.card.code .code-head` 12→13、`pre` 13→14；`.ovl .mm`（图/视频信息行）12→13；`.card.audio .mm` 12→13；`.ops .btn` 12→13；上传占位 `.ph-mm`/`.ph-ops .btn`/`.ph-ring .ph-pct` 12→13。
- 验证（Playwright）：文本卡 622px+bubble15px+head13px ✓；文件卡 622px+name15px+sub13px ✓；代码卡 702px+pre14px+head13px（maxW 700）✓。移动端 .msg .body 82% 限制不因 max-width 增大受影响。
- 本次未打包 exe（按用户要求只增量构建 web）。

## [6.0.0-beta1] 设置界面 + 二维码弹窗字体放大（用户「设置界面、二维码界面的字体也放大一点点」）
- **改动（app.css）**：
  - 设置面板：`.panel label` 12→13；`.panel .fp` 11→12；`.panel .field`（昵称输入框）无显式(13.33 继承)→显式 **14**；`.settings .st-sec`（连接/工具/关于小标题）13→14；`.settings .muted`（HTTP/WS 行）12→13；`.settings .st-note`（说明）12→13；`.settings code.fp`（指纹）11→12；`.settings .btn.tool`（下载工具按钮）14→15。`.ptitle`（24px 标题）保持。
  - 二维码：`.panel.qr p`（扫码 URL 文字）12→13；`.qrbox .qr-loading` 12→13。
- 验证（Playwright）：设置面板 st-sec 14px / label 13px / field 14px / fp 12px / muted 13px / st-note 13px / btn.tool 15px ✓；二维码面板 URL 文字 13px、标题 24px ✓。
- 本次未打包 exe（按用户要求只增量构建 web）。

## [6.0.0-beta1] 旧版 NiarApp 类移植到新版项目（用户「把这个类，搬到项目里边去」）
- **来源**：`filesync/src/common/NiarApp.ts`（旧版控制台彩蛋：`window.joke()` 冷笑话 + `execute("me")` 作者信息）。
- **移植**：新建 `packages/web/src/NiarApp.ts`——去掉对旧版 `ProjectConfig` 的依赖，`jokeAPI`（https://v2.jokeapi.dev/joke/Any）内联为类内 `JOKE_API` 常量；`var/let` 改 `const`、`==` 改 `===`、fetch 加 `.catch` 静默；逻辑与作者信息字段（病雨/common_langs/interest/learning/email base64）完全保留。
- **接入**：`packages/web/src/main.ts` 加 `NiarApp.init()` + `window.NiarApp = NiarApp`（与旧版 `window.NiarApp = NiarApp; NiarApp.init(this)` 行为一致）。
- 验证（Playwright）：`window.NiarApp` 存在 ✓；`NiarApp.execute("me")` 返回完整作者信息 ✓；`window.joke()` 存在且调用返回 "Joke is coming..." ✓；web 构建通过。
- 本次未打包 exe（按用户要求只增量构建 web）。

## [6.0.0-beta1] 消除 touchmove scroll-blocking 警告（用户「Chrome 提示 Added non-passive event listener to a scroll-blocking 'touchmove'」）
- **来源**：新版 web 两个 lit 模板 `@touchmove` 绑定默认 non-passive → Chrome 性能警告：①消息列表 `.msg` 的 `@touchmove=${this.msgPressEnd}`（仅 clearTimeout 取消长按，无需 preventDefault）；②图片预览 `@touchmove=${this.touchMove}`（缩放/拖动需 preventDefault）。
- **修复（lit 3 已移除 eventOptions，改手动）**：
  - 消息列表：模板去掉 `@touchmove`；`msgPressStart` 改为 `window.addEventListener("touchmove", this.cancelLongPress, { passive: true })`（滑动取消长按走 passive，不阻塞滚动、无警告）；长按成功（500ms timer）或 `cancelLongPress` 时移除监听；`msgPressEnd` 保持原样（touchend 仍取消长按）。
  - 图片预览：`.vbody.pv-img .ph` 加 `touch-action: none`（声明该区域不响应系统触摸滚动 → touchmove 不再被视作 scroll-blocking，preventDefault 仍生效用于缩放/拖动）。
  - `window delMoveHandler`（336）本已显式 `passive:false`，不触发该警告。
- 验证（Playwright 移动视口 390 手动 TouchEvent）：滑动后 600ms 不弹气泡（passive 取消长按生效）✓、长按 600ms 正常弹删除气泡 ✓；图片预览 img `touch-action:none` ✓。桌面端长按逻辑不受影响（window.innerWidth>640 不执行）。
- 本次未打包 exe（按用户要求只增量构建 web）。

## [6.0.0-beta1] 控制台信息打印（用户「项目加入类似这里的打印」）
- **需求**：把旧版 `filesync/src/client/index.ts` 的 `printMsg()`（控制台彩色打印项目名/描述/作者/版本）加到新版。
- **实现**：`packages/web/src/main.ts` 加 `printMsg()`——项目名/版本从 `/api/health` 实时取（默认 filesyncEX / 6.0.0-beta1），作者（NoRain）与描述（"一个简单的局域网文件/文字同步服务"）为常量；三行 `console.log` 样式与旧版一致：项目名 `#e12885` 大字号 + 值 `#047878`（黛绿），标签 `#0f9d58` 绿。页面加载即打印。
- 验证（Playwright 监听 console）：刷新后输出三行——`filesyncEX：一个简单的局域网文件/文字同步服务` / `作者：NoRain` / `当前版本：6.0.0-beta1`（版本取自 health）✓。
- 本次未打包 exe（按用户要求只增量构建 web）。

## [6.0.0-beta1] 消除剩余 wheel / touchstart scroll-blocking 警告（用户「还有两个警告 wheel + touchstart」）
- **来源**：①`connectedCallback` 里 `this.addEventListener("wheel", this.onHostWheel)` 未指定 passive（onHostWheel 需 preventDefault 转发滚轮到容器，不能 passive）→ Chrome 警告；②消息列表 lit 模板 `@touchstart=${() => this.msgPressStart(m)}`（msgPressStart 不 preventDefault）non-passive 且 `.msg` 无 touch-action → 警告。
- **修复**：
  - wheel：`addEventListener("wheel", this.onHostWheel, { passive: false })` 显式声明 non-passive——Chrome 只对"未指定 passive"的滚动监听器警告，显式声明（开发者明确意图）不警告，且 preventDefault 仍生效。
  - 消息 touchstart：`.msg` 加 `touch-action: pan-y`（声明该元素仅垂直滚动 → 其上 non-passive touchstart 不再视为 scroll-blocking，不警告）；图片预览 `@touchstart` 此前已由 `touch-action:none` 覆盖，同样不警告。
- 验证（Playwright 鼠标滚轮触发滚动 + 监听 console）：wheel 滚动后 `warnings: []`（无 Violation）✓；`.msg` computed `touch-action: pan-y` ✓。
- 本次未打包 exe（按用户要求只增量构建 web）。

## [6.0.0-beta1] 消除最后一个 touchstart 警告（用户「还有一个警告 touchstart」）
- **根因**：`touch-action: pan-y` 只是辅助——**lit 模板 `@touchstart` 绑定的监听器仍是 `passive:false`**（CDP `getEventListeners` 实测），Chrome 对 lit 的 non-passive touchstart 依旧警告（警告栈指向 lit EventPart，bundle `:15`）。lit 3 已移除 eventOptions，无法在模板内设 passive。
- **修复**：消息模板去掉 `@touchstart`，改为**组件级手动 passive 事件委托**——`connectedCallback` 里 `this.addEventListener("touchstart", this.onMsgTouchStart, { passive: true })`（disconnectedCallback 移除）；`onMsgTouchStart` 用 `e.composedPath()[0]` 取**原始目标**（shadow DOM 事件重定向会把组件监听器的 `e.target` 置为 host，`closest(".msg")` 会失败）再找 `.msg[data-id]` → `msgPressStart(m)`。
- 验证（Playwright）：①CDP 确认 `.msg` 上 touchstart 监听器 `[]`、组件上 touchstart `[{passive:true}]`（无 lit non-passive）✓；②移动视口 390 composed TouchEvent——touchstart 后 `longPressTimer` 为 number（委托触发）、滑动取消长按 ✓、长按 600ms 弹删除气泡 ✓。
- 本次未打包 exe（按用户要求只增量构建 web）。

## [6.0.0-beta1] 消除图片预览 wheel/touchstart/touchmove 三警告（用户「桌面端点开图片预览弹出三个警告」）
- **根因**：图片预览 `<img class="ph">` 的 lit 模板 `@wheel`/`@touchstart`/`@touchmove` 绑定（zoomPreview/touchStart/touchMove 均需 preventDefault 缩放/拖动）默认 non-passive → 预览打开渲染时 Chrome 弹 3 个 scroll-blocking 警告（栈指向 lit EventPart）。不能 passive（会破坏缩放/拖动）；`touch-action:none` 已加但仍警告。
- **修复（app.ts）**：图片 img 模板移除 `@wheel`/`@touchstart`/`@touchmove`/`@touchend`/`@touchcancel`（保留 `@mousedown` 拖动，非滚动事件不警告）；新增 `updated()` 钩子：预览 img 存在且未标记（`dataset.pvBound`）时手动 `addEventListener` 并**显式 `{passive:false}`**（Chrome 只警告"未指定 passive"的监听，显式声明不警告且 preventDefault 有效），箭头函数保持组件 this；每次渲染后对新 img 自动重绑（re-render 重建 img 不丢绑定）。`updated` 需传 `changedProperties` 参数（TS2554 修复）。
- 验证（Playwright 桌面端）：上传图片 → 打开预览 → 滚轮缩放，console **`warnings: []`**（无 Violation）✓；img `dataset.pvBound=true`、滚轮缩放 transform `translate(...) scale(1.15)` 正常 ✓；touch-action:none 保留。
- 本次未打包 exe（按用户要求只增量构建 web）。

## [6.0.0-beta1] 移动端视频封面不显示修复（用户「为什么移动端无法显示视频第一帧作为封面」）
- **根因**：视频卡片 `<video muted preload="metadata">` 靠浏览器自动显示首帧，但**缺 `playsinline`**——iOS Safari 对无 `playsinline` 的视频按全屏视频处理、预加载被节流，不渲染首帧封面；且这种"依赖 video 元素自动显示首帧"的方式在移动端（尤其 iOS）不可靠。桌面/Chrome 正常（实测 readyState=4、1280×720）。
- **修复（app.ts + app.css）**：①消息卡 video 加 `playsinline` + `webkit-playsinline`（iOS 内联加载）；②**canvas 取首帧兜底**——video 绑定 `@loadeddata` → `captureVideoCover(m)` 用 canvas `drawImage` 取首帧转 dataURL（jpeg 0.72）存入 `videoCovers Map`（key=消息 id，防重），`requestUpdate` 后把 video 替换为 `<img class="vcover">` 封面（不依赖浏览器自动显示首帧，省流量）；③预览 `<video controls>` 也加 playsinline/webkit-playsinline；④CSS `.card.video .vthumb .vcover` 复用 object-fit cover。
- 验证（Playwright 上传真实 mp4 4.3MB）：取帧后 `hasCoverImg=true`、`coverDataLen=8235`（dataURL 有真实 JPEG 数据）、`hasVideo=false`（video 已被 img 替换）✓。iOS 低数据模式（完全不加载视频）仍无法前端解决，需服务端生成缩略图，正常移动网络下 playsinline+canvas 取帧可靠。
- 本次未打包 exe（按用户要求只增量构建 web）。

## [6.0.0-beta1] 视频封面改「前端取帧上传 + 服务器存图 + 网页加载图片」（用户「能否服务器解析第一帧，网页直接加载图片」「借用前端上传时解析第一帧上传到服务器」）
- **方案**：不用 ffmpeg（避免 exe 体积 +80MB）。**前端在上传视频前本地取首帧**（ObjectURL + video + canvas），生成 jpeg 封面**上传到服务器**，服务器存图并把封面 URL 挂到视频消息 `file.cover`；网页（任何设备含 iOS）直接 `<img src={cover}>` 加载服务器图片，不再依赖 video 解码首帧。
- **协议（schema.ts）**：`FileMeta` 加 `cover`（封面相对路径）；`UploadInitReq` 加 `coverKey`（视频上传关联封面）。
- **服务器**：①`UploadService` 加 `covers: Map<uploadId, coverKey>`（内存关联，init 存 / complete 取，断点续传客户端重带 coverKey）；`saveCover(buf)` 存 `uploadDir/<random>_cover.jpg` 返回 coverKey；`complete`/`finalize`（含 direct）meta 加 `cover: /api/file/<coverKey>`。②`HttpServer` 加 `POST /api/upload/cover`（raw jpeg → coverKey）；`/api/upload/direct` query 加 coverKey 透传。
- **前端**：`api.ts` 加 `apiUploadCover(blob)→coverKey`；`uploadFile(file, cb, coverKey?)`/`apiUploadInit`/`apiUploadDirect` 传递 coverKey。`app.ts` 加 `extractVideoCover(file)`（取帧→传封面→coverKey），`handleFiles`/`retryUpload` 对视频先取帧上传封面再传视频（`rec.coverKey` 缓存）；视频消息渲染优先 `m.file?.cover` 显示 img，历史视频（无 cover）回退 canvas 实时取帧（captureVideoCover 保留）。
- 验证（Playwright 上传真实 mp4 4.3MB）：消息 `file.cover=/api/file/049cd46e_cover.jpg`、渲染 `img.vcover`、**封面 HTTP 200 从服务器加载** ✓、hasVideo=false ✓。跨设备一致显示（img 无需视频解码），无 ffmpeg、exe 体积不变。
- 本次未打包 exe（按用户要求只增量构建 protocol+server+web）。

## [6.0.0-beta1] 视频封面纯黑修复（用户「为什么渲染出来的图片都是纯黑色的」）
- **根因**：`loadeddata` 事件触发时视频数据刚就绪，**首帧画面可能还没实际解码渲染**，此时 `canvas.drawImage` 拿到的是**黑帧**（封面图本身是黑的，非渲染问题）。
- **修复（app.ts）**：取帧前 **seek 强制解码一帧** + **纯黑检测换时间点重试**：
  - 新增 `grabVideoFrame(v)`：依次尝试 `currentTime` = 0.01/0.1/1/0.5（≤ duration*0.9），每次等待 `seeked`（800ms 超时兜底）强制解码该帧，再 `drawVideoFrame` 取帧。
  - `drawVideoFrame`：drawImage 后 `getImageData` 采样平均亮度，`< 4/255` 判为黑帧返回 null（自动试下一个时间点）。
  - `extractVideoCover`（上传前取帧）与 `captureVideoCover`（历史视频 canvas 回退）都改用 `grabVideoFrame`。
  - 顺带修 TS2532（`noUncheckedIndexedAccess` 下 `d[i]` 可能 undefined，用 `?? 0`）。
- 验证（Playwright 上传真实 mp4）：服务器封面 `1280×720`、**平均亮度 54.2**（非黑）、`isBlack=false` ✓。
- 本次未打包 exe（按用户要求只增量构建 web）。

## [6.0.0-beta1] 提示消息动画重做（用户「淡入→停留→上移固定距离淡出→移除，多个堆叠」）
- **旧问题**：toast 首次渲染即带 `show`（opacity 1），**没有真正淡入**；淡出只上移 -24px。
- **改动（app.ts + app.css）**：
  - `toasts` 类型加 `show: boolean`；`flash()` 初始 `show:false`，**下一帧 rAF 再加 show** → CSS transition 淡入（opacity 0→1，0.3s）；停留 **2000ms**；置 `leaving` 后**上移固定距离 -60px 同时淡出**（opacity→0，0.4s）；动画完（2500ms）移除。
  - 渲染 class：`toast ${leaving ? "leaving" : show ? "show" : ""}`（初始无 show 透明）。
  - CSS：`.toast` opacity 0 + transition opacity .3s；`.toast.show` opacity 1；`.toast.leaving` opacity 0 + `translateY(-60px)` + transition .4s；`.toasts` flex column gap 10 垂直堆叠成卡片。
- 验证（Playwright 连续 3 个 flash 采样）：t150/t400 三个 toast 堆叠 opacity 1（淡入完成）✓；t2100 逐个 leaving 上移淡出中（-18.8/-4.25）✓；t2600 到达 -60px + opacity 0、前两个已移除 ✓。
- 本次未打包 exe（按用户要求只增量构建 web）。

## [6.0.0-beta1] 桌面端设置/二维码弹窗淡入+轻微放大动画（用户「设置、二维码界面需要淡入以及轻微放大弹出动画，磨砂背景不要动」）
- **改动（app.css）**：新增 `@keyframes panelIn`（opacity 0→1 + `scale(.94→1)`），`.panel` 加 `animation: panelIn .28s ease; transform-origin: bottom center`（面板贴底，从底部轻微放大弹出）。**`.mask` 磨砂背景（--frost-bg + blur 10px）未动**。移动端 media 内已有 `animation: sheetUp .28s ease` 覆盖，保留滑上动画不受影响（仅桌面端生效）。
- 验证（Playwright）：设置面板 `animationName=panelIn`，逐帧 opacity 0→1、scale 0.94→1 平滑（t1 0.94/透明 → t289 1.0/scale1）✓；二维码面板 `panelIn` ✓；`.mask` `backdropFilter=blur(10px)` 保持 ✓。
- 本次未打包 exe（按用户要求只增量构建 web）。

## [6.0.0-beta1] 修复：弹窗放大动画导致阴影被 scale 缩放（「加动画后阴影不对劲」）
- **根因**：`.panel` 的 `animation: panelIn`（`transform: scale(.94→1)`）会**整体缩放元素含 `box-shadow`**，动画中阴影随内容缩放/偏移，视觉上"阴影不对劲"。
- **改动（app.ts + app.css）**：把背景/圆角/阴影移到**外层 `.panel-shell`**（静态，只 `panelFade` 淡入 opacity，无 transform → 阴影不被缩放）；`.panel` 只做内容 **`panelIn` scale 放大**（背景透明）。`renderSheet` 结构改为 `mask > .panel-shell(.qr/.settings-panel) > .panel > 内容`；`.panel.settings-panel`/`.panel.qr` 选择器同步为 `.settings-panel .panel`/`.qr .panel`；桌面 media 的宽度/圆角（`.panel`→`.panel-shell`）、移动端 `sheetUp` 移到 `.panel-shell` + `.panel { animation: none }`（禁用内容 scale 避免与滑上叠加）。
- 验证（Playwright 采样动画中 t≈120ms）：二维码面板 `.panel-shell` `box-shadow=0 -10px 30px` **完整未缩放**、`transform:none`、只 opacity 0.83 淡入；`.panel` `scale≈0.987` 放大中 ✓。设置面板同 ✓（shell 宽 640、阴影完整、panel scale 0.982）。`.mask` `backdropFilter=blur(10px)` 磨砂未动 ✓。动画后 shadow 完整、transform:none ✓。
- 本次未打包 exe（按用户要求只增量构建 web）。

## [6.0.0-beta1] 修复：弹窗阴影偏上（用户「效果不对，好像阴影偏上了」）
- **根因**：`.panel-shell` 的 `box-shadow: 0 -10px 30px` 是**朝上投影**（offset-y 负值 → 阴影落在面板上方），桌面居中弹窗显得"阴影偏上"。
- **改动（app.css）**：基础 `.panel-shell` 阴影 `0 -10px 30px` → **`0 0 30px`（四周对称）**，不偏上也不偏下；**移动端 media 里 `.panel-shell` 覆盖回 `0 -10px 30px`**（移动端 sheet 贴底，投影朝上投在磨砂背景上，保持不回归）。阴影仍在 shell（transform 动画之外），内容 scale 不受影响。
- 验证（Playwright）：设置面板 `.panel-shell` `box-shadow=rgba(0,0,0,0.25) 0px 0px 30px 0px`（四周对称）、`transform:none` ✓；页面保持打开可查看效果。
- 本次未打包 exe（按用户要求只增量构建 web）。

## [6.0.0-beta1] 开源授权：GPL-2.0-or-later（用户「在项目根目录生成 GPL-2.0-or-later 授权文件」）
- 新建根目录 `LICENSE.md`：完整 GPL-2.0（June 1991）官方全文 + 项目头说明（filesyncEX，Copyright (C) 2026 NoRainLand，SPDX: GPL-2.0-or-later），How to Apply 部分已填项目信息。
- 6 个 `package.json`（根 + core/protocol/server/shell/web）补 `"license": "GPL-2.0-or-later"`（JSON 验证有效）。
- 选择理由：依赖 `@audio/decode-aac` 为 GPL-2.0，项目用 GPL-2.0-or-later 与其完全兼容（GPL-2/3 与 Apache 互不兼容，Apache 需替换该解码器）。
- 未打包 exe。

## [6.0.0-beta1] README 补开源协议小节（用户「要的，加上加上」）
- README 目录加「开源协议」条目；文末新增「开源协议」小节：GPL-2.0-or-later 声明 + shields.io 徽章（GPL 红）+ 三条说明（可自由使用但衍生须开源 / aac 解码器 GPL-2.0 兼容 / 指向 LICENSE.md）+ Copyright (C) 2026 NoRainLand。
- 未打包 exe。

## [6.0.0-beta1] 修复 ws.ts「frame 类型未知」警告（用户「这里有点小警告，你修一下」）
- **现象**：`packages/web/src/ws.ts` 语言服务报 `frame` 类型为 unknown（onmessage 里 `let frame: ServerFrameT` 后 switch frame.type 报错）；但本地 `tsc`（5.9.3）通过。
- **根因**：VS Code 语言服务（内置 TS 版本）对 **zod v4 的 `z.discriminatedUnion` 的 `z.infer` 推断退化为 unknown**（本地 tsc 5.9.3 正常）。决定性验证：`const __w: ServerFrameT = 42;` 语言服务不报错 → 证明 ServerFrameT 被解析为 unknown。
- **修复（protocol/src/schema.ts）**：`ClientFrame`/`ServerFrame` 类型由 `z.infer<typeof ...>` 改为**手写联合类型**（普通 TS 类型，语言服务必定能解析），加注释「勿改回 z.infer，改 schema 需同步」；ws.ts 赋值处补 `as ServerFrameT` 断言。
- 验证：protocol/server/web 全量 tsc 构建通过；`get_errors` 全 workspace 无错误 ✓。
- 本次未打包 exe（按用户要求只增量构建）。

## [6.0.0-beta2] 前端中英文切换（i18n）+ 设置语言按钮 + 版本 beta2
- **新建 `packages/web/src/i18n.ts`**：zh/en 双语词典（星期/日期、文件类型、全部提示 toast/按钮/placeholder/弹窗标题/预览/删除气泡/设置面板等 ~90 key）+ `loadLang/saveLang`（localStorage `fsex_lang`）+ `dayLabel`/`fmtType` 按语言返回。
- **app.ts 接入**：`lang` 状态（`loadLang()`）、`t(key, vars)` 翻译方法（缺 key 回退中文）、`setLang`（持久化 + 触发重渲染）；替换全部用户可见硬编码中文（`console.error` 开发者日志保留）。
- **设置面板新增「语言」区块**：中文 / English 两个切换按钮（`.st-lang .langbtn`，on 态主色），点击即切换 + 持久化。
- **版本 beta1 → beta2**：6 个 package.json + server health/banner + web main.ts 默认版本 + README + LICENSE 示例同步。
- **坑**：`noUncheckedIndexedAccess` 下 i18n.ts 数组/Record 索引返回 undefined → week 数组 `?? ""`、dict 访问改用 `tr()` 辅助（`?.` 链 + `??` 回退）；**get_errors 对未打开文件报陈旧诊断**（probe 实验确认：加了明显错误它不报），以 `tsc build` 为准。
- 验证（Playwright）：设置面板语言按钮存在；切 English 后 Settings/Language/Connection/Connected/(LAN)/My nickname/QR Code/Toggle theme/File/Send/Copy/Delete/Today 全英文 ✓；localStorage `fsex_lang=en` 持久化 ✓；`/api/health` `version=6.0.0-beta2` ✓。
- 本次未打包 exe（按用户要求只增量构建）。

## [6.0.0-beta2] 语言切换改单选框（用户「切换有点难看，改为单选框不要按钮」）
- 设置面板语言切换由两个按钮（`.langbtn`）改为**原生 radio 单选框**：`<label class="lang-opt"><input type="radio" name="fsex-lang" .checked ... @change=setLang>文本</label>`（中文 / English）。
- CSS：`.st-lang .langbtn` 三行替换为 `.st-lang .lang-opt`（inline-flex + gap 6px + cursor）+ `input[type="radio"]`（15px、`accent-color: var(--primary)` 主色圆点）。
- 验证（Playwright）：无障碍快照显示 `radio "中文"` / `radio "English" [checked]`；点「中文」→ checked 切换、全界面切回中文（设置/语言/连接/已连接/我的昵称…）、localStorage `fsex_lang=zh` ✓。
- 本次未打包 exe。

## [6.0.0-beta2] 语言区块移到连接下 + 首次按浏览器语言判断（用户「语言选项放连接选项下面」「首次打开判断浏览器语言，中文则中文否则英文」）
- **位置调整**：设置面板语言区块从顶部移到「连接」区块下方（顺序：连接 → 语言 → 设备身份/昵称 → 关于）。
- **首次默认语言**：`i18n.ts loadLang()` 改为——localStorage 有记录用记录；**无记录（首次打开）按 `navigator.language` 判断**（`/^zh/i` 匹配 zh-CN/zh-TW 等 → 中文，否则英文）。
- 验证（Playwright）：区块顺序 `连接→语言`（seclabels：连接/语言/关于，connBeforeLang=true）✓；清 localStorage 后 zh-CN 浏览器首次加载显示中文（二维码/今天/选择文件）✓；addInitScript 模拟 en-US 后首次加载显示英文（QR Code/Today/Choose file）✓。
- 本次未打包 exe。

## [6.0.0-beta2] 语言区块移到设备指纹后面（用户「语言选项，放在设备指纹后面吧」）
- 设置面板语言区块从「连接」下方移到**设备指纹后面**（顺序：连接 → 设备身份/昵称（默认昵称/我的昵称/设备指纹）→ 语言 → 工具 → 关于）。
- 验证（Playwright）：seclabels Connection→Language→Tools→About、`fpBeforeLang=true`（设备指纹 code.fp 在 st-lang 前）✓。
- 本次未打包 exe。

## [6.0.0-beta2] 静态资源缓存策略（根治 Firefox 缓存旧 index.html → 旧 CSS）
- **背景**：Firefox 一直用旧版 CSS，实为缓存了入口 `index.html`（不带 hash）→ 引用旧 hash JS → 旧 CSS；而带 hash 的 JS/CSS（?inline 内联）本身不会缓存旧。
- **改动（server/src/HttpServer.ts）**：`express.static` 加 `setHeaders`——`/assets/*`（Vite 带 hash 构建资产）设 `Cache-Control: public, max-age=31536000, immutable`；其余（index.html/favicon/字体等不带 hash）设 `no-cache` 每次重新校验。SPA 回退 `sendFile` 兜底也加 `no-cache`。
- 验证（curl -I）：`/` → `no-cache`；`/assets/index-*.js` → `public, max-age=31536000, immutable`；`/fonts/*.woff2` → `no-cache` ✓。
- 效果：改版后 Firefox 刷新必然拿新 index.html → 新 hash JS → 新 CSS；带 hash 资产永久缓存不损性能。
- 本次未打包 exe。

## [6.0.0-beta2] 合并两次 /api/health 请求为一次（用户「合并为一次吧」）
- **背景**：main.ts printMsg（取 name/version 打印）与 app.ts connectedCallback（取 lanIp/port 拼 httpUrl）各自 fetch /api/health，重复请求。
- **改动**：api.ts 新增 `HealthT` 接口 + `fetchHealth()`（模块级缓存 Promise：多次调用只发一次请求，失败回退空对象）；main.ts / app.ts 都改用它。
- 验证（Playwright 监听请求）：reload 后 `/api/health` 仅 `healthCount: 1` ✓。
- 本次未打包 exe。

## [6.0.0-beta2] 一键统一版本号脚本（用户「加个脚本，一键修改为同一个版本」）
- 新建 `scripts/set-version.mjs`：从根 package.json 自动读当前版本，一键全文替换为指定新版本；覆盖 11 个位置（根+5 子包 package.json、HttpServer.ts health version、index.ts banner、main.ts 默认版本、README 版本行、LICENSE 示例）。用法 `node scripts/set-version.mjs 6.0.0-beta3`；根 package.json 加 `set-version` npm script。
- 放 `scripts/` 而非 `tool/`（tool/ 会被 package.mjs 同步进 web/dist 打包）。
- 测试：beta2→beta3 更新 11 文件 ✓、改回 beta2 恢复 11 文件 ✓、同版本提示无需修改 ✓；grep 无 beta3 残留。
- 未打包 exe。

## [6.0.0-beta2] 掉线通知去重（用户「掉线通知弹了一个之后，不应该弹第二个」）
- 根因：`showNotice` 无条件追加，同一掉线通知重复收到时弹多个。
- 改动（app.ts）：`showNotice` 加去重——已存在同 `level` 且同 `message` 的 pending 通知则跳过；不同内容仍可并存（保留通知池能力）。
- 验证（Playwright）：同一通知连续 3 次 → notices 仅 1 个（弹窗只渲染一个）；不同内容（error+ warn）→ 2 个并存 ✓。
- 本次未打包 exe。

## [6.0.0-beta2] 掉线/维护通知不可关闭 + 重连成功自动关 + 断线兜底（用户需求）
- **改动（app.ts）**：
  ① `renderNotice`：shutdown/maintenance 通知**不渲染 ✕**（不可关闭），其他（info/warn/error）保留可关。
  ② `confirmNotice`：掉线类（shutdown/maintenance）确认后**不立即关闭**（保留），连接成功才关；其他通知照旧立即关。
  ③ `onOpen`（重连成功）：**自动移除掉线类通知**（shutdown/maintenance）。
  ④ `onClose`（WS 断开）：**兜底弹「服务器维护」通知**（已有掉线类则不重复）——无论维护/关闭/断线都连不上服务器，保证有通知。
- 验证（Playwright）：shutdown 面板无 ✕ / info 有 ✕ ✓；确认重连后连接成功 shutdown 自动移除、info 保留 ✓；kill server → 弹 maintenance（服务器维护中）无 ✕、connState connecting 重连中 ✓。
- 本次未打包 exe。

## [6.0.0-beta2] 掉线通知统一为两种形态（用户「只有两种情况」）
- **情况1 服务器主动关闭**（shutdown/maintenance notice）：标题统一「服务器维护中」，内容固定「点击确定尝试重新连接服务器」。
- **情况2 客户端断开**（onClose 兜底，新增 level=disconnected）：标题「服务器断开连接」，内容固定「点击确定尝试重新连接服务器」。
- **改动**：
  ① i18n 新增 `notice_disconnected`（服务器断开连接）、`notice_retry`（点击确定尝试重新连接服务器）；shutdown 标题改走 `notice_maintenance`。
  ② `showNotice`：掉线类（shutdown/maintenance/disconnected）**强制内容为 notice_retry**（忽略服务器传入 message）。
  ③ `onClose` 兜底改弹 `disconnected`。
  ④ `noticeLevelLabel`：shutdown+maintenance →「服务器维护中」、disconnected →「服务器断开连接」。
  ⑤ 不可关闭（locked）与 onOpen 自动移除范围加入 disconnected。
- 验证（Playwright）：shutdown → 维护中/固定内容/无 ✕；disconnected → 断开连接/固定内容/无 ✕；kill server → 弹 disconnected（服务器断开连接）无 ✕、自动重连 ✓。
- 本次未打包 exe。

## [6.0.0-beta2] 断线自动重连流程（用户「维护主动断开 / 客户端断开自动重连3次 / 确定按钮进重连」）
- **需求1 服务器维护**：收到 maintenance notice → 弹「服务器维护中」（有确定按钮）并**主动 `ws.close()` 断开**（onNotice 处理）。
- **需求2 客户端断开**：onClose 无服务器通知 → 弹「断线重连中」（标题，内容「正在自动尝试点选重连，剩余次数X」，**无 ✕、无确定按钮**）并**自动重连最多 3 次**；成功（onOpen）同步数据（onWelcome）+ 自动关闭；3 次失败 → 关闭「断线重连中」→ 弹「服务器断开连接」（有确定按钮）。
- **需求3 确定按钮**：任何掉线通知（维护/断开）点「确定」→ 关当前通知 → 弹「断线重连中」并自动重连。
- **改动**：ws.ts `autoReconnect` 参数（app 传 false，关闭 WS 内建无限退避重连，改由 app 层控制次数）；app.ts 新增 `reconnectLeft/reconnectTimer/autoReconnecting` + `startAutoReconnect/tryReconnect/updateReconnectNotice/dismissNoticeLevel`；i18n 加 `notice_reconnecting`/`notice_reconnect_left`；renderNotice 对 reconnecting 不渲染 ✕ 和确定按钮。
- **坑**：`window.setTimeout` 返回 number，reconnectTimer 类型用 `number | null`（`ReturnType<typeof setTimeout>` 解析成 Node Timeout 报 TS2322）。
- 验证（Playwright）：断线 → 弹「断线重连中」剩余次数 2→1 → 3 次失败转「服务器断开连接」✓；点确定 → 弹「断线重连中」→ 重连成功 connected、通知自动关闭 ✓。
- 本次未打包 exe。

## [6.0.0-beta2] 重连成功 toast + 断线重连中省略号动画（用户两项）
- **重连成功 toast**：`onOpen` 里若 `autoReconnecting`（处于重连流程）→ `flash("服务器重连成功")`（i18n `reconnect_success`）；首次连接不提示。
- **断线重连中省略号动画**：`renderNotice` 对 `reconnecting` 通知内容尾部加 `.dots`（3 个 `<i>` 圆点），CSS `dotTyping` 动画（0/.2/.4s 依次点亮循环 = 打字机省略号 `...`）。
- 验证（Playwright）：断线重连中期间 `.dots` 3 点 + animationName=dotTyping ✓；确认重连→重连成功 connected、通知关闭、toast「服务器重连成功」✓。
- 本次未打包 exe。

## [6.0.0-beta2] 省略号改文字形式（用户「直接在通知内容后面加，也就是文字」）
- 「断线重连中」尾部省略号由 3 个圆点 `<i>` 元素改为**文字省略号**：`.dots` 空 span，`::after { content: "..." }`（3ch 宽 + overflow hidden），`dotType` 动画在 3ch 容器内平移文字，循环显示 `... → .. → .`。
- 验证（Playwright）：`.dots::after` content="..."、animationName=dotType、宽度 3ch（27px）、无障碍快照显示文字 ... ✓。
- 本次未打包 exe。

## [6.0.0-beta2] 引入 Prism.js 代码高亮 + 深浅主题自动切换（用户「引入prism，One Dark+浅色主题，按浏览器黑夜模式切换」）
- **依赖**：web 包 pnpm 引入 `prismjs` + `prism-themes` + `@types/prismjs`。
- **高亮替换**：`highlightCode` 由手写正则 tokenizer（HIGHLIGHT_LANGS/GROUPS/TOKEN_CLASS）改为 `Prism.highlight`；`PRISM_LANG` 映射（ts→typescript、js→javascript、python、ini、bat→batch、json、sql、html→markup、css）；引入语言组件 prism-typescript/python/ini/batch/json/sql（js/markup/css 核心自带）。
- **主题**：新建 `src/prism-theme.css`（`@import one-light` 默认 + `@import one-dark (prefers-color-scheme: dark)`）→ **`?inline` 注入 shadow root**（坑：Vite 全局 CSS 不穿透 shadow DOM，`.token` 规则对组件内元素不生效，实测全 token 继承 pre 前景色；改为与 app.css 一样 `?inline`+unsafeCSS 数组注入）。
- **卡片跟随深浅**：`.card.code`/`.codeview` 背景前景按 `prefers-color-scheme` 切换（浅 `#f5f5f5`/文字 `#383a42`，深 `#282c34`/`#abb2bf`），One Dark 旧 `.tok-*` 规则删除。
- 验证（Playwright）：ts 代码 21 token / 7 class（keyword/operator/builtin/number/punctuation/function/comment）✓；浅色 One Light（keyword #a626a4、function #4078f2、卡片 #f5f5f5）✓；`emulateMedia({colorScheme:'dark'})` → One Dark（keyword #c678dd、卡片 #282c34、mediaDark true）且免刷新实时切换 ✓。
- 本次未打包 exe。
- **Prism 主题改跟随项目主题 + 主题持久化（用户「切黑夜没自动切 onedark」「切黑夜浏览器没记录在本地」）**：①根因1：prism-theme.css 用 @import one-dark (prefers-color-scheme: dark) 只跟系统深浅，不跟项目手动主题（data-theme）→ 重写为 CSS 变量方案：.token.* 颜色改 ar(--tok-*)，:host 默认 One Light 值 + :host(.dark) 用 One Dark 值；app.ts 在 constructor/toggleTheme 给组件 host 	his.classList.toggle("dark", theme==="dark")（shadow 内 :host(.dark) 生效，外部 html[data-theme] 选择器穿透不了 shadow DOM）。②根因2：	oggleTheme 只改 html data-theme 不存 localStorage → 新增 loadTheme()（localStorage sex_theme 记录优先，首次跟随 matchMedia("(prefers-color-scheme: dark)")）+ toggleTheme 写 localStorage；constructor 读 loadTheme + 设 data-theme + host class。③.card.code/.codeview 深浅切换同步从 @media (prefers-color-scheme: dark) 改 :host(.dark) ...（与 Prism 联动一致）。验证（Playwright）：dark 时 token keyword #c678dd/卡片 #282c34 ✓，light 时 #a626a4/#f5f5f5 ✓，fsex_theme=light/dark 刷新后保持 ✓。未打包 exe。已登记 PROJECT_LOG.md。
- **代码模式输入框颜色跟随主题（用户「代码模式的输入框的颜色也要和主题一致」）**：根因=.code-editor textarea（app.css 58 行）背景/前景固定深色 #282c34/#abb2bf（One Dark 风格），不跟项目主题。修复=默认（浅色）改 #f5f5f5/#383a42（One Light）+ 新增 :host(.dark) .code-editor textarea { background:#282c34; color:#abb2bf } 覆盖（与 .card.code/Prism 配色联动一致，host dark class 驱动，免刷新实时切换）。ce-top/语言下拉已是自定义控件用 var(--surface) 跟随主题无需改。验证（Playwright）：light→textarea bg #f5f5f5/文字 #383a42，dark→#282c34/#abb2bf，切换免刷新实时生效 ✓。未打包 exe。已登记 PROJECT_LOG.md。
- **测试脚本统一目录 _dev/（用户「测试脚本放指定文件夹并配置 gitignore，不要到处写」）**：新建根目录 _dev/（含 README 说明），.gitignore 把原来散落的 _runN.mjs/_ui-data//_shot*.png 单条替换为统一 _dev/；根目录残留的 _replaceHl.mjs（Prism 改造临时脚本）一并移入 _dev/。**今后所有临时启动/验证脚本、测试数据、截图一律写 _dev/，不散落根目录或 src 下**。验证：git check-ignore _dev/README.md 命中、git status 无 _dev 条目、_replaceHl.mjs 已不在跟踪列表 ✓。已登记 PROJECT_LOG.md。
- **桌面端打开代码模式消息上移修复（用户「每次打开代码模式，消息会向上移动一点点」）**：根因=code-mode 时 .upload-row 内 .btn-file/.input 被 display:none、.send 变 absolute → 流内无内容 → 行高 42px 塌陷为 0 → .upload（sticky）总高 64px→22px → 消息列表整体上移 42px。修复=.upload-row 基础加 min-height: 42px（与普通态 fileBtn 撑起的行高一致），code-mode 时空行也保持 42px。验证（Playwright 实测）：普通/打开/关闭三态 upload 64、row 42、firstMsgTop 均 195px 恒定，不再移动 ✓。未打包 exe。已登记 PROJECT_LOG.md。
- **视频封面取帧改「采样 + 亮度/对比度评分」（用户「开头黑的视频截后面画面」）**：旧 grabVideoFrame 固定时间点 [0.01,0.1,1,0.5] + 平均亮度<4 判黑——黑场>1s 的视频全部判黑返回 null（无封面）。新实现=**从前往后梯度采样 [0.3,1,2,3,5,8] + 按比例中后段 dur*0.15/dur*0.3（clamp dur*0.9）**，每点 seek 后 drawVideoFrame 打分：**亮度分**（avg∈[30,225] 满分，过暗黑场/过亮白闪线性衰减）+ **对比度分**（方差/150，区分「暗但有内容」vs「黑场」），score=0.5*亮度+0.5*对比度；**首个 score≥1 即停**，全不合格取最高分兜底。drawVideoFrame 返回 {c, score}。extractVideoCover/captureVideoCover 复用 grabVideoFrame 不需改。验证（ffmpeg 造「2s 纯黑+3s testsrc2」测试视频，Playwright 上传）：封面 avgBrightness=117（非黑，旧逻辑前 2s 全黑会返回 null）✓。未打包 exe。已登记 PROJECT_LOG.md。
- **ESC 快捷键关闭预览/弹层/代码模式（用户「所有预览界面 + 代码模式加 esc 关闭」）**：新增组件级 onKeyDown（window keydown 监听，connectedCallback 注册 / disconnectedCallback 移除），按 ESC 依次关闭：**预览（.viewer，closePreview）→ 设置/二维码弹层（sheet=null）→ 代码模式（codeMode=false）**。通知弹窗（维护/断线）不参与 ESC（重要提示不可误关）。验证（Playwright）：代码卡片预览→ESC 关 ✓、设置→ESC 关 ✓、二维码→ESC 关 ✓、代码模式→ESC 关 ✓。未打包 exe。已登记 PROJECT_LOG.md。
- **代码模式失焦关闭（用户「代码模式下其他区域获取焦点则关闭代码模式」）**：新增组件级 onPointerDown + onFocusIn（document 捕获阶段监听，connectedCallback 注册/disconnectedCallback 移除）：codeMode 开启时，点击或焦点落在 .code-editor 外 → codeMode=false。**坑：shadow DOM 事件重定向——document 捕获监听里 .target 被重定向为 host（filesync-app），ditor.contains(e.target) 恒 false → 点编辑器内部也误关；必须用 .composedPath()[0] 取原始目标**（同 onMsgTouchStart 教训）。验证（Playwright）：点 header 空白关闭 ✓、点 textarea 内部保持 ✓、点发送按钮关闭 ✓、点 ce-top 语言下拉保持 ✓。未打包 exe。已登记 PROJECT_LOG.md。
- **语言下拉列表再次截断修复（用户「又把语言选择器下拉列表截断了，只能看到五种语言」）**：根因=.code-editor 的 overflow:hidden（此前「大文件删除按钮点不了」修复时加回，防收起态 textarea 溢出可见+拦截点击）与「语言列表上下截断」修复（曾移除 overflow）冲突——展开态向下弹出的 .lang-list（桌面 upward=false）又被 overflow:hidden 裁剪，只剩前 5 项。修复=展开态 .code-editor.open 加 overflow:visible（收起态仍 overflow:hidden）。圆角由子元素（.ce-top 上/textarea 下）负责不受影响。验证（Playwright）：桌面打开代码模式点语言下拉 → 9 项全可见（TypeScript top129 到 CSS top385，allVisible=true，codeEditorOverflow=visible）；ESC 收起后 overflow 回 hidden、textarea visibility hidden（不拦截点击）✓。未打包 exe。已登记 PROJECT_LOG.md。
- **语言下拉选择后不收回修复（用户「下拉表框重新选择之后没有自动收回来」）**：根因=.lang-opt 点击事件**冒泡到父级 .lang-pick**，其 @click 把 langOpen 再次翻转回 true（lang-opt 已设 false，冒泡后又 true）→ 下拉不收回（实测：lang-cur 已变 Python 但列表仍开）。修复=.lang-opt @click 加 .stopPropagation()（阻止冒泡到 lang-pick）。**连带**：移动端 .lang-bar 在 .code-editor 外，失焦关闭（onPointerDown/onFocusIn）会把点语言控件误判为"外部"而退出代码模式 → 内部判断从 .code-editor 扩展为 closest('.code-editor, .lang-bar')（覆盖移动端语言控件）。验证（Playwright）：桌面选 JSON→下拉收回+代码模式保持 ✓；移动 390 选 Batch→下拉收回+代码模式保持 ✓。未打包 exe。已登记 PROJECT_LOG.md。
- **代码模式点发送不发消息修复（用户「代码模式写代码点发送，代码模式收回但没发消息」）**：根因=失焦关闭的 onPointerDown（capture）先于 click 触发——点发送按钮（在 .code-editor 外）时 pointerdown 先 codeMode=false 收起了代码模式，等 click 触发 send 的 @click 时 	his.codeMode 已是 false → 走 sendText() 而非 sendCode()（发空文本，不发送）。修复=失焦关闭白名单加入发送按钮：closest('.code-editor, .lang-bar, .send, .sendbtn')（桌面 .send / 移动 .sendbtn）。sendCode 发送后 codeMode=false 收回是原有设计。验证（Playwright）：桌面写代码点 send → 代码卡发出（含代码）+ 代码模式收回 ✓；移动 390 写代码点 sendbtn → 同样 ✓。未打包 exe。已登记 PROJECT_LOG.md。
- **代码模式按钮点击闪烁修复（用户「代码模式下点击代码模式按钮，会瞬间收回又展开」）**：根因=bracebtn（{}）在 .code-editor 外，失焦关闭 onPointerDown（capture）先于 click 触发——pointerdown 先 codeMode=false 收回，click 的 toggle 又 codeMode=true 展开 = 瞬间收回又展开。修复=bracebtn 加入失焦关闭白名单：closest('.code-editor, .lang-bar, .send, .sendbtn, .bracebtn')（开关由 click toggle 统一处理，pointerdown 不预判）。验证（Playwright）：桌面点 bracebtn → pointerdown 时代码模式仍开（无闪烁）、click 后正常收回 ✓；移动 390 同 ✓；点外部区域失焦关闭未回归 ✓。未打包 exe。已登记 PROJECT_LOG.md。
- **设置面板三项（用户「①二级标题放大 ②加一栏昵称 ③关于加 app 名/版本/描述/版权」）**：①.settings .st-sec 二级标题 font-size 14→16px；②设备身份区加 <p class=st-sec>昵称</p> 栏标题（顺序 连接→昵称→语言→工具→关于），i18n 新增 st_nick（昵称/Nickname）；③关于区新增 .st-about 块：app 名 filesyncEX（17px 700）+ 版本（ppVer state，来自 /api/health version，默认 6.0.0-beta2）+ 描述（i18n pp_desc）+ 版权（i18n copyright，© (C) 2026 NoRainLand）。i18n 新增 4 key（zh+en）：st_nick/version/app_desc/copyright。验证（Playwright）：中文标题 [连接 昵称 语言 工具 关于] 全 16px、关于区 filesyncEX 版本 6.0.0 描述 版权 ✓；英文 [Connection Nickname Language Tools About] + Version 6.0.0 等 ✓。未打包 exe。已登记 PROJECT_LOG.md。
- **桌面端设置/二维码去放大缩小动画（用户「去掉桌面端打开设置界面、二维码界面的放大缩小动画」）**：.panel 的 panelIn keyframes 原含 	ransform: scale(.94→1)（轻微放大弹出）+ 	ransform-origin: bottom center。修复=keyframes 去掉 transform 只留 opacity 淡入（0.28s），删除 transform-origin（无 transform 无意义）。所有桌面端面板（设置/二维码/附件/进度）统一只淡入；移动端不受影响（.panel{animation:none} + 外壳 sheetUp 滑上）。验证（Playwright）：设置面板 .settings-panel .panel animationName=panelIn、keyframes 仅 opacity 0→1、hasTransform=false ✓；二维码 .qr .panel 同 ✓。未打包 exe。已登记 PROJECT_LOG.md。
- **设置界面拖拽选择文本跨出面板误关修复（用户「改昵称时拖拽全选，鼠标移出设置界面松手，界面关闭」）**：根因=遮罩 .mask 用 @click 关闭——在输入框内 mousedown（面板内）→ 拖拽选择跨出面板 → mouseup 在遮罩上 → 浏览器在公共祖先（mask）触发 click → 关闭设置界面。修复=.mask 关闭改 @mousedown 且 .target === e.currentTarget（只有按下目标就是遮罩本身才关；拖拽的 mousedown 发生在面板内不触发）。ptitle/ESC 等关闭途径不变。验证（Playwright）：桌面输入框内按下拖到遮罩松手 → 设置界面保持打开 ✓、点遮罩空白 → 正常关闭 ✓；移动端点面板外遮罩 → 关闭 ✓（点面板内不关，正确）。未打包 exe。已登记 PROJECT_LOG.md。
- **断线通知英文文案统一（用户「英文下内容 Click OK 但按钮 Reconnect，合理么」）**：判断=不一致不合理（用户会找 OK 按钮但按钮是 Reconnect）。修复=i18n 
otice_retry 内容指向按钮动作：en Click OK to try... → Click Reconnect to try reconnecting to the server；zh 点击确定... → 点击「确认并重连」尝试重新连接服务器（对齐按钮「确认并重连」）。按钮 econnect_confirm 保持（Reconnect/确认并重连，语义更明确）。验证（Playwright kill server → 断线通知）：en 标题 Server disconnected、内容 Click Reconnect to try reconnecting to the server、按钮 Reconnect，三者一致 ✓。未打包 exe。已登记 PROJECT_LOG.md。
- **i18n 清理 + me 改 This device（用户「删掉并且改动吧」）**：①删除 3 个未使用死键（zh+en）：econnecting（正在重新连接…/Reconnecting…）、econnecting_shutdown（正在尝试重新连接…/Trying to reconnect…）、
otice_shutdown（服务器关闭/Server is shutting down）——shutdown 标题实际统一走 notice_maintenance。②英文 me：Me → This device（对齐中文「本机」=本设备语义）。构建通过（无引用缺失，bundle 172.29→172.08kB）。验证（Playwright）：英文发消息本机标注 This device ✓。未打包 exe。已登记 PROJECT_LOG.md。
- **通知单词被截断修复（用户「通知的时候，单词被截断了」）**：根因=.notice-panel .nbody 用 word-break: break-all——它会把任意英文单词**硬性拆断**换行（如 reconnecting 断成两行）。修复=改 overflow-wrap: break-word（普通单词按空格正常换行，只有超长词如 URL 超出容器才断）；.ntitle 也补 overflow-wrap: break-word 保护。验证（Playwright kill server → 断线通知）：nbody computed overflowWrap=break-word / wordBreak=normal、ntitle overflowWrap=break-word，文本正常显示 ✓。未打包 exe。已登记 PROJECT_LOG.md。
- **vConsole 通过 CDN 按需引入（用户「CDN 不用 npm 引入 vconsole，仅 url 带 ?vc=1 才开启」）**：main.ts 新增 initVConsole()：URLSearchParams(location.search).get('vc')==='1' 才动态创建 <script src="https://unpkg.com/vconsole@3.15.1/dist/vconsole.min.js"> 注入 head，onload 后 
ew VConsole({maxLogNumber:1000})；无 vc=1 零开销（不加载 CDN、不打进 bundle）。验证（Playwright）：无 vc=1 → 无 vconsole script/无按钮/window 无 VConsole ✓；?vc=1 → CDN script 注入 + vc-switch 按钮出现 + window.VConsole ✓（截图右下角绿钮）。注意：CDN 引入需外网，局域网离线时 vc=1 加载失败无 VConsole（用户要求 CDN，接受）。未打包 exe。已登记 PROJECT_LOG.md。
