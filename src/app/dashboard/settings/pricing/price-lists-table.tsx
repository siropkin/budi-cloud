"use client";

import { useTransition, useState } from "react";
import {
  activatePricingList,
  discardPricingDraft,
} from "@/app/actions/pricing";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/responsive-table";

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

function formatEffective(l: PriceListRow): string {
  return l.effectiveTo
    ? `${l.effectiveFrom} → ${l.effectiveTo}`
    : l.effectiveFrom;
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

  const columns: ResponsiveColumn<PriceListRow>[] = [
    {
      key: "name",
      header: "Name",
      cellClassName: "text-zinc-200",
      render: (l) => l.name,
    },
    {
      key: "status",
      header: "Status",
      render: (l) => <StatusBadge status={l.status} />,
    },
    {
      key: "effective",
      header: "Effective from",
      cellClassName: "text-zinc-400",
      render: (l) => formatEffective(l),
    },
    {
      key: "source",
      header: "Source file",
      cellClassName: "text-zinc-400",
      render: (l) => l.sourceFileName ?? "—",
    },
    {
      key: "uploaded-by",
      header: "Uploaded by",
      cellClassName: "text-zinc-400",
      render: (l) => l.uploadedBy ?? "—",
    },
    {
      key: "actions",
      header: "Actions",
      align: "right",
      render: (l) => renderActions(l),
    },
  ];

  return (
    <div className="space-y-3">
      {error && <p className="text-sm text-red-400">{error}</p>}

      <ResponsiveTable
        columns={columns}
        rows={lists}
        rowKey={(l) => l.id}
        mobileItemClassName="space-y-2 py-3"
        mobileCard={(l) => (
          <>
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-zinc-200">{l.name}</span>
              <StatusBadge status={l.status} />
            </div>
            <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
              <dt className="text-zinc-500">Effective</dt>
              <dd className="text-zinc-300">{formatEffective(l)}</dd>
              <dt className="text-zinc-500">Source file</dt>
              <dd className="truncate text-zinc-300">
                {l.sourceFileName ?? "—"}
              </dd>
              <dt className="text-zinc-500">Uploaded by</dt>
              <dd className="truncate text-zinc-300">{l.uploadedBy ?? "—"}</dd>
            </dl>
            {l.status === "draft" && renderActions(l)}
          </>
        )}
      />
    </div>
  );
}
