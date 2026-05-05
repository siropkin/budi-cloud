import { redirect } from "next/navigation";
import { MobileSidebar, Sidebar } from "@/components/sidebar";
import { UserMenu } from "@/components/user-menu";
import { SyncFreshness } from "@/components/sync-freshness";
import { TimeZoneSync } from "@/components/timezone-sync";
import { getCurrentUser, getSyncFreshness } from "@/lib/dal";
import { getViewerTimeZone } from "@/lib/viewer-timezone";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getCurrentUser();

  if (!user) redirect("/auth/error?reason=missing_user_record");
  if (!user.org_id) redirect("/setup");

  // Fresh on every render because the layout is `force-dynamic`. Opening the
  // dashboard (especially via the local statusline link) therefore always
  // reflects the *current* ingest watermark rather than stale SSR.
  const freshness = await getSyncFreshness(user);
  const cookieTz = await getViewerTimeZone();

  return (
    <div className="flex h-screen bg-[#0a0a0a] text-white">
      <TimeZoneSync currentCookieTz={cookieTz} />
      <Sidebar role={user.role} />
      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex h-14 items-center gap-2 border-b border-white/10 px-3 sm:gap-3 sm:px-4 md:justify-end md:px-6">
          <MobileSidebar role={user.role} />
          <div className="flex-1 md:hidden" />
          <SyncFreshness
            deviceCount={freshness.deviceCount}
            lastSeenAt={freshness.lastSeenAt}
            lastRollupAt={freshness.lastRollupAt}
            lastSessionAt={freshness.lastSessionAt}
            renderedRollupAt={freshness.lastRollupAt}
          />
          <UserMenu displayName={user.display_name} email={user.email} />
        </header>
        <main className="flex-1 overflow-y-auto p-4 sm:p-5 md:p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
