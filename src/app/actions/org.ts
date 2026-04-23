"use server";

import { redirect } from "next/navigation";
import { randomBytes } from "crypto";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Dependency order for wiping an org's data.
 *
 * None of the FKs in `001_ingest_schema.sql` declare `ON DELETE CASCADE`, so
 * we delete leaves first. This list is reused by the tests to document and
 * pin the expected sequence.
 */
const ORG_CASCADE_ORDER = [
  "session_summaries",
  "daily_rollups",
  "devices",
  "invite_tokens",
  "users",
  "orgs",
] as const;

export { ORG_CASCADE_ORDER };

export async function createOrg(
  _prevState: { error: string } | undefined,
  formData: FormData
) {
  const name = formData.get("name") as string;
  if (!name?.trim()) return { error: "Org name is required" };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated" };

  const admin = createAdminClient();
  const orgId = `org_${randomBytes(12).toString("base64url")}`;

  // Create the org
  const { error: orgError } = await admin.from("orgs").insert({
    id: orgId,
    name: name.trim(),
  });
  if (orgError) return { error: "Failed to create org" };

  // Link user to org as manager
  const { error: userError } = await admin
    .from("users")
    .update({ org_id: orgId, role: "manager" })
    .eq("id", user.id);
  if (userError) return { error: "Failed to link user to org" };

  redirect("/dashboard");
}

export async function generateInviteToken() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated" };

  const admin = createAdminClient();
  const { data: budiUser } = await admin
    .from("users")
    .select("id, org_id, role")
    .eq("id", user.id)
    .single();

  if (!budiUser?.org_id || budiUser.role !== "manager") {
    return { error: "Only managers can create invite tokens" };
  }

  const token = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  const { error } = await admin.from("invite_tokens").insert({
    id: token,
    org_id: budiUser.org_id,
    role: "member",
    created_by: budiUser.id,
    expires_at: expiresAt.toISOString(),
  });

  if (error) return { error: "Failed to create invite token" };

  return { token };
}

/**
 * Manager-only: nuke an entire org and every piece of synced data tied to it.
 *
 * The caller must type the org name into `formData.confirm` — this is the
 * only typed-confirmation the settings UI requires for a destructive action,
 * mirroring the GitHub "type the name to continue" pattern. We re-verify
 * both the role and the confirmation text on the server so a crafted request
 * can't skip either check.
 *
 * Deletion cascades in dependency order (see `ORG_CASCADE_ORDER`). Supabase
 * auth rows (`auth.users`) are intentionally left intact so former members
 * can still sign in and create/join a different org.
 */
export async function deleteOrganization(
  _prevState: { error: string } | undefined,
  formData: FormData
): Promise<{ error: string } | void> {
  const confirm = String(formData.get("confirm") ?? "");

  const supabase = await createClient();
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();
  if (!authUser) return { error: "Not authenticated" };

  const admin = createAdminClient();
  const { data: me } = await admin
    .from("users")
    .select("id, org_id, role")
    .eq("id", authUser.id)
    .single();

  if (!me?.org_id) return { error: "No organization to delete" };
  if (me.role !== "manager") {
    return { error: "Only managers can delete the organization" };
  }

  const { data: org } = await admin
    .from("orgs")
    .select("id, name")
    .eq("id", me.org_id)
    .single();
  if (!org) return { error: "Organization not found" };

  if (confirm.trim() !== org.name) {
    return { error: "Type the organization name exactly to confirm" };
  }

  const orgId = org.id as string;

  // Pull ids we need to scope the leaf deletes. The device set is derived
  // from the org's users so we never have to trust a caller-supplied list.
  const { data: orgUsers } = await admin
    .from("users")
    .select("id")
    .eq("org_id", orgId);
  const userIds = (orgUsers ?? []).map((u) => u.id as string);

  let deviceIds: string[] = [];
  if (userIds.length > 0) {
    const { data: orgDevices } = await admin
      .from("devices")
      .select("id")
      .in("user_id", userIds);
    deviceIds = (orgDevices ?? []).map((d) => d.id as string);
  }

  if (deviceIds.length > 0) {
    await admin.from("session_summaries").delete().in("device_id", deviceIds);
    await admin.from("daily_rollups").delete().in("device_id", deviceIds);
    await admin.from("devices").delete().in("user_id", userIds);
  }

  await admin.from("invite_tokens").delete().eq("org_id", orgId);
  await admin.from("users").delete().eq("org_id", orgId);
  await admin.from("orgs").delete().eq("id", orgId);

  await supabase.auth.signOut();
  redirect("/login");
}

/**
 * Member-only: leave the current org. Deletes the caller's devices and
 * sync data, then nulls their `org_id` so they survive as a user who can
 * join or create a different org on next sign-in.
 *
 * Managers are refused here to avoid orphaning an org with no one who can
 * invite or delete — they should use `deleteOrganization` instead (a lone
 * manager leaving is, functionally, an org deletion). Once we grow a
 * promote-to-manager flow this check can relax.
 */
export async function leaveOrganization(): Promise<{ error: string } | void> {
  const supabase = await createClient();
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();
  if (!authUser) return { error: "Not authenticated" };

  const admin = createAdminClient();
  const { data: me } = await admin
    .from("users")
    .select("id, org_id, role")
    .eq("id", authUser.id)
    .single();

  if (!me?.org_id) return { error: "Not a member of any organization" };
  if (me.role === "manager") {
    return {
      error:
        "Managers can't leave an organization. Delete it instead, or hand off ownership first.",
    };
  }

  const userId = me.id as string;
  const { data: myDevices } = await admin
    .from("devices")
    .select("id")
    .eq("user_id", userId);
  const deviceIds = (myDevices ?? []).map((d) => d.id as string);

  if (deviceIds.length > 0) {
    await admin.from("session_summaries").delete().in("device_id", deviceIds);
    await admin.from("daily_rollups").delete().in("device_id", deviceIds);
    await admin.from("devices").delete().eq("user_id", userId);
  }

  await admin
    .from("users")
    .update({ org_id: null, role: "member" })
    .eq("id", userId);

  await supabase.auth.signOut();
  redirect("/login");
}
