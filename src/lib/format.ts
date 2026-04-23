/**
 * Formatting utilities — reuses patterns from frontend/dashboard/src/lib/format.ts.
 */

/** Format a dollar cost from cents. */
export function fmtCost(cents: number): string {
  const dollars = cents / 100;
  if (dollars === 0) return "$0.00";
  if (Math.abs(dollars) < 0.01) return `$${dollars.toFixed(4)}`;
  if (Math.abs(dollars) < 1) return `$${dollars.toFixed(2)}`;
  return `$${dollars.toFixed(2)}`;
}

/** Format a number with locale-aware grouping. */
export function fmtNum(n: number): string {
  if (n === 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString("en-US");
}

/**
 * Extract a short repo name from a hashed repo_id.
 *
 * The daemon emits two historical sentinels when a session's directory has
 * no resolvable git remote — `"Unassigned"` (legacy) and `"(untagged)"`
 * (current). Both mean the same thing to the viewer, so collapse them to a
 * single display bucket. Don't rewrite DB values; just unify at render time.
 */
export function repoName(repoId: string | null): string {
  if (!repoId) return "(unknown)";
  if (repoId === "Unassigned" || repoId === "(untagged)") return "(no repo)";
  if (repoId.startsWith("sha256:")) return repoId.slice(7, 15) + "...";
  if (repoId.length > 16) return repoId.slice(0, 12) + "...";
  return repoId;
}

/** Format a model name for display. */
export function formatModelName(model: string): string {
  // Strip date suffixes like -20250514
  return model.replace(/-\d{8}$/, "");
}

/** Format a date string for chart labels. */
export function fmtDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Long-form date for chart tooltips — includes year so the window is unambiguous. */
export function fmtFullDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * A device label for the UI. Falls back to a short suffix of the id so a
 * still-unlabelled daemon is easy to tell apart in the table while staying
 * clearly not a user-chosen name.
 */
export function deviceLabel(
  id: string,
  label: string | null | undefined
): string {
  if (label && label.trim()) return label;
  const suffix = id.replace(/^dev_/, "").slice(0, 8);
  return `device ${suffix || id}`;
}

/**
 * Coarse "X ago" string for server-rendered last-seen timestamps. Deliberately
 * low-precision (minute granularity, no ticking) — the dashboard layout is
 * `force-dynamic` so each page load recomputes against a fresh `Date.now()`.
 */
export function fmtRelative(iso: string | null, now: number = Date.now()): string {
  if (!iso) return "never";
  const diff = Math.max(0, now - Date.parse(iso));
  const s = Math.floor(diff / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}
