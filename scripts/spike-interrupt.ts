/**
 * Q0 SPIKE (part 2) — manual, NOT in test:unit. Follow-up to
 * scripts/spike-busy-prompt.ts, which proved:
 *   - Q1: a prompt sent to a busy session is ACCEPTED and QUEUED
 *     (session inbox), then runs as a SEPARATE turn after the running one
 *     ends — both with no delivery field and with explicit delivery:"steer"
 *     on a single-generation text turn.
 * This script answers what was left:
 *
 *  Exp D — Q2 redo: interrupt is called while text is ACTUALLY streaming
 *     (timed off the session.text.started event, not off message.list which
 *     only shows completed messages). Does the partial reply survive?
 *  Exp E — steer at a STEP BOUNDARY: prompt 2 (default delivery) sent while
 *     a multi-step tool turn is between steps (after the first
 *     session.tool.success). Does it fold into the running turn or queue?
 *
 * LIVE service, throwaway sessions in /tmp/opencode/q0-spike2 only.
 * Costs ~2-3 real LLM turns. Cleans up after itself.
 *
 * Run:  npx tsx scripts/spike-interrupt.ts
 */
import { existsSync, mkdirSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { OpenCode } from "@opencode/client";
import { Service } from "@opencode/client/service";
import { newMessageID, assistantText } from "../src/opencode.js";

const DIR = "/tmp/opencode/q0-spike2";
const REPORT = "/tmp/opencode/q0-spike2-report.json";

const unwrap = (x: any) => (x && typeof x === "object" && "data" in x ? x.data : x);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const msgText = (m: any) => (m?.type === "user" ? String(m?.text ?? "") : assistantText(m));
const clip = (s: string, n = 300) => (s && s.length > n ? s.slice(0, n) + ` …(+${s.length - n} ch)` : s ?? "");

function errInfo(e: any) {
  return { name: e?.name, reason: e?.reason, status: e?.status, message: e?.message };
}

const T0 = Date.now();
const now = () => Date.now() - T0;

// ---------- events ----------
const events: Array<{ t: number; type: string; extra?: any }> = [];
const evAbort = new AbortController();
const waiters: Array<{ sid: string; type: string; resolve: (e: any) => void }> = [];

async function eventLoop(client: any) {
  try {
    const stream = client.event.subscribe({ signal: evAbort.signal }) as AsyncIterable<any>;
    for await (const ev of stream) {
      const type: string | undefined = ev?.type ?? ev?.data?.type;
      const d = ev?.data ?? {};
      const sid = d.sessionID ?? ev?.sessionID;
      if (!type) continue;
      const extra: any = {};
      if (d.inboxID) extra.inboxID = d.inboxID;
      if (d.delivery) extra.delivery = d.delivery;
      if (d.item?.delivery) extra.itemDelivery = d.item.delivery;
      if (d.requestID) extra.requestID = d.requestID;
      if (d.messageID) extra.messageID = d.messageID;
      if (sid) events.push({ t: now(), type, extra: { sid: String(sid).slice(0, 10), ...extra } });
      for (const w of [...waiters]) {
        if (w.sid === sid && (w.type === "*" || w.type === type)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(ev);
        }
      }
    }
  } catch {
    /* ended */
  }
}

function waitForEvent(sid: string, type: string, timeoutMs: number): Promise<any> {
  return new Promise((resolve) => {
    const to = setTimeout(() => {
      const i = waiters.findIndex((w) => w.sid === sid && w.type === type);
      if (i >= 0) waiters.splice(i, 1);
      resolve(undefined);
    }, timeoutMs);
    waiters.push({ sid, type, resolve: (e) => { clearTimeout(to); resolve(e); } });
  });
}

// ---------- helpers ----------
async function createSession(client: any, title: string): Promise<string> {
  const s = unwrap(await client.session.create({ location: { directory: DIR }, title }));
  if (!s?.id) throw new Error("session.create returned no id");
  return s.id as string;
}

async function removeSession(client: any, sid: string) {
  try {
    await client.session.remove({ sessionID: sid });
  } catch (e: any) {
    console.log(`  cleanup: remove ${sid.slice(0, 14)}… failed: ${e?.message ?? e}`);
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
    text: clip(msgText(m), 400),
    tools: (m?.content ?? []).filter((c: any) => c?.type === "tool").map((c: any) => c?.tool ?? c?.label),
    error: m?.error ? (typeof m.error === "string" ? m.error : m.error?.message) : undefined,
    outcome: m?.outcome,
  }));
}

