import { notFound } from "next/navigation";
import Link from "next/link";
import { getCurrentUser, getSessionDetail, type VitalState } from "@/lib/dal";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { SessionVitals } from "@/components/session-vitals";
import { fmtCost, fmtNum, formatDuration, repoName } from "@/lib/format";

/**
 * Session detail page (#99). The id segment is the daemon-emitted
 * `session_id`; we also need the `device_id` to resolve a row, since
 * `(device_id, session_id)` is the composite PK on `session_summaries`.
 *
 * Privacy: no prompt / response / file path content is read, written, or
 * rendered here — see ADR-0083 §1 and `006_session_vitals.sql`. The page
 * shows numeric metrics + traffic-light scores only.
 */
export default async function SessionDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    device?: string;
    days?: string;
    user?: string;
    cursor?: string;
    p?: string;
  }>;
}) {
  const user = await getCurrentUser();
  if (!user?.org_id) return null;

  const { id: sessionId } = await params;
  const sp = await searchParams;
  const { device: deviceId } = sp;
  if (!deviceId) {
    // The composite PK requires both halves; without `device` the page can't
    // disambiguate two daemons that happen to share a session_id. Send the
    // viewer back to the list rather than guessing.
    notFound();
  }

  const session = await getSessionDetail(user, deviceId, sessionId);
  if (!session) notFound();

  const totalTokens =
    Number(session.total_input_tokens) + Number(session.total_output_tokens);

  const backHref = buildSessionsBackHref(sp);

  return (
    <div className="space-y-6">
      <div>
        <Link
          href={backHref}
          className="text-sm text-zinc-400 hover:text-zinc-200"
        >
          ← Sessions
        </Link>
        <h1 className="mt-2 text-xl font-bold">Session {sessionId}</h1>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Session Vitals</CardTitle>
          </CardHeader>
          <CardContent>
            <SessionVitals
              contextDrag={{
                state: toState(session.vital_context_drag_state),
                metric: toMetric(session.vital_context_drag_metric),
              }}
              cacheEfficiency={{
                state: toState(session.vital_cache_efficiency_state),
                metric: toMetric(session.vital_cache_efficiency_metric),
              }}
              thrashing={{
                state: toState(session.vital_thrashing_state),
                metric: toMetric(session.vital_thrashing_metric),
              }}
              costAcceleration={{
                state: toState(session.vital_cost_acceleration_state),
                metric: toMetric(session.vital_cost_acceleration_metric),
              }}
              overall={toState(session.vital_overall_state)}
            />
            <p className="mt-4 text-xs text-zinc-500">
              Vitals refresh on the next sync tick — the dashboard does not
              receive live updates.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Summary</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
              <Field label="Provider" value={session.provider} />
              <Field
                label="Started"
                value={
                  session.started_at
                    ? new Date(session.started_at).toLocaleString()
                    : "-"
                }
              />
              <Field label="Repo" value={repoName(session.repo_id)} />
              <Field
                label="Branch"
                value={session.git_branch?.replace(/^refs\/heads\//, "") || "-"}
              />
              <Field
                label="Duration"
                value={formatDuration(
                  session.duration_ms,
                  session.started_at,
                  session.ended_at
                )}
              />
              <Field label="Messages" value={fmtNum(session.message_count)} />
              <Field label="Tokens" value={fmtNum(totalTokens)} />
              <Field
                label="Cost"
                value={fmtCost(Number(session.total_cost_cents))}
              />
            </dl>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-zinc-500">{label}</dt>
      <dd className="mt-0.5 text-zinc-200">{value}</dd>
    </div>
  );
}

// Round-trip the list-page filter/page params (#85) onto the back link so a
// viewer arriving from `/dashboard/sessions?days=…&user=…&cursor=…&p=…`
// returns to the same filtered, paged view. Direct-link visits with no
// referrer params produce a bare `/dashboard/sessions` href.
function buildSessionsBackHref(sp: {
  days?: string;
  user?: string;
  cursor?: string;
  p?: string;
}): string {
  const qs = new URLSearchParams();
  if (sp.days) qs.set("days", sp.days);
  if (sp.user) qs.set("user", sp.user);
  if (sp.cursor) qs.set("cursor", sp.cursor);
  if (sp.p) qs.set("p", sp.p);
  const s = qs.toString();
  return s ? `/dashboard/sessions?${s}` : "/dashboard/sessions";
}

function toState(raw: string | null | undefined): VitalState {
  if (raw === "green" || raw === "yellow" || raw === "red") return raw;
  return null;
}

function toMetric(raw: number | string | null | undefined): number | null {
  if (raw == null) return null;
  const n = typeof raw === "string" ? Number(raw) : raw;
  return Number.isFinite(n) ? n : null;
}
