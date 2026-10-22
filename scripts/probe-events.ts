/**
 * LIVE PROBE — captures what the running OpenCode service actually emits on
 * the event stream for one real tool-using turn. Answers:
 *   1. Is `session.tool.input.started` emitted for simple (non-streamed)
 *      tool calls? (the activity line needs it to learn tool names)
 *   2. Do `session.tool.called/success/failed` carry what the label needs?
 *   3. Are `session.text.delta` / `session.reasoning.delta` / `session.step.ended`
 *      emitted at all? (the Wave 2 streaming plan depends on them)
 *
 * It creates a throwaway session (title "tgbot-event-probe"), prompts it to
 * read a file (forcing tool calls), logs the event sequence, then deletes the
 * session. The session is not bound to any Telegram chat, so the bot ignores it.
 *
 * Run:  npx tsx scripts/probe-events.ts
 */
import { OpenCode } from "@opencode/client";
import { Service } from "@opencode/client/service";
import { newMessageID } from "../src/opencode.js";
import { resolve } from "node:path";

const KEEP_MS = 0; // 0 = delete the probe session afterwards

async function main() {
  const ep = await Service.discover();
  const client = OpenCode.make({ baseUrl: ep.url, headers: Service.headers(ep) as Record<string, string> });
  console.log(`Service: ${ep.url}`);

  const seen = new Map<string, number>(); // type -> count
  const interesting: Array<{ type: string; data: Record<string, unknown> }> = [];
  let done = false;

  const ctrl = new AbortController();
  const timer = setTimeout(() => {
    console.error("TIMEOUT — service stopped emitting; aborting.");
    ctrl.abort();
  }, 180_000);

  const stream = (client.event.subscribe({ signal: ctrl.signal }) as unknown) as AsyncIterable<any>;
  const pump = (async () => {
    for await (const ev of stream) {
      const t: string = ev?.type ?? "?";
      seen.set(t, (seen.get(t) ?? 0) + 1);
      const d = (ev?.data ?? {}) as Record<string, unknown>;
      if (
        t.startsWith("session.tool.") ||
        t.startsWith("session.shell.") ||
        t === "session.text.delta" ||
        t === "session.reasoning.delta" ||
        t === "session.step.ended" ||
        t.startsWith("session.execution.")
      ) {
        const slim: Record<string, unknown> = {};
        for (const k of ["sessionID", "id", "name", "input", "error", "cost", "tokens", "files", "delta", "text", "executed"]) {
          if (d[k] !== undefined) slim[k] = k === "delta" || k === "text" ? String(d[k]).slice(0, 60) : d[k];
        }
        interesting.push({ type: t, data: slim });
        if (t.startsWith("session.execution.") && t !== "session.execution.started") done = true;
      }
      if (done) break;
    }
  })();

  const directory = resolve(import.meta.dirname, "..");
  const s = (await client.session.create({ location: { directory }, title: "tgbot-event-probe", agent: "build" })) as any;
  const sessionID: string = s?.data?.id ?? s?.id;
  console.log(`Probe session: ${sessionID}`);

  await client.session.prompt({
    sessionID,
    id: newMessageID(),
    text: "Dùng tool `read` đọc file src/activity.ts, rồi trả lời MỘT câu ngắn: export hàm nào? Không dùng tool nào khác.",
  });

  await pump;
  clearTimeout(timer);

  console.log("\n=== Event counts ===");
  for (const [t, n] of [...seen.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${t}`);
  console.log("\n=== Interesting events (slim) ===");
  for (const e of interesting) {
    console.log(`  ${e.type}: ${JSON.stringify(e.data).slice(0, 220)}`);
  }
  if (KEEP_MS === 0) {
    await client.session.remove({ sessionID }).catch(() => {});
    console.log("\nProbe session deleted.");
  }
}

main().catch((e) => {
  console.error("PROBE FAILED:", e);
  process.exit(1);
});
