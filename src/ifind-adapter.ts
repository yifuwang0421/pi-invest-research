import { buildSourceMeta, extractJsonPayload, makeDataGap, normalizeRawEvidence } from "./evidence.js";
import type { DataGapReasonCode, IFindQueryRequest, IFindQueryResult, ResearchDataAdapters } from "./schemas.js";

type IFindServerKey = IFindQueryRequest["server"];

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

interface JsonRpcResponse<T> {
  jsonrpc?: string;
  id?: string | number;
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

const DEFAULT_IFIND_ENDPOINTS: Record<IFindServerKey, string> = {
  stock: "https://api-mcp.51ifind.com:8643/ds-mcp-servers/hexin-ifind-ds-stock-mcp",
  fund: "https://api-mcp.51ifind.com:8643/ds-mcp-servers/hexin-ifind-ds-fund-mcp",
  news: "https://api-mcp.51ifind.com:8643/ds-mcp-servers/hexin-ifind-ds-news-mcp",
  edb: "https://api-mcp.51ifind.com:8643/ds-mcp-servers/hexin-ifind-ds-edb-mcp",
};

export interface IFindAdapterOptions {
  endpoints?: Partial<Record<IFindServerKey, string>>;
  bearerToken?: string;
  fetchImpl?: typeof fetch;
  clock?: () => Date;
}

export class IFindMcpAdapter implements ResearchDataAdapters {
  private readonly endpoints: Record<IFindServerKey, string>;
  private readonly bearerToken: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly clock: () => Date;

  constructor(options: IFindAdapterOptions = {}) {
    this.endpoints = {
      stock: process.env.IFIND_STOCK_MCP_URL ?? options.endpoints?.stock ?? DEFAULT_IFIND_ENDPOINTS.stock,
      fund: process.env.IFIND_FUND_MCP_URL ?? options.endpoints?.fund ?? DEFAULT_IFIND_ENDPOINTS.fund,
      news: process.env.IFIND_NEWS_MCP_URL ?? options.endpoints?.news ?? DEFAULT_IFIND_ENDPOINTS.news,
      edb: process.env.IFIND_EDB_MCP_URL ?? options.endpoints?.edb ?? DEFAULT_IFIND_ENDPOINTS.edb,
    };
    this.bearerToken = options.bearerToken ?? process.env.IFIND_MCP_AUTH_TOKEN;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.clock = options.clock ?? (() => new Date());
  }

  async queryIFind(request: IFindQueryRequest): Promise<IFindQueryResult> {
    const retrievedAt = this.clock().toISOString();
    const endpoint = this.endpoints[request.server];

    try {
      await this.callRpc(endpoint, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "pi-invest-research", version: "0.1.0" },
      });

      const toolsResponse = await this.callRpc<{ tools?: McpTool[] }>(endpoint, "tools/list", {});
      const tools = toolsResponse.tools ?? [];
      const tool = chooseTool(tools, request);
      if (!tool) {
        return {
          evidence: [],
          data_gaps: [
            makeIFindGap(
              request,
              `iFind ${request.server} MCP returned no matching tool. Available tools: ${tools.map((item) => item.name).join(", ")}`,
              "tool_missing",
              retrievedAt,
              endpoint,
            ),
          ],
        };
      }

      const result = await this.callRpc<unknown>(endpoint, "tools/call", {
        name: tool.name,
        arguments: buildToolArguments(tool, request),
      });

      return normalizeRawEvidence({
        source_type: "ifind_mcp",
        vendor: "ifind",
        server: request.server,
        source_name: `hexin-ifind-ds-${request.server}-mcp`,
        query: request.query,
        ...(request.target ? { target: request.target } : {}),
        intent: request.intent,
        endpoint,
        tool: tool.name,
        retrieved_at: retrievedAt,
        raw: result,
      });
    } catch (error) {
      return {
        evidence: [],
        data_gaps: [
          makeIFindGap(
            request,
            error instanceof Error ? error.message : String(error),
            "transport_error",
            retrievedAt,
            endpoint,
          ),
        ],
      };
    }
  }

  private async callRpc<T>(endpoint: string, method: string, params: unknown): Promise<T> {
    const response = await this.fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(this.bearerToken ? { authorization: `Bearer ${this.bearerToken}` } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        method,
        params,
      }),
    });

    if (!response.ok) {
      throw new Error(`MCP HTTP ${response.status} ${response.statusText}`);
    }

    const text = await response.text();
    const jsonText = extractJsonPayload(text);
    const payload = JSON.parse(jsonText) as JsonRpcResponse<T>;
    if (payload.error) {
      throw new Error(`MCP ${method} error ${payload.error.code}: ${payload.error.message}`);
    }
    if (payload.result === undefined) {
      throw new Error(`MCP ${method} returned no result`);
    }
    return payload.result;
  }
}

