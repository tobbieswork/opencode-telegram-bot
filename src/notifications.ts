import { createHash, randomBytes } from "node:crypto";
import { chatOf, type ConvKey } from "./conv.js";
import { esc } from "./format.js";
import type { StateManager } from "./state.js";
import { quietUntil, validateQuiet, type QuietHours } from "./notification-time.js";

export const NOTICE_KINDS = ["question", "permission", "blocked", "completed", "reminder", "operational", "progress", "naming"] as const;
export type NoticeKind = typeof NOTICE_KINDS[number];
export const NOTICE_LABELS: Record<NoticeKind, string> = { question: "Cần trả lời", permission: "Cần cấp quyền", blocked: "Công việc bị chặn",
  completed: "Lượt đã kết thúc", reminder: "Nhắc yêu cầu đang chờ", operational: "Thông tin vận hành", progress: "Tiến độ", naming: "Lỗi tên chủ đề" };
export interface Notice {
  chat: ConvKey;
  conv: ConvKey;
  linkID: string;
  sessionID: string;
  binding: string;
  kind: NoticeKind;
  occurredAt: number;
  title: string;
  url?: string;
  reference?: { kind: "form" | "permission" | "input" | "operation"; id: string };
  occurrence?: number;
  direct?: boolean;
}
export interface NotificationSettings { version: 1 | 2; enabled: boolean; revision: number; quiet?: QuietHours }
export interface NotificationPorts {
  now(): number;
  deliver(chat: ConvKey, text: string, links: Array<{ text: string; url: string }>): Promise<number>;
  edit?(chat: ConvKey, messageID: number, text: string, links: Array<{ text: string; url: string }>): Promise<void>;
  resolve?(event: Notice): Promise<Notice | undefined>;
  holdUntil?(event: Notice): number | undefined;
}
export interface NoticeItem { key: string; event: Notice; state: "pending" | "sending" | "sent" | "unknown" | "dropped" | "failed";
  createdAt: number; dueAt: number; expiresAt: number; attempts: number; messageID?: number; error?: string; heldUntil?: number }
export interface NotificationQueue { version: 1; items: Record<string, NoticeItem>; blockedUntil?: number; batchAfter?: number }
export type NoticeDecision = "direct" | "off" | "immediate" | "batch" | "drop" | "defer";

export function noticeDecision(settings: NotificationSettings, event: Notice): NoticeDecision {
  if (event.direct) return "direct";
  if (!settings.enabled) return "off";
  if (event.kind === "progress") return "drop";
  return ["question", "permission", "blocked", "reminder"].includes(event.kind) ? "immediate" : "batch";
}
export function noticeKey(event: Notice): string {
  // Không nhận diện lượt theo tên phiên hoặc theo thời điểm của sự kiện SSE.
  return createHash("sha256").update(JSON.stringify([event.chat, event.conv, event.sessionID, event.binding, event.kind,
    event.reference ?? randomBytes(12).toString("hex"), event.occurrence ?? 0])).digest("hex");
}
export function noticeText(events: readonly Notice[]): string {
  if (events.some(event => event.chat !== events[0]?.chat || event.chat !== chatOf(event.conv))) throw new Error("Không gộp thông báo khác nhóm.");
  return "<b>Thông báo phiên</b>\n" + events.map(event => `• ${esc([...event.title].slice(0, 80).join(""))} — ${NOTICE_LABELS[event.kind]}`).join("\n") +
    "\nChỉ thông tin tóm lược; phản hồi và thao tác câu hỏi/quyền vẫn ở chủ đề của phiên.";
}

