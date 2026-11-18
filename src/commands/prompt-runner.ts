/**
 * The turn engine (prompt-runner) — the long-running prompt task, the inflight
 * guard, the queue drain, the graceful-shutdown drain, and the shared stop
 * (docs/sdd/split-bot-ts.md, T6 — the "prompt-runner" feature module).
 *
 * Moved out of bot.ts verbatim (a move, not a rewrite): `this.<member>` became
 * `ctx.<member>`. The feature talks to the bot only through the narrow `BotCtx`
 * interface; `Bot` satisfies it structurally, so behaviour is unchanged and the
 * `Bot` class keeps thin delegates so existing callers/tests are untouched.
 * The per-conv turn state (inflight, queue, busyNotes, drafts, turnGen, …) is
 * owned by Bot and shared across features; this module reaches it via `ctx`.
 */
import type { BotCtx } from "./ctx.js";
import type { ConvKey } from "../conv.js";
import type { ChatState, Lang } from "../state.js";
import { tr } from "../i18n.js";
import { log, warn, error } from "../logger.js";
import { audit } from "../audit.js";
import { buildBusyReply, busyKeyboard, queueFullReply } from "../busy.js";
import type { BusyReply } from "../busy.js";
import { applyLanguagePin, LANGUAGE_INSTRUCTION_KEY, LANGUAGE_INSTRUCTION } from "../language.js";
import { applySuggestPin } from "../suggest.js";
import { applyStylePin } from "../style.js";
import { QUESTIONS_PREAMBLE } from "../shared.js";
import { newMessageID, isTransportError } from "../opencode.js";
import { esc, stripTags, formatTurnFailure } from "../format.js";
import { extractOptionsMarker } from "../choices.js";
import { REACTION_FAIL } from "../reactions.js";
import { prepareNotesTurn } from "./notes.js";


/** Shown on a live stream preview while the bot drains at shutdown. */
const DRAIN_PREVIEW_TEXT = "⏳ Đang khởi động lại… kết quả sẽ gửi sau.";


/**
 * Core of the graceful-shutdown drain, split out so it can be unit-tested with
 * fake promises (no bot, no Telegram, no systemd).
 *
 * Polls `isBusy` until it reports idle, or until `timeoutMs` elapses —
 * whichever comes first. Work that appears WHILE the drain is running (e.g. a
 * final-reply sweep spawned by the very turn that just ended) is picked up on
 * the next poll, so the drain never returns while registered work is pending.
 *
 * @returns true when everything settled before the cap, false when the cap
 *          elapsed first. The caller must exit either way — the cap is the
 *          guarantee that the drain never blocks forever.
 */
export async function drainInflightCore(opts: {
/** True while in-flight work that must finish before exit remains. */
isBusy: () => boolean;
/** Hard cap for the whole wait. */
timeoutMs: number;
/** Poll interval (default 100ms). */
pollMs?: number;
}): Promise<boolean> {
const pollMs = opts.pollMs ?? 100;
const deadline = Date.now() + opts.timeoutMs;
for (;;) {
  if (!opts.isBusy()) return true;
  if (Date.now() >= deadline) return false;
  await new Promise((r) => setTimeout(r, Math.min(pollMs, deadline - Date.now())));
}
}


export function trackPending(ctx: BotCtx, p: Promise<void>): void {
  ctx.pendingSends.add(p);
  void p.finally(() => ctx.pendingSends.delete(p));
}


export async function drainInflight(ctx: BotCtx, opts: { timeoutMs: number }): Promise<boolean> {
  ctx.draining = true; // pause preview pushes so the notice isn't overwritten
  ctx.stopAllWatches(); // W5.1: stop the live cards (in-memory cleanup + audit — Telegram is stopped after)
  ctx.notifyQueuedNotRunning(); // Q1.8: queued turns won't start — tell the chats now
  const edits: Promise<unknown>[] = [];
  for (const [conv, w] of ctx.drafts) {
    if (w.previewMsgId && w.previewMsgId !== 0) {
      edits.push(
        ctx.tg
          .editMessageText(conv, w.previewMsgId, tr(ctx.userPrefs.getLang(ctx.st.peek(conv)?.createdBy ?? ""), DRAIN_PREVIEW_TEXT, "⏳ Restarting… the result will be sent after."), { parse_mode: undefined })
          .catch(() => {}),
      );
    }
  }
  if (edits.length) {
    // Bound the notice phase itself: a hung Telegram call must not eat the cap.
    await Promise.race([Promise.allSettled(edits), new Promise((r) => setTimeout(r, 5_000))]);
  }
  return drainInflightCore({
    timeoutMs: opts.timeoutMs,
    isBusy: () => ctx.inflight.size > 0 || ctx.orch.managerInflight || ctx.pendingSends.size > 0,
  });
}


