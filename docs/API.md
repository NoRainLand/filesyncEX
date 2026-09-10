# filesyncEX HTTP API 技术文档

> 用于开发 / 修改 **QuickSendTool**（Windows 右键发送工具）等第三方 HTTP 客户端。
> 服务端实现：`packages/server/src/HttpServer.ts`、`packages/server/src/upload.ts`；协议类型：`packages/protocol/src/schema.ts`。

---

## 1. 概览

| 项 | 说明 |
|---|---|
| 协议 | HTTP/1.1 + JSON（上传分片为二进制） |
| 默认端口 | **4100**（`serverConfig.json` 的 `httpPort` 可改；开发环境常用 4197/4199） |
| 端口冲突 | 端口被占用时**自动向后切换**，实际端口以 `GET /api/health` 返回的 `port` 为准 |
| 地址 | 局域网 IP（`health.lanIp`）+ 实际端口 |
| 单文件上限 | 默认 **16 GiB**（`serverConfig.json` 的 `maxFileSize` 可改，0 = 不限制）；≤ 直传阈值（默认 8 MiB）整块上传，更大走分片（切片按文件大小动态取 1–8 MiB） |
| 数据 | 上传文件落盘在服务器 `data/uploads/`（`uploadDir`），消息/索引持久化 |
| 字符集 | 文件名/消息支持 UTF-8；下载响应按文件原始字节 |
| WebSocket | 实时消息走 `ws://<host>:<port>/ws`（可选，见 §8） |
| 管理接口 | `/api/sys/*`、`/api/data/export`、`/api/app/download` 为**本机管理能力**，需令牌（见 §4.1） |
| 版本号 | `health.version` 来自仓库根 `package.json`（打包时内联，开发时运行时读取），不要写死版本做判断 |

---

## 2. 通用约定

- 请求 `Content-Type`：普通接口 `application/json`；分片 / direct / cover 上传为**原始二进制**（`application/octet-stream`）。
- 响应均为 JSON；失败统一返回 `HTTP 400` + `{ "error": "原因" }`；鉴权失败为 `403`。
- 业务接口（health / msgs / upload / file / stream）**不需要令牌**，第三方客户端（如 QuickSendTool）行为与旧版完全一致。
- `device`（设备身份）是所有上传接口必需的字段，QuickSendTool 每次启动生成一个稳定身份即可：

```jsonc
{
  "deviceId": "qst-8f3a2c1e",   // 全局唯一，建议用 GUID 或 MAC+进程号生成
  "deviceName": "QuickSendTool", // 发送者显示名（≤40 字符）
  "color": "#047878",            // 头像色（任意 hex）
  "platform": "windows"          // windows | macos | linux | android | ios | other
}
```

---

