import assert from "node:assert/strict";
import test from "node:test";
import { reviewSubagentResult, reviewSubagentResults } from "../src/review.js";
import type {
  EvidenceItem,
  ResearchEvidenceStructuredOutput,
  RiskReportStructuredOutput,
  SubagentId,
  SubagentResult,
  SubagentStructuredOutput,
  ThesisValuationStructuredOutput,
} from "../src/schemas.js";

const evidence: EvidenceItem = {
  id: "ev-1",
  domain: "financials",
  source_type: "mock",
  source_name: "fixture-source",
  query: "CATL revenue margin battery shipment data",
  as_of: "2026-06-10",
  retrieved_at: "2026-06-10T00:00:00.000Z",
  confidence: 0.82,
  raw_text: "CATL revenue growth, margin pressure, battery shipments, customer concentration, overseas policy pressure, and valuation scenarios are available.",
  value: { target: "CATL" },
};

const newsEvidence: EvidenceItem = {
  ...evidence,
  id: "ev-news",
  domain: "news",
  query: "CATL policy news",
  raw_text: "CATL overseas policy pressure is available.",
};

test("review rejects missing structured output", () => {
  const result = buildResult("research_evidence", {
    summary: "Evidence summary includes revenue growth and margin pressure.",
    findings: [{ statement: "CATL revenue growth and margin pressure are available.", evidence_ids: ["ev-1"], confidence: 0.7 }],
    evidence: [evidence],
  });
  const withoutStructuredOutput: SubagentResult = { ...result };
  delete withoutStructuredOutput.structured_output;

  const review = reviewSubagentResult(withoutStructuredOutput);
  assert.equal(review.pass, false);
  assert.match(review.issues.join("\n"), /structured_output must be an object/);
});

test("review rejects structured output with missing evidence references", () => {
  const result = buildResult("risk_report", {
    summary: "Risk report summary is complete.",
    findings: [
      {
        statement: "CATL margin pressure and customer concentration create risk.",
        evidence_ids: ["ev-1"],
        confidence: 0.7,
      },
    ],
    evidence: [evidence],
    structured_output: {
      ...(structuredOutputFor("risk_report") as RiskReportStructuredOutput),
      counter_evidence: [
        {
          claim_challenged: "CATL margin pressure is manageable.",
          counterpoint: "Customer concentration could amplify pressure.",
          evidence_ids: ["missing-ev"],
          severity: "medium",
        },
      ],
    },
  });

  const review = reviewSubagentResult(result);
  assert.equal(review.pass, false);
  assert.match(review.issues.join("\n"), /cites missing evidence/);
});

test("review sorts issues by severity and emits prioritized revision guidance", () => {
  const result = buildResult("research_evidence", {
    summary: "Evidence summary uses weak structure.",
    findings: [{ statement: "CATL revenue growth is available.", evidence_ids: ["missing-ev"], confidence: 0.7 }],
    evidence: [evidence],
    structured_output: {
      ...(structuredOutputFor("research_evidence") as ResearchEvidenceStructuredOutput),
      fact_table: [
        {
          fact: "CATL revenue growth is available.",
          domain: "other",
          evidence_ids: ["missing-ev"],
          confidence: 0.2,
          as_of: "2026-06-10",
        },
        {
          fact: "CATL margin pressure is available.",
          domain: "other",
          evidence_ids: ["missing-ev"],
          confidence: 0.2,
          as_of: "2026-06-10",
        },
      ],
    },
  });

  const review = reviewSubagentResult(result);

  assert.equal(review.pass, false);
  assert.equal(review.revision_action, "revise");
  assert.match(review.issues[0] ?? "", /^\[critical\]/);
  assert.match(review.revision_instruction ?? "", /Fix \d+ critical issues? first/);
  assert.match(review.revision_instruction ?? "", /Finally clean up \d+ minor issues?/);
});

