import assert from "node:assert/strict";
import test from "node:test";
import { buildResearchPlan, selectSubagents } from "../src/orchestrator.js";

test("technical review selects evidence and risk/report agents", () => {
  assert.deepEqual(
    selectSubagents("technical_review", "只做贵州茅台近一个月技术面复盘"),
    ["research_evidence", "risk_report"],
  );
});

test("deep research selects the compressed three-agent pipeline", () => {
  assert.deepEqual(
    selectSubagents("deep_research", "做宁德时代深度研究"),
    ["research_evidence", "thesis_valuation", "risk_report"],
  );
});

test("research plan encodes Hermes-style isolated delegation boundaries", () => {
  const plan = buildResearchPlan({ request: "做宁德时代深度研究" });
  const riskReportTask = plan.tasks.find((task) => task.agent_id === "risk_report");
  const parallelTasks = plan.tasks.filter((task) => task.depends_on.length === 0);

  assert.equal(plan.delegation_policy.mode, "batch");
  assert.equal(plan.delegation_policy.max_concurrency, 3);
  assert.equal(plan.delegation_policy.summary_only, true);
  assert.deepEqual(parallelTasks.map((task) => task.agent_id), ["research_evidence", "thesis_valuation"]);
  assert.deepEqual(riskReportTask?.depends_on, ["research_evidence", "thesis_valuation"]);
  assert.equal(riskReportTask?.isolation.user_interaction, "blocked");
  assert.equal(riskReportTask?.isolation.terminal_session, "dedicated");
  assert.equal(riskReportTask?.isolation.workspace, "dedicated");
});

test("missing target asks a concise clarification question", () => {
  const plan = buildResearchPlan({ request: "做一个深度研究" });
  assert.equal(plan.clarification_question, "请告诉我需要研究的具体标的、行业或宏观指标。");
  assert.equal(plan.tasks.length, 0);
});
