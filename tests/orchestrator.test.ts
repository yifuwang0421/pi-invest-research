import assert from "node:assert/strict";
import test from "node:test";
import { createInvestResearchTool, createMockLLMAdapter, investResearch } from "../src/index.js";
import { buildSubagentTask, runSubagentTask } from "../src/orchestrator.js";
import { createMockIFindAdapter } from "../src/ifind-adapter.js";
import { createFallbackStructuredOutput } from "../src/output-contracts.js";
import type { FinalReport, LLMAdapter, LLMGenerateRequest, SubagentId, SubagentResult } from "../src/schemas.js";
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
  assert.deepEqual(
    report.trace.subagent_results.map((result) => result.structured_output?.agent_id),
    report.trace.subagent_results.map((result) => result.agent_id),
  );
  assert.match(report.markdown, /## Structured Agent Outputs/);
  assert.match(report.markdown, /Fact Table/);
  assert.match(report.markdown, /\[(quote|financials|announcement|news|profile|macro|other)\]/);
  assert.match(report.markdown, /Thesis And Valuation/);
  assert.match(report.markdown, /\[(bullish|neutral|bearish|mixed)\]/);
  assert.match(report.markdown, /Valuation framework: evidence-led qualitative framework; (fairly_valued|insufficient_data)/);
  assert.match(report.markdown, /Scenario variable: evidence quality/);
  assert.match(report.markdown, /Risk And Counter Evidence/);
  assert.match(report.markdown, /Counter-evidence \[(low|medium|high)\]/);
  assert.match(report.markdown, /Trigger: Evidence quality deteriorates or key data remains unavailable/);
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

test("investResearch reruns a failed subagent with concrete review issues until it passes", async () => {
  const calls: LLMGenerateRequest[] = [];
  const attempts = new Map<SubagentId, number>();
  const adapter: LLMAdapter = {
    async generateSubagentResult(request) {
      calls.push(request);
      const attempt = (attempts.get(request.task.agent_id) ?? 0) + 1;
      attempts.set(request.task.agent_id, attempt);
      if (request.task.agent_id === "research_evidence" && attempt === 1) {
        return buildMockSubagentResult(request, {
          evidenceIds: ["missing-ev"],
          summary: "Initial evidence summary cites a missing evidence id.",
        });
      }
      return buildMockSubagentResult(request, {
        summary:
          request.task.agent_id === "research_evidence"
            ? "Revised evidence summary fixes review issues."
            : "Risk report regenerated against latest upstream evidence.",
      });
    },
  };

  const result = await investResearch(
    {
      request: "Summarize CATL",
      target: "CATL",
      task_type: "general",
      sources: ["fixture"],
      use_live_ifind: false,
    },
    {
      evidenceProviders: createEvidenceProviders(["fixture"]),
      llmAdapter: adapter,
    },
  );

  assert.ok(!("clarification_question" in result));
  const report = result as FinalReport;
  assert.deepEqual(report.review_results.map((review) => review.pass), [true, true]);
  const revisedResearchCall = calls.find(
    (call) => call.task.agent_id === "research_evidence" && call.revision_context,
  );
  assert.equal(revisedResearchCall?.revision_context?.round, 1);
  assert.match(revisedResearchCall?.revision_context?.review.issues.join("\n") ?? "", /missing evidence/);
  assert.equal(report.trace.subagent_results.find((item) => item.agent_id === "research_evidence")?.summary, "Revised evidence summary fixes review issues.");
  assert.equal(report.trace.subagent_results.find((item) => item.agent_id === "research_evidence")?.revision_history?.length, 1);
  assert.match(
    report.trace.subagent_results.find((item) => item.agent_id === "research_evidence")?.revision_history?.[0]?.review.issues.join("\n") ?? "",
    /missing evidence/,
  );
  assert.ok(report.trace.delegation_executions.some((entry) => entry.agent_id === "research_evidence" && entry.status === "revised"));
});

test("upstream revision reruns dependent risk report with the latest upstream result", async () => {
  const riskCalls: LLMGenerateRequest[] = [];
  const attempts = new Map<SubagentId, number>();
  const adapter: LLMAdapter = {
    async generateSubagentResult(request) {
      const attempt = (attempts.get(request.task.agent_id) ?? 0) + 1;
      attempts.set(request.task.agent_id, attempt);
      if (request.task.agent_id === "risk_report") riskCalls.push(request);
      if (request.task.agent_id === "research_evidence" && attempt === 1) {
        return buildMockSubagentResult(request, {
          evidenceIds: ["missing-ev"],
          summary: "Old upstream evidence summary.",
        });
      }
      return buildMockSubagentResult(request, {
        summary:
          request.task.agent_id === "research_evidence"
            ? "Fresh upstream evidence summary."
            : `Risk saw upstream: ${request.upstream_results?.[0]?.summary ?? "none"}`,
      });
    },
  };

  const result = await investResearch(
    {
      request: "Summarize CATL",
      target: "CATL",
      task_type: "general",
      sources: ["fixture"],
      use_live_ifind: false,
    },
    {
      evidenceProviders: createEvidenceProviders(["fixture"]),
      llmAdapter: adapter,
    },
  );

  assert.ok(!("clarification_question" in result));
  const report = result as FinalReport;
  assert.equal(riskCalls.length, 2);
  assert.equal(riskCalls[1]?.revision_context?.review.issues[0], "[major] Upstream result changed: research_evidence. Regenerate against the latest upstream_results.");
  assert.equal(riskCalls[1]?.upstream_results?.[0]?.summary, "Fresh upstream evidence summary.");
  assert.equal(report.trace.subagent_results.find((item) => item.agent_id === "risk_report")?.summary, "Risk saw upstream: Fresh upstream evidence summary.");
});

test("upstream revision does not rerun dependents when semantic output is unchanged", async () => {
  const riskCalls: LLMGenerateRequest[] = [];
  const attempts = new Map<SubagentId, number>();
  const adapter: LLMAdapter = {
    async generateSubagentResult(request) {
      const attempt = (attempts.get(request.task.agent_id) ?? 0) + 1;
      attempts.set(request.task.agent_id, attempt);
      if (request.task.agent_id === "risk_report") riskCalls.push(request);
      if (request.task.agent_id === "research_evidence" && attempt === 1) {
        return buildMockSubagentResult(request, {
          summary: "Stable upstream evidence summary.",
          needsRevision: true,
        });
      }
      return buildMockSubagentResult(request, {
        summary:
          request.task.agent_id === "research_evidence"
            ? "Stable upstream evidence summary."
            : "Risk report should not be rerun for status-only upstream changes.",
      });
    },
  };

  const result = await investResearch(
    {
      request: "Summarize CATL",
      target: "CATL",
      task_type: "general",
      sources: ["fixture"],
      use_live_ifind: false,
    },
    {
      evidenceProviders: createEvidenceProviders(["fixture"]),
      llmAdapter: adapter,
    },
  );

  assert.ok(!("clarification_question" in result));
  assert.equal(riskCalls.length, 1);
});

test("revision reruns independent failed agents in parallel within the same round", async () => {
  let activeRevisionCalls = 0;
  let maxActiveRevisionCalls = 0;
  const attempts = new Map<SubagentId, number>();
  const adapter: LLMAdapter = {
    async generateSubagentResult(request) {
      const attempt = (attempts.get(request.task.agent_id) ?? 0) + 1;
      attempts.set(request.task.agent_id, attempt);
      if (
        (request.task.agent_id === "research_evidence" || request.task.agent_id === "thesis_valuation") &&
        attempt === 1
      ) {
        return buildMockSubagentResult(request, {
          evidenceIds: ["missing-ev"],
          summary: `${request.task.agent_id} initial invalid summary.`,
        });
      }
      if (request.revision_context && request.task.agent_id !== "risk_report") {
        activeRevisionCalls += 1;
        maxActiveRevisionCalls = Math.max(maxActiveRevisionCalls, activeRevisionCalls);
        await new Promise((resolve) => setTimeout(resolve, 20));
        activeRevisionCalls -= 1;
      }
      return buildMockSubagentResult(request, {
        summary: `${request.task.agent_id} revised valid summary.`,
      });
    },
  };

  const result = await investResearch(
    {
      request: "做CATL深度研究",
      target: "CATL",
      task_type: "deep_research",
      sources: ["fixture"],
      use_live_ifind: false,
    },
    {
      evidenceProviders: createEvidenceProviders(["fixture"]),
      llmAdapter: adapter,
      delegation: { max_concurrency: 2 },
    },
  );

  assert.ok(!("clarification_question" in result));
  assert.equal(maxActiveRevisionCalls, 2);
});

test("revision skips pure evidence-required failures instead of rerunning the LLM", async () => {
  const researchCalls: LLMGenerateRequest[] = [];
  const adapter: LLMAdapter = {
    async generateSubagentResult(request) {
      if (request.task.agent_id === "research_evidence") researchCalls.push(request);
      if (request.task.agent_id === "research_evidence") {
        return buildMockSubagentResult(request, {
          evidenceIds: [],
          summary: "Evidence-backed fact is missing citable evidence.",
        });
      }
      return buildMockSubagentResult(request);
    },
  };

  const result = await investResearch(
    {
      request: "Summarize CATL",
      target: "CATL",
      task_type: "general",
      sources: ["fixture"],
      use_live_ifind: false,
    },
    {
      evidenceProviders: createEvidenceProviders(["fixture"]),
      llmAdapter: adapter,
    },
  );

  assert.ok(!("clarification_question" in result));
  const report = result as FinalReport;
  assert.equal(researchCalls.length, 1);
  const review = report.review_results.find((item) => item.agent_id === "research_evidence");
  assert.equal(review?.revision_action, "needs_evidence");
  assert.match(review?.revision_instruction ?? "", /require additional evidence/);
});

test("revision loop stops after the configured maximum rounds", async () => {
  const researchCalls: LLMGenerateRequest[] = [];
  const adapter: LLMAdapter = {
    async generateSubagentResult(request) {
      if (request.task.agent_id === "research_evidence") researchCalls.push(request);
      return buildMockSubagentResult(request, {
        ...(request.task.agent_id === "research_evidence" ? { evidenceIds: ["missing-ev"] } : {}),
        summary: `${request.task.agent_id} stays invalid.`,
      });
    },
  };

  const result = await investResearch(
    {
      request: "Summarize CATL",
      target: "CATL",
      task_type: "general",
      sources: ["fixture"],
      use_live_ifind: false,
    },
    {
      evidenceProviders: createEvidenceProviders(["fixture"]),
      llmAdapter: adapter,
      delegation: { max_revision_rounds: 2 },
    },
  );

  assert.ok(!("clarification_question" in result));
  const report = result as FinalReport;
  const researchReview = report.review_results.find((review) => review.agent_id === "research_evidence");
  assert.equal(researchReview?.pass, false);
  assert.equal(researchCalls.length, 3);
  assert.equal(report.trace.delegation_executions.filter((entry) => entry.agent_id === "research_evidence" && entry.status === "revised").length, 2);
  assert.deepEqual(
    report.trace.subagent_results.map((item) => item.agent_id),
    ["research_evidence", "risk_report"],
  );
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

function buildMockSubagentResult(
  request: LLMGenerateRequest,
  options: { evidenceIds?: string[]; summary?: string; needsRevision?: boolean; openQuestions?: string[] } = {},
): SubagentResult {
  const evidenceIds = options.evidenceIds ?? request.evidence.slice(0, 1).map((item) => item.id);
  const findings = [
    {
      statement: `${request.task.agent_id} finding for ${request.task.target}.`,
      evidence_ids: evidenceIds,
      confidence: 0.72,
    },
  ];
  return {
    agent_id: request.task.agent_id,
    task: request.task.task,
    summary: options.summary ?? `${request.task.agent_id} summary.`,
    findings,
    evidence: request.evidence,
    assumptions: [],
    open_questions: options.openQuestions ?? [],
    confidence: 0.72,
    data_gaps: request.data_gaps,
    structured_output: createFallbackStructuredOutput({
      agent_id: request.task.agent_id,
      target: request.task.target,
      evidence: request.evidence,
      data_gaps: request.data_gaps,
      findings,
    }),
    needs_revision: options.needsRevision ?? false,
  };
}
