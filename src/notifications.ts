import { createHash, randomBytes } from "node:crypto";
import { chatOf, type ConvKey } from "./conv.js";
import { esc } from "./format.js";
import type { StateManager } from "./state.js";

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
export interface NotificationSettings { version: 1; enabled: boolean; revision: number }
export interface NotificationPorts {
  now(): number;
  deliver(chat: ConvKey, text: string, links: Array<{ text: string; url: string }>): Promise<number>;
}
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
  constructor(protected store: StateManager, protected ports: NotificationPorts) {}
  settings(chat: ConvKey): NotificationSettings {
    if (chat !== chatOf(chat)) throw new Error("Thiết lập thông báo chỉ thuộc General.");
    const value = this.store.peek(chat)?.notificationSettings;
    if (value === undefined) return { version: 1, enabled: false, revision: 0 };
    if (!value || typeof value !== "object" || value.version !== 1 || typeof value.enabled !== "boolean" || !Number.isSafeInteger(value.revision) || value.revision < 0) throw new Error("Thiết lập thông báo chưa hỗ trợ; giữ dữ liệu và không tự bật.");
    return structuredClone(value);
  }
  configure(chat: ConvKey, revision: number, enabled: boolean): NotificationSettings {
    const previous = this.settings(chat);
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
    return noticeDecision(this.settings(event.chat), event);
  }
  rules(chat: ConvKey): string {
    const settings = this.settings(chat);
    return `<b>Quy tắc thông báo General</b>\nHiện tại: ${settings.enabled ? "đã bật" : "chưa bật; giữ cách nhận hiện tại"}.\n` +
      "• Câu hỏi/quyền/lỗi chặn việc: ưu tiên báo ngay.\n• Hoàn tất/vận hành/lỗi tên: có thể gộp. Lỗi tên không phải lỗi thực thi.\n" +
      "• Tiến độ thông thường: không thêm thông báo General.\n• Chỉ tên phiên, trạng thái và đường dẫn; không sao chép phản hồi/công cụ.\n" +
      "• Trả lời trực tiếp và thẻ câu hỏi gốc không bị hoãn.\n• Giờ yên lặng chưa được tự bật. Thay đổi cần xem trước và xác nhận.";
  }
}
