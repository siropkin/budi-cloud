"use client";

import { useState } from "react";
import { Copy, Check, Eye, EyeOff } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

export function ApiKeySection({ apiKey }: { apiKey: string }) {
  const [copied, setCopied] = useState(false);
  const [revealed, setRevealed] = useState(false);

  const command = `budi cloud init --api-key ${apiKey}`;
  const displayCommand = revealed
    ? command
    : `budi cloud init --api-key ${maskApiKey(apiKey)}`;

  function handleCopy() {
    navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Your API Key</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="mb-2 text-sm text-zinc-400">
          Run this on your local machine to point Budi at your cloud account.
        </p>
        {/*
          Below sm: stack the action buttons under the code block so the
          masked command + two 100px buttons can't push past the card's
          right edge and force a page-level horizontal scrollbar (#122).
          From sm: keep the original single-row layout.
        */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <code className="block flex-1 whitespace-pre-wrap break-all rounded-lg bg-black/50 px-4 py-3 font-mono text-sm text-emerald-400">
            {displayCommand}
          </code>
          {/*
            min-width on both toggles keeps the code column from jumping
            when labels swap (Reveal→Hide, Copy→Copied).
          */}
          <div className="flex gap-2">
            <button
              onClick={() => setRevealed((v) => !v)}
              aria-label={revealed ? "Hide API key" : "Reveal API key"}
              className="inline-flex min-w-[6.25rem] flex-1 items-center justify-center gap-1.5 rounded-lg bg-white/10 px-3 py-2 text-sm font-medium text-zinc-200 transition-colors hover:bg-white/15 sm:flex-none"
            >
              {revealed ? (
                <>
                  <EyeOff className="h-4 w-4" /> Hide
                </>
              ) : (
                <>
                  <Eye className="h-4 w-4" /> Reveal
                </>
              )}
            </button>
            <button
              onClick={handleCopy}
              className="inline-flex min-w-[6.25rem] flex-1 items-center justify-center gap-1.5 rounded-lg bg-white/10 px-3 py-2 text-sm font-medium text-zinc-200 transition-colors hover:bg-white/15 sm:flex-none"
            >
              {copied ? (
                <>
                  <Check className="h-4 w-4" /> Copied
                </>
              ) : (
                <>
                  <Copy className="h-4 w-4" /> Copy
                </>
              )}
            </button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function maskApiKey(key: string): string {
  const idx = key.indexOf("_");
  if (idx >= 0) {
    const bodyLen = Math.max(key.length - idx - 1, 8);
    return key.slice(0, idx + 1) + "•".repeat(bodyLen);
  }
  return "•".repeat(Math.max(key.length, 12));
}
