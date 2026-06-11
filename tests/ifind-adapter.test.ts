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
              description: "quote",
              inputSchema: { type: "object", properties: { query: { type: "string" } } },
            },
          ],
        },
      });
    }
    return jsonResponse({
      jsonrpc: "2.0",
      id: "3",
      result: {
        structuredContent: {
          symbol: "600519.SH",
          name: "Kweichow Moutai",
          market: "A-share",
          price: 1500,
          open: 1490,
          high: 1510,
          low: 1480,
          prev_close: 1482.2,
          change_pct: 1.2,
          volume: 1000000,
          turnover: 1500000000,
          trade_date: "2026-06-10",
        },
      },
    });
  };

  const adapter = new IFindMcpAdapter({
    endpoints: { stock: "https://example.test/mcp?token=secret" },
    fetchImpl,
    clock: () => new Date("2026-06-10T00:00:00.000Z"),
  });

  const result = await adapter.queryIFind({
    server: "stock",
    intent: "quote",
    target: "Kweichow Moutai",
    query: "Kweichow Moutai quote",
  });

  assert.deepEqual(calls, ["initialize", "tools/list", "tools/call"]);
  assert.equal(result.data_gaps.length, 0);
  assert.equal(result.evidence[0]?.source_name, "hexin-ifind-ds-stock-mcp");
  assert.equal(result.evidence[0]?.query, "Kweichow Moutai quote");
  assert.equal(result.evidence[0]?.domain, "quote");
  assert.equal(result.evidence[0]?.source_meta?.ref, "https://example.test/mcp#stock_quote");
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
    target: "Kweichow Moutai",
    query: "Kweichow Moutai quote",
  });

  assert.equal(result.evidence.length, 0);
  assert.equal(result.data_gaps[0]?.reason_code, "transport_error");
  assert.notEqual(result.data_gaps[0]?.source_meta?.raw_hash, "00000000");
  assert.match(result.data_gaps[0]?.reason ?? "", /boom/);
});

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
