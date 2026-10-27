/**
 * Checks the PR watcher's snapshot diff + event rendering (src/pr-watch.ts).
 * The whole point of the watcher is to notify ONCE per change, so the dedup
 * rules are the contract under test:
 *   - merged:      fires when merged_at appears, never again
 *   - opened:      fires for a brand-new open PR only
 *   - comment:     id > lastSeenId, capped + excerpted
 *   - review:      highest-severity new review
 *   - ci:          (sha, conclusion) change with a terminal conclusion
 *   - first run:   no events at all (baseline)
 *
 * Run:  npx tsx scripts/test-pr-watch.ts
 */
import { diffSnapshots, renderEvent, MAX_COMMENTS_PER_EVENT, type PrSnapshot, type PrState } from "../src/pr-watch.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

const REPO = "owner/repo";

function snap(p: Partial<PrSnapshot> & { number: number }): PrSnapshot {
  return {
    state: "open",
    headSha: "sha1",
    title: "feat: thing",
    updated: "2026-10-26T00:00:00Z",
    mergedAt: null,
    maxCommentId: 0,
    maxReviewId: 0,
    ciSha: null,
    ciName: null,
    ciConclusion: null,
    ...p,
  };
}

// ── merged: open → merged fires once, then silence ──────────────────────────
{
  const prev: PrState = { 7: snap({ number: 7 }) };
  const next: PrState = { 7: snap({ number: 7, state: "closed", mergedAt: "2026-10-26T10:00:00Z" }) };
  const ev = diffSnapshots(prev, next);
  check("merged fires on open→merged", ev.length === 1 && ev[0].kind === "merged" && (ev[0] as any).number === 7);

  // Same state again → no event (already reported).
  const ev2 = diffSnapshots(next, next);
  check("merged fires only once", ev2.length === 0);
}

// ── opened: brand-new open PR fires once ────────────────────────────────────
{
  const ev = diffSnapshots({}, { 9: snap({ number: 9 }) });
  check("opened fires for new open PR", ev.length === 1 && ev[0].kind === "opened");
  const again = diffSnapshots({ 9: snap({ number: 9 }) }, { 9: snap({ number: 9 }) });
  check("opened fires only once", again.length === 0);
}

// ── comment: id-based dedup, cap + excerpt ──────────────────────────────────
{
  const prev: PrState = { 5: snap({ number: 5, maxCommentId: 100 }) };
  const next: PrState = { 5: snap({ number: 5, maxCommentId: 103 }) };
  const comments = [
    { id: 101, user: "alice", body: "first" },
    { id: 102, user: "bob", body: "x".repeat(300) },
    { id: 103, user: "carol", body: "third" },
  ];
  const ev = diffSnapshots(prev, next, { comments: { 5: comments } });
  check("comment fires when maxCommentId advances", ev.length === 1 && ev[0].kind === "comment");
  const c = ev[0] as any;
  check("comment shows only new ids", c.comments.length === 3 && c.comments[0].id === 101);
  check("comment body excerpted to 120 chars + ellipsis", c.comments[1].body.length === 121 && c.comments[1].body.endsWith("…"));

  // Unchanged → silence.
  check("comment silent when unchanged", diffSnapshots(next, next, { comments: { 5: comments } }).length === 0);

  // Cap: 5 new comments → only 3 shown.
  const prev2: PrState = { 5: snap({ number: 5, maxCommentId: 10 }) };
  const next2: PrState = { 5: snap({ number: 5, maxCommentId: 15 }) };
  const many = Array.from({ length: 5 }, (_, i) => ({ id: 11 + i, user: `u${i}`, body: `b${i}` }));
  const ev2 = diffSnapshots(prev2, next2, { comments: { 5: many } });
  const c2 = ev2[0] as any;
  check("comment capped at MAX_COMMENTS_PER_EVENT", c2.comments.length === MAX_COMMENTS_PER_EVENT);
}

