/**
 * QueueStore (src/queue.ts) checks: FIFO order, cap (refuse at 3, nothing
 * dropped), 30-min expiry (skipped by shift/list/size, swept by expire),
 * clear, per-conv isolation, position, senderId, custom cap/expiry.
 * Time is injected — nothing waits.
 *
 * Run:  npx tsx scripts/test-queue.ts
 */
import { QueueStore } from "../src/queue.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

const T0 = 1_000_000; // arbitrary epoch ms for injected time
const MIN = 60_000;

// ── order (FIFO) + position + list/size/has ──────────────────────────────
{
  const q = new QueueStore();
  const r1 = q.push("a", { text: "one" }, T0);
  check("push #1 ok, position 1", r1.ok === true && r1.position === 1, JSON.stringify(r1));
  const r2 = q.push("a", { text: "two" }, T0 + MIN);
  check("push #2 ok, position 2", r2.ok && r2.position === 2, JSON.stringify(r2));
  const r3 = q.push("a", { text: "three" }, T0 + 2 * MIN);
  check("push #3 ok, position 3", r3.ok && r3.position === 3, JSON.stringify(r3));

  check("size counts 3", q.size("a", T0 + 3 * MIN) === 3, String(q.size("a", T0 + 3 * MIN)));
  check("has true for a non-empty conv", q.has("a"));
  check("has false for an unknown conv", !q.has("zzz"));

  const l = q.list("a", T0 + 3 * MIN);
  check("list order FIFO", l.map((x) => x.text).join(",") === "one,two,three", JSON.stringify(l));
  check("list ageMs is from each item's `at`", l[0].ageMs === 3 * MIN && l[2].ageMs === MIN, JSON.stringify(l.map((x) => x.ageMs)));

  check("shift returns the head", q.shift("a", T0 + 3 * MIN)?.text === "one");
  check("shift is FIFO", q.shift("a", T0 + 3 * MIN)?.text === "two");
  check("shift on an empty conv is null", q.shift("zzz", T0) === null);
  check("list on an empty conv is []", q.list("zzz", T0).length === 0);
  check("size on an empty conv is 0", q.size("zzz", T0) === 0);
}

// ── cap: the 4th push is refused, nothing dropped ───────────────────────
{
  const q = new QueueStore();
  q.push("x", { text: "1" }, T0);
  q.push("x", { text: "2" }, T0 + 20 * MIN);
  q.push("x", { text: "3" }, T0 + 21 * MIN);
  const r = q.push("x", { text: "4" }, T0 + 22 * MIN);
  check("4th push refused with { full }", r.ok === false && "full" in r, JSON.stringify(r));
  check("queue still holds 3 (no silent drop)", q.size("x", T0 + 22 * MIN) === 3, String(q.size("x", T0 + 22 * MIN)));
  check("oldest item intact after refusal", q.list("x", T0 + 22 * MIN)[0].text === "1");

  // an item that has expired frees its slot
  q.shift("x", T0 + 31 * MIN); // head "1" (T0) is expired → skipped, "2" is consumed
  const r2 = q.push("x", { text: "4" }, T0 + 31 * MIN);
  check("push ok once a slot expired", r2.ok === true && r2.position === 2, JSON.stringify(r2));
}

// ── expiry: >30 min is skipped, exactly 30 min is still alive ────────────
{
  const q = new QueueStore(); // default expiry 30 min
  q.push("e", { text: "old" }, T0);
  q.push("e", { text: "new" }, T0 + 29 * MIN);
  const at31 = T0 + 31 * MIN;
  check("expired item hidden from list", q.list("e", at31).map((x) => x.text).join(",") === "new");
  check("expired item excluded from size", q.size("e", at31) === 1, String(q.size("e", at31)));
  check("shift skips the expired head", q.shift("e", at31)?.text === "new");
  check("conv empty after skipping", q.size("e", at31) === 0);

  q.push("b", { text: "edge" }, T0);
  check("exactly 30 min is NOT expired", q.size("b", T0 + 30 * MIN) === 1, String(q.size("b", T0 + 30 * MIN)));
  check("30 min + 1 ms is expired", q.size("b", T0 + 30 * MIN + 1) === 0, String(q.size("b", T0 + 30 * MIN + 1)));
}

