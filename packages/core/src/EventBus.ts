/**
 * 轻量类型安全事件总线。
 * 纯业务事件在此发布/订阅，传输层（server）负责把事件映射为 WS 帧。
 */
export type Listener<T = unknown> = (payload: T) => void;

export interface EventMap {
  /** 新消息落库（含本机发送，广播给其他设备） */
  message: { msg: import("@filesyncex/protocol").MsgDataT; fromSelf: boolean };
  /** 消息被删除 */
  deleted: { id: string };
  /** 文件引用归零 → 请求删除物理文件（server 层订阅执行） */
  "file-gc": { key: string };
  /** 设备上线/下线/改名 */
  peers: { peers: import("@filesyncex/protocol").DeviceInfoT[] };
}

export class EventBus {
  private map = new Map<keyof EventMap, Set<Listener<any>>>();

  on<K extends keyof EventMap>(type: K, fn: Listener<EventMap[K]>): () => void {
    let set = this.map.get(type);
    if (!set) {
      set = new Set();
      this.map.set(type, set);
    }
    set.add(fn as Listener);
    return () => this.off(type, fn);
  }

  off<K extends keyof EventMap>(type: K, fn: Listener<EventMap[K]>): void {
    this.map.get(type)?.delete(fn as Listener);
  }

  emit<K extends keyof EventMap>(type: K, payload: EventMap[K]): void {
    const set = this.map.get(type);
    if (!set) return;
    for (const fn of set) {
      try {
        (fn as Listener<EventMap[K]>)(payload);
      } catch (e) {
        console.error("[EventBus] listener error:", e);
      }
    }
  }

  clear(): void {
    this.map.clear();
  }
}
