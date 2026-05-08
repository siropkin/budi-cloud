/**
 * Pure helpers for the surface dimension. Lives outside the
 * `"use client"` chip in `components/surface-filter.tsx` so server
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