export function notifyQueuedNotRunning(ctx: BotCtx): void {
  for (const [conv] of Object.entries(ctx.st.all())) {
    const n = ctx.queue.size(conv);
    if (n <= 0) continue;
    audit({ action: "queue_drop", chatId: conv, meta: { count: n, reason: "shutdown" } });
    const lang = ctx.userPrefs.getLang(ctx.st.peek(conv)?.createdBy ?? "");
    void ctx.tg
      .sendMessage(conv, tr(lang, `⚠️ Bot đang tắt — ${n} tin trong hàng chờ sẽ không chạy.`, `⚠️ Bot is shutting down — ${n} queued message(s) will not run.`))
      .catch(() => {});
  }
}


export async function runPrompt(ctx: BotCtx, conv: ConvKey, text: string, state: ChatState, userMsgId?: number, lang?: Lang): Promise<{ busy: boolean }> {
  // A closed worker topic reopens itself when the user speaks in it
  // (openForumTopic is a no-op on an already-open topic, so safe every time).
  if (state.worker) void ctx.tg.openForumTopic(conv).catch(() => {});
  if (ctx.inflight.has(conv)) {
    // Busy reply per config.busyMode (ask / queue / off — see src/busy.ts).
    // In "queue" mode the message is auto-enqueued on arrival (no tap); in
    // "off" the reply is byte-identical to the pre-queue behaviour.
    const busyLang = lang ?? "vi";
    let reply: BusyReply;
    if (ctx.cfg.busyMode === "queue" && userMsgId != null) {
      const r = ctx.queue.push(conv, { text, senderId: state.createdBy != null ? String(state.createdBy) : undefined });
      if (r.ok) audit({ action: "queue_add", chatId: conv, userId: state.createdBy != null ? String(state.createdBy) : undefined, meta: { messageId: userMsgId, textLen: text.length, queuedCount: r.position, auto: true } });
      reply = r.ok
        ? buildBusyReply({ lang: busyLang, mode: "queue", messageId: userMsgId, queuedCount: r.position })
        : queueFullReply({ lang: busyLang, messageId: userMsgId });
    } else {
      reply = buildBusyReply({ lang: busyLang, mode: ctx.cfg.busyMode, messageId: userMsgId, canSteer: true });
    }
    const kb = busyKeyboard(reply.buttons);
    await ctx.tg.sendMessage(conv, reply.text, kb ? { reply_markup: kb } : undefined);
    // Retain the dropped message's text so a tap (Queue / Steer now / note)
    // can fetch it from the busy-note store by the user message's id.
    if (userMsgId != null) ctx.busyNotes.push(conv, userMsgId, text);
    return { busy: true };
  }

  // Keep the "typing…" indicator alive for the whole turn (until the reply is sent).
  ctx.startTyping(conv);
  ctx.startWorking(conv, lang); // "⏳ Đang xử lý…" — General top-level only (native typing doesn't render there)
  try {
    let sid = state.sessionID;
    if (!sid) {
      sid = await ctx.oc.createSession(state.directory || ctx.cfg.opencodeDirectory);
      await ctx.applyModelAndVariant(sid, state);
      if (state.agent) await ctx.oc.setAgent(sid, state.agent).catch((e) => warn("setAgent:", e?.message));
      ctx.st.set(conv, { sessionID: sid });
    }
    // Per-user language preference: pin the session to English when the user
    // chose "en" ("vi"/unset clears it). Idempotent and self-tracked per session,
    // so a fresh session after /new, /use, or rotation re-applies on its prompt.
    await applyLanguagePin(ctx.oc, ctx.st, conv, sid, lang);
    // Quick replies (R2): pin the [OPTIONS] instruction when enabled; idempotent + self-tracked.
    await applySuggestPin(ctx.oc, ctx.st, conv, sid, ctx.cfg.suggest);
    // Per-user output style: pin the style instruction when set ("default" = no pin); idempotent + self-tracked.
    // uid source: the conv's last driver (createdBy, set from the sender uid on every user message) —
    // the same resolution the orchestrator uses for the Manager pin.
    await applyStylePin(ctx.oc, ctx.st, conv, sid, ctx.userPrefs.getStyle(state.createdBy ?? ""));
    // "Stay in the user's language" is a per-session INSTRUCTION (OpenCode
    // injects `api/*` entries into the system context), not prepended text —
    // cleaner and it doesn't grow the user-turn context. Tracked per SESSION
    // (guidedLanguageSession), so a brand-new session after /new, /use, setsess,
    // or plan→build gets it re-applied on its first prompt.
    if (ctx.cfg.guideLanguage) {
      if (state.guidedLanguageSession !== sid) {
        try {
          await ctx.oc.setInstruction(sid, LANGUAGE_INSTRUCTION_KEY, LANGUAGE_INSTRUCTION);
          // Record on success only — a failure is retried on the next prompt.
          ctx.st.set(conv, { guidedLanguageSession: sid });
        } catch (e) {
          warn("setInstruction:", (e as Error)?.message);
        }
      }
    } else if (!ctx.languageRemoved.has(sid)) {
      // Toggle off: strip any instruction a previous (enabled) run left on this
      // session (idempotent; remembered per process so we don't call it every
      // prompt). Clear the applied-marker so re-enabling re-applies it.
      try {
        await ctx.oc.removeInstruction(sid, LANGUAGE_INSTRUCTION_KEY);
        ctx.languageRemoved.add(sid); // success only — a failure is retried on the next prompt
      } catch (e) {
        warn("removeInstruction:", (e as Error)?.message);
      }
      if (state.guidedLanguageSession === sid) ctx.st.set(conv, { guidedLanguageSession: undefined });
    }
    // Scratchpad notes (/note): retire last turn's notes or surface pending ones.
    await prepareNotesTurn(ctx, conv, sid, lang ?? "vi");
    // Inject the "ask via question tool" preamble once per session so the agent
    // knows it is headless and should surface decisions as answerable questions.
    let promptText = text;
    if (ctx.cfg.guideQuestions && !state.guided) {
      promptText = QUESTIONS_PREAMBLE + "\n\n" + text;
      ctx.st.set(conv, { guided: true });
    }
    const ac = new AbortController();
    ctx.inflight.set(conv, ac);
    log(`[chat ${conv}] prompt on ${sid} (${text.length} chars)`);
    audit({ action: "prompt", userId: ctx.st.peek(conv)?.createdBy, chatId: conv, session: sid, dir: state.directory || ctx.cfg.opencodeDirectory, outcome: "accepted", text });
    // Fire-and-forget: don't block the polling loop; /stop aborts `ac`.
    void ctx.runPromptTask(conv, sid, promptText, ac, userMsgId, lang).catch((e) => error("prompt task:", e?.message));
  } catch (e) {
    ctx.stopTyping(conv); // don't leave "typing…" running if the prompt never started
    throw e;
  }
  return { busy: false };
}