## 3. 端点总览

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/health` | 健康检查 / 探测服务器地址与版本 |
| GET | `/api/msgs` | 消息历史（REST 兜底） |
| POST | `/api/upload/init` | 分片上传：初始化（返回分片参数 / 秒传） |
| POST | `/api/upload/chunk/:uploadId/:index` | 分片上传：提交一个分片（二进制） |
| POST | `/api/upload/complete/:uploadId` | 分片上传：完成（组装 + 广播文件消息） |
| POST | `/api/upload/direct` | 小文件（≤8 MiB）直接上传 |
| POST | `/api/upload/cover` | 视频封面图上传 |
| GET | `/api/file/:key` | 下载文件 / 封面 |
| GET | `/api/stream/:key` | 音频转码为 WAV 流（支持 Range） |
| GET | `/api/auth` | 取本机管理令牌（同源可读，见 §4.1） |
| POST | `/api/msg/:id/cover` | 为已存在消息补封面（已有封面返回 409） |
| POST | `/api/sys/autostart` | 开机自启开关（仅打包 exe + Windows，**需令牌**） |
| GET | `/api/sys/autostart` | 查询开机自启状态（**需令牌**） |
| POST | `/api/sys/shutdown` | 关闭服务器（**需令牌**） |
| POST | `/api/sys/reset` | 清空全部消息与文件（**需令牌**） |
| GET | `/api/data/export` | 导出全部数据为 zip（**需令牌**，流式） |
| GET | `/api/app/download` | 下载服务器本体 exe（仅打包模式，**需令牌**） |

---

## 4. GET /api/health

健康检查，返回真实局域网 IP 与实际监听端口（端口自动切换时用它拿真实端口）。

**响应 `200`：**

```json
{
  "ok": true,
  "name": "filesyncEX",
  "version": "6.2.0",
  "lanIp": "192.168.1.100",
  "lanIps": ["192.168.1.100", "10.0.0.5"],
  "port": 4100,
  "limits": { "directUpload": 8388608, "maxFileSize": 17179869184, "chunkSizeMin": 1048576, "chunkSizeMax": 8388608 }
}
```

> QuickSendTool 用法：先连本机 `127.0.0.1:<端口>`，用返回的 `lanIp:port` 作为局域网内发送目标。
> `lanIps` 是**全部**可用局域网地址（已按「物理网卡 + 私网段」优先排序）：装了 VMware/Hyper-V/WSL/VPN 的机器上，
> 首个地址未必是手机能连上的那个，可依次尝试。

**上传限制（`limits` 字段，客户端应据此做上传前预检）：**

| 字段 | 含义 | 默认值 |
|---|---|---|
| `limits.directUpload` | ≤ 该字节数走 `POST /api/upload/direct`（跳过哈希/分片） | 8 MiB |
| `limits.maxFileSize` | **单文件上限**（0 = 不限制）；超过时 `init` 直接返回 400 | **16 GiB** |
| `limits.chunkSizeMin` / `chunkSizeMax` | 切片大小**区间**（按文件大小自动取；两者相等即固定切片） | 1 MiB – 8 MiB |

> 建议客户端在**计算 SHA-256 之前**就比对 `maxFileSize`，避免大文件白算哈希再被拒；
> 并用 `directUpload` 判断走直传还是分片（不要自行硬编码阈值）。
> 服务端权威兜底：`POST /api/upload/init` 超限返回
> `400 { "error": "文件过大：3.0 MB 超过单文件上限 2.0 MB（可在 serverConfig.json 调整 maxFileSize，0 = 不限制）" }`；
> 单片超过约定大小返回 `400 { "error": "分片过大：…（应为 1.0 MB/片，请按 init 返回的 chunkSize 切分）" }`。
> 各项均可在 `serverConfig.json` 配置：`{ "maxFileSize": 17179869184, "chunkSizeMin": 1048576, "chunkSizeMax": 8388608, "directUpload": 8388608 }`
> （`directUpload > maxFileSize`、`chunkSizeMin > chunkSizeMax` 都会被自动收敛并告警；旧版配置的 `chunkSize` 会自动迁移为等值的 min=max，行为不变）。

### 4.1 管理接口鉴权（`GET /api/auth`）

`/api/sys/*`、`/api/data/export`、`/api/app/download` 能**关机、清空全部数据、改开机自启、导出全部聊天记录**，
因此需要令牌 + 来源校验，防止局域网内任意网页跨站触发（CORS 只拦读取响应，不拦请求发出）。

**取令牌（同源可读，跨站被 CORS 拦住）：**

```http
GET /api/auth
→ 200 { "token": "48 位十六进制字符串" }
```

> 令牌在服务器**每次启动时随机生成**（不落盘）。服务器重启后旧令牌失效，需重新获取。

**调用管理接口（二选一）：**

```http
X-FSEX-Token: <token>
```

或查询参数 `?token=<token>`（便于 `<a download>` 直接触发下载）。

**来源校验规则：**

| 请求来源 | 行为 |
|---|---|
| 无 `Origin` 且无 `Sec-Fetch-Site`（curl / QuickSendTool 等非浏览器客户端） | 仅校验令牌 |
| 同源，或 `localhost` / `127.0.0.1` / `[::1]`（任意端口，兼容开发模式） | 放行 |
| 其它 `Origin`，或 `Sec-Fetch-Site: cross-site` | `403`（即使令牌正确） |

失败响应：`403 { "error": "缺少或无效的访问令牌（…）" }` 或 `{ "error": "拒绝跨站来源的本机管理请求（…）" }`。

**注意**：业务接口（上传 / 下载 / 消息 / 音频流）**不需要**令牌 —— 这是刻意设计，保证 QuickSendTool 等已有客户端无需改造。

---

## 5. GET /api/msgs

返回全部消息历史（REST 兜底；实时列表走 WebSocket）。

**响应 `200`：**`MsgData[]`（数组），元素结构见 §7。

---

## 6. 上传

### 6.1 选择上传方式

| 文件大小 | 推荐接口 |
|---|---|
| ≤ **8 MiB** | `POST /api/upload/direct`（一步到位） |
| > 8 MiB | 分片上传：`init → chunk×N → complete` |
| 任意（想秒传） | 分片 `init` 带 `sha256`，命中则秒传不传文件 |

分片大小**按文件大小动态取**（默认 1–8 MiB：4 GiB 内 1 MiB、16 GiB 4 MiB、32 GiB 以上 8 MiB，目标分片数 ~4096），**一律以 `init` 返回的 `chunkSize` 为准**。

### 6.2 POST /api/upload/direct（小文件）

整块文件放请求体（二进制），参数走 query。

- `name`（必填）：文件名
- `mime`（可选）：MIME 类型
- `device`（必填）：URL 编码的 JSON（设备身份）
- `coverKey`（可选）：视频封面 key（先调 §6.5）

**请求示例：**

```
POST /api/upload/direct?name=report.pdf&mime=application/pdf&device=%7B%22deviceId%22%3A%22qst-1%22%2C%22deviceName%22%3A%22QuickSendTool%22%2C%22color%22%3A%22%23047878%22%2C%22platform%22%3A%22windows%22%7D
Content-Type: application/octet-stream

<文件二进制>
```

**响应 `200`：**

```json
{
  "ok": true,
  "msg": { "...": "见 §7，广播到所有设备" }
}
```

> `device` 必须用 `encodeURIComponent(JSON.stringify(device))` 编码。

### 6.3 分片上传（大文件 / 断点续传 / 秒传）

#### ① POST /api/upload/init

请求体 JSON：

```json
{
  "name": "big-video.mp4",
  "size": 104857600,            // 字节
  "mime": "video/mp4",          // 可选
  "sha256": "a1b2...",          // 可选：文件整体 SHA-256（秒传去重）
  "device": { "deviceId": "...", "deviceName": "QuickSendTool", "color": "#047878", "platform": "windows" },
  "uploadId": "xxx",            // 可选：上次中断的 uploadId（断点续传）
  "coverKey": ""                // 可选：视频封面 key
}
```

响应 `200`：

```json
{
  "uploadId": "0e1f2a3b-...",
  "chunkSize": 1048576,     // 每片字节数（按文件大小动态计算，客户端必须用这个值切分）
  "chunkCount": 100,
  "done": [0, 1, 2],        // 已传分片下标（断点续传时跳过）
  "existed": false          // true = 秒传命中，无需再传
}
```

> **秒传**：若 `existed === true`，文件已存在，直接结束，服务器已广播文件消息。
> **断点续传**：带上次 `uploadId`（且 `name`/`size` 一致）→ 复用会话，用 `done` 跳过已传分片。

#### ② POST /api/upload/chunk/:uploadId/:index

请求体 = **第 index 个分片的原始二进制**（每片 ≤ `init` 返回的 `chunkSize`，最后一片可不足）。

```
POST /api/upload/chunk/0e1f2a3b-.../3
Content-Type: application/octet-stream

<第 3 片二进制>
```

响应 `200`：

```json
{ "ok": true, "index": 3 }
```

#### ③ POST /api/upload/complete/:uploadId

服务器把全部分片组装为最终文件、计算 SHA-256、广播文件消息。

```
POST /api/upload/complete/0e1f2a3b-...
```

响应 `200`：

```json
{ "ok": true, "msg": { "...": "见 §7" } }
```

### 6.4 POST /api/upload/cover（视频封面，可选）

请求体 = JPEG 二进制（≤4 MiB）。

**响应 `200`：**

```json
{ "coverKey": "8f3a2c1e_cover.jpg" }
```

把 `coverKey` 传给 `direct`/`init` 的 `coverKey`，消息即携带封面图。

---

## 7. 数据模型

### 消息 MsgData（`/api/msgs`、上传返回的 `msg` 通用）

```jsonc
{
  "id": "5f7a...",                 // 全局唯一
  "kind": "file",                  // text | file | image | audio | video | code
  "sender": {
    "deviceId": "qst-1",
    "deviceName": "QuickSendTool",
    "color": "#047878",
    "platform": "windows"
  },
  "ts": 1755000000000,             // epoch 毫秒
  "text": "hello",                 // kind=text 时
  "code": { "lang": "ts", "content": "..." },  // kind=code 时
  "file": {                         // kind=file/image/audio/video 时
    "name": "report.pdf",
    "size": 102400,
    "mime": "application/pdf",
    "key": "5f7a..._report.pdf",
    "url": "/api/file/5f7a..._report.pdf",   // 下载路径
    "sha256": "a1b2...",
    "cover": "/api/file/8f3a2c1e_cover.jpg"  // 视频封面（可选）
  }
}
```

> 上传后 kind 由服务器按 MIME / 扩展名自动判定：`image/*`→image、`audio/*`→audio、`video/*`→video，其余→file。
> 下载完整地址 = `http://<lanIp>:<port> + url`。

---

## 8. WebSocket（可选，实时消息 / 发送文本）

- 地址：`ws://<host>:<port>/ws`
- 连上后先发 `hello`（携带 device），服务器回 `welcome`（含历史消息与在线设备）。
- 发送文本/代码：发 `send` 帧（`kind` 为 `text`/`code`，`id` 由服务端补全），服务端广播 `add` 帧。
- 心跳：客户端每 30s 发 `ping`，服务端回 `pong`。

```jsonc
// 客户端 → 服务端
{ "type": "hello", "device": { "...": "见 §2" } }
{ "type": "send", "msg": { "kind": "text", "text": "来自 QuickSendTool" } }
{ "type": "send", "msg": { "kind": "code", "code": { "lang": "ts", "content": "const a = 1;" } } }
```

> QuickSendTool 仅做"右键发送文件"时**不需要** WebSocket，用 §6 的 HTTP 上传即可。

---

## 9. QuickSendTool 推荐流程（最小实现）

1. **探测**：`GET /api/health` → 拿 `lanIp`、`port`、`version`。
2. **构造设备身份**：稳定 `deviceId` + `deviceName="QuickSendTool"` + `platform="windows"`。
3. **上传文件**：
   - ≤8 MiB → `POST /api/upload/direct`（body=文件，query 带 name/mime/device）。
   - >8 MiB → `init`（返回本文件的 `chunkSize`/`chunkCount`）→ 按 `chunkSize` 分片逐个 `chunk` → `complete`。
4. **完成提示**：`msg` 已广播，所有在线设备收到文件消息；用 `url` 可下载。
5. 可选：上传失败重试时复用 `uploadId` 实现断点续传。