/** Chủ sở hữu chính sách thông báo; không có cổng gọi mô hình hay chạy công việc. */
export class Notifications {
  private timer?: ReturnType<typeof setInterval>;
  private draining?: Promise<void>;
  private recovered = false;
  private stopped = false;
  private cursor = 0;
  private receipts = new Map<string, number>();
  private quietCache = new Map<ConvKey, { revision: number; from: number; to: number; until?: number }>();
  constructor(protected store: StateManager, protected ports: NotificationPorts) {}
  settings(chat: ConvKey): NotificationSettings {
    if (chat !== chatOf(chat)) throw new Error("Thiết lập thông báo chỉ thuộc General.");
    const value = this.store.peek(chat)?.notificationSettings;
    if (value === undefined) return { version: 1, enabled: false, revision: 0 };
    if (!value || typeof value !== "object" || ![1, 2].includes(value.version) || typeof value.enabled !== "boolean" || !Number.isSafeInteger(value.revision) || value.revision < 0) throw new Error("Thiết lập thông báo chưa hỗ trợ; giữ dữ liệu và không tự bật.");
    if (value.quiet) validateQuiet(value.quiet);
    return structuredClone(value);
  }
  configure(chat: ConvKey, revision: number, enabled: boolean): NotificationSettings {
    const previous = this.settings(chat);
    this.queue(chat);
    if (previous.revision !== revision) throw new Error("Thiết lập thông báo đã đổi; xem trước lại.");
    if (previous.enabled === enabled) return previous;
    const next = { ...previous, enabled, revision: previous.revision + 1 };
    if (!Number.isSafeInteger(next.revision)) throw new Error("Mốc thiết lập thông báo không hợp lệ.");
    this.store.setRequired(chat, { notificationSettings: next });
    return next;
  }
  decision(event: Notice): NoticeDecision {
    if (event.direct) return "direct";
    if (event.chat !== chatOf(event.conv)) throw new Error("Thông báo không thuộc nhóm của phiên.");
    const decision = noticeDecision(this.settings(event.chat), event);
    return !["off", "direct", "drop"].includes(decision) && this.pauseUntil(event.chat, event.kind) > this.ports.now() ? "defer" : decision;
  }
  configureQuiet(chat: ConvKey, revision: number, quiet: QuietHours): NotificationSettings {
    const previous = this.settings(chat);
    if (previous.revision !== revision) throw new Error("Chính sách đã đổi; xem trước giờ yên lặng lại.");
    const next: NotificationSettings = { ...previous, version: 2, revision: previous.revision + 1, quiet: validateQuiet(quiet) };
    if (!Number.isSafeInteger(next.revision)) throw new Error("Mốc chính sách không hợp lệ.");
    this.store.setRequired(chat, { notificationSettings: next });
    this.quietCache.delete(chat);
    return next;
  }
  pauseUntil(chat: ConvKey, kind: NoticeKind): number {
    const settings = this.settings(chat);
    if ((!settings.enabled && kind !== "reminder") || !settings.quiet?.enabled || settings.quiet.urgent.includes(kind as "question" | "permission" | "blocked")) return 0;
    const now = this.ports.now();
    let cache = this.quietCache.get(chat);
    if (!cache || cache.revision !== settings.revision || now < cache.from || now >= cache.to) {
      const until = quietUntil(settings.quiet, now);
      cache = { revision: settings.revision, from: now, to: until ?? Math.floor(now / 60_000) * 60_000 + 60_000, until };
      this.quietCache.set(chat, cache);
      while (this.quietCache.size > 1000) this.quietCache.delete(this.quietCache.keys().next().value!);
    }
    return cache.until ?? 0;
  }
  rules(chat: ConvKey): string {
    const settings = this.settings(chat);
    return `<b>Quy tắc thông báo General</b>\nHiện tại: ${settings.enabled ? "đã bật" : "chưa bật; giữ cách nhận hiện tại"}.\n` +
      "• Câu hỏi/quyền/lỗi chặn việc: ưu tiên báo ngay.\n• Hoàn tất/vận hành/lỗi tên: có thể gộp. Lỗi tên không phải lỗi thực thi.\n" +
      "• Tiến độ thông thường: không thêm thông báo General.\n• Chỉ tên phiên, trạng thái và đường dẫn; không sao chép phản hồi/công cụ.\n" +
      "• Trả lời trực tiếp và thẻ câu hỏi gốc không bị hoãn.\n" +
      (settings.quiet?.enabled ? `• Giờ yên lặng: ${esc(settings.quiet.start)}–${esc(settings.quiet.end)} · ${esc(settings.quiet.timeZone)}; báo ngay: ${settings.quiet.urgent.map(kind => NOTICE_LABELS[kind]).join(", ") || "không loại nào"}.` : "• Giờ yên lặng chưa bật.") +
      "\nChỉ áp dụng cho thông báo/nhắc của luồng này; cảnh báo máy/PR, phản hồi và lịch chạy không đổi. Thay đổi cần xem trước/xác nhận.";
  }
  private valid(event: Notice): boolean {
    return Boolean(event && typeof event.chat === "string" && typeof event.conv === "string" && event.chat === chatOf(event.conv) && /^[a-f0-9]{16}$/.test(event.linkID) &&
      typeof event.sessionID === "string" && event.sessionID.length <= 128 && event.sessionID && typeof event.binding === "string" && event.binding.length > 0 && event.binding.length <= 8192 &&
      NOTICE_KINDS.includes(event.kind) && typeof event.title === "string" && event.title.length <= 256 && Number.isFinite(event.occurredAt) &&
      (!event.url || /^https:\/\/t\.me\/c\/\d+\/\d+(?:\/\d+)?$/.test(event.url)) && (!event.reference ||
        ["form", "permission", "input", "operation"].includes(event.reference.kind) && typeof event.reference.id === "string" && event.reference.id.length > 0 && event.reference.id.length <= 128) &&
      (event.occurrence === undefined || Number.isSafeInteger(event.occurrence) && event.occurrence >= 0));
  }
  private queue(chat: ConvKey): NotificationQueue {
    const data = this.store.peek(chat)?.notificationQueue;
    if (data === undefined) return { version: 1, items: {} };
    if (!data || data.version !== 1 || !data.items || typeof data.items !== "object" || Array.isArray(data.items) || Object.keys(data.items).length > 500 ||
      (data.blockedUntil !== undefined && !Number.isFinite(data.blockedUntil)) || Object.entries(data.items).some(([key, item]) => !item || key !== item.key ||
        !/^[a-f0-9]{64}$/.test(key) || !this.valid(item.event) || item.event.chat !== chat || !["pending", "sending", "sent", "unknown", "dropped", "failed"].includes(item.state) ||
        ![item.createdAt, item.dueAt, item.expiresAt, item.attempts].every(Number.isFinite) || (item.heldUntil !== undefined && !Number.isFinite(item.heldUntil)) ||
        (item.messageID !== undefined && (!Number.isSafeInteger(item.messageID) || item.messageID <= 0))) || (data.batchAfter !== undefined && !Number.isFinite(data.batchAfter))) throw new Error("Hàng đợi thông báo hỏng/chưa hỗ trợ; giữ dữ liệu, không phát lại.");
    return structuredClone(data);
  }
  private save(chat: ConvKey, data: NotificationQueue): void { this.store.setRequired(chat, { notificationQueue: data }); }
  enqueue(event: Notice): NoticeItem["state"] | "off" | "direct" | "dropped" {
    if (!this.valid(event)) throw new Error("Thông báo thiếu hoặc sai phạm vi/định danh.");
    const decision = this.decision(event);
    if (decision === "off" || decision === "direct") return decision;
    const now = this.ports.now();
    if (decision === "drop" || now - event.occurredAt > 7 * 86400_000 || event.occurredAt > now + 300_000) return "dropped";
    const data = this.queue(event.chat);
    const key = noticeKey(event);
    if (data.items[key]) return data.items[key].state;
    for (const [id, item] of Object.entries(data.items)) if (item.expiresAt <= now) delete data.items[id];
    if (Object.keys(data.items).length >= 500) throw new Error("Hàng đợi General đã đủ 500 mục; không xóa yêu cầu gốc hoặc gửi ngoài hàng đợi.");
    data.items[key] = { key, event: structuredClone(event), state: "pending", createdAt: now, dueAt: decision === "immediate" ? now : now + 5000,
      expiresAt: event.occurredAt + 7 * 86400_000, attempts: 0 };
    this.save(event.chat, data);
    return "pending";
  }
  status(chat: ConvKey): Record<NoticeItem["state"], number> {
    const counts = { pending: 0, sending: 0, sent: 0, unknown: 0, dropped: 0, failed: 0 };
    for (const item of Object.values(this.queue(chat).items)) counts[item.state]++;
    return counts;
  }
  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => void this.flush().catch(() => {}), 1000);
    this.timer.unref?.();
    void this.flush().catch(() => {});
  }
  stop(): void { this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  retryKnown(chat: ConvKey, key: string): void {
    const data = this.queue(chat);
    const item = data.items[key];
    if (!item || item.state !== "unknown" || !item.messageID || !this.ports.edit) throw new Error("Không biết mã tin để chỉnh sửa an toàn; không gửi mới mù quáng.");
    for (const candidate of Object.values(data.items)) if (candidate.state === "unknown" && candidate.messageID === item.messageID) {
      candidate.state = "pending"; candidate.dueAt = this.ports.now();
    }
    this.save(chat, data);
  }
  repairKnown(chat: ConvKey): number {
    const data = this.queue(chat);
    let count = 0;
    if (!this.ports.edit) return count;
    for (const item of Object.values(data.items)) if (item.state === "unknown" && item.messageID) {
      item.state = "pending"; item.dueAt = this.ports.now(); count++;
    }
    if (count) this.save(chat, data);
    return count;
  }
  flush(): Promise<void> {
    if (this.draining) return this.draining;
    this.draining = this.drain().finally(() => { this.draining = undefined; });
    return this.draining;
  }
  private async bounded<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Hết thời gian giao tin; kết quả chưa xác nhận.")), 10_000); })]); }
    finally { if (timer) clearTimeout(timer); }
  }
  private async drain(): Promise<void> {
    const chats = Object.keys(this.store.all()).filter(chat => chat === chatOf(chat) && this.store.peek(chat)?.notificationQueue);
    if (!this.recovered) {
      for (const chat of chats) {
        try {
        const data = this.queue(chat);
        let changed = false;
        for (const item of Object.values(data.items)) if (item.state === "sending") { item.state = "unknown"; item.error = "Tiến trình dừng khi đang giao; không tự gửi lại."; changed = true; }
        if (changed) this.save(chat, data);
        } catch { /* Một nhóm có dữ liệu hỏng không chặn nhóm khác. */ }
      }
      this.recovered = true;
    }
    const ordered = chats.slice(this.cursor).concat(chats.slice(0, this.cursor));
    this.cursor = chats.length ? (this.cursor + 1) % chats.length : 0;
    let index = 0;
    const work = async () => { while (index < ordered.length && !this.stopped) { const chat = ordered[index++]; try { await this.sendGroup(chat); } catch { /* Giữ ý định bền vững; nhóm khác vẫn được xét. */ } } };
    await Promise.all([work(), work()]);
  }
  private async sendGroup(chat: ConvKey): Promise<void> {
    let data = this.queue(chat);
    let changed = false;
    for (const item of Object.values(data.items)) {
      const receipt = this.receipts.get(item.key);
      if (receipt && item.state !== "sent") { item.state = "sent"; item.messageID = receipt; item.error = undefined; changed = true; }
      if (item.expiresAt <= this.ports.now() && item.state === "pending") { item.state = "dropped"; changed = true; }
    }
    if (changed) {
      this.save(chat, data);
      for (const item of Object.values(data.items)) if (item.state === "sent") this.receipts.delete(item.key);
    }
    if (!this.settings(chat).enabled || (data.blockedUntil ?? 0) > this.ports.now()) return;
    changed = false;
    for (const item of Object.values(data.items)) if (item.state === "pending") {
      const hold = Math.max(this.pauseUntil(chat, item.event.kind), this.ports.holdUntil?.(item.event) ?? 0);
      if (!Number.isFinite(hold)) throw new Error("Mốc tạm hoãn không hợp lệ; chưa gửi.");
      if (hold > this.ports.now()) {
        if (item.heldUntil !== hold) { item.heldUntil = hold; item.dueAt = Math.max(item.dueAt, hold); changed = true; }
      } else if (item.heldUntil !== undefined) { item.heldUntil = undefined; item.dueAt = this.ports.now(); changed = true; }
    }
    if (changed) this.save(chat, data);
    const candidates = Object.values(data.items).filter(item => item.state === "pending" && item.dueAt <= this.ports.now())
      .filter(item => this.decision(item.event) === "immediate" || (data.batchAfter ?? 0) <= this.ports.now())
      .sort((a, b) => Number(this.decision(b.event) === "immediate") - Number(this.decision(a.event) === "immediate") || a.createdAt - b.createdAt);
    const first = candidates[0];
    if (!first) return;
    const selected = Object.values(data.items).filter(item => item.state === "pending" && item.messageID === first.messageID &&
      (item.dueAt <= this.ports.now() || item.attempts === 0 && item.dueAt === item.createdAt + 5000 && this.decision(item.event) === "batch"))
      .sort((a, b) => Number(this.decision(b.event) === "immediate") - Number(this.decision(a.event) === "immediate") || a.createdAt - b.createdAt).slice(0, 8);
    const ready: Notice[] = [];
    const readyKeys = new Set<string>();
    try {
      for (const item of selected) {
        const event = await this.bounded(this.ports.resolve ? this.ports.resolve(item.event) : Promise.resolve(item.event));
        data = this.queue(chat);
        const current = data.items[item.key];
        if (!current || current.state !== "pending") continue;
        if (!event || !this.valid(event) || event.chat !== chat || event.binding !== item.event.binding || event.sessionID !== item.event.sessionID || event.conv !== item.event.conv ||
          event.kind !== item.event.kind || JSON.stringify(event.reference) !== JSON.stringify(item.event.reference) || event.occurrence !== item.event.occurrence) current.state = "dropped";
        else {
          current.event = event;
          const hold = Math.max(this.pauseUntil(chat, event.kind), this.ports.holdUntil?.(event) ?? 0);
          if (hold > this.ports.now()) { current.dueAt = hold; current.heldUntil = hold; }
          else { ready.push(event); readyKeys.add(item.key); }
        }
        this.save(chat, data);
      }
    } catch (error) {
      data = this.queue(chat);
      for (const item of selected) if (data.items[item.key]?.state === "pending") {
        data.items[item.key].dueAt = this.ports.now() + 5000;
        data.items[item.key].error = String((error as Error).message).slice(0, 300);
      }
      this.save(chat, data); return;
    }
    data = this.queue(chat);
    const active = selected.map(item => data.items[item.key]).filter(item => item?.state === "pending" && readyKeys.has(item.key));
    if (!active.length || !ready.length || this.stopped || !this.settings(chat).enabled) return;
    for (const item of active) {
      const hold = Math.max(this.pauseUntil(chat, item.event.kind), this.ports.holdUntil?.(item.event) ?? 0);
      if (hold > this.ports.now()) { item.dueAt = hold; item.heldUntil = hold; readyKeys.delete(item.key); }
    }
    if (active.some(item => !readyKeys.has(item.key))) { this.save(chat, data); return; }
    for (const item of active) { item.state = "sending"; item.attempts++; }
    this.save(chat, data);
    const links = ready.filter(event => event.url).map(event => ({ text: [...event.title].slice(0, 32).join(""), url: event.url! }));
    let messageID: number | undefined;
    try {
      if (first.messageID && this.ports.edit) {
        try { await this.bounded(this.ports.edit(chat, first.messageID, noticeText(ready), links)); }
        catch (error) { if ((error as { code?: number }).code !== 400 || !/message is not modified/i.test((error as Error).message)) throw error; }
        messageID = first.messageID;
      } else {
        const receipt = await this.bounded(this.ports.deliver(chat, noticeText(ready), links));
        if (!Number.isSafeInteger(receipt) || receipt <= 0) throw new Error("Không có mã tin xác nhận giao thành công.");
        messageID = receipt;
      }
      if (!Number.isSafeInteger(messageID) || messageID! <= 0) throw new Error("Không có mã tin xác nhận giao thành công.");
      for (const item of active) this.receipts.set(item.key, messageID!);
      data = this.queue(chat);
      for (const item of active) Object.assign(data.items[item.key], { state: "sent", messageID, error: undefined });
      data.batchAfter = this.ports.now() + 5000;
      this.save(chat, data);
      for (const item of active) this.receipts.delete(item.key);
    } catch (error) {
      data = this.queue(chat);
      const fault = error as { code?: number; retryAfter?: number; message?: string };
      const limited = !messageID && fault.code === 429;
      const seconds = Number.isFinite(fault.retryAfter) ? Math.max(1, fault.retryAfter!) : 1;
      const retry = limited ? this.ports.now() + seconds * 1000 : undefined;
      if (retry) data.blockedUntil = Math.max(data.blockedUntil ?? 0, retry);
      for (const item of active) Object.assign(data.items[item.key], { state: limited ? "pending" : messageID ? "unknown" : fault.code && fault.code >= 400 && fault.code < 500 ? "failed" : "unknown",
        messageID: messageID ?? item.messageID, dueAt: retry ?? item.dueAt, error: String(fault.message ?? error).slice(0, 300) });
      this.save(chat, data);
    }
  }
}
