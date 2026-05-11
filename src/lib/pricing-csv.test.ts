import { describe, it, expect } from "vitest";
import {
  buildAliasDict,
  normalizeVendorClaudeModel,
  parsePricingCsv,
} from "./pricing-csv";

const HEADER =
  "Platform,Model,Type,Region,List Price (USD/MTok/Month),Sale Price (USD/MTok/Month)";

describe("normalizeVendorClaudeModel", () => {
  it("converts vendor display names to canonical wire ids", () => {
    expect(normalizeVendorClaudeModel("Claude Sonnet 4.5")).toBe(
      "claude-sonnet-4-5"
    );
    expect(normalizeVendorClaudeModel("Claude Opus 4.5")).toBe(
      "claude-opus-4-5"
    );
    expect(normalizeVendorClaudeModel("Claude Haiku 4.5")).toBe(
      "claude-haiku-4-5"
    );
    expect(normalizeVendorClaudeModel("Claude Opus 4.6")).toBe(
      "claude-opus-4-6"
    );
  });

  it("tolerates case and whitespace variation", () => {
    expect(normalizeVendorClaudeModel("claude opus 4.5")).toBe(
      "claude-opus-4-5"
    );
    expect(normalizeVendorClaudeModel("  Claude   Sonnet   4.5  ")).toBe(
      "claude-sonnet-4-5"
    );
    expect(normalizeVendorClaudeModel("Claude-Sonnet-4.5")).toBe(
      "claude-sonnet-4-5"
    );
  });

  it("returns null for non-Claude or non-matching shapes", () => {
    expect(normalizeVendorClaudeModel("Claude Sonnet 4")).toBeNull();
    expect(normalizeVendorClaudeModel("Claude Banana 4.5")).toBeNull();
    expect(normalizeVendorClaudeModel("GPT-4o")).toBeNull();
    expect(normalizeVendorClaudeModel("claude-sonnet-4-5")).toBeNull();
    expect(normalizeVendorClaudeModel("")).toBeNull();
  });
});

