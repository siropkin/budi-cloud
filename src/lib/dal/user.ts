import "server-only";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { BudiUser } from "./types";

/**
 * Get the current budi user and verify they have an org.
 * Uses admin client because the auth→users mapping needs to bypass RLS
 * during the initial lookup.
 */
export async function getCurrentUser(): Promise<BudiUser | null> {
  const supabase = await createClient();
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();
  if (!authUser) return null;

  const admin = createAdminClient();
  const { data } = await admin
    .from("users")
    .select("id, org_id, role, api_key, display_name, email")
    .eq("id", authUser.id)
    .single();

  return data;
}

/**
 * Get org members list.
 */
export async function getOrgMembers(orgId: string) {
  const admin = createAdminClient();
  const { data } = await admin
    .from("users")
    .select("id, display_name, email, role, created_at")
    .eq("org_id", orgId)
    .order("created_at");

  return data ?? [];
}
