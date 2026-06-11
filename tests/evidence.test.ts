import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { normalizeExistingEvidence, normalizeRawEvidence, summarizeEvidenceForLLM } from "../src/evidence.js";
import type { EvidenceItem } from "../src/schemas.js";
import type { RawEvidenceInput } from "../src/evidence.js";

interface GoldenCase {
  input: RawEvidenceInput;
  expected: {
    evidence_count: number;
    data_gap_count: number;
    domain: string;
    schema?: string;
    dedupe_key?: string;
    source_ref?: string;
    min_confidence?: number;
    max_confidence?: number;
    reason_code?: string;
    warning?: string;
    dedupe_warning?: string;
    value?: unknown;
  };
}

const fixtureNames = [
  "quote.golden.json",
  "financials.golden.json",
  "announcement.golden.json",
  "news.golden.json",
  "dedupe.golden.json",
  "invalid-schema.golden.json",
  "empty-result.golden.json",
  "unstructured-payload.golden.json",
  "partial-fields.golden.json",
  "freshness-stale.golden.json",
  "macro-domain.golden.json",
  "profile-domain.golden.json",
];

for (const fixtureName of fixtureNames) {
  test(`normalizes golden evidence fixture: ${fixtureName}`, async () => {
    const golden = await readGolden(fixtureName);
    const result = normalizeRawEvidence(golden.input);
    const first = result.evidence[0];

    assert.equal(result.evidence.length, golden.expected.evidence_count);
    assert.equal(result.data_gaps.length, golden.expected.data_gap_count);
    if (golden.expected.evidence_count > 0) {
      assert.equal(first?.schema_version, "evidence.v1");
      assert.equal(first?.domain, golden.expected.domain);
      assert.equal(first?.source_meta?.vendor, golden.input.vendor);
      assert.ok(first?.source_meta?.raw_hash);
    }

    if (golden.expected.schema) {
      assert.equal((first?.value as { schema?: string } | undefined)?.schema, golden.expected.schema);
    }
    if (golden.expected.value !== undefined) {
      assert.deepEqual(first?.value, reviveGoldenValue(golden.expected.value));
    }
    if (golden.expected.dedupe_key) {
      assert.equal(first?.quality?.dedupe_key, golden.expected.dedupe_key);
    }
    if (golden.expected.source_ref) {
      assert.equal(first?.source_meta?.ref, golden.expected.source_ref);
      assert.ok(!first.source_meta.ref.includes("token=secret"));
    }
    if (golden.expected.min_confidence !== undefined) {
      assert.ok((first?.confidence ?? 0) >= golden.expected.min_confidence);
    }
    if (golden.expected.max_confidence !== undefined) {
      assert.ok((first?.confidence ?? 1) <= golden.expected.max_confidence);
    }
    if (golden.expected.reason_code) {
      assert.equal(result.data_gaps[0]?.reason_code, golden.expected.reason_code);
    }
    if (golden.expected.warning) {
      assert.ok(first?.quality?.warnings.includes(golden.expected.warning));
    }
    if (golden.expected.dedupe_warning) {
      assert.ok(first?.quality?.warnings.some((warning) => warning.startsWith(golden.expected.dedupe_warning ?? "")));
    }
  });
}

test("normalization accepts non-iFind API evidence sources", () => {
  const result = normalizeRawEvidence({
    source_type: "api",
    vendor: "wind",
    server: "equity-api",
    source_name: "wind-equity-api",
    query: "CATL quote snapshot",
    target: "CATL",
    intent: "quote",
    endpoint: "https://data.example.test/equity?api_key=secret",
    tool: "quote_snapshot",
    retrieved_at: "2026-06-10T00:00:00.000Z",
    raw: {
      symbol: "300750.SZ",
      name: "CATL",
      market: "A-share",
      price: 245.6,
      open: 242.1,
      high: 248.2,
      low: 240.3,
      prev_close: 241.26,
      change_pct: 1.8,
      volume: 12345678,
      turnover: 3012345678,
      trade_date: "2026-06-10",
    },
  });

  assert.equal(result.data_gaps.length, 0);
  assert.equal(result.evidence[0]?.source_type, "api");
  assert.equal(result.evidence[0]?.source_meta?.vendor, "wind");
  assert.equal(result.evidence[0]?.source_meta?.server, "equity-api");
  assert.equal(result.evidence[0]?.quality?.dedupe_key, "wind:quote:catl:2026-06-10:2026-06-10");
  assert.equal(result.evidence[0]?.source_meta?.ref, "https://data.example.test/equity#quote_snapshot");
});

