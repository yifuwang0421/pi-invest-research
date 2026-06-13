import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAICompatibleLLMAdapter } from "../src/llm.js";
import { SUBAGENT_OUTPUT_CONTRACTS } from "../src/output-contracts.js";
import type { LLMGenerateRequest, SubagentResult, SubagentStructuredOutput } from "../src/schemas.js";

test("OpenAI-compatible LLM adapter sends chat completion request and parses JSON", async () => {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { model: string; messages: unknown[] };
    calls.push(body.model);
    assert.equal(body.model, "test-model");
    assert.ok(body.messages.length >= 2);
    return jsonResponse({
      choices: [
        {
          message: {
            content: JSON.stringify({
              summary: "观点与估值完成。",
              findings: [{ statement: "证据显示经营情况可继续跟踪。", evidence_ids: ["ev-1"], confidence: 0.7 }],
              assumptions: [],
              open_questions: [],
              confidence: 0.7,
              structured_output: validThesisStructuredOutput(),
              needs_revision: false,
            }),
          },
        },
      ],
    });
  };

  const adapter = createOpenAICompatibleLLMAdapter({
    apiKey: "test-key",
    baseUrl: "https://example.test/v1",
    model: "test-model",
    fetchImpl,
  });
  const result = await adapter.generateSubagentResult(makeLLMRequest());

  assert.deepEqual(calls, ["test-model"]);
  assert.equal(result.summary, "观点与估值完成。");
  assert.equal(result.findings[0]?.evidence_ids[0], "ev-1");
});

test("OpenAI-compatible LLM adapter includes revision context in the prompt payload", async () => {
  let promptPayload: {
    revision_context?: {
      round?: number;
      max_rounds?: number;
      review?: { issues?: string[] };
      prior_result?: { summary?: string };
    };
  } = {};
  const fetchImpl: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
    const userMessage = body.messages.find((message) => message.role === "user");
    promptPayload = JSON.parse(userMessage?.content ?? "{}") as typeof promptPayload;
    return jsonResponse({
      choices: [
        {
          message: {
            content: JSON.stringify({
              summary: "修订后的观点与估值完成。",
              findings: [{ statement: "证据显示经营情况可继续跟踪。", evidence_ids: ["ev-1"], confidence: 0.7 }],
              assumptions: [],
              open_questions: [],
              confidence: 0.7,
              structured_output: validThesisStructuredOutput(),
              needs_revision: false,
            }),
          },
        },
      ],
    });
  };

  const adapter = createOpenAICompatibleLLMAdapter({
    apiKey: "test-key",
    model: "test-model",
    fetchImpl,
  });
  const request = makeLLMRequest();
  await adapter.generateSubagentResult({
    ...request,
    revision_context: {
      round: 1,
      max_rounds: 2,
      prior_result: validPriorResult(),
      review: {
        agent_id: "thesis_valuation",
        pass: false,
        score: 70,
        issues: ["[critical] thesis_valuation.theses[0].evidence_ids cites missing evidence: missing-ev."],
        revision_instruction: "Fix missing evidence citations.",
      },
    },
  });

  assert.equal(promptPayload.revision_context?.round, 1);
  assert.equal(promptPayload.revision_context?.max_rounds, 2);
  assert.match(promptPayload.revision_context?.review?.issues?.join("\n") ?? "", /missing evidence/);
  assert.equal(promptPayload.revision_context?.prior_result?.summary, "Prior thesis summary.");
});

test("OpenAI-compatible LLM adapter retries malformed JSON once", async () => {
  let callCount = 0;
  const repairPrompts: string[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    callCount += 1;
    if (callCount === 1) {
      return jsonResponse({ choices: [{ message: { content: "not json" } }] });
    }
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ content?: string }> };
    repairPrompts.push(body.messages.at(-1)?.content ?? "");
    return jsonResponse({
      choices: [
        {
          message: {
            content: JSON.stringify({
              summary: "修复后的结构化结果。",
              findings: [{ statement: "证据可用。", evidence_ids: ["ev-1"], confidence: 0.6 }],
              assumptions: [],
              open_questions: [],
              confidence: 0.6,
              structured_output: validThesisStructuredOutput(),
              needs_revision: false,
            }),
          },
        },
      ],
    });
  };

  const adapter = createOpenAICompatibleLLMAdapter({
    apiKey: "test-key",
    model: "test-model",
    fetchImpl,
  });
  const result = await adapter.generateSubagentResult({
    ...makeLLMRequest(),
    signal: new AbortController().signal,
  });

  assert.equal(callCount, 2);
  assert.equal(result.summary, "修复后的结构化结果。");
  assert.match(repairPrompts.join("\n"), /structured_output/);
});

