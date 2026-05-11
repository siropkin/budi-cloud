/**
 * Pure row-mapping helpers for `POST /v1/ingest`.
 *
 * Extracted so the normalization logic (in particular the `started_at`
 * fallback that fixes #14) can be unit-tested without spinning up the full
 * Next.js route handler.
 */

export interface IngestDailyRollup {
  bucket_day: string;
  role: string;
  provider: string;
  model: string;
  repo_id: string;
  git_branch: string;
  ticket?: string | null;
  message_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  cost_cents: number;
  // Surface dimension (#187): which IDE / CLI drove the daemon for this
  // rollup — `vscode`, `cursor`, `jetbrains`, `terminal`, … Optional because
  // older daemons (pre siropkin/budi#701) don't emit it; missing values land
  // as the literal `'unknown'` so all-surface aggregations still see them
  // and the dashboard can render them in the unfiltered "where is the team
  // working?" chart on Overview.
  surface?: string | null;
}

/**
 * Allowed values for the per-vital traffic-light score (#99). Mirrors the
 * `Score::{Green,Yellow,Red}` enum on `VitalScore` in budi-core. The cloud
 * mirrors the column-level CHECK in `006_session_vitals.sql`, but we also
 * filter at the ingest layer so a malformed envelope never reaches the
 * database in the first place.
 */
export type VitalState = "green" | "yellow" | "red";

const VITAL_STATE_VALUES: ReadonlySet<string> = new Set([
  "green",
  "yellow",
  "red",
]);

function normalizeVitalState(raw: unknown): VitalState | null {
  if (typeof raw !== "string") return null;
  return VITAL_STATE_VALUES.has(raw) ? (raw as VitalState) : null;
}

function normalizeVitalMetric(raw: unknown): number | null {
  if (typeof raw !== "number") return null;
  return Number.isFinite(raw) ? raw : null;
}

/**
 * Per-field upper bounds for the headline metric columns (#178).
 *
 * Token columns are BIGINT (`001_ingest_schema.sql`) but a single rollup row
 * representing more than 10 billion tokens is almost certainly a bug — real
 * heavy-user rollups land in the millions. Capping silently here prevents a
 * single corrupt envelope from poisoning the auto-ranged dashboard charts for
 * the full 90-day retention window, while a strict validator (see
 * `validateIngestMetrics`) rejects obviously malformed inputs (NaN/-Inf) with
 * 422 so the daemon backs off instead of looping.
 *
 * `cost_cents` is `NUMERIC(12,4)` (max ≈ 1e8 before overflow), so its cap is
 * tighter than the suggested 1e9 in #178 — a single rollup row at $1M of cost
 * is already well past the bug horizon.
 */
export const METRIC_CAPS = {
  message_count: 1e7,
  input_tokens: 1e10,
  output_tokens: 1e10,
  cache_creation_tokens: 1e10,
  cache_read_tokens: 1e10,
  cost_cents: 1e8,
  total_input_tokens: 1e10,
  total_output_tokens: 1e10,
  total_cost_cents: 1e8,
} as const;

/**
 * Returns true iff `raw` is a finite, non-negative `number`. Used to gate
 * the headline metric columns at the envelope-validation layer (#178) so a
 * NaN/-Infinity/negative value triggers a 422 — that's the daemon-pause
 * signal documented in ADR-0083 §7 — rather than landing as a silent zero.
 */
export function isValidNonNegativeNumber(raw: unknown): raw is number {
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0;
}

/**
 * Coerce a numeric metric to `[0, max]`. Defense-in-depth alongside
 * `validateIngestMetrics`: if the validator misses a path or a future
 * non-validated field is added, this still floors the value into a sane
 * range before it reaches the database.
 */
function safeNonNegativeNumber(raw: unknown, max: number): number {
  if (!isValidNonNegativeNumber(raw)) return 0;
  return Math.min(raw, max);
}

const ROLLUP_METRIC_FIELDS = [
  "message_count",
  "input_tokens",
  "output_tokens",
  "cache_creation_tokens",
  "cache_read_tokens",
  "cost_cents",
] as const satisfies ReadonlyArray<keyof IngestDailyRollup>;

