import { notFound } from "next/navigation";
import Link from "next/link";
import {
  getCurrentUser,
  getSessionDetail,
  getSessionDetailBySessionId,
} from "@/lib/dal";
import { SessionTokenComposition } from "@/components/session-token-composition";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import {
  buildCostCellTooltip,
  fmtCost,
  fmtNum,
  formatDuration,
  formatModelName,
  formatProvider,
  repoName,
} from "@/lib/format";
import { formatSurface } from "@/lib/surface";

/**
 * Session detail page (#99). The id segment is the daemon-emitted
 * `session_id`; we also need the `device_id` to resolve a row, since
 * `(device_id, session_id)` is the composite PK on `session_summaries`.
 *
 * Privacy: no prompt / response / file path content is read, written, or
 * rendered here — see ADR-0083 §1. The page shows numeric metrics only.
 *
 * The Session Vitals card was removed in #141: the cloud schema and ingest
 * still accept `vital_*` columns (006_session_vitals.sql), but the daemon
 * never actually emitted them — `SessionSummaryRecord` in
 * `siropkin/budi:crates/budi-core/src/cloud_sync.rs` has no vital fields and
 * no commit in that repo's history has ever populated one. Every viewer
 * therefore saw a permanently-empty card. The DB columns are left in place
 * (dormant) so a future daemon release can light the card back up without a
 * migration.
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
    units?: string;
    cursor?: string;
    p?: string;
  }>;
}) {
  const user = await getCurrentUser();
  if (!user?.org_id) return null;

  const { id: sessionId } = await params;
  const sp = await searchParams;
  const { device: deviceId } = sp;
  // Deep-link entry (#202): a session URL pasted from chat / a ticket
  // typically lacks `?device=`. In that case fall back to a session_id-only
  // lookup scoped to the viewer's visible devices. The composite PK is
  // `(device_id, session_id)`, so this can be ambiguous in principle — the
  // DAL returns null on >1 match to keep the privacy contract intact.
  const session = deviceId
    ? await getSessionDetail(user, deviceId, sessionId)
    : await getSessionDetailBySessionId(user, sessionId);
  if (!session) notFound();

  const isManager = user.role === "manager";
  const inputTokens = Number(session.total_input_tokens);
  const outputTokens = Number(session.total_output_tokens);
  const totalTokens = inputTokens + outputTokens;
  // Output-only rows (#168): May-2026+ VS Code Copilot Chat builds drop
  // prompt-token counts on disk, so the daemon ships rows with
  // `input_tokens = 0` and a non-zero `output_tokens`. A bare "0" in the
  // Tokens row would read as missing data; tag the breakdown so a viewer
  // looking at one of these sessions sees the state honestly.
  const isOutputOnly = inputTokens === 0 && outputTokens > 0;

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
        {/* Session id is a long opaque string; truncate so the header stays
            scannable on narrow widths and surface the full id via the title
            attribute for copy-paste. When the daemon resolves a session title
            (#256), surface it as the primary handle and demote the hash to a
            subtitle — the title (e.g. `Verkada-Web`, `chat-agent`) is the most
            human-readable thing on the page. */}
        {session.title ? (
          <>
            <h1
              className="mt-2 truncate text-xl font-bold"
              title={session.title}
            >
              {session.title}
            </h1>
            <p
              className="mt-1 truncate font-mono text-xs text-zinc-500"
              title={sessionId}
            >
              {sessionId}
            </p>
          </>
        ) : (
          <h1
            className="mt-2 truncate text-xl font-bold"
            title={`Session ${sessionId}`}
          >
            Session{" "}
            <span className="font-mono text-base font-medium text-zinc-300">
              {sessionId}
            </span>
          </h1>
        )}
      </div>

      {/*
        Two-section row (#203 follow-up). The original single-card Summary
        crammed identity (who / what / where) and activity (when / how
        much) into one undifferentiated dl-grid, which left a viewer
        pivoting between unrelated rows. Splitting into a Context card +
        an Activity card means a manager scanning "is this an expensive
        Cursor session on the auth-rewrite branch?" reads each thread in
        one place. Stacks at sm; sits side-by-side at lg+.
      */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Context</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
              {isManager && (
                <Field label="Member" value={session.owner_name ?? "-"} />
              )}
              <Field
                label="Provider"
                value={formatProvider(session.provider)}
              />
              <Field label="Surface" value={formatSurface(session.surface)} />
              <Field
                label="Model"
                value={
                  session.main_model ? formatModelName(session.main_model) : "-"
                }
              />
              <Field label="Repo" value={repoName(session.repo_id)} />
              <Field
                label="Branch"
                value={session.git_branch?.replace(/^refs\/heads\//, "") || "-"}
              />
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Activity</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
              <Field
                label="Started"
                value={
                  session.started_at
                    ? new Date(session.started_at).toLocaleString()
                    : "-"
                }
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
              <Field
                label="Tokens"
                value={
                  isOutputOnly
                    ? `${fmtNum(totalTokens)} (output-only)`
                    : fmtNum(totalTokens)
                }
              />
              <Field
                label="Cost"
                value={fmtCost(Number(session.total_cost_cents_effective))}
                title={buildCostCellTooltip(
                  Number(session.total_cost_cents_ingested),
                  Number(session.total_cost_cents_effective)
                )}
              />
            </dl>
            {/*
              Token composition bar (#215). Sits beneath the Activity dl so
              the input-vs-output split reads alongside the Tokens / Cost
              pair instead of duplicating that field above. Hidden entirely
              when both halves are 0 — a 0-width bar would read as a broken
              UI element rather than an empty session.
            */}
            <SessionTokenComposition
              inputTokens={inputTokens}
              outputTokens={outputTokens}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  title,
}: {
  label: string;
  value: string | number;
  /** Override the default value-as-title tooltip — used by the cost field to
   * show "List: $X / Effective: $Y" when team pricing changed the number
   * (#733). When omitted, falls back to the rendered value. */
  title?: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs uppercase tracking-wide text-zinc-500">{label}</dt>
      <dd
        className="mt-0.5 truncate whitespace-nowrap text-zinc-200"
        title={title ?? (typeof value === "string" ? value : String(value))}
      >
        {value}
      </dd>
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
  units?: string;
  cursor?: string;
  p?: string;
}): string {
  const qs = new URLSearchParams();
  if (sp.days) qs.set("days", sp.days);
  if (sp.user) qs.set("user", sp.user);
  if (sp.units) qs.set("units", sp.units);
  if (sp.cursor) qs.set("cursor", sp.cursor);
  if (sp.p) qs.set("p", sp.p);
  const s = qs.toString();
  return s ? `/dashboard/sessions?${s}` : "/dashboard/sessions";
}
