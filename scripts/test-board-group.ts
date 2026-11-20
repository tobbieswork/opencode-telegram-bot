/**
 * /board urgency grouping — boardGroup / boardReason (plannotator #3, adapted).
 *
 * These are pure classifiers over WorkerInfo state: no worker changes, no
 * live Telegram/OpenCode. They file each worker by what it needs from the
 * human (plannotator's Blocked > Holding > Waiting, derived from status):
 *   - "needs" = waiting (question/permission), failed, or a spec worker that
 *               finished its turn with a run still pending (awaiting Accept/Redo)
 *   - "busy"  = running
 *   - "idle"  = done (no pending run) / stopped / idle
 *
 * Run:  npx tsx scripts/test-board-group.ts
 */
import { boardGroup, boardReason } from "../src/orchestrator.js";
import type { WorkerInfo } from "../src/state.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? "\n      " + detail : ""}`);
  }
}

const T0 = 1_700_000_000_000;
function mkWorker(o: Partial<WorkerInfo> = {}): WorkerInfo {
  return {
    name: "w",
    status: "idle",
    spawnedBy: "user",
    createdAt: T0,
    updatedAt: T0,
    ...o,
  };
}
const SPEC_RUN = { spec: "gamma", branch: "spec/gamma", task: "T2", conv: "1:1" as any, uid: 7 };

console.log("# boardGroup — the status → urgency matrix");
check("waiting → needs", boardGroup(mkWorker({ status: "waiting" })) === "needs");
check("failed → needs", boardGroup(mkWorker({ status: "failed" })) === "needs");
check("done + specRun (awaiting Accept/Redo) → needs", boardGroup(mkWorker({ status: "done", specRun: SPEC_RUN })) === "needs");
check("running → busy", boardGroup(mkWorker({ status: "running" })) === "busy");
check("running + specRun (working a run) → busy, NOT needs", boardGroup(mkWorker({ status: "running", specRun: SPEC_RUN })) === "busy");
check("done (no pending run) → idle", boardGroup(mkWorker({ status: "done" })) === "idle");
check("stopped → idle", boardGroup(mkWorker({ status: "stopped" })) === "idle");
check("idle → idle", boardGroup(mkWorker({ status: "idle" })) === "idle");

console.log("# boardReason — the needs-you 'why' line (localized)");
check("waiting (vi): mentions chờ bạn trả lời", boardReason(mkWorker({ status: "waiting" }), "vi").includes("chờ bạn trả lời"), boardReason(mkWorker({ status: "waiting" }), "vi"));
check("waiting (en): 'needs your answer'", boardReason(mkWorker({ status: "waiting" }), "en").includes("needs your answer"), boardReason(mkWorker({ status: "waiting" }), "en"));
check("failed (vi): mentions lỗi", boardReason(mkWorker({ status: "failed" }), "vi").includes("lỗi"), boardReason(mkWorker({ status: "failed" }), "vi"));
check("failed (en): 'errored'", boardReason(mkWorker({ status: "failed" }), "en").includes("errored"), boardReason(mkWorker({ status: "failed" }), "en"));
const reason = boardReason(mkWorker({ status: "done", specRun: SPEC_RUN }), "vi");
check("done+specRun (vi): 'chờ duyệt' + task id", reason.includes("chờ duyệt") && reason.includes("T2"), reason);
check("done+specRun, no task id → no trailing space", boardReason(mkWorker({ status: "done", specRun: { ...SPEC_RUN, task: "" } }), "vi") === "📋 chờ duyệt", boardReason(mkWorker({ status: "done", specRun: { ...SPEC_RUN, task: "" } }), "vi"));
check("running → empty reason", boardReason(mkWorker({ status: "running" }), "vi") === "");
check("idle → empty reason", boardReason(mkWorker({ status: "idle" }), "en") === "");

if (failures) {
  console.error(`\n${failures} board-group failure(s)`);
  process.exit(1);
}
console.log("All /board grouping checks passed.");
