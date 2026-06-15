import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { createFallbackStructuredOutput } from "../src/output-contracts.js";
import { runAnalystAgent } from "../src/runner.js";
import type { LLMAdapter, LLMGenerateRequest, SubagentResult } from "../src/schemas.js";

test("runAnalystAgent writes report, evidence ledger, and trace artifacts", async () => {
  const out = await mkdtemp(join(tmpdir(), "analyst-agent-"));
  const result = await runAnalystAgent(
    {
      request: "做宁德时代深度研究",
      use_live_ifind: false,
      sources: ["fixture"],
    },
    {
      outputDir: out,
      mockLLM: true,
    },
  );

  assert.ok(result.report);
  assert.ok(result.artifacts);
  const report = await readFile(result.artifacts.report, "utf8");
  const ledger = await readFile(result.artifacts.evidence_ledger, "utf8");
  const trace = await readFile(result.artifacts.trace, "utf8");
  const parsedLedger = JSON.parse(ledger) as { schema_version?: string; evidence?: Array<{ quality?: { dedupe_key?: string } }> };
  const dedupeKeys = parsedLedger.evidence?.map((item) => item.quality?.dedupe_key).filter((key): key is string => Boolean(key)) ?? [];

  assert.match(report, /# 宁德时代 投资研究 Memo/);
  assert.equal(parsedLedger.schema_version, "evidence.v1");
  assert.ok((parsedLedger.evidence?.length ?? 0) > 0);
  assert.deepEqual(dedupeKeys, [...new Set(dedupeKeys)]);
  assert.match(trace, /selected_agents/);
});

test("runAnalystAgent returns clarification without writing a misleading report", async () => {
  const result = await runAnalystAgent(
    {
      request: "做一个深度研究",
      use_live_ifind: false,
      sources: ["fixture"],
    },
    {
      mockLLM: true,
    },
  );

  assert.equal(result.clarification_question, "请告诉我需要研究的具体标的、行业或宏观指标。");
  assert.equal(result.report, undefined);
});

test("runAnalystAgent forwards LLM timeout options", async () => {
  const hangingAdapter: LLMAdapter = {
    async generateSubagentResult(request) {
      assert.ok(request.signal instanceof AbortSignal);
      return await new Promise(() => undefined);
    },
  };

  const result = await runAnalystAgent(
    {
      request: "Summarize CATL",
      target: "CATL",
      task_type: "general",
      use_live_ifind: false,
      sources: ["fixture"],
    },
    {
      llmAdapter: hangingAdapter,
      llmTimeoutMs: 5,
    },
  );

  assert.ok(result.report);
  assert.match(result.report.data_gaps.map((gap) => gap.reason).join("\n"), /timed out/);
});

test("runAnalystAgent forwards max concurrency options", async () => {
  let active = 0;
  let maxActive = 0;
  const adapter: LLMAdapter = {
    async generateSubagentResult(request) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return buildRunnerSubagentResult(request);
    },
  };

  const result = await runAnalystAgent(
    {
      request: "Deep research CATL",
      target: "CATL",
      task_type: "deep_research",
      use_live_ifind: false,
      sources: ["fixture"],
    },
    {
      llmAdapter: adapter,
      maxConcurrency: 1,
    },
  );

  assert.ok(result.report);
  assert.equal(result.report.trace.plan.delegation_policy.max_concurrency, 1);
  assert.equal(maxActive, 1);
});

function buildRunnerSubagentResult(request: LLMGenerateRequest): SubagentResult {
  const findings = [
    {
      statement: `${request.task.agent_id} finding for ${request.task.target}.`,
      evidence_ids: request.evidence.slice(0, 1).map((item) => item.id),
      confidence: 0.72,
    },
  ];
  return {
    agent_id: request.task.agent_id,
    task: request.task.task,
    summary: `${request.task.agent_id} summary.`,
    findings,
    evidence: request.evidence,
    assumptions: [],
    open_questions: [],
    confidence: 0.72,
    data_gaps: request.data_gaps,
    structured_output: createFallbackStructuredOutput({
      agent_id: request.task.agent_id,
      target: request.task.target,
      evidence: request.evidence,
      data_gaps: request.data_gaps,
      findings,
    }),
    needs_revision: false,
  };
}
