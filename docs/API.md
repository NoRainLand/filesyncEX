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
| 数据 | 上传文件落盘在服务器 `data/uploads/`（`uploadDir`），消息/索引持久化 |
| 字符集 | 文件名/消息支持 UTF-8；下载响应按文件原始字节 |
| WebSocket | 实时消息走 `ws://<host>:<port>/ws`（可选，见 §8） |

---

## 2. 通用约定

- 请求 `Content-Type`：普通接口 `application/json`；分片 / direct / cover 上传为**原始二进制**（`application/octet-stream`）。
- 响应均为 JSON；失败统一返回 `HTTP 400` + `{ "error": "原因" }`。
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

---

## 4. GET /api/health

健康检查，返回真实局域网 IP 与实际监听端口（端口自动切换时用它拿真实端口）。

**响应 `200`：**

```json
{
  "ok": true,
  "name": "filesyncEX",
  "version": "6.0.1",
  "lanIp": "192.168.1.100",
  "port": 4100
}
```

> QuickSendTool 用法：先连本机 `127.0.0.1:<端口>`，用返回的 `lanIp:port` 作为局域网内发送目标。

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

分片大小固定 **1 MiB**（服务器 `chunkSize`），以 `init` 返回为准。

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
  "chunkSize": 1048576,     // 每片字节数
  "chunkCount": 100,
  "done": [0, 1, 2],        // 已传分片下标（断点续传时跳过）
  "existed": false          // true = 秒传命中，无需再传
}
```

> **秒传**：若 `existed === true`，文件已存在，直接结束，服务器已广播文件消息。
> **断点续传**：带上次 `uploadId`（且 `name`/`size` 一致）→ 复用会话，用 `done` 跳过已传分片。

#### ② POST /api/upload/chunk/:uploadId/:index

请求体 = **第 index 个分片的原始二进制**（每片 ≤ `chunkSize`，最后一片可不足）。

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
   - >8 MiB → `init` → 按 `chunkSize` 分片逐个 `chunk` → `complete`。
4. **完成提示**：`msg` 已广播，所有在线设备收到文件消息；用 `url` 可下载。
5. 可选：上传失败重试时复用 `uploadId` 实现断点续传。