test("summarizeEvidenceForLLM emits the stable LLM-facing evidence shape", () => {
  const normalized = normalizeRawEvidence({
    source_type: "api",
    vendor: "wind",
    server: "equity-api",
    source_name: "wind-equity-api",
    query: "CATL quote snapshot",
    target: "CATL",
    intent: "quote",
    retrieved_at: "2026-06-10T00:00:00.000Z",
    raw: {
      symbol: "300750.SZ",
      name: "CATL",
      market: "A-share",
      price: 245.6,
      prev_close: 241.26,
      change_pct: 1.8,
      volume: 12345678,
      turnover: 3012345678,
      trade_date: "2026-06-10",
    },
  });

  assert.deepEqual(summarizeEvidenceForLLM(normalized.evidence), [
    {
      id: normalized.evidence[0]?.id,
      domain: "quote",
      source_type: "api",
      source_name: "wind-equity-api",
      query: "CATL quote snapshot",
      as_of: "2026-06-10",
      retrieved_at: "2026-06-10T00:00:00.000Z",
      confidence: normalized.evidence[0]?.quality?.confidence,
      quality: normalized.evidence[0]?.quality,
      value: normalized.evidence[0]?.value,
    },
  ]);
});

test("normalizeExistingEvidence enriches legacy evidence with recalculated quality", () => {
  const legacy: EvidenceItem = {
    id: "legacy-quote",
    source_type: "api",
    source_name: "legacy-api",
    query: "CATL quote snapshot",
    as_of: "2026-06-10",
    retrieved_at: "2026-06-10T00:00:00.000Z",
    confidence: 0.2,
    value: {
      schema: "quote.v1",
      symbol: "300750.SZ",
      name: "CATL",
      market: "A-share",
      price: 245.6,
      prev_close: 241.26,
      change_pct: 1.8,
      volume: 12345678,
      turnover: 3012345678,
      trade_date: "2026-06-10",
    },
  };

  const [item] = normalizeExistingEvidence([legacy]);
  assert.equal(item?.schema_version, "evidence.v1");
  assert.equal(item?.domain, "quote");
  assert.equal(item?.quality?.completeness, 1);
  assert.equal(item?.quality?.freshness, 1);
  assert.equal(item?.confidence, item?.quality?.confidence);
});

test("normalization emits parse_error for malformed JSON payloads", () => {
  const result = normalizeRawEvidence({
    source_type: "api",
    vendor: "generic-api",
    source_name: "generic-api",
    query: "CATL malformed quote",
    target: "CATL",
    intent: "quote",
    retrieved_at: "2026-06-10T00:00:00.000Z",
    raw: "{\"symbol\":\"300750.SZ\"",
  });

  assert.equal(result.data_gaps.some((gap) => gap.reason_code === "parse_error"), true);
  assert.equal(result.data_gaps.some((gap) => gap.reason_code === "schema_invalid"), true);
});

test("normalization emits stale_data when as_of is too old", () => {
  const result = normalizeRawEvidence({
    source_type: "api",
    vendor: "generic-api",
    source_name: "generic-api",
    query: "CATL old quote",
    target: "CATL",
    intent: "quote",
    retrieved_at: "2026-06-10T00:00:00.000Z",
    raw: {
      symbol: "300750.SZ",
      name: "CATL",
      market: "A-share",
      price: 245.6,
      prev_close: 241.26,
      change_pct: 1.8,
      volume: 12345678,
      turnover: 3012345678,
      trade_date: "2025-01-01",
    },
  });

  assert.equal(result.evidence[0]?.quality?.freshness, 0.4);
  assert.equal(result.data_gaps[0]?.reason_code, "stale_data");
});