async function waitForIdle(client: any, sid: string, timeoutMs = 90_000) {
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), timeoutMs);
  try {
    await client.session.wait({ sessionID: sid }, { signal: ac.signal });
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: { abortedByTimeout: ac.signal.aborted, ...errInfo(e) } };
  } finally {
    clearTimeout(to);
  }
}

const SLOW = "Hãy đếm từ 1 đến 20, mỗi số một dòng, kèm một câu giải thích ngắn cho mỗi số. Viết cẩn thận, đừng vội.";

// ---------- Exp D: interrupt while text is actually streaming ----------
async function expD(client: any) {
  console.log("\n=== D: interrupt mid-streaming (timed off session.text.started) ===");
  for (let attempt = 1; attempt <= 2; attempt++) {
    const sid = await createSession(client, `q0-spike2-D${attempt}`);
    console.log(`session: ${sid}`);
    const r: any = { name: `D${attempt}`, sessionID: sid, attempt };

    const evs: string[] = [];
    void (async () => {
      while (true) {
        const e = await waitForEvent(sid, "*", 120_000);
        if (!e) break;
        evs.push(`${e?.type ?? e?.data?.type}`);
      }
    })();

    await client.session.prompt({ sessionID: sid, id: newMessageID(), text: SLOW });
    console.log(`[+${now()}ms] slow prompt sent, waiting for session.text.started…`);
    const ts = await waitForEvent(sid, "session.text.started", 60_000);
    if (!ts) {
      r.error = "no session.text.started within 60s";
      console.log("  no text.started — aborting this attempt");
      await client.session.interrupt({ sessionID: sid }).catch(() => {});
      await removeSession(client, sid);
      continue;
    }
    r.textStartedAt = now();
    await sleep(1500); // let ~1s of text stream
    const tInt = now();
    let ir: any;
    try {
      ir = unwrap(await client.session.interrupt({ sessionID: sid }));
    } catch (e: any) {
      ir = errInfo(e);
    }
    r.interrupt = { at: tInt, afterTextStartedMs: tInt - r.textStartedAt, res: ir };
    console.log(`[+${tInt}ms] interrupt after ${(1500 / 1000).toFixed(1)}s of streaming →`, JSON.stringify(ir));

    if (ir?.interrupted !== true) {
      console.log("  interrupted !== true (turn already done?) — one retry with fresh turn");
      r.messages = await dumpMessages(client, sid);
      await removeSession(client, sid);
      continue;
    }

    const idle = await waitForIdle(client, sid);
    r.wait = idle;
    r.messages = await dumpMessages(client, sid);
    const s = unwrap(await client.session.get({ sessionID: sid }));
    r.session = { outcome: s?.outcome };
    r.events = events.filter((e) => e.extra?.sid === sid.slice(0, 10));
    return r;
  }
  return { name: "D", error: "both attempts failed" };
}

