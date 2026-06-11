import assert from "node:assert/strict";
import test from "node:test";
import { buildSubagentTask } from "../src/orchestrator.js";
import { FixtureEvidenceProvider } from "../src/sources.js";

test("FixtureEvidenceProvider only preserves ids with exact agent suffix", async () => {
  const provider = new FixtureEvidenceProvider([
    {
      id: "fixture-research_evidence-shared",
      source_type: "mock",
      source_name: "fixture-source",
      query: "CATL revenue",
      as_of: "2026-06-10",
      retrieved_at: "2026-06-10T00:00:00.000Z",
      confidence: 0.72,
    },
  ]);

  const result = await provider.collect(buildSubagentTask("research_evidence", "CATL", "general"));

  assert.equal(result.evidence[0]?.id, "fixture-research_evidence-shared-research_evidence");
});

test("FixtureEvidenceProvider preserves ids that already end with agent suffix", async () => {
  const provider = new FixtureEvidenceProvider([
    {
      id: "fixture-basic-research_evidence",
      source_type: "mock",
      source_name: "fixture-source",
      query: "CATL revenue",
      as_of: "2026-06-10",
      retrieved_at: "2026-06-10T00:00:00.000Z",
      confidence: 0.72,
    },
  ]);

  const result = await provider.collect(buildSubagentTask("research_evidence", "CATL", "general"));

  assert.equal(result.evidence[0]?.id, "fixture-basic-research_evidence");
});
