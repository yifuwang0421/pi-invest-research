import assert from "node:assert/strict";
import test from "node:test";
import { createInvestResearchTool, createMockLLMAdapter, investResearch } from "../src/index.js";
import { buildSubagentTask, runSubagentTask } from "../src/orchestrator.js";
import { createMockIFindAdapter } from "../src/ifind-adapter.js";
import type { FinalReport, LLMAdapter } from "../src/schemas.js";
import { createEvidenceProviders } from "../src/sources.js";

test("investResearch produces a Markdown report with the compressed three-agent pipeline", async () => {
  const result = await investResearch(
    {
      request: "做宁德时代深度研究",
      sources: ["fixture"],
      use_live_ifind: false,
    },
    {
      evidenceProviders: createEvidenceProviders(["fixture"]),
      llmAdapter: createMockLLMAdapter(),
    },
  );

  assert.ok(!("clarification_question" in result));
  const report = result as FinalReport;
  assert.deepEqual(report.selected_agents, ["research_evidence", "thesis_valuation", "risk_report"]);
  assert.match(report.markdown, /# 宁德时代 投研分析报告/);
  assert.ok(report.evidence_ledger.length > 0);
  assert.ok(!report.markdown.includes("workflow JSON"));
  assert.equal(report.trace.delegation_executions.length, 3);
  assert.deepEqual(
    report.trace.delegation_executions.find((entry) => entry.agent_id === "risk_report")?.upstream_agents,
    ["research_evidence", "thesis_valuation"],
  );
  assert.match(
    report.trace.delegation_executions[0]?.terminal_session_id ?? "",
    /^term-\d+-/,
  );
});

test("technical live adapter path uses evidence plus risk/report agents", async () => {
  const result = await investResearch(
    {
      request: "只做贵州茅台近一个月技术面复盘",
      use_live_ifind: true,
    },
    {
      evidenceProviders: createEvidenceProviders(["ifind"], { ifindAdapter: createMockIFindAdapter() }),
      llmAdapter: createMockLLMAdapter(),
    },
  );

  assert.ok(!("clarification_question" in result));
  const report = result as FinalReport;
  assert.deepEqual(report.selected_agents, ["research_evidence", "risk_report"]);
  assert.ok(report.evidence_ledger.length >= 2);
  assert.ok(report.markdown.includes("mock-ifind-stock"));
});

test("extension tool registers and can execute", async () => {
  const tool = createInvestResearchTool();
  assert.equal(tool.name, "invest_research");

  const result = await tool.execute("tool-call-1", {
    request: "对贵州茅台做风险检查",
    use_live_ifind: false,
  });

  assert.match(result.content[0]?.text ?? "", /贵州茅台 投研分析报告/);
  assert.ok(typeof result.details === "object" && result.details !== null);
});

test("runSubagentTask times out a hanging LLM adapter", async () => {
  const adapter: LLMAdapter = {
    async generateSubagentResult(request) {
      assert.ok(request.signal instanceof AbortSignal);
      return await new Promise(() => undefined);
    },
  };

  const result = await runSubagentTask(
    buildSubagentTask("research_evidence", "CATL", "general"),
    createEvidenceProviders(["fixture"]),
    adapter,
    {
      request: "Summarize CATL",
      target: "CATL",
      task_type: "general",
      output_format: "markdown",
      sources: ["fixture"],
    },
    "",
    [],
    5,
  );

  assert.equal(result.needs_revision, true);
  assert.match(result.data_gaps.map((gap) => gap.reason).join("\n"), /timed out/);
});
