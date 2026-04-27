"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { randomBytes } from "crypto";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

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
 * Deletion cascades in dependency order (see `ORG_CASCADE_ORDER` in
 * `./org-cascade.ts`). Supabase auth rows (`auth.users`) are intentionally
 * left intact so former members can still sign in and create/join a
 * different org.
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

/**
 * Member-only: switch the caller from their current org to the org an invite
 * token belongs to. The opt-in alternative to the dead-end "Already in an
 * Organization" screen on `/invite/[token]` (#72).
 *
 * Devices, daily rollups, and session summaries are keyed off `user_id`
 * (transitively through `devices`), so flipping `users.org_id` is enough to
 * carry every piece of synced data with the user — there's no DELETE in this
 * action by design. The original org loses visibility on the caller's data
 * the moment the update commits.
 *
 * Managers are refused for the same reason `leaveOrganization` refuses them:
 * a sole manager switching out would orphan the org with no one able to
 * invite, promote, or delete. They have to delete the org first (or, once
 * we ship one, hand off ownership).
 *
 * The token is re-validated server-side. The form-supplied `targetOrgId` is
 * cross-checked against the token's `org_id` so a tampered request can't
 * land the user in an org the token wasn't issued for.
 */
export async function switchOrganization(
  _prevState: { error: string } | undefined,
  formData: FormData
): Promise<{ error: string } | void> {
  const tokenId = String(formData.get("token") ?? "");
  const targetOrgId = String(formData.get("targetOrgId") ?? "");
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

  if (!me?.org_id) return { error: "Not a member of any organization" };
  if (me.role === "manager") {
    return {
      error:
        "Managers can't switch organizations. Delete this org or hand off ownership first.",
    };
  }

  const { data: invite } = await admin
    .from("invite_tokens")
    .select("id, org_id, role, expires_at")
    .eq("id", tokenId)
    .single();

  if (!invite) return { error: "Invite link is invalid" };
  if (new Date(invite.expires_at as string) < new Date()) {
    return { error: "Invite link has expired" };
  }
  if (invite.org_id !== targetOrgId) {
    return { error: "Invite link does not match the target organization" };
  }
  if (invite.org_id === me.org_id) {
    return { error: "You are already a member of that organization" };
  }

  const { data: targetOrg } = await admin
    .from("orgs")
    .select("id, name")
    .eq("id", invite.org_id as string)
    .single();
  if (!targetOrg) return { error: "Target organization not found" };

  if (confirm.trim() !== (targetOrg.name as string)) {
    return { error: "Type the organization name exactly to confirm" };
  }

  const { error: updateError } = await admin
    .from("users")
    .update({ org_id: invite.org_id, role: invite.role })
    .eq("id", me.id as string);
  if (updateError) return { error: "Failed to switch organization" };

  // Audit row, same shape as a fresh join. Idempotent on (token, user) so a
  // re-click after the switch is a no-op rather than a duplicate-key error.
  await admin
    .from("invite_redemptions")
    .upsert(
      { token_id: tokenId, user_id: me.id as string },
      { onConflict: "token_id,user_id", ignoreDuplicates: true }
    );

  redirect("/dashboard");
}

/**
 * Manager-only: change another org member's role between `member` and
 * `manager`. Self-edits go through the same path so the server's safety
 * guards (in particular the last-manager check) apply uniformly.
 *
 * The admin client bypasses RLS, so this action has to scope every read
 * and write to the caller's `org_id` itself — a manager from org A must
 * never be able to flip a user in org B.
 *
 * The "last manager" guard mirrors the invariant enforced by
 * `leaveOrganization`: an org must always have ≥1 manager. Without this
 * check a sole manager could demote themselves and orphan the org with
 * no one able to invite, promote, or delete it.
 */
export async function updateMemberRole(
  targetUserId: string,
  newRole: string
): Promise<{ ok?: true; error?: string }> {
  if (newRole !== "member" && newRole !== "manager") {
    return { error: "Invalid role" };
  }

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

  if (!me?.org_id || me.role !== "manager") {
    return { error: "Only managers can change member roles" };
  }

  const { data: target } = await admin
    .from("users")
    .select("id, org_id, role")
    .eq("id", targetUserId)
    .single();

  if (!target || target.org_id !== me.org_id) {
    return { error: "User is not a member of your organization" };
  }

  if (target.role === newRole) return { ok: true };

  if (target.role === "manager" && newRole === "member") {
    const { data: managers } = await admin
      .from("users")
      .select("id")
      .eq("org_id", me.org_id)
      .eq("role", "manager");
    if ((managers?.length ?? 0) <= 1) {
      return {
        error: "Can't demote the last manager — promote someone else first.",
      };
    }
  }

  const { error: updateError } = await admin
    .from("users")
    .update({ role: newRole })
    .eq("id", targetUserId);
  if (updateError) return { error: "Failed to update role" };

  revalidatePath("/dashboard/settings");
  return { ok: true };
}
