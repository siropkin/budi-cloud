/** Cap on rows the bar chart will render. Lives in a server-and-client safe
 * module (no `"use client"` directive) so the Repos page's server component
 * can import it directly to keep its companion tables in lockstep with the
 * chart. Importing the same constant from `cost-bar-chart.tsx` (which IS a
 * client module) makes it a client reference at server build time — the
 * imported value is `undefined` server-side, and `Array.slice(0, undefined)`
 * silently returns the full array. */
export const COST_BAR_CHART_MAX_ITEMS = 10;
