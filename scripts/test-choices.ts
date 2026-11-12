/**
 * Unit tests for src/choices.ts — the Pattern B deterministic choice-button
 * detector, keyboard builder, and registry.
 *
 * Run:  npx tsx scripts/test-choices.ts
 */
import { extractTrailingChoices, extractOptionsMarker, choiceKeyboard, registry } from "../src/choices.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

// ── extractTrailingChoices ─────────────────────────────────────────────────────
{
  // A/B/C list at the end → detected, body = the intro line.
  const abc = extractTrailingChoices("Here are your options:\nA. do X\nB. do Y\nC. do Z");
  check("A/B/C at end → non-null", abc !== null);
  check("A/B/C options extracted", abc?.options.join("|") === "do X|do Y|do Z", JSON.stringify(abc?.options));
  check("A/B/C body is the intro", abc?.body === "Here are your options:", JSON.stringify(abc?.body));

  // 1/2/3 list at the end → detected.
  const num = extractTrailingChoices("Pick one:\n1. first\n2. second\n3. third");
  check("1/2/3 at end → non-null", num !== null);
  check("1/2/3 options extracted", num?.options.join("|") === "first|second|third", JSON.stringify(num?.options));

  // No list (plain prose) → null.
  check("no list → null", extractTrailingChoices("Just a normal sentence with no list at all.") === null);

  // List inside a code fence → null (fence guard).
  const fenced = extractTrailingChoices("Code sample:\n```\nA. one\nB. two\n```");
  check("list in code fence → null", fenced === null);

  // Mid-message list (not at the end) → null (last-block-only).
  const mid = extractTrailingChoices("Steps:\n1. first\n2. second\nAnd then the final paragraph.");
  check("mid-message list → null", mid === null);

  // Single item (not 2+) → null.
  check("single item → null", extractTrailingChoices("Options:\nA. only one") === null);

  // More than 8 items → null.
  const nine = "Options:\n" + Array.from({ length: 9 }, (_, i) => `${i + 1}. item ${i + 1}`).join("\n");
  check("9 items → null", extractTrailingChoices(nine) === null);

  // Exactly 8 items → ok.
  const eight = "Options:\n" + Array.from({ length: 8 }, (_, i) => `${i + 1}. item ${i + 1}`).join("\n");
  check("8 items → non-null", extractTrailingChoices(eight) !== null);

  // Exactly 2 items → ok (the minimum).
  check("2 items → non-null", extractTrailingChoices("Go?\nA. yes\nB. no") !== null);

  // Non-sequential markers → null.
  check("A,C,D (gap) → null", extractTrailingChoices("x\nA. a\nC. c\nD. d") === null);
  check("1,3 (gap) → null", extractTrailingChoices("x\n1. a\n3. c") === null);

  // Non-sequential but all valid single letters starting at A but out of order.
  check("B,A (reversed) → null", extractTrailingChoices("x\nB. b\nA. a") === null);

  // Mixed kinds (letter then number) → null.
  check("mixed A then 2 → null", extractTrailingChoices("x\nA. a\n2. b") === null);

  // A list that does not start at A → null (conservative).
  check("starts at B → null", extractTrailingChoices("x\nB. b\nC. c") === null);

  // Over-long option line (>80 chars) → null.
  check("over-long option → null", extractTrailingChoices("x\nA. " + "z".repeat(90) + "\nB. short") === null);

  // Message that is ONLY the list (empty body) → null (never send empty).
  check("list-only message → null", extractTrailingChoices("A. one\nB. two") === null);

  // Trailing blank lines after the list are fine.
  const trailingBlanks = extractTrailingChoices("Options:\nA. one\nB. two\n\n");
  check("trailing blanks ok", trailingBlanks !== null && trailingBlanks.options.length === 2);

  // Various marker separators within ONE kind are fine, but mixing kinds is not.
  const mixedKinds = extractTrailingChoices("Pick:\nA — alpha\n1) beta\n(2) gamma\n3 - delta");
  check("mixed letter+number separators → null", mixedKinds === null, JSON.stringify(mixedKinds));

  // Same kind, mixed separators → ok.
  const seps2 = extractTrailingChoices("Pick:\nA — alpha\nB: beta\nC - gamma");
  check("same-kind separators detected", seps2 !== null && seps2.options.length === 3, JSON.stringify(seps2?.options));

  // Numeric separators ( ) : - within one kind → ok.
  const numSep = extractTrailingChoices("Pick:\n1) one\n(2) two\n3 - three");
  check("numeric separators detected", numSep !== null && numSep.options.length === 3, JSON.stringify(numSep?.options));

  // Lowercase letters → ok.
  const lower = extractTrailingChoices("Pick:\na. alpha\nb. beta");
  check("lowercase letters → ok", lower !== null && lower.options.length === 2);
}

