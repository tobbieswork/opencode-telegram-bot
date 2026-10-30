/**
 * `npm run advisor:doctor` — check the hub → advisor daemon link from the hub
 * machine, and say how to fix what is wrong:
 *   1. config: ADVISOR_URL + ADVISOR_TOKEN set (from .env or the environment)
 *   2. reachable: GET /health answers (Tailscale up, daemon running, right IP/port)
 *   3. token: an authenticated no-op (/forget of a probe id) is accepted
 *   4. agents: the daemon runs the default agent (ADVISOR_DEFAULT_AGENT)
 *   5. with --live: one real one-line question per agent (spends a turn each)
 *
 * Exit code 0 when everything passes. The token is never printed.
 */
import { join } from "node:path";
import { advisorConfig, loadDotEnv } from "../src/config.js";
import { advisorHealth, askAdvisor, AdvisorError, forgetAdvisor } from "../src/advisor/advisor-client.js";
import { agentLabel, LEGACY_AGENT, resolveAgent } from "../src/advisor/agents.js";

const live = process.argv.includes("--live");
let bad = 0;
const ok = (m: string): void => console.log(`  ✓ ${m}`);
const fail = (m: string, fix: string): void => {
  bad++;
  console.log(`  ✗ ${m}\n    → ${fix}`);
};

async function main(): Promise<void> {
  const root = process.cwd();
  loadDotEnv(join(root, ".env"));
  const cfg = advisorConfig();
  console.log("advisor doctor\n");

  if (!cfg.advisor) {
    fail(
      "advisor chưa bật (thiếu ADVISOR_URL hoặc ADVISOR_TOKEN)",
      "chạy advisor-daemon/install.sh trên máy có claude/agy — nó in ra 2 dòng ADVISOR_URL / ADVISOR_TOKEN để dán vào .env của bot",
    );
    return;
  }
  ok(`config: ${cfg.advisorUrl} · agent mặc định ${agentLabel(cfg.advisorDefaultAgent)}`);
  const host = new URL(cfg.advisorUrl).hostname;
  if (!/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host) && !host.endsWith(".ts.net")) {
    console.log(`  ℹ ${host} không phải địa chỉ Tailscale (100.64.0.0/10 hoặc *.ts.net) — đúng ý bạn chứ?`);
  }
  const ep = { url: cfg.advisorUrl, token: cfg.advisorToken };

  const health = await advisorHealth(ep, 8_000);
  if (!health) {
    fail(
      `không tới được ${cfg.advisorUrl}/health`,
      "kiểm tra: máy advisor đang thức + Tailscale bật ở cả hai máy (tailscale status), daemon chạy (log ở ~/mac-advisor/logs/), đúng IP/port (install.sh in ra ADVISOR_URL)",
    );
    return;
  }
  ok(`daemon trả lời: agents [${health.agents.join(", ")}], ${health.sessions} session`);

  try {
    await forgetAdvisor(ep, resolveAgent(health.agents[0]) ?? LEGACY_AGENT, "doctor-probe", 8_000);
    ok("token đúng");
  } catch (e) {
    if (e instanceof AdvisorError && e.message.includes("401")) {
      fail("daemon từ chối token (401)", "ADVISOR_TOKEN trong .env của bot phải trùng token của daemon (install.sh giữ nguyên token cũ khi cài lại)");
    } else {
      fail(`gọi có xác thực bị lỗi: ${(e as Error).message}`, "xem log daemon");
    }
    return;
  }

  if (health.agents.includes(cfg.advisorDefaultAgent)) {
    ok(`agent mặc định ${agentLabel(cfg.advisorDefaultAgent)} có trên daemon`);
  } else {
    fail(
      `agent mặc định ${agentLabel(cfg.advisorDefaultAgent)} KHÔNG có trên daemon (có: ${health.agents.join(", ")})`,
      `đặt ADVISOR_DEFAULT_AGENT=${health.agents[0]} trong .env, hoặc cài lại daemon với ADVISOR_AGENTS gồm ${cfg.advisorDefaultAgent}`,
    );
  }

  if (!live) {
    console.log("\n  (thêm --live để hỏi thật mỗi agent một câu — tốn một lượt mỗi agent)");
    return;
  }
  for (const a of health.agents) {
    const id = resolveAgent(a);
    if (!id) continue;
    process.stdout.write(`  … hỏi thử ${agentLabel(id)} `);
    try {
      const r = await askAdvisor(ep, { agent: id, message: "Reply with exactly: OK" });
      console.log("");
      if (r.status === "done") ok(`${agentLabel(id)} trả lời (${Math.round(r.durationMs / 1000)}s): ${r.answer.trim().slice(0, 60)}`);
      else fail(`${agentLabel(id)}: ${r.answer.slice(0, 160)}`, "agent CLI đã đăng nhập trên máy advisor chưa? Xem log daemon");
      if (r.sessionId) await forgetAdvisor(ep, id, r.sessionId).catch(() => {});
    } catch (e) {
      console.log("");
      fail(`${agentLabel(id)}: ${(e as Error).message}`, "xem log daemon");
    }
  }
}

main()
  .catch((e) => fail(`doctor crashed: ${(e as Error).message}`, "báo lỗi kèm output này"))
  .finally(() => {
    console.log(bad ? `\n${bad} vấn đề cần sửa.` : "\nMọi thứ ổn.");
    process.exit(bad ? 1 : 0);
  });
