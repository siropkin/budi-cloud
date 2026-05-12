"use client";

import { useTransition, useState } from "react";
import {
  activatePricingList,
  discardPricingDraft,
} from "@/app/actions/pricing";

export type PriceListRow = {
  id: number;
  name: string;
  status: "draft" | "active" | "archived";
  effectiveFrom: string;
  effectiveTo: string | null;
  sourceFileName: string | null;
  uploadedAt: string;
  uploadedBy: string | null;
};

function StatusBadge({ status }: { status: PriceListRow["status"] }) {
  const styles =
    status === "active"
      ? "bg-emerald-500/15 text-emerald-300"
      : status === "draft"
        ? "bg-amber-500/15 text-amber-300"
        : "bg-zinc-500/15 text-zinc-400";
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${styles}`}
    >
      {status}
    </span>
  );
}

export function PriceListsTable({ lists }: { lists: PriceListRow[] }) {
  const [isPending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  function handleActivate(listId: number) {
    setError(null);
    setBusyId(listId);
    startTransition(async () => {
      const res = await activatePricingList(listId);
      setBusyId(null);
      if (res.error) setError(res.error);
    });
  }

  function handleDiscard(listId: number) {
    setError(null);
    setBusyId(listId);
    startTransition(async () => {
      const res = await discardPricingDraft(listId);
      setBusyId(null);
      if (res.error) setError(res.error);
    });
  }

  if (lists.length === 0) {
    return (
      <p className="text-sm text-zinc-500">
        No price lists yet. Upload a CSV below to get started.
      </p>
    );
  }

  function renderActions(l: PriceListRow) {
    if (l.status !== "draft") return null;
    return (
      <div className="flex items-center justify-end gap-2">
        <button
          onClick={() => handleActivate(l.id)}
          disabled={isPending && busyId === l.id}
          className="rounded-md bg-emerald-600 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-emerald-700 disabled:opacity-50"
        >
          {isPending && busyId === l.id ? "Activating…" : "Activate"}
        </button>
        <button
          onClick={() => handleDiscard(l.id)}
          disabled={isPending && busyId === l.id}
          className="rounded-md bg-white/10 px-3 py-1 text-xs font-medium text-zinc-200 transition-colors hover:bg-white/15 disabled:opacity-50"
        >
          Discard
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {error && <p className="text-sm text-red-400">{error}</p>}

      {/* Table on sm+; below `sm` render each list as a stacked card so the
          5 + actions columns don't overlap at 390px. Mirrors the members-list
          pattern in src/app/dashboard/settings/page.tsx (#258). */}
      <table className="hidden w-full text-sm sm:table">
        <thead>
          <tr className="border-b border-white/10 text-left text-zinc-400">
            <th className="pb-2 font-medium">Name</th>
            <th className="pb-2 font-medium">Status</th>
            <th className="pb-2 font-medium">Effective from</th>
            <th className="pb-2 font-medium">Source file</th>
            <th className="pb-2 font-medium">Uploaded by</th>
            <th className="pb-2 text-right font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {lists.map((l) => (
            <tr key={l.id} className="border-b border-white/5">
              <td className="py-2 text-zinc-200">{l.name}</td>
              <td className="py-2">
                <StatusBadge status={l.status} />
              </td>
              <td className="py-2 text-zinc-400">
                {l.effectiveFrom}
                {l.effectiveTo ? ` → ${l.effectiveTo}` : ""}
              </td>
              <td className="py-2 text-zinc-400">{l.sourceFileName ?? "—"}</td>
              <td className="py-2 text-zinc-400">{l.uploadedBy ?? "—"}</td>
              <td className="py-2 text-right">{renderActions(l)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="divide-y divide-white/5 text-sm sm:hidden">
        {lists.map((l) => (
          <li key={l.id} className="space-y-2 py-3">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-zinc-200">{l.name}</span>
              <StatusBadge status={l.status} />
            </div>
            <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
              <dt className="text-zinc-500">Effective</dt>
              <dd className="text-zinc-300">
                {l.effectiveFrom}
                {l.effectiveTo ? ` → ${l.effectiveTo}` : ""}
              </dd>
              <dt className="text-zinc-500">Source file</dt>
              <dd className="truncate text-zinc-300">
                {l.sourceFileName ?? "—"}
              </dd>
              <dt className="text-zinc-500">Uploaded by</dt>
              <dd className="truncate text-zinc-300">{l.uploadedBy ?? "—"}</dd>
            </dl>
            {l.status === "draft" && renderActions(l)}
          </li>
        ))}
      </ul>
    </div>
  );
}
