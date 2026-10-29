import { randomBytes, createHash } from "node:crypto";
import { chatOf, convKey, parseConv, type ConvKey } from "./conv.js";
import { StateManager, type ChatState } from "./state.js";
import { topicTitle } from "./format.js";
import { warn } from "./logger.js";

class TopicOwnershipError extends Error {}

export interface TopicSessionInfo {
  id: string;
  title?: string;
  directory: string;
  projectID: string;
  createdAt: number;
  source: string;
  archived: boolean;
}

export interface TopicSession extends TopicSessionInfo {
  busy: boolean;
  terminal: boolean;
}

export interface TopicTitlePolicy {
  mode: "follow" | "keep" | "custom";
  revision: number;
  customName?: string;
}
export const TITLE_POLICY_LABELS: Record<TopicTitlePolicy["mode"], string> = { follow: "Theo OpenCode", keep: "Giữ tên hiện tại", custom: "Tên riêng" };
export interface TitlePolicies {
  version: 1;
  groups: Record<string, { enabled: boolean; revision: number }>;
}

export interface SessionTopic {
  id: string;
  operationID: string;
  chat: ConvKey;
  directory: string;
  title: string;
  sessionID?: string;
  conv?: ConvKey;
  identity?: Pick<TopicSession, "projectID" | "createdAt" | "source">;
  phase: "creating" | "open" | "closing" | "closed" | "restoring" | "missing" | "attention";
  step?: string;
  configured: boolean;
  error?: string;
  titleSync?: { pending: boolean; error?: string; retryAt?: number; attempts?: number; desiredName?: string; desiredStamp?: string };
  titlePolicy?: TopicTitlePolicy;
}

export interface SessionTopicsData {
  version: 1;
  groups: Record<string, true>;
  links: Record<string, SessionTopic>;
  titleSyncGroups?: Record<string, true>;
  titleRetryAt?: Record<string, number>;
  titlePolicies?: TitlePolicies;
}

export interface TopicTitlePreview { id: string; before: string; after?: string; error?: string; reason?: string; deferred: boolean }
export interface TopicTitleResult { id: string; status: "synced" | "unchanged" | "waiting" | "disabled" | "failed" }

export interface NewSessionTopic {
  chat: ConvKey;
  directory: string;
  title: string;
  operationID?: string;
  agent?: string;
  metadata?: Record<string, string | number | boolean>;
  state?: ChatState;
}

export interface SessionTopicPorts {
  createSession(input: NewSessionTopic & { linkID: string }): Promise<string>;
  session(id: string): Promise<TopicSession>;
  createTopic(chat: ConvKey, title: string): Promise<number>;
  archive(id: string, archived: boolean): Promise<void>;
  closeTopic(conv: ConvKey): Promise<void>;
  openTopic(conv: ConvKey): Promise<void>;
  stop(link: SessionTopic): Promise<boolean>;
  configure?(id: string, state: ChatState): Promise<void>;
  sessionTitle?(id: string): Promise<TopicSessionInfo>;
  renameTopic?(conv: ConvKey, title: string): Promise<void>;
  now?(): number;
}

/** Sole owner of managed session/topic bindings, persisted with conversation state. */
export class SessionTopics {
  private creating = new Map<string, Promise<SessionTopic>>();
  private attaching = new Map<string, Promise<SessionTopic>>();
  private operations = new Map<string, Promise<unknown>>();
  private provisioning = new Set<string>();
  private titleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private titleForces = new Set<string>();
  private titleQueues = new Map<ConvKey, Promise<unknown>>();
  private titleJobs = new Map<string, Promise<TopicTitleResult>>();
  private titleAgain = new Set<string>();
  private titleWriteAfter = new Map<ConvKey, number>();
  private titleStopped = false;
  constructor(private readonly store: StateManager, private readonly ports: SessionTopicPorts) {}