test("review checks open questions for consistency with data gaps", () => {
  const result = buildResult("research_evidence", {
    summary: "Evidence summary includes an unsupported open question.",
    findings: [{ statement: "CATL revenue growth and margin pressure are available.", evidence_ids: ["ev-1"], confidence: 0.7 }],
    evidence: [evidence],
    open_questions: ["   ", "Need supplier concentration evidence."],
    data_gaps: [],
  });

  const review = reviewSubagentResult(result);

  assert.equal(review.pass, false);
  assert.match(review.issues.join("\n"), /Open question 0 is empty/);
  assert.match(review.issues.join("\n"), /without corresponding data gaps/);
});

test("review accepts contract-complete evidence-backed results for all agents", () => {
  const reviews = reviewSubagentResults([
    buildResult("research_evidence", {
      summary: "Evidence summary includes revenue growth, margin pressure, and coverage notes.",
      findings: [{ statement: "CATL revenue growth and margin pressure are available.", evidence_ids: ["ev-1"], confidence: 0.7 }],
      evidence: [evidence],
    }),
    buildResult("thesis_valuation", {
      summary: "Investment thesis is mixed with scenario sensitivity.",
      findings: [{ statement: "CATL revenue growth and valuation scenarios support a mixed view.", evidence_ids: ["ev-1"], confidence: 0.7 }],
      evidence: [evidence],
    }),
    buildResult("risk_report", {
      summary: "Risk report summary highlights margin pressure and customer concentration.",
      findings: [{ statement: "CATL margin pressure and customer concentration create risk.", evidence_ids: ["ev-1"], confidence: 0.7 }],
      evidence: [evidence],
    }),
  ]);

  assert.deepEqual(reviews.map((review) => review.pass), [true, true, true]);
});

test("review rejects risk report without counter-evidence or risk triggers", () => {
  const result = buildResult("risk_report", {
    summary: "Risk report summary highlights margin pressure.",
    findings: [{ statement: "CATL margin pressure creates risk.", evidence_ids: ["ev-1"], confidence: 0.7 }],
    evidence: [evidence],
    structured_output: {
      ...structuredOutputFor("risk_report"),
      counter_evidence: [],
      risk_triggers: [],
    } as SubagentStructuredOutput,
  });

  const review = reviewSubagentResult(result);
  assert.equal(review.pass, false);
  assert.match(review.issues.join("\n"), /counter_evidence/);
  assert.match(review.issues.join("\n"), /risk_triggers/);
});

test("review rejects risk trigger references outside counter-evidence", () => {
  const result = buildResult("risk_report", {
    summary: "Risk report summary highlights margin pressure.",
    findings: [{ statement: "CATL margin pressure creates risk.", evidence_ids: ["ev-1"], confidence: 0.7 }],
    evidence: [evidence],
    structured_output: {
      ...(structuredOutputFor("risk_report") as RiskReportStructuredOutput),
      risk_triggers: [
        {
          trigger: "Margin pressure worsens.",
          metric_or_event: "margin pressure",
          derived_from_counter_evidence_index: 99,
          evidence_ids: ["ev-1"],
        },
      ],
    },
  });

  const review = reviewSubagentResult(result);
  assert.equal(review.pass, false);
  assert.match(review.issues.join("\n"), /points outside counter_evidence/);
});

test("review flags risk final summary without upstream references", () => {
  const result = buildResult("risk_report", {
    summary: "Risk report summary highlights margin pressure.",
    findings: [{ statement: "CATL margin pressure creates risk.", evidence_ids: ["ev-1"], confidence: 0.7 }],
    evidence: [evidence],
    structured_output: {
      ...(structuredOutputFor("risk_report") as RiskReportStructuredOutput),
      final_summary: {
        stance: "mixed",
        key_reasons: ["Revenue growth and risk evidence both matter."],
        major_risks: ["Margin pressure"],
        data_gaps: [],
        upstream_references: {
          research_evidence_fact_indices: [],
          thesis_indices: [],
        },
      },
    },
  });

  const review = reviewSubagentResult(result);
  assert.equal(review.pass, false);
  assert.match(review.issues.join("\n"), /does not explicitly reference upstream/);
});

