/**
 * #232: CSV parser for the Settings → Pricing upload flow.
 *
 * Accepts the canonical CSV described in ADR-0094 §2:
 *
 *   Platform,Model,Type,Region,List Price (USD/MTok/Month),Sale Price (USD/MTok/Month)
 *   Bedrock,Claude Sonnet 4.5,Prompts,Regional (Non-global),$3.30,$3.20
 *
 * Normalization (issue #232):
 *   - Trim `$` from price columns; accept bare numbers.
 *   - `Type`: `Prompts` → `input`, `Outputs` → `output`,
 *             `Cache Read` → `cache_read`, `Cache Write` → `cache_write`.
 *   - `Region`: `Regional (Non-global)` → `regional`, `Global` → `global`,
 *               `US` → `us`.
 *   - `Platform`: lower-cased; preserved verbatim otherwise so an org running
 *     Azure-OpenAI through a private vendor name still round-trips.
 *
 * Model alias resolution does NOT happen here — the parser only flags which
 * rows are "mapped" vs "unmapped" given a caller-supplied alias dictionary,
 * so the UI's preview screen can show counts without coupling parsing to the
 * database round-trip.
 */

export type TokenType = "input" | "output" | "cache_read" | "cache_write";

export type ParsedPriceRow = {
  /** 1-indexed row number in the source file (header is row 1). */
  lineNumber: number;
  platform: string;
  model: string;
  tokenType: TokenType;
  region: string | null;
  listUsdPerMtok: number | null;
  saleUsdPerMtok: number;
  /** True when `model` matched a `model_aliases` entry (or equals a display name). */
  mapped: boolean;
  /** The raw row, key-preserved, for storage in `org_price_list_rows.raw_row`. */
  raw: Record<string, string>;
};

export type ParseError = {
  lineNumber: number;
  message: string;
};

export type ParseResult = {
  rows: ParsedPriceRow[];
  errors: ParseError[];
  /** Number of rows whose `Model` matched the alias dictionary. */
  mappedCount: number;
  /** Number of rows with an unmapped model (still committable per the issue). */
  unmappedCount: number;
};

const REQUIRED_HEADERS = [
  "Platform",
  "Model",
  "Type",
  "Region",
  "List Price (USD/MTok/Month)",
  "Sale Price (USD/MTok/Month)",
] as const;

const TYPE_MAP: Record<string, TokenType> = {
  prompts: "input",
  prompt: "input",
  input: "input",
  outputs: "output",
  output: "output",
  "cache read": "cache_read",
  cache_read: "cache_read",
  "cache write": "cache_write",
  cache_write: "cache_write",
};

const REGION_MAP: Record<string, string | null> = {
  "regional (non-global)": "regional",
  regional: "regional",
  global: "global",
  us: "us",
  "": null,
};

/**
 * Minimal RFC-4180-ish CSV splitter — handles double-quoted fields with
 * embedded commas and escaped quotes (`""`). Not a full parser; we accept it
 * because every CSV we expect is exported by humans from a spreadsheet and
 * doesn't carry newlines inside fields.
 */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else if (ch === '"' && cur === "") {
      inQuotes = true;
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function parsePrice(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s]/g, "");
  if (cleaned === "" || cleaned === "-") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

export type AliasDict = {
  /** Set of canonical display names from `model_aliases.display_name`. */
  displayNames: Set<string>;
  /** Map each wire-model pattern → its canonical display name. */
  patternToDisplay: Map<string, string>;
};

/** Build an alias dictionary from `{display_name, patterns}` rows. */
export function buildAliasDict(
  rows: Array<{ display_name: string; patterns: string[] | null }>
): AliasDict {
  const displayNames = new Set<string>();
  const patternToDisplay = new Map<string, string>();
  for (const row of rows) {
    if (!row.display_name) continue;
    displayNames.add(row.display_name);
    for (const p of row.patterns ?? []) {
      if (p) patternToDisplay.set(p, row.display_name);
    }
  }
  return { displayNames, patternToDisplay };
}

/**
 * Parse the canonical CSV. Header row is required; missing required headers
 * produce a single error and an empty result so the caller can surface it
 * without rendering an empty preview.
 */