  private data(): SessionTopicsData {
    const data = this.store.sessionTopics();
    if (data === undefined) return { version: 1, groups: {}, links: {} };
    const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
    if (!record(data) || data.version !== 1 || !record(data.groups) || !record(data.links)) throw new Error("Unsupported or invalid session/topic state; preserve it for recovery.");
    if (data.titleSyncGroups !== undefined && (!record(data.titleSyncGroups) ||
      Object.entries(data.titleSyncGroups).some(([chat, value]) => data.groups[chat] !== true || value !== true))) {
      throw new Error("Dữ liệu chính sách đồng bộ tên không hợp lệ; giữ nguyên để kiểm tra.");
    }
    if (data.titleRetryAt !== undefined && (!record(data.titleRetryAt) || Object.entries(data.titleRetryAt).some(([chat, value]) =>
      data.groups[chat] !== true || typeof value !== "number" || !Number.isFinite(value) || value < 0))) {
      throw new Error("Dữ liệu chờ đồng bộ tên không hợp lệ; giữ nguyên để kiểm tra.");
    }
    if (data.titlePolicies !== undefined && (!record(data.titlePolicies) || data.titlePolicies.version !== 1 || !record(data.titlePolicies.groups) ||
      Object.entries(data.titlePolicies.groups).some(([chat, value]) => data.groups[chat] !== true || !record(value) ||
        typeof value.enabled !== "boolean" || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0))) {
      throw new Error("Dữ liệu chính sách tên không hỗ trợ hoặc không hợp lệ; giữ nguyên để kiểm tra.");
    }
    const phases = ["creating", "open", "closing", "closed", "restoring", "missing", "attention"];
    const sessions = new Set<string>();
    const topics = new Set<string>();
    for (const [id, link] of Object.entries(data.links)) {
      if (!record(link) || link.id !== id || !/^[a-f0-9]{16}$/.test(id) || typeof link.chat !== "string" ||
        data.groups[link.chat] !== true || !phases.includes(link.phase) || typeof link.operationID !== "string" ||
        typeof link.directory !== "string" || typeof link.title !== "string") throw new Error("Unsupported or invalid session/topic link.");
      if (link.sessionID) {
        if (typeof link.sessionID !== "string" || sessions.has(link.sessionID)) throw new Error("Invalid duplicate session ownership.");
        sessions.add(link.sessionID);
      }
      if (link.conv) {
        if (typeof link.conv !== "string" || chatOf(link.conv) !== link.chat || (parseConv(link.conv).threadId ?? 0) <= 1 || topics.has(link.conv)) throw new Error("Invalid duplicate topic ownership.");
        topics.add(link.conv);
      }
      if (link.identity && (!link.identity.projectID || !link.identity.source || !Number.isFinite(link.identity.createdAt))) throw new Error("Invalid session identity.");
      if (link.titleSync !== undefined && (!record(link.titleSync) || typeof link.titleSync.pending !== "boolean" ||
        (link.titleSync.error !== undefined && typeof link.titleSync.error !== "string") ||
        (link.titleSync.retryAt !== undefined && (!Number.isFinite(link.titleSync.retryAt) || link.titleSync.retryAt < 0)) ||
        (link.titleSync.attempts !== undefined && (!Number.isSafeInteger(link.titleSync.attempts) || link.titleSync.attempts < 0)) ||
        (link.titleSync.desiredName !== undefined && (typeof link.titleSync.desiredName !== "string" || !link.titleSync.desiredName || topicTitle(link.titleSync.desiredName) !== link.titleSync.desiredName)) ||
        (link.titleSync.desiredStamp !== undefined && (typeof link.titleSync.desiredStamp !== "string" || !link.titleSync.desiredStamp || link.titleSync.desiredStamp.length > 128)) ||
        ((link.titleSync.desiredName === undefined) !== (link.titleSync.desiredStamp === undefined)))) {
        throw new Error("Dữ liệu đồng bộ tên không hợp lệ; giữ nguyên để kiểm tra.");
      }
      if (link.titlePolicy !== undefined && (!data.titlePolicies || !record(link.titlePolicy) || !["follow", "keep", "custom"].includes(link.titlePolicy.mode as string) ||
        !Number.isSafeInteger(link.titlePolicy.revision) || (link.titlePolicy.revision as number) < 1 ||
        (link.titlePolicy.mode === "custom" ? typeof link.titlePolicy.customName !== "string" || !link.titlePolicy.customName ||
          topicTitle(link.titlePolicy.customName) !== link.titlePolicy.customName : link.titlePolicy.customName !== undefined))) {
        throw new Error("Dữ liệu chính sách tên chủ đề không hợp lệ; giữ nguyên để kiểm tra.");
      }
      if (!["creating", "attention"].includes(link.phase) && (!link.sessionID || !link.conv || !link.identity)) throw new Error("Incomplete session/topic ownership.");
    }
    return data;
  }

  enable(chat: ConvKey): void {
    if (chatOf(chat) !== chat || !Number.isSafeInteger(Number(chat)) || Number(chat) >= 0) throw new Error("Use General in a forum supergroup.");
    const data = this.data();
    data.groups[chat] = true;
    this.store.commitSessionTopics(data);
  }

  enabled(conv: ConvKey): boolean { return this.data().groups[chatOf(conv)] === true; }

  list(chat?: ConvKey): SessionTopic[] {
    return Object.values(this.data().links).filter((link) => !chat || link.chat === chatOf(chat));
  }

  get(id: string): SessionTopic | undefined { return this.data().links[id]; }
  forTopic(conv: ConvKey): SessionTopic | undefined { return this.list().find((link) => link.conv === conv); }

  titleGroupPolicy(chat: ConvKey): { enabled: boolean; revision: number } {
    const data = this.data();
    return data.titlePolicies?.groups[chatOf(chat)] ?? { enabled: data.titlePolicies ? false : data.titleSyncGroups?.[chatOf(chat)] === true, revision: 0 };
  }

  titleSyncEnabled(chat: ConvKey): boolean { return this.titleGroupPolicy(chat).enabled; }

  titlePolicy(chat: ConvKey, id: string): TopicTitlePolicy {
    return this.require(chat, id).titlePolicy ?? { mode: "follow", revision: 0 };
  }

