/**
 * Q0 SPIKE — manual experiment (NOT in test:unit). Answers the gate
 * questions for docs/sdd/queue-and-steer.md:
 *
 *  Q1: a prompt sent to a session whose turn is RUNNING — error, queued,
 *      or folded into the running turn?
 *      Exp A: no `delivery` field (what the bot's oc.prompt() sends today)
 *      Exp B: explicit `delivery: "steer"` (the S-native candidate)
 *  Q2: does session.interrupt keep the partial reply? (Exp C)
 *
 * Runs against the LIVE OpenCode service (Service.discover, same as the
 * bot), using throwaway sessions in /tmp/opencode/q0-spike only. Never
 * touches real sessions. Cleans up its sessions and directory on exit.
 * Costs 3-5 real LLM prompts.
 *
 * Run:  npx tsx scripts/spike-busy-prompt.ts
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { OpenCode } from "@opencode/client";
import { Service } from "@opencode/client/service";
import { newMessageID, assistantText } from "../src/opencode.js";

const DIR = "/tmp/opencode/q0-spike";
const REPORT = "/tmp/opencode/q0-spike-report.json";
const WAIT_TIMEOUT_MS = 300_000;

const unwrap = (x: any) => (x && typeof x === "object" && "data" in x ? x.data : x);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const msgText = (m: any) => (m?.type === "user" ? String(m?.text ?? "") : assistantText(m));
const clip = (s: string, n = 320) => (s && s.length > n ? s.slice(0, n) + ` …(+${s.length - n} ch)` : s ?? "");

function errInfo(e: any) {
  return {
    name: e?.name,
    reason: e?.reason,
    status: e?.status,
    message: e?.message,
    detail: typeof e?.detail === "string" ? clip(e.detail, 500) : e?.detail,
  };
}

const T0 = Date.now();
const now = () => Date.now() - T0;

// ---------- event timeline (global subscription, filtered to our sessions) ----------
const ourSessions = new Set<string>();
const events: Array<{ t: number; type: string; extra?: any }> = [];
const evAbort = new AbortController();

async function eventLoop(client: any) {
  try {
    const stream = client.event.subscribe({ signal: evAbort.signal }) as AsyncIterable<any>;
    for await (const ev of stream) {
      const type: string | undefined = ev?.type ?? ev?.data?.type;
      const d = ev?.data ?? {};
      const sid = d.sessionID ?? ev?.sessionID;
      if (!type || !ourSessions.has(sid)) continue;
      const extra: any = {};
      if (d.inboxID) extra.inboxID = d.inboxID;
      if (d.delivery) extra.delivery = d.delivery;
      if (d.item?.delivery) extra.itemDelivery = d.item.delivery;
      if (d.id) extra.id = d.id;
      events.push({ t: now(), type, extra: Object.keys(extra).length ? extra : undefined });
    }
  } catch {
    /* subscription ended (we aborted it) */
  }
}

// ---------- helpers ----------
async function createSession(client: any, title: string): Promise<string> {
  const s = unwrap(await client.session.create({ location: { directory: DIR }, title }));
  const id = s?.id;
  if (!id) throw new Error("session.create returned no id");
  ourSessions.add(id);
  return id;
}

async function removeSession(client: any, sid: string) {
  try {
    await client.session.remove({ sessionID: sid });
    return true;
  } catch (e: any) {
    console.log(`  cleanup: remove ${sid.slice(0, 14)}… failed: ${e?.message ?? e}`);
    return false;
  }
}

async function dumpMessages(client: any, sid: string) {
  const raw = unwrap(await client.message.list({ sessionID: sid, limit: 200 })) ?? [];
  const msgs = [...raw].sort((a: any, b: any) => (a?.time?.created ?? 0) - (b?.time?.created ?? 0));
  return msgs.map((m: any) => ({
    id: m?.id,
    type: m?.type,
    t: (m?.time?.created ?? 0) - T0,
    lines: msgText(m) ? msgText(m).split("\n").length : 0,
    text: clip(msgText(m)),
    error: m?.error ? (typeof m.error === "string" ? m.error : m.error?.message) : undefined,
    outcome: m?.outcome,
  }));
}

async function waitForIdle(client: any, sid: string): Promise<{ ok: boolean; error?: any }> {
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), WAIT_TIMEOUT_MS);
  try {
    await client.session.wait({ sessionID: sid }, { signal: ac.signal });
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: { abortedByTimeout: ac.signal.aborted, ...errInfo(e) } };
  } finally {
    clearTimeout(to);
  }
}