test("review flags research evidence other-domain overuse and data gap impact omissions", () => {
  const result = buildResult("research_evidence", {
    summary: "Evidence summary includes mostly uncategorized facts.",
    findings: [{ statement: "CATL revenue growth and margin pressure are available.", evidence_ids: ["ev-1"], confidence: 0.7 }],
    evidence: [evidence],
    structured_output: {
      ...(structuredOutputFor("research_evidence") as ResearchEvidenceStructuredOutput),
      fact_table: [
        {
          fact: "CATL revenue growth is available.",
          domain: "other",
          evidence_ids: ["ev-1"],
          confidence: 0.7,
          as_of: "2026-06-10",
        },
        {
          fact: "CATL margin pressure is available.",
          domain: "other",
          evidence_ids: ["ev-1"],
          confidence: 0.7,
          as_of: "2026-06-10",
        },
      ],
      data_gaps: [{ topic: "Supplier split", reason: "No supplier-level shipment evidence." }],
    },
  });

  const review = reviewSubagentResult(result);
  assert.equal(review.pass, false);
  assert.match(review.issues.join("\n"), /domain=other/);
  assert.match(review.issues.join("\n"), /impact assessments/);
});

test("review checks finding evidence domains against agent role", () => {
  const result = buildResult("thesis_valuation", {
    summary: "Investment thesis cites a news item without valuation evidence.",
    findings: [{ statement: "CATL has upside.", evidence_ids: ["ev-news"], confidence: 0.7 }],
    evidence: [newsEvidence],
    structured_output: {
      ...(structuredOutputFor("thesis_valuation") as ThesisValuationStructuredOutput),
      theses: [{ statement: "CATL has upside.", direction: "bullish", evidence_ids: ["ev-news"], confidence: 0.7 }],
      valuation_framework: {
        ...(structuredOutputFor("thesis_valuation") as ThesisValuationStructuredOutput).valuation_framework,
        evidence_ids: ["ev-news"],
      },
      scenario_variables: [
        {
          name: "policy sentiment",
          base: "stable",
          bull: "improves",
          bear: "worsens",
          evidence_ids: ["ev-news"],
        },
      ],
    },
  });

  const review = reviewSubagentResult(result);
  assert.equal(review.pass, false);
  assert.match(review.issues.join("\n"), /outside thesis_valuation domain expectations/);
});

test("review flags research evidence coverage and structured confidence issues", () => {
  const result = buildResult("research_evidence", {
    summary: "Evidence summary includes low-confidence financial facts.",
    findings: [{ statement: "CATL revenue growth is available.", evidence_ids: ["ev-1"], confidence: 0.7 }],
    evidence: [evidence],
    structured_output: {
      ...(structuredOutputFor("research_evidence") as ResearchEvidenceStructuredOutput),
      fact_table: [
        {
          fact: "CATL revenue growth is available.",
          domain: "financials",
          evidence_ids: ["ev-1"],
          confidence: 0.2,
          as_of: "2026-06-10",
        },
      ],
      evidence_coverage: { covered_domains: ["quote"], missing_domains: [], notes: "Coverage is inconsistent." },
    },
  });

  const review = reviewSubagentResult(result);
  assert.equal(review.pass, false);
  assert.match(review.issues.join("\n"), /confidence is below review threshold/);
  assert.match(review.issues.join("\n"), /coverage omits fact_table domains/);
});

test("review rejects invalid valuation view enum", () => {
  const result = buildResult("thesis_valuation", {
    summary: "Investment thesis is mixed with scenario sensitivity.",
    findings: [{ statement: "CATL revenue growth and valuation scenarios support a mixed view.", evidence_ids: ["ev-1"], confidence: 0.7 }],
    evidence: [evidence],
    structured_output: {
      ...(structuredOutputFor("thesis_valuation") as ThesisValuationStructuredOutput),
      valuation_framework: {
        ...(structuredOutputFor("thesis_valuation") as ThesisValuationStructuredOutput).valuation_framework,
        valuation_view: "preliminary mixed view",
      },
    } as unknown as SubagentStructuredOutput,
  });

  const review = reviewSubagentResult(result);
  assert.equal(review.pass, false);
  assert.match(review.issues.join("\n"), /valuation_framework\.valuation_view is invalid/);
});

