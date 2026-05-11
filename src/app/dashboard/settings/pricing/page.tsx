import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentUser, getRecalculationRuns } from "@/lib/dal";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { DefaultsForm } from "./defaults-form";
import { UploadCsvSection } from "./upload-csv-section";
import { PriceListsTable } from "./price-lists-table";
import {
  AuditHistoryTable,
  PAGE_SIZE,
  parsePage,
  parseStatusFilter,
} from "./audit-history-table";

/**
 * #232: Settings → Pricing. Admin-only surface for managing the team's
 * negotiated price lists.
 *
 * Three blocks on the page:
 *   1. Org defaults — platform/region used by recalc when a row matches
 *      multiple (platform, region) tuples.
 *   2. Price lists table — history of draft/active/archived lists.
 *   3. Upload CSV — file picker → preview → commit (server actions in
 *      `src/app/actions/pricing.ts`).
 *
 * Non-managers get a 404 (same response the rest of the dashboard uses for
 * manager-only sections — see #110).
 */
export default async function PricingSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{
    recalc_status?: string;
    recalc_page?: string;
  }>;
}) {
  const user = await getCurrentUser();
  if (!user?.org_id) return null;
  if (user.role !== "manager") notFound();

  const params = await searchParams;
  const recalcStatus = parseStatusFilter(params.recalc_status);
  const recalcPage = parsePage(params.recalc_page);
  const recalcOffset = (recalcPage - 1) * PAGE_SIZE;

  const admin = createAdminClient();

  const [{ data: defaultsRow }, { data: lists }, recalcRuns] =
    await Promise.all([
      admin
        .from("org_pricing_defaults")
        .select("default_platform, default_region")
        .eq("org_id", user.org_id)
        .maybeSingle(),
      admin
        .from("org_price_lists")
        .select(
          "id, name, status, effective_from, effective_to, source_file_name, uploaded_at, uploaded_by"
        )
        .eq("org_id", user.org_id)
        .order("uploaded_at", { ascending: false }),
      getRecalculationRuns(user.org_id, {
        status: recalcStatus === "all" ? null : recalcStatus,
        limit: PAGE_SIZE,
        offset: recalcOffset,
      }),
    ]);

  const defaults = {
    platform: (defaultsRow?.default_platform as string | null) ?? null,
    region: (defaultsRow?.default_region as string | null) ?? null,
  };

  const lookupUserIds = Array.from(
    new Set(
      [
        ...(lists ?? []).map((l) => l.uploaded_by as string | null),
        ...recalcRuns.rows.map((r) => r.triggeredBy),
      ].filter((v): v is string => Boolean(v))
    )
  );
  const usersById = new Map<string, string>();
  if (lookupUserIds.length > 0) {
    const { data: users } = await admin
      .from("users")
      .select("id, display_name, email")
      .in("id", lookupUserIds);
    for (const u of users ?? []) {
      const name =
        (u.display_name as string | null) ||
        (u.email as string | null) ||
        (u.id as string);
      usersById.set(u.id as string, name);
    }
  }

  const rows = (lists ?? []).map((l) => ({
    id: l.id as number,
    name: (l.name as string) ?? "",
    status: (l.status as "draft" | "active" | "archived") ?? "draft",
    effectiveFrom: (l.effective_from as string) ?? "",
    effectiveTo: (l.effective_to as string | null) ?? null,
    sourceFileName: (l.source_file_name as string | null) ?? null,
    uploadedAt: (l.uploaded_at as string) ?? "",
    uploadedBy: usersById.get((l.uploaded_by as string) ?? "") ?? null,
  }));

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/dashboard/settings"
          className="inline-flex items-center text-sm text-zinc-400 hover:text-zinc-200"
        >
          <span aria-hidden="true">←</span>
          <span className="ml-1">Settings</span>
        </Link>
        <h1 className="mt-2 text-xl font-bold">Pricing</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Manage your team&apos;s negotiated price lists. Recalculations use the
          active list to override the daemon&apos;s ingested costs.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Org defaults</CardTitle>
        </CardHeader>
        <CardContent>
          <DefaultsForm
            initialPlatform={defaults.platform}
            initialRegion={defaults.region}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Price lists</CardTitle>
        </CardHeader>
        <CardContent>
          <PriceListsTable lists={rows} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Upload CSV</CardTitle>
        </CardHeader>
        <CardContent>
          <UploadCsvSection />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div id="audit-history" className="scroll-mt-6">
            <CardTitle>Audit history</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <AuditHistoryTable
            runs={recalcRuns.rows}
            total={recalcRuns.total}
            page={recalcPage}
            pageSize={PAGE_SIZE}
            status={recalcStatus}
            usersById={usersById}
          />
        </CardContent>
      </Card>
    </div>
  );
}