// ── extractOptionsMarker ─────────────────────────────────────────────────────
{
  // Valid 3-option marker → body (marker line removed) + 3 options.
  const three = extractOptionsMarker("Done. Now what?\n[OPTIONS: deploy | review | rollback]");
  check("3-option marker → non-null", three !== null);
  check("3-option body = intro (marker line removed)", three?.body === "Done. Now what?", JSON.stringify(three?.body));
  check("3-option options parsed", three?.options.join("|") === "deploy|review|rollback", JSON.stringify(three?.options));

  // Valid 2-option marker (the minimum).
  const two = extractOptionsMarker("Pick one.\n[OPTIONS: yes | no]");
  check("2-option marker → non-null", two !== null && two.options.length === 2, JSON.stringify(two?.options));

  // Valid 4-option marker → all 4 returned (the parser does not slice to 3).
  const four = extractOptionsMarker("Pick.\n[OPTIONS: a | b | c | d]");
  check("4-option marker → all 4 returned", four !== null && four.options.length === 4, JSON.stringify(four?.options));

  // 1 option → null.
  check("1 option → null", extractOptionsMarker("Pick.\n[OPTIONS: only one]") === null);

  // 5 options → null.
  check("5 options → null", extractOptionsMarker("Pick.\n[OPTIONS: a | b | c | d | e]") === null);

  // R1.3: a valid marker with one over-long option → strip the line, no buttons
  // (body has the marker line removed, options empty) — NOT null.
  const overLong = extractOptionsMarker("Pick.\n[OPTIONS: a | " + "x".repeat(57) + "]");
  check("option > 56 chars → { body, options: [] }", overLong !== null && overLong.body === "Pick." && overLong.options.length === 0, JSON.stringify(overLong));

  // Exactly 56 chars is fine (the limit is strictly "longer than 56").
  check("option == 56 chars → ok", extractOptionsMarker("Pick.\n[OPTIONS: a | " + "x".repeat(56) + "]") !== null);

  // Marker NOT the last non-blank line (a non-blank line after it) → null.
  check("marker not last non-blank line → null", extractOptionsMarker("[OPTIONS: a | b]\nbut more text after") === null);

  // Marker inside a closed code fence → null (the closing fence is the last line).
  check("marker in code fence → null", extractOptionsMarker("Example:\n```\n[OPTIONS: a | b]\n```") === null);

  // Marker inside an UNCLOSED fence, as the last non-blank line → null (still fenced).
  check("marker in unclosed fence → null", extractOptionsMarker("Example:\n```\n[OPTIONS: a | b]") === null);

  // Malformed: lowercase prefix → null (prefix is case-sensitive).
  check("lowercase [options:] → null", extractOptionsMarker("Pick.\n[options: a | b]") === null);

  // Malformed: missing closing ] → null.
  check("missing ] → null", extractOptionsMarker("Pick.\n[OPTIONS: a | b") === null);

  // Malformed: text after the ] on the same line (not on its own) → null.
  check("text after ] → null", extractOptionsMarker("Pick.\n[OPTIONS: a | b] and more") === null);

  // Malformed: text before the marker on the same line (not on its own) → null.
  check("text before marker → null", extractOptionsMarker("Pick.\nsee [OPTIONS: a | b]") === null);

  // Marker + a trailing lettered list → the marker wins; the list stays in the body.
  const prec = extractOptionsMarker("Pick one:\nA. first\nB. second\nC. third\n[OPTIONS: x | y]");
  check("marker wins over lettered list", prec !== null && prec.options.join("|") === "x|y", JSON.stringify(prec?.options));
  check("list stays as text in body", prec?.body === "Pick one:\nA. first\nB. second\nC. third", JSON.stringify(prec?.body));

  // De-dup (case-insensitive): "Alpha" and "alpha" collapse to one (first kept).
  const dedup = extractOptionsMarker("Pick.\n[OPTIONS: Alpha | alpha | Beta]");
  check("case-insensitive de-dupe", dedup !== null && dedup.options.join("|") === "Alpha|Beta", JSON.stringify(dedup?.options));

  // Empty option dropped (blank between pipes).
  const empty = extractOptionsMarker("Pick.\n[OPTIONS: A |  | B]");
  check("empty option dropped", empty !== null && empty.options.join("|") === "A|B", JSON.stringify(empty?.options));

  // De-dupe + empty together → still 2 valid options.
  const dedup2 = extractOptionsMarker("Pick.\n[OPTIONS: A | a |  | B]");
  check("de-dupe + empty → 2 options", dedup2 !== null && dedup2.options.length === 2, JSON.stringify(dedup2?.options));

  // Trailing blank lines after the marker are fine (marker is still the last non-blank line).
  const trailBlank = extractOptionsMarker("Intro\n[OPTIONS: a | b]\n\n\n");
  check("blank lines after marker ok", trailBlank !== null && trailBlank.body === "Intro", JSON.stringify(trailBlank?.body));

  // Reply that is ONLY the marker (no body) → null (never send an empty message).
  check("marker-only reply → null", extractOptionsMarker("[OPTIONS: a | b]") === null);
}