export async function runPromptTask(ctx: BotCtx, conv: ConvKey, sid: string, text: string, ac: AbortController, userMsgId?: number, lang?: Lang): Promise<void> {
  const langEff: Lang = lang ?? ctx.userPrefs.getLang(ctx.st.peek(conv)?.createdBy ?? "");
  // One id for this user message, reused by the reconnect retry below: the
  // server dedupes on it, so the retry waits on the same turn instead of
  // running the instruction a second time.
  const messageID = newMessageID();
  // Bump the turn generation: invalidates any preview state from a previous
  // turn (its wrapper may still linger to absorb late deltas) and starts the
  // streaming wrapper for this turn fresh.
  ctx.turnGen.set(conv, (ctx.turnGen.get(conv) ?? 0) + 1);
  ctx.drafts.delete(conv);
  const run = () => ctx.oc.promptAndWait(sid, text, { signal: ac.signal, messageID });
  // Turn outcome, for the drain decision in `finally` (Q3.2: only a SUCCEEDED
  // turn runs the next queued message; a failed or interrupted turn holds it).
  // Fail-safe default "failed" so an unexpected path never drains the queue.
  let outcome: "succeeded" | "failed" | "interrupted" = "failed";
  // Next-step Review signal: the working-tree fingerprint BEFORE the turn
  // (undefined when the feature is off, the conv is not a plain build session,
  // or the folder is not a git repo). Compared with a second one afterwards.
  const nsBefore = await ctx.nextStepSnapshot(conv);
  try {
    let res;
    try {
      res = await run();
    } catch (e) {
      // A persistent "Transport: fetch failed" usually means the OpenCode
      // service restarted on a new port (stale URL). Re-discover and retry
      // once; the retry rides out the reconnect.
      if (!ac.signal.aborted && isTransportError(e)) {
        warn("prompt failed (transport) — reconnecting to OpenCode and retrying…");
        await ctx.oc.reconnect();
        res = await run();
      } else {
        throw e;
      }
    }
    // Classify the turn now that `res` is final (after any reconnect retry).
    if (res.interrupted) outcome = "interrupted";
    else if (res.outcome === "failed") outcome = "failed";
    else outcome = "succeeded";
    ctx.stopTyping(conv);
    // Drop the live preview before the final message lands (group transport
    // keeps a real, self-editing message that must not outlive the reply).
    await ctx.dropPreview(conv);
    // A failed turn produced no useful reply — surface the real reason (often
    // context overflow, fixable with /clear) instead of an opaque "failed · Xs".
    if (res.outcome === "failed" && !res.interrupted) {
      if (res.reply) {
        await ctx.sendReply(conv, res.reply);
        if (res.replyTime) ctx.st.set(conv, { lastRelayedTime: res.replyTime });
      }
      // A genuine failure (not a user /stop): attach a one-tap "⏯ Chạy tiếp"
      // button to the failure message so the user can resume the same session.
      const kb = ctx.offerContinueKeyboard(conv, sid, messageID, res.outcome, res.interrupted, langEff);
      // S5 (next-step buttons): a context-overflow failure also earns the
      // "new-keep" row (engine rule) — same message, under the Continue row.
      const nsKb = await ctx.buildNextStepFailureKeyboard(conv, sid, {
        outcome: "failed",
        interrupted: false,
        elapsedMs: res.elapsedMs,
        error: res.error,
        lang: langEff,
      });
      const failText = formatTurnFailure(res.error, res.elapsedMs, langEff);
      if (nsKb) {
        const rows = [...(kb?.inline_keyboard ?? []), ...nsKb.inline_keyboard];
        const failId = await ctx.tg.sendMessageId(conv, failText, { reply_markup: { inline_keyboard: rows } }).catch(() => -1);
        // N3.1/N3.7: remember the message so the next-step row can be dropped
        // on tap / next user message, reverting to the Continue row when there
        // is one (the pre-existing button must survive).
        if (failId > 0) ctx.noteNextStepMessage(conv, failId, kb);
      } else {
        // No next-step row: exactly the pre-next-steps path (chunked by sendHtml).
        await ctx.sendHtml(conv, failText, kb ? { reply_markup: kb } : {});
      }
      // Body language (feature C): the bot dislikes the turn that failed.
      ctx.bodyReact(conv, userMsgId, REACTION_FAIL);
      return;
    }
    const reply = res.reply || (res.interrupted ? "(interrupted — no text produced yet)" : "(no text reply)");
    await ctx.sendReply(conv, reply);
    // Remember the newest reply we've relayed so a restart can recover any that
    // were produced but never sent (see recoverOrphanedReplies).
    if (res.replyTime) ctx.st.set(conv, { lastRelayedTime: res.replyTime });
    // A quiet italic footer. The <i> tags are meant to render (HTML mode), so
    // we do NOT escape the whole string — only the server-supplied outcome text.
    const meta = `<i>${esc(res.outcome ?? "")} · ${(res.elapsedMs / 1000).toFixed(1)}s${res.interrupted ? " · stopped" : ""}</i>`;
    // S3 (next-step buttons): the quiet footer carries the turn's keyboard —
    // no extra message. decide() returns [] for everything it must not show
    // (N1.3–N1.5: choices/other-keyboard, stopped turns, non-idle convs).
    // R4.1: a reply carrying quick replies (an [OPTIONS] marker) gets no
    // rule-based next-step buttons for that turn (the model's options win).
    const hasQuickReplies = ctx.cfg.suggest && extractOptionsMarker(stripTags(res.reply ?? "")) !== null;
    const kb = hasQuickReplies
      ? undefined
      : await ctx.buildNextStepKeyboard(conv, sid, {
          outcome,
          interrupted: res.interrupted,
          reply: res.reply,
          elapsedMs: res.elapsedMs,
          error: res.error,
          lang: langEff,
          fpBefore: nsBefore,
        });
    if (kb) {
      const footerId = await ctx.tg.sendMessageId(conv, meta, { reply_markup: kb }).catch(() => -1);
      if (footerId > 0) ctx.nextStepFooters.set(conv, footerId);
    } else {
      await ctx.tg.sendMessage(conv, meta).catch(() => {});
    }
    if (!res.interrupted && res.reply) await ctx.maybeOfferPlanToBuild(conv);
  } catch (e) {
    // A throw (service down, unhandled) is a failed turn; a user /stop aborts
    // the signal (interrupted). Either way it is NOT "succeeded", so no drain.
    outcome = ac.signal.aborted ? "interrupted" : "failed";
    ctx.stopTyping(conv);
    await ctx.dropPreview(conv);
    error("prompt error:", (e as Error)?.message);
    const lang = ctx.userPrefs.getLang(ctx.st.peek(conv)?.createdBy ?? "");
    const msg = isTransportError(e)
      ? tr(lang, "⚠️ Không thể nối tới OpenCode (service có thể đang restart / chưa chạy). Hẵng thử lại sau, hoặc kiểm tra `opencode service status`.", "⚠️ Can't reach OpenCode (the service may be restarting / not running). Try again later, or check `opencode service status`.")
      : `❌ Error: ${esc((e as Error).message)}`;
    await ctx.tg.sendMessage(conv, msg).catch(() => {});
    // Body language (feature C): the bot dislikes the turn that failed.
    ctx.bodyReact(conv, userMsgId, REACTION_FAIL);
  } finally {
    ctx.clearActivity(conv);
    ctx.stopWorking(conv); // safety net: drop the "⏳ Đang xử lý…" line if it never reached the stream
    // NOTE: do NOT delete the streaming wrapper here — it must stay (killed
    // by the generation bump in dropPreview) so late deltas of this turn
    // cannot spawn a stray preview after the final message. The NEXT turn
    // removes it (see the turnGen bump at the top of runPromptTask).
    ctx.inflight.delete(conv);
    ctx.busyNotes.clear(conv); // the turn ended: the note-button retention window is over
    // Drain the queue ONLY after a SUCCEEDED turn (Q3.2): a failed or
    // interrupted turn holds the queue. Placed after inflight.delete so the
    // drained item passes runPrompt's inflight guard (race-safe, see drainQueue).
    if (outcome === "succeeded") ctx.drainQueue(conv);
  }
}


