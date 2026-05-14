import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary", "html", "json-summary"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.test.tsx",
        "src/**/*.d.ts",
        "src/test-utils/**",
      ],
      // Baseline floor captured in #281 — ratchet up only; never lower without filing a follow-up.
      // Follow-ups #282/#283/#284 raise it. CI runs `test:coverage` informationally; fail-gate work
      // belongs to #290. The floor is rounded down from the measured baseline so trivial fluctuation
      // doesn't flake CI.
      thresholds: {
        lines: 60,
        statements: 58,
        functions: 53,
        branches: 52,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
