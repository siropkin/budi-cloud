"use client";

import { useEffect, useState } from "react";

/**
 * Subscribe to a CSS media query from a client component. SSR-safe — returns
 * `false` on the first render so layout always matches the desktop default
 * until the browser reports otherwise. Used to adapt recharts pixel props
 * (YAxis width, BarChart margin) that Tailwind can't express on its own.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}
