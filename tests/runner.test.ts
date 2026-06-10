import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { runAnalystAgent } from "../src/runner.js";

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
      fixturePath: "tests/fixtures/basic-evidence.json",
      mockLLM: true,
    },
  );

  assert.ok(result.report);
  assert.ok(result.artifacts);
  const report = await readFile(result.artifacts.report, "utf8");
  const ledger = await readFile(result.artifacts.evidence_ledger, "utf8");
  const trace = await readFile(result.artifacts.trace, "utf8");

  assert.match(report, /# 宁德时代 投研分析报告/);
  assert.match(ledger, /fixture-basic-evidence/);
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