export function drainQueue(ctx: BotCtx, conv: ConvKey): void {
  if (ctx.draining) return; // shutdown in progress — queued turns must not start
  const item = ctx.queue.shift(conv); // drops expired heads, returns the next live item or null
  if (!item) return; // nothing queued
  audit({ action: "queue_run", chatId: conv, userId: item.senderId, meta: { senderId: item.senderId, waitedMs: Date.now() - item.at } });
  const state = ctx.st.get(conv);
  void ctx.runPrompt(conv, item.text, state, undefined, undefined).then(
    (res) => {
      // Lost the turn-end race to a user message (inflight is theirs now): put
      // the item back at the HEAD (FIFO preserved, Q1.11) so it runs on the
      // next succeeded turn-end, ahead of anything enqueued behind it.
      if (res.busy) ctx.queue.prepend(conv, item);
    },
    (e) => {
      // A setup failure (service down) must not silently lose the message:
      // put it back at the head. It can only re-fire on a later SUCCEEDED
      // turn, so this can't infinite-loop.
      warn("drainQueue: runPrompt failed, requeueing:", (e as Error)?.message);
      ctx.queue.prepend(conv, item);
    },
  );
}


export async function stopCurrent(ctx: BotCtx, conv: ConvKey, interrupt = false): Promise<void> {
  ctx.stopTyping(conv);
  ctx.clearActivity(conv);
  ctx.busyNotes.clear(conv); // /stop (and /new, /clear) end the turn: drop the note-button retention
  const droppedQueue = ctx.queue.clear(conv); // /stop (and /new, /clear, session switch) = stop EVERYTHING, including the queue (Q1.5)
  if (droppedQueue > 0) audit({ action: "queue_drop", chatId: conv, meta: { count: droppedQueue, reason: "stop" } });
  await ctx.dropPreview(conv); // stopping a turn drops its live preview (and kills late deltas)
  ctx.orch.clearManagerBusy(conv); // /new, /clear, /stop all drop the manager's session — never let a late terminal event wedge the flag
  const ac = ctx.inflight.get(conv);
  if (ac) ac.abort();
  const sid = ctx.st.peek(conv)?.sessionID;
  if (ac && interrupt && sid) await ctx.oc.interrupt(sid).catch((e) => warn("interrupt:", e?.message));
}

