import type { DataGap, IFindQueryRequest, IFindQueryResult, ResearchDataAdapters } from "./schemas.js";

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
            makeGap(request, `iFind ${request.server} MCP 未返回可匹配工具。可用工具：${tools.map((item) => item.name).join(", ")}`, retrievedAt),
          ],
        };
      }

      const result = await this.callRpc<unknown>(endpoint, "tools/call", {
        name: tool.name,
        arguments: buildToolArguments(tool, request),
      });

      return {
        evidence: [
          {
            id: makeEvidenceId(request.server, request.intent, request.target ?? request.query),
            source_type: "ifind_mcp",
            source_name: `hexin-ifind-ds-${request.server}-mcp`,
            query: request.query,
            as_of: retrievedAt.slice(0, 10),
            retrieved_at: retrievedAt,
            confidence: 0.82,
            value: extractMcpValue(result),
            raw_ref: `${endpoint}#${tool.name}`,
          },
        ],
        data_gaps: [],
      };
    } catch (error) {
      return {
        evidence: [],
        data_gaps: [
          makeGap(request, error instanceof Error ? error.message : String(error), retrievedAt),
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
      return {
        evidence: [
          {
            id: makeEvidenceId(request.server, request.intent, request.target ?? request.query),
            source_type: "mock",
            source_name: `mock-ifind-${request.server}`,
            query: request.query,
            as_of: now.slice(0, 10),
            retrieved_at: now,
            confidence: 0.7,
            value: { target: request.target, intent: request.intent, note: "fixture evidence" },
          },
        ],
        data_gaps: [],
      };
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

function extractMcpValue(result: unknown): unknown {
  if (typeof result !== "object" || result === null) return result;
  const candidate = result as { content?: Array<{ type?: string; text?: string }>; structuredContent?: unknown };
  if (candidate.structuredContent !== undefined) return candidate.structuredContent;
  const text = candidate.content?.find((item) => item.type === "text" && item.text)?.text;
  return text ?? result;
}

function extractJsonPayload(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("event:") && !trimmed.startsWith("data:")) return trimmed;
  const dataLine = trimmed
    .split(/\r?\n/)
    .find((line) => line.startsWith("data:"));
  if (!dataLine) throw new Error("MCP SSE response had no data line");
  return dataLine.slice("data:".length).trim();
}

function makeGap(request: IFindQueryRequest, reason: string, occurredAt: string): DataGap {
  return {
    source_name: `hexin-ifind-ds-${request.server}-mcp`,
    query: request.query,
    reason,
    occurred_at: occurredAt,
  };
}
