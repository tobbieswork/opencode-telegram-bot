/**
 * S1 — rule-based next-step buttons: the decision engine (S1 of
 * docs/sdd/next-step-buttons.md).
 *
 * PURE module: no I/O, no Telegram/OpenCode/config imports. `decide()` takes
 * facts the bot already holds plus an injected `now`, and returns at most 3
 * suggestions (N1.2). S2 adds config, S3+ builds the facts and renders.
 *
 * The rule table is one array in priority order (review → board → new-keep)
 * so the 3-button cap is meaningful. Exclusions (N1.3–N1.5, N2.1, N2.2) are
 * applied before any rule is evaluated.
 *
 * Callback encoding: `ns:<id>:<k>` — 4-char base36 id into an in-memory
 * registry (same shape as choices.registry: 24 h TTL), well under Telegram's
 * 64-byte callback_data cap, carrying no user text.
 */
import { randomInt } from "node:crypto";

// ── Types ────────────────────────────────────────────────────────────────────

export type ConversationKind = "plain" | "worker" | "manager" | "advisor" | "scheduled";

export interface NextStepFacts {
  kind: ConversationKind;
  outcome: "succeeded" | "failed" | "interrupted";
  /** The user stopped this turn (/stop). N1.4: no buttons after a stop. */
  interrupted: boolean;
  /** Agent that ran the turn, e.g. "build" | "plan" | "explore" | "general". */
  agent: string;
  elapsedMs: number;
  worker?: { writes: boolean; hasWorktree: boolean };
  /** Workers still running or waiting (for the `board` rule). */
  busyWorkers: number;
  /** N2.3: session modified-files set contains a path not in the last offer's set. */
  filesNew: boolean;
  /** The turn failed with a context-overflow error (isOverflowError). */
  overflow: boolean;
  /** The reply already carries model-written choice buttons (ch:). N1.3. */
  hasChoices: boolean;
  /** The turn already carries a dedicated keyboard (Continue, Switch to build). N1.3. */
  hasOtherKeyboard: boolean;
}

export interface NextStepConfig {
  /** N4.1: feature master switch (off → engine always returns []). */
  nextSteps: boolean;
  /** N4.2: minimum turn length (seconds) for the plain-session `review` rule. */
  minSecs: number;
}

export type RuleId = "review" | "board" | "new-keep";

export interface Suggestion {
  rule: RuleId;
  /** Localized label — says what happens on tap (N3.4). */
  label: (lang: string) => string;
  action: RuleId;
}

export interface Rule {
  rule: RuleId;
  when: (facts: NextStepFacts, cfg: NextStepConfig) => boolean;
}

// ── Labels (N3.4: fixed text, label says what happens) ──────────────────────

const LABELS: Record<RuleId, { vi: string; en: string }> = {
  review: { vi: "🔍 Xem lại", en: "🔍 Review changes" },
  board: { vi: "📋 Board", en: "📋 Board" },
  "new-keep": { vi: "♻ Phiên mới, giữ context", en: "♻ New session, keep context" },
};

/** Localized label for a rule (vi by default, like tr()). */
export function labelFor(rule: RuleId, lang: string): string {
  const l = LABELS[rule];
  return lang === "en" ? l.en : l.vi;
}

// ── Rule table (N2) — one array, in priority order ──────────────────────────

export const RULES: Rule[] = [
  // review — plain session, build agent, succeeded, long enough, new files.
  // N2.1 is structural: the rule requires kind === "plain", so it can never
  // fire in the Manager conversation.
  {
    rule: "review",
    when: (f, c) =>
      f.kind === "plain" &&
      f.agent === "build" &&
      f.outcome === "succeeded" &&
      !f.interrupted &&
      f.elapsedMs >= c.minSecs * 1000 &&
      f.filesNew,
  },
  // review — a writing worker finished done with changes (N2.2: `writes` must
  // be true; read-only plan/explore/general agents never get a Review).
  {
    rule: "review",
    when: (f) =>
      f.kind === "worker" &&
      f.outcome === "succeeded" &&
      f.worker?.writes === true &&
      f.filesNew,
  },
  // board — a Manager turn ended and at least one worker is still busy.
  {
    rule: "board",
    when: (f) => f.kind === "manager" && f.outcome === "succeeded" && f.busyWorkers > 0,
  },
  // new-keep — the turn failed with a context-overflow error.
  {
    rule: "new-keep",
    when: (f) => f.overflow === true && f.outcome === "failed",
  },
];