  followsOpenCode(chat: ConvKey, id: string): boolean { return this.titleSyncEnabled(chat) && this.titlePolicy(chat, id).mode === "follow"; }

  titlePolicyStamp(chat: ConvKey, id: string): string {
    const group = this.titleGroupPolicy(chat);
    const policy = this.titlePolicy(chat, id);
    return `${group.enabled}:${group.revision}:${policy.mode}:${policy.revision}`;
  }

  titleScopeStamp(chat: ConvKey, id?: string): string {
    const data = this.data();
    if (chat !== chatOf(chat) || !data.groups[chat]) throw new Error("Đọc chính sách tên từ đúng General.");
    const links = Object.values(data.links).filter(link => link.chat === chat && (!id || link.id === id)).sort((a, b) => a.id.localeCompare(b.id));
    if (id && !links.length) throw new Error("Chủ đề không thuộc nhóm này.");
    const group = data.titlePolicies?.groups[chat] ?? { enabled: data.titlePolicies ? false : data.titleSyncGroups?.[chat] === true, revision: 0 };
    return createHash("sha256").update(JSON.stringify([group.enabled, group.revision, links.map(link => [link.id,
      link.sessionID, link.conv, link.phase, link.identity?.source, link.identity?.projectID, link.identity?.createdAt,
      link.titlePolicy?.mode ?? "follow", link.titlePolicy?.revision ?? 0])])).digest("hex");
  }

  titleStatus(chat: ConvKey, id: string) {
    const link = this.require(chat, id);
    const group = this.titleGroupPolicy(chat);
    const policy = this.titlePolicy(chat, id);
    const retryAt = Math.max(link.titleSync?.retryAt ?? 0, this.data().titleRetryAt?.[chat] ?? 0, this.titleWriteAfter.get(chat) ?? 0);
    return { group, policy, confirmedName: link.title, error: link.titleSync?.error,
      pendingName: link.titleSync?.desiredStamp === this.titlePolicyStamp(chat, id) ? link.titleSync.desiredName : undefined,
      pending: group.enabled && policy.mode === "follow" && Boolean(link.titleSync?.pending || this.titleTimers.has(id) || this.titleJobs.has(id)),
      retryAt: retryAt > this.titleNow() ? retryAt : undefined };
  }

  private cancelTitleTimers(chat: ConvKey, id?: string): void {
    for (const link of this.list(chat)) {
      if (id && link.id !== id) continue;
      const timer = this.titleTimers.get(link.id);
      if (timer) clearTimeout(timer);
      this.titleTimers.delete(link.id);
      this.titleForces.delete(link.id);
      this.titleAgain.delete(link.id);
    }
  }

  private policyData(data: SessionTopicsData): TitlePolicies {
    data.titlePolicies ??= { version: 1, groups: Object.fromEntries(Object.keys(data.groups).map(chat =>
      [chat, { enabled: data.titleSyncGroups?.[chat] === true, revision: 0 }])) };
    // Bộ đọc cũ chỉ biết bản đồ này: tắt nó để quay về mã cũ không ghi đè ngoại lệ.
    data.titleSyncGroups = {};
    return data.titlePolicies;
  }

  setTitleGroupSync(chat: ConvKey, enabled: boolean): void {
    if (chat !== chatOf(chat) || !this.enabled(chat) || typeof enabled !== "boolean") throw new Error("Đổi chính sách tên từ General của nhóm được quản lý.");
    const data = this.data();
    const existing = data.titlePolicies?.groups[chat];
    if (existing?.enabled === enabled && !Object.keys(data.titleSyncGroups ?? {}).length) {
      if (!enabled) this.cancelTitleTimers(chat);
      return;
    }
    const policies = this.policyData(data);
    const before = policies.groups[chat] ?? { enabled: false, revision: 0 };
    if (before.enabled !== enabled && before.revision === Number.MAX_SAFE_INTEGER) throw new Error("Mốc chính sách tên đã hết phạm vi; giữ nguyên để kiểm tra.");
    policies.groups[chat] = { enabled, revision: before.revision + Number(before.enabled !== enabled) };
    if (!enabled) for (const link of Object.values(data.links)) if (link.chat === chat && link.titleSync) link.titleSync = { ...link.titleSync, pending: false };
    this.store.commitSessionTopics(data);
    if (!enabled) this.cancelTitleTimers(chat);
  }