test("review flags thesis direction and valuation view inconsistency", () => {
  const result = buildResult("thesis_valuation", {
    summary: "Investment thesis is positive but valuation view is overvalued.",
    findings: [{ statement: "CATL revenue growth and valuation scenarios support upside.", evidence_ids: ["ev-1"], confidence: 0.7 }],
    evidence: [evidence],
    structured_output: {
      ...(structuredOutputFor("thesis_valuation") as ThesisValuationStructuredOutput),
      theses: [{ statement: "CATL has upside.", direction: "bullish", evidence_ids: ["ev-1"], confidence: 0.7 }],
      valuation_framework: {
        ...(structuredOutputFor("thesis_valuation") as ThesisValuationStructuredOutput).valuation_framework,
        valuation_view: "overvalued",
      },
    },
  });

  const review = reviewSubagentResult(result);
  assert.equal(review.pass, false);
  assert.match(review.issues.join("\n"), /bullish while valuation_view is overvalued/);
});

test("review flags risk stance and counter-evidence severity inconsistency", () => {
  const result = buildResult("risk_report", {
    summary: "Risk report summary is negative despite low severity evidence.",
    findings: [{ statement: "CATL margin pressure creates risk.", evidence_ids: ["ev-1"], confidence: 0.7 }],
    evidence: [evidence],
    structured_output: {
      ...(structuredOutputFor("risk_report") as RiskReportStructuredOutput),
      counter_evidence: [
        {
          claim_challenged: "CATL margin pressure is manageable.",
          counterpoint: "Only low severity counter-evidence is available.",
          evidence_ids: ["ev-1"],
          severity: "low",
        },
      ],
      final_summary: {
        ...(structuredOutputFor("risk_report") as RiskReportStructuredOutput).final_summary,
        stance: "negative",
      },
    },
  });

  const review = reviewSubagentResult(result);
  assert.equal(review.pass, false);
  assert.match(review.issues.join("\n"), /stance is negative while all counter_evidence severity values are low/);
});

test("batch review flags structured thesis and risk report inconsistency", () => {
  const reviews = reviewSubagentResults([
    buildResult("thesis_valuation", {
      summary: "Investment thesis is positive with upside valuation sensitivity.",
      findings: [{ statement: "CATL revenue growth and valuation scenarios support upside.", evidence_ids: ["ev-1"], confidence: 0.7 }],
      evidence: [evidence],
      structured_output: {
        ...(structuredOutputFor("thesis_valuation") as ThesisValuationStructuredOutput),
        theses: [{ statement: "CATL has upside.", direction: "bullish", evidence_ids: ["ev-1"], confidence: 0.7 }],
      },
    }),
    buildResult("risk_report", {
      summary: "Risk report summary: high risk and downside pressure are material.",
      findings: [{ statement: "CATL margin pressure and customer concentration create risk.", evidence_ids: ["ev-1"], confidence: 0.7 }],
      evidence: [evidence],
      structured_output: {
        ...(structuredOutputFor("risk_report") as RiskReportStructuredOutput),
        final_summary: {
          stance: "negative",
          key_reasons: ["High risk evidence"],
          major_risks: ["Margin pressure"],
          data_gaps: [],
          upstream_references: {
            research_evidence_fact_indices: [0],
            thesis_indices: [0],
          },
        },
      },
    }),
  ]);

  const riskReview = reviews.find((review) => review.agent_id === "risk_report");
  assert.equal(riskReview?.pass, false);
  assert.match(riskReview?.issues.join("\n") ?? "", /Potential inconsistency/);
});

