import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  type BudiUser,
  type DateRange,
  type ScopeOptions,
  getVisibleDeviceIds,
  normalizeSurfaces,
} from "./types";

/**
 * Get cost breakdown by repo.
 * Manager sees full org; member sees own devices only (ADR-0083 §6).
 * `options.scopedUserId` further narrows a manager view to a single teammate.
 */
export async function getCostByRepo(
  user: BudiUser,
  range: DateRange,
  options?: ScopeOptions
) {
  const admin = createAdminClient();
  const deviceIds = await getVisibleDeviceIds(admin, user, options);
  if (deviceIds.length === 0) return [];

  const { data, error } = await admin.rpc("dashboard_cost_by_repo", {
    p_device_ids: deviceIds,
    p_bucket_from: range.bucketFrom,
    p_bucket_to: range.bucketTo,
    p_surfaces: normalizeSurfaces(options?.surfaces),
  });
  if (error) throw error;

  return ((data ?? []) as RepoCostRow[])
    .map((r) => {
      const effective = Number(r.cost_cents);
      return {
        repo_id: r.repo_id,
        cost_cents: effective,
        cost_cents_ingested: Number(r.cost_cents_ingested ?? effective),
        input_tokens: Number(r.input_tokens ?? 0),
        output_tokens: Number(r.output_tokens ?? 0),
      };
    })
    .filter((r) => r.cost_cents > 0 || r.input_tokens + r.output_tokens > 0)
    .sort((a, b) => b.cost_cents - a.cost_cents);
}

interface RepoCostRow {
  repo_id: string;
  cost_cents: number | string;
  cost_cents_ingested?: number | string;
  input_tokens?: number | string;
  output_tokens?: number | string;
}

/**
 * Get cost breakdown by branch.
 * Manager sees full org; member sees own devices only (ADR-0083 §6).
 * `options.scopedUserId` further narrows a manager view to a single teammate.
 */
export async function getCostByBranch(
  user: BudiUser,
  range: DateRange,
  options?: ScopeOptions
) {
  const admin = createAdminClient();
  const deviceIds = await getVisibleDeviceIds(admin, user, options);
  if (deviceIds.length === 0) return [];

  const { data, error } = await admin.rpc("dashboard_cost_by_branch", {
    p_device_ids: deviceIds,
    p_bucket_from: range.bucketFrom,
    p_bucket_to: range.bucketTo,
    p_surfaces: normalizeSurfaces(options?.surfaces),
  });
  if (error) throw error;

  return ((data ?? []) as BranchCostRow[])
    .map((r) => {
      const effective = Number(r.cost_cents);
      return {
        repo_id: r.repo_id,
        git_branch: r.git_branch,
        cost_cents: effective,
        cost_cents_ingested: Number(r.cost_cents_ingested ?? effective),
        input_tokens: Number(r.input_tokens ?? 0),
        output_tokens: Number(r.output_tokens ?? 0),
      };
    })
    .filter((b) => b.cost_cents > 0 || b.input_tokens + b.output_tokens > 0)
    .sort((a, b) => b.cost_cents - a.cost_cents);
}

interface BranchCostRow {
  repo_id: string;
  git_branch: string;
  cost_cents: number | string;
  cost_cents_ingested?: number | string;
  input_tokens?: number | string;
  output_tokens?: number | string;
}

/**
 * Get cost breakdown by ticket.
 * Manager sees full org; member sees own devices only (ADR-0083 §6).
 * `options.scopedUserId` further narrows a manager view to a single teammate.
 */
export async function getCostByTicket(
  user: BudiUser,
  range: DateRange,
  options?: ScopeOptions
) {
  const admin = createAdminClient();
  const deviceIds = await getVisibleDeviceIds(admin, user, options);
  if (deviceIds.length === 0) return [];

  const { data, error } = await admin.rpc("dashboard_cost_by_ticket", {
    p_device_ids: deviceIds,
    p_bucket_from: range.bucketFrom,
    p_bucket_to: range.bucketTo,
    p_surfaces: normalizeSurfaces(options?.surfaces),
  });
  if (error) throw error;

  return ((data ?? []) as TicketCostRow[])
    .map((r) => {
      const effective = Number(r.cost_cents);
      return {
        ticket: r.ticket,
        cost_cents: effective,
        cost_cents_ingested: Number(r.cost_cents_ingested ?? effective),
        input_tokens: Number(r.input_tokens ?? 0),
        output_tokens: Number(r.output_tokens ?? 0),
      };
    })
    .filter((t) => t.cost_cents > 0 || t.input_tokens + t.output_tokens > 0)
    .sort((a, b) => b.cost_cents - a.cost_cents);
}

interface TicketCostRow {
  ticket: string;
  cost_cents: number | string;
  cost_cents_ingested?: number | string;
  input_tokens?: number | string;
  output_tokens?: number | string;
}