test("profile and macro domains use explicit minimal schemas", () => {
  const profile = normalizeRawEvidence({
    source_type: "api",
    vendor: "company-api",
    source_name: "company-api",
    query: "CATL profile",
    target: "CATL",
    intent: "profile",
    retrieved_at: "2026-06-10T00:00:00.000Z",
    raw: {
      symbol: "300750.SZ",
      name: "CATL",
      market: "A-share",
      industry: "Battery",
      business_scope: "Power batteries and energy storage systems",
      as_of: "2026-06-10",
    },
  });
  const macro = normalizeRawEvidence({
    source_type: "api",
    vendor: "macro-api",
    source_name: "macro-api",
    query: "China PMI",
    intent: "macro",
    retrieved_at: "2026-06-10T00:00:00.000Z",
    raw: {
      indicator_name: "PMI",
      region: "China",
      frequency: "monthly",
      value: 50.2,
      unit: "index",
      period: "2026-05",
    },
  });

  assert.equal((profile.evidence[0]?.value as { schema?: string } | undefined)?.schema, "profile.v1");
  assert.equal(profile.evidence[0]?.quality?.completeness, 1);
  assert.equal((macro.evidence[0]?.value as { schema?: string } | undefined)?.schema, "macro.v1");
  assert.equal(macro.evidence[0]?.quality?.completeness, 1);
});

test("announcement evidence accepts source ids without source URLs", () => {
  const result = normalizeRawEvidence({
    source_type: "api",
    vendor: "announcement-api",
    source_name: "announcement-api",
    query: "CATL announcement",
    target: "CATL",
    intent: "announcement",
    retrieved_at: "2026-06-10T00:00:00.000Z",
    raw: {
      symbol: "300750.SZ",
      name: "CATL",
      title: "Board resolution",
      published_at: "2026-06-10T08:00:00.000Z",
      category: "board",
      source_id: "notice-1",
      summary: "Board approved a financing plan.",
    },
  });

  assert.equal(result.data_gaps.length, 0);
  assert.equal(result.evidence[0]?.quality?.completeness, 1);
  assert.equal((result.evidence[0]?.value as { source_id?: string } | undefined)?.source_id, "notice-1");
});

test("news sentiment maps common labels and warns on unknown labels", () => {
  const bullish = normalizeRawEvidence({
    source_type: "api",
    vendor: "news-api",
    source_name: "news-api",
    query: "CATL bullish news",
    target: "CATL",
    intent: "news",
    retrieved_at: "2026-06-10T00:00:00.000Z",
    raw: {
      title: "CATL signs supply agreement",
      published_at: "2026-06-10T08:00:00.000Z",
      source: "Example News",
      related_symbols: ["300750.SZ"],
      summary: "CATL signed a new agreement.",
      sentiment: "bullish",
    },
  });
  const unknown = normalizeRawEvidence({
    source_type: "api",
    vendor: "news-api",
    source_name: "news-api",
    query: "CATL odd sentiment news",
    target: "CATL",
    intent: "news",
    retrieved_at: "2026-06-10T00:00:00.000Z",
    raw: {
      title: "CATL update",
      published_at: "2026-06-10T08:00:00.000Z",
      source: "Example News",
      related_symbols: ["300750.SZ"],
      summary: "CATL released an update.",
      sentiment: "constructive",
    },
  });

  assert.equal((bullish.evidence[0]?.value as { sentiment?: string } | undefined)?.sentiment, "positive");
  assert.equal(
    unknown.evidence[0]?.quality?.warnings.some((warning) => warning === "unrecognized_sentiment:constructive"),
    true,
  );
});

async function readGolden(name: string): Promise<GoldenCase> {
  const url = new URL(`../../tests/fixtures/${name}`, import.meta.url);
  return JSON.parse(await readFile(url, "utf8")) as GoldenCase;
}

function reviveGoldenValue(value: unknown): unknown {
  if (value === "__NaN__") return Number.NaN;
  if (Array.isArray(value)) return value.map((item) => reviveGoldenValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, reviveGoldenValue(item)]),
    );
  }
  return value;
}
