/**
 * Pure helpers for the surface dimension. Lives outside the
 * `"use client"` chip in `components/filters/surface-filter.tsx` so server
 * components can call these without Next.js treating them as client
 * references (which threw `Attempted to call …() from the server but
 * … is on the client` after #187 shipped).
 */

/**
 * Parse the URL-shaped `?surface=` value into the canonical CSV list.
 * `?surface=vscode,cursor` → `["vscode", "cursor"]`. Empty / missing → `[]`.
 */
export function parseSurfaceParam(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * True when every row in `surfaceShare` is the schema-default `unknown` —
 * i.e. nothing in the period was tagged by a daemon that emits `surface`.
 * Used by the Overview / Models "Spend by Surface" cards to fall back to
 * an empty-state explanation rather than a single self-tautological
 * `Unknown — $TOTAL` bar that just duplicates the headline total (#210).
 *
 * `[]` is *not* all-unknown — that case is "no data at all" and is owned
 * by the existing single-surface / no-activity copy.
 */
export function isAllUnknownSurface(
  rows: { surface: string | null | undefined }[]
): boolean {
  if (rows.length === 0) return false;
  return rows.every((r) => !r.surface || r.surface === "unknown");
}

/**
 * Friendly display label for a surface id. Falls back to the raw id
 * (title-cased) so a never-before-seen surface still renders.
 */
export function formatSurface(surface: string | null | undefined): string {
  if (!surface) return "Unknown";
  switch (surface) {
    case "vscode":
      return "VS Code";
    case "cursor":
      return "Cursor";
    case "jetbrains":
      return "JetBrains";
    case "terminal":
      return "Terminal";
    case "unknown":
      return "Unknown";
    default:
      return surface.charAt(0).toUpperCase() + surface.slice(1);
  }
}
