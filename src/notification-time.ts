export interface QuietHours { enabled: boolean; start: string; end: string; timeZone: string; urgent: Array<"question" | "permission" | "blocked"> }
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(zone: string): Intl.DateTimeFormat {
  let result = formatters.get(zone);
  if (!result) {
    result = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    if (formatters.size >= 32) formatters.delete(formatters.keys().next().value!);
    formatters.set(zone, result);
  }
  return result;
}
export function validateQuiet(value: QuietHours): QuietHours {
  const valid = (time: string) => typeof time === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time);
  if (!value || typeof value.enabled !== "boolean" || !valid(value.start) || !valid(value.end) || value.start === value.end ||
    typeof value.timeZone !== "string" || value.timeZone.length > 100 || !Array.isArray(value.urgent) || value.urgent.length > 3 ||
    new Set(value.urgent).size !== value.urgent.length || value.urgent.some(kind => !["question", "permission", "blocked"].includes(kind))) throw new Error("Khoảng giờ hoặc loại báo ngay không hợp lệ; không lưu.");
  try { formatter(value.timeZone); } catch { throw new Error("Múi giờ IANA không hợp lệ; ví dụ Asia/Ho_Chi_Minh."); }
  return structuredClone(value);
}
const minute = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
function inQuiet(value: QuietHours, at: number): boolean {
  const parts = formatter(value.timeZone).formatToParts(at);
  const current = Number(parts.find(part => part.type === "hour")!.value) * 60 + Number(parts.find(part => part.type === "minute")!.value);
  const start = minute(value.start), end = minute(value.end);
  return start < end ? current >= start && current < end : current >= start || current < end;
}
/** Đi theo giờ địa phương thật, kể cả giờ bị lặp/bỏ qua; không dùng độ lệch UTC cố định. */
export function quietUntil(value: QuietHours, at: number): number | undefined {
  validateQuiet(value);
  if (!value.enabled || !inQuiet(value, at)) return undefined;
  for (let next = Math.floor(at / 60_000) * 60_000 + 60_000, limit = next + 27 * 3600_000; next <= limit; next += 60_000) if (!inQuiet(value, next)) return next;
  throw new Error("Không xác định được ranh giới giờ yên lặng; giữ thông báo để kiểm tra.");
}
