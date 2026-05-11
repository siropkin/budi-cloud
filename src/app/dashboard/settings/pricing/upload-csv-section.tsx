"use client";

import { useState, useTransition, useRef } from "react";
import {
  commitPricingDraft,
  previewPricingCsv,
  type CsvPreview,
} from "@/app/actions/pricing";

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

export function UploadCsvSection() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState<string>(todayISO());
  const [isPending, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);

  function reset() {
    setFile(null);
    setPreview(null);
    setError(null);
    setName("");
    setDescription("");
    setEffectiveFrom(todayISO());
    formRef.current?.reset();
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    setFile(f);
    setPreview(null);
    setError(null);
    if (f && !name) {
      // Default the list name to the filename minus extension.
      setName(f.name.replace(/\.[^.]+$/, ""));
    }
  }

  function handlePreview() {
    if (!file) {
      setError("Choose a CSV file");
      return;
    }
    setError(null);
    const fd = new FormData();
    fd.set("file", file);
    startTransition(async () => {
      const res = await previewPricingCsv(fd);
      if (res.error) {
        setError(res.error);
      } else if (res.preview) {
        setPreview(res.preview);
      }
    });
  }

  function handleCommit() {
    if (!file) {
      setError("Choose a CSV file");
      return;
    }
    if (!name.trim()) {
      setError("Name is required");
      return;
    }
    setError(null);
    const fd = new FormData();
    fd.set("file", file);
    fd.set("name", name);
    fd.set("description", description);
    fd.set("effective_from", effectiveFrom);
    startTransition(async () => {
      const res = await commitPricingDraft(undefined, fd);
      if (res.error) {
        setError(res.error);
      } else {
        reset();
      }
    });
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-zinc-400">
        Canonical columns:{" "}
        <code className="rounded bg-black/40 px-1 text-xs text-zinc-300">
          Platform, Model, Type, Region, List Price (USD/MTok/Month), Sale Price
          (USD/MTok/Month)
        </code>
      </p>

      <form ref={formRef} className="space-y-4">
        <label className="block text-sm">
          <span className="mb-1 block text-zinc-300">CSV file</span>
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={handleFileChange}
            className="block w-full text-sm text-zinc-400 file:mr-3 file:rounded-md file:border-0 file:bg-white/10 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-zinc-200 hover:file:bg-white/15"
          />
        </label>

        {file && !preview && (
          <button
            type="button"
            onClick={handlePreview}
            disabled={isPending}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            {isPending ? "Parsing…" : "Preview"}
          </button>
        )}
      </form>

      {error && (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {preview && <PreviewBlock preview={preview} />}

      {preview && preview.totalRows > 0 && (
        <div className="space-y-4 border-t border-white/10 pt-4">
          {preview.duplicateOfListName && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-300">
              Duplicate filename: a previous upload named &quot;
              {preview.duplicateOfListName}&quot; used the same file. You can
              still create a new draft.
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="mb-1 block text-zinc-300">Name</span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded-md border border-white/10 bg-black/40 px-3 py-2 text-sm text-zinc-200"
              />
            </label>

            <label className="block text-sm">
              <span className="mb-1 block text-zinc-300">Effective from</span>
              <input
                type="date"
                value={effectiveFrom}
                onChange={(e) => setEffectiveFrom(e.target.value)}
                className="w-full rounded-md border border-white/10 bg-black/40 px-3 py-2 text-sm text-zinc-200"
              />
            </label>
          </div>

          <label className="block text-sm">
            <span className="mb-1 block text-zinc-300">
              Description (optional)
            </span>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full rounded-md border border-white/10 bg-black/40 px-3 py-2 text-sm text-zinc-200"
            />
          </label>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleCommit}
              disabled={isPending}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-700 disabled:opacity-50"
            >
              {isPending ? "Saving…" : "Commit as draft"}
            </button>
            <button
              type="button"
              onClick={reset}
              disabled={isPending}
              className="rounded-lg bg-white/10 px-4 py-2 text-sm font-medium text-zinc-200 transition-colors hover:bg-white/15 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function PreviewBlock({ preview }: { preview: CsvPreview }) {
  return (
    <div className="space-y-3 border-t border-white/10 pt-4">
      <div className="grid grid-cols-3 gap-3 text-sm">
        <Stat label="Parsed rows" value={preview.totalRows} />
        <Stat label="Mapped" value={preview.mappedCount} />
        <Stat
          label="Unmapped"
          value={preview.unmappedCount}
          tone={preview.unmappedCount > 0 ? "warn" : "ok"}
        />
      </div>

      {preview.errors.length > 0 && (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300">
          <p className="mb-1 font-medium">Errors</p>
          <ul className="list-inside list-disc space-y-0.5">
            {preview.errors.slice(0, 10).map((e, i) => (
              <li key={i}>
                Line {e.lineNumber}: {e.message}
              </li>
            ))}
            {preview.errors.length > 10 && (
              <li>…and {preview.errors.length - 10} more</li>
            )}
          </ul>
        </div>
      )}

      {preview.unmappedModels.length > 0 && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-300">
          <p className="mb-1 font-medium">
            Unmapped models (still committable)
          </p>
          <p>{preview.unmappedModels.join(", ")}</p>
        </div>
      )}

      {preview.sampleMapped.length > 0 && (
        <div>
          <p className="mb-2 text-xs font-medium text-zinc-400">
            Sample mapped rows
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-white/10 text-left text-zinc-500">
                  <th className="pb-1 font-medium">Model</th>
                  <th className="pb-1 font-medium">Token</th>
                  <th className="pb-1 font-medium">Region</th>
                  <th className="pb-1 font-medium text-right">List</th>
                  <th className="pb-1 font-medium text-right">Sale</th>
                </tr>
              </thead>
              <tbody>
                {preview.sampleMapped.map((r) => (
                  <tr key={r.lineNumber} className="border-b border-white/5">
                    <td className="py-1 text-zinc-300">{r.model}</td>
                    <td className="py-1 text-zinc-400">{r.tokenType}</td>
                    <td className="py-1 text-zinc-400">{r.region ?? "—"}</td>
                    <td className="py-1 text-right text-zinc-400">
                      {r.listUsdPerMtok === null
                        ? "—"
                        : `$${r.listUsdPerMtok.toFixed(2)}`}
                    </td>
                    <td className="py-1 text-right text-zinc-200">
                      ${r.saleUsdPerMtok.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "ok" | "warn";
}) {
  const valueClass =
    tone === "warn"
      ? "text-amber-300"
      : tone === "ok"
        ? "text-emerald-300"
        : "text-zinc-100";
  return (
    <div className="rounded-md border border-white/10 bg-black/40 p-3">
      <p className="text-xs text-zinc-500">{label}</p>
      <p className={`mt-1 text-lg font-semibold ${valueClass}`}>{value}</p>
    </div>
  );
}
