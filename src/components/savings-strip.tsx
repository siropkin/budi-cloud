import { fmtCost } from "@/lib/format";

/**
 * "You saved $X this period at negotiated rates" banner for /dashboard
 * (#235). Renders above the cost chart whenever the org has an active price
 * list AND the period's effective cost is strictly below the ingested cost.
 *
 * Hidden when:
 *   - The org has no active `org_price_lists` row — there is no negotiated
 *     rate to compare against, so the strip would just be visual noise.
 *   - `effective >= ingested` — either nothing was recalculated yet for this
 *     window, or the team's negotiated rate is *worse* than vendor list (a
 *     legitimate case we don't surface as "savings" because the framing is
 *     wrong; the audit history tab is where that detail belongs).
 *
 * The component itself is a pure render — the page decides whether to mount
 * it. Keeping the visibility logic in the caller (rather than nesting it
 * inside an `if (showStrip) return null`) means the SSR snapshot only ever
 * paints the strip when it's going to stick, avoiding a hydration-time
 * disappearance.
 *
 * The user-visible copy is composed by the caller and threaded through
 * `title` / `subtitle` props rather than baked into the component body —
 * page-tree tests (`src/test-utils/page-tree.ts`) pick up text from those
 * recognized props but cannot peek into a Server Component's body, so this
 * shape keeps the regression test surface honest.
 */
export function SavingsStrip({
  title,
  subtitle,
}: {
  title: string;
  subtitle: string;
}) {
  return (
    <div
      role="status"
      className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-4 py-3 text-sm"
    >
      <span aria-hidden className="text-emerald-300">
        ●
      </span>
      <span className="font-semibold text-emerald-200">{title}</span>
      <span className="text-zinc-400">{subtitle}</span>
    </div>
  );
}

/** Format the strip's copy from raw cents. Exported so the page wires it in. */
export function buildSavingsStripCopy(
  ingestedCents: number,
  effectiveCents: number
): { title: string; subtitle: string } {
  const savedCents = ingestedCents - effectiveCents;
  return {
    title: `${fmtCost(savedCents)} saved this period at negotiated rates`,
    subtitle: `list: ${fmtCost(ingestedCents)} → effective: ${fmtCost(effectiveCents)}`,
  };
}