describe("parsePricingCsv", () => {
  it("rejects a file missing required headers", () => {
    const result = parsePricingCsv("Foo,Bar\n1,2\n");
    expect(result.rows).toHaveLength(0);
    expect(result.errors[0]?.message).toMatch(/Missing required column/);
  });

  it("rejects an empty file", () => {
    const result = parsePricingCsv("");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toBe("Empty file");
  });

  it("normalizes Type / Region / price values", () => {
    const csv = [
      HEADER,
      "Bedrock,Claude Sonnet 4.5,Prompts,Regional (Non-global),$3.30,$3.20",
      "Bedrock,Claude Sonnet 4.5,Outputs,Global,$15.00,$14.00",
      "Bedrock,Claude Sonnet 4.5,Cache Read,US,$0.30,$0.30",
      "Bedrock,Claude Sonnet 4.5,Cache Write,,$3.75,$3.75",
    ].join("\n");

    const result = parsePricingCsv(csv);
    expect(result.errors).toHaveLength(0);
    expect(result.rows).toHaveLength(4);

    // Vendor display "Claude Sonnet 4.5" is normalized to its canonical wire
    // id even without an alias dictionary (#244).
    expect(result.rows[0]).toMatchObject({
      platform: "bedrock",
      model: "claude-sonnet-4-5",
      tokenType: "input",
      region: "regional",
      listUsdPerMtok: 3.3,
      saleUsdPerMtok: 3.2,
    });
    expect(result.rows[1].tokenType).toBe("output");
    expect(result.rows[1].region).toBe("global");
    expect(result.rows[2].tokenType).toBe("cache_read");
    expect(result.rows[2].region).toBe("us");
    expect(result.rows[3].tokenType).toBe("cache_write");
    expect(result.rows[3].region).toBeNull();
  });

  it("flags rows with invalid prices but keeps the good rows", () => {
    const csv = [
      HEADER,
      "Bedrock,X,Prompts,Global,$1,$0.10",
      "Bedrock,X,Prompts,Global,$1,not a number",
    ].join("\n");

    const result = parsePricingCsv(csv);
    expect(result.rows).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toMatch(/Invalid Sale Price/);
  });

  it("marks rows mapped/unmapped via the alias dictionary", () => {
    const aliases = buildAliasDict([
      {
        display_name: "Claude Sonnet 4.5",
        patterns: ["claude-sonnet-4-5", "claude-sonnet-4.5"],
      },
    ]);

    const csv = [
      HEADER,
      "Bedrock,Claude Sonnet 4.5,Prompts,Global,$3.30,$3.20",
      "Bedrock,claude-sonnet-4-5,Prompts,Global,$3.30,$3.20",
      "Bedrock,Mystery Model,Prompts,Global,$1.00,$0.50",
    ].join("\n");

    const result = parsePricingCsv(csv, aliases);
    expect(result.rows).toHaveLength(3);
    expect(result.rows[0]).toMatchObject({
      model: "Claude Sonnet 4.5",
      mapped: true,
    });
    // Pattern match canonicalizes to the display name.
    expect(result.rows[1]).toMatchObject({
      model: "Claude Sonnet 4.5",
      mapped: true,
    });
    expect(result.rows[2]).toMatchObject({
      model: "Mystery Model",
      mapped: false,
    });
    expect(result.mappedCount).toBe(2);
    expect(result.unmappedCount).toBe(1);
  });

  it("treats a missing List price as null but keeps the row", () => {
    const csv = [HEADER, "Bedrock,X,Prompts,Global,,$0.10"].join("\n");

    const result = parsePricingCsv(csv);
    expect(result.errors).toHaveLength(0);
    expect(result.rows[0]?.listUsdPerMtok).toBeNull();
    expect(result.rows[0]?.saleUsdPerMtok).toBe(0.1);
  });

  it("maps vendor display names to canonical wire ids (#244)", () => {
    // model_aliases is empty — the vendor-display normalizer is the only
    // thing that should make these map.
    const aliases = buildAliasDict([]);

    const csv = [
      HEADER,
      "Anthropic,Claude Sonnet 4.5,Prompts,Global,$3.00,$3.00",
      "Anthropic,Claude Opus 4.5,Prompts,Global,$15.00,$15.00",
      "Anthropic,Claude Haiku 4.5,Prompts,Global,$0.80,$0.80",
      "Anthropic,Claude Opus 4.6,Prompts,Global,$15.00,$15.00",
    ].join("\n");

    const result = parsePricingCsv(csv, aliases);
    expect(result.errors).toHaveLength(0);
    expect(result.rows).toHaveLength(4);
    expect(result.mappedCount).toBe(4);
    expect(result.unmappedCount).toBe(0);
    expect(result.rows.map((r) => r.model)).toEqual([
      "claude-sonnet-4-5",
      "claude-opus-4-5",
      "claude-haiku-4-5",
      "claude-opus-4-6",
    ]);
  });

  it("maps daemon-emitted wire ids when known to the org (#244 regression)", () => {
    // model_aliases empty, but the org has uploaded "claude-sonnet-4-5"
    // rollups before — the known-models hint should still map the row.
    const aliases = buildAliasDict([], ["claude-sonnet-4-5"]);

    const csv = [
      HEADER,
      "Anthropic,claude-sonnet-4-5,Prompts,Global,$3.00,$3.00",
    ].join("\n");

    const result = parsePricingCsv(csv, aliases);
    expect(result.errors).toHaveLength(0);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      model: "claude-sonnet-4-5",
      mapped: true,
    });
  });

  it("ignores blank lines between rows", () => {
    const csv = [
      HEADER,
      "",
      "Bedrock,X,Prompts,Global,$1,$1",
      "",
      "Bedrock,X,Outputs,Global,$2,$2",
    ].join("\n");

    const result = parsePricingCsv(csv);
    expect(result.errors).toHaveLength(0);
    expect(result.rows).toHaveLength(2);
  });
});
