import type { ClientFrameT, ServerFrameT, DeviceInfoT, MsgDataT } from "@filesyncex/protocol";

export interface WsHandlers {
  onOpen?: () => void;
  onClose?: () => void;
  onWelcome?: (self: DeviceInfoT, msgs: MsgDataT[], peers: DeviceInfoT[]) => void;
  onAdd?: (msg: MsgDataT) => void;
  onDel?: (id: string) => void;
  onPeers?: (peers: DeviceInfoT[]) => void;
  onRenamed?: (device: DeviceInfoT) => void;
}

/** 轻量 WS 客户端：自动重连（指数退避）、帧收发 */
export class WsClient {
  private ws: WebSocket | null = null;
  private url: string;
  private handlers: WsHandlers;
  private retry = 0;
  private closedByUser = false;
  private queue: ClientFrameT[] = [];
  connected = false;

  constructor(url: string, handlers: WsHandlers) {
    this.url = url;
    this.handlers = handlers;
  }

  connect(): void {
    this.closedByUser = false;
    try {
      this.ws = new WebSocket(this.url);
    } catch {
      return;
    }
    this.ws.onopen = () => {
      this.connected = true;
      this.retry = 0;
      this.handlers.onOpen?.();
      // 补发连接期间缓存的帧
      for (const f of this.queue) this.send(f);
      this.queue = [];
    };
    this.ws.onmessage = (e) => {
      let frame: ServerFrameT;
      try {
        frame = JSON.parse(String(e.data));
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
        default:
          break;
      }
    };
    this.ws.onclose = () => {
      this.connected = false;
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
    this.ws?.close();
  }
}