  setTitlePolicy(chat: ConvKey, id: string, input: { mode: TopicTitlePolicy["mode"]; customName?: string }): TopicTitlePolicy {
    const link = this.require(chat, id);
    if (!["follow", "keep", "custom"].includes(input.mode)) throw new Error("Chế độ tên không hợp lệ.");
    const customName = input.mode === "custom" ? topicTitle(input.customName ?? "") : undefined;
    if (input.mode === "custom" && !customName) throw new Error("Tên riêng không được trống.");
    const current = link.titlePolicy ?? { mode: "follow" as const, revision: 0 };
    if (current.mode === input.mode && current.customName === customName) {
      const data = this.data();
      if (!data.titlePolicies || Object.keys(data.titleSyncGroups ?? {}).length) {
        this.policyData(data);
        this.store.commitSessionTopics(data);
      }
      if (input.mode !== "follow") this.cancelTitleTimers(chat, id);
      return current;
    }
    const revision = link.titlePolicy?.revision ?? 0;
    if (revision === Number.MAX_SAFE_INTEGER) throw new Error("Mốc chính sách tên đã hết phạm vi; giữ nguyên để kiểm tra.");
    const data = this.data();
    this.policyData(data);
    const policy: TopicTitlePolicy = { mode: input.mode, revision: revision + 1, ...(customName ? { customName } : {}) };
    data.links[id] = { ...data.links[id], titlePolicy: policy, titleSync: { pending: false } };
    this.store.commitSessionTopics(data);
    if (input.mode !== "follow") this.cancelTitleTimers(chat, id);
    return policy;
  }

  enableTitleSync(chat: ConvKey): void {
    this.setTitleGroupSync(chat, true);
  }

  private titleNow(): number { return this.ports.now?.() ?? Date.now(); }

  private async inspectTitle(link: SessionTopic): Promise<TopicSessionInfo> {
    if (!link.sessionID || !link.identity || !link.conv || this.store.peek(link.conv)?.sessionID !== link.sessionID ||
      this.owners(link.sessionID).length !== 1 || this.store.findChatBySession(link.sessionID) !== link.conv) {
      throw new Error("Liên kết phiên không đầy đủ hoặc xung đột.");
    }
    if (!this.ports.sessionTitle) throw new Error("Chưa cấu hình đọc tiêu đề phiên.");
    const session = await this.ports.sessionTitle(link.sessionID);
    if (session.id !== link.sessionID || session.projectID !== link.identity.projectID ||
      session.createdAt !== link.identity.createdAt || session.source !== link.identity.source) {
      throw new Error("Danh tính phiên thay đổi; không đổi tên chủ đề.");
    }
    return session;
  }

  async previewOpenCodeTitle(chat: ConvKey, id: string): Promise<TopicTitlePreview> {
    const link = this.require(chat, id);
    try {
      const session = await this.inspectTitle(link);
      return { id, before: link.title, after: topicTitle(session.title ?? "") || undefined,
        deferred: link.phase !== "open" || !link.configured || session.archived };
    } catch (error) { return { id, before: link.title, error: (error as Error).message, deferred: true }; }
  }

