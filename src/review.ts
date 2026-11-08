/**
 * `/review [target]` — runs the project's `review-code` skill
 * (.opencode/skills/review-code) as a normal turn in this chat's session.
 *
 * The target is a single git-ish token (PR number, branch, sha, range,
 * `staged`). It ends up inside a prompt that the model turns into git/gh
 * commands, so it is validated against a strict whitelist first — anything
 * else (spaces, quotes, `;`, `$`, backticks…) is rejected, never escaped.
 */
import type { Lang } from "./state.js";

const TARGET_RE = /^[A-Za-z0-9._/#@^~:-]{1,100}$/;

export const REVIEW_USAGE =
  "Cú pháp: <code>/review [đích]</code>\n" +
  "Đích (tuỳ chọn, một từ): số PR (<code>84</code>), branch, commit, <code>a..b</code> hoặc <code>staged</code>.\n" +
  "Bỏ trống = thay đổi chưa commit, nếu sạch thì branch hiện tại so với main.\n" +
  "Chỉ đọc: không sửa file, không commit, không restart.";

/** Localized /review usage card. */
export function reviewUsage(lang: Lang = "vi"): string {
  return lang === "en"
    ? "Usage: <code>/review [target]</code>\n" +
      "Target (optional, one word): PR number (<code>84</code>), branch, commit, <code>a..b</code> or <code>staged</code>.\n" +
      "Empty = uncommitted changes; if clean, the current branch vs main.\n" +
      "Read-only: no file edits, no commits, no restarts."
    : REVIEW_USAGE;
}

/** The prompt for one review turn, or null when the target is not a safe single token. */
export function reviewPrompt(target: string, lang: Lang = "vi"): string | null {
  const t = target.trim();
  if (t && !TARGET_RE.test(t)) return null;
  if (lang === "en") {
    const scope = t ? `\`${t}\`` : "default (uncommitted changes; if clean, current branch vs main)";
    return (
      `Use the \`review-code\` skill to review code. Scope: ${scope}. ` +
      "Read-only — do not modify files, commit, or restart services. Respond in English."
    );
  }
  const scope = t ? `\`${t}\`` : "mặc định (thay đổi chưa commit; nếu sạch thì branch hiện tại so với main)";
  return (
    `Dùng skill \`review-code\` để review code. Phạm vi: ${scope}. ` +
    "Chỉ đọc — không sửa file, không commit, không restart service. Trả lời bằng tiếng Việt."
  );
}