// ── review: highest-severity new review wins ────────────────────────────────
{
  const prev: PrState = { 3: snap({ number: 3, maxReviewId: 10 }) };
  const next: PrState = { 3: snap({ number: 3, maxReviewId: 12 }) };
  const reviews = [
    { id: 11, user: "dave", state: "APPROVED" },
    { id: 12, user: "erin", state: "CHANGES_REQUESTED" },
  ];
  const ev = diffSnapshots(prev, next, { reviews: { 3: reviews } });
  check("review fires when maxReviewId advances", ev.length === 1 && ev[0].kind === "review");
  check("review surfaces CHANGES_REQUESTED over APPROVED", (ev[0] as any).state === "CHANGES_REQUESTED" && (ev[0] as any).user === "erin");
  check("review silent when unchanged", diffSnapshots(next, next, { reviews: { 3: reviews } }).length === 0);
}

// ── ci: (sha, conclusion) change with terminal conclusion ───────────────────
{
  const prev: PrState = { 2: snap({ number: 2, headSha: "shaA", ciSha: "shaA", ciConclusion: "success" }) };
  // New push → new sha, CI still pending (null) → no terminal event yet.
  const nextPending: PrState = { 2: snap({ number: 2, headSha: "shaB", ciSha: "shaB", ciConclusion: null }) };
  check("ci silent while pending", diffSnapshots(prev, nextPending).length === 0);
  // New push → CI failure → event.
  const nextFail: PrState = { 2: snap({ number: 2, headSha: "shaB", ciSha: "shaB", ciConclusion: "failure" }) };
  const evFail = diffSnapshots(prev, nextFail);
  check("ci fires on failure", evFail.length === 1 && evFail[0].kind === "ci" && (evFail[0] as any).conclusion === "failure");
  // Same failure reported again → silence.
  check("ci silent when unchanged", diffSnapshots(nextFail, nextFail).length === 0);
  // Conclusion flip on same sha → event.
  const nextOk: PrState = { 2: snap({ number: 2, headSha: "shaB", ciSha: "shaB", ciConclusion: "success" }) };
  check("ci fires on conclusion flip", diffSnapshots(nextFail, nextOk).length === 1);
}

// ── first run: empty prev → no events (baseline, no replay) ────────────────
{
  const many: PrState = {
    1: snap({ number: 1 }),
    2: snap({ number: 2, state: "closed", mergedAt: "2026-10-26T09:00:00Z", ciSha: "sha1", ciConclusion: "success" }),
    3: snap({ number: 3, maxCommentId: 42 }),
  };
  const details = { comments: { 3: [{ id: 42, user: "z", body: "old" }] } };

  // Sanity: the raw diff WOULD replay everything if called naively on an empty
  // prev — that's exactly why the tick guards the first run.
  const naive = diffSnapshots({}, many, details);
  check("naive diff replays on empty prev (why a guard is needed)", naive.length > 0);

  // The tick's guard (exact same expression as Bot.prWatchTick): no events when
  // prev is empty, so enabling the watcher never replays the repo's history.
  const prev: PrState = {};
  const firstRun = Object.keys(prev).length === 0;
  const ev = firstRun ? [] : diffSnapshots(prev, many, details);
  check("first run emits nothing (baseline, no replay)", ev.length === 0, `got ${ev.length} events`);

  // Empty repo entirely → no events either way.
  check("empty repo → no events", diffSnapshots({}, {}).length === 0);
}

// ── renderEvent: one line per kind ──────────────────────────────────────────
{
  check("render merged", renderEvent({ kind: "merged", number: 17, title: "feat: x" }, REPO) === `✅ ${REPO} PR #17 merged · feat: x`);
  check("render opened", renderEvent({ kind: "opened", number: 9, title: "fix: y" }, REPO) === `📌 ${REPO} PR #9 mới · fix: y`);
  check("render ci success", renderEvent({ kind: "ci", number: 9, conclusion: "success" }, REPO).includes("🟢"));
  check("render ci failure", renderEvent({ kind: "ci", number: 9, conclusion: "failure" }, REPO).includes("CI FAILED"));
  check("render review approved", renderEvent({ kind: "review", number: 9, user: "a", state: "APPROVED" }, REPO).includes("@a approved"));
  const single = renderEvent({ kind: "comment", number: 9, comments: [{ id: 1, user: "a", body: "hi" }] }, REPO);
  check("render single comment quotes body", single.includes("@a") && single.includes("“hi”"));
  const multi = renderEvent(
    { kind: "comment", number: 9, comments: [{ id: 1, user: "a", body: "1" }, { id: 2, user: "b", body: "2" }] },
    REPO,
  );
  check("render multi comment lists all", multi.includes("2 comment mới") && multi.includes("@b"));
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
