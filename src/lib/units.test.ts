import { describe, it, expect } from "vitest";
import { DEFAULT_UNIT, UNITS, UNITS_STORAGE_KEY, parseUnit } from "./units";

/**
 * #282: pin the `?units=` parser contract. The Overview / Repos / Team
 * charts all read this on every render, and a regression that quietly
 * flips the fallback would change every dollar axis on a no-query-string
 * URL into a tokens axis (or vice versa).
 */

describe("parseUnit", () => {
  it('returns "tokens" only for the exact literal', () => {
    expect(parseUnit("tokens")).toBe("tokens");
  });

  it('returns "dollars" for the matching literal', () => {
    expect(parseUnit("dollars")).toBe("dollars");
  });

  it("falls back to the default for missing/empty input", () => {
    expect(parseUnit(null)).toBe(DEFAULT_UNIT);
    expect(parseUnit(undefined)).toBe(DEFAULT_UNIT);
    expect(parseUnit("")).toBe(DEFAULT_UNIT);
  });

  it("falls back to the default for unknown values without throwing", () => {
    expect(parseUnit("euros")).toBe(DEFAULT_UNIT);
    expect(parseUnit("TOKENS")).toBe(DEFAULT_UNIT);
    expect(parseUnit(" tokens")).toBe(DEFAULT_UNIT);
  });
});

describe("units constants", () => {
  it("exposes both units with the wire values the parser accepts", () => {
    expect(UNITS.map((u) => u.value).sort()).toEqual(["dollars", "tokens"]);
  });

  it("uses a namespaced storage key so it never collides with another widget", () => {
    expect(UNITS_STORAGE_KEY).toMatch(/^budi\./);
  });

  it("defaults to dollars — the finance lens most viewers land on", () => {
    expect(DEFAULT_UNIT).toBe("dollars");
  });
});
