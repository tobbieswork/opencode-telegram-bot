/**
 * Checks the scheduler engine (slice 2): the file-backed store (round-trip,
 * corrupt → .bak, size cap, CRUD) and the tick/decision logic (fire exactly
 * once, catchup vs skip, busy, error-isolation, allowlist, once-disable).
 * Every dep is injected (fake clock / dispatch / notify / allow / busy + a real
 * temp-file store), so no Telegram or OpenCode is needed.
 *
 * Run:  npx tsx scripts/test-scheduler.ts
 */
import { mkdirSync, writeFileSync, existsSync, rm } from "node:fs";
import { Scheduler, ScheduleStore } from "../src/scheduler.js";
import type { SchedulerDeps } from "../src/scheduler.js";
import type { Schedule } from "../src/schedule.js";
import type { ConvKey } from "../src/conv.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}
function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

const HICT = "Asia/Ho_Chi_Minh";
// Dedicated scratch dir (created by the store's own mkdir on first save).
const T = `/tmp/opencode/oc-scheduler-${Date.now()}-${process.pid}`;
mkdirSync(T, { recursive: true });

const Z = Date.UTC;
const NOW = Z(2026, 9, 1, 2, 0, 0); // fixed "now" (Oct 1 2026 02:00 UTC = 09:00 ICT)
const GRACE = 60 * 60_000; // 1h, matches the cfg default

function mkSch(over: Partial<Schedule> = {}): Schedule {
  return {
    id: "a1b2",
    conv: "1:1",
    prompt: "do thing",
    spec: { kind: "daily", time: { h: 8, m: 0 } },
    tz: HICT,
    dir: ".",
    agent: "plan",
    nextRunAt: 0,
    enabled: true,
    createdBy: 1,
    createdAt: 0,
    ...over,
  };
}

/** A fake clock we can freeze (or advance if needed). */
function clock(start: number): { now: () => number; set: (n: number) => void } {
  let t = start;
  return { now: () => t, set: (n: number) => { t = n; } };
}

interface CallLog {
  dispatch: Schedule[];
  notify: Array<[ConvKey, string]>;
}

function makeDeps(
  store: ScheduleStore,
  opts: {
    clock?: () => number;
    isBusy?: (s: Schedule) => boolean;
    isAllowed?: (id: number) => boolean;
    dispatch?: (s: Schedule) => Promise<void>;
    graceMs?: number;
    tickMs?: number;
  } = {},
): { deps: SchedulerDeps; calls: CallLog } {
  const calls: CallLog = { dispatch: [], notify: [] };
  const deps: SchedulerDeps = {
    now: opts.clock ?? (() => NOW),
    store,
    dispatch: opts.dispatch ?? (async (s) => { calls.dispatch.push(s); }),
    isBusy: opts.isBusy ?? (() => false),
    isAllowed: opts.isAllowed ?? (() => true),
    notify: async (conv, text) => { calls.notify.push([conv, text]); },
    tickMs: opts.tickMs ?? 30_000,
    graceMs: opts.graceMs ?? GRACE,
  };
  return { deps, calls };
}

// ── store: round-trip save/load + missing file ─────────────────────────────
{
  const f = `${T}/roundtrip.json`;
  const store = new ScheduleStore(f, 10);
  store.save([mkSch({ id: "aa11" }), mkSch({ id: "bb22", enabled: false, prompt: "p2" })]);
  const back = store.load();
  check("store: round-trip length", back.length === 2, String(back.length));
  check(
    "store: round-trip fields preserved",
    back[0].id === "aa11" && back[0].tz === HICT && back[1].id === "bb22" && back[1].enabled === false && back[1].prompt === "p2",
  );
  check("store: missing file → []", new ScheduleStore(`${T}/nope.json`, 10).load().length === 0);
}

// ── store: corrupt file → renamed to .bak + returns [] ─────────────────────
{
  const f = `${T}/corrupt.json`;
  writeFileSync(f, "{ this is not json", "utf8");
  const store = new ScheduleStore(f, 10);
  const got = store.load();
  check("store: corrupt → []", got.length === 0, String(got.length));
  check("store: corrupt → renamed to .bak", existsSync(`${f}.bak`) && !existsSync(f));
  // A bad shape (valid JSON, no schedules array) is also quarantined.
  const g = `${T}/badshape.json`;
  writeFileSync(g, '{"v":1,"schedules":"oops"}', "utf8");
  check("store: bad shape → [] + .bak", new ScheduleStore(g, 10).load().length === 0 && existsSync(`${g}.bak`));
}