// ── expire() sweeps every conv ───────────────────────────────────────────
{
  const q = new QueueStore();
  q.push("m", { text: "old" }, T0); // expired at T0+31 min
  q.push("m", { text: "new" }, T0 + 20 * MIN); // live
  q.push("n", { text: "ancient" }, T0); // expired
  const dropped = q.expire(T0 + 31 * MIN);
  check("expire() drops all expired items (every conv)", dropped === 2, String(dropped));
  check("expire() keeps live items", q.list("m", T0 + 31 * MIN).map((x) => x.text).join(",") === "new");
  check("conv emptied by expire is gone", !q.has("n"));
}

// ── clear ────────────────────────────────────────────────────────────────
{
  const q = new QueueStore();
  q.push("k", { text: "a" }, T0);
  q.push("k", { text: "b" }, T0);
  q.push("z", { text: "z" }, T0);
  check("clear returns the count", q.clear("k") === 2, String(q.clear("k")));
  check("cleared conv is empty", q.size("k", T0) === 0 && !q.has("k"));
  check("other conv untouched by clear", q.size("z", T0) === 1);
  check("clear on an unknown conv is 0", q.clear("nope") === 0);
}

// ── per-conv isolation ───────────────────────────────────────────────────
{
  const q = new QueueStore();
  q.push("a", { text: "a0" }, T0);
  q.push("a", { text: "a1" }, T0 + 1);
  q.push("a", { text: "a2" }, T0 + 2);
  const r = q.push("b", { text: "b0" }, T0);
  check("a full conv does not block another conv", r.ok === true && r.position === 1, JSON.stringify(r));
  q.shift("a", T0);
  check("shifting one conv leaves the other intact", q.size("b", T0) === 1 && q.list("b", T0)[0].text === "b0");
  q.clear("a");
  check("clearing one conv leaves the other intact", q.size("b", T0) === 1);
}

// ── custom cap/expiry + senderId ─────────────────────────────────────────
{
  const q = new QueueStore({ cap: 2, expiryMs: 5 * MIN });
  q.push("s", { text: "1", senderId: "111" }, T0);
  q.push("s", { text: "2", senderId: "222" }, T0 + 4 * MIN);
  check("custom cap (2) enforced", q.push("s", { text: "3" }, T0 + 4 * MIN).ok === false);
  const l = q.list("s", T0 + 4 * MIN);
  check("senderId recorded on the items", l[0].senderId === "111" && l[1].senderId === "222", JSON.stringify(l));
  const it = q.shift("s", T0 + 5 * MIN + 1);
  check("custom expiry: expired head skipped, next returned", it?.text === "2" && it?.senderId === "222", JSON.stringify(it));
  q.push("s", { text: "3" }, T0 + 5 * MIN + 1);
  check("push without senderId keeps it undefined", q.list("s", T0 + 5 * MIN + 1)[0].senderId === undefined);
}


// prepend: requeue at the HEAD (Q1.11 FIFO), preserving the original `at`.
{
  const q = new QueueStore();
  q.push("s", { text: "A" }, T0);
  q.push("s", { text: "B" }, T0 + 1);
  const popped = q.shift("s", T0 + 2);            // A out (head), B remains
  q.prepend("s", { text: "A", at: T0 }, T0 + 3);          // A back at the head, before B
  const order = q.list("s", T0 + 3).map((i) => i.text);
  check("prepend: item back at head (FIFO preserved)", order[0] === "A" && order[1] === "B", JSON.stringify(order));
  const next = q.shift("s", T0 + 3);
  check("prepend: shifted-out item comes back first", next?.text === "A", JSON.stringify(next));
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
