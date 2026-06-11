import type {
  DataGap,
  DataGapReasonCode,
  EvidenceDomain,
  EvidenceIntent,
  EvidenceItem,
  EvidenceQuality,
  EvidenceSchemaVersion,
  EvidenceSourceMeta,
  EvidenceSourceServer,
  EvidenceSourceType,
} from "./schemas.js";

export const EVIDENCE_SCHEMA_VERSION: EvidenceSchemaVersion = "evidence.v1";

export interface RawEvidenceInput {
  source_type: EvidenceSourceType;
  vendor: string;
  server?: EvidenceSourceServer;
  source_name: string;
  query: string;
  target?: string;
  intent?: EvidenceIntent;
  endpoint?: string;
  tool?: string;
  retrieved_at: string;
  raw: unknown;
}

export interface NormalizedEvidenceBatch {
  evidence: EvidenceItem[];
  data_gaps: DataGap[];
}

const REQUIRED_FIELDS: Record<EvidenceDomain, string[]> = {
  quote: ["symbol", "name", "market", "price", "prev_close", "change_pct", "volume", "turnover", "trade_date"],
  financials: [
    "symbol",
    "name",
    "period",
    "report_type",
    "revenue",
    "net_profit",
    "gross_margin",
    "roe",
    "total_assets",
    "operating_cash_flow",
    "currency",
  ],
  announcement: ["symbol", "name", "title", "published_at", "category", "summary"],
  news: ["title", "published_at", "source", "related_symbols", "summary"],
  profile: ["symbol", "name", "market", "industry", "business_scope", "as_of"],
  macro: ["indicator_name", "region", "frequency", "value", "unit", "period"],
};

const SOURCE_BASE_CONFIDENCE: Record<EvidenceSourceType, number> = {
  ifind_mcp: 0.78,
  api: 0.74,
  knowledge_base: 0.68,
  web_search: 0.62,
  mock: 0.56,
  manual: 0.5,
};

export function normalizeRawEvidence(input: RawEvidenceInput): NormalizedEvidenceBatch {
  const parsed = extractPayloads(input.raw);
  const payloads = parsed.payloads;
  const data_gaps = parsed.parse_errors.map((reason) =>
    makeDataGap({
      source_name: input.source_name,
      query: input.query,
      reason,
      reason_code: "parse_error",
      occurred_at: input.retrieved_at,
      source_meta: buildSourceMeta(input, input.raw),
    }),
  );

  if (payloads.length === 0) {
    return {
      evidence: [],
      data_gaps: [
        ...data_gaps,
        makeDataGap({
          source_name: input.source_name,
          query: input.query,
          reason: "Evidence source returned no usable payload.",
          reason_code: "empty_result",
          occurred_at: input.retrieved_at,
          source_meta: buildSourceMeta(input, input.raw),
        }),
      ],
    };
  }

  const evidence: EvidenceItem[] = [];
  for (const payload of payloads) {
    const domain = inferDomain(input.intent, payload, input.query);
    const normalized = normalizeValue(domain, payload, input);
    const sourceMeta = buildSourceMeta(input, payload, normalized.as_of);
    const quality = scoreQuality({
      source_type: input.source_type,
      domain,
      value: normalized.value,
      source_meta: sourceMeta,
      warnings: normalized.warnings,
    });

    if (normalized.invalid) {
      data_gaps.push(
        makeDataGap({
          source_name: input.source_name,
          query: input.query,
          reason: `Evidence payload failed ${domain} schema: ${normalized.warnings.join("; ")}`,
          reason_code: "schema_invalid",
          occurred_at: input.retrieved_at,
          source_meta: sourceMeta,
        }),
      );
    }
    if (quality.freshness < 0.5) {
      data_gaps.push(
        makeDataGap({
          source_name: input.source_name,
          query: input.query,
          reason: `Evidence is stale: as_of=${sourceMeta.as_of}, retrieved_at=${sourceMeta.retrieved_at}`,
          reason_code: "stale_data",
          occurred_at: input.retrieved_at,
          source_meta: sourceMeta,
        }),
      );
    }

    evidence.push({
      schema_version: EVIDENCE_SCHEMA_VERSION,
      id: makeStableEvidenceId(input.vendor, domain, quality.dedupe_key),
      domain,
      source_type: input.source_type,
      source_name: input.source_name,
      query: input.query,
      as_of: sourceMeta.as_of,
      retrieved_at: input.retrieved_at,
      confidence: quality.confidence,
      source_meta: sourceMeta,
      quality,
      value: normalized.value,
      ...(typeof payload === "string" ? { raw_text: payload.slice(0, 2_000) } : {}),
      ...(sourceMeta.ref ? { raw_ref: sourceMeta.ref } : {}),
    });
  }

  return {
    evidence: dedupeEvidence(evidence),
    data_gaps,
  };
}

