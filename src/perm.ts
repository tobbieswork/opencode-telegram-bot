/**
 * Pure helpers for the Telegram relay of OpenCode permission prompts.
 */

/**
 * True ONLY when a `replyPermission` failure means the request is no longer
 * pending on the server — it was already answered (here or elsewhere, e.g. the
 * TUI) or it is unknown. In that case the Telegram card must be settled, not
 * retried.
 *
 * The OpenCode client resolves an unknown/already-settled request id to a
 * server error whose wire tag is `PermissionNotFoundError` (carried both as
 * `_tag` and as `name` on the thrown Error, with message
 * "Permission request not found: <id>"). We match THAT specific tag — never on
 * the words "permission"/"not found" in the message, which also appears in
 * unrelated failures (a real "permission denied", an HTTP 403 body, a transport
 * blip) where the request is still pending and the card must stay retryable.
 */
export function isAlreadyResolvedPermissionError(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const t = e as { _tag?: unknown; name?: unknown };
  return t._tag === "PermissionNotFoundError" || t.name === "PermissionNotFoundError";
}
