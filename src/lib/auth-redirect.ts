/**
 * Helpers for preserving a post-login destination across the Supabase
 * auth round-trip (login form → OAuth/magic-link → /auth/callback → app).
 *
 * The risk we are guarding against is the invite flow (`/invite/<token>`):
 * if `?next=` is dropped during the round-trip, a brand-new user gets
 * silently provisioned into a fresh personal org and the invite no-ops.
 * See issue #62 for the original report.
 */

const ALLOWED_NEXT_PREFIXES = ["/invite/", "/dashboard"] as const;

/**
 * Whitelist of paths that are safe to use as a post-auth destination.
 * Refuses absolute URLs and protocol-relative URLs to avoid open redirects.
 */
export function isSafeNextPath(
  next: string | null | undefined
): next is string {
  if (!next) return false;
  if (!next.startsWith("/")) return false;
  if (next.startsWith("//")) return false;
  return ALLOWED_NEXT_PREFIXES.some(
    (prefix) => next === prefix || next.startsWith(prefix)
  );
}

/**
 * Returns true when `next` points at the invite-acceptance page. The
 * auth callback uses this to skip the `/setup` redirect for users who
 * came in via an invite link — the invite page provisions them into
 * the inviter's org instead.
 */
export function isInvitePath(next: string | null | undefined): next is string {
  return typeof next === "string" && next.startsWith("/invite/");
}

/**
 * Build the OAuth/magic-link `redirectTo` URL, forwarding a sanitized
 * `next` query param so the callback knows where to send the user once
 * the session is established.
 */
export function buildAuthCallbackUrl(
  origin: string,
  next: string | null | undefined
): string {
  const base = `${origin}/auth/callback`;
  if (!isSafeNextPath(next)) return base;
  return `${base}?next=${encodeURIComponent(next)}`;
}
