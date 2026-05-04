// Test-only helpers for inspecting an async server component's returned
// React tree. Page-level tests in src/app/**/page.test.tsx import these so
// they avoid round-tripping through JSON.stringify (which trips on Next's
// lazy/circular references) without pulling in React Testing Library.
//
// Lives under src/test-utils/ — the directory is excluded from production
// bundles by virtue of every consumer being a *.test.tsx file.

import type { ReactElement } from "react";

type Node = unknown;

/**
 * Concatenate every string/number child reachable from `node` into a single
 * search-friendly haystack. Walks `props.children` recursively, guards
 * against cycles, and tolerates `null` / `undefined` / boolean leaves the
 * way React itself does. The result is a whitespace-separated bag-of-words
 * — order is preserved, but layout characters (newlines, indentation) are
 * not, so use `.toContain(substring)` rather than equality.
 */
export function extractText(node: Node): string {
  const seen = new WeakSet<object>();
  const parts: string[] = [];
  walk(node, parts, seen);
  return parts.join(" ");
}

// Props worth scanning for user-visible text. The dashboard pages use a
// thin "label/value" wrapper (Field, CardTitle, CostBarChart#emptyLabel) and
// Verkada-style icon/aria labels — text on those components lives in props,
// not in children. Class names / hrefs / styling props are skipped because
// they would otherwise pollute the haystack with CSS.
const TEXT_PROPS = new Set([
  "label",
  "value",
  "emptyLabel",
  "title",
  "alt",
  "placeholder",
  "ariaLabel",
  "aria-label",
  "subtitle",
  "name",
  "fallback",
]);

function walk(node: Node, parts: string[], seen: WeakSet<object>): void {
  if (node == null || typeof node === "boolean") return;
  if (typeof node === "string") {
    parts.push(node);
    return;
  }
  if (typeof node === "number") {
    parts.push(String(node));
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) walk(child, parts, seen);
    return;
  }
  if (typeof node !== "object") return;
  if (seen.has(node as object)) return;
  seen.add(node as object);

  const el = node as ReactElement & {
    props?: Record<string, unknown> & { children?: unknown };
  };
  if (el.props) {
    for (const key of Object.keys(el.props)) {
      if (key === "children") continue;
      if (!TEXT_PROPS.has(key)) continue;
      walk(el.props[key], parts, seen);
    }
    walk(el.props.children, parts, seen);
  }
}

/**
 * Walk the tree looking for a `<Suspense>` boundary. Pages that opt into
 * streaming wrap their filter cluster in `<Suspense>` (no fallback prop —
 * default `null`); these tests pin the presence of that boundary so a
 * refactor that strips it shows up rather than silently regressing.
 */
export function containsSuspense(node: Node): boolean {
  const seen = new WeakSet<object>();
  return findSuspense(node, seen);
}

function findSuspense(node: Node, seen: WeakSet<object>): boolean {
  if (node == null || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some((c) => findSuspense(c, seen));
  if (seen.has(node as object)) return false;
  seen.add(node as object);

  const el = node as ReactElement & { props?: { children?: unknown } };
  const t = el.type as
    | { displayName?: string; name?: string }
    | string
    | symbol
    | undefined;
  if (typeof t === "symbol" && t.toString().includes("react.suspense")) {
    return true;
  }
  if (
    t &&
    typeof t === "object" &&
    ((t as { displayName?: string }).displayName === "Suspense" ||
      (t as { name?: string }).name === "Suspense")
  ) {
    return true;
  }
  return findSuspense(el.props?.children, seen);
}