// ---------- Exp E: steer (default delivery) while a multi-step tool turn runs ----------
async function expE(client: any) {
  console.log("\n=== E: steer while multi-step tool turn is between steps ===");
  for (const [i, c] of ["one", "two", "three"].entries()) writeFileSync(`${DIR}/f${i + 1}.txt`, `file ${c}\n`);
  const sid = await createSession(client, "q0-spike2-E");
  console.log(`session: ${sid}`);
  const r: any = { name: "E", sessionID: sid };

  const p1 = await client.session.prompt({
    sessionID: sid,
    id: newMessageID(),
    text: "Hãy đọc file f1.txt (một thao tác), rồi đọc file f2.txt (một thao tác), rồi đọc file f3.txt (một thao tác). Mỗi file phải là một thao tác đọc riêng. Sau khi đọc hết 3 file, trả lời 1 dòng tổng kết ngắn.",
  });
  r.prompt1 = { at: now(), delivery: unwrap(p1)?.delivery };
  console.log(`[+${now()}ms] prompt1 sent (3 file reads), delivery=${r.prompt1.delivery ?? "-"}`);

  // wait until the turn is actually mid-tools (first tool.success) or 40s
  const toolEv = await waitForEvent(sid, "session.tool.success", 40_000);
  if (toolEv) console.log(`[+${now()}ms] first tool.success seen (turn is mid-tools)`);
  else console.log(`[+${now()}ms] no tool.success within 40s — sending steer anyway (turn may be blocked/single-step)`);

  // auto-allow any permission asks so the turn is not blocked (we test delivery, not permissions)
  void (async () => {
    while (true) {
      const e = await waitForEvent(sid, "permission.asked", 60_000);
      if (!e) break;
      const req = e?.data?.requestID ?? e?.requestID;
      console.log(`[+${now()}ms] permission.asked → auto-allow (once): ${req}`);
      if (req) await client.permission.reply({ sessionID: sid, requestID: req, decision: "once" }).catch((x: any) => console.log("  permission.reply failed:", x?.message));
    }
  })();

  await sleep(500); // make sure we are between steps, not right at a boundary
  const steer = unwrap(await client.session.prompt({
    sessionID: sid,
    id: newMessageID(),
    text: "ĐỪNG đọc file nào nữa. Trả lời đúng 1 dòng: BẠN ĐÃ DỪNG.",
  }));
  r.steer = { at: now(), delivery: steer?.delivery };
  console.log(`[+${now()}ms] steer sent, server delivery=${r.steer.delivery ?? "-"}`);

  const idle = await waitForIdle(client, sid, 120_000);
  r.wait = idle;
  if (!idle.ok) {
    console.log("  still not idle after 120s — interrupting");
    await client.session.interrupt({ sessionID: sid }).catch(() => {});
    await waitForIdle(client, sid, 30_000);
  }
  r.messages = await dumpMessages(client, sid);
  const s = unwrap(await client.session.get({ sessionID: sid }));
  r.session = { outcome: s?.outcome };
  r.events = events.filter((e) => e.extra?.sid === sid.slice(0, 10));
  r.filesAfter = readdirSync(DIR);

  // verdict from the event order: was the steer delivered BEFORE execution.succeeded of turn 1?
  const evs = r.events as Array<{ t: number; type: string; extra?: any }>;
  const execOk = evs.find((e) => e.type === "session.execution.succeeded");
  const steerEnq = evs.find((e) => e.type === "session.inbox.enqueued" && e.t > (r.steer.at - 2000));
  const steerDel = evs.find((e) => e.type === "session.inbox.delivered" && e.extra?.inboxID === steerEnq?.extra?.inboxID);
  r.verdictExtra = {
    steerEnqueuedAt: steerEnq?.t,
    steerDeliveredAt: steerDel?.t,
    executionSucceededAt: execOk?.t,
    deliveredBeforeTurn1Ended: steerDel?.t != null && execOk?.t != null ? steerDel.t < execOk.t : null,
  };
  const reads = r.messages.flatMap((m: any) => (m.tools ?? []).filter(Boolean));
  r.filesRead = reads;
  return r;
}

// ---------- main ----------
const ep = await Service.discover();
if (!ep?.url) throw new Error("Service.discover() returned no endpoint");
console.log(`service: ${ep.url}`);
const client = OpenCode.make({ baseUrl: ep.url, headers: Service.headers(ep) as Record<string, string> });
const info: any = unwrap(await client.server.info());
console.log(`server version: ${info?.version}`);

if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
void eventLoop(client);
await sleep(300);

const results: any[] = [];
results.push(await expD(client));
results.push(await expE(client));

events.sort((a, b) => a.t - b.t);
const report = { t0: new Date(T0).toISOString(), serverVersion: info?.version, results };
evAbort.abort();
for (const res of results) if (res?.sessionID) await removeSession(client, res.sessionID);
let dirRemoved = false;
try { rmSync(DIR, { recursive: true, force: true }); dirRemoved = true; } catch { /* ignore */ }
writeFileSync(REPORT, JSON.stringify(report, null, 2));
console.log(`\nreport: ${REPORT}, dir removed: ${dirRemoved}`);

console.log("\n=== SUMMARY ===");
for (const r of results) {
  console.log(`\n--- ${r.name} ---`);
  if (r.error) console.log(`ERROR: ${r.error}`);
  if (r.interrupt) console.log(`interrupt: +${r.interrupt.at}ms (after ${r.interrupt.afterTextStartedMs}ms of streaming) → ${JSON.stringify(r.interrupt.res)}`);
  if (r.session) console.log(`session outcome: ${r.session.outcome}`);
  if (r.messages) {
    for (const m of r.messages as any[]) {
      console.log(`  msg +${m.t}ms ${m.type} lines=${m.lines}${m.outcome ? ` outcome=${m.outcome}` : ""}${m.error ? ` ERROR=${clip(String(m.error), 120)}` : ""}${m.tools?.length ? ` tools=[${m.tools.join(",")}]` : ""}`);
      if (m.text) console.log(`    | ${clip(m.text, 260).split("\n").map((l: string) => "    | " + l).join("\n")}`);
    }
  }
  if (r.verdictExtra) console.log(`event order: ${JSON.stringify(r.verdictExtra)}`);
  if (r.filesRead) console.log(`files read: ${JSON.stringify(r.filesRead)}`);
  if (r.filesAfter) console.log(`files on disk: ${JSON.stringify(r.filesAfter)}`);
}
process.exit(0);
