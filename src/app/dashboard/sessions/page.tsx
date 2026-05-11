import { Suspense } from "react";
import Link from "next/link";
import {
  getCurrentUser,
  getEarliestActivity,
  getKnownSurfaces,
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
  formatProvider,
  repoName,
} from "@/lib/format";
import { PeriodSelector } from "@/components/period-selector";
import { UnitsSelector } from "@/components/units-selector";
import { UserFilter } from "@/components/user-filter";
import { SurfaceFilter } from "@/components/surface-filter";
import { parseSurfaceParam } from "@/lib/surface";
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
    surface?: string;
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
  const surfaces = parseSurfaceParam(params.surface);
  const scope = { scopedUserId: params.user || null, surfaces };
  const earliestActivity =
    params.days === ALL_PERIOD_VALUE
      ? await getEarliestActivity(user, scope)
      : null;
  const tz = await getViewerTimeZone();
  const range = dateRangeFromDays(params.days, earliestActivity, tz);
  const cursor = decodeSessionsCursor(params.cursor);
  const page = parsePage(params.p);

  const [{ rows: sessions, nextCursor }, members, knownSurfaces] =
    await Promise.all([
      getSessions(user, range, scope, { cursor }),
      isManager ? getOrgMembers(user.org_id) : Promise.resolve([]),
      getKnownSurfaces(user, { scopedUserId: scope.scopedUserId }),
    ]);

  const startIndex = (page - 1) * SESSIONS_PAGE_SIZE + 1;
  const endIndex = startIndex + sessions.length - 1;
  const hasNext = nextCursor !== null;
  const hasFirst = page > 1;

  // Preserve the period, unit, and user-filter params across page boundaries
  // (#85 acceptance: "Period selector + user filter both preserved across
  // page boundaries"). Build link params off the *current* search params so
  // any future filter we add is automatically carried.
  const baseParams = new URLSearchParams();
  if (params.days) baseParams.set("days", params.days);
  if (params.user) baseParams.set("user", params.user);
  if (params.units) baseParams.set("units", params.units);
  if (params.surface) baseParams.set("surface", params.surface);

  const firstParams = new URLSearchParams(baseParams);
  // "First" jumps back to page 1 — drops cursor and `p`. The forward-only
  // cursor scheme (#85) can't cheaply step back one page, so we expose only
  // the affordances that actually work: « First and Next ›. The absence of
  // a per-page Prev is signalled by the labels themselves (#197) — earlier
  // copy ("← Newest") read as "previous page" and surprised users who had
  // paged forward several times. Browser back still walks one page at a
  // time for users who need it.

  const nextParams = new URLSearchParams(baseParams);
  if (nextCursor) {
    nextParams.set("cursor", encodeSessionsCursor(nextCursor));
    nextParams.set("p", String(page + 1));
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-xl font-bold">Sessions</h1>
        <Suspense>
          <div className="flex flex-wrap items-center gap-3">
            <UserFilter members={members} role={user.role} />
            <SurfaceFilter surfaces={knownSurfaces} />
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
              : `Recent Sessions (showing ${startIndex.toLocaleString()}–${endIndex.toLocaleString()}${hasNext ? "+" : ""})`}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {sessions.length === 0 ? (
            <p className="py-8 text-center text-sm text-zinc-500">
              No sessions found for this period
            </p>
          ) : (
            <div className="relative">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-white/10 text-left text-zinc-400">
                      {isManager && (
                        <th className="pr-3 pb-2 font-medium whitespace-nowrap">
                          Member
                        </th>
                      )}
                      <th className="pr-3 pb-2 font-medium whitespace-nowrap">
                        Provider
                      </th>
                      <th className="pr-3 pb-2 font-medium whitespace-nowrap">
                        Model
                      </th>
                      <th className="pr-3 pb-2 font-medium whitespace-nowrap">
                        Started
                      </th>
                      <th className="pr-3 pb-2 font-medium whitespace-nowrap">
                        Duration
                      </th>
                      <th className="pr-3 pb-2 font-medium whitespace-nowrap">
                        Repo
                      </th>
                      <th className="pr-3 pb-2 font-medium whitespace-nowrap">
                        Branch
                      </th>
                      <th className="pr-3 pb-2 text-right font-medium whitespace-nowrap">
                        Messages
                      </th>
                      <th className="pb-2 text-right font-medium whitespace-nowrap">
                        {isTokens ? "Tokens" : "Cost"}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {sessions.map((s) => {
                      const href = `/dashboard/sessions/${encodeURIComponent(
                        s.session_id
                      )}`;
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
                                className="block max-w-[20ch] truncate py-2 pr-3 whitespace-nowrap"
                              >
                                {s.owner_name ?? "-"}
                              </Link>
                            </td>
                          )}
                          <td
                            className="text-zinc-300"
                            title={formatProvider(s.provider)}
                          >
                            <Link
                              href={href}
                              className="block max-w-[16ch] truncate py-2 pr-3 whitespace-nowrap"
                            >
                              {formatProvider(s.provider)}
                            </Link>
                          </td>
                          <td
                            className="text-zinc-400"
                            title={s.main_model ?? undefined}
                          >
                            <Link
                              href={href}
                              className="block max-w-[16ch] truncate py-2 pr-3 whitespace-nowrap"
                            >
                              {s.main_model
                                ? formatModelName(s.main_model)
                                : "-"}
                            </Link>
                          </td>
                          <td
                            className="text-zinc-400"
                            title={
                              s.started_at
                                ? new Date(s.started_at).toLocaleString()
                                : undefined
                            }
                          >
                            <Link
                              href={href}
                              className="block max-w-[14ch] truncate py-2 pr-3 whitespace-nowrap"
                            >
                              {formatTimestamp(s.started_at)}
                            </Link>
                          </td>
                          <td className="text-zinc-400">
                            <Link
                              href={href}
                              className="block max-w-[10ch] truncate py-2 pr-3 whitespace-nowrap"
                            >
                              {formatDuration(
                                s.duration_ms,
                                s.started_at,
                                s.ended_at
                              )}
                            </Link>
                          </td>
                          <td
                            className="text-zinc-400"
                            title={repoName(s.repo_id) || undefined}
                          >
                            <Link
                              href={href}
                              className="block max-w-[16ch] truncate py-2 pr-3 whitespace-nowrap"
                            >
                              {repoName(s.repo_id)}
                            </Link>
                          </td>
                          <td
                            className="text-zinc-400"
                            title={
                              s.git_branch?.replace(/^refs\/heads\//, "") ||
                              undefined
                            }
                          >
                            <Link
                              href={href}
                              className="block max-w-[16ch] truncate py-2 pr-3 whitespace-nowrap"
                            >
                              {s.git_branch?.replace(/^refs\/heads\//, "") ||
                                "-"}
                            </Link>
                          </td>
                          <td className="text-right tabular-nums text-zinc-300">
                            <Link
                              href={href}
                              className="block py-2 pr-3 whitespace-nowrap"
                            >
                              {fmtNum(s.message_count)}
                            </Link>
                          </td>
                          <td className="text-right tabular-nums text-zinc-200">
                            <Link
                              href={href}
                              className="block py-2 whitespace-nowrap"
                            >
                              {isTokens
                                ? fmtNum(
                                    Number(s.total_input_tokens) +
                                      Number(s.total_output_tokens)
                                  )
                                : fmtCost(Number(s.total_cost_cents_effective))}
                            </Link>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {/* Right-edge fade hints at horizontal scroll on narrow viewports
                  (#173). Visible only when columns overflow — the wider table
                  lives behind it. */}
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-[#0a0a0a] to-transparent sm:hidden"
              />
            </div>
          )}

          {(hasNext || hasFirst) && (
            <nav
              aria-label="Sessions pagination"
              className="mt-4 flex items-center justify-between gap-3 border-t border-white/5 pt-3 text-sm"
            >
              <div>
                {hasFirst ? (
                  <Link
                    href={buildHref(firstParams)}
                    aria-label="Jump to first page"
                    className="rounded-md px-3 py-1.5 font-medium text-zinc-300 transition-colors hover:bg-white/5 hover:text-white"
                  >
                    « First
                  </Link>
                ) : (
                  <span aria-hidden="true" />
                )}
              </div>
              <div>
                {hasNext && (
                  <Link
                    href={buildHref(nextParams)}
                    aria-label="Next page"
                    className="rounded-md px-3 py-1.5 font-medium text-zinc-300 transition-colors hover:bg-white/5 hover:text-white"
                  >
                    Next ›
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