// ── store: size cap ────────────────────────────────────────────────────────
{
  const store = new ScheduleStore(`${T}/cap.json`, 2);
  check("store: add below cap ok", !throws(() => store.add(mkSch({ id: "c1" }))));
  check("store: add at cap ok", !throws(() => store.add(mkSch({ id: "c2" }))));
  check("store: add beyond cap throws", throws(() => store.add(mkSch({ id: "c3" }))));
  const dup = new ScheduleStore(`${T}/dup.json`, 5);
  dup.add(mkSch({ id: "d1" }));
  check("store: duplicate id throws", throws(() => dup.add(mkSch({ id: "d1" }))));
}

// ── store: CRUD get/remove/set ─────────────────────────────────────────────
{
  const store = new ScheduleStore(`${T}/crud.json`, 5);
  store.add(mkSch({ id: "s1", prompt: "orig", nextRunAt: 123 }));
  check("store: get found", store.get("s1")?.prompt === "orig");
  check("store: get missing → undefined", store.get("nope") === undefined);
  const upd = store.set("s1", { prompt: "patched", enabled: false });
  check("store: set partial update (untouched fields kept)", upd?.prompt === "patched" && upd?.enabled === false && upd?.nextRunAt === 123);
  check("store: set keeps id immutable", store.set("s1", { id: "hijack" })?.id === "s1");
  check("store: remove existing", store.remove("s1") === true && store.get("s1") === undefined);
  check("store: remove missing → false", store.remove("s1") === false);
}

// ── tick: a due schedule fires dispatch EXACTLY ONCE across two ticks ──────
{
  const store = new ScheduleStore(`${T}/once-once.json`, 10);
  const c = clock(NOW);
  const { deps, calls } = makeDeps(store, { clock: c.now });
  store.add(mkSch({ id: "a1", nextRunAt: NOW })); // due exactly now
  const sched = new Scheduler(deps);
  await sched.tick();
  await sched.tick();
  check("tick: due fires dispatch exactly once across two ticks", calls.dispatch.length === 1, String(calls.dispatch.length));
  const after = store.get("a1")!;
  check("tick: nextRunAt advanced past now (double-run guard)", after.nextRunAt > NOW, `nextRunAt=${after.nextRunAt} now=${NOW}`);
  check("tick: lastRunAt set to now", after.lastRunAt === NOW, String(after.lastRunAt));
  check("tick: lastStatus ok after dispatch", after.lastStatus === "ok", String(after.lastStatus));
}

// ── tick: late-within-grace → catchup fires; late-beyond-grace → skip ──────
{
  const store = new ScheduleStore(`${T}/late.json`, 10);
  const c = clock(NOW);
  const { deps, calls } = makeDeps(store, { clock: c.now });
  store.add(mkSch({ id: "l1", nextRunAt: NOW - 30 * 60_000 })); // 30 min late → catchup
  store.add(mkSch({ id: "l2", nextRunAt: NOW - 2 * 3600_000 })); // 2h late → skip
  const sched = new Scheduler(deps);
  await sched.tick();
  check("late: catchup (within grace) fires", calls.dispatch.some((s) => s.id === "l1"), JSON.stringify(calls.dispatch.map((s) => s.id)));
  check("late: beyond-grace does NOT fire", !calls.dispatch.some((s) => s.id === "l2"));
  const l1 = store.get("l1")!;
  const l2 = store.get("l2")!;
  check("late: catchup advanced nextRunAt", l1.nextRunAt > NOW, String(l1.nextRunAt));
  check("late: catchup lastStatus ok", l1.lastStatus === "ok", String(l1.lastStatus));
  check("late: skipped-late advanced nextRunAt", l2.nextRunAt > NOW, String(l2.nextRunAt));
  check("late: skipped-late lastStatus", l2.lastStatus === "skipped-late", String(l2.lastStatus));
}

// ── tick: isBusy → skipped-busy, no dispatch, one notify ───────────────────
{
  const store = new ScheduleStore(`${T}/busy.json`, 10);
  const c = clock(NOW);
  const { deps, calls } = makeDeps(store, { clock: c.now, isBusy: () => true });
  store.add(mkSch({ id: "b1", nextRunAt: NOW }));
  const sched = new Scheduler(deps);
  await sched.tick();
  check("busy: no dispatch when isBusy", calls.dispatch.length === 0, String(calls.dispatch.length));
  check("busy: lastStatus skipped-busy", store.get("b1")?.lastStatus === "skipped-busy", String(store.get("b1")?.lastStatus));
  check("busy: notify sent once", calls.notify.length === 1, String(calls.notify.length));
  check("busy: notify targets the schedule's conv", calls.notify[0]?.[0] === "1:1", JSON.stringify(calls.notify[0]));
}

