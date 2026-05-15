import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

// Asserts the code↔schema contract that broke on 2026-05-15: that `users`
// has a `workspace_id` column. A 500 from this endpoint is the single
// fastest signal that prod-code is reading a column prod-schema doesn't
// have. Lightweight enough to poll from a monitor or a post-deploy gate;
// limited to columns the dashboard touches on every request.
export async function GET() {
  try {
    const admin = createAdminClient();
    const { error } = await admin
      .from("users")
      .select("id, workspace_id")
      .limit(0);
    if (error) {
      return NextResponse.json(
        { ok: false, error: error.message },
        { status: 500 }
      );
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : "unknown";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
