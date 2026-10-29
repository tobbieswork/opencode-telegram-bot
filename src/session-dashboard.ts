import { chatOf, type ConvKey } from "./conv.js";
import type { StateManager, PendingPrompt } from "./state.js";
import type { SessionTopic, SessionTopics, TopicSessionInfo } from "./session-topics.js";

export type DashboardWork = "unknown" | "idle" | "running" | "done" | "failed" | "stopped";
export interface DashboardObservation {
  info: TopicSessionInfo;
  work: DashboardWork;
  forms?: readonly string[];
  permissions?: readonly string[];
  reason?: string;
}
export interface PendingAction {
  id: string;
  kind: "form" | "permission";
  verified: boolean;
  checkedAt?: number;
  firstShownAt?: number;
  messageId?: number;
}
export interface DashboardRow {
  id: string;
  chat: ConvKey;
  conv?: ConvKey;
  sessionID?: string;
  title: string;
  directory: string;
  lifecycle: SessionTopic["phase"];
  work: DashboardWork;
  lastKnownWork?: DashboardWork;
  checkedAt?: number;
  lastActivityAt: number;
  stale: boolean;
  pendingVerified: boolean;
  pending: PendingAction[];
  reason?: string;
  titleError?: string;
}
interface Snapshot {
  attemptedAt: number;
  workAt?: number;
  work?: DashboardWork;
  forms?: readonly string[];
  formsAt?: number;
  formsUnknown?: boolean;
  permissions?: readonly string[];
  permissionsAt?: number;
  permissionsUnknown?: boolean;
  error?: string;
  reason?: string;
}
export interface DashboardDeps {
  store: StateManager;
  topics: SessionTopics;
  observe(sessionID: string, signal: AbortSignal): Promise<DashboardObservation>;
  now?: () => number;
  ttlMs?: number;
  concurrency?: number;
  timeoutMs?: number;
}

/** Chỉ chiếu dữ liệu; không sở hữu vòng đời, lời nhắc hoặc quyền nhận công việc. */
export class SessionDashboard {
  private cache = new Map<string, Snapshot>();
  private inflight = new Map<string, Promise<void>>();
  private active = 0;
  private waiters: Array<() => void> = [];
  constructor(private deps: DashboardDeps) {}

  private now(): number { return this.deps.now?.() ?? Date.now(); }
  private get ttl(): number { return Math.max(1, this.deps.ttlMs ?? 30_000); }
  private key(link: SessionTopic): string {
    return `${link.chat}:${link.id}:${link.conv}:${link.sessionID}:${link.identity?.source}:${link.identity?.projectID}:${link.identity?.createdAt}`;
  }
  private binding(link: SessionTopic): boolean {
    return Boolean(link.conv && link.sessionID && link.identity && this.deps.store.peek(link.conv)?.sessionID === link.sessionID &&
      this.deps.store.findChatBySession(link.sessionID) === link.conv &&
      Object.values(this.deps.store.all()).filter(state => state.sessionID === link.sessionID).length === 1);
  }

  async read(chat: ConvKey, options: { refresh?: boolean; force?: boolean; ids?: readonly string[] } = {}): Promise<DashboardRow[]> {
    if (chat !== chatOf(chat) || !this.deps.topics.enabled(chat)) throw new Error("Mở bảng điều khiển trong General của nhóm được quản lý.");
    const links = this.deps.topics.list(chat);
    if (options.refresh) await Promise.all(links.filter(link => !options.ids || options.ids.includes(link.id))
      .filter(link => link.phase === "open" && link.configured && this.binding(link))
      .map(link => this.refresh(link, Boolean(options.force))));
    // Đọc lại liên kết sau các bước chờ; không trả về thẻ của liên kết đã chuyển/biến mất.
    return this.deps.topics.list(chat).map(link => this.row(link));
  }

  private refresh(link: SessionTopic, force: boolean): Promise<void> {
    const key = this.key(link);
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const prior = this.cache.get(key);
    if (!force && prior && this.now() - prior.attemptedAt < this.ttl) return Promise.resolve();
    const task = this.load(link, key).finally(() => { this.inflight.delete(key); });
    this.inflight.set(key, task);
    return task;
  }