test("batch review rejects risk upstream reference indices outside upstream outputs", () => {
  const reviews = reviewSubagentResults([
    buildResult("research_evidence", {
      summary: "Research evidence summary cites one fact.",
      findings: [{ statement: "CATL revenue growth is available.", evidence_ids: ["ev-1"], confidence: 0.7 }],
      evidence: [evidence],
    }),
    buildResult("thesis_valuation", {
      summary: "Thesis valuation summary cites one thesis.",
      findings: [{ statement: "CATL has a mixed valuation view.", evidence_ids: ["ev-1"], confidence: 0.7 }],
      evidence: [evidence],
    }),
    buildResult("risk_report", {
      summary: "Risk report summary references upstream outputs.",
      findings: [{ statement: "CATL risks depend on upstream facts and thesis.", evidence_ids: ["ev-1"], confidence: 0.7 }],
      evidence: [evidence],
      structured_output: {
        ...(structuredOutputFor("risk_report") as RiskReportStructuredOutput),
        final_summary: {
          stance: "mixed",
          key_reasons: ["Upstream evidence matters."],
          major_risks: ["Margin pressure"],
          data_gaps: [],
          upstream_references: {
            research_evidence_fact_indices: [9],
            thesis_indices: [4],
          },
        },
      },
    }),
  ]);

  const riskReview = reviews.find((review) => review.agent_id === "risk_report");
  assert.equal(riskReview?.pass, false);
  assert.match(riskReview?.issues.join("\n") ?? "", /missing research_evidence fact indices: 9/);
  assert.match(riskReview?.issues.join("\n") ?? "", /missing thesis_valuation thesis indices: 4/);
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
    structured_output: structuredOutputFor(agent_id),
    needs_revision: false,
    ...overrides,
  };
}

function structuredOutputFor(agentId: SubagentId): SubagentStructuredOutput {
  if (agentId === "research_evidence") {
    return {
      schema_version: "subagent-output.v1",
      agent_id: "research_evidence",
      fact_table: [
        {
          fact: "CATL revenue growth and margin pressure are available.",
          domain: "financials",
          evidence_ids: ["ev-1"],
          confidence: 0.7,
          as_of: "2026-06-10",
        },
      ],
      data_gaps: [
        {
          topic: "Supplier split",
          reason: "No supplier-level shipment evidence.",
          impact: "Limits confidence in supply-chain attribution.",
        },
      ],
      evidence_coverage: { covered_domains: ["financials"], missing_domains: ["supplier"], notes: "Fixture coverage." },
    };
  }
  if (agentId === "thesis_valuation") {
    return {
      schema_version: "subagent-output.v1",
      agent_id: "thesis_valuation",
      theses: [
        {
          statement: "CATL revenue growth and valuation scenarios support a mixed view.",
          direction: "mixed",
          evidence_ids: ["ev-1"],
          confidence: 0.7,
        },
      ],
      valuation_framework: {
        method: "scenario framework",
        key_assumptions: ["Margin remains observable."],
        valuation_view: "fairly_valued",
        evidence_ids: ["ev-1"],
      },
      scenario_variables: [
        {
          name: "margin",
          base: "stable",
          bull: "improves",
          bear: "compresses",
          unit: "pct",
          evidence_ids: ["ev-1"],
        },
      ],
    };
  }
  return {
    schema_version: "subagent-output.v1",
    agent_id: "risk_report",
    counter_evidence: [
      {
        claim_challenged: "CATL margin pressure is manageable.",
        counterpoint: "Customer concentration could amplify margin pressure.",
        evidence_ids: ["ev-1"],
        severity: "medium",
      },
    ],
    risk_triggers: [
      {
        trigger: "Margin pressure worsens.",
        metric_or_event: "margin pressure",
        threshold: "material deterioration",
        watch_frequency: "per earnings update",
        derived_from_counter_evidence_index: 0,
        evidence_ids: ["ev-1"],
      },
    ],
    final_summary: {
      stance: "mixed",
      key_reasons: ["Revenue growth and risk evidence both matter."],
      major_risks: ["Margin pressure"],
      data_gaps: [],
      upstream_references: {
        research_evidence_fact_indices: [0],
        thesis_indices: [0],
      },
    },
  };
}
