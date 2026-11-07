import { Worker } from "node:worker_threads";
import path from "node:path";
import { log, warn } from "../logger.js";
import { executeTool } from "./tools.js";

export interface RunScriptResult {
  /** The script's return value (stringified). */
  result: string;
  /** Error message if the script threw (or the sandbox intervened). */
  error?: string;
  /** Wall-clock execution time. */
  durationMs: number;
  /** True if the script was killed by the timeout. */
  timedOut: boolean;
}

export interface RunScriptOptions {
  /** The worktree path — every RPC path is validated against it. */
  worktree: string;
  /** Hard wall-clock timeout. Default 60000. */
  timeoutMs?: number;
  /** Worker heap cap (resourceLimits.maxOldGenerationSizeMb). Default 256. */
  memoryLimitMb?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MEMORY_LIMIT_MB = 256;

// ── worker ↔ main-thread protocol ─────────────────────────────────────────────────
interface RpcRequest {
  kind: "rpc";
  id: number;
  tool: string;
  params?: Record<string, unknown>;
}
interface DoneMsg {
  kind: "done";
  value: string;
}
interface ErrMsg {
  kind: "error";
  message: string;
}
interface LogMsg {
  kind: "log";
  level: string;
  text: string;
}
interface SelfTimeoutMsg {
  kind: "self-timeout";
}
type WorkerMsg = RpcRequest | DoneMsg | ErrMsg | LogMsg | SelfTimeoutMsg;

/**
 * Build the worker-thread wrapper (plain CJS, no tsx needed).
 *
 * The user script runs in a vm context whose realm contains only ECMAScript
 * builtins plus the injected { console, setTimeout, clearTimeout, rpc } —
 * no require, no process, no fs, no fetch, no import(), no other host global.
 * All host access goes through rpc(), which the main thread validates
 * (allowlist + worktree path) and executes via executeTool (same logic as
 * rpc-server.ts). A 1s vm timeout additionally bounds synchronous execution.
 *
 * Note: with `eval: true` Node does NOT inject the `workerData` global, so
 * `code`/`timeoutMs` are inlined as JSON literals and `parentPort` comes from
 * the worker_threads module export.
 */
function buildWorkerCode(code: string, timeoutMs: number): string {
  return `
"use strict";
const { parentPort } = require("node:worker_threads");
const vm = require("node:vm");
const userCode = ${JSON.stringify(code)};
const timeoutMs = ${timeoutMs};

let seq = 0;
const pending = new Map();

function rpc(tool, params) {
  const id = ++seq;
  return new Promise(function (resolve, reject) {
    pending.set(id, { resolve: resolve, reject: reject });
    parentPort.postMessage({ kind: "rpc", id: id, tool: tool, params: params == null ? {} : params });
  });
}

parentPort.on("message", function (msg) {
  if (!msg || msg.kind !== "rpc-result") return;
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if (msg.ok) p.resolve(msg.payload);
  else p.reject(new Error(msg.error || "rpc error"));
});

function toText(a) {
  if (typeof a === "string") return a;
  if (a instanceof Error) return a.message;
  try { return JSON.stringify(a); } catch (e) { return String(a); }
}
function mkLog(level) {
  return function () {
    try {
      const args = Array.prototype.slice.call(arguments);
      parentPort.postMessage({ kind: "log", level: level, text: args.map(toText).join(" ") });
    } catch (e) { /* worker gone */ }
  };
}

const sandbox = {
  console: {
    log: mkLog("log"),
    info: mkLog("info"),
    warn: mkLog("warn"),
    error: mkLog("error"),
    debug: mkLog("debug"),
    trace: mkLog("trace"),
  },
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  rpc: rpc,
};
vm.createContext(sandbox, { name: "sandbox-script" });

let finished = false;
function safePost(msg) {
  try { parentPort.postMessage(msg); return true; } catch (e) { return false; }
}
// Belt and suspenders: if the main thread has not terminated us by the deadline,
// say so (the worker cannot kill itself or the host process).
const selfTimeout = setTimeout(function () {
  if (!finished) safePost({ kind: "self-timeout" });
}, timeoutMs + 1000);

function reportError(err) {
  if (finished) return;
  finished = true;
  clearTimeout(selfTimeout);
  safePost({ kind: "error", message: err && err.message ? String(err.message) : String(err) });
}

const NL = String.fromCharCode(10);
// On Node < 22.12 import() in a vm context is blocked by default ("A dynamic
// import callback was not specified"); on newer Node, pass an explicit
// importModuleDynamically so the block is permanent and the error is clearer.
const major = parseInt(process.versions.node.split(".")[0], 10);
const minor = parseInt(process.versions.node.split(".")[1], 10);
const runOpts = { timeout: 1000 }; // bounds sync execution (e.g. while(true) {})
if (major > 22 || (major === 22 && minor >= 12)) {
  runOpts.importModuleDynamically = function () {
    throw new Error("dynamic import() is not allowed in the sandbox");
  };
}
let scriptPromise;
try {
  const script = new vm.Script("(async () => {" + NL + userCode + NL + "})()", { filename: "sandbox-script.js" });
  scriptPromise = script.runInContext(sandbox, runOpts);
} catch (e) {
  reportError(e);
  process.exitCode = 1;
}

if (scriptPromise) {
  scriptPromise.then(
    function (value) {
      if (finished) return;
      finished = true;
      clearTimeout(selfTimeout);
      safePost({ kind: "done", value: String(value) });
    },
    function (err) { reportError(err); }
  );
}
`;
}

/**
 * Run a user-provided JavaScript script in an isolated worker thread.
 *
 * The script gets `rpc(tool, params)` plus console/setTimeout/clearTimeout and
 * the ECMAScript builtins — nothing else. It returns the script's return value
 * (stringified); errors and timeouts are reported in the result, never thrown
 * to the caller.
 */
export async function runScript(code: string, opts: RunScriptOptions): Promise<RunScriptResult> {
  if (typeof code !== "string" || typeof opts?.worktree !== "string" || opts.worktree.length === 0) {
    return { result: "", error: "runScript: a string code and a non-empty worktree are required", durationMs: 0, timedOut: false };
  }
  const work = path.resolve(opts.worktree);
  const timeoutMs = Math.max(1, Math.floor(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const memoryLimitMb = Math.max(1, Math.floor(opts.memoryLimitMb ?? DEFAULT_MEMORY_LIMIT_MB));
  const startedAt = Date.now();
  const now = (): number => Date.now() - startedAt;

  let worker: Worker;
  try {
    worker = new Worker(buildWorkerCode(code, timeoutMs), {
      eval: true,
      // Heap cap: V8 options (e.g. --max-old-space-size) are NOT allowed in a
      // worker's execArgv, so the cap goes through resourceLimits (per the
      // design doc). OOM surfaces as a worker error below.
      resourceLimits: { maxOldGenerationSizeMb: memoryLimitMb },
    });
  } catch (e) {
    return { result: "", error: `failed to start sandbox worker: ${(e as Error)?.message ?? String(e)}`, durationMs: now(), timedOut: false };
  }

  return await new Promise<RunScriptResult>((resolve) => {
    let settled = false;
    const finish = (result: RunScriptResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        void worker.terminate();
      } catch {
        /* already gone */
      }
      resolve(result);
    };
    const timer = setTimeout(() => {
      warn(`sandbox script timed out after ${timeoutMs}ms (worktree ${work})`);
      finish({ result: "", error: "timeout", durationMs: timeoutMs, timedOut: true });
    }, timeoutMs);

    worker.on("message", (msg: WorkerMsg) => {
      switch (msg?.kind) {
        case "rpc":
          handleRpc(worker, work, msg);
          break;
        case "done":
          finish({ result: String(msg.value), durationMs: now(), timedOut: false });
          break;
        case "error":
          finish({ result: "", error: msg.message, durationMs: now(), timedOut: false });
          break;
        case "log": {
          const text = `sandbox script: ${msg.text}`;
          if (msg.level === "error" || msg.level === "warn") warn(text);
          else log(text);
          break;
        }
        case "self-timeout":
          finish({ result: "", error: "timeout", durationMs: timeoutMs, timedOut: true });
          break;
      }
    });
    worker.on("error", (e) => {
      finish({ result: "", error: `worker error: ${e.message}`, durationMs: now(), timedOut: false });
    });
    worker.on("exit", (exitCode) => {
      // Covers crashes (e.g. OOM) where the worker dies before it can report.
      if (exitCode !== 0) finish({ result: "", error: `worker exited with code ${exitCode}`, durationMs: now(), timedOut: false });
    });
  });
}

/** Validate + execute one RPC from the worker and reply on the worker port. */
function handleRpc(worker: Worker, work: string, msg: RpcRequest): void {
  let ok = true;
  let errMsg = "";
  let payload: unknown;
  try {
    payload = executeTool(msg.tool, msg.params ?? {}, work);
  } catch (e) {
    ok = false;
    errMsg = (e as Error)?.message ?? String(e);
  }
  try {
    worker.postMessage(ok ? { kind: "rpc-result", id: msg.id, ok: true, payload } : { kind: "rpc-result", id: msg.id, ok: false, error: errMsg });
  } catch {
    /* worker already terminated (timeout) while the tool ran — nothing to reply to */
  }
}
