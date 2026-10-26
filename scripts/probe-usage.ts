/**
 * LIVE PROBE — read-only checks against the running OpenCode service that
 * `/usage` depends on:
 *   1. ORDER of `message.list`: it finds an existing session with >=2
 *      assistant steps and prints the first 5 messages' time.created in
 *      array order, so we can see whether the API returns newest-first or
 *      oldest-first (the code must not trust either — but the docs in
 *      opencode.ts say newest-first and this proves it live).
 *   2. TOKEN SHAPE of an assistant message: it prints the full `tokens`
 *      object of the newest assistant step so the context formula in
 *      usage.ts (input + cache.read + cache.write) matches the real field
 *      names.
 *
 * Read-only: it lists sessions and messages, creates/deletes nothing.
 *
 * Run:  npx tsx scripts/probe-usage.ts
 */
import { OpenCode } from "@opencode/client";
import { Service } from "@opencode/client/service";

function unwrap(x: any): any {
  return x && typeof x === "object" && "data" in x ? x.data : x;
}

async function main() {
  const ep = await Service.discover();
  const client = OpenCode.make({ baseUrl: ep.url, headers: Service.headers(ep) as Record<string, string> });
  console.log(`Service: ${ep.url}\n`);

  const sessions: any[] = unwrap((await (client.session.list() as any)) ?? []) ?? [];
  const sids = sessions.map((s: any) => s.id).filter(Boolean);
  console.log(`sessions on service: ${sids.length}`);

  // Find a session with >=2 assistant messages (read-only scan).
  let target: { sid: string; msgs: any[] } | undefined;
  for (const sid of sids) {
    const msgs: any[] = unwrap((await (client.message.list({ sessionID: sid, limit: 50 }) as any)) ?? []) ?? [];
    const asst = msgs.filter((m: any) => m?.info?.type === "assistant" || m?.type === "assistant");
    if (asst.length >= 2) {
      target = { sid, msgs };
      console.log(`\ntarget session: ${sid} (${asst.length} assistant msgs in first 50)`);
      break;
    }
  }
  if (!target) {
    console.error("NO session with >=2 assistant messages found — cannot probe ordering.");
    process.exit(2);
  }

  const { sid, msgs } = target;

  // ── 1. Ordering: print the first 5 messages' time.created in array order ──
  console.log("\nmessage.list order (array position → time.created):");
  let nonMonotonic = 0;
  const created = (m: any) => m?.info?.time?.created ?? m?.time?.created ?? 0;
  for (let i = 0; i < Math.min(5, msgs.length); i++) {
    const m = msgs[i];
    const t = created(m);
    const date = t ? new Date(t).toISOString() : "(no time)";
    console.log(`  [${i}] ${m?.info?.type ?? m?.type ?? "?"}  created=${t}  (${date})`);
    if (i > 0 && t > created(msgs[i - 1])) nonMonotonic++;
  }
  const first = created(msgs[0]);
  const last = created(msgs[msgs.length - 1]);
  const newestFirst = first > last;
  console.log(
    newestFirst
      ? `  → first (${first}) is NEWER than last (${last}): list is NEWEST-FIRST`
      : `  → first (${first}) is OLDER than last (${last}): list is OLDEST-FIRST`,
  );
  if (newestFirst && nonMonotonic > 0)
    console.error(`  ⚠️ but ${nonMonotonic} adjacent pairs are not strictly descending — order is not a clean sort`);

  // ── 2. Token shape of the newest assistant messages ───────────────────────
  const asst = msgs
    .filter((m: any) => m?.info?.type === "assistant" || m?.type === "assistant")
    .sort((a: any, b: any) => created(b) - created(a));
  console.log("\nassistant token shapes (newest first, full `tokens` object):");
  for (const m of asst.slice(0, 3)) {
    const info = m.info ?? m;
    console.log(`  msg ${m.id}`);
    console.log(`    model: ${JSON.stringify(info.model)}`);
    console.log(`    tokens: ${JSON.stringify(info.tokens ?? m.tokens)}`);
  }
}

main().catch((e) => {
  console.error("probe failed:", e);
  process.exit(1);
});