test("OpenAI-compatible LLM adapter retries HTTP 429 before succeeding", async () => {
  let callCount = 0;
  const fetchImpl: typeof fetch = async (_input, init) => {
    callCount += 1;
    assert.ok(init?.signal instanceof AbortSignal);
    if (callCount === 1) {
      return new Response(JSON.stringify({ error: "rate limited" }), {
        status: 429,
        statusText: "Too Many Requests",
        headers: { "retry-after": "0" },
      });
    }
    return jsonResponse({
      choices: [
        {
          message: {
            content: JSON.stringify({
              summary: "retry ok",
              findings: [{ statement: "evidence is available", evidence_ids: ["ev-1"], confidence: 0.6 }],
              assumptions: [],
              open_questions: [],
              confidence: 0.6,
              structured_output: validThesisStructuredOutput(),
              needs_revision: false,
            }),
          },
        },
      ],
    });
  };

  const adapter = createOpenAICompatibleLLMAdapter({
    apiKey: "test-key",
    model: "test-model",
    fetchImpl,
    retryBaseDelayMs: 0,
  });
  const result = await adapter.generateSubagentResult({
    ...makeLLMRequest(),
    signal: new AbortController().signal,
  });

  assert.equal(callCount, 2);
  assert.equal(result.summary, "retry ok");
});

test("OpenAI-compatible LLM adapter returns revision result after exhausted 5xx retries", async () => {
  let callCount = 0;
  const fetchImpl: typeof fetch = async () => {
    callCount += 1;
    return new Response(JSON.stringify({ error: "temporary" }), {
      status: 503,
      statusText: "Service Unavailable",
    });
  };

  const adapter = createOpenAICompatibleLLMAdapter({
    apiKey: "test-key",
    model: "test-model",
    fetchImpl,
    maxRetries: 1,
    retryBaseDelayMs: 0,
  });
  const result = await adapter.generateSubagentResult(makeLLMRequest());

  assert.equal(callCount, 4);
  assert.equal(result.needs_revision, true);
  assert.match(result.data_gaps.map((gap) => gap.reason).join("\n"), /503/);
});

test("OpenAI-compatible LLM adapter fails clearly without API key", async () => {
  const adapter = createOpenAICompatibleLLMAdapter({
    apiKey: "",
    model: "test-model",
    fetchImpl: async () => jsonResponse({}),
  });

  await assert.rejects(
    () => adapter.generateSubagentResult(makeLLMRequest()),
    /OPENAI_API_KEY/,
  );
});

function makeLLMRequest(): LLMGenerateRequest {
  return {
    normalized_request: {
      request: "做宁德时代深度研究",
      target: "宁德时代",
      task_type: "deep_research",
      output_format: "markdown",
      sources: ["fixture"],
    },
    task: {
      agent_id: "thesis_valuation",
      target: "宁德时代",
      task_type: "deep_research",
      task: "观点与估值",
      role: "leaf",
      depends_on: ["research_evidence"],
      required_evidence: ["财务摘要"],
      allowed_skills: ["thesis-valuation"],
      allowed_toolsets: ["evidence", "llm"],
      result_contract: SUBAGENT_OUTPUT_CONTRACTS.thesis_valuation,
      delegation_context: "独立上下文任务。",
      isolation: {
        fresh_context: true,
        memory_access: "blocked",
        user_interaction: "blocked",
        side_effects: "blocked",
        terminal_session: "dedicated",
        workspace: "dedicated",
      },
    },
    evidence: [
      {
        id: "ev-1",
        source_type: "mock",
        source_name: "fixture-source",
        query: "宁德时代 财务摘要",
        as_of: "2026-06-10",
        retrieved_at: "2026-06-10T00:00:00.000Z",
        confidence: 0.7,
        value: { note: "fixture" },
      },
    ],
    data_gaps: [],
    skill_text: "# Thesis Valuation",
  };
}

function validThesisStructuredOutput(): SubagentStructuredOutput {
  return {
    schema_version: "subagent-output.v1",
    agent_id: "thesis_valuation",
    theses: [
      {
        statement: "Evidence supports a preliminary mixed thesis.",
        direction: "mixed",
        evidence_ids: ["ev-1"],
        confidence: 0.6,
      },
    ],
    valuation_framework: {
      method: "scenario framework",
      key_assumptions: ["Fixture evidence is sufficient for parser validation."],
      valuation_view: "fairly_valued",
      evidence_ids: ["ev-1"],
    },
    scenario_variables: [
      {
        name: "margin",
        base: "stable",
        bull: "improves",
        bear: "compresses",
        evidence_ids: ["ev-1"],
      },
    ],
  };
}

function validPriorResult(): SubagentResult {
  return {
    agent_id: "thesis_valuation",
    task: "观点与估值",
    summary: "Prior thesis summary.",
    findings: [{ statement: "Prior finding cited a missing id.", evidence_ids: ["missing-ev"], confidence: 0.5 }],
    evidence: makeLLMRequest().evidence,
    assumptions: [],
    open_questions: ["Needs citation repair."],
    confidence: 0.5,
    data_gaps: [],
    structured_output: validThesisStructuredOutput(),
    needs_revision: true,
  };
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