const SESSION_METRIC_FIELDS = [
  "message_count",
  "total_input_tokens",
  "total_output_tokens",
  "total_cost_cents",
] as const satisfies ReadonlyArray<keyof IngestSessionSummary>;

/**
 * Walks the envelope's rollups and session summaries, returning a 422-style
 * error message on the first non-finite or negative numeric metric.
 *
 * Per #178: cost and token counts drive every dashboard card and are summed
 * across the 90-day retention window. A single bad row (NaN, -1, Infinity)
 * silently corrupts every aggregate that touches it. Reject loudly so the
 * daemon pauses (ADR-0083 §7) instead of spraying garbage on retry.
 */
export function validateIngestMetrics(
  rollups: IngestDailyRollup[],
  sessions: IngestSessionSummary[]
): string | null {
  for (let i = 0; i < rollups.length; i++) {
    const r = rollups[i];
    for (const f of ROLLUP_METRIC_FIELDS) {
      if (!isValidNonNegativeNumber(r[f])) {
        return `daily_rollups[${i}].${f} must be a finite, non-negative number`;
      }
    }
  }
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    for (const f of SESSION_METRIC_FIELDS) {
      if (!isValidNonNegativeNumber(s[f])) {
        return `session_summaries[${i}].${f} must be a finite, non-negative number`;
      }
    }
  }
  return null;
}

// Cap on the stored surface tag so a malformed envelope can't store an
// unbounded string and the dashboard's chip dropdown stays readable. Real
// daemon-side values are short (`vscode`, `jetbrains`, …); 64 is comfortably
// above that ceiling.
const MAX_SURFACE_LENGTH = 64;

/**
 * Per-field upper bounds for the user-controlled string columns ingest writes
 * (#177). The label cap on `devices.label` (128) lives in `route.ts` and
 * documents the same intent: a malformed or compromised envelope must not
 * land hundreds of KiB on a single column, slowing every dashboard query
 * for the 90-day retention window and overflowing the rendered table cells.
 *
 * The numbers track the worst plausible real-world value, not the worst
 * theoretical one — branch names occasionally embed long ticket slugs but
 * never approach 256 chars; session ids are typically UUIDs or short
 * tool-emitted strings well under 128. Migration 018 mirrors these caps as
 * column-level CHECK constraints so a future ingest path that forgets to
 * call the row-builder still can't bypass them.
 */
export const STRING_CAPS = {
  session_id: 128,
  provider: 64,
  model: 128,
  role: 32,
  repo_id: 128,
  git_branch: 256,
  ticket: 64,
} as const;

/**
 * Truncate a string to `max` chars. Non-string inputs (null, undefined,
 * numbers, …) pass through unchanged so the existing NOT NULL / type
 * mismatch error paths still trip — this cap is purely defense-in-depth
 * against unbounded length, not a coercion layer.
 */
function capString<T>(raw: T, max: number): T {
  if (typeof raw === "string") return raw.slice(0, max) as T;
  return raw;
}

/**
 * Normalize the envelope's `surface` value. The cloud column is `NOT NULL
 * DEFAULT 'unknown'` (014), so we coalesce missing / invalid / empty inputs
 * to that literal rather than letting the daemon's omission collapse the
 * row out of all-surface aggregations. Whitespace is trimmed and length is
 * capped before storage.
 */
function normalizeSurface(raw: unknown): string {
  if (typeof raw !== "string") return "unknown";
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "unknown";
  return trimmed.slice(0, MAX_SURFACE_LENGTH);
}

/**
 * Diagnostic for #204. The receiving cloud knows exactly what `surface` /
 * `provider` values it persisted for this envelope; echoing the sorted-unique
 * sets back in the ingest response lets `budi cloud sync` (or `curl`) show
 * the operator whether named surfaces are arriving at all, without having to
 * pull cloud logs or open the dashboard.
 *
 * If `surfaces_seen === ["unknown"]` and the dashboard reports the same shape,
 * the gap is daemon-side (envelope never carried the field). If the daemon
 * sent named surfaces but the dashboard still aggregates everything as
 * "unknown", the gap is somewhere between this point and the rendered chart.
 *
 * Costs nothing on the hot path: one pass over the already-built row arrays,
 * Set-deduped, capped at the same `MAX_*_SEEN` to bound the response body.
 */
const MAX_SURFACES_SEEN = 32;
const MAX_PROVIDERS_SEEN = 32;

