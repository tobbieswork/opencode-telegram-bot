/**
 * LIVE PROBE — renders the NEW /usage report (liveness-aware: active-first,
 * dead collapsed into one line, --all lists everything) against the running
 * OpenCode service, so we can eyeball the real shape before merge.
 *
 * Read-only: lists sessions + messages, creates nothing.
 *
 * Run:  npx tsx scripts/probe-usage.ts
 */
import { OpenCode } from "@opencode/client";
import { Service } from "@opencode/client/service";
import { UsageRow, formatUsageReport, newestAssistantInfo } from "../src/usage.js";

function unwrap(x: any): any {
  return x && typeof x === "object" && "data" in x ? x.data : x;
}
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const plain = (l: string) => l.replace(/<[^>]+>/g, "");

async function main() {
  const ep = await Service.discover();
  const client = OpenCode.make({ baseUrl: ep.url, headers: Service.headers(ep) as Record<string, string> });
  console.log(`Service: ${ep.url}\n`);

  const sessions: any[] = unwrap((await (client.session.list() as any)) ?? []) ?? [];
  const rows: UsageRow[] = [];
  for (const s of sessions.slice(0, 15)) {
    const sid = s.id as string;
    let msgs: any[] = [];
    try {
      msgs = unwrap((await (client.message.list({ sessionID: sid, limit: 200 }) as any)) ?? []) ?? [];
    } catch {}
    const info = newestAssistantInfo(msgs);
    rows.push({
      label: sid.slice(0, 14),
      id: sid,
      current: info.context,
      limit: 200_000,
      cumInput: s?.tokens?.input ?? 0,
      cumOutput: s?.tokens?.output ?? 0,
      updated: s?.time?.updated,
    });
  }
  console.log(`rendered ${rows.length} session(s)\n`);
  console.log("=== DEFAULT (active first, dead collapsed) ===");
  console.log(formatUsageReport(rows, esc, { now: Date.now() }).map(plain).join("\n"));
  console.log("\n=== --all (every session, dead prefixed 💤) ===");
  console.log(formatUsageReport(rows, esc, { now: Date.now(), all: true }).map(plain).join("\n"));
}

main().catch((e) => {
  console.error("probe failed:", e);
  process.exit(1);
});
