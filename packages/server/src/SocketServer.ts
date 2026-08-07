import type { WebSocketServer, WebSocket } from "ws";
import type { DeviceInfoT, MsgDataT } from "@filesyncex/protocol";
import { parse, ClientFrame, ServerFrame, MsgData } from "@filesyncex/protocol";
import { SyncEngine } from "@filesyncex/core";
import { randomUUID } from "node:crypto";

type Conn = { ws: WebSocket; device?: DeviceInfoT };

/**
 * WebSocket 传输层：把客户端帧接入 SyncEngine，并把引擎事件广播为服务端帧。
 * 协议见 packages/protocol（ClientFrame / ServerFrame）。
 */
export class SocketServer {
  private engine: SyncEngine;
  private wss: WebSocketServer;
  private conns = new Map<WebSocket, Conn>();
  private offs: (() => void)[] = [];

  constructor(engine: SyncEngine, wss: WebSocketServer) {
    this.engine = engine;
    this.wss = wss;

    wss.on("connection", (ws) => this.handleConnection(ws));

    // 引擎事件 → 广播（含发送者，前端按 id 去重实现回显）
    this.offs.push(engine.events.on("message", ({ msg }) => {
      this.broadcast({ type: "add", msg });
    }));
    this.offs.push(engine.events.on("deleted", ({ id }) => this.broadcast({ type: "del", id })));
    this.offs.push(engine.events.on("peers", ({ peers }) => this.broadcast({ type: "peers", peers })));
  }

  private handleConnection(ws: WebSocket): void {
    const conn: Conn = { ws };
    this.conns.set(ws, conn);

    ws.on("message", async (raw) => {
      let frame;
      try {
        frame = parse(ClientFrame, JSON.parse(raw.toString()));
      } catch {
        this.send(ws, { type: "pong" }); // 非法帧静默忽略
        return;
      }
      try {
        await this.onFrame(conn, frame);
      } catch (e) {
        console.error("[ws] 处理帧失败:", e);
      }
    });

    ws.on("close", () => this.handleClose(conn));
    ws.on("error", () => this.handleClose(conn));
  }

  private async onFrame(conn: Conn, frame: import("@filesyncex/protocol").ClientFrameT): Promise<void> {
    switch (frame.type) {
      case "hello": {
        conn.device = frame.device;
        if (!this.engine.self) this.engine.self = frame.device;
        const peers = this.peerList();
        const msgs = await this.engine.listMessages();
        this.send(conn.ws, { type: "welcome", self: frame.device, msgs, peers });
        this.engine.setPeers(peers);
        break;
      }
      case "send": {
        if (!conn.device) return;
        const msg: MsgDataT = MsgData.parse({
          ...frame.msg,
          id: randomUUID(), // 服务端权威 id
          sender: conn.device, // 以登记的设备身份为准
          ts: Date.now(),
        });
        await this.engine.addMessage(msg);
        break;
      }
      case "del": {
        await this.engine.removeMessage(frame.id);
        break;
      }
      case "rename": {
        if (!conn.device) return;
        const updated = this.engine.renameDevice(conn.device, frame.name);
        conn.device = updated;
        this.engine.setPeers(this.peerList());
        this.broadcast({ type: "renamed", device: updated });
        break;
      }
      case "ping":
        this.send(conn.ws, { type: "pong" });
        break;
    }
  }

  private handleClose(conn: Conn): void {
    this.conns.delete(conn.ws);
    if (conn.device) this.engine.setPeers(this.peerList());
    try {
      conn.ws.close();
    } catch {
      /* noop */
    }
  }

  private peerList(): DeviceInfoT[] {
    const arr: DeviceInfoT[] = [];
    for (const c of this.conns.values()) if (c.device) arr.push(c.device);
    return arr;
  }

  private send(ws: WebSocket, frame: ServerFrame): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
  }

  private broadcast(frame: ServerFrame): void {
    const data = JSON.stringify(frame);
    for (const c of this.conns.values()) {
      if (c.ws.readyState === c.ws.OPEN) c.ws.send(data);
    }
  }

  close(): void {
    this.offs.forEach((off) => off());
    this.wss.close();
  }
}
