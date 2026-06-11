import assert from "node:assert/strict";
import test from "node:test";
import { reviewSubagentResult, reviewSubagentResults } from "../src/review.js";
import type { EvidenceItem, SubagentResult } from "../src/schemas.js";

const evidence: EvidenceItem = {
  id: "ev-1",
  source_type: "mock",
  source_name: "fixture-source",
  query: "CATL revenue margin battery shipment data",
  as_of: "2026-06-10",
  retrieved_at: "2026-06-10T00:00:00.000Z",
  confidence: 0.82,
  raw_text: "CATL revenue growth, margin pressure, battery shipments, and customer concentration are available.",
  value: { target: "CATL" },
};

test("review rejects factual findings without evidence", () => {
  const result = buildResult("thesis_valuation", {
    summary: "Investment thesis and valuation assumptions are positive with scenario sensitivity.",
    findings: [
      {
        statement: "Financial quality is high.",
        evidence_ids: [],
        confidence: 0.8,
      },
    ],
    evidence: [],
  });

  const review = reviewSubagentResult(result);
  assert.equal(review.pass, false);
  assert.match(review.issues.join("\n"), /lacks evidence/);
});

test("review rejects output contract gaps and weak evidence-claim relevance", () => {
  const result = buildResult("risk_report", {
    summary: "Risk report summary is complete.",
    findings: [
      {
        statement: "The main risk is overseas policy pressure.",
        evidence_ids: ["ev-1"],
        confidence: 0.7,
      },
    ],
    evidence: [evidence],
  });

  const review = reviewSubagentResult(result);
  assert.equal(review.pass, false);
  assert.match(review.issues.join("\n"), /weakly related/);
  assert.match(review.issues.join("\n"), /counter-evidence/);
  assert.ok(review.score < 100);
});

test("review accepts contract-complete evidence-backed result", () => {
  const result = buildResult("research_evidence", {
    summary: "Evidence summary: source coverage includes revenue facts, margin observations, and data gaps.",
    findings: [
      {
        statement: "Revenue growth and margin observations are supported by source data.",
        evidence_ids: ["ev-1"],
        confidence: 0.7,
      },
    ],
    evidence: [evidence],
    open_questions: ["Data gaps remain for supplier-level shipment splits."],
  });

  const review = reviewSubagentResult(result);
  assert.equal(review.pass, true);
  assert.equal(review.score, 100);
});

test("batch review flags thesis and risk report inconsistency", () => {
  const reviews = reviewSubagentResults([
    buildResult("thesis_valuation", {
      summary: "Investment thesis is positive: upside valuation with earnings scenario sensitivity.",
      findings: [
        {
          statement: "Revenue growth and margin support an upside valuation scenario.",
          evidence_ids: ["ev-1"],
          confidence: 0.7,
        },
      ],
      evidence: [evidence],
      assumptions: ["Valuation assumption depends on stable margin."],
    }),
    buildResult("risk_report", {
      summary: "Risk report summary: high risk and downside pressure are material.",
      findings: [
        {
          statement: "Risk trigger: margin pressure creates high risk and downside.",
          evidence_ids: ["ev-1"],
          confidence: 0.7,
        },
      ],
      evidence: [evidence],
      assumptions: ["Counter-evidence check highlights trigger levels for margin pressure."],
    }),
  ]);

  const riskReview = reviews.find((review) => review.agent_id === "risk_report");
  assert.equal(riskReview?.pass, false);
  assert.match(riskReview?.issues.join("\n") ?? "", /Potential inconsistency/);
});

function buildResult(
  agent_id: SubagentResult["agent_id"],
  overrides: Partial<SubagentResult>,
): SubagentResult {
  return {
    agent_id,
    task: `${agent_id} task`,
    summary: "",
    findings: [],
    evidence: [],
    assumptions: [],
    open_questions: [],
    confidence: 0.7,
    data_gaps: [],
    needs_revision: false,
    ...overrides,
  };
}
