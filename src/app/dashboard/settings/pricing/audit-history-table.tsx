import Link from "next/link";
import type { RecalculationRunRow } from "@/lib/dal";
import { fmtCost } from "@/lib/format";

/**
 * Settings → Pricing → Audit history (#733). Renders the org's
 * `recalculation_runs` audit trail with status filter + offset pagination
 * (50 rows/page). Server component: filter / page state lives in the URL
 * (`?recalc_status=`, `?recalc_page=`) so a deep-link to "show every failed
 * run on page 3" is shareable without client-side state.
 *
 * Rows are immutable audit records (#728), so no row-level actions are
 * exposed — only inspection. The expandable detail pane is a native
 * `<details>` element rather than a client component because the data is
 * read-once and we don't pay React hydration for a static disclosure.
 */
export const PAGE_SIZE = 50;

/** Status values worth offering in the filter chip. Includes the two values
 * the recalc engine actually writes (#728 — `running` while in-flight,
 * `succeeded` on commit) plus `failed` as a forward-looking option so a
 * future change to the engine doesn't require revisiting this UI. */
export const STATUS_FILTER_OPTIONS = [
  "all",
  "running",
  "succeeded",
  "failed",
] as const;
export type StatusFilter = (typeof STATUS_FILTER_OPTIONS)[number];

export function parseStatusFilter(
  raw: string | undefined | null
): StatusFilter {
  if (!raw) return "all";
  const known = STATUS_FILTER_OPTIONS.find((s) => s === raw);
  return known ?? "all";
}

export function parsePage(raw: string | undefined | null): number {
  if (!raw) return 1;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return n;
}

function StatusBadge({ status }: { status: string }) {
  const tone =
    status === "succeeded"
      ? "bg-emerald-500/15 text-emerald-300"
      : status === "running"
        ? "bg-amber-500/15 text-amber-300"
        : status === "failed"
          ? "bg-red-500/15 text-red-300"
          : "bg-zinc-500/15 text-zinc-400";
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}
    >
      {status || "—"}
    </span>
  );
}

