import { randomBytes } from "node:crypto";
import type { ConvKey } from "./conv.js";
import type { StateManager } from "./state.js";
import { stripTags } from "./format.js";

export type ActivitySource = "topic" | "manager" | "schedule" | "opencode" | "report";
export const ACTIVITY_SOURCE_LABELS: Record<ActivitySource, string> = {
  topic: "Chủ đề làm việc", manager: "Phiên quản lý", schedule: "Lượt chạy lịch", opencode: "Quan sát từ OpenCode", report: "Báo cáo tự động",
};
export interface SessionActivity {
  version: 1;
  sessionID: string;
  revision: string;
  input: { id: string; source: ActivitySource; snippet: string; receivedAt: number; observed: boolean; createdAt?: number };
  result?: { inputID: string; messageID: string; snippet: string; observedAt: number; createdAt?: number; outcome?: string };
  uncertainty?: string;
}
export interface ActivityMessage {
  id: string;
  type: string;
  text?: string;
  content?: readonly { type?: string; text?: string }[];
  time?: { created?: number };
  outcome?: string;
}

const sources: readonly string[] = ["topic", "manager", "schedule", "opencode", "report"];
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max;
const time = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const object = (value: unknown): value is Record<string, any> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const outcome = (value?: string) => value && ["succeeded", "failed", "interrupted"].includes(value) ? value : undefined;
function excerpt(value: string, max: number): string {
  const plain = stripTags(value).replace(/\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g, "[đã ẩn]")
    .replace(/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{30,}|gh[pousr]_[A-Za-z0-9]{30,})\b/g, "[đã ẩn]")
    .replace(/\b(authorization\s*:\s*(?:Bearer|Basic)\s+)\S+/gi, "$1[đã ẩn]")
    .replace(/\b((?:api[_-]?key|access[_-]?token|bot[_-]?token|password|authorization)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi, "$1[đã ẩn]")
    .replace(/\s+/g, " ").trim();
  let result = "";
  for (const char of plain) { if (result.length + char.length > max) break; result += char; }
  return result;
}
function messageText(message: ActivityMessage): string {
  return message.text ?? (message.content ?? []).filter(part => part.type === "text" && typeof part.text === "string").map(part => part.text).join("\n");
}

