import { chatOf, type ConvKey } from "./conv.js";
import type { StateManager } from "./state.js";
import type { SessionTopic, SessionTopics } from "./session-topics.js";
import { createHash } from "node:crypto";

export interface PinEntry { id: string; binding: string }
export interface PinUser { revision: number; entries: PinEntry[] }
export interface PinData { version: 1; chat: ConvKey; users: Record<string, PinUser> }
export function pinBinding(link: SessionTopic): string {
  return createHash("sha256").update(JSON.stringify([link.sessionID, link.identity?.source, link.identity?.projectID, link.identity?.createdAt])).digest("hex");
}
export class SessionPins {
  constructor(private store: StateManager, private topics: SessionTopics) {}
  private data(chat: ConvKey): PinData {
    if (chat !== chatOf(chat)) throw new Error("Ghim cá nhân thuộc General của nhóm.");
    const data = this.store.peek(chat)?.sessionPins;
    if (data === undefined) return { version: 1, chat, users: {} };
    if (!data || data.version !== 1 || data.chat !== chat || !data.users || typeof data.users !== "object" || Array.isArray(data.users) || Object.keys(data.users).length > 500 ||
      Object.entries(data.users).some(([id, user]) => !/^\d{1,16}$/.test(id) || !Number.isSafeInteger(Number(id)) || !user || !Number.isSafeInteger(user.revision) || user.revision < 0 ||
        !Array.isArray(user.entries) || user.entries.length > 20 || new Set(user.entries.map(entry => entry?.id)).size !== user.entries.length || user.entries.some(entry =>
          !entry || typeof entry.id !== "string" || !entry.id || entry.id.length > 128 || typeof entry.binding !== "string" || entry.binding.length > 2048))) throw new Error("Dữ liệu ghim hỏng/chưa hỗ trợ; giữ nguyên, không dùng để mở phiên khác.");
    return structuredClone(data);
  }
  user(chat: ConvKey, actor: number): PinUser {
    if (!Number.isSafeInteger(actor) || actor < 0) throw new Error("Không xác định được người dùng ghim.");
    return this.data(chat).users[String(actor)] ?? { revision: 0, entries: [] };
  }
  list(chat: ConvKey, actor: number) {
    const links = new Map(this.topics.list(chat).map(link => [link.id, link]));
    const counts = new Map<string, number>();
    for (const state of Object.values(this.store.all())) if (state.sessionID) counts.set(state.sessionID, (counts.get(state.sessionID) ?? 0) + 1);
    return this.user(chat, actor).entries.map(entry => {
      const link = links.get(entry.id);
      const available = Boolean(link && link.chat === chat && pinBinding(link) === entry.binding && link.sessionID && link.conv && link.identity &&
        this.store.peek(link.conv)?.sessionID === link.sessionID && this.store.findChatBySession(link.sessionID) === link.conv &&
        counts.get(link.sessionID) === 1);
      return { ...entry, available, link: available ? link : undefined };
    });
  }
  ids(chat: ConvKey, actor: number): ReadonlySet<string> { return new Set(this.list(chat, actor).filter(entry => entry.available).map(entry => entry.id)); }
  set(chat: ConvKey, actor: number, id: string, desired: boolean, revision: number): PinUser {
    const data = this.data(chat);
    const previous = this.user(chat, actor);
    if (previous.entries.some(entry => entry.id === id) === desired) return previous;
    if (previous.revision !== revision) throw new Error("Danh sách ghim đã đổi; mở lại thẻ cá nhân.");
    let entries = previous.entries.filter(entry => entry.id !== id);
    if (desired) {
      if (!/^[a-f0-9]{16}$/.test(id)) throw new Error("Mã liên kết ghim không hợp lệ.");
      const link = this.topics.get(id);
      if (!link || link.chat !== chat || !link.identity || !link.sessionID || !link.conv || this.store.peek(link.conv)?.sessionID !== link.sessionID ||
        this.store.findChatBySession(link.sessionID) !== link.conv || Object.values(this.store.all()).filter(state => state.sessionID === link.sessionID).length !== 1) throw new Error("Không thể ghim liên kết chưa xác minh thuộc nhóm.");
      if (entries.length >= 20) throw new Error("Đã đủ 20 ghim cho bạn trong nhóm; bỏ bớt trước khi thêm.");
      entries = [...entries, { id, binding: pinBinding(link) }];
    }
    const next = { revision: previous.revision + 1, entries };
    if (!Number.isSafeInteger(next.revision)) throw new Error("Mốc ghim không hợp lệ.");
    if (!data.users[String(actor)] && Object.keys(data.users).length >= 500) throw new Error("Đã đủ danh sách cá nhân được lưu trong nhóm.");
    data.users[String(actor)] = next;
    this.store.setRequired(chat, { sessionPins: data });
    return structuredClone(next);
  }
}
