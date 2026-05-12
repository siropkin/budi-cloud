import type { ReactNode } from "react";
import { clsx } from "clsx";

/**
 * Dashboard tables need two completely different layouts: a `<table>` at
 * `sm:` and above, and a stacked card list (`<ul>`) below `sm` so the columns
 * don't overlap at 390px. Five places re-implemented the split — members
 * (settings), price-lists, audit-history, sessions, and the three repos
 * tables (#270). This primitive owns the split so the next responsive-table
 * lands in one place.
 *
 * Each call site passes a `columns` config for the desktop table and a
 * `mobileCard` renderer for the stacked card body. The two views often surface
 * different fields (cost-by-project shows 4 columns desktop but only label +
 * total on mobile), so they're independent rather than auto-derived from
 * columns.
 *
 * The outer wrapper defaults to `min-w-0 sm:overflow-x-auto` — gap 3 from the
 * retro (#270): callers should not have to remember this for new tables. The
 * default can be replaced via `className`.
 */
export type ResponsiveColumn<T> = {
  /** Stable identifier for React keys. */
  key: string;
  header: ReactNode;
  align?: "left" | "right";
  /** Extra Tailwind classes appended to the `<th>`. */
  headerClassName?: string;
  /** Extra Tailwind classes appended to the `<td>`. */
  cellClassName?: string;
  /** Optional `title` attribute on the `<td>` — useful for truncated text. */
  cellTitle?: (row: T) => string | undefined;
  render: (row: T) => ReactNode;
};

export type ResponsiveTableProps<T> = {
  columns: ResponsiveColumn<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string | number;
  /** Body of the `<li>` for the mobile card. */
  mobileCard: (row: T, index: number) => ReactNode;
  /** Classes appended to each mobile `<li>`. Default `py-3`. */
  mobileItemClassName?: string;
  /** Extra classes appended to each desktop `<tr>` (e.g. `align-top`). */
  rowClassName?: string;
  /**
   * Replaces the outer wrapper classes. The default
   * `min-w-0 sm:overflow-x-auto` enforces gap 3 from #270 — pass an explicit
   * value only when the surrounding layout already guarantees the overflow
   * contract.
   */
  className?: string;
  /**
   * Default padding applied to every `<td>`. Defaults to `py-2`. Set to `""`
   * when each cell's child owns the padding itself — e.g. Sessions, where
   * every cell is a `<Link className="block py-2 …">` so the click target
   * spans the full cell box.
   */
  cellPadding?: string;
};

const DEFAULT_WRAPPER = "min-w-0 sm:overflow-x-auto";

export function ResponsiveTable<T>({
  columns,
  rows,
  rowKey,
  mobileCard,
  mobileItemClassName = "py-3",
  rowClassName,
  className = DEFAULT_WRAPPER,
  cellPadding = "py-2",
}: ResponsiveTableProps<T>) {
  return (
    <div className={className}>
      <table className="hidden w-full text-sm sm:table">
        <thead>
          <tr className="border-b border-white/10 text-left text-zinc-400">
            {columns.map((col) => (
              <th
                key={col.key}
                className={clsx(
                  "pb-2 font-medium",
                  col.align === "right" && "text-right",
                  col.headerClassName
                )}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={rowKey(row, i)}
              className={clsx("border-b border-white/5", rowClassName)}
            >
              {columns.map((col) => {
                const title = col.cellTitle?.(row);
                return (
                  <td
                    key={col.key}
                    className={clsx(
                      cellPadding,
                      col.align === "right" && "text-right",
                      col.cellClassName
                    )}
                    title={title}
                  >
                    {col.render(row)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="divide-y divide-white/5 text-sm sm:hidden">
        {rows.map((row, i) => (
          <li key={rowKey(row, i)} className={mobileItemClassName}>
            {mobileCard(row, i)}
          </li>
        ))}
      </ul>
    </div>
  );
}
