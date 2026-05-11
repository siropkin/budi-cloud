"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  buildAliasDict,
  parsePricingCsv,
  type ParseResult,
} from "@/lib/pricing-csv";
import { recalculateEffectiveCost } from "@/lib/recalculate-effective-cost";

/**
 * #232: Server actions backing the Settings → Pricing page.
 *
 * Every action that mutates org state re-verifies the caller's role on the
 * server — the page itself already gates rendering to managers, but a crafted
 * POST against a server action bypasses the JSX guard, so we always re-check
 * (mirroring the pattern in `org.ts`).
 */

type Manager = { id: string; org_id: string; role: "manager" };

async function requireManager(): Promise<
  { ok: true; me: Manager } | { ok: false; error: string }
> {
  const supabase = await createClient();
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();
  if (!authUser) return { ok: false, error: "Not authenticated" };

  const admin = createAdminClient();
  const { data: me } = await admin
    .from("users")
    .select("id, org_id, role")
    .eq("id", authUser.id)
    .single();

  if (!me?.org_id) return { ok: false, error: "Not a member of any organization" };
  if (me.role !== "manager") {
    return { ok: false, error: "Only managers can manage pricing" };
  }

  return {
    ok: true,
    me: { id: me.id as string, org_id: me.org_id as string, role: "manager" },
  };
}

// ============================================================
// Pricing defaults (platform / region)
// ============================================================

export async function savePricingDefaults(
  _prev: { error?: string; ok?: true } | undefined,
  formData: FormData
): Promise<{ error?: string; ok?: true }> {
  const auth = await requireManager();
  if (!auth.ok) return { error: auth.error };

  const platform = (formData.get("default_platform") as string | null)?.trim() || null;
  const region = (formData.get("default_region") as string | null)?.trim() || null;

  const admin = createAdminClient();
  const { error } = await admin.from("org_pricing_defaults").upsert(
    {
      org_id: auth.me.org_id,
      default_platform: platform,
      default_region: region,
      updated_by: auth.me.id,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "org_id" }
  );
  if (error) return { error: "Failed to save defaults" };

  revalidatePath("/dashboard/settings/pricing");
  return { ok: true };
}

// ============================================================
// CSV preview (parse-only; no DB writes)
// ============================================================

export type PreviewRow = {
  lineNumber: number;
  platform: string;
  model: string;
  tokenType: string;
  region: string | null;
  listUsdPerMtok: number | null;
  saleUsdPerMtok: number;
  mapped: boolean;
};

export type CsvPreview = {
  totalRows: number;
  mappedCount: number;
  unmappedCount: number;
  sampleMapped: PreviewRow[];
  unmappedModels: string[];
  errors: { lineNumber: number; message: string }[];
  /** Same `(filename, sha256-ish)` heuristic surfaced as a duplicate warning. */
  duplicateOfListName: string | null;
};

export async function previewPricingCsv(formData: FormData): Promise<
  | { error: string; preview?: undefined }
  | { error?: undefined; preview: CsvPreview }
> {
  const auth = await requireManager();
  if (!auth.ok) return { error: auth.error };

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { error: "Upload a CSV file" };
  }
  if (file.size > 2_000_000) {
    return { error: "File too large (max 2MB)" };
  }

  const text = await file.text();
  const admin = createAdminClient();

  const { data: aliasRows } = await admin
    .from("model_aliases")
    .select("display_name, patterns");
  const aliases = buildAliasDict(
    (aliasRows ?? []).map((r) => ({
      display_name: r.display_name as string,
      patterns: (r.patterns as string[] | null) ?? [],
    }))
  );

  const result = parsePricingCsv(text, aliases);

  // Duplicate heuristic: same filename already uploaded for this org.
  let duplicateOfListName: string | null = null;
  if (file.name) {
    const { data: prior } = await admin
      .from("org_price_lists")
      .select("name, source_file_name")
      .eq("org_id", auth.me.org_id)
      .eq("source_file_name", file.name)
      .order("uploaded_at", { ascending: false })
      .limit(1);
    if (prior && prior.length > 0) {
      duplicateOfListName = (prior[0]!.name as string) ?? null;
    }
  }

  return {
    preview: shapePreview(result, duplicateOfListName),
  };
}

function shapePreview(
  result: ParseResult,
  duplicateOfListName: string | null
): CsvPreview {
  const unmappedModels = Array.from(
    new Set(result.rows.filter((r) => !r.mapped).map((r) => r.model))
  );
  const sampleMapped: PreviewRow[] = result.rows
    .filter((r) => r.mapped)
    .slice(0, 5)
    .map((r) => ({
      lineNumber: r.lineNumber,
      platform: r.platform,
      model: r.model,
      tokenType: r.tokenType,
      region: r.region,
      listUsdPerMtok: r.listUsdPerMtok,
      saleUsdPerMtok: r.saleUsdPerMtok,
      mapped: r.mapped,
    }));

  return {
    totalRows: result.rows.length,
    mappedCount: result.mappedCount,
    unmappedCount: result.unmappedCount,
    sampleMapped,
    unmappedModels,
    errors: result.errors,
    duplicateOfListName,
  };
}

// ============================================================
// Commit a parsed CSV as a draft price list
// ============================================================