export function summarizeEnvelope(
  rollupRows: ReadonlyArray<{ surface: string; provider: string }>,
  sessionRows: ReadonlyArray<{ surface: string; provider: string }>
): { surfaces_seen: string[]; providers_seen: string[] } {
  const surfaces = new Set<string>();
  const providers = new Set<string>();
  for (const r of rollupRows) {
    surfaces.add(r.surface);
    providers.add(r.provider);
  }
  for (const s of sessionRows) {
    surfaces.add(s.surface);
    providers.add(s.provider);
  }
  return {
    surfaces_seen: [...surfaces].sort().slice(0, MAX_SURFACES_SEEN),
    providers_seen: [...providers].sort().slice(0, MAX_PROVIDERS_SEEN),
  };
}

export interface IngestSessionSummary {
  session_id: string;
  provider: string;
  started_at?: string | null;
  ended_at?: string | null;
  duration_ms?: number | null;
  repo_id?: string | null;
  git_branch?: string | null;
  ticket?: string | null;
  message_count: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_cents: number;
  // Per-session "main" model (#140). The model that consumed the largest
  // share of total (input + output) tokens for the session — see the
  // 009_session_main_model.sql migration for the full definition. Optional
  // because older daemons (< 8.3.16) don't emit it, and the daemon
  // legitimately omits it for sessions with zero scored messages.
  primary_model?: string | null;
  // Vitals (#99). Optional — older daemons (< 8.3.15) omit these, and budi-core
  // legitimately skips emission for sessions with too few assistant messages.
  vital_context_drag_state?: string | null;
  vital_context_drag_metric?: number | null;
  vital_cache_efficiency_state?: string | null;
  vital_cache_efficiency_metric?: number | null;
  vital_thrashing_state?: string | null;
  vital_thrashing_metric?: number | null;
  vital_cost_acceleration_state?: string | null;
  vital_cost_acceleration_metric?: number | null;
  vital_overall_state?: string | null;
  // Surface dimension (#187). Same shape and rationale as the rollup field —
  // missing values fall through to the literal `'unknown'` so the Sessions
  // table never has a null hole in the column.
  surface?: string | null;
}

export function buildRollupRows(
  deviceId: string,
  syncedAt: string,
  rollups: IngestDailyRollup[]
) {
  return rollups.map((r) => ({
    device_id: deviceId,
    bucket_day: r.bucket_day,
    // #177: cap every user-controlled string column so a malformed daemon
    // (or a leaked API key) can't land hundreds of KiB on a single field.
    role: capString(r.role, STRING_CAPS.role),
    provider: capString(r.provider, STRING_CAPS.provider),
    model: capString(r.model, STRING_CAPS.model),
    repo_id: capString(r.repo_id, STRING_CAPS.repo_id),
    git_branch: capString(r.git_branch, STRING_CAPS.git_branch),
    ticket: capString(r.ticket ?? null, STRING_CAPS.ticket),
    // #178: every numeric metric is coerced to a finite, non-negative value
    // capped per `METRIC_CAPS` before storage. The route's
    // `validateIngestMetrics` already rejects bad inputs with 422; the
    // coercion here is defense-in-depth so a future ingest path that forgets
    // to validate still can't corrupt the dashboard's auto-ranging.
    message_count: safeNonNegativeNumber(
      r.message_count,
      METRIC_CAPS.message_count
    ),
    input_tokens: safeNonNegativeNumber(
      r.input_tokens,
      METRIC_CAPS.input_tokens
    ),
    output_tokens: safeNonNegativeNumber(
      r.output_tokens,
      METRIC_CAPS.output_tokens
    ),
    cache_creation_tokens: safeNonNegativeNumber(
      r.cache_creation_tokens,
      METRIC_CAPS.cache_creation_tokens
    ),
    cache_read_tokens: safeNonNegativeNumber(
      r.cache_read_tokens,
      METRIC_CAPS.cache_read_tokens
    ),
    // #231: write both cost columns. The daemon-uploaded value lives in
    // `_ingested`; the dashboard-facing value lives in `_effective`. Until the
    // recalculation engine (#233) rewrites `_effective` from a team price
    // list, the two columns are equal on every freshly-ingested row.
    cost_cents_ingested: safeNonNegativeNumber(
      r.cost_cents,
      METRIC_CAPS.cost_cents
    ),
    cost_cents_effective: safeNonNegativeNumber(
      r.cost_cents,
      METRIC_CAPS.cost_cents
    ),
    surface: normalizeSurface(r.surface),
    synced_at: syncedAt,
  }));
}

/**
 * Build `session_summaries` rows to upsert.
 *
 * Fix for #14: some providers (e.g. `claude_code`) create local session rows
 * without ever setting `started_at`, so the daemon legitimately ships session
 * summaries with no `started_at`. `session_summaries.started_at` is a nullable
 * TIMESTAMPTZ in the ingest schema, but the dashboard Sessions page filters
 * by that column (`.gte("started_at", range.from)`), so rows with NULL
 * `started_at` silently disappear. We coalesce to `ended_at`, then the
 * envelope's `synced_at`, guaranteeing every row is visible to the dashboard
 * and that an already-set `started_at` never gets clobbered with NULL on
 * subsequent upserts.
 */
export function buildSessionRows(
  deviceId: string,
  syncedAt: string,
  sessions: IngestSessionSummary[]
) {
  return sessions.map((s) => ({
    device_id: deviceId,
    // #177: matches `buildRollupRows` — every user-controlled string is
    // length-capped before storage. See STRING_CAPS for the per-field bounds.
    session_id: capString(s.session_id, STRING_CAPS.session_id),
    provider: capString(s.provider, STRING_CAPS.provider),
    started_at: s.started_at ?? s.ended_at ?? syncedAt,
    ended_at: s.ended_at ?? null,
    duration_ms: s.duration_ms ?? null,
    repo_id: capString(s.repo_id ?? null, STRING_CAPS.repo_id),
    git_branch: capString(s.git_branch ?? null, STRING_CAPS.git_branch),
    ticket: capString(s.ticket ?? null, STRING_CAPS.ticket),
    // #178: see the matching note in `buildRollupRows` — coerce + cap the
    // headline session metrics so a malformed value can't poison the
    // dashboard's session-level aggregates.
    message_count: safeNonNegativeNumber(
      s.message_count,
      METRIC_CAPS.message_count
    ),
    total_input_tokens: safeNonNegativeNumber(
      s.total_input_tokens,
      METRIC_CAPS.total_input_tokens
    ),
    total_output_tokens: safeNonNegativeNumber(
      s.total_output_tokens,
      METRIC_CAPS.total_output_tokens
    ),
    // #231: see the matching note in `buildRollupRows` — every freshly
    // ingested session lands with `_effective == _ingested`; the recalc
    // engine (#233) is the only path that can ever decouple them.
    total_cost_cents_ingested: safeNonNegativeNumber(
      s.total_cost_cents,
      METRIC_CAPS.total_cost_cents
    ),
    total_cost_cents_effective: safeNonNegativeNumber(
      s.total_cost_cents,
      METRIC_CAPS.total_cost_cents
    ),
    main_model: capString(s.primary_model ?? null, STRING_CAPS.model),
    // Vitals (#99). Each field is normalized independently so a daemon that
    // emits e.g. only the overall state (or only some vitals) still lands the
    // partial signal — the dashboard already renders missing slots as a
    // dash.
    vital_context_drag_state: normalizeVitalState(s.vital_context_drag_state),
    vital_context_drag_metric: normalizeVitalMetric(
      s.vital_context_drag_metric
    ),
    vital_cache_efficiency_state: normalizeVitalState(
      s.vital_cache_efficiency_state
    ),
    vital_cache_efficiency_metric: normalizeVitalMetric(
      s.vital_cache_efficiency_metric
    ),
    vital_thrashing_state: normalizeVitalState(s.vital_thrashing_state),
    vital_thrashing_metric: normalizeVitalMetric(s.vital_thrashing_metric),
    vital_cost_acceleration_state: normalizeVitalState(
      s.vital_cost_acceleration_state
    ),
    vital_cost_acceleration_metric: normalizeVitalMetric(
      s.vital_cost_acceleration_metric
    ),
    vital_overall_state: normalizeVitalState(s.vital_overall_state),
    surface: normalizeSurface(s.surface),
    synced_at: syncedAt,
  }));
}
