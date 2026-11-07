/**
 * Zero-Context-Workers — the "Script Mode" instruction block injected into a
 * build worker's preamble (see workerPreamble in src/orchestrator.ts).
 *
 * It advertises that a 5+ step task can be collapsed into one script that calls
 * tools over rpc() (src/sandbox/runner.ts), so intermediate tool I/O never
 * enters the worker's context. Actual script execution is wired in a later
 * slice; for now this only tells the worker the capability exists.
 *
 * The text is intentionally language-neutral (always English): it is a
 * technical instruction, not a UI string. `_lang` is accepted for API symmetry
 * / future localization but does not change the output.
 */
export function scriptInstruction(_lang: string): string {
  return `## Script Mode (zero-context tasks)

For tasks with 5+ sequential tool steps (read multiple files, search, transform, write output), write a single script instead of calling tools one-by-one. This avoids context overflow.

Usage:
const result = await rpc("read_file", { path: "src/app.ts" });
const matches = await rpc("grep", { pattern: "TODO", path: "src/" });
await rpc("write_file", { path: "output/summary.md", content: "# Summary\\n..." });
return "Done: 5 files processed, 3 TODOs found";

Rules:
- Available tools: read_file, write_file, grep, glob, exec
- All paths are relative to your worktree (or absolute within it)
- exec: no shell metacharacters (; | & > < $( backticks)
- The script runs in 60s. Keep it simple and sequential.
- Return a final string summary (max 500 chars).
- Use script mode ONLY when the task is 5+ tool steps. For 1-4 steps, just call tools normally.`;
}
