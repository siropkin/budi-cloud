import { Card } from "@/components/ui/card";

interface Delta {
  label: string;
  direction: "up" | "down" | "flat";
}

export function StatCard({
  title,
  value,
  subtitle,
  delta,
  deltaCaption,
}: {
  title: string;
  value: string;
  subtitle?: string;
  /**
   * Period-over-period change vs the previous comparable window (#150). Color
   * follows direction; a `flat` direction renders zinc so the comparison
   * stays neutral when the baseline is missing or the change is sub-rounding.
   */
  delta?: Delta;
  /** e.g. `vs previous 7d`. Required when `delta` is supplied. */
  deltaCaption?: string;
}) {
  const deltaColor =
    delta?.direction === "up"
      ? "text-emerald-400"
      : delta?.direction === "down"
        ? "text-rose-400"
        : "text-zinc-500";
  return (
    <Card>
      <p className="text-sm font-medium text-zinc-400">{title}</p>
      <p className="mt-2 text-3xl font-semibold text-white">{value}</p>
      {subtitle && <p className="mt-1 text-sm text-zinc-500">{subtitle}</p>}
      {delta && deltaCaption && (
        <p className="mt-1 text-xs text-zinc-500">
          <span className={`font-medium ${deltaColor}`}>{delta.label}</span>{" "}
          {deltaCaption}
        </p>
      )}
    </Card>
  );
}
