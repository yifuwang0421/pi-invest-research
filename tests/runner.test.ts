import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { runAnalystAgent } from "../src/runner.js";
import type { LLMAdapter } from "../src/schemas.js";

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

  assert.match(report, /# 宁德时代 投研分析报告/);
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
