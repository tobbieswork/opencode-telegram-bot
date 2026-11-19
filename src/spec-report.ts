/**
 * T2 (docs/sdd/ocr-hardening.md) — the fixed spec-worker report schema.
 *
 * The spec worker brief (buildTaskPrompt, "## Report" section) requires the
 * worker's FINAL message to carry the fields Status / Coverage / Files /
 * Tests / Follow-ups. When a SPEC worker reaches a terminal status the host
 * parses these fields from the final message (postSpecCheckpoint): parsed
 * fields go onto the worker entry (`report?`, optional → state.json
 * backward compatible) and onto the checkpoint card as a compact block;
 * missing fields get a ⚠️ line on the card plus a host warning. The warning
 * is SOFT — it never blocks accept (accept is governed by T1's gate).
 *
 * Pure: no I/O. Language-neutral — the field names ARE the machine schema.
 */

/** The schema's field names, in render order (the brief and the parser agree on them). */
export const REPORT_FIELDS = ["Status", "Coverage", "Files", "Tests", "Follow-ups"] as const;
export type ReportField = (typeof REPORT_FIELDS)[number];

/** The WorkerReport key each field name maps to. */
export const FIELD_KEYS: Record<ReportField, "status" | "coverage" | "files" | "tests" | "followUps"> = {
  Status: "status",
  Coverage: "coverage",
  Files: "files",
  Tests: "tests",
  "Follow-ups": "followUps",
};

/**
 * The parsed report block of a worker's final message. A field is "present"
 * when its `Name:` marker was found — even with an empty value (Follow-ups
 * MAY be empty by the schema). `missing` lists the absent field names in
 * schema order.
 */
export interface WorkerReport {
  status?: string;
  coverage?: string;
  files?: string;
  tests?: string;
  followUps?: string;
  /** Field names with no `Name:` marker in the message, in schema order. */
  missing: ReportField[];
}

/** A field line: start of line, optional bullet, `Name:`, rest of line = value. */
const FIELD_RE = /^\s*(?:[-*+]\s+)?(Status|Coverage|Files|Tests|Follow-ups)\s*:(.*)$/i;
/** A decorative `Report:` header line a worker may add — not a field. */
const REPORT_HEADER_RE = /^\s*(?:[-*+]\s+)?Report\s*:/i;

/** Normalize a case-insensitive match ("status") to the schema name ("Status"). */
function canonical(raw: string): ReportField {
  return REPORT_FIELDS.find((f) => f.toLowerCase() === raw.toLowerCase())!;
}

/**
 * Parse the fixed report block out of a worker's final message.
 *
 * Line-based, case-insensitive on the field name:
 *   - a field line STARTS a field (optional bullet, `Name:`, the rest of the
 *     line is the value's first line); a marker that was already seen is
 *     skipped — the first occurrence wins;
 *   - following non-blank lines until the next field line are continuation
 *     lines (e.g. a multi-line Coverage list) and append to the current field;
 *   - a decorative `Report:` header line is ignored;
 *   - prose before the first field line is ignored (the block sits at the
 *     end of the final message; only the block is parsed).
 *
 * A `Files:` mention MID-LINE (e.g. "the Files: list above") never matches —
 * the marker must start the line.
 */
export function parseWorkerReport(text: string): WorkerReport {
  const fields: Partial<Record<ReportField, string[]>> = {};
  let current: ReportField | undefined;
  for (const line of (text ?? "").split(/\r?\n/)) {
    if (REPORT_HEADER_RE.test(line)) continue;
    const m = line.match(FIELD_RE);
    if (m) {
      const name = canonical(m[1]);
      if (fields[name] !== undefined) continue; // first occurrence wins
      current = name;
      const value = m[2].trim();
      fields[name] = value ? [value] : [];
    } else if (current !== undefined && line.trim() !== "") {
      fields[current]!.push(line.trim());
    }
  }
  const report: WorkerReport = { missing: [] as ReportField[] };
  for (const f of REPORT_FIELDS) {
    const lines = fields[f];
    if (lines === undefined) {
      report.missing.push(f);
      continue;
    }
    report[FIELD_KEYS[f]] = lines.join("\n");
  }
  return report;
}