  private async load(link: SessionTopic, key: string): Promise<void> {
    const limit = Math.max(1, Math.min(4, this.deps.concurrency ?? 2));
    if (this.active >= limit) await new Promise<void>(resolve => this.waiters.push(resolve));
    else this.active++;
    const prior = this.cache.get(key);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const current = this.deps.topics.get(link.id);
      if (!current || this.key(current) !== key || current.phase !== "open" || !this.binding(current)) return;
      const observation = await Promise.race([
        this.deps.observe(link.sessionID!, controller.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new Error("Hết thời gian đọc trạng thái phiên.")); }, this.deps.timeoutMs ?? 8000);
        }),
      ]);
      const latest = this.deps.topics.get(link.id);
      if (!latest || this.key(latest) !== key || !this.binding(latest) || observation.info.id !== link.sessionID ||
        observation.info.projectID !== link.identity?.projectID || observation.info.source !== link.identity.source ||
        observation.info.createdAt !== link.identity.createdAt) throw new Error("Danh tính phiên hoặc liên kết đã thay đổi.");
      const now = this.now();
      this.put(key, { attemptedAt: now, workAt: now,
        work: observation.info.archived ? "unknown" : observation.work,
        forms: observation.forms ?? prior?.forms, formsAt: observation.forms !== undefined ? now : prior?.formsAt,
        formsUnknown: observation.forms === undefined,
        permissions: observation.permissions ?? prior?.permissions,
        permissionsAt: observation.permissions !== undefined ? now : prior?.permissionsAt,
        permissionsUnknown: observation.permissions === undefined,
        reason: observation.info.archived ? "OpenCode đã lưu trữ phiên; cần đối chiếu vòng đời." : observation.reason });
    } catch (error) {
      this.put(key, { ...prior, attemptedAt: this.now(), error: (error as Error).message,
        formsUnknown: true, permissionsUnknown: true });
    } finally {
      if (timer) clearTimeout(timer);
      const next = this.waiters.shift();
      if (next) next(); else this.active--;
    }
  }

  private put(key: string, value: Snapshot): void {
    this.cache.delete(key);
    this.cache.set(key, value);
    while (this.cache.size > 1000) this.cache.delete(this.cache.keys().next().value!);
  }

  private row(link: SessionTopic): DashboardRow {
    const valid = this.binding(link);
    const state = valid ? this.deps.store.peek(link.conv!) : undefined;
    const snap = valid ? this.cache.get(this.key(link)) : undefined;
    const fresh = (at?: number) => at !== undefined && this.now() - at <= this.ttl;
    const workVerified = link.phase === "open" && !snap?.error && fresh(snap?.workAt);
    const pending: PendingAction[] = [];
    let pendingVerified = Boolean(snap && !snap.error);
    for (const kind of ["form", "permission"] as const) {
      const at = kind === "form" ? snap?.formsAt : snap?.permissionsAt;
      const known = kind === "form" ? snap?.forms : snap?.permissions;
      const unknown = kind === "form" ? snap?.formsUnknown : snap?.permissionsUnknown;
      const verified = Boolean(valid && snap && !snap.error && !unknown && fresh(at));
      pendingVerified &&= verified;
      const local = Object.entries(state?.pendingPrompts ?? {}).filter(([, prompt]) => prompt.kind === kind);
      const newerLocal = local.filter(([, prompt]) => at === undefined || prompt.firstShownAt > at).map(([id]) => id);
      const ids = verified ? known ?? [] : [...new Set([...(known ?? []), ...newerLocal])];
      for (const id of ids) {
        const prompt: PendingPrompt | undefined = local.find(([key]) => key === id)?.[1];
        pending.push({ id, kind, verified, checkedAt: at, firstShownAt: prompt?.firstShownAt, messageId: prompt?.messageId });
      }
    }
    const work = workVerified ? snap?.work ?? "unknown" : "unknown";
    return { id: link.id, chat: link.chat, conv: link.conv, sessionID: link.sessionID,
      title: link.title, directory: link.directory, lifecycle: link.phase, work,
      lastKnownWork: snap?.work, checkedAt: snap?.workAt,
      lastActivityAt: state?.worker?.updatedAt ?? link.identity?.createdAt ?? 0,
      stale: work === "unknown" || !pendingVerified, pendingVerified, pending,
      reason: !valid ? "Liên kết phiên chưa đầy đủ hoặc xung đột." : snap?.error ?? snap?.reason ??
        (!workVerified ? "Chưa xác minh trạng thái thực thi." : !pendingVerified ? "Chưa xác minh đủ câu hỏi và quyền." : undefined),
      titleError: link.titleSync?.error };
  }
}