// ── tick: a throwing dispatch must not crash; others still processed ───────
{
  const store = new ScheduleStore(`${T}/err.json`, 10);
  const c = clock(NOW);
  const { deps, calls } = makeDeps(store, {
    clock: c.now,
    dispatch: async (s) => {
      if (s.id === "bad") throw new Error("boom");
      calls.dispatch.push(s);
    },
  });
  store.add(mkSch({ id: "bad", nextRunAt: NOW }));
  store.add(mkSch({ id: "good", nextRunAt: NOW }));
  const sched = new Scheduler(deps);
  let crashed = false;
  try {
    await sched.tick();
  } catch {
    crashed = true;
  }
  check("error: tick does NOT crash on a throwing dispatch", !crashed);
  check("error: throwing schedule → lastStatus error", store.get("bad")?.lastStatus === "error", String(store.get("bad")?.lastStatus));
  check("error: other schedule still dispatched", calls.dispatch.some((s) => s.id === "good"), JSON.stringify(calls.dispatch.map((s) => s.id)));
  check("error: good schedule → lastStatus ok", store.get("good")?.lastStatus === "ok", String(store.get("good")?.lastStatus));
  check("error: a notify went out for the failing one", calls.notify.length >= 1, String(calls.notify.length));
}

// ── tick: isAllowed false → not dispatched ─────────────────────────────────
{
  const store = new ScheduleStore(`${T}/allowed.json`, 10);
  const c = clock(NOW);
  const { deps, calls } = makeDeps(store, { clock: c.now, isAllowed: () => false });
  store.add(mkSch({ id: "n1", nextRunAt: NOW, createdBy: 99 }));
  const sched = new Scheduler(deps);
  await sched.tick();
  check("allow: not-allowed → no dispatch", calls.dispatch.length === 0, String(calls.dispatch.length));
  check("allow: not-allowed → not marked ok", store.get("n1")?.lastStatus !== "ok", String(store.get("n1")?.lastStatus));
}

// ── tick: kind "once" fires once, then is disabled and never fires again ───
{
  const store = new ScheduleStore(`${T}/once.json`, 10);
  const c = clock(NOW);
  const { deps, calls } = makeDeps(store, { clock: c.now });
  store.add(mkSch({ id: "o1", spec: { kind: "once", date: { y: 2026, mo: 10, d: 1 }, time: { h: 8, m: 0 } }, nextRunAt: NOW }));
  const sched = new Scheduler(deps);
  await sched.tick();
  await sched.tick();
  check("once: fires exactly once", calls.dispatch.length === 1, String(calls.dispatch.length));
  check("once: disabled after firing", store.get("o1")?.enabled === false, String(store.get("o1")?.enabled));
}

// ── tick: a `once` missed beyond grace is skipped AND disabled (no churn) ──
{
  const store = new ScheduleStore(`${T}/once-skip.json`, 10);
  const c = clock(NOW);
  const { deps, calls } = makeDeps(store, { clock: c.now });
  // The once's single instant is 3h in the past → beyond the 1h grace.
  store.add(mkSch({ id: "o2", spec: { kind: "once", date: { y: 2026, mo: 10, d: 1 }, time: { h: 1, m: 0 } }, nextRunAt: NOW - 3 * 3600_000 }));
  const sched = new Scheduler(deps);
  await sched.tick();
  await sched.tick();
  check("once-skip: missed beyond grace does NOT dispatch", calls.dispatch.length === 0, String(calls.dispatch.length));
  check("once-skip: lastStatus skipped-late", store.get("o2")?.lastStatus === "skipped-late", String(store.get("o2")?.lastStatus));
  check("once-skip: disabled so it never churningly re-skips", store.get("o2")?.enabled === false, String(store.get("o2")?.enabled));
}

// ── tick: re-entrancy — overlapping ticks never double-dispatch ─────────────
{
  const store = new ScheduleStore(`${T}/reentry.json`, 10);
  const c = clock(NOW);
  const { deps, calls } = makeDeps(store, {
    clock: c.now,
    dispatch: async (s) => {
      await new Promise((r) => setTimeout(r, 30));
      calls.dispatch.push(s);
    },
  });
  store.add(mkSch({ id: "r1", nextRunAt: NOW }));
  const sched = new Scheduler(deps);
  await Promise.all([sched.tick(), sched.tick()]);
  check("reentry: overlapping ticks dispatch exactly once", calls.dispatch.length === 1, String(calls.dispatch.length));
}

// ── tick: not-yet-due schedules are left alone ──────────────────────────────
{
  const store = new ScheduleStore(`${T}/notdue.json`, 10);
  const c = clock(NOW);
  const { deps, calls } = makeDeps(store, { clock: c.now });
  store.add(mkSch({ id: "f1", nextRunAt: NOW + 3600_000 })); // an hour in the future
  const sched = new Scheduler(deps);
  await sched.tick();
  check("notdue: future schedule is not dispatched", calls.dispatch.length === 0, String(calls.dispatch.length));
  check("notdue: future schedule untouched (no status)", store.get("f1")?.lastStatus === undefined, String(store.get("f1")?.lastStatus));
}

await rm(T, { recursive: true, force: true });

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
