import { Suspense } from "react";
import Link from "next/link";
import {
  getCurrentUser,
  getEarliestActivity,
  getOrgMembers,
  getSessions,
  SESSIONS_PAGE_SIZE,
} from "@/lib/dal";
import {
  decodeSessionsCursor,
  encodeSessionsCursor,
} from "@/lib/sessions-cursor";
import { dateRangeFromDays } from "@/lib/date-range";
import { getViewerTimeZone } from "@/lib/viewer-timezone";
import { ALL_PERIOD_VALUE } from "@/lib/periods";
import { parseUnit } from "@/lib/units";
import {
  fmtCost,
  fmtNum,
  formatDuration,
  formatModelName,
  repoName,
} from "@/lib/format";
import { PeriodSelector } from "@/components/period-selector";
import { UnitsSelector } from "@/components/units-selector";
import { UserFilter } from "@/components/user-filter";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

function formatTimestamp(ts: string | null): string {
  if (!ts) return "-";
  return new Date(ts).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function parsePage(raw: string | undefined): number {
  if (!raw) return 1;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

function buildHref(params: URLSearchParams): string {
  const qs = params.toString();
  return qs ? `?${qs}` : "?";
}

export default async function SessionsPage({
  searchParams,
}: {
  searchParams: Promise<{
    days?: string;
    user?: string;
    units?: string;
    cursor?: string;
    p?: string;
  }>;
}) {
  const params = await searchParams;
  const user = await getCurrentUser();
  if (!user?.org_id) return null;

  const unit = parseUnit(params.units);
  const isTokens = unit === "tokens";
  const isManager = user.role === "manager";
  const scope = { scopedUserId: params.user || null };
  const earliestActivity =
    params.days === ALL_PERIOD_VALUE
      ? await getEarliestActivity(user, scope)
      : null;
  const tz = await getViewerTimeZone();
  const range = dateRangeFromDays(params.days, earliestActivity, tz);
  const cursor = decodeSessionsCursor(params.cursor);
  const page = parsePage(params.p);

  const [{ rows: sessions, nextCursor }, members] = await Promise.all([
    getSessions(user, range, scope, { cursor }),
    isManager ? getOrgMembers(user.org_id) : Promise.resolve([]),
  ]);

  const startIndex = (page - 1) * SESSIONS_PAGE_SIZE + 1;
  const endIndex = startIndex + sessions.length - 1;
  const hasOlder = nextCursor !== null;
  const hasNewer = page > 1;

  // Preserve the period, unit, and user-filter params across page boundaries
  // (#85 acceptance: "Period selector + user filter both preserved across
  // page boundaries"). Build link params off the *current* search params so
  // any future filter we add is automatically carried.
  const baseParams = new URLSearchParams();
  if (params.days) baseParams.set("days", params.days);
  if (params.user) baseParams.set("user", params.user);
  if (params.units) baseParams.set("units", params.units);

  const newerParams = new URLSearchParams(baseParams);
  // "Newer" returns to the first page — drops cursor and `p`. Browser back
  // remains the way to walk one page at a time, per the cursor scheme in #85.

  const olderParams = new URLSearchParams(baseParams);
  if (nextCursor) {
    olderParams.set("cursor", encodeSessionsCursor(nextCursor));
    olderParams.set("p", String(page + 1));
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-xl font-bold">Sessions</h1>
        <Suspense>
          <div className="flex flex-wrap items-center gap-3">
            <UserFilter members={members} role={user.role} />
            <UnitsSelector />
            <PeriodSelector />
          </div>
        </Suspense>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            {sessions.length === 0
              ? "Recent Sessions"
              : `Recent Sessions (showing ${startIndex.toLocaleString()}–${endIndex.toLocaleString()}${hasOlder ? "+" : ""})`}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {sessions.length === 0 ? (
            <p className="py-8 text-center text-sm text-zinc-500">
              No sessions found for this period
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/10 text-left text-zinc-400">
                    {isManager && (
                      <th className="pr-3 pb-2 font-medium">Member</th>
                    )}
                    <th className="pr-3 pb-2 font-medium">Provider</th>
                    <th className="pr-3 pb-2 font-medium">Model</th>
                    <th className="pr-3 pb-2 font-medium">Started</th>
                    <th className="pr-3 pb-2 font-medium">Duration</th>
                    <th className="pr-3 pb-2 font-medium">Repo</th>
                    <th className="pr-3 pb-2 font-medium">Branch</th>
                    <th className="pr-3 pb-2 text-right font-medium">
                      Messages
                    </th>
                    <th className="pb-2 text-right font-medium">
                      {isTokens ? "Tokens" : "Cost"}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((s) => {
                    const href = `/dashboard/sessions/${encodeURIComponent(
                      s.session_id
                    )}?device=${encodeURIComponent(s.device_id)}`;
                    return (
                      <tr
                        key={`${s.device_id}-${s.session_id}`}
                        className="border-b border-white/5 transition-colors hover:bg-white/5"
                      >
                        {isManager && (
                          <td
                            className="text-zinc-300"
                            title={s.owner_name ?? undefined}
                          >
                            <Link
                              href={href}
                              className="block max-w-[20ch] truncate py-2 pr-3"
                            >
                              {s.owner_name ?? "-"}
                            </Link>
                          </td>
                        )}
                        <td className="text-zinc-300">
                          <Link href={href} className="block py-2 pr-3">
                            {s.provider}
                          </Link>
                        </td>
                        <td
                          className="text-zinc-400"
                          title={s.main_model ?? undefined}
                        >
                          <Link
                            href={href}
                            className="block max-w-[16ch] truncate py-2 pr-3"
                          >
                            {s.main_model ? formatModelName(s.main_model) : "-"}
                          </Link>
                        </td>
                        <td className="text-zinc-400">
                          <Link href={href} className="block py-2 pr-3">
                            {formatTimestamp(s.started_at)}
                          </Link>
                        </td>
                        <td className="text-zinc-400">
                          <Link href={href} className="block py-2 pr-3">
                            {formatDuration(
                              s.duration_ms,
                              s.started_at,
                              s.ended_at
                            )}
                          </Link>
                        </td>
                        <td className="text-zinc-400">
                          <Link href={href} className="block py-2 pr-3">
                            {repoName(s.repo_id)}
                          </Link>
                        </td>
                        <td className="text-zinc-400">
                          <Link href={href} className="block py-2 pr-3">
                            {s.git_branch?.replace(/^refs\/heads\//, "") || "-"}
                          </Link>
                        </td>
                        <td className="text-right tabular-nums text-zinc-300">
                          <Link href={href} className="block py-2 pr-3">
                            {fmtNum(s.message_count)}
                          </Link>
                        </td>
                        <td className="text-right tabular-nums text-zinc-200">
                          <Link href={href} className="block py-2">
                            {isTokens
                              ? fmtNum(
                                  Number(s.total_input_tokens) +
                                    Number(s.total_output_tokens)
                                )
                              : fmtCost(Number(s.total_cost_cents))}
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {(hasOlder || hasNewer) && (
            <nav
              aria-label="Sessions pagination"
              className="mt-4 flex items-center justify-between gap-3 border-t border-white/5 pt-3 text-sm"
            >
              <div>
                {hasNewer ? (
                  <Link
                    href={buildHref(newerParams)}
                    className="rounded-md px-3 py-1.5 font-medium text-zinc-300 transition-colors hover:bg-white/5 hover:text-white"
                  >
                    ← Newest
                  </Link>
                ) : (
                  <span aria-hidden="true" />
                )}
              </div>
              <div>
                {hasOlder && (
                  <Link
                    href={buildHref(olderParams)}
                    className="rounded-md px-3 py-1.5 font-medium text-zinc-300 transition-colors hover:bg-white/5 hover:text-white"
                  >
                    Older →
                  </Link>
                )}
              </div>
            </nav>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
