/**
 * Reproduction + probe for the "question tool" flow over the OpenCode client.
 *
 * Goals:
 *  1. Does a `question` tool call surface as a *form* that a remote client can see?
 *  2. Does `client.event.subscribe()` emit `form.created`?
 *  3. Can we answer it with `client.session.form.reply` and get the session back to idle?
 *
 * Run:  npx tsx scripts/test-question.ts
 */
import { OpenCode } from "@opencode/client";
import { Service } from "@opencode/client/service";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";

const S = (m: string) => console.log(`[test] ${m}`);

async function main() {
  let ep: any;
  try {
    ep = await Service.discover();
  } catch {
    ep = await Service.ensure();
  }
  const client = OpenCode.make({ baseUrl: ep.url, headers: Service.headers(ep) as any });
  const info = (await client.server.info()) as any;
  const version = (info?.data ?? info)?.version;
  S(`url=${ep.url} version=${version}`);

  const dir = mkdtempSync(join("/tmp/opencode", "qtest-"));
  S(`dir=${dir}`);

  const sess = (await client.session.create({ location: { directory: dir } })) as any;
  const sessionID = (sess?.data?.id ?? sess?.id) as string;
  S(`session=${sessionID}`);

  // --- event subscription (must start BEFORE prompting) ---
  let eventsCount = 0;
  let formCreatedEvent: any = null;
  const ev = client.event.subscribe() as AsyncIterable<any>;
  const evTask = (async () => {
    for await (const e of ev) {
      eventsCount++;
      const t = e?.type;
      if (
        t === "form.created" ||
        t === "form.replied" ||
        t === "form.cancelled" ||
        t === "session.idle" ||
        t === "session.status.updated"
      ) {
        S(`EVENT ${t}: ${JSON.stringify(e.data ?? e).slice(0, 400)}`);
        if (t === "form.created") formCreatedEvent = e;
      }
    }
  })().catch((err: any) => S(`event loop error: ${err?.message ?? err}`));

  // --- prompt the agent to ask exactly one multiple-choice question ---
  S("prompting agent to ask ONE multiple-choice question via the `question` tool...");
  await client.session.prompt({
    sessionID,
    text:
      "Use the `question` tool to ask me EXACTLY ONE multiple-choice question: " +
      "header 'Color', question 'Which color do you prefer?', with options: Red, Blue, Green. " +
      "Ask ONLY that one question and do nothing else.",
  });

  // --- poll for a pending form ---
  const t0 = Date.now();
  let forms: any[] = [];
  while (Date.now() - t0 < 60_000) {
    const raw = (await client.session.form.list({ sessionID }).catch(() => [])) as any;
    forms = (raw?.data ?? raw) as any[];
    if (Array.isArray(forms) && forms.length) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  S(`forms after ${((Date.now() - t0) / 1000).toFixed(1)}s: ${JSON.stringify(forms).slice(0, 2000)}`);

  if (!forms?.length) {
    S("!! NO FORM FOUND — the question did NOT surface as a pending form (likely auto-cancelled as non-interactive).");
  } else {
    const form = forms[0];
    const formID = form.id as string;
    S(`form=${formID} title=${form.title} metadata=${JSON.stringify(form.metadata)} state=${JSON.stringify(form.state)}`);
    S(`fields=${JSON.stringify(form.fields)}`);

    const answer: Record<string, any> = {};
    for (const f of form.fields ?? []) {
      if (f.hidden) continue;
      if (Array.isArray(f.options) && f.options.length) answer[f.key] = f.options[0].value;
      else if (f.type === "boolean") answer[f.key] = true;
      else if (f.type === "number" || f.type === "integer") answer[f.key] = 1;
      else if (f.type === "multiselect") answer[f.key] = f.options?.[0] ? [f.options[0].value] : [];
      else if (f.type === "string") answer[f.key] = "blue";
    }
    S(`answering with: ${JSON.stringify(answer)}`);
    await client.session.form.reply({ sessionID, formID, answer });
    S("form.reply sent");
  }

  // --- wait for idle (bounded) ---
  S("waiting for idle (max 90s)...");
  try {
    await client.session.wait({ sessionID }, { signal: AbortSignal.timeout(90_000) });
    S("session idle reached");
  } catch (e: any) {
    S(`wait ended: name=${e?.name} msg=${e?.message ?? e}`);
  }

  // --- read the final assistant message ---
  const msgs = (await client.message.list({ sessionID }).catch(() => [])) as any;
  const arr = (msgs?.data ?? msgs) as any[];
  let last = "";
  for (const m of arr) {
    if (m?.type === "assistant") {
      const t = (m.content ?? [])
        .filter((c: any) => c?.type === "text")
        .map((c: any) => c.text)
        .join("\n");
      if (t) last = t;
    }
  }
  S(`final assistant reply:\n${last}`);
  S(`total events observed: ${eventsCount}; formCreatedEvent=${formCreatedEvent ? "yes" : "no"}`);
}

main()
  .then(() => {
    S("DONE");
    process.exit(0);
  })
  .catch((e) => {
    console.error("[test] FATAL", e);
    process.exit(1);
  });
