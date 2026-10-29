import { createHash } from "node:crypto";
import type { ConvKey } from "./conv.js";
import { esc } from "./format.js";
import { ACTIVITY_SOURCE_LABELS } from "./session-activity.js";
import { DASHBOARD_PHASE_LABELS, DASHBOARD_WORK_LABELS, type DashboardRow } from "./session-dashboard.js";

const segments = new Intl.Segmenter("vi", { granularity: "grapheme" });
function quote(value: string, budget: number): string {
  let result = "";
  for (const { segment } of segments.segment(value)) {
    const next = esc(segment);
    if (result.length + next.length > budget - 1) return result + "…";
    result += next;
  }
  return result;
}
function date(at?: number): string {
  if (at === undefined) return "Chưa biết mốc";
  const value = new Date(at);
  return Number.isFinite(value.getTime()) ? value.toISOString() : "Mốc không biểu diễn được";
}

/** Chỉ trình bày dữ liệu đã kiểm tra; không có cổng thực thi hoặc đọc trạng thái. */
export function buildSessionSummary(chat: ConvKey, row: DashboardRow, options: { now: number; refreshedAt?: number; refreshError?: string }) {
  if (row.chat !== chat) throw new Error("Bản tóm tắt không thuộc nhóm này.");
  const activity = row.activity?.sessionID === row.sessionID ? row.activity : undefined;
  const pending = [...row.pending].sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
  const marker = createHash("sha256").update(JSON.stringify([row.id, row.sessionID, row.conv, row.directory, row.lifecycle,
    row.work, activity?.revision, pending.map(item => [item.kind, item.id, item.verified]), row.pendingVerified])).digest("hex");
  const render = (scale: number) => {
    const q = (value: string, budget: number) => quote(value, Math.floor(budget * scale));
    const lines = [`<b>Tóm tắt · ${q(row.title, 200)}</b>`, `Phiên: <code>${q(row.sessionID ?? "Chưa xác nhận", 140)}</code>`,
      `Thư mục: <code>${q(row.directory, 360)}</code>`, `Vòng đời: ${DASHBOARD_PHASE_LABELS[row.lifecycle]}`,
      `Công việc: ${DASHBOARD_WORK_LABELS[row.work]} · kiểm tra ${date(row.checkedAt)}`];
    if (row.stale || row.checkedAt === undefined || options.now - row.checkedAt > 30_000) lines.push("Thông tin thực thi/yêu cầu chờ có thể cũ hoặc chưa xác minh; không suy thành đã xong.");
    if (row.reason) lines.push(q(row.reason, 200));
    lines.push("", "<b>Yêu cầu gần nhất</b>");
    if (activity) {
      lines.push(q(activity.input.snippet, 640), `Nguồn: ${ACTIVITY_SOURCE_LABELS[activity.input.source]} · mốc ${date(activity.input.createdAt ?? activity.input.receivedAt)}`,
        activity.input.observed ? "Đầu vào đã được đối chiếu với nguồn." : "Bot đã nhận; chưa đối chiếu được việc gửi tới nguồn.");
      if (activity.uncertainty) lines.push(q(activity.uncertainty, 220));
    } else lines.push("Chưa có yêu cầu gần nhất được đối chiếu cho phiên này.");
    lines.push("", "<b>Kết quả đã quan sát</b>");
    if (activity?.result && activity.result.inputID === activity.input.id) lines.push(q(activity.result.snippet, 1000),
      `Mốc quan sát: ${date(activity.result.observedAt)}`, "Đây là phản hồi mô hình, không phải bằng chứng độc lập rằng đã sửa tệp hoặc kiểm thử thành công.");
    else lines.push("Chưa có phản hồi được ghép đúng đầu vào; không lấy kết quả cũ làm kết quả yêu cầu mới.");
    lines.push("", "<b>Vướng mắc và yêu cầu chờ</b>");
    const verified = pending.filter(item => item.verified);
    if (verified.length) lines.push(`${verified.filter(item => item.kind === "form").length} câu hỏi · ${verified.filter(item => item.kind === "permission").length} yêu cầu cấp quyền đã xác minh.`);
    if (!row.pendingVerified) lines.push(`Chưa xác minh đủ yêu cầu chờ; ${pending.filter(item => !item.verified).length} mục đã lưu chưa được đối chiếu.`);
    else if (!pending.length) lines.push("Không thấy câu hỏi hoặc quyền đang chờ tại lần kiểm tra đã ghi.");
    if (row.titleError) lines.push(`Lỗi tên chủ đề, không phải kết quả công việc: ${q(row.titleError, 160)}`);
    if (row.activityError) lines.push(`Bản ghi hoạt động chưa đọc được: ${q(row.activityError, 160)}`);
    lines.push("", "<b>Bước tiếp theo</b>", "Chưa có bước tiếp theo được ghi nhận.");
    if (options.refreshedAt) lines.push(`Lần đọc nguồn gần nhất: ${date(options.refreshedAt)}; chỉ tối đa 40 tin của phiên đã chọn.`);
    if (options.refreshError) lines.push(`Làm mới chưa đầy đủ: ${q(options.refreshError, 200)}`);
    lines.push("Mở thẻ không tạo mốc thực thi mới. Nội dung có thể cũ khi có đầu vào mới; xem tóm tắt không mở lại hoặc tiếp tục công việc.");
    return lines.filter(line => line !== undefined).join("\n");
  };
  let text = render(1);
  if (text.length > 3800) text = render(0.6);
  return { text, marker };
}