  async previewTitles(chat: ConvKey): Promise<TopicTitlePreview[]> {
    if (chat !== chatOf(chat) || !this.enabled(chat)) throw new Error("Xem trước tên trong General của nhóm được quản lý.");
    const links = this.list(chat);
    const rows: TopicTitlePreview[] = new Array(links.length);
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(2, links.length) }, async () => {
      while (cursor < links.length) {
        const index = cursor++;
        const link = links[index];
        if (link.titlePolicy && link.titlePolicy.mode !== "follow") {
          rows[index] = { id: link.id, before: link.title, after: link.title, deferred: true,
            reason: link.titlePolicy.mode === "custom" ? "Đang dùng tên riêng; không ghi đè theo OpenCode." : "Đang giữ tên hiện tại; không ghi đè theo OpenCode." };
          continue;
        }
        try { rows[index] = await this.previewOpenCodeTitle(chat, link.id); }
        catch (error) { rows[index] = { id: link.id, before: link.title, error: (error as Error).message, deferred: true }; }
      }
    }));
    return rows;
  }

  /** Hàng đợi đổi tên tách khỏi vòng đời: không làm canPrompt thành false. */
  syncTitle(chat: ConvKey, id: string, force = false): Promise<TopicTitleResult> {
    this.require(chat, id);
    if (this.titleStopped || !this.followsOpenCode(chat, id)) return Promise.resolve({ id, status: "disabled" });
    const existing = this.titleJobs.get(id);
    if (existing) {
      this.titleAgain.add(id);
      if (force) this.titleForces.add(id);
      return existing;
    }
    const previous = this.titleQueues.get(chat) ?? Promise.resolve();
    const stamp = this.titlePolicyStamp(chat, id);
    const task = previous.catch(() => {}).then(() => this.titlePolicyStamp(chat, id) === stamp ? this.applyTitle(chat, id, force) : { id, status: "disabled" as const });
    this.titleQueues.set(chat, task);
    const result = task.finally(() => {
      if (this.titleQueues.get(chat) === task) this.titleQueues.delete(chat);
      this.titleJobs.delete(id);
      if (this.titleAgain.delete(id)) this.scheduleTitle(id, false, 1000);
    });
    this.titleJobs.set(id, result);
    return result;
  }

  private async applyTitle(chat: ConvKey, id: string, force: boolean): Promise<TopicTitleResult> {
    let link = this.require(chat, id);
    if (this.titleStopped || !this.followsOpenCode(chat, id)) return { id, status: "disabled" };
    const policyStamp = this.titlePolicyStamp(chat, id);
    let desiredName: string | undefined;
    if (link.phase !== "open" || !link.configured || this.operations.has(id)) return { id, status: "waiting" };
    const now = this.titleNow();
    const retryAt = Math.max(link.titleSync?.retryAt ?? 0, this.titleWriteAfter.get(chat) ?? 0, this.data().titleRetryAt?.[chat] ?? 0);
    if (retryAt > now) {
      this.scheduleTitle(id, force, retryAt - now);
      return { id, status: "waiting" };
    }
    try {
      const session = await this.inspectTitle(link);
      const name = topicTitle(session.title ?? "");
      link = this.require(chat, id);
      if (this.titlePolicyStamp(chat, id) !== policyStamp || !this.followsOpenCode(chat, id)) return { id, status: "disabled" };
      if (session.archived || !name) {
        this.patch(id, { titleSync: { ...link.titleSync, pending: false, desiredName: undefined, desiredStamp: undefined } });
        return { id, status: "waiting" };
      }
      if (this.titleStopped || link.phase !== "open" || !link.configured || this.operations.has(id)) return { id, status: "waiting" };
      if (!this.canInteract(link.conv!, session.id) || link.sessionID !== session.id || link.identity?.projectID !== session.projectID ||
        link.identity.createdAt !== session.createdAt || link.identity.source !== session.source) {
        throw new Error("Liên kết phiên đã thay đổi trong lúc đọc tiêu đề; không đổi tên chủ đề.");
      }
      if (!force && name === link.title && !link.titleSync?.pending) return { id, status: "unchanged" };
      if (!this.ports.renameTopic) throw new Error("Chưa cấu hình đổi tên chủ đề.");
      desiredName = name;
      this.patch(id, { titleSync: { ...link.titleSync, pending: true, error: undefined, retryAt: undefined, desiredName: name, desiredStamp: policyStamp } });
      this.titleWriteAfter.set(chat, this.titleNow() + 1000);
      await this.ports.renameTopic(link.conv!, name);
      this.titleWriteAfter.set(chat, this.titleNow() + 1000);
      const changed = this.titlePolicyStamp(chat, id) !== policyStamp;
      this.patch(id, { title: name, titleSync: { pending: changed && this.followsOpenCode(chat, id) } });
      return { id, status: changed ? "waiting" : "synced" };
    } catch (error) {
      const attempts = Math.min(20, (link.titleSync?.attempts ?? 0) + 1);
      const retrySeconds = (error as { retryAfter?: number }).retryAfter;
      const delay = Math.min(Number.MAX_SAFE_INTEGER - this.titleNow(), Math.max(1000, Math.min(300_000, 1000 * 2 ** attempts),
        typeof retrySeconds === "number" && Number.isFinite(retrySeconds) ? retrySeconds * 1000 : 0));
      const next = this.titleNow() + delay;
      if ((error as { code?: number }).code === 429) {
        this.titleWriteAfter.set(chat, next);
        const data = this.data();
        data.titleRetryAt = { ...data.titleRetryAt, [chat]: next };
        this.store.commitSessionTopics(data);
      }
      if (this.titlePolicyStamp(chat, id) !== policyStamp || !this.followsOpenCode(chat, id)) return { id, status: "disabled" };
      const intendedName = desiredName ?? (link.titleSync?.desiredStamp === policyStamp ? link.titleSync.desiredName : undefined);
      this.patch(id, { titleSync: { pending: true, attempts, retryAt: next, error: (error as Error).message,
        ...(intendedName ? { desiredName: intendedName, desiredStamp: policyStamp } : {}) } });
      this.scheduleTitle(id, force, delay);
      return { id, status: "failed" };
    }
  }

  private scheduleTitle(id: string, force: boolean, delay: number): void {
    if (this.titleStopped) return;
    if (force) this.titleForces.add(id);
    const existing = this.titleTimers.get(id);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.titleTimers.delete(id);
      const forced = this.titleForces.delete(id);
      void Promise.resolve().then(() => {
        const link = this.get(id);
        if (link) return this.syncTitle(link.chat, id, forced);
      }).catch(() => warn("Không lưu được kết quả đồng bộ tên chủ đề."));
    }, Math.min(2_147_483_647, Math.max(1, delay)));
    timer.unref?.();
    this.titleTimers.set(id, timer);
  }

  requestTitleSync(sessionID?: string, force = false, chat?: ConvKey): void {
    if (this.titleStopped) return;
    const data = this.data();
    for (const link of Object.values(data.links)) {
      if (chat && link.chat !== chat) continue;
      if (sessionID && link.sessionID !== sessionID) continue;
      const enabled = data.titlePolicies ? data.titlePolicies.groups[link.chat]?.enabled : data.titleSyncGroups?.[link.chat] === true;
      if (!enabled || (link.titlePolicy?.mode ?? "follow") !== "follow" || link.phase !== "open" || !link.configured) continue;
      this.scheduleTitle(link.id, force, Math.max(1000, (link.titleSync?.retryAt ?? 0) - this.titleNow()));
    }
  }

  observeTopicTitle(conv: ConvKey, name: string): void {
    const link = this.forTopic(conv);
    if (!link || link.phase !== "open" || !this.followsOpenCode(link.chat, link.id) || name === link.title) return;
    this.patch(link.id, { titleSync: { ...link.titleSync, pending: true } });
    this.requestTitleSync(link.sessionID, true);
  }

  stopTitleSync(): void {
    this.titleStopped = true;
    for (const timer of this.titleTimers.values()) clearTimeout(timer);
    this.titleTimers.clear();
    this.titleForces.clear();
    this.titleAgain.clear();
  }

  canPrompt(conv: ConvKey): boolean {
    const link = this.forTopic(conv);
    return Boolean(link?.sessionID && this.canInteract(conv, link.sessionID) && !this.operations.has(link.id));
  }

  canInteract(conv: ConvKey, sessionID: string): boolean {
    const link = this.forTopic(conv);
    return Boolean(link?.phase === "open" && link.configured && link.sessionID === sessionID &&
      this.store.peek(conv)?.sessionID === link.sessionID && this.owners(link.sessionID).length === 1 &&
      this.store.findChatBySession(link.sessionID) === conv);
  }

  topicGone(conv: ConvKey): void {
    const link = this.forTopic(conv);
    if (link) this.patch(link.id, { phase: "attention", step: "topic-missing",
      error: "Telegram topic is missing. Session, binding and worktree are preserved; inspect in General." });
  }

  private patch(id: string, patch: Partial<SessionTopic>): SessionTopic {
    const data = this.data();
    const previous = data.links[id];
    if (!previous) throw new Error("Session/topic link does not exist.");
    const link = { ...previous, ...patch };
    data.links[id] = link;
    this.store.commitSessionTopics(data);
    return structuredClone(link);
  }

  private require(chat: ConvKey, id: string): SessionTopic {
    const link = this.get(id);
    if (!link || link.chat !== chat || chatOf(chat) !== chat) throw new Error("Session/topic link does not belong to this General.");
    if (!link.conv || !link.sessionID || !link.identity) throw new Error("Session/topic creation is incomplete; inspect it before requesting lifecycle changes.");
    return link;
  }

  private async serial<T>(id: string, work: () => Promise<T>): Promise<T> {
    const task = (this.operations.get(id) ?? Promise.resolve()).catch(() => {}).then(work);
    this.operations.set(id, task);
    try { return await task; }
    finally { if (this.operations.get(id) === task) this.operations.delete(id); }
  }

  private async inspect(link: SessionTopic): Promise<TopicSession> {
    if (!link.sessionID || !link.identity || !link.conv || this.store.peek(link.conv)?.sessionID !== link.sessionID ||
      this.owners(link.sessionID).length !== 1 || this.store.findChatBySession(link.sessionID) !== link.conv) throw new TopicOwnershipError("Session binding is incomplete or conflicting.");
    const session = await this.ports.session(link.sessionID);
    if (session.id !== link.sessionID || session.projectID !== link.identity.projectID ||
      session.createdAt !== link.identity.createdAt || session.source !== link.identity.source) {
      throw new TopicOwnershipError("Session identity changed; intervention is required.");
    }
    return session;
  }

  close(chat: ConvKey, id: string): Promise<SessionTopic> {
    this.require(chat, id);
    return this.serial(id, () => this.finishClose(id));
  }

  stop(chat: ConvKey, id: string): Promise<boolean> {
    this.require(chat, id);
    return this.serial(id, async () => {
      const link = this.get(id)!;
      try {
        let session = await this.inspect(link);
        if (!await this.ports.stop(link)) return false;
        session = await this.inspect(link);
        return !session.busy && session.terminal;
      } catch (error) {
        if (error instanceof TopicOwnershipError) this.patch(id, { phase: "attention", step: "identity-conflict", error: error.message });
        return false;
      }
    });
  }

  private async finishClose(id: string): Promise<SessionTopic> {
    const link = this.patch(id, { phase: "closing", step: "confirm-stop", error: undefined });
    try {
      let session = await this.inspect(link);
      if (!await this.ports.stop(link)) return this.get(id)!;
      session = await this.inspect(link);
      if (session.busy || !session.terminal) return this.get(id)!;
      if (!session.archived) {
        this.patch(id, { step: "archive" });
        await this.ports.archive(link.sessionID!, true);
        session = await this.inspect(link);
        if (!session.archived) throw new Error("Archive is not confirmed.");
      }
      if (!link.conv) throw new Error("Topic identity is incomplete.");
      this.patch(id, { step: "close-topic" });
      await this.ports.closeTopic(link.conv);
      return this.patch(id, { phase: "closed", step: undefined, error: undefined });
    } catch (error) {
      if ((error as Error)?.name === "SessionNotFoundError") return this.markMissing(id);
      if (error instanceof TopicOwnershipError) return this.patch(id, { phase: "attention", step: "identity-conflict", error: error.message });
      return this.patch(id, { error: "Closure is not confirmed; retry reconciliation from General." });
    }
  }

  restore(chat: ConvKey, id: string): Promise<SessionTopic> {
    this.require(chat, id);
    return this.serial(id, () => this.finishRestore(id));
  }

  /** Mở đúng liên kết đã biết; không tự sửa trạng thái chưa xác minh. */
  open(chat: ConvKey, id: string): Promise<SessionTopic> {
    this.require(chat, id);
    return this.serial(id, async () => {
      const link = this.get(id)!;
      if (!["open", "closed"].includes(link.phase)) {
        throw new Error(`Phiên đang ở trạng thái ${link.phase}. Kiểm tra bằng /sessions hoặc /sync trong General; không tạo phiên thay thế.`);
      }
      if (link.phase === "closed") return this.finishRestore(id);
      try {
        const session = await this.inspect(link);
        if (session.archived) return this.finishRestore(id);
        if (!link.configured) throw new Error("Cấu hình phiên chưa hoàn tất.");
        await this.ports.openTopic(link.conv!);
        return this.get(id)!;
      } catch (error) {
        if ((error as Error)?.name === "SessionNotFoundError") return this.markMissing(id);
        return this.patch(id, { phase: "attention", step: "verify-open",
          error: "Chưa xác minh được phiên hoặc chưa mở được chủ đề. Kiểm tra trong General; phiên và lịch sử được giữ nguyên." });
      }
    });
  }

  private async finishRestore(id: string): Promise<SessionTopic> {
    if (this.get(id)?.phase === "closing") throw new Error("Session is still closing; confirm termination and closure first.");
    const link = this.patch(id, { phase: "restoring", step: "unarchive", error: undefined });
    try {
      let session = await this.inspect(link);
      if (session.archived) {
        await this.ports.archive(link.sessionID!, false);
        session = await this.inspect(link);
        if (session.archived) throw new Error("Restore is not confirmed.");
      }
      if (!link.configured) {
        if (session.busy || !session.terminal) throw new Error("Wait for idle before completing configuration.");
        await this.ports.configure?.(link.sessionID!, this.store.get(link.conv!));
        this.patch(id, { configured: true });
      }
      if (!link.conv) throw new Error("Topic identity is incomplete.");
      this.patch(id, { step: "open-topic" });
      await this.ports.openTopic(link.conv);
      const opened = this.patch(id, { phase: "open", step: undefined, error: undefined });
      this.requestTitleSync(opened.sessionID);
      return opened;
    } catch (error) {
      if ((error as Error)?.name === "SessionNotFoundError") return this.markMissing(id);
      if (error instanceof TopicOwnershipError) return this.patch(id, { phase: "attention", step: "identity-conflict", error: error.message });
      return this.patch(id, { error: "Restore is not confirmed; retry reconciliation from General." });
    }
  }

  private async markMissing(id: string): Promise<SessionTopic> {
    const link = this.get(id)!;
    try {
      await this.ports.closeTopic(link.conv!);
      return this.patch(id, { phase: "missing", step: undefined, error: "Session no longer exists; history and binding are preserved. This is not execution-termination evidence." });
    } catch {
      return this.patch(id, { phase: "attention", error: "Session is missing; closing its topic is not confirmed." });
    }
  }

  async reconcile(sessionID?: string): Promise<void> {
    for (const link of this.list().filter((item) => !sessionID || item.sessionID === sessionID)) {
      await this.serial(link.id, async () => {
        const current = this.get(link.id)!;
        if (current.phase === "closing") { await this.finishClose(link.id); return; }
        if (current.phase === "restoring") { await this.finishRestore(link.id); return; }
        if (current.phase === "creating" && !this.provisioning.has(current.id)) {
          this.patch(current.id, { phase: "attention", error: "Bot restarted during creation. Inspect the saved identity before retrying; creation is not replayed." });
          return;
        }
        if (!current.conv || !current.identity || current.phase === "creating" ||
          ["topic-missing", "create-session", "inspect-session", "create-topic", "bind"].includes(current.step ?? "")) return;
        try {
          const session = await this.inspect(current);
          if (!session.archived && !current.configured) {
            this.patch(current.id, { phase: "attention", step: "bind", error: "Configuration is incomplete. Use restore to retry it before accepting work." });
            return;
          }
          if (session.archived) await this.ports.closeTopic(current.conv);
          else await this.ports.openTopic(current.conv);
          this.patch(current.id, { phase: session.archived ? "closed" : "open", error: undefined, step: undefined });
        } catch (error) {
          if ((error as Error)?.name === "SessionNotFoundError") {
            await this.markMissing(current.id);
          } else {
            this.patch(current.id, { phase: "attention", error: "Could not verify session/topic state; intervention is required." });
          }
        }
      });
    }
  }

  create(input: NewSessionTopic): Promise<SessionTopic> {
    const key = `${input.chat}:${input.operationID ?? randomBytes(8).toString("hex")}`;
    const pending = this.creating.get(key);
    if (pending) return pending;
    const previous = input.operationID && this.list(input.chat).find((link) => link.operationID === input.operationID);
    if (previous) {
      if (previous.phase === "creating" || previous.phase === "attention") return Promise.reject(new Error("Creation needs reconciliation; do not retry blindly."));
      return Promise.resolve(previous);
    }
    const task = this.createOnce(input).finally(() => this.creating.delete(key));
    this.creating.set(key, task);
    return task;
  }

  async attach(chat: ConvKey, sessionID: string): Promise<SessionTopic> {
    if (!this.enabled(chat) || chatOf(chat) !== chat) throw new Error("Attach sessions from General.");
    const existing = this.list().find((link) => link.sessionID === sessionID);
    if (existing) {
      if (existing.chat !== chat) throw new Error("Session belongs to another chat.");
      return existing;
    }
    const pending = this.attaching.get(sessionID);
    if (pending) {
      const link = await pending;
      if (link.chat !== chat) throw new Error("Session belongs to another chat.");
      return link;
    }
    const task = this.attachOnce(chat, sessionID).finally(() => this.attaching.delete(sessionID));
    this.attaching.set(sessionID, task);
    return task;
  }

  private async attachOnce(chat: ConvKey, sessionID: string): Promise<SessionTopic> {
    if (this.list(chat).some((link) => link.operationID === `attach:${sessionID}`)) {
      throw new Error("Lần gắn phiên trước chưa xác nhận hoàn tất. Kiểm tra bằng /sessions trong General; không tạo lại chủ đề.");
    }
    if (this.owners(sessionID).length > 1) throw new Error("Session has conflicting legacy owners in multiple conversations; resolve ownership explicitly first.");
    const from = this.store.findChatBySession(sessionID);
    if (from && chatOf(from) !== chat) throw new Error("Session belongs to another chat; explicitly detach it there first.");
    const session = await this.ports.session(sessionID);
    if (session.archived) throw new Error("Phiên đã lưu trữ; hãy mở lại trong OpenCode trước khi gắn.");
    if (session.busy || !session.terminal) throw new Error("Phiên vẫn đang chạy hoặc chưa xác nhận kết thúc. Hãy chờ rồi chọn lại.");
    return this.createOnce({ chat, directory: session.directory, title: session.title || this.store.peek(from ?? "")?.worker?.name || sessionID,
      operationID: `attach:${sessionID}`, state: from ? this.store.peek(from) : undefined }, session, from);
  }

  private owners(sessionID: string): ConvKey[] {
    return Object.entries(this.store.all()).filter(([, state]) => state.sessionID === sessionID).map(([conv]) => conv);
  }

  private async createOnce(input: NewSessionTopic, existing?: TopicSession, from?: ConvKey): Promise<SessionTopic> {
    if (!this.enabled(input.chat) || chatOf(input.chat) !== input.chat) throw new Error("Create sessions from General.");
    const id = randomBytes(8).toString("hex");
    const data = this.data();
    data.links[id] = { id, operationID: input.operationID ?? id, chat: input.chat, title: input.title,
      directory: input.directory, phase: "creating", step: "create-session", configured: Boolean(existing) };
    this.store.commitSessionTopics(data);
    this.provisioning.add(id);
    try {
      const sessionID = existing?.id ?? await this.ports.createSession({ ...input, linkID: id });
      if (this.list().some((link) => link.id !== id && link.sessionID === sessionID) ||
        this.owners(sessionID).some((conv) => conv !== from)) throw new Error("Session ownership conflicts with an existing conversation.");
      this.patch(id, { sessionID, step: "inspect-session" });
      const session = existing ?? await this.ports.session(sessionID);
      if (session.id !== sessionID || typeof session.projectID !== "string" || !session.projectID ||
        typeof session.source !== "string" || !session.source || !Number.isFinite(session.createdAt)) {
        throw new TopicOwnershipError("Session creation returned conflicting or incomplete identity evidence.");
      }
      this.patch(id, { identity: { projectID: session.projectID, createdAt: session.createdAt, source: session.source }, step: "create-topic" });
      const fromThread = from ? parseConv(from).threadId : undefined;
      const conv = from && fromThread && fromThread > 1 ? from : convKey(input.chat, await this.ports.createTopic(input.chat, input.title));
      const threadID = parseConv(conv).threadId;
      if (!threadID || !Number.isSafeInteger(threadID) || threadID <= 1 ||
        this.list().some((link) => link.conv === conv) ||
        (this.store.peek(conv)?.sessionID && conv !== from)) throw new TopicOwnershipError("Topic creation returned conflicting or incomplete identity evidence.");
      this.patch(id, { conv, step: "bind" });
      const latest = this.data();
      const state = { ...input.state, sessionID, directory: session.directory, agent: input.agent ?? input.state?.agent,
        lastRelayedTime: existing ? input.state?.lastRelayedTime ?? 1 : 1 };
      this.store.commitSessionTopics(latest, { conv, state, from });
      if (!existing) await this.ports.configure?.(sessionID, this.store.get(conv));
      const opened = this.patch(id, { phase: "open", configured: true, step: undefined });
      this.requestTitleSync(opened.sessionID);
      return opened;
    } catch {
      this.patch(id, { phase: "attention", error: "Creation is unconfirmed; inspect the saved identity before retrying." });
      throw new Error(`Creation needs intervention in General: ${id}.`);
    } finally { this.provisioning.delete(id); }
  }
}
