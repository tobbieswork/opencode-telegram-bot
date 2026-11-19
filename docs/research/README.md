# Nghiên cứu (Research)

Báo cáo nghiên cứu các repo công cụ/agent bên ngoài, đọc từ code thật (mọi claim dẫn
`file:line`), với mục đích rút **methodology** áp dụng cho `opencode-telegram-bot`.
Mỗi báo cáo có TL;DR ở cuối. Ngày nghiên cứu: 2026-11.

> Lưu ý: các `file:line` trong báo cáo trỏ vào clone tạm tại `/home/phatnd12/fpt/…`
> (có thể đã được dọn). Báo cáo tự đứng được bằng nội dung + trích dẫn.

## Chỉ mục

| File | Nguồn | Tóm tắt | Trạng thái |
|---|---|---|---|
| [`bot-scale-and-risks.md`](./bot-scale-and-risks.md) | — (phân tích chính dự án) | Trục scale, ≥12 rủi ro tương lai kèm early-warning, roadmap 1-owner system | **Tham chiếu chiến lược** — đọc trước khi scale / thêm user·repo·worker |
| [`modern-web-guidance-study.md`](./modern-web-guidance-study.md) | `GoogleChrome/modern-web-guidance-src` (8.9k★) | Pipeline calibration tự-verify (golden/zero-passrate → opportunity/uplift → prune), retrieval 4 lớp, deterministic pre-scan | **Hành động được** — ý: opportunity/uplift trên gate `typecheck`+`test:unit`; deterministic pre-scan cho `review-code` |
| [`agent-browser-study.md`](./agent-browser-study.md) | `vercel-labs/agent-browser` (52.6k★) | Snapshot+ref loop, "fail not success", daemon multi-session | **Hành động được** — ý: worker dùng headless browser riêng (thay browsermcp) |

## Đã biến thành spec (không lưu report thô)

- **`alibaba/open-code-review`** (OCR, 54k★) — nghiên cứu đã crystallize thành
  [`docs/sdd/ocr-hardening.md`](../sdd/ocr-hardening.md) (5 task: accept gate, report
  schema, tool discipline, review guardrail, re-run guard). **Đã implement + merge
  toàn bộ** (PR #314/#316/#318, 2026-11-19). Report thô bỏ, giá trị sống trong spec + git history.

## Pattern chung (3 repo hội tụ)

> **deterministic đo/trước, LLM quyết/sau — và phần đo phải tự-verify.**

- OCR: pre-gate build+test trước khi LLM accept; precision threshold cho review rule.
- MWG: grader tự chứng minh (golden 100% / zero-passrate 0%) trước khi đo; prune content model đã biết.
- agent-browser: verify-after-act (snapshot lại), "fail not success".

Đây là phương pháp nên giữ khi thiết kế thêm guardrail/gate/skill cho bot.
