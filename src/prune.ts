/** A worker as seen by the /prune selector: only the fields the selection needs. */
export interface PruneItem {
  /** Conversation key of the worker topic (`chat:topic`). */
  conv: string;
  /** Current worker status (running/waiting/done/failed/stopped/idle). */
  status: string;
  /** Last activity (ms epoch); the "age" of the finished worker. */
  updatedAt: number;
}

/**
 * Worker topics eligible for /prune: FINISHED (done/failed/stopped) and
 * untouched for strictly longer than `daysMs`. Busy workers (running/waiting)
 * and idle ones are never selected, no matter how old. A finished worker with
 * no recorded `updatedAt` is treated as ancient (0) and therefore prunable.
 * Pure — no clock or state inside, so the policy is unit-testable.
 */
export function selectPruneable(items: PruneItem[], nowMs: number, daysMs: number): string[] {
  const cutoff = nowMs - daysMs;
  const finished = new Set(["done", "failed", "stopped"]);
  return items.filter((it) => finished.has(it.status) && (it.updatedAt ?? 0) < cutoff).map((it) => it.conv);
}
