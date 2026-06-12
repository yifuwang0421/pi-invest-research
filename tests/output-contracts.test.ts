import assert from "node:assert/strict";
import test from "node:test";
import { validateStructuredOutput } from "../src/output-contracts.js";

test("validateStructuredOutput accepts complete research evidence output", () => {
  const issues = validateStructuredOutput("research_evidence", {
    schema_version: "subagent-output.v1",
    agent_id: "research_evidence",
    fact_table: [
      {
        fact: "CATL reported resilient margins.",
        domain: "financials",
        evidence_ids: ["ev-1"],
        confidence: 0.72,
        as_of: "2026-06-10",
      },
    ],
    data_gaps: [
      {
        topic: "customer concentration",
        reason: "Detailed customer-level revenue was unavailable.",
        needed_evidence: "Customer revenue breakdown",
        impact: "Limits confidence in demand durability.",
      },
    ],
    evidence_coverage: {
      covered_domains: ["financials"],
      missing_domains: ["announcement"],
      notes: "Financial evidence was available, but disclosure coverage remains partial.",
    },
  });

  assert.deepEqual(issues, []);
});

test("validateStructuredOutput rejects research evidence with empty fact table", () => {
  const issues = validateStructuredOutput("research_evidence", {
    schema_version: "subagent-output.v1",
    agent_id: "research_evidence",
    fact_table: [],
    data_gaps: [],
    evidence_coverage: {
      covered_domains: [],
      missing_domains: ["financials"],
      notes: "No verified facts were available.",
    },
  });

  assert.match(issues.join("\n"), /fact_table must be a non-empty array/);
});

test("validateStructuredOutput rejects research evidence invalid domain and missing coverage", () => {
  const issues = validateStructuredOutput("research_evidence", {
    schema_version: "subagent-output.v1",
    agent_id: "research_evidence",
    fact_table: [
      {
        fact: "CATL has a disputed fact.",
        domain: "unsupported_domain",
        evidence_ids: ["ev-1"],
        confidence: 0.6,
        as_of: "2026-06-10",
      },
    ],
    data_gaps: [{ topic: "coverage", reason: "Coverage was partial." }],
  });

  assert.match(issues.join("\n"), /fact_table\[0\]\.domain is invalid/);
  assert.match(issues.join("\n"), /evidence_coverage must be an object/);
});

test("validateStructuredOutput accepts thesis valuation without optional scenario unit", () => {
  const issues = validateStructuredOutput("thesis_valuation", {
    schema_version: "subagent-output.v1",
    agent_id: "thesis_valuation",
    theses: [{ statement: "CATL is fairly valued.", direction: "mixed", evidence_ids: ["ev-1"], confidence: 0.7 }],
    valuation_framework: {
      method: "scenario framework",
      key_assumptions: ["Margin remains observable."],
      valuation_view: "fairly_valued",
      evidence_ids: ["ev-1"],
    },
    scenario_variables: [{ name: "margin", base: "stable", bull: "improves", bear: "compresses", evidence_ids: ["ev-1"] }],
  });

  assert.deepEqual(issues, []);
});

test("validateStructuredOutput rejects invalid valuation view", () => {
  const issues = validateStructuredOutput("thesis_valuation", {
    schema_version: "subagent-output.v1",
    agent_id: "thesis_valuation",
    theses: [{ statement: "CATL is fairly valued.", direction: "mixed", evidence_ids: ["ev-1"], confidence: 0.7 }],
    valuation_framework: {
      method: "scenario framework",
      key_assumptions: ["Margin remains observable."],
      valuation_view: "preliminary mixed view",
      evidence_ids: ["ev-1"],
    },
    scenario_variables: [{ name: "margin", base: "stable", bull: "improves", bear: "compresses", evidence_ids: ["ev-1"] }],
  });

  assert.match(issues.join("\n"), /valuation_framework\.valuation_view is invalid/);
});

test("validateStructuredOutput rejects missing risk upstream references", () => {
  const issues = validateStructuredOutput("risk_report", {
    schema_version: "subagent-output.v1",
    agent_id: "risk_report",
    counter_evidence: [
      { claim_challenged: "Margin pressure is manageable.", counterpoint: "Customer concentration risk remains.", evidence_ids: ["ev-1"], severity: "medium" },
    ],
    risk_triggers: [{ trigger: "Margin pressure worsens.", metric_or_event: "margin", evidence_ids: ["ev-1"] }],
    final_summary: {
      stance: "mixed",
      key_reasons: ["Risk and thesis evidence both matter."],
      major_risks: ["Margin pressure"],
      data_gaps: [],
    },
  });

  assert.match(issues.join("\n"), /final_summary\.upstream_references must be an object/);
});

test("validateStructuredOutput rejects invalid counter-evidence trigger index type", () => {
  const issues = validateStructuredOutput("risk_report", {
    schema_version: "subagent-output.v1",
    agent_id: "risk_report",
    counter_evidence: [
      { claim_challenged: "Margin pressure is manageable.", counterpoint: "Customer concentration risk remains.", evidence_ids: ["ev-1"], severity: "medium" },
    ],
    risk_triggers: [
      {
        trigger: "Margin pressure worsens.",
        metric_or_event: "margin",
        derived_from_counter_evidence_index: "0",
        evidence_ids: ["ev-1"],
      },
    ],
    final_summary: {
      stance: "mixed",
      key_reasons: ["Risk and thesis evidence both matter."],
      major_risks: ["Margin pressure"],
      data_gaps: [],
      upstream_references: {
        research_evidence_fact_indices: [0],
        thesis_indices: [0],
      },
    },
  });

  assert.match(issues.join("\n"), /derived_from_counter_evidence_index is invalid/);
});
