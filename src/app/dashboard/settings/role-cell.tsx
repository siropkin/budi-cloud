"use client";

import { useState, useTransition } from "react";
import { clsx } from "clsx";
import { updateMemberRole } from "@/app/actions/org";

/**
 * Role display + (for managers) inline editor for a single team-members row.
 *
 * Members see the same read-only badge as before. Managers see a styled
 * native `<select>` that promotes/demotes on change. The update is applied
 * optimistically and rolled back if the server action returns an error
 * (e.g. last-manager guard) — the inline error appears under the select.
 *
 * Self-edits go through the same server path; we never short-circuit a
 * demote-self locally because the "last manager" check is server-side only.
 */
export function RoleCell({
  userId,
  initialRole,
  canEdit,
}: {
  userId: string;
  initialRole: string;
  canEdit: boolean;
}) {
  const [role, setRole] = useState(initialRole);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (!canEdit) return <RoleBadge role={role} />;

  function onChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const next = e.target.value;
    const previous = role;
    if (next === previous) return;

    setRole(next);
    setError(null);
    startTransition(async () => {
      const result = await updateMemberRole(userId, next);
      if (result.error) {
        setRole(previous);
        setError(result.error);
      }
    });
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <select
        value={role}
        onChange={onChange}
        disabled={pending}
        aria-label="Role"
        className={clsx(
          "rounded-md border px-2 py-0.5 text-xs font-medium transition-colors focus:outline-none focus:ring-1 disabled:opacity-50",
          role === "manager"
            ? "border-blue-500/30 bg-blue-500/10 text-blue-300 focus:ring-blue-500/40"
            : "border-zinc-500/30 bg-zinc-500/10 text-zinc-300 focus:ring-zinc-500/40"
        )}
      >
        <option value="member">member</option>
        <option value="manager">manager</option>
      </select>
      {error && <p className="text-xs text-red-400">{error}</p>}
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
