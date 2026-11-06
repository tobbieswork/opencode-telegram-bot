/**
 * Pure-function checks for redactSecrets — the outbound-secret guard wired
 * into every Telegram message-text send path (see src/telegram.ts). No
 * service or network needed.
 *
 * Run:  npx tsx scripts/test-redact.ts
 */
import { redactSecrets } from "../src/redact.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

// Fixed fixtures (deterministic, no live credentials)
const GH_PAT = `ghp_${"a1B2c3D4".repeat(4)}xyZw`; // ghp_ + 36 chars
const GH_FINE = `github_pat_${"A1b2C3d4".repeat(4)}_xY`; // github_pat_ + 35 chars
const TG_TOKEN = `8635324226:AAH${"fK3pQx".repeat(5)}Zm`; // id:35 chars
const OAI_KEY = `sk-proj-${"Tq9vLm".repeat(6)}88ab`; // sk-proj- + 30 chars
const ANT_KEY = `sk-ant-api03-${"Kw2nRd".repeat(5)}Q7`; // sk-ant- + 26 chars
const AWS_KEY = "AKIA" + "Q7X2MB9F3K1L0C8E"; // AKIA + 16
const SLACK_KEY = `xoxb-192837465${"7-Ab3Fg6Hj9K".slice(0, 10)}0987`; // xoxb- + 19
const GOOG_KEY = "AIza" + "SyA6Hc3V9q0W5t8X2r7Y4u1I3o6P9d2eK4f"; // AIza + 35
const PK_BLOCK = `-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA7v5x\nabcdef0123456789\n-----END RSA PRIVATE KEY-----`;

// ── each known secret format is masked with a first4…last4 fingerprint ─────
{
  const r = redactSecrets(`token=${GH_PAT}`);
  check("github PAT masked", !r.includes(GH_PAT) && r.includes(`ghp_…${GH_PAT.slice(-4)}`), r);

  const r2 = redactSecrets(GH_FINE);
  check("github fine-grained PAT masked", !r2.includes(GH_FINE) && r2.startsWith("gith"), r2);

  const r3 = redactSecrets(`tg=${TG_TOKEN}`);
  check("telegram bot token masked", !r3.includes(TG_TOKEN) && r3.includes("8635…"), r3);

  const r4 = redactSecrets(`a=${OAI_KEY} b=${ANT_KEY}`);
  check("openai key masked", !r4.includes(OAI_KEY) && r4.includes("sk-p…"), r4);
  check("anthropic key masked", !r4.includes(ANT_KEY) && r4.includes("sk-a…"), r4);

  const r5 = redactSecrets(`aws=${AWS_KEY}`);
  check("aws key id masked", !r5.includes(AWS_KEY) && r5.includes("AKIA…"), r5);

  const r6 = redactSecrets(`slack=${SLACK_KEY}`);
  check("slack token masked", !r6.includes(SLACK_KEY) && r6.includes("xoxb…"), r6);

  const r7 = redactSecrets(`g=${GOOG_KEY}`);
  check("google api key masked", !r7.includes(GOOG_KEY) && r7.includes("AIza…"), r7);

  const r8 = redactSecrets(`key:\n${PK_BLOCK}\ndone`);
  check("private key block removed", !r8.includes("MIIEpAIBAAKCAQEA7v5x") && r8.includes("[REDACTED private key]") && r8.includes("done"), r8);
}

// ── multiple secrets in one message are ALL masked ─────────────────────────
{
  const r = redactSecrets(`first ${GH_PAT} then ${OAI_KEY} and ${TG_TOKEN} end`);
  check("multi: none survive", ![GH_PAT, OAI_KEY, TG_TOKEN].some((s) => r.includes(s)), r);
  check("multi: context kept", r.includes("first") && r.includes("then") && r.includes("end"), r);
}

// ── lookalikes that are NOT secrets pass through untouched ─────────────────
{
  const clean = "sk-2026-11-06\nghp_short1\nAKIA123\nxoxb-123\nsee 12345:67890 for the ticket";
  check("lookalikes untouched", redactSecrets(clean) === clean, redactSecrets(clean));
}

// ── clean text (incl. Vietnamese, URLs, HTML, code) is byte-identical ───────
{
  const clean = "Xong! Xem https://github.com/tobbieswork/opencode-telegram-bot/blob/main/README.md\n<b>đầy</b> context? chạy <code>/clear</code>";
  check("clean text identity", redactSecrets(clean) === clean, redactSecrets(clean));
}

// ── idempotent: masking already-masked text changes nothing ────────────────
{
  const once = redactSecrets(`x ${GH_PAT} ${OAI_KEY} ${PK_BLOCK} y`);
  check("idempotent", redactSecrets(once) === once, `${once}\n---\n${redactSecrets(once)}`);
}

// ── masking never breaks HTML tag balance (Telegram rejects unbalanced tags) ─
{
  const html = `<b>${GH_PAT}</b> and <i>${OAI_KEY}</i>`;
  const r = redactSecrets(html);
  for (const tag of ["b", "i", "code"]) {
    const open = (r.match(new RegExp(`<${tag}[ >]`, "g")) ?? []).length;
    const close = (r.match(new RegExp(`</${tag}>`, "g")) ?? []).length;
    check(`html: <${tag}> balanced`, open === close, r);
  }
  check("html: raw secret gone", !r.includes(GH_PAT) && !r.includes(OAI_KEY), r);
}

// ── fingerprint format: first4…last4 of the original secret ────────────────
{
  const r = redactSecrets(GH_PAT);
  check("fingerprint format", r === `${GH_PAT.slice(0, 4)}…${GH_PAT.slice(-4)}`, r);
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
