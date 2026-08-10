import type { ClientFrameT, ServerFrameT, DeviceInfoT, MsgDataT } from "@filesyncex/protocol";

interface WsHandlers {
  onConnecting?: () => void;
  onOpen?: () => void;
  onClose?: () => void;
  onWelcome?: (self: DeviceInfoT, msgs: MsgDataT[], peers: DeviceInfoT[]) => void;
  onAdd?: (msg: MsgDataT) => void;
  onDel?: (id: string) => void;
  onPeers?: (peers: DeviceInfoT[]) => void;
  onRenamed?: (device: DeviceInfoT) => void;
  /** 服务器通知（异常/维护/关闭） */
  onNotice?: (level: string, message: string) => void;
}

const HEARTBEAT_MS = 30_000; // 心跳间隔
const HEARTBEAT_TIMEOUT_MS = 90_000; // 超过该时长未收到 pong 判定失联，强制重连

/** 轻量 WS 客户端：自动重连（指数退避）、帧收发、心跳检测（30s ping / pong 失联重连） */
export class WsClient {
  private ws: WebSocket | null = null;
  private url: string;
  private handlers: WsHandlers;
  private retry = 0;
  private closedByUser = false;
  private queue: ClientFrameT[] = [];
  private hbTimer: ReturnType<typeof setInterval> | null = null;
  private lastPong = 0;
  connected = false;

  constructor(url: string, handlers: WsHandlers) {
    this.url = url;
    this.handlers = handlers;
  }

  connect(): void {
    this.closedByUser = false;
    this.handlers.onConnecting?.();
    try {
      this.ws = new WebSocket(this.url);
    } catch {
      return;
    }
    this.ws.onopen = () => {
      this.connected = true;
      this.retry = 0;
      this.lastPong = Date.now();
      this.startHeartbeat();
      this.handlers.onOpen?.();
      // 补发连接期间缓存的帧
      for (const f of this.queue) this.send(f);
      this.queue = [];
    };
    this.ws.onmessage = (e) => {
      let frame: ServerFrameT;
      try {
        frame = JSON.parse(String(e.data)) as ServerFrameT;
      } catch {
        return;
      }
      switch (frame.type) {
        case "welcome":
          this.handlers.onWelcome?.(frame.self, frame.msgs, frame.peers);
          break;
        case "add":
          this.handlers.onAdd?.(frame.msg);
          break;
        case "del":
          this.handlers.onDel?.(frame.id);
          break;
        case "peers":
          this.handlers.onPeers?.(frame.peers);
          break;
        case "renamed":
          this.handlers.onRenamed?.(frame.device);
          break;
        case "pong":
          this.lastPong = Date.now();
          break;
        case "notice":
          this.handlers.onNotice?.(frame.level, frame.message);
          break;
        default:
          break;
      }
    };
    this.ws.onclose = () => {
      this.connected = false;
      this.stopHeartbeat();
      this.handlers.onClose?.();
      if (!this.closedByUser) {
        const delay = Math.min(1000 * 2 ** this.retry, 15000);
        this.retry++;
        setTimeout(() => this.connect(), delay);
      }
    };
    this.ws.onerror = () => {
      try {
        this.ws?.close();
      } catch {
        /* noop */
      }
    };
  }

  /** 心跳：每 30s 发一次 ping；超过 90s 未收到 pong 判定失联，主动关闭触发重连 */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.hbTimer = setInterval(() => {
      if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastPong > HEARTBEAT_TIMEOUT_MS) {
        // 失联：关闭连接，触发自动重连
        try {
          this.ws.close();
        } catch {
          /* noop */
        }
        return;
      }
      try {
        this.ws.send(JSON.stringify({ type: "ping" } satisfies ClientFrameT));
      } catch {
        /* noop */
      }
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.hbTimer) {
      clearInterval(this.hbTimer);
      this.hbTimer = null;
    }
  }

  /** 未连接时缓存，连接后补发（保证 hello 最先） */
  send(frame: ClientFrameT): void {
    if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.queue.push(frame);
      return;
    }
    this.ws.send(JSON.stringify(frame));
  }

  close(): void {
    this.closedByUser = true;
    this.stopHeartbeat();
    this.ws?.close();
  }

  /** 通知确认后主动重连：关闭现有连接并立即重连（重置指数退避） */
  forceReconnect(): void {
    this.closedByUser = false;
    this.retry = 0;
    try {
      this.ws?.close();
    } catch {
      /* noop */
    }
    this.connect();
  }
}