/** Bản ghi tối thiểu của đúng phiên; không sở hữu nhận công việc hoặc giao tin. */
export class SessionActivityLog {
  constructor(private store: StateManager, private now: () => number = Date.now) {}
  private bound(conv: ConvKey, sessionID: string): boolean {
    return this.store.peek(conv)?.sessionID === sessionID && this.store.findChatBySession(sessionID) === conv &&
      Object.values(this.store.all()).filter(state => state.sessionID === sessionID).length === 1;
  }
  read(conv: ConvKey): SessionActivity | undefined {
    const state = this.store.peek(conv);
    const data = state?.sessionActivity;
    if (data === undefined || !state?.sessionID || !this.bound(conv, state.sessionID)) return undefined;
    if (!object(data) || data.version !== 1 || !text(data.sessionID, 128) || !text(data.revision, 64) || !data.revision ||
      !object(data.input) || !text(data.input.id, 128) || !data.input.id || !sources.includes(data.input.source) ||
      !text(data.input.snippet, 1200) || !time(data.input.receivedAt) || typeof data.input.observed !== "boolean" ||
      (data.input.createdAt !== undefined && !time(data.input.createdAt)) ||
      (data.result !== undefined && (!object(data.result) || data.result.inputID !== data.input.id ||
        !text(data.result.messageID, 128) || !data.result.messageID || !text(data.result.snippet, 1800) || !time(data.result.observedAt) ||
        (data.result.createdAt !== undefined && !time(data.result.createdAt)) ||
        (data.result.outcome !== undefined && !outcome(data.result.outcome)))) ||
      (data.uncertainty !== undefined && !text(data.uncertainty, 240))) {
      throw new Error("Dữ liệu hoạt động phiên không hỗ trợ hoặc không hợp lệ; giữ nguyên để kiểm tra.");
    }
    return data.sessionID === state.sessionID ? structuredClone(data) : undefined;
  }
  private write(conv: ConvKey, data: SessionActivity): void {
    this.store.setRequired(conv, { sessionActivity: { ...data, revision: randomBytes(8).toString("hex") } });
  }
  begin(conv: ConvKey, input: { sessionID: string; inputID: string; text: string; source: ActivitySource }): boolean {
    if (!this.bound(conv, input.sessionID)) return false;
    const prior = this.read(conv);
    if (!text(input.inputID, 128) || !input.inputID || !sources.includes(input.source)) throw new Error("Mã hoặc nguồn đầu vào không hợp lệ.");
    if (prior?.input.id === input.inputID) return false;
    this.write(conv, { version: 1, sessionID: input.sessionID, revision: "", input: { id: input.inputID,
      source: input.source, snippet: excerpt(input.text, 1200), receivedAt: this.now(), observed: false } });
    return true;
  }
  complete(conv: ConvKey, input: { sessionID: string; inputID: string; messageID: string; text: string; outcome?: string; createdAt?: number }): boolean {
    const prior = this.read(conv);
    if (!prior || prior.sessionID !== input.sessionID || prior.input.id !== input.inputID || !text(input.messageID, 128) || !input.messageID) return false;
    const snippet = excerpt(input.text, 1800);
    const status = outcome(input.outcome);
    if (prior.result?.messageID === input.messageID && prior.result.snippet === snippet && prior.result.outcome === status) return false;
    this.write(conv, { ...prior, input: { ...prior.input, observed: true }, uncertainty: undefined,
      result: { inputID: input.inputID, messageID: input.messageID, snippet, observedAt: this.now(), outcome: status,
        ...(time(input.createdAt) ? { createdAt: input.createdAt } : {}) } });
    return true;
  }
  uncertain(conv: ConvKey, sessionID: string, inputID: string, reason: string): boolean {
    const prior = this.read(conv);
    if (!prior || prior.sessionID !== sessionID || prior.input.id !== inputID || prior.uncertainty === reason) return false;
    this.write(conv, { ...prior, uncertainty: excerpt(reason, 240) });
    return true;
  }
  /** Đầu vào phải là trang mới nhất, thứ tự giảm dần do máy chủ trả về; không suy từ sự kiện kết thúc không có mã lượt. */
  observe(conv: ConvKey, sessionID: string, expectedRevision: string | undefined, messages: readonly ActivityMessage[]): boolean {
    if (!this.bound(conv, sessionID)) return false;
    const prior = this.read(conv);
    if (prior?.revision !== expectedRevision) return false;
    const index = messages.findIndex(message => message.type === "user" && text(message.id, 128) && Boolean(message.id));
    if (index < 0) return false;
    const user = messages[index];
    if (prior && prior.input.id !== user.id && time(prior.input.createdAt) && time(user.time?.created) &&
      user.time.created <= prior.input.createdAt && !messages.some(message => message.id === prior.input.id)) {
      return this.uncertain(conv, sessionID, prior.input.id, "Nguồn đọc có mốc cũ hoặc chưa đủ để thay đầu vào hiện tại.");
    }
    if (prior && prior.input.id !== user.id && !prior.input.observed && !messages.some(message => message.id === prior.input.id)) {
      return this.uncertain(conv, sessionID, prior.input.id, "Chưa đối chiếu được đầu vào mới nhận với dữ liệu OpenCode.");
    }
    const same = prior?.input.id === user.id;
    const next: SessionActivity = { version: 1, sessionID, revision: prior?.revision ?? "", input: {
      ...(same ? prior.input : { id: user.id, source: "opencode" as const, snippet: excerpt(messageText(user), 1200), receivedAt: this.now() }),
      observed: true, ...(time(user.time?.created) ? { createdAt: user.time.created } : {}),
    }, ...(same && prior.result ? { result: prior.result } : {}) };
    const reply = messages.slice(0, index).find(message => message.type === "assistant" && text(message.id, 128) && message.id && messageText(message));
    if (reply) {
      const snippet = excerpt(messageText(reply), 1800);
      const status = outcome(messages.slice(0, index).find(message => message.type === "idle")?.outcome) ??
        (same && prior.result?.messageID === reply.id ? prior.result.outcome : undefined);
      next.result = same && prior.result?.messageID === reply.id && prior.result.snippet === snippet && prior.result.outcome === status ? prior.result :
        { inputID: user.id, messageID: reply.id, snippet, observedAt: this.now(), outcome: status,
          ...(time(reply.time?.created) ? { createdAt: reply.time.created } : {}) };
    }
    if (JSON.stringify(next) === JSON.stringify(prior)) return false;
    this.write(conv, next);
    return true;
  }
}