// ── decide (N1) ──────────────────────────────────────────────────────────────

/** N1.2: at most 3 buttons. */
const MAX_BUTTONS = 3;

/**
 * Decide which next-step buttons belong under this turn's result.
 * Pure: (facts, cfg, now) → Suggestion[], exclusions applied, capped at 3.
 * `now` is injected for testability (unused by the v1 rules, kept in the
 * signature so a future time-dependent rule doesn't change the API).
 */
export function decide(
  facts: NextStepFacts,
  cfg: NextStepConfig,
  _now: number,
  rules: Rule[] = RULES,
): Suggestion[] {
  // N4.1: feature off → identical to today (no buttons).
  if (!cfg.nextSteps) return [];
  // N1.3: the reply already has choice buttons or a dedicated keyboard.
  if (facts.hasChoices || facts.hasOtherKeyboard) return [];
  // N1.4: stopped turns, advisor threads, unattended scheduled runs.
  if (facts.interrupted || facts.kind === "advisor" || facts.kind === "scheduled") return [];

  const out: Suggestion[] = [];
  for (const r of rules) {
    if (out.length >= MAX_BUTTONS) break;
    if (r.when(facts, cfg)) {
      out.push({ rule: r.rule, label: (lang) => labelFor(r.rule, lang), action: r.rule });
    }
  }
  return out;
}

// ── Registry (same shape as choices.registry: 4-char base36 id, 24 h TTL) ────

export interface RegistryRec {
  conv: string;
  sessionID: string;
  rule: RuleId;
  createdAt: number;
}

/** Default TTL for unclicked next-step records (24 h). */
const NS_TTL_MS = 24 * 60 * 60 * 1000;

/** Callback prefix — `ns:<id>:<k>`. */
export const NS_PREFIX = "ns:";

const records = new Map<string, RegistryRec>();

const B36_4 = /^[0-9a-z]{4}$/;

/**
 * In-memory registry binding a short id to the conversation + session + rule a
 * keyboard was created for (N3.2: taps are refused once the conversation moved
 * to another session). Same process lifetime as the session map.
 */
export const registry = {
  /** Store a record and return a fresh 4-char base36 id. */
  set({ conv, sessionID, rule, now }: { conv: string; sessionID: string; rule: RuleId; now: number }): string {
    let id = "";
    do {
      id = randomInt(0, 36 ** 4).toString(36).padStart(4, "0");
    } while (records.has(id));
    records.set(id, { conv, sessionID, rule, createdAt: now });
    return id;
  },
  /** Look up a record; prunes it when expired (N3.6: expired, not silent). */
  get(id: string, now: number): RegistryRec | null {
    const rec = records.get(id);
    if (!rec) return null;
    if (now - rec.createdAt > NS_TTL_MS) {
      records.delete(id);
      return null;
    }
    return rec;
  },
  /** Consume a record (one-shot taps, N3.1). No-op when unknown. */
  delete(id: string): void {
    records.delete(id);
  },
  /** Remove records older than maxAgeMs (default 24 h). Returns count pruned. */
  prune(now: number, maxAgeMs: number = NS_TTL_MS): number {
    let n = 0;
    for (const [id, rec] of records) {
      if (now - rec.createdAt > maxAgeMs) {
        records.delete(id);
        n++;
      }
    }
    return n;
  },
  /** Test helper: drop all records. */
  clear(): void {
    records.clear();
  },
};

// ── Callback encoding: `ns:<id>:<k>` (k = rule index) ────────────────────────

/** Tiny callback_data — 10–11 bytes, well under Telegram's 64-byte cap. */
export function callbackFor(id: string, k: number): string {
  return `${NS_PREFIX}${id}:${k}`;
}

/** Parse an `ns:<id>:<k>` callback; null on anything foreign or malformed. */
export function parseCallback(data: string): { id: string; k: number } | null {
  if (typeof data !== "string" || !data.startsWith(NS_PREFIX)) return null;
  const rest = data.slice(NS_PREFIX.length);
  const idx = rest.lastIndexOf(":");
  if (idx < 0) return null;
  const id = rest.slice(0, idx);
  const kStr = rest.slice(idx + 1);
  if (!B36_4.test(id)) return null;
  if (!/^\d+$/.test(kStr)) return null;
  const k = parseInt(kStr, 10);
  if (!Number.isSafeInteger(k) || k < 0) return null;
  return { id, k };
}
