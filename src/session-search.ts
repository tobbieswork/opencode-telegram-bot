import type { ConvKey } from "./conv.js";
import { dashboardMatches, type DashboardFilter, type DashboardRow } from "./session-dashboard.js";

export function searchText(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").replace(/[đĐ]/g, "d").toLocaleLowerCase("vi").replace(/\s+/g, " ").trim();
}
export function searchQuery(value: string): string {
  if (!value.trim() || value.length > 120) throw new Error("Từ khóa cần 1–120 ký tự; không tìm ngầm từ tin nhắn khác.");
  const query = searchText(value);
  if (!query) throw new Error("Từ khóa chưa có ký tự có thể tìm.");
  return query;
}
export interface SearchEntry { id: string; title: string; directory: string; summary?: string; at: number }
export function rankedSearch<T extends SearchEntry>(entries: readonly T[], query: string, pinned: ReadonlySet<string> = new Set()): T[] {
  const folded = searchQuery(query);
  const tokens = folded.split(" ");
  return entries.flatMap(entry => {
    const title = searchText(entry.title), rest = searchText(`${entry.directory} ${entry.summary ?? ""}`);
    if (!tokens.every(token => title.includes(token) || rest.includes(token))) return [];
    return [{ entry, rank: title === folded ? 0 : title.includes(folded) ? 1 : 2 }];
  }).sort((a, b) => a.rank - b.rank || Number(pinned.has(b.entry.id)) - Number(pinned.has(a.entry.id)) || b.entry.at - a.entry.at || a.entry.id.localeCompare(b.entry.id))
    .map(value => value.entry);
}
export function searchManaged(chat: ConvKey, rows: readonly DashboardRow[], query: string, filter: DashboardFilter, page = 0,
  includeClosed = false, pinned: ReadonlySet<string> = new Set(), onlyPinned = false) {
  const source = rows.filter(row => row.chat === chat && (includeClosed || filter === "closed" || row.lifecycle !== "closed") &&
    dashboardMatches(row, filter) && (!onlyPinned || pinned.has(row.id))).map(row => {
    const activity = row.activity?.sessionID === row.sessionID ? row.activity : undefined;
    return { ...row, at: row.lastActivityAt, summary: activity ? `${activity.input.snippet} ${activity.result?.snippet ?? ""}` : "" };
  });
  const matches = rankedSearch(source, query, pinned);
  const pages = Math.max(1, Math.ceil(matches.length / 10));
  const current = Math.max(0, Math.min(page, pages - 1));
  return { rows: matches.slice(current * 10, current * 10 + 10), page: current, pages, total: matches.length };
}