export function normalizeExistingEvidence(items: EvidenceItem[]): EvidenceItem[] {
  return dedupeEvidence(items.map((item) => enrichEvidenceItem(item)));
}

export function dedupeEvidence(items: EvidenceItem[]): EvidenceItem[] {
  const byKey = new Map<string, EvidenceItem>();
  for (const item of items) {
    const normalized = enrichEvidenceItem(item);
    const key = normalized.quality?.dedupe_key ?? normalized.id;
    const current = byKey.get(key);
    if (!current) {
      byKey.set(key, normalized);
      continue;
    }

    const currentScore = evidenceSortScore(current);
    const nextScore = evidenceSortScore(normalized);
    const keepNext = nextScore > currentScore;
    const kept = keepNext ? normalized : current;
    const mergedWarnings = new Set([
      ...(kept.quality?.warnings ?? []),
      `deduped:${keepNext ? current.id : normalized.id}`,
    ]);
    byKey.set(key, {
      ...kept,
      ...(kept.quality ? { quality: { ...kept.quality, warnings: [...mergedWarnings] } } : {}),
    });
  }
  return [...byKey.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function makeDataGap(input: {
  source_name: string;
  query: string;
  reason: string;
  reason_code: DataGapReasonCode;
  occurred_at: string;
  source_meta?: EvidenceSourceMeta;
}): DataGap {
  return {
    source_name: input.source_name,
    query: input.query,
    reason: input.reason,
    occurred_at: input.occurred_at,
    reason_code: input.reason_code,
    ...(input.source_meta ? { source_meta: input.source_meta } : {}),
  };
}

export function summarizeEvidenceForLLM(items: EvidenceItem[]): Array<Record<string, unknown>> {
  return items.map((item) => ({
    id: item.id,
    domain: item.domain,
    source_type: item.source_type,
    source_name: item.source_name,
    query: item.query,
    as_of: item.as_of,
    retrieved_at: item.retrieved_at,
    confidence: item.quality?.confidence ?? item.confidence,
    quality: item.quality,
    value: item.value,
  }));
}

export function extractJsonPayload(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("event:") && !trimmed.startsWith("data:")) return trimmed;
  const dataLine = trimmed
    .split(/\r?\n/)
    .find((line) => line.startsWith("data:"));
  if (!dataLine) throw new Error("MCP SSE response had no data line");
  return dataLine.slice("data:".length).trim();
}

export function buildSourceMeta(input: RawEvidenceInput, raw: unknown, asOf?: string): EvidenceSourceMeta {
  const sanitizedEndpoint = sanitizeRef(input.endpoint);
  return {
    vendor: input.vendor,
    ...(input.server ? { server: input.server } : {}),
    ...(input.tool ? { tool: input.tool } : {}),
    ...(sanitizedEndpoint ? { endpoint: sanitizedEndpoint, ref: `${sanitizedEndpoint}${input.tool ? `#${input.tool}` : ""}` } : {}),
    retrieved_at: input.retrieved_at,
    as_of: asOf ?? input.retrieved_at.slice(0, 10),
    query: input.query,
    ...(input.target ? { target: input.target } : {}),
    raw_hash: stableHash(raw),
  };
}

function enrichEvidenceItem(item: EvidenceItem): EvidenceItem {
  const domain = item.domain ?? inferDomainFromEvidence(item);
  const fallbackTarget = extractString(item.value, ["target", "symbol", "name"]);
  const sourceMeta = item.source_meta ?? {
    vendor: item.source_type === "ifind_mcp" ? "ifind" : item.source_type,
    retrieved_at: item.retrieved_at,
    as_of: item.as_of,
    query: item.query,
    raw_hash: stableHash(item.raw_text ?? item.value ?? item.id),
    ...(fallbackTarget ? { target: fallbackTarget } : {}),
    ...(item.raw_ref ? { ref: item.raw_ref } : {}),
  };
  const quality = item.quality ?? scoreQuality({
    source_type: item.source_type,
    domain,
    value: item.value,
    source_meta: sourceMeta,
    warnings: [],
    confidenceOverride: item.confidence,
  });
  return {
    ...item,
    schema_version: item.schema_version ?? EVIDENCE_SCHEMA_VERSION,
    domain,
    confidence: quality.confidence,
    source_meta: sourceMeta,
    quality,
  };
}

function extractPayloads(raw: unknown): { payloads: unknown[]; parse_errors: string[] } {
  const parse_errors: string[] = [];
  const extracted = unwrapMcpPayload(raw, parse_errors);
  if (Array.isArray(extracted)) return { payloads: extracted, parse_errors };
  if (isRecord(extracted) && Object.keys(extracted).length === 0) return { payloads: [], parse_errors };
  if (isRecord(extracted)) {
    for (const key of ["data", "items", "rows", "result", "records"]) {
      const nested = extracted[key];
      if (Array.isArray(nested)) return { payloads: nested, parse_errors };
    }
  }
  return {
    payloads: extracted === undefined || extracted === null || extracted === "" ? [] : [extracted],
    parse_errors,
  };
}

function unwrapMcpPayload(raw: unknown, parseErrors: string[]): unknown {
  if (!isRecord(raw)) return parseMaybeJson(raw, parseErrors);
  if ("structuredContent" in raw) return parseMaybeJson(raw.structuredContent, parseErrors);
  if ("jsonrpc" in raw && "result" in raw) return parseMaybeJson(raw.result, parseErrors);
  const content = raw.content;
  if (Array.isArray(content)) {
    const text = content.find((item) => isRecord(item) && item.type === "text" && typeof item.text === "string");
    if (isRecord(text)) return parseMaybeJson(text.text, parseErrors);
  }
  return raw;
}

function parseMaybeJson(value: unknown, parseErrors: string[]): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return "";
  let jsonText: string;
  try {
    jsonText = trimmed.startsWith("event:") || trimmed.startsWith("data:")
      ? extractJsonPayload(trimmed)
      : trimmed;
  } catch (error) {
    parseErrors.push(`Failed to parse JSON evidence payload: ${error instanceof Error ? error.message : String(error)}`);
    return value;
  }
  if (!jsonText.startsWith("{") && !jsonText.startsWith("[")) return value;
  try {
    const parsed = JSON.parse(jsonText) as unknown;
    if (isRecord(parsed) && "jsonrpc" in parsed && "result" in parsed) return parsed.result;
    return parsed;
  } catch (error) {
    parseErrors.push(`Failed to parse JSON evidence payload: ${error instanceof Error ? error.message : String(error)}`);
    return value;
  }
}

function inferDomain(
  intent: EvidenceIntent | undefined,
  payload: unknown,
  query: string,
): EvidenceDomain {
  const text = `${query} ${JSON.stringify(payload)}`.toLowerCase();
  if (intent === "news" && /announcement|notice|公告/.test(text)) return "announcement";
  if (intent) return intent;
  if (/announcement|notice|公告/.test(text)) return "announcement";
  if (/news|sentiment|新闻/.test(text)) return "news";
  if (/price|change_pct|prev_close|volume|turnover|quote|行情/.test(text)) return "quote";
  if (/revenue|net_profit|gross_margin|roe|total_assets|cash_flow|financial|财务|利润/.test(text)) return "financials";
  if (/indicator|macro|pmi|gdp|cpi/.test(text)) return "macro";
  return "profile";
}

function inferDomainFromEvidence(item: EvidenceItem): EvidenceDomain {
  return inferDomain(undefined, item.value ?? item.raw_text ?? item.query, item.query);
}

function normalizeValue(domain: EvidenceDomain, payload: unknown, input: RawEvidenceInput): {
  value: unknown;
  as_of: string;
  warnings: string[];
  invalid: boolean;
} {
  if (!isRecord(payload)) {
    const asOf = input.retrieved_at.slice(0, 10);
    return {
      value: { schema: `${domain}.v1`, target: input.target, text: String(payload) },
      as_of: asOf,
      warnings: ["unstructured_payload"],
      invalid: true,
    };
  }

  if (domain === "quote") return normalizeQuote(payload, input);
  if (domain === "financials") return normalizeFinancials(payload, input);
  if (domain === "announcement") return normalizeAnnouncement(payload, input);
  if (domain === "news") return normalizeNews(payload, input);
  if (domain === "profile") return normalizeProfile(payload, input);
  return normalizeMacro(payload, input);
}

function normalizeQuote(payload: Record<string, unknown>, input: RawEvidenceInput) {
  const open = pickOptionalNumber(payload, ["open", "open_price"]);
  const high = pickOptionalNumber(payload, ["high", "high_price"]);
  const low = pickOptionalNumber(payload, ["low", "low_price"]);
  const value = {
    schema: "quote.v1" as const,
    symbol: pickString(payload, ["symbol", "code", "ticker", "stock_code"]) ?? input.target ?? "",
    name: pickString(payload, ["name", "security_name", "stock_name", "short_name"]) ?? input.target ?? "",
    market: pickString(payload, ["market", "exchange"]) ?? "",
    price: pickNumber(payload, ["price", "last", "close", "last_price"]),
    ...(open !== undefined ? { open } : {}),
    ...(high !== undefined ? { high } : {}),
    ...(low !== undefined ? { low } : {}),
    prev_close: pickNumber(payload, ["prev_close", "previous_close", "pre_close"]),
    change_pct: pickNumber(payload, ["change_pct", "pct_chg", "changePercent"]),
    volume: pickNumber(payload, ["volume"]),
    turnover: pickNumber(payload, ["turnover", "amount"]),
    trade_date: pickString(payload, ["trade_date", "date"]) ?? input.retrieved_at.slice(0, 10),
  };
  return finalizeStructuredValue("quote", value, value.trade_date);
}

function normalizeFinancials(payload: Record<string, unknown>, input: RawEvidenceInput) {
  const totalEquity = pickOptionalNumber(payload, ["total_equity", "equity", "owner_equity"]);
  const value = {
    schema: "financials.v1" as const,
    symbol: pickString(payload, ["symbol", "code", "ticker", "stock_code"]) ?? input.target ?? "",
    name: pickString(payload, ["name", "security_name", "stock_name", "short_name"]) ?? input.target ?? "",
    period: pickString(payload, ["period", "report_period"]) ?? "",
    report_type: pickString(payload, ["report_type", "type"]) ?? "",
    revenue: pickNumber(payload, ["revenue", "operating_revenue"]),
    net_profit: pickNumber(payload, ["net_profit", "np_parent", "profit"]),
    gross_margin: pickNumber(payload, ["gross_margin", "gross_profit_margin"]),
    roe: pickNumber(payload, ["roe"]),
    total_assets: pickNumber(payload, ["total_assets", "assets"]),
    ...(totalEquity !== undefined ? { total_equity: totalEquity } : {}),
    operating_cash_flow: pickNumber(payload, ["operating_cash_flow", "operating_cf", "cfo"]),
    currency: pickString(payload, ["currency"]) ?? "CNY",
  };
  return finalizeStructuredValue("financials", value, value.period || input.retrieved_at.slice(0, 10));
}

function normalizeAnnouncement(payload: Record<string, unknown>, input: RawEvidenceInput) {
  const sourceUrl = pickString(payload, ["source_url", "url", "link"]);
  const sourceId = pickString(payload, ["source_id", "announcement_id", "notice_id", "id"]);
  const value = {
    schema: "announcement.v1" as const,
    symbol: pickString(payload, ["symbol", "code", "ticker", "stock_code"]) ?? input.target ?? "",
    name: pickString(payload, ["name", "security_name", "stock_name", "short_name"]) ?? input.target ?? "",
    title: pickString(payload, ["title"]),
    published_at: pickString(payload, ["published_at", "publish_time", "date"]) ?? input.retrieved_at,
    category: pickString(payload, ["category", "type"]) ?? "announcement",
    ...(sourceUrl ? { source_url: sourceUrl } : {}),
    ...(sourceId ? { source_id: sourceId } : {}),
    summary: pickString(payload, ["summary", "abstract", "content"]) ?? "",
  };
  return finalizeStructuredValue("announcement", value, value.published_at.slice(0, 10));
}

function normalizeNews(payload: Record<string, unknown>, input: RawEvidenceInput) {
  const related = payload.related_symbols ?? payload.symbols ?? payload.codes;
  const normalizedSentiment = normalizeSentiment(pickString(payload, ["sentiment"]));
  const value = {
    schema: "news.v1" as const,
    title: pickString(payload, ["title"]) ?? "",
    published_at: pickString(payload, ["published_at", "publish_time", "date"]) ?? input.retrieved_at,
    source: pickString(payload, ["source", "media"]) ?? "",
    related_symbols: Array.isArray(related) ? related.filter((item): item is string => typeof item === "string") : [],
    summary: pickString(payload, ["summary", "abstract", "content"]) ?? "",
    ...(normalizedSentiment.value ? { sentiment: normalizedSentiment.value } : {}),
  };
  const extraWarnings = normalizedSentiment.warning ? [normalizedSentiment.warning] : [];
  return withExtraWarnings(finalizeStructuredValue("news", value, value.published_at.slice(0, 10)), extraWarnings);
}

function normalizeProfile(payload: Record<string, unknown>, input: RawEvidenceInput) {
  const value = {
    schema: "profile.v1" as const,
    symbol: pickString(payload, ["symbol", "code", "ticker", "stock_code"]) ?? input.target ?? "",
    name: pickString(payload, ["name", "security_name", "company_name", "stock_name", "short_name"]) ?? input.target ?? "",
    market: pickString(payload, ["market", "exchange"]) ?? "",
    industry: pickString(payload, ["industry", "sector"]) ?? "",
    business_scope: pickString(payload, ["business_scope", "business", "description"]) ?? "",
    as_of: pickString(payload, ["as_of", "date", "updated_at"]) ?? input.retrieved_at.slice(0, 10),
  };
  return finalizeStructuredValue("profile", value, value.as_of);
}

function normalizeMacro(payload: Record<string, unknown>, input: RawEvidenceInput) {
  const value = {
    schema: "macro.v1" as const,
    indicator_name: pickString(payload, ["indicator_name", "indicator", "name"]) ?? input.query,
    region: pickString(payload, ["region", "country", "area"]) ?? "",
    frequency: pickString(payload, ["frequency", "freq"]) ?? "",
    value: pickNumber(payload, ["value", "latest"]),
    unit: pickString(payload, ["unit"]) ?? "",
    period: pickString(payload, ["period", "date", "as_of"]) ?? input.retrieved_at.slice(0, 10),
  };
  return finalizeStructuredValue("macro", value, value.period);
}

function finalizeStructuredValue<T extends Record<string, unknown>>(
  domain: EvidenceDomain,
  value: T,
  asOf: string,
): { value: T; as_of: string; warnings: string[]; invalid: boolean } {
  const missing = REQUIRED_FIELDS[domain].filter((field) => isMissingValue(value[field]));
  return {
    value,
    as_of: asOf,
    warnings: missing.map((field) => `missing:${field}`),
    invalid: missing.length > 0,
  };
}

function withExtraWarnings<T extends { warnings: string[]; invalid: boolean }>(result: T, warnings: string[]): T {
  return warnings.length === 0
    ? result
    : {
        ...result,
        warnings: [...result.warnings, ...warnings],
      };
}

function normalizeSentiment(value: string | undefined): {
  value?: "positive" | "neutral" | "negative";
  warning?: string;
} {
  if (!value) return {};
  const normalized = value.trim().toLowerCase();
  if (["positive", "bullish", "buy", "up", "optimistic", "看多", "利好", "正面"].includes(normalized)) {
    return { value: "positive" };
  }
  if (["negative", "bearish", "sell", "down", "pessimistic", "看空", "利空", "负面"].includes(normalized)) {
    return { value: "negative" };
  }
  if (["neutral", "mixed", "hold", "中性", "观望"].includes(normalized)) {
    return { value: "neutral" };
  }
  return { warning: `unrecognized_sentiment:${value}` };
}

function scoreQuality(input: {
  source_type: EvidenceSourceType;
  domain: EvidenceDomain;
  value: unknown;
  source_meta: EvidenceSourceMeta;
  warnings: string[];
  confidenceOverride?: number;
}): EvidenceQuality {
  const completeness = completenessFor(input.domain, input.value);
  const freshness = freshnessFor(input.source_meta.as_of, input.source_meta.retrieved_at);
  const base = input.confidenceOverride ?? SOURCE_BASE_CONFIDENCE[input.source_type];
  const warningPenalty = Math.min(0.25, input.warnings.length * 0.05);
  const confidence = clamp(base * 0.5 + completeness * 0.3 + freshness * 0.2 - warningPenalty);
  return {
    confidence,
    freshness,
    completeness,
    dedupe_key: makeDedupeKey(input.source_meta.vendor, input.domain, input.value, input.source_meta),
    warnings: input.warnings,
  };
}

function completenessFor(domain: EvidenceDomain, value: unknown): number {
  if (!isRecord(value)) return 0.2;
  const required = REQUIRED_FIELDS[domain];
  if (required.length === 0) return 0.7;
  const present = required.filter((field) => !isMissingValue(value[field]));
  return present.length / required.length;
}

function freshnessFor(asOf: string, retrievedAt: string): number {
  const asOfTime = Date.parse(asOf);
  const retrievedTime = Date.parse(retrievedAt);
  if (Number.isNaN(asOfTime) || Number.isNaN(retrievedTime)) return 0.55;
  const days = Math.max(0, (retrievedTime - asOfTime) / 86_400_000);
  if (days <= 2) return 1;
  if (days <= 30) return 0.85;
  if (days <= 120) return 0.65;
  return 0.4;
}

function makeDedupeKey(
  vendor: string,
  domain: EvidenceDomain,
  value: unknown,
  meta: EvidenceSourceMeta,
): string {
  const title = isRecord(value)
    ? pickString(value, ["title", "period", "trade_date", "published_at", "schema"]) ?? ""
    : "";
  const target = meta.target ?? (isRecord(value) ? pickString(value, ["symbol", "name"]) : undefined) ?? meta.query;
  return [vendor, domain, normalizeKey(target), normalizeKey(meta.as_of), normalizeKey(title)].join(":");
}

function makeStableEvidenceId(vendor: string, domain: EvidenceDomain, dedupeKey: string): string {
  return `${normalizeKey(vendor)}-${domain}-${stableHash(dedupeKey).slice(0, 12)}`;
}

function evidenceSortScore(item: EvidenceItem): number {
  const completeness = item.quality?.completeness ?? 0;
  const retrieved = Date.parse(item.retrieved_at);
  return completeness * 1_000_000 + (Number.isNaN(retrieved) ? 0 : retrieved / 1_000_000_000);
}

function pickString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function pickNumber(record: Record<string, unknown>, keys: string[]): number {
  return pickOptionalNumber(record, keys) ?? Number.NaN;
}

function pickOptionalNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const normalized = Number(value.replace(/[% ,]/g, ""));
      if (Number.isFinite(normalized)) return normalized;
    }
  }
  return undefined;
}

function extractString(value: unknown, keys: string[]): string | undefined {
  return isRecord(value) ? pickString(value, keys) : undefined;
}

function isMissingValue(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === "" ||
    (typeof value === "number" && !Number.isFinite(value)) ||
    (Array.isArray(value) && value.length === 0)
  );
}

function sanitizeRef(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return value.replace(/(token|key|authorization|bearer)=([^&#]+)/gi, "$1=REDACTED");
  }
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^\p{Letter}\p{Number}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 80) || "unknown";
}

function stableHash(value: unknown): string {
  const text = stableStringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(4))));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