/** Poll until the session has an assistant message with text (partial output). */
async function waitForPartialText(client: any, sid: string, maxMs = 40_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const msgs = (unwrap(await client.message.list({ sessionID: sid, limit: 50 })) ?? []) as any[];
    const ast = msgs
      .filter((m: any) => m?.type === "assistant" && msgText(m))
      .sort((a: any, b: any) => (b?.time?.created ?? 0) - (a?.time?.created ?? 0));
    if (ast[0]) return { text: msgText(ast[0]), msgId: ast[0].id, t: (ast[0].time?.created ?? 0) - T0 };
    await sleep(700);
  }
  return undefined;
}

// ---------- experiment ----------
interface ExpSpec {
  name: string;
  slow: string;
  fast?: string;
  delivery?: "steer" | "queue";
  interrupt?: boolean;
}

async function runExp(client: any, exp: ExpSpec, sessionTitle: string) {
  console.log(`\n=== ${exp.name} ===`);
  const sid = await createSession(client, sessionTitle);
  console.log(`session: ${sid}`);
  const r: any = { name: exp.name, sessionID: sid };

  // prompt 1 (slow turn)
  const id1 = newMessageID();
  const tP1 = now();
  try {
    const res = unwrap(await client.session.prompt({ sessionID: sid, id: id1, text: exp.slow }));
    r.prompt1 = { at: tP1, ok: true, inboxID: res?.id, delivery: res?.delivery };
    console.log(`[+${tP1}ms] prompt1 sent (id ${id1}), accepted, delivery=${res?.delivery ?? "-"}`);
  } catch (e: any) {
    r.prompt1 = { at: tP1, ok: false, err: errInfo(e) };
    console.log(`[+${tP1}ms] prompt1 REJECTED:`, JSON.stringify(errInfo(e)));
    return r;
  }

  if (exp.interrupt) {
    // Exp C: wait for partial output, then interrupt
    const p = await waitForPartialText(client, sid);
    if (!p) {
      r.interrupt = { at: now(), error: "no partial text appeared within 40s" };
      console.log("  no partial text seen within 40s; aborting interrupt exp");
      return r;
    }
    r.partialBeforeInterrupt = { at: p.t, lines: p.text.split("\n").length, text: clip(p.text, 500) };
    console.log(`[+${now()}ms] partial output visible (${p.text.split("\n").length} lines so far), interrupting…`);
    const tInt = now();
    let ir: any;
    try {
      ir = { ok: true, res: unwrap(await client.session.interrupt({ sessionID: sid })) };
    } catch (e: any) {
      ir = { ok: false, err: errInfo(e) };
    }
    r.interrupt = { at: tInt, ...ir };
    console.log(`[+${now()}ms] interrupt result:`, JSON.stringify(ir));
    const idle = await waitForIdle(client, sid);
    r.wait = idle;
    r.messages = await dumpMessages(client, sid);
    const s = unwrap(await client.session.get({ sessionID: sid }));
    r.session = { outcome: s?.outcome, tokens: s?.tokens };
    return r;
  }

  // Exps A/B: let the turn run a few seconds, then send prompt 2
  await sleep(3500);
  const id2 = newMessageID();
  const tP2 = now();
  const input: any = { sessionID: sid, id: id2, text: exp.fast! };
  if (exp.delivery) input.delivery = exp.delivery;
  let p2: { ok: boolean; res?: any; err?: any };
  try {
    const res = unwrap(await client.session.prompt(input));
    p2 = { ok: true, res: { inboxID: res?.id, delivery: res?.delivery } };
  } catch (e: any) {
    p2 = { ok: false, err: errInfo(e) };
  }
  r.prompt2 = { at: tP2, requestedDelivery: exp.delivery ?? null, ...p2 };
  console.log(
    p2.ok
      ? `[+${tP2}ms] prompt2 accepted, server delivery=${p2.res?.delivery ?? "-"}`
      : `[+${tP2}ms] prompt2 REJECTED: ${JSON.stringify(p2.err)}`,
  );

  const idle = await waitForIdle(client, sid);
  r.wait = idle;
  r.messages = await dumpMessages(client, sid);
  const s = unwrap(await client.session.get({ sessionID: sid }));
  r.session = { outcome: s?.outcome, tokens: s?.tokens };

  // heuristic verdict (raw data above is authoritative)
  const msgs = r.messages as any[];
  const ast = msgs.filter((m: any) => m.type === "assistant" && m.lines > 0);
  const users = msgs.filter((m: any) => m.type === "user");
  if (!p2.ok) r.verdict = "ERROR (prompt2 rejected)";
  else if (ast.length >= 2) r.verdict = "QUEUED (two separate assistant turns)";
  else if (ast.length === 1) r.verdict = "FOLDED? (single assistant turn for both prompts)";
  else r.verdict = "NO ASSISTANT OUTPUT";
  r.verdictExtra = { userMessages: users.length, assistantMessagesWithText: ast.length };
  console.log(`  verdict: ${r.verdict} (users=${users.length}, assistants=${ast.length})`);
  return r;
}