export async function commitPricingDraft(
  _prev: { error?: string; ok?: true; listId?: number } | undefined,
  formData: FormData
): Promise<{ error?: string; ok?: true; listId?: number }> {
  const auth = await requireManager();
  if (!auth.ok) return { error: auth.error };

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { error: "Upload a CSV file" };
  }
  if (file.size > 2_000_000) {
    return { error: "File too large (max 2MB)" };
  }

  const name = ((formData.get("name") as string | null) ?? "").trim();
  if (!name) return { error: "Name is required" };

  const description =
    ((formData.get("description") as string | null) ?? "").trim() || null;

  const effectiveFromRaw = (
    (formData.get("effective_from") as string | null) ?? ""
  ).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFromRaw)) {
    return { error: "Effective-from date is required (YYYY-MM-DD)" };
  }

  const text = await file.text();
  const admin = createAdminClient();

  const { data: aliasRows } = await admin
    .from("model_aliases")
    .select("display_name, patterns");
  const aliases = buildAliasDict(
    (aliasRows ?? []).map((r) => ({
      display_name: r.display_name as string,
      patterns: (r.patterns as string[] | null) ?? [],
    }))
  );

  const parsed = parsePricingCsv(text, aliases);
  if (parsed.rows.length === 0) {
    return { error: "No valid rows in CSV" };
  }

  const { data: listInsert, error: listError } = await admin
    .from("org_price_lists")
    .insert({
      org_id: auth.me.org_id,
      name,
      description,
      source_file_name: file.name || null,
      effective_from: effectiveFromRaw,
      status: "draft",
      uploaded_by: auth.me.id,
    })
    .select("id")
    .single();
  if (listError || !listInsert) {
    return { error: "Failed to create price list" };
  }

  const listId = listInsert.id as number;
  const rowsToInsert = parsed.rows.map((r) => ({
    list_id: listId,
    platform: r.platform,
    model_pattern: r.model,
    region: r.region,
    token_type: r.tokenType,
    list_usd_per_mtok: r.listUsdPerMtok,
    sale_usd_per_mtok: r.saleUsdPerMtok,
    raw_row: r.raw,
  }));

  const { error: rowsError } = await admin
    .from("org_price_list_rows")
    .insert(rowsToInsert);
  if (rowsError) {
    // Roll the draft back on row-insert failure so the UI doesn't show an
    // empty draft the manager can't recover.
    await admin.from("org_price_lists").delete().eq("id", listId);
    return { error: "Failed to save price list rows" };
  }

  revalidatePath("/dashboard/settings/pricing");
  return { ok: true, listId };
}

// ============================================================
// Activate a draft price list (and trigger recalc)
// ============================================================

export async function activatePricingList(listId: number): Promise<
  { ok?: true; error?: string }
> {
  const auth = await requireManager();
  if (!auth.ok) return { error: auth.error };

  const admin = createAdminClient();
  const { data: list } = await admin
    .from("org_price_lists")
    .select("id, org_id, status, effective_from")
    .eq("id", listId)
    .single();
  if (!list || list.org_id !== auth.me.org_id) {
    return { error: "Price list not found" };
  }
  if (list.status === "active") {
    return { ok: true };
  }
  if (list.status === "archived") {
    return { error: "Cannot activate an archived list" };
  }

  const newEffectiveFrom = list.effective_from as string;

  // Archive previously-active lists for this org. Their effective_to becomes
  // the new list's effective_from (one-day overlap is fine — recalc resolves
  // to the most-specific row, and the new list will outrank the old where
  // they tie because it has a higher id).
  const { data: priorActive } = await admin
    .from("org_price_lists")
    .select("id")
    .eq("org_id", auth.me.org_id)
    .eq("status", "active");

  if (priorActive && priorActive.length > 0) {
    const priorIds = priorActive.map((r) => r.id as number);
    await admin
      .from("org_price_lists")
      .update({ status: "archived", effective_to: newEffectiveFrom })
      .in("id", priorIds);
  }

  const { error: activateError } = await admin
    .from("org_price_lists")
    .update({ status: "active" })
    .eq("id", listId);
  if (activateError) return { error: "Failed to activate list" };

  // Synchronous recalc over the active window: [effective_from .. today].
  // The recalc engine writes its own audit row in `recalculation_runs`.
  const today = new Date().toISOString().slice(0, 10);
  try {
    await recalculateEffectiveCost({
      orgId: auth.me.org_id,
      fromDate: newEffectiveFrom,
      toDate: today,
      triggeredBy: auth.me.id,
    });
  } catch (err) {
    console.error("Recalc failed after activation:", err);
    // The list is active either way — surface the error so the manager can
    // re-run from the audit UI (#233) without flipping the list back to draft.
    revalidatePath("/dashboard/settings/pricing");
    return { error: "Activated, but recalc failed" };
  }

  revalidatePath("/dashboard/settings/pricing");
  return { ok: true };
}

// ============================================================
// Discard a draft (managers only)
// ============================================================

export async function discardPricingDraft(listId: number): Promise<
  { ok?: true; error?: string }
> {
  const auth = await requireManager();
  if (!auth.ok) return { error: auth.error };

  const admin = createAdminClient();
  const { data: list } = await admin
    .from("org_price_lists")
    .select("id, org_id, status")
    .eq("id", listId)
    .single();
  if (!list || list.org_id !== auth.me.org_id) {
    return { error: "Price list not found" };
  }
  if (list.status !== "draft") {
    return { error: "Only drafts can be discarded" };
  }

  await admin.from("org_price_lists").delete().eq("id", listId);
  revalidatePath("/dashboard/settings/pricing");
  return { ok: true };
}