export function parsePricingCsv(
  source: string,
  aliases: AliasDict = { displayNames: new Set(), patternToDisplay: new Map() }
): ParseResult {
  const lines = source
    .split(/\r?\n/)
    .map((l) => l)
    .filter((l, idx) => !(idx > 0 && l.trim() === ""));

  if (lines.length === 0 || lines[0]!.trim() === "") {
    return {
      rows: [],
      errors: [{ lineNumber: 1, message: "Empty file" }],
      mappedCount: 0,
      unmappedCount: 0,
    };
  }

  const header = splitCsvLine(lines[0]!);
  const missing = REQUIRED_HEADERS.filter((h) => !header.includes(h));
  if (missing.length > 0) {
    return {
      rows: [],
      errors: [
        {
          lineNumber: 1,
          message: `Missing required column(s): ${missing.join(", ")}`,
        },
      ],
      mappedCount: 0,
      unmappedCount: 0,
    };
  }

  const colIdx: Record<(typeof REQUIRED_HEADERS)[number], number> = {
    Platform: header.indexOf("Platform"),
    Model: header.indexOf("Model"),
    Type: header.indexOf("Type"),
    Region: header.indexOf("Region"),
    "List Price (USD/MTok/Month)": header.indexOf(
      "List Price (USD/MTok/Month)"
    ),
    "Sale Price (USD/MTok/Month)": header.indexOf(
      "Sale Price (USD/MTok/Month)"
    ),
  };

  const rows: ParsedPriceRow[] = [];
  const errors: ParseError[] = [];

  for (let i = 1; i < lines.length; i++) {
    const rawLine = lines[i]!;
    if (rawLine.trim() === "") continue;

    const fields = splitCsvLine(rawLine);
    const lineNumber = i + 1;

    const platform = (fields[colIdx.Platform] ?? "").trim().toLowerCase();
    const model = (fields[colIdx.Model] ?? "").trim();
    const typeRaw = (fields[colIdx.Type] ?? "").trim().toLowerCase();
    const regionRaw = (fields[colIdx.Region] ?? "").trim().toLowerCase();
    const listRaw = fields[colIdx["List Price (USD/MTok/Month)"]] ?? "";
    const saleRaw = fields[colIdx["Sale Price (USD/MTok/Month)"]] ?? "";

    if (!platform) {
      errors.push({ lineNumber, message: "Missing Platform" });
      continue;
    }
    if (!model) {
      errors.push({ lineNumber, message: "Missing Model" });
      continue;
    }
    const tokenType = TYPE_MAP[typeRaw];
    if (!tokenType) {
      errors.push({ lineNumber, message: `Unknown Type: "${typeRaw}"` });
      continue;
    }
    const region =
      regionRaw in REGION_MAP ? REGION_MAP[regionRaw] : regionRaw || null;

    const sale = parsePrice(saleRaw);
    if (sale === null || Number.isNaN(sale) || sale < 0) {
      errors.push({
        lineNumber,
        message: `Invalid Sale Price: "${saleRaw}"`,
      });
      continue;
    }
    const list = parsePrice(listRaw);
    if (list !== null && (Number.isNaN(list) || list < 0)) {
      errors.push({
        lineNumber,
        message: `Invalid List Price: "${listRaw}"`,
      });
      continue;
    }

    // Resolve canonical model: alias display-name match wins; otherwise check
    // if a pattern lookup canonicalizes; otherwise mark unmapped (still kept).
    let canonicalModel = model;
    let mapped = false;
    if (aliases.displayNames.has(model)) {
      mapped = true;
    } else if (aliases.patternToDisplay.has(model)) {
      canonicalModel = aliases.patternToDisplay.get(model)!;
      mapped = true;
    }

    const raw: Record<string, string> = {};
    for (const h of header) {
      raw[h] = (fields[header.indexOf(h)] ?? "").trim();
    }

    rows.push({
      lineNumber,
      platform,
      model: canonicalModel,
      tokenType,
      region,
      listUsdPerMtok: list,
      saleUsdPerMtok: sale,
      mapped,
      raw,
    });
  }

  return {
    rows,
    errors,
    mappedCount: rows.filter((r) => r.mapped).length,
    unmappedCount: rows.filter((r) => !r.mapped).length,
  };
}
