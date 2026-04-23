import { clsx } from "clsx";
import { getCurrentUser, getOrgMembers } from "@/lib/dal";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { ApiKeySection } from "./api-key-section";
import { CopyButton } from "./copy-button";
import { InviteSection } from "./invite-section";
import { DangerZone } from "./danger-zone";

export default async function SettingsPage() {
  const user = await getCurrentUser();
  if (!user?.org_id) return null;

  const admin = createAdminClient();
  const { data: org } = await admin
    .from("orgs")
    .select("id, name")
    .eq("id", user.org_id)
    .single();

  const members = await getOrgMembers(user.org_id);

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">Settings</h1>

      <Card>
        <CardHeader>
          <CardTitle>Organization</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="space-y-3 text-sm">
            <div className="flex justify-between">
              <dt className="text-zinc-400">Name</dt>
              <dd className="text-zinc-200">{org?.name ?? "-"}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-zinc-400">Org ID</dt>
              <dd className="flex items-center gap-1 font-mono text-xs text-zinc-400">
                <span>{user.org_id}</span>
                <CopyButton value={user.org_id} label="Copy Org ID" />
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
            <>
              {/* Table on sm+ stays the same; below `sm` render each member
                  as a stacked card (name+role pill on the first row, email
                  on the second) so the cluster doesn't overflow horizontally
                  at phone widths. */}
              <table className="hidden w-full text-sm sm:table">
                <thead>
                  <tr className="border-b border-white/10 text-left text-zinc-400">
                    <th className="pb-2 font-medium">Name</th>
                    <th className="pb-2 font-medium">Email</th>
                    <th className="pb-2 font-medium">Role</th>
                  </tr>
                </thead>
                <tbody>
                  {members.map((m) => (
                    <tr key={m.id} className="border-b border-white/5">
                      <td className="py-2 text-zinc-200">
                        {m.display_name || "-"}
                      </td>
                      <td className="py-2 text-zinc-400">{m.email || "-"}</td>
                      <td className="py-2">
                        <RoleBadge role={m.role} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <ul className="divide-y divide-white/5 text-sm sm:hidden">
                {members.map((m) => (
                  <li key={m.id} className="space-y-1 py-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-zinc-200">
                        {m.display_name || "-"}
                      </span>
                      <RoleBadge role={m.role} />
                    </div>
                    {m.email && (
                      <p className="truncate text-xs text-zinc-500">
                        {m.email}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </CardContent>
      </Card>

      {user.role === "manager" && <InviteSection />}

      <DangerZone userRole={user.role} orgName={org?.name ?? ""} />
    </div>
  );
}

function RoleBadge({ role }: { role: string }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium",
        role === "manager"
          ? "border-blue-500/30 bg-blue-500/10 text-blue-300"
          : "border-zinc-500/30 bg-zinc-500/10 text-zinc-400"
      )}
    >
      {role}
    </span>
  );
}