export function createMockIFindAdapter(): ResearchDataAdapters {
  return {
    async queryIFind(request: IFindQueryRequest): Promise<IFindQueryResult> {
      const now = new Date("2026-06-10T00:00:00.000Z").toISOString();
      return normalizeRawEvidence({
        source_type: "mock",
        vendor: "ifind-mock",
        server: request.server,
        source_name: `mock-ifind-${request.server}`,
        query: request.query,
        ...(request.target ? { target: request.target } : {}),
        intent: request.intent,
        retrieved_at: now,
        raw: buildMockPayload(request, now),
      });
    },
  };
}

export function makeEvidenceId(server: string, intent: string, seed: string): string {
  const safeSeed = seed.replace(/[^\p{Letter}\p{Number}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 32);
  return `ifind-${server}-${intent}-${safeSeed || "query"}`.toLowerCase();
}

function chooseTool(tools: McpTool[], request: IFindQueryRequest): McpTool | undefined {
  const intentHints: Record<IFindQueryRequest["intent"], string[]> = {
    quote: ["quote", "行情", "price", "market"],
    profile: ["profile", "basic", "公司", "基础"],
    financials: ["financial", "finance", "财务", "报表"],
    news: ["news", "公告", "新闻", "资讯"],
    macro: ["macro", "edb", "指标", "经济"],
  };
  const hints = intentHints[request.intent];
  return (
    tools.find((tool) => hints.some((hint) => tool.name.toLowerCase().includes(hint.toLowerCase()) || tool.description?.includes(hint))) ??
    tools[0]
  );
}

function buildToolArguments(tool: McpTool, request: IFindQueryRequest): Record<string, unknown> {
  const schemaText = JSON.stringify(tool.inputSchema ?? {}).toLowerCase();
  if (schemaText.includes("query")) return { query: request.query };
  if (schemaText.includes("symbol")) return { symbol: request.target ?? request.query };
  if (schemaText.includes("code")) return { code: request.target ?? request.query };
  return {
    query: request.query,
    target: request.target,
  };
}

function makeIFindGap(
  request: IFindQueryRequest,
  reason: string,
  reasonCode: Extract<DataGapReasonCode, "transport_error" | "tool_missing">,
  occurredAt: string,
  endpoint: string,
) {
  const sourceName = `hexin-ifind-ds-${request.server}-mcp`;
  const raw = { reason, reason_code: reasonCode, server: request.server };
  return makeDataGap({
    source_name: sourceName,
    query: request.query,
    reason,
    reason_code: reasonCode,
    occurred_at: occurredAt,
    source_meta: buildSourceMeta({
      source_type: "ifind_mcp",
      vendor: "ifind",
      server: request.server,
      source_name: sourceName,
      query: request.query,
      ...(request.target ? { target: request.target } : {}),
      endpoint,
      retrieved_at: occurredAt,
      raw,
    }, raw),
  });
}

function buildMockPayload(request: IFindQueryRequest, retrievedAt: string): unknown {
  const target = request.target ?? request.query;
  if (request.intent === "quote") {
    return {
      symbol: target,
      name: target,
      market: "A-share",
      price: 245.6,
      open: 242.1,
      high: 248.2,
      low: 240.3,
      prev_close: 241.26,
      change_pct: 1.8,
      volume: 12345678,
      turnover: 3012345678,
      trade_date: retrievedAt.slice(0, 10),
    };
  }
  if (request.intent === "financials") {
    return {
      symbol: target,
      name: target,
      period: "2026Q1",
      report_type: "quarterly",
      revenue: 79700000000,
      net_profit: 10500000000,
      gross_margin: 24.5,
      roe: 6.7,
      total_assets: 765000000000,
      total_equity: 285000000000,
      operating_cash_flow: 13200000000,
      currency: "CNY",
    };
  }
  if (request.intent === "news") {
    return {
      title: `${target} operating update`,
      published_at: retrievedAt,
      source: "mock-ifind",
      related_symbols: [target],
      summary: "Fixture evidence for offline validation.",
      sentiment: "neutral",
    };
  }
  return { target, intent: request.intent, note: "fixture evidence" };
}
