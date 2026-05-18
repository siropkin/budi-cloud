"use client";

import { useState, useTransition } from "react";
import { savePricingDefaults } from "@/app/actions/pricing";

const PLATFORM_OPTIONS = [
  { value: "", label: "— None —" },
  { value: "bedrock", label: "Bedrock" },
  { value: "anthropic", label: "Anthropic" },
  { value: "vertex", label: "Vertex" },
  { value: "azure-openai", label: "Azure-OpenAI" },
];

const REGION_OPTIONS = [
  { value: "", label: "— None —" },
  { value: "global", label: "Global" },
  { value: "regional", label: "Regional" },
  { value: "us", label: "US" },
];

export function DefaultsForm({
  initialPlatform,
  initialRegion,
}: {
  initialPlatform: string | null;
  initialRegion: string | null;
}) {
  const [platform, setPlatform] = useState(initialPlatform ?? "");
  const [region, setRegion] = useState(initialRegion ?? "");
  const [message, setMessage] = useState<{
    kind: "ok" | "error";
    text: string;
  } | null>(null);
  const [isPending, startTransition] = useTransition();

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    setMessage(null);
    startTransition(async () => {
      const result = await savePricingDefaults(undefined, formData);
      if (result.error) {
        setMessage({ kind: "error", text: result.error });
      } else {
        setMessage({ kind: "ok", text: "Saved" });
      }
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <p className="text-sm text-zinc-400">
        Used to interpret ingested rows that don&apos;t carry a platform or
        region.
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block text-zinc-300">Default platform</span>
          <select
            name="default_platform"
            value={platform}
            onChange={(e) => setPlatform(e.target.value)}
            className="w-full rounded-md border border-white/10 bg-black/40 px-3 py-2 text-sm text-zinc-200"
          >
            {PLATFORM_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-sm">
          <span className="mb-1 block text-zinc-300">Default region</span>
          <select
            name="default_region"
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            className="w-full rounded-md border border-white/10 bg-black/40 px-3 py-2 text-sm text-zinc-200"
          >
            {REGION_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={isPending}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          {isPending ? "Saving…" : "Save defaults"}
        </button>
        {message && (
          <span
            className={
              message.kind === "ok"
                ? "text-sm text-emerald-400"
                : "text-sm text-red-400"
            }
          >
            {message.text}
          </span>
        )}
      </div>
    </form>
  );
}
