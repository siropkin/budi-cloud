"use client";

import { useRouter, useSearchParams } from "next/navigation";

const ALL_TEAM_VALUE = "";
const ALL_TEAM_LABEL = "All team";

export interface UserFilterMember {
  id: string;
  display_name: string | null;
  email: string | null;
}

/**
 * Manager-only header dropdown that scopes the rest of the dashboard to a
 * single teammate's data via `?user=<id>`. Mirrors `<PeriodSelector />`:
 * lifts the URL into the source of truth so the breakdown queries can read
 * it on the server without prop drilling, and preserves any other params
 * (`?days=…`) on every change. Members never see this control — they're
 * already DAL-scoped to themselves (ADR-0083 §6) so the dropdown would have
 * a single trivial option (#80).
 */
export function UserFilter({
  members,
  role,
}: {
  members: UserFilterMember[];
  role: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  if (role !== "manager") return null;

  const current = searchParams.get("user") ?? ALL_TEAM_VALUE;

  function selectUser(value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value === ALL_TEAM_VALUE) {
      params.delete("user");
    } else {
      params.set("user", value);
    }
    const qs = params.toString();
    router.push(qs ? `?${qs}` : "?");
  }

  return (
    <label
      className="flex items-center gap-2 text-sm"
      data-testid="user-filter"
    >
      <span className="sr-only">Filter by teammate</span>
      <select
        value={current}
        onChange={(e) => selectUser(e.target.value)}
        className="rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2.5 text-sm font-medium text-zinc-200 transition-colors hover:bg-white/[0.04] focus:outline-none focus:ring-1 focus:ring-white/20"
      >
        <option value={ALL_TEAM_VALUE}>{ALL_TEAM_LABEL}</option>
        {members.map((m) => (
          <option key={m.id} value={m.id}>
            {memberLabel(m)}
          </option>
        ))}
      </select>
    </label>
  );
}

function memberLabel(m: UserFilterMember): string {
  return m.display_name?.trim() || m.email?.trim() || m.id.slice(0, 8);
}
