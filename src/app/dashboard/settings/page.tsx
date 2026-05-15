import Link from "next/link";
import { getCurrentUser, getWorkspaceMembers } from "@/lib/dal";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/responsive-table";
import { ApiKeySection } from "./api-key-section";
import { CopyButton } from "./copy-button";
import { InviteSection } from "./invite-section";
import { DangerZone } from "./danger-zone";
import { RoleCell } from "./role-cell";

export default async function SettingsPage() {
  const user = await getCurrentUser();
  if (!user?.workspace_id) return null;

  const admin = createAdminClient();
  const { data: workspace } = await admin
    .from("workspaces")
    .select("id, name")
    .eq("id", user.workspace_id)
    .single();

  const members = await getWorkspaceMembers(user.workspace_id);
  const canEditRoles = user.role === "manager";
  type Member = (typeof members)[number];
  const memberColumns: ResponsiveColumn<Member>[] = [
    {
      key: "name",
      header: "Name",
      cellClassName: "text-zinc-200",
      render: (m) => m.display_name || "-",
    },
    {
      key: "email",
      header: "Email",
      cellClassName: "text-zinc-400",
      render: (m) => m.email || "-",
    },
    {
      key: "role",
      header: "Role",
      render: (m) => (
        <RoleCell userId={m.id} initialRole={m.role} canEdit={canEditRoles} />
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">Settings</h1>

      <Card>
        <CardHeader>
          <CardTitle>Workspace</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="space-y-3 text-sm">
            <div className="flex justify-between">
              <dt className="text-zinc-400">Name</dt>
              <dd className="text-zinc-200">{workspace?.name ?? "-"}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-zinc-400">Workspace ID</dt>
              <dd className="flex items-center gap-1 font-mono text-xs text-zinc-400">
                <span>{user.workspace_id}</span>
                <CopyButton
                  value={user.workspace_id}
                  label="Copy Workspace ID"
                />
              </dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      <ApiKeySection apiKey={user.api_key} />

      <Card>
        <CardHeader>
          <CardTitle>Team Members ({members.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {members.length === 0 ? (
            <p className="text-sm text-zinc-500">No members yet</p>
          ) : (
            <ResponsiveTable
              columns={memberColumns}
              rows={members}
              rowKey={(m) => m.id}
              mobileItemClassName="space-y-1 py-3"
              mobileCard={(m) => (
                <>
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-zinc-200">
                      {m.display_name || "-"}
                    </span>
                    <RoleCell
                      userId={m.id}
                      initialRole={m.role}
                      canEdit={canEditRoles}
                    />
                  </div>
                  {m.email && (
                    <p className="truncate text-xs text-zinc-500">{m.email}</p>
                  )}
                </>
              )}
            />
          )}
        </CardContent>
      </Card>

      {user.role === "manager" && <InviteSection />}

      {user.role === "manager" && (
        <Card>
          <CardHeader>
            <CardTitle>Pricing</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="mb-3 text-sm text-zinc-400">
              Upload and manage your team&apos;s negotiated price lists. The
              active list overrides the daemon&apos;s ingested costs.
            </p>
            <Link
              href="/dashboard/settings/pricing"
              className="inline-block rounded-lg bg-white/10 px-4 py-2 text-sm font-medium text-zinc-200 transition-colors hover:bg-white/15"
            >
              Manage pricing
            </Link>
          </CardContent>
        </Card>
      )}

      <DangerZone userRole={user.role} workspaceName={workspace?.name ?? ""} />
    </div>
  );
}
