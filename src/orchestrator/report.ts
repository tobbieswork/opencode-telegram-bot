import type { ConvKey } from "../conv.js";
import { warn } from "../logger.js";
import type { Orchestrator } from "../orchestrator.js";

/** Worker reports arriving within this window reach the Manager as one message. */
export const REPORT_DEBOUNCE_MS = 4000;

/** Batch worker reports and feed them to the Manager as one "[Bot event]" message. */
export function queueReport(o: Orchestrator, chat: ConvKey, report: string): void {
  const list = o.reports.get(chat) ?? [];
  list.push(report);
  o.reports.set(chat, list);
  if (o.reportTimers.has(chat)) return;
  const t = setTimeout(() => {
    o.reportTimers.delete(chat);
    const batch = o.reports.get(chat) ?? [];
    o.reports.delete(chat);
    void notifyManager(o, chat, batch.join("\n\n")).catch((e) => warn("notify manager:", e?.message));
  }, REPORT_DEBOUNCE_MS);
  (t as any).unref?.();
  o.reportTimers.set(chat, t);
}

export async function notifyManager(o: Orchestrator, chat: ConvKey, body: string): Promise<void> {
  const sid = o.h.st.peek(chat)?.manager ? o.h.st.peek(chat)?.sessionID : undefined;
  if (!sid || !body) return;
  await o.h.oc.prompt(sid, `[Bot event — not from the user]\n${body}`);
  o.h.startTyping(chat);
}
