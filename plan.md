## Plan: filesyncEX 房间与传输架构 V2

基于 Node.js + TypeScript 构建局域网文件/文字共享系统：TSRPC 负责实时信令与 P2P 信令协调、HTTP PassThrough 负责文件流式中转（模式一：中转）、WebRTC DataChannel 负责大文件点对点直传（模式二：P2P）。PIN 模式可开关：关闭时全员进入公共大房间；开启时输入 4 位数字加入对应房间，输入空则进入默认公共房间。

**Steps**
1. Phase 1 - 工程初始化（阻塞后续）: 使用 pnpm workspaces 从零创建 monorepo，建立 packages/backend、packages/frontend、packages/shared；统一 TypeScript 配置与基础脚本。
2. Phase 2 - 协议与模型设计（阻塞后续）: 在 shared 定义 TSRPC 协议与共享类型，重点新增 RoomMode（pinEnabled 布尔开关）、RoomId、PinCode 校验规则、JoinRoom 请求结构。
3. Phase 3 - 后端房间系统（依赖 2）: 实现 RoomManager。pinEnabled=false 时所有连接分配到 GLOBAL 房间；pinEnabled=true 时客户端输入 4 位数字加入该 PIN 房间，输入空字符串加入 GLOBAL 房间；非法 PIN 直接拒绝。房间显示名称由服务器自动生成。
4. Phase 4a - 后端信令与文件中转（依赖 3，可与 5 并行）: 实现文字广播、文件 Offer/Accept/Ready/Cancel/Status 信令；建立 TransferSession（HTTP PassThrough）并提供 upload/download 流式端点；会话按 roomId 隔离，禁止跨房间收发；不落盘、纯流式；新增房间消息历史缓存与 Join 后回放（每房间最近 100 条，不主动过期）；提供任意成员可触发的历史清理接口。
5. Phase 4b - WebRTC P2P 信令（依赖 4a，可与 6 并行）: 在 TSRPC 中实现 P2P 信令中继服务（MsgP2PSignal）；服务器不参与实际数据流、只转发 Offer/Answer/ICE Candidate；超过阈值（服务器配置，默认 10GB）或用户手动选择时触发 P2P 模式；第一个接受者独占传输，其余人该消息状态变为"已被接收"；传输完成后所有人显示"已被接收"。
6. Phase 5 - 前端欢迎页与房间页（依赖 2，可与 4 并行）:
   - 欢迎页（首次/无历史）: 全屏大 LOGO + PIN 输入框（placeholder: 4位数字或留空进入默认）+ "开始文件传输"按钮。
   - 欢迎页（有历史/点击返回后）: 同上，另带历史房间列表（PIN + 服务器自生房间名 + 进入时间），可点击直接重入。
   - 自动跳转: localStorage 存有最近房间时，页面加载立即跳转进入最近房间，不显示欢迎页。
   - 房间页顶部状态栏: 返回按钮 | 房间名（服务器自生）| 在线设备数量 | 服务器状态指示（正常/断线/重连中）| 二维码按钮。
   - 房间页中间消息流: 纯列表风格（无气泡），每条消息一行，显示设备名 + 内容 + 时间戳；文件消息内嵌显示文件名 + 大小 + 传输模式标签（中转/P2P）+ 进度条 + 接受/拒绝按钮，被他人接收后该消息显示"已被接收"，与文字消息混排。
   - 房间页底部操作条: 文字输入框 + 发送按钮 | 发送文件按钮（选择文件）| 在线设备列表按钮（弹窗）；支持拖拽文件到页面触发发送；支持截图/粘贴图片发送（paste 事件）。
   - 当 pinEnabled=false 时隐藏 PIN 输入，直接以空 PIN 入房。
7. Phase 6 - 房间内二维码（依赖 6）: 将二维码入口放到房间页，点击后弹窗展示当前房间加入链接（包含 server 地址、roomHint、PIN，扫码一步入房），二维码为静态不失效。
8. Phase 7 - localStorage 持久化（依赖 6）: 用 filesyncex.rooms 保存房间记录（PIN + 自生房间名 + 进入时间），最多 20 条去重；用 filesyncex.lastRoom 存储最近房间供加载时自动跳转。
9. Phase 8 - 容错与日志（依赖 4a、4b、6、7、8）: 增加连接/入房/传输日志，补齐超时清理、断连清理、错误提示（PIN 非法、房间不存在、目标离线、传输中断）。

