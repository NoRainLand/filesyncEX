import type { DeviceInfoT, MsgDataT } from "@filesyncex/protocol";
import type { Store } from "./Store.js";
import { EventBus } from "./EventBus.js";

export interface EngineOptions {
  /** 消息历史保留条数上限（超出按时间裁剪） */
  historyLimit?: number;
  /** 本机设备信息（server 层注入，welcome 时返回） */
  self?: DeviceInfoT;
}

/**
 * 同步引擎：纯业务，零传输依赖。
 * 负责消息的增删查、历史裁剪、事件发布；设备在线状态由 server 层通过
 * setPeers / renameDevice 喂入，引擎统一向外广播 peers 事件。
 */
export class SyncEngine {
  readonly events = new EventBus();
  private store: Store;
  private limit: number;
  self?: DeviceInfoT;

  constructor(store: Store, opts: EngineOptions = {}) {
    this.store = store;
    this.limit = opts.historyLimit ?? 500;
    if (opts.self) this.self = opts.self;
  }

  /* ---------- 消息 ---------- */

  async init(): Promise<void> {
    await this.store.init();
  }

  /** 新增消息（本地用户发送或本机上传完成）并广播 */
  async addMessage(msg: MsgDataT): Promise<MsgDataT> {
    await this.store.saveMessage(msg);
    await this.trim();
    this.events.emit("message", { msg, fromSelf: !!this.self && msg.sender.deviceId === this.self.deviceId });
    return msg;
  }

  async listMessages(limit?: number): Promise<MsgDataT[]> {
    return this.store.listMessages(limit ?? this.limit);
  }

  async getMessage(id: string): Promise<MsgDataT | undefined> {
    return this.store.getMessage(id);
  }

  /** 更新消息（如补充视频封面）并广播 */
  async updateMessage(id: string, msg: MsgDataT): Promise<void> {
    await this.store.updateMessage(id, msg);
    this.events.emit("updated", { msg });
  }

  async removeMessage(id: string): Promise<void> {
    const msg = await this.store.getMessage(id);
    if (!msg) return;
    await this.store.removeMessage(id);
    await this.releaseFileRef(msg);
    this.events.emit("deleted", { id });
  }

  /**
   * 消息被删除（含 trim 裁剪）时：文件引用 -1，归零则发 file-gc（server 删物理文件）。
   * 附件 key 与视频封面 coverKey 统一走引用计数（两者都由 server 在上传/补充封面时登记进文件索引）：
   * 同一物理文件被多条消息共享时，只有最后一条引用它的消息被删才会真正删除文件。
   */
  private async releaseFileRef(msg: MsgDataT): Promise<void> {
    const keys: string[] = [];
    if (msg.file?.key) keys.push(msg.file.key);
    const cover = msg.file?.cover;
    if (cover) {
      const m = /\/api\/file\/([^/]+)$/.exec(cover);
      if (m?.[1]) {
        try {
          const coverKey = decodeURIComponent(m[1]);
          // 封面 key 不会与附件 key 相同（附件 key 以 sha 前缀命名，封面为 <random>_cover.jpg），此处仍做防重
          if (coverKey && !keys.includes(coverKey)) keys.push(coverKey);
        } catch {
          /* 解码失败忽略 */
        }
      }
    }
    for (const key of keys) {
      try {
        const remain = await this.store.decrFileRef(key);
        if (remain <= 0) {
          await this.store.removeFile(key);
          this.events.emit("file-gc", { key });
        }
      } catch (e) {
        console.warn("[engine] 释放文件引用失败:", (e as Error).message);
      }
    }
  }

  /**
   * 历史裁剪：只删除超出上限的**消息**，不再删除其附件物理文件。
   * （超限的多是旧消息；若连带删除附件，用户会发现历史图片/文件“莫名消失”。
   *  文件索引与 refs 保持不变 —— 引用计数表示“还有多少条消息引用它”，
   *  这些消息已不在历史列表内，但文件仍可被仍存在的消息/后续清理流程安全处理。）
   */
  private async trim(): Promise<void> {
    const all = await this.store.listMessages(1_000_000);
    if (all.length <= this.limit) return;
    const drop = all.slice(0, all.length - this.limit);
    for (const m of drop) {
      await this.store.removeMessage(m.id);
    }
  }

  /* ---------- 设备（由 server 层调用） ---------- */

  setPeers(peers: DeviceInfoT[]): void {
    this.events.emit("peers", { peers });
  }

  /** 设备改名：返回更新后的设备信息 */
  renameDevice(device: DeviceInfoT, name: string): DeviceInfoT {
    const updated: DeviceInfoT = { ...device, deviceName: name };
    this.self = updated;
    return updated;
  }

  close(): Promise<void> {
    this.events.clear();
    return this.store.close();
  }
}
