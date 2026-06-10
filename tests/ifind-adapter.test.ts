import assert from "node:assert/strict";
import test from "node:test";
import { IFindMcpAdapter } from "../src/ifind-adapter.js";

test("IFindMcpAdapter converts MCP tool response into evidence", async () => {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { method: string };
    calls.push(body.method);
    if (body.method === "initialize") {
      return jsonResponse({ jsonrpc: "2.0", id: "1", result: { capabilities: {} } });
    }
    if (body.method === "tools/list") {
      return jsonResponse({
        jsonrpc: "2.0",
        id: "2",
        result: {
          tools: [
            {
              name: "stock_quote",
              description: "行情",
              inputSchema: { type: "object", properties: { query: { type: "string" } } },
            },
          ],
        },
      });
    }
    return jsonResponse({
      jsonrpc: "2.0",
      id: "3",
      result: { content: [{ type: "text", text: "贵州茅台 quote fixture" }] },
    });
  };

  const adapter = new IFindMcpAdapter({
    endpoints: { stock: "https://example.test/mcp" },
    fetchImpl,
    clock: () => new Date("2026-06-10T00:00:00.000Z"),
  });

  const result = await adapter.queryIFind({
    server: "stock",
    intent: "quote",
    target: "贵州茅台",
    query: "贵州茅台 行情",
  });

  assert.deepEqual(calls, ["initialize", "tools/list", "tools/call"]);
  assert.equal(result.data_gaps.length, 0);
  assert.equal(result.evidence[0]?.source_name, "hexin-ifind-ds-stock-mcp");
  assert.equal(result.evidence[0]?.query, "贵州茅台 行情");
});

test("IFindMcpAdapter returns data gap on MCP error", async () => {
  const fetchImpl: typeof fetch = async () => jsonResponse(
    { jsonrpc: "2.0", id: "1", error: { code: -32603, message: "boom" } },
  );
  const adapter = new IFindMcpAdapter({
    endpoints: { stock: "https://example.test/mcp" },
    fetchImpl,
    clock: () => new Date("2026-06-10T00:00:00.000Z"),
  });

  const result = await adapter.queryIFind({
    server: "stock",
    intent: "quote",
    target: "贵州茅台",
    query: "贵州茅台 行情",
  });

  assert.equal(result.evidence.length, 0);
  assert.match(result.data_gaps[0]?.reason ?? "", /boom/);
});

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