// ---------- main ----------
const ep = await Service.discover();
if (!ep?.url) throw new Error("Service.discover() returned no endpoint");
console.log(`service: ${ep.url}`);
const client = OpenCode.make({ baseUrl: ep.url, headers: Service.headers(ep) as Record<string, string> });
const info: any = unwrap(await client.server.info());
console.log(`server version: ${info?.version}`);

mkdirSync(DIR, { recursive: true });
void eventLoop(client);
await sleep(300); // let the event subscription arm

const results: any[] = [];

// Exp A — Q1: prompt 2 while busy, NO delivery field (bot's current behaviour)
results.push(
  await runExp(
    client,
    {
      name: "A: busy prompt, no delivery field",
      slow: "Hãy đếm từ 1 đến 20, mỗi số một dòng, kèm một câu giải thích ngắn cho mỗi số. Viết cẩn thận, đừng vội.",
      fast: "DỪNG ĐẾM NGAY. Trả lời đúng một dòng, chỉ cần số: 1+1 bằng mấy?",
    },
    "q0-spike-A",
  ),
);

// Exp B — Q1: prompt 2 while busy with explicit delivery: "steer" (S-native candidate)
results.push(
  await runExp(
    client,
    {
      name: "B: busy prompt, delivery=steer",
      slow: "Hãy đếm từ 1 đến 15, mỗi số một dòng, kèm một câu giải thích ngắn cho mỗi số. Viết cẩn thận.",
      fast: "ĐỪNG ĐẾM. Trả lời đúng một dòng, chỉ cần số: 2+2 bằng mấy?",
      delivery: "steer",
    },
    "q0-spike-B",
  ),
);

// Exp C — Q2: interrupt mid-turn, is the partial reply kept?
results.push(
  await runExp(
    client,
    {
      name: "C: interrupt mid-turn",
      slow: "Hãy đếm từ 1 đến 20, mỗi số một dòng, kèm một câu giải thích ngắn cho mỗi số. Viết cẩn thận, đừng vội.",
      interrupt: true,
    },
    "q0-spike-C",
  ),
);

// ---------- finish ----------
events.sort((a, b) => a.t - b.t);
const report = {
  t0: new Date(T0).toISOString(),
  serverVersion: info?.version,
  events,
  results,
};
evAbort.abort();

// cleanup
for (const res of results) {
  if (res?.sessionID) await removeSession(client, res.sessionID);
}
let dirRemoved = false;
try {
  rmSync(DIR, { recursive: true, force: true });
  dirRemoved = true;
} catch {
  /* ignore */
}

writeFileSync(REPORT, JSON.stringify(report, null, 2));
console.log(`\nreport written: ${REPORT}`);
console.log(`dir removed: ${dirRemoved}`);
console.log("\n=== SUMMARY ===");
for (const r of results) {
  console.log(`\n--- ${r.name} ---`);
  if (r.verdict) console.log(`verdict: ${r.verdict}`);
  if (r.prompt1) console.log(`prompt1: ${r.prompt1.ok ? `accepted at +${r.prompt1.at}ms delivery=${r.prompt1.delivery ?? "-"}` : "REJECTED " + JSON.stringify(r.prompt1.err)}`);
  if (r.prompt2) console.log(`prompt2: ${r.prompt2.ok ? `accepted at +${r.prompt2.at}ms serverDelivery=${r.prompt2.res?.delivery ?? "-"}` : "REJECTED " + JSON.stringify(r.prompt2.err)}`);
  if (r.partialBeforeInterrupt) console.log(`partial before interrupt: ${r.partialBeforeInterrupt.lines} lines`);
  if (r.interrupt) console.log(`interrupt: ${JSON.stringify(r.interrupt).slice(0, 300)}`);
  if (r.messages) {
    for (const m of r.messages as any[]) {
      console.log(`  msg +${m.t}ms ${m.type} lines=${m.lines}${m.outcome ? ` outcome=${m.outcome}` : ""}${m.error ? ` ERROR=${m.error}` : ""}`);
      if (m.text) console.log(`    | ${clip(m.text, 200).split("\n").map((l: string) => "    | " + l).join("\n")}`);
    }
  }
  if (r.session) console.log(`session outcome: ${r.session.outcome}`);
}
process.exit(0);
