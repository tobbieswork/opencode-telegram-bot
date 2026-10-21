const ts = () => new Date().toISOString().replace("T", " ").slice(0, 19);

export function log(...a: unknown[]): void {
  console.log(`[${ts()}]`, ...a);
}
export function warn(...a: unknown[]): void {
  console.warn(`[${ts()}] WARN`, ...a);
}
export function error(...a: unknown[]): void {
  console.error(`[${ts()}] ERROR`, ...a);
}
