import { randomBytes } from "node:crypto";
import { chatOf, type ConvKey } from "./conv.js";
import type { StateManager } from "./state.js";

export interface ResumeConfirmation {
  token: string;
  boot: string;
  actor: number;
  chat: ConvKey;
  conv: ConvKey;
  sessionID: string;
  directory: string;
  binding: string;
  marker: string;
  goal: string;
  payload: string;
  inputID: string;
  expiresAt: number;
  createdAt: number;
  state: "ready" | "used" | "observed" | "not-started";
  usedAt?: number;
  boundAt?: number;
  failureTurn?: string;
}
export interface ResumeData { version: 1; records: Record<string, ResumeConfirmation> }
const record = (value: unknown): value is Record<string, any> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const string = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const time = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Chỉ sở hữu xác nhận dùng một lần; việc nhận/chạy công việc vẫn thuộc bộ điều phối hiện có. */
export class ResumeConfirmations {
  private boot = randomBytes(6).toString("hex");
  constructor(private store: StateManager, private now: () => number = () => Date.now()) {}
  private data(conv: ConvKey): ResumeData {
    const data = this.store.peek(conv)?.resumeConfirmations;
    if (data === undefined) return { version: 1, records: {} };
    if (!record(data) || data.version !== 1 || !record(data.records) || Object.keys(data.records).length > 20 ||
      Object.entries(data.records).some(([key, value]) => !record(value) || !/^[a-f0-9]{16}$/.test(key) || value.token !== key ||
        !string(value.boot, 32) || !Number.isSafeInteger(value.actor) || value.actor < 0 || !string(value.chat, 64) || value.conv !== conv || chatOf(conv) !== value.chat ||
        !string(value.sessionID, 128) || !string(value.directory, 4096) || !string(value.binding, 8192) || !string(value.marker, 128) ||
        !string(value.goal, 1200) || !string(value.payload, 3000) || !string(value.inputID, 128) || !time(value.createdAt) || !time(value.expiresAt) ||
        !["ready", "used", "observed", "not-started"].includes(value.state) || (value.usedAt !== undefined && !time(value.usedAt)) ||
        (value.boundAt !== undefined && !time(value.boundAt)) || (value.failureTurn !== undefined && !string(value.failureTurn, 128)))) {
      throw new Error("Dữ liệu xác nhận tiếp tục không hỗ trợ hoặc hỏng; giữ nguyên, không gửi yêu cầu.");
    }
    return structuredClone(data);
  }
  private bound(conv: ConvKey, sessionID: string): boolean {
    return this.store.peek(conv)?.sessionID === sessionID && this.store.findChatBySession(sessionID) === conv &&
      Object.values(this.store.all()).filter(state => state.sessionID === sessionID).length === 1;
  }
  prepare(input: Omit<ResumeConfirmation, "token" | "boot" | "createdAt" | "expiresAt" | "state" | "usedAt" | "boundAt">): ResumeConfirmation {
    if (!this.bound(input.conv, input.sessionID) || input.chat !== chatOf(input.conv) || !string(input.goal, 1200) || !string(input.payload, 3000) ||
      !Number.isSafeInteger(input.actor) || input.actor < 0 || !string(input.directory, 4096) || !string(input.binding, 8192) || !string(input.marker, 128) ||
      !string(input.inputID, 128) || (input.failureTurn !== undefined && !string(input.failureTurn, 128))) throw new Error("Không đủ dữ liệu hoặc quyền sở hữu để chuẩn bị tiếp tục.");
    const data = this.data(input.conv);
    const existing = input.failureTurn && Object.values(data.records).find(item => item.sessionID === input.sessionID && item.failureTurn === input.failureTurn);
    if (existing) return structuredClone(existing);
    while (Object.keys(data.records).length >= 20) delete data.records[Object.keys(data.records)[0]];
    const item: ResumeConfirmation = { ...input, token: randomBytes(8).toString("hex"), boot: this.boot,
      createdAt: this.now(), expiresAt: this.now() + 10 * 60_000, state: "ready" };
    data.records[item.token] = item;
    this.store.setRequired(input.conv, { resumeConfirmations: data });
    return structuredClone(item);
  }
  get(conv: ConvKey, token: string): ResumeConfirmation | undefined { return this.data(conv).records[token]; }
  consume(conv: ConvKey, token: string, actor: number, binding: string, marker: string): ResumeConfirmation {
    const data = this.data(conv);
    const item = data.records[token];
    if (!item || item.actor !== actor || item.state !== "ready" || item.boot !== this.boot || item.expiresAt < this.now() ||
      item.binding !== binding || item.marker !== marker || !this.bound(conv, item.sessionID)) throw new Error("Xác nhận đã dùng, hết hạn, thuộc người khác hoặc mốc đã đổi; chuẩn bị lại, không tự gửi lại.");
    const used = { ...item, state: "used" as const, usedAt: this.now() };
    data.records[token] = used;
    this.store.setRequired(conv, { resumeConfirmations: data });
    return used;
  }
  notStarted(conv: ConvKey, token: string): void {
    const data = this.data(conv);
    const item = data.records[token];
    if (item?.state !== "used") return;
    data.records[token] = { ...item, state: "not-started" };
    this.store.setRequired(conv, { resumeConfirmations: data });
  }
  bindInput(conv: ConvKey, token: string, inputID: string): void {
    const data = this.data(conv);
    const item = data.records[token];
    if (!item || item.state !== "used" || item.boot !== this.boot || item.boundAt !== undefined || !string(inputID, 128)) throw new Error("Xác nhận không còn ở bước gắn đầu vào; không gửi lại.");
    data.records[token] = { ...item, inputID, boundAt: this.now() };
    this.store.setRequired(conv, { resumeConfirmations: data });
  }
  cancelReady(conv: ConvKey, token: string, actor: number): void {
    const data = this.data(conv);
    const item = data.records[token];
    if (!item || item.actor !== actor || item.state !== "ready" || !this.bound(conv, item.sessionID)) throw new Error("Không có xác nhận chưa dùng thuộc bạn; thao tác này không dừng việc đã gửi.");
    data.records[token] = { ...item, state: "not-started" };
    this.store.setRequired(conv, { resumeConfirmations: data });
  }
  observe(conv: ConvKey, inputIDs: readonly string[]): void {
    const data = this.data(conv);
    let changed = false;
    for (const item of Object.values(data.records)) if (item.state === "used" && item.boundAt !== undefined && this.bound(conv, item.sessionID) && inputIDs.includes(item.inputID)) {
      item.state = "observed";
      changed = true;
    }
    if (changed) this.store.setRequired(conv, { resumeConfirmations: data });
  }
  unobserved(conv: ConvKey): ResumeConfirmation[] {
    return Object.values(this.data(conv).records).filter(item => item.state === "used" && item.boundAt !== undefined && this.bound(conv, item.sessionID));
  }
}
