import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  type BudiUser,
  type DateRange,
  type ScopeOptions,
  getVisibleDeviceIds,
  normalizeSurfaces,
} from "./types";

export interface WindowTimelineDay {
  bucket_day: string;
  window_count: number;
  message_count: number;
  input_tokens: number;
  output_tokens: number;
  cost_cents: number;
  avg_burn_rate: number;
}

export async function getWindowTimeline(
  user: BudiUser,
  range: DateRange,
  options?: ScopeOptions
): Promise<WindowTimelineDay[]> {
  const admin = createAdminClient();
  const deviceIds = await getVisibleDeviceIds(admin, user, options);
  if (deviceIds.length === 0) return [];

  const { data, error } = await admin.rpc("dashboard_window_timeline", {
    p_device_ids: deviceIds,
    p_started_from: range.startedAtFrom,
    p_started_to: range.startedAtTo,
    p_surfaces: normalizeSurfaces(options?.surfaces),
  });
  if (error) throw error;

  return ((data ?? []) as WindowTimelineRow[])
    .map((r) => ({
      bucket_day: r.bucket_day,
      window_count: Number(r.window_count),
      message_count: Number(r.message_count),
      input_tokens: Number(r.input_tokens),
      output_tokens: Number(r.output_tokens),
      cost_cents: Number(r.cost_cents),
      avg_burn_rate: Number(r.avg_burn_rate),
    }))
    .sort((a, b) => a.bucket_day.localeCompare(b.bucket_day));
}

interface WindowTimelineRow {
  bucket_day: string;
  window_count: number | string;
  message_count: number | string;
  input_tokens: number | string;
  output_tokens: number | string;
  cost_cents: number | string;
  avg_burn_rate: number | string;
}

export interface ThrottleEvent {
  started_at: string;
  ended_at: string;
  duration_minutes: number;
  message_count: number;
  input_tokens: number;
  output_tokens: number;
  cost_cents: number;
  burn_rate: number;
  device_id: string;
  provider: string;
  surface: string;
}

export async function getThrottleEvents(
  user: BudiUser,
  range: DateRange,
  options?: ScopeOptions
): Promise<ThrottleEvent[]> {
  const admin = createAdminClient();
  const deviceIds = await getVisibleDeviceIds(admin, user, options);
  if (deviceIds.length === 0) return [];

  const { data, error } = await admin.rpc("dashboard_throttle_events", {
    p_device_ids: deviceIds,
    p_started_from: range.startedAtFrom,
    p_started_to: range.startedAtTo,
    p_surfaces: normalizeSurfaces(options?.surfaces),
  });
  if (error) throw error;

  return ((data ?? []) as ThrottleEventRow[]).map((r) => ({
    started_at: r.started_at,
    ended_at: r.ended_at,
    duration_minutes: Number(r.duration_minutes),
    message_count: Number(r.message_count),
    input_tokens: Number(r.input_tokens),
    output_tokens: Number(r.output_tokens),
    cost_cents: Number(r.cost_cents),
    burn_rate: Number(r.burn_rate),
    device_id: r.device_id,
    provider: r.provider,
    surface: r.surface,
  }));
}

interface ThrottleEventRow {
  started_at: string;
  ended_at: string;
  duration_minutes: number | string;
  message_count: number | string;
  input_tokens: number | string;
  output_tokens: number | string;
  cost_cents: number | string;
  burn_rate: number | string;
  device_id: string;
  provider: string;
  surface: string;
}

export interface BurnRatePoint {
  started_at: string;
  burn_rate: number;
  cost_cents: number;
  device_id: string;
}

export async function getBurnRateTrend(
  user: BudiUser,
  range: DateRange,
  options?: ScopeOptions
): Promise<BurnRatePoint[]> {
  const admin = createAdminClient();
  const deviceIds = await getVisibleDeviceIds(admin, user, options);
  if (deviceIds.length === 0) return [];

  const { data, error } = await admin.rpc("dashboard_burn_rate_trend", {
    p_device_ids: deviceIds,
    p_started_from: range.startedAtFrom,
    p_started_to: range.startedAtTo,
    p_surfaces: normalizeSurfaces(options?.surfaces),
  });
  if (error) throw error;

  return ((data ?? []) as BurnRateRow[]).map((r) => ({
    started_at: r.started_at,
    burn_rate: Number(r.burn_rate),
    cost_cents: Number(r.cost_cents),
    device_id: r.device_id,
  }));
}

interface BurnRateRow {
  started_at: string;
  burn_rate: number | string;
  cost_cents: number | string;
  device_id: string;
}

export interface TeamRateLimitDay {
  bucket_day: string;
  users_hitting_limit: number;
  total_throttle_windows: number;
  total_windows: number;
}

export async function getTeamRateLimitStats(
  user: BudiUser,
  range: DateRange,
  options?: ScopeOptions
): Promise<TeamRateLimitDay[]> {
  const admin = createAdminClient();
  const deviceIds = await getVisibleDeviceIds(admin, user, options);
  if (deviceIds.length === 0) return [];

  const { data, error } = await admin.rpc("dashboard_team_rate_limit_stats", {
    p_device_ids: deviceIds,
    p_started_from: range.startedAtFrom,
    p_started_to: range.startedAtTo,
    p_surfaces: normalizeSurfaces(options?.surfaces),
  });
  if (error) throw error;

  return ((data ?? []) as TeamRateLimitRow[])
    .map((r) => ({
      bucket_day: r.bucket_day,
      users_hitting_limit: Number(r.users_hitting_limit),
      total_throttle_windows: Number(r.total_throttle_windows),
      total_windows: Number(r.total_windows),
    }))
    .sort((a, b) => a.bucket_day.localeCompare(b.bucket_day));
}

interface TeamRateLimitRow {
  bucket_day: string;
  users_hitting_limit: number | string;
  total_throttle_windows: number | string;
  total_windows: number | string;
}
