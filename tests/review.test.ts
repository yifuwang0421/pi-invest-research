import assert from "node:assert/strict";
import test from "node:test";
import { reviewSubagentResult } from "../src/review.js";
import type { SubagentResult } from "../src/schemas.js";

test("review rejects factual findings without evidence", () => {
  const result: SubagentResult = {
    agent_id: "thesis_valuation",
    task: "观点与估值",
    summary: "公司财务质量较高。",
    findings: [
      {
        statement: "公司财务质量较高。",
        evidence_ids: [],
        confidence: 0.8,
      },
    ],
    evidence: [],
    assumptions: [],
    open_questions: [],
    confidence: 0.8,
    data_gaps: [],
    needs_revision: false,
  };

  const review = reviewSubagentResult(result);
  assert.equal(review.pass, false);
  assert.match(review.issues.join("\n"), /缺少 evidence/);
});

test("review accepts evidence-backed result", () => {
  const result: SubagentResult = {
    agent_id: "research_evidence",
    task: "研究与证据",
    summary: "已获得行情证据。",
    findings: [
      {
        statement: "近一个月行情证据可用于复盘。",
        evidence_ids: ["ifind-stock-quote-test"],
        confidence: 0.7,
      },
    ],
    evidence: [
      {
        id: "ifind-stock-quote-test",
        source_type: "ifind_mcp",
        source_name: "hexin-ifind-ds-stock-mcp",
        query: "贵州茅台 行情",
        as_of: "2026-06-10",
        retrieved_at: "2026-06-10T00:00:00.000Z",
        confidence: 0.82,
        value: { price: 100 },
      },
    ],
    assumptions: [],
    open_questions: [],
    confidence: 0.7,
    data_gaps: [],
    needs_revision: false,
  };

  const review = reviewSubagentResult(result);
  assert.equal(review.pass, true);
});
