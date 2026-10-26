/**
 * Pure logic for the PR watcher (Bot-side feature, no I/O).
 *
 * Every tick the bot builds a fresh "snapshot" of the watched repo (open PRs
 * + recently-closed ones, with comment/review/CI detail for PRs that changed)
 * and diffs it against the previous snapshot stored in state. This module owns
 * the diff: given prev + next snapshots it returns the list of user-facing
 * events. Keeping it pure makes the dedup rules (the whole point of the
 * watcher — notify ONCE per change) unit-testable without touching GitHub.
 *
 * Dedup keys (why each is what it is):
 *   - merged:      `merged_at` — a PR transitions open→merged exactly once.
 *   - comments:    max review-comment `id` — ids are globally increasing, so
 *                  "new since last tick" = id > lastSeenId.
 *   - reviews:     max review `id`, same reasoning.
 *   - CI:          (head sha, conclusion) — a commit's checks don't change
 *                  identity; a new head sha is a fresh run.
 *   - opened:      a PR number with no prev entry and state=open.
 */

/** One PR's point-in-time view, as built by a watcher tick. */
export interface PrSnapshot {
  number: number;
  state: "open" | "closed";
  headSha: string;
  title: string;
  updated: string; // ISO updated_at
  mergedAt: string | null;
  maxCommentId: number;
  maxReviewId: number;
  ciSha: string | null; // head sha the CI result refers to
  ciName: string | null; // aggregate conclusion name, e.g. "Test"
  ciConclusion: string | null; // "success" | "failure" | "cancelled" | null
}

/** A previous tick's stored view (what we persist in state). */
export type PrState = Record<number, PrSnapshot>;

/** The new comment that triggered a "comment" event (id + who + excerpt). */
export interface CommentEvent {
  id: number;
  user: string;
  body: string;
}

/** One user-facing notification, in order of arrival. */
export type PrEvent =
  | { kind: "opened"; number: number; title: string }
  | { kind: "merged"; number: number; title: string }
  | { kind: "comment"; number: number; comments: CommentEvent[] }
  | { kind: "review"; number: number; user: string; state: string }
  | { kind: "ci"; number: number; conclusion: string };

/** Max comments surfaced per event (Telegram line budget). */
export const MAX_COMMENTS_PER_EVENT = 3;
/** Excerpt length for a comment body in the notification line. */
export const COMMENT_EXCERPT_LEN = 120;

/**
 * Diff two snapshots into events. `newComments` / `newReviews` are the
 * detail fetches for PRs whose max id advanced (the bot only fetches those,
 * so callers can pass empty arrays for unchanged PRs — no event is produced
 * for an advanced id with no matching detail row… which can't happen, since
 * the fetch filters by id > prev).
 */
export function diffSnapshots(
  prev: PrState,
  next: PrState,
  details: {
    comments?: Record<number, CommentEvent[]>; // prNumber → new comments (id > prev)
    reviews?: Record<number, { id: number; user: string; state: string }[]>;
  } = {},
): PrEvent[] {
  const events: PrEvent[] = [];
  const comments = details.comments ?? {};
  const reviews = details.reviews ?? {};

  for (const number of Object.keys(next).map(Number).sort((a, b) => a - b)) {
    const n = next[number];
    const p = prev[number];

    // 1) merged: open (or unseen) → merged_at set
    if (n.mergedAt && (!p || !p.mergedAt)) {
      events.push({ kind: "merged", number, title: n.title });
      continue; // nothing else to say about a PR that just merged
    }
    // Merged and already reported on a previous tick → silence.
    if (n.mergedAt && p?.mergedAt) continue;

    // 2) opened: brand-new open PR
    if (!p && n.state === "open" && !n.mergedAt) {
      events.push({ kind: "opened", number, title: n.title });
    }

    // 3) CI: changed head sha with a terminal conclusion, or conclusion flipped
    if (n.ciConclusion && n.ciSha) {
      const ciChanged = !p || p.ciSha !== n.ciSha || p.ciConclusion !== n.ciConclusion;
      if (ciChanged && (n.ciConclusion === "success" || n.ciConclusion === "failure" || n.ciConclusion === "cancelled")) {
        events.push({ kind: "ci", number, conclusion: n.ciConclusion });
      }
    }

    // 4) new review (approve / changes requested / comment)
    if (p && n.maxReviewId > p.maxReviewId) {
      const fresh = (reviews[number] ?? []).filter((r) => r.id > p.maxReviewId);
      // Surface the most meaningful one: changes_requested > approved > comment.
      const rank = (s: string) => (s === "CHANGES_REQUESTED" ? 0 : s === "APPROVED" ? 1 : 2);
      const top = fresh.sort((a, b) => rank(a.state) - rank(b.state))[0];
      if (top) events.push({ kind: "review", number, user: top.user, state: top.state });
    }

    // 5) new review comments
    if (p && n.maxCommentId > p.maxCommentId) {
      const fresh = (comments[number] ?? []).filter((c) => c.id > p.maxCommentId);
      if (fresh.length > 0) {
        const shown = fresh.slice(0, MAX_COMMENTS_PER_EVENT).map((c) => ({
          ...c,
          body:
            c.body.length > COMMENT_EXCERPT_LEN
              ? c.body.slice(0, COMMENT_EXCERPT_LEN).trimEnd() + "…"
              : c.body,
        }));
        events.push({ kind: "comment", number, comments: shown });
      }
    }
  }
  return events;
}

/**
 * Render one event as a single notification line (the bot sends events
 * sequentially; one Telegram message per event keeps the chat scannable).
 */
export function renderEvent(ev: PrEvent, repo: string): string {
  switch (ev.kind) {
    case "merged":
      return `✅ ${repo} PR #${ev.number} merged · ${ev.title}`;
    case "opened":
      return `📌 ${repo} PR #${ev.number} mới · ${ev.title}`;
    case "ci": {
      const icon = ev.conclusion === "success" ? "🟢" : ev.conclusion === "failure" ? "🔴" : "⚪";
      const label =
        ev.conclusion === "success" ? "CI passed" : ev.conclusion === "failure" ? "CI FAILED" : "CI cancelled";
      return `${icon} PR #${ev.number}: ${label}`;
    }
    case "review": {
      const icon = ev.state === "APPROVED" ? "👍" : ev.state === "CHANGES_REQUESTED" ? "🔁" : "💬";
      const label =
        ev.state === "APPROVED" ? "approved" : ev.state === "CHANGES_REQUESTED" ? "mô tả cần sửa" : "review mới";
      return `${icon} PR #${ev.number}: @${ev.user} ${label}`;
    }
    case "comment": {
      const first = ev.comments[0];
      const head =
        ev.comments.length > 1
          ? `💬 PR #${ev.number}: ${ev.comments.length} comment mới (từ @${first.user})`
          : `💬 PR #${ev.number} @${first.user}: “${first.body}”`;
      if (ev.comments.length === 1) return head;
      const rest = ev.comments
        .slice(1, MAX_COMMENTS_PER_EVENT)
        .map((c) => `  @${c.user}: “${c.body}”`)
        .join("\n");
      const more = ev.comments.length > MAX_COMMENTS_PER_EVENT ? `\n  (+${ev.comments.length - MAX_COMMENTS_PER_EVENT} khác)` : "";
      return head + "\n" + rest + more;
    }
  }
}