// ── choiceKeyboard ─────────────────────────────────────────────────────────────
{
  const kb = choiceKeyboard("abcd", ["option one", "option two", "option three"]);
  check("keyboard has 3 rows", kb.inline_keyboard.length === 3, `got ${kb.inline_keyboard.length}`);
  check("one button per row", kb.inline_keyboard.every((r) => r.length === 1));
  check("callback_data = ch:<id>:<i>", kb.inline_keyboard.map((r) => r[0].callback_data).join(",") === "ch:abcd:0,ch:abcd:1,ch:abcd:2",
    JSON.stringify(kb.inline_keyboard.map((r) => r[0].callback_data)));
  check("callback_data <= 64 bytes", kb.inline_keyboard.every((r) => Buffer.byteLength(r[0].callback_data!, "utf8") <= 64));
  check("labels kept when short", kb.inline_keyboard[0][0].text === "option one");

  // Long labels truncated to ~40 chars.
  const long = choiceKeyboard("abcd", ["x".repeat(60)]);
  check("long label truncated", long.inline_keyboard[0][0].text.length <= 41, `len ${long.inline_keyboard[0][0].text.length}`);

  // More than 8 options → only first 8 rendered.
  const many = choiceKeyboard("abcd", Array.from({ length: 12 }, (_, i) => `opt${i}`));
  check(">8 options → 8 rows", many.inline_keyboard.length === 8, `got ${many.inline_keyboard.length}`);
}

// ── registry ───────────────────────────────────────────────────────────────────
{
  const id = registry.put("chat:1", "ses_abc", ["a", "b", "c"]);
  check("put returns 4-char base36 id", /^[0-9a-z]{4}$/.test(id), id);
  const rec = registry.get(id);
  check("get returns the record", rec !== undefined);
  check("record.conv stored", rec?.conv === "chat:1");
  check("record.sessionID stored", rec?.sessionID === "ses_abc");
  check("record.options stored", rec?.options.join("|") === "a|b|c", JSON.stringify(rec?.options));
  check("get unknown id → undefined", registry.get("zzzz") === undefined);
  registry.delete(id);
  check("delete removes the record", registry.get(id) === undefined);
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll choices checks passed.");