**Frontend Baseline（已确认）**
- React: 页面与状态管理框架，承载 WelcomePage / RoomPage / 各功能组件。
- pico.css: 全局基础样式与语义化控件，不引入重型 UI 框架。
- @heroicons/react: 统一图标风格（设备状态、复制、扫码、发送、接收等）。
- qrcodejs: 仅用于房间内二维码弹窗，不在首页默认渲染。
- clipboard.js: 一键复制，采用顶部 toast 提示复制成功。

**Relevant files（待创建）**
- package.json
- pnpm-workspace.yaml
- packages/shared/src/protocols/PtlJoinRoom.ts
- packages/shared/src/protocols/MsgRoomState.ts
- packages/shared/src/protocols/MsgFileOffer.ts
- packages/shared/src/protocols/MsgFileStatus.ts
- packages/shared/src/protocols/MsgP2PSignal.ts
- packages/backend/src/models/RoomManager.ts
- packages/backend/src/models/TransferManager.ts
- packages/backend/src/api/ApiJoinRoom.ts
- packages/backend/src/routes/transfer.ts
- packages/backend/src/services/P2PSignalService.ts
- packages/frontend/src/pages/WelcomePage.tsx
- packages/frontend/src/pages/RoomPage.tsx
- packages/frontend/src/components/RoomQrModal.tsx
- packages/frontend/src/components/DeviceListModal.tsx
- packages/frontend/src/components/ServerStatusBadge.tsx
- packages/frontend/src/utils/roomHistory.ts

**Verification**
1. pinEnabled=false: 多端自动进入 GLOBAL 房间并互相可见。
2. pinEnabled=true: 同 PIN 同房互通，不同 PIN 隔离不可见。
3. pinEnabled=true 下空 PIN 进入 GLOBAL，非 4 位数字报错。
4. 首次访问显示欢迎页；有历史记录时加载立即跳转最近房间。
5. 点击返回进入欢迎页，历史房间列表正确展示，可点重入。
6. 房间页点击二维码按钮才弹出 QR，扫码可直接入房。
7. 中转模式（Mode 1）：1GB 文件全程流式、不落盘、进度正常，断连可终止并提示。
8. P2P 模式（Mode 2）：超阈值文件自动切换 P2P；手动选择 P2P 传输；第一个接受者独占传输；其余人消息状态显示"已被接收"。
9. 跨房间收发被拒绝，服务器有日志。

**Decisions（全部已确认）**
- 前端: React + pico.css + @heroicons/react + qrcodejs + clipboard.js。
- PIN: 可关闭（全员 GLOBAL）；开启时严格 4 位数字，空值进入 GLOBAL。
- 欢迎页: 首次无历史时显示 LOGO + PIN 输入 + 按钮；有历史加载时自动跳转。
- 欢迎页历史列表: PIN + 服务器自生房间名 + 进入时间，可点重入；始终自动跳最近房间，返回后不清除记录。
- localStorage: filesyncex.rooms（最多 20 条）+ filesyncex.lastRoom。
- 房间页顶部状态栏: 返回 | 房间名 | 在线设备数 | 服务器状态（正常/断线/重连中）| 二维码按钮。
- 房间页消息流: 纯列表风格，无气泡；文件消息内嵌进度条 + 接受/拒绝按钮，与文字混排。
- 房间页底部操作条: 文字输入框+发送 | 选择文件 | 设备列表弹窗；支持拖拽文件到页面发送；支持 paste 粘贴图片发送。
- 文字发送: Enter 发送，Shift+Enter 换行。
- 文件/文字发送目标: 广播给房间所有人，任何人均可接受。
- 文件接收: 在消息流中内嵌接受/拒绝按钮，不弹独立弹窗。
- 传输进度: 发送方和接收方的消息条目中均显示各自的进度条。
- vConsole: URL 带 ?debug=1 时挂载，其他情况不加载。
- 消息历史: 服务端保留最近 100 条，不主动过期，任意成员可清理。
- 设备名: 自动生成（平台 + 随机后缀，如 Android-A3F2）。
- 二维码: 含 PIN 的静态 QR，仅房间内按需展示。
- 移动端: 同一套响应式页面。
- 文件传输双模式:
  - 中转模式（默认）: HTTP PassThrough 流式中转，不落盘，第一个接受者独占传输。
  - P2P 模式: WebRTC DataChannel 点对点直传，超过阈值（服务器配置，默认 10GB）自动触发或用户手动选择；服务器只转发信令；第一个接受者独占，其余人显示"已被接收"，传输完成后同。