function formatStarted(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatScope(from: string | null, to: string | null): string {
  if (!from && !to) return "—";
  if (from && to && from === to) return from;
  return `${from ?? "…"} → ${to ?? "…"}`;
}

function formatDelta(
  before: number | null,
  after: number | null
): { label: string; tone: "up" | "down" | "flat" } {
  if (before == null || after == null) return { label: "—", tone: "flat" };
  const diff = after - before;
  if (diff === 0)
    return { label: `${fmtCost(before)} → ${fmtCost(after)}`, tone: "flat" };
  const tone = diff < 0 ? "down" : "up";
  return {
    label: `${fmtCost(before)} → ${fmtCost(after)}`,
    tone,
  };
}

export function AuditHistoryTable({
  runs,
  total,
  page,
  pageSize,
  status,
  usersById,
}: {
  runs: RecalculationRunRow[];
  total: number;
  page: number;
  pageSize: number;
  status: StatusFilter;
  usersById: Map<string, string>;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const showingFrom = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const showingTo = Math.min(page * pageSize, total);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-zinc-500">Filter:</span>
        {STATUS_FILTER_OPTIONS.map((opt) => {
          const isActive = opt === status;
          const href = buildHref({
            status: opt,
            page: 1,
          });
          return (
            <Link
              key={opt}
              href={href}
              className={`rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors ${
                isActive
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
                  : "border-white/10 bg-white/[0.02] text-zinc-300 hover:border-white/20"
              }`}
            >
              {opt}
            </Link>
          );
        })}
      </div>

      {runs.length === 0 ? (
        <p className="text-sm text-zinc-500">
          No recalculation runs
          {status === "all" ? " yet" : ` with status "${status}"`}.
        </p>
      ) : (
        <>
          {/* Table on sm+; below `sm` render each run as a stacked card so the
              six columns don't collapse into each other at 390px. Mirrors the
              members-list pattern in src/app/dashboard/settings/page.tsx
              (#258). */}
          <table className="hidden w-full text-sm sm:table">
            <thead>
              <tr className="border-b border-white/10 text-left text-zinc-400">
                <th className="pb-2 font-medium">Started</th>
                <th className="pb-2 font-medium">Triggered by</th>
                <th className="pb-2 font-medium">Scope</th>
                <th className="pb-2 text-right font-medium">Rows changed</th>
                <th className="pb-2 pl-6 font-medium">Before → After</th>
                <th className="pb-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => {
                const delta = formatDelta(
                  run.beforeTotalCents,
                  run.afterTotalCents
                );
                const trigger = run.triggeredBy
                  ? (usersById.get(run.triggeredBy) ?? run.triggeredBy)
                  : "—";
                return (
                  <tr
                    key={run.id}
                    className="border-b border-white/5 align-top"
                  >
                    <td className="py-2 text-zinc-200">
                      <details>
                        <summary className="cursor-pointer list-none whitespace-nowrap">
                          <span aria-hidden className="mr-1 text-zinc-500">
                            ▸
                          </span>
                          {formatStarted(run.startedAt)}
                        </summary>
                        <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs text-zinc-400">
                          <dt>Run id</dt>
                          <dd className="font-mono text-zinc-300">{run.id}</dd>
                          <dt>Finished</dt>
                          <dd className="text-zinc-300">
                            {run.finishedAt
                              ? formatStarted(run.finishedAt)
                              : "—"}
                          </dd>
                          <dt>Active price lists</dt>
                          <dd className="text-zinc-300">
                            {run.priceListIds.length === 0
                              ? "—"
                              : run.priceListIds.join(", ")}
                          </dd>
                          <dt>Rows processed</dt>
                          <dd className="text-zinc-300">
                            {run.rowsProcessed ?? "—"}
                          </dd>
                        </dl>
                      </details>
                    </td>
                    <td className="py-2 text-zinc-300">{trigger}</td>
                    <td className="py-2 text-zinc-400">
                      {formatScope(run.scopeFromDate, run.scopeToDate)}
                    </td>
                    <td className="py-2 text-right text-zinc-200 tabular-nums">
                      {run.rowsChanged ?? "—"}
                    </td>
                    <td
                      className={`py-2 pl-6 tabular-nums ${
                        delta.tone === "down"
                          ? "text-emerald-300"
                          : delta.tone === "up"
                            ? "text-amber-300"
                            : "text-zinc-300"
                      }`}
                    >
                      {delta.label}
                    </td>
                    <td className="py-2">
                      <StatusBadge status={run.status} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <ul className="divide-y divide-white/5 text-sm sm:hidden">
            {runs.map((run) => {
              const delta = formatDelta(
                run.beforeTotalCents,
                run.afterTotalCents
              );
              const trigger = run.triggeredBy
                ? (usersById.get(run.triggeredBy) ?? run.triggeredBy)
                : "—";
              return (
                <li key={run.id} className="space-y-2 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-zinc-200">
                      {formatStarted(run.startedAt)}
                    </span>
                    <StatusBadge status={run.status} />
                  </div>
                  <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
                    <dt className="text-zinc-500">Triggered by</dt>
                    <dd className="truncate text-zinc-300">{trigger}</dd>
                    <dt className="text-zinc-500">Scope</dt>
                    <dd className="text-zinc-300">
                      {formatScope(run.scopeFromDate, run.scopeToDate)}
                    </dd>
                    <dt className="text-zinc-500">Rows changed</dt>
                    <dd className="text-zinc-300 tabular-nums">
                      {run.rowsChanged ?? "—"}
                    </dd>
                    <dt className="text-zinc-500">Before → After</dt>
                    <dd
                      className={`tabular-nums ${
                        delta.tone === "down"
                          ? "text-emerald-300"
                          : delta.tone === "up"
                            ? "text-amber-300"
                            : "text-zinc-300"
                      }`}
                    >
                      {delta.label}
                    </dd>
                  </dl>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {total > pageSize && (
        <nav
          aria-label="Audit history pagination"
          className="flex items-center justify-between text-xs text-zinc-500"
        >
          <span>
            Showing {showingFrom}–{showingTo} of {total}
          </span>
          <div className="flex items-center gap-2">
            <PagerLink
              status={status}
              page={page - 1}
              disabled={page <= 1}
              label="← Previous"
            />
            <span className="text-zinc-400">
              Page {page} / {totalPages}
            </span>
            <PagerLink
              status={status}
              page={page + 1}
              disabled={page >= totalPages}
              label="Next →"
            />
          </div>
        </nav>
      )}
    </div>
  );
}

function PagerLink({
  status,
  page,
  disabled,
  label,
}: {
  status: StatusFilter;
  page: number;
  disabled: boolean;
  label: string;
}) {
  if (disabled) {
    return (
      <span className="rounded-md border border-white/5 bg-white/[0.01] px-2 py-1 text-zinc-600">
        {label}
      </span>
    );
  }
  return (
    <Link
      href={buildHref({ status, page })}
      className="rounded-md border border-white/10 bg-white/[0.02] px-2 py-1 text-zinc-300 hover:border-white/20"
    >
      {label}
    </Link>
  );
}

function buildHref({
  status,
  page,
}: {
  status: StatusFilter;
  page: number;
}): string {
  const params = new URLSearchParams();
  if (status !== "all") params.set("recalc_status", status);
  if (page > 1) params.set("recalc_page", String(page));
  const qs = params.toString();
  // Land on the audit-history card with the deep-link anchor (#733).
  return `/dashboard/settings/pricing${qs ? `?${qs}` : ""}#audit-history`;
}
