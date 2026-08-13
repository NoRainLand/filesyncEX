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

  /** 消息被删除（含 trim 裁剪）时：文件引用 -1，归零则发 file-gc（server 删物理文件）；视频封面无引用计数，删除消息即删封面物理文件 */
  private async releaseFileRef(msg: MsgDataT): Promise<void> {
    const key = msg.file?.key;
    if (key) {
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
    // 视频封面：无引用计数，且未进 store 文件索引，删除消息时直接发 file-gc 删物理文件
    const cover = msg.file?.cover;
    if (cover && cover !== key) {
      const m = /\/api\/file\/([^/]+)$/.exec(cover);
      if (m?.[1]) {
        try {
          const coverKey = decodeURIComponent(m[1]);
          if (coverKey && coverKey !== key) this.events.emit("file-gc", { key: coverKey });
        } catch {
          /* 解码失败忽略 */
        }
      }
    }
  }

  private async trim(): Promise<void> {
    const all = await this.store.listMessages(1_000_000);
    if (all.length <= this.limit) return;
    const drop = all.slice(0, all.length - this.limit);
    for (const m of drop) {
      await this.store.removeMessage(m.id);
      await this.releaseFileRef(m);
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