- P2P 技术栈: WebRTC DataChannel，仅 STUN（局域网场景无需 TURN）。
- P2P 阈值: 服务器配置项，默认 10GB，固定不可运行时更改。
- 排除: mDNS 自动发现、离线文件暂存、断点续传、TURN 服务器。

**Status**

**当前进度**
- ✅ 项目概念与范围确定（LAN 文件/文字共享系统）
- ✅ 技术栈完全确认（TSRPC + React + pico.css + @heroicons + qrcodejs + clipboard.js）
- ✅ 房间系统设计完成（PIN on/off、GLOBAL 房间、4位数字严格校验、empty→GLOBAL）
- ✅ 欢迎页 UX 完成设计（首次显示 LOGO+PIN+button、历史列表、自动跳转、localStorage）
- ✅ 房间页 UI 与交互完成设计（9 元素顶bar + 纯列表消息流 + 底部操作条）
- ✅ 消息历史与管理完成（服务端保留100条、任意成员可清理）
- ✅ 设备名与二维码完成设计（自动生成、QR房间内按需）
- ✅ **文件传输双模式架构确认**（中转Mode1：HTTP PassThrough不落盘；P2P Mode2：WebRTC DataChannel、>10GB阈值、第一接受者独占）
- ✅ Phase 编号与依赖关系更新完成（4分4a+4b、5→6、6→7、7→8、8→9）
- ✅ 新增协议文件列表（MsgFileStatus.ts、MsgP2PSignal.ts）
- ✅ 新增后端服务（P2PSignalService.ts）

**下一阶段任务（选一个继续）**
1. **协议字段定义** — 逐个定义 TSRPC 消息类型的 TS 字段
   - PtlJoinRoom: request(pinCode) / response(roomId, roomName, createdAt)
   - MsgRoomState: onlineUsers, isP2PAvailable, threshold
   - MsgFileOffer: fileId, fileName, size, transferMode(RELAY|P2P)
   - MsgFileStatus: fileId, status(PENDING|P2P_WAITING|ACCEPTED|TRANSFERRING|COMPLETED), acceptedBy, rejectedBy
   - MsgP2PSignal: type(OFFER|ANSWER|ICE), payload, iceCandidates
   - ... 其他消息定义

2. **后端配置规格** — 定义服务端启动配置项
   - 监听端口（HTTP + TSRPC WS）
   - P2P 阈值大小（默认 10GB，字节制）
   - 房间名自动生成规则（前缀 + UUID + timestamp 截断）
   - 消息历史上限（100条硬限）
   - STUN 服务器列表（Google/Cloudflare 默认值）
   - 连接超时、心跳间隔等参数

3. **前端配置规格** — 定义客户端常量与行为
   - localStorage 键名、最大房间历史条数
   - 消息发送超时提示
   - 图片粘贴的尺寸限制
   - QR 显示与扫码重定向逻辑
   - 进度条更新频率

4. **直接开始 Phase 1 实现** — 初始化 monorepo 工程结构

**已确认的核心设计决策**
- 双模式传输：中转（HTTP PassThrough 不落盘）+ P2P（WebRTC DataChannel STUN-only）
- P2P 独占机制：第一个接受者独占传输，其余人消息显示"已被接收"
- P2P 阈值：服务器配置项，默认 10GB，固定（不可运行时动态调整）
- 房间人数限制：无限制（不排除但暂不设上限）
- 断点续传：排除（纯流式传输）
- 离线存储：排除（无 disk storage）
- TURN 服务器：排除（LAN 场景仅用 STUN）
- mDNS 自动发现：排除（QR 码与手动 IP 入房）

**待细化或确认的细节**
- [ ] P2P 信令消息在 TSRPC 中的确切字段与 ICE 转发方式
- [ ] 房间名生成算法 (需要用户建议规则)
- [ ] 图片粘贴的格式与压缩策略
- [ ] 移动端拖拽文件实现方式（Web API 兼容性）
- [ ] vConsole 与生产环境的日志分离策略
- [ ] 用户被动掉线vs主动断开的区分处理

**2026-04-10 Session 总结**
- 任务：从基础架构规划迭代至双模式文件传输架构
- 方法：用户提需求 → agent 用 vscode_askQuestions 澄清 → 记录决策 → 更新 plan.md
- 结果：9阶段完整计划 + 所有核心UI/架构决策已确认 + 两个新协议文件/一个新服务加入计划
- 代码状态：0行代码（pure planning phase）
- 模式：持续在 Plan Mode，尚未切换到实现模式