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
}

export function buildRollupRows(
  deviceId: string,
  syncedAt: string,
  rollups: IngestDailyRollup[]
) {
  return rollups.map((r) => ({
    device_id: deviceId,
    bucket_day: r.bucket_day,
    role: r.role,
    provider: r.provider,
    model: r.model,
    repo_id: r.repo_id,
    git_branch: r.git_branch,
    ticket: r.ticket ?? null,
    message_count: r.message_count,
    input_tokens: r.input_tokens,
    output_tokens: r.output_tokens,
    cache_creation_tokens: r.cache_creation_tokens,
    cache_read_tokens: r.cache_read_tokens,
    cost_cents: r.cost_cents,
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
    session_id: s.session_id,
    provider: s.provider,
    started_at: s.started_at ?? s.ended_at ?? syncedAt,
    ended_at: s.ended_at ?? null,
    duration_ms: s.duration_ms ?? null,
    repo_id: s.repo_id ?? null,
    git_branch: s.git_branch ?? null,
    ticket: s.ticket ?? null,
    message_count: s.message_count,
    total_input_tokens: s.total_input_tokens,
    total_output_tokens: s.total_output_tokens,
    total_cost_cents: s.total_cost_cents,
    main_model: s.primary_model ?? null,
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
    synced_at: syncedAt,
  }));
}
