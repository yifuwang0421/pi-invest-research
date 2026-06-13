import type {
  DataGap,
  LLMAdapter,
  LLMGenerateRequest,
  SubagentResult,
  SubagentStructuredOutput,
} from "./schemas.js";
import { summarizeEvidenceForLLM } from "./evidence.js";
import {
  createFallbackStructuredOutput,
  getRequiredStructuredShape,
  parseStructuredOutput,
} from "./output-contracts.js";
import { SUBAGENT_PROFILES } from "./subagents.js";

interface ChatMessage {
  role: "system" | "user";
  content: string;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

type LLMRequiredShape = Omit<SubagentResult, "evidence" | "data_gaps" | "structured_output"> & {
  structured_output: SubagentStructuredOutput;
};

const REQUIRED_RESULT_SHAPE_TEMPLATE = {
  task: "string",
  summary: "string",
  findings: [{ statement: "string", evidence_ids: ["string"], confidence: 0.0 }],
  assumptions: ["string"],
  open_questions: ["string"],
  confidence: 0.0,
  needs_revision: false,
} satisfies Omit<LLMRequiredShape, "agent_id" | "structured_output">;

export interface OpenAICompatibleLLMOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  retryBaseDelayMs?: number;
}

export function createOpenAICompatibleLLMAdapter(options: OpenAICompatibleLLMOptions = {}): LLMAdapter {
  return new OpenAICompatibleLLMAdapter(options);
}

export function createMockLLMAdapter(): LLMAdapter {
  return createHeuristicLLMAdapter();
}

export function createHeuristicLLMAdapter(): LLMAdapter {
  return {
    async generateSubagentResult(request: LLMGenerateRequest): Promise<SubagentResult> {
      return buildHeuristicResult(request);
    },
  };
}

class OpenAICompatibleLLMAdapter implements LLMAdapter {
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;

  constructor(options: OpenAICompatibleLLMOptions) {
    this.apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
    this.baseUrl = options.baseUrl ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
    this.model = options.model ?? process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 500;
  }

  async generateSubagentResult(request: LLMGenerateRequest): Promise<SubagentResult> {
    if (!this.apiKey) {
      throw new Error("OPENAI_API_KEY is required for OpenAI-compatible LLM execution.");
    }

    const messages = buildMessages(request);
    try {
      const first = await this.callModel(messages, request.signal);
      return parseAndNormalize(first, request);
    } catch (firstError) {
      const repairMessages: ChatMessage[] = [
        ...messages,
        {
          role: "user",
          content: [
            "The previous output did not satisfy the required JSON contract.",
            "Return only one JSON object. Do not use Markdown or code fences.",
            "The object must include structured_output exactly matching required_shape.structured_output.",
            `Error: ${firstError instanceof Error ? firstError.message : String(firstError)}`,
          ].join("\n"),
        },
      ];
      try {
        const repaired = await this.callModel(repairMessages, request.signal);
        return parseAndNormalize(repaired, request);
      } catch (secondError) {
        return buildLLMFailureResult(request, secondError);
      }
    }
  }

  private async callModel(messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
    const endpoint = `${this.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const maxAttempts = Math.max(1, this.maxRetries + 1);

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const init: RequestInit = {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: this.model,
            temperature: 0.2,
            messages,
          }),
        };
        if (signal) init.signal = signal;
        const response = await this.fetchImpl(endpoint, init);

        if (!response.ok) {
          const error = new LLMHttpError(response.status, response.statusText, retryAfterMs(response.headers));
          if (attempt < maxAttempts - 1 && isRetryableHttpStatus(response.status)) {
            await delay(retryDelayMs(attempt, this.retryBaseDelayMs, error.retryAfterMs), signal);
            continue;
          }
          throw error;
        }

        const payload = (await response.json()) as ChatCompletionResponse;
        const content = payload.choices?.[0]?.message?.content;
        if (!content) {
          throw new Error("LLM response had no message content.");
        }
        return content;
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) throw error;
        if (attempt < maxAttempts - 1 && isRetryableNetworkError(error)) {
          await delay(retryDelayMs(attempt, this.retryBaseDelayMs), signal);
          continue;
        }
        throw error;
      }
    }

    throw new Error("LLM call failed without an execution attempt.");
  }
}

class LLMHttpError extends Error {
  constructor(
    readonly status: number,
    readonly statusText: string,
    readonly retryAfterMs?: number,
  ) {
    super(`LLM HTTP ${status} ${statusText}`);
  }
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function isRetryableNetworkError(error: unknown): boolean {
  return error instanceof TypeError;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function retryAfterMs(headers: Headers): number | undefined {
  const value = headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return undefined;
  return Math.max(0, timestamp - Date.now());
}

function retryDelayMs(attempt: number, baseDelayMs: number, retryAfter?: number): number {
  if (retryAfter !== undefined) return retryAfter;
  return Math.max(0, baseDelayMs * 2 ** attempt);
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    const abort = () => {
      clearTimeout(timeout);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function buildMessages(request: LLMGenerateRequest): ChatMessage[] {
  const profile = SUBAGENT_PROFILES[request.task.agent_id];
  return [
    {
      role: "system",
      content: [
        "你是严谨的投资研究子 agent。",
        "你运行在独立上下文、独立终端会话和独立工作区中，只能使用本次输入里的 task、evidence、data_gaps 和 upstream_results。",
        "所有事实性判断必须引用 evidence_ids；无法由证据支持的内容必须放入 assumptions 或 data_gaps。",
        "如果 revision_context 存在，你是在返工：必须逐条修复 review.issues，返回完整 JSON 结果而不是差异补丁。",
        "返工时只能复用本次 evidence 中存在的 evidence_ids，不能编造新证据或引用不存在的 evidence id。",
        "只返回 JSON 对象，不要 Markdown，不要代码围栏。",
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          profile,
          skill: request.skill_text,
          normalized_request: request.normalized_request,
          task: request.task,
          delegation_context: request.delegation_context ?? request.task.delegation_context,
          evidence: summarizeEvidenceForLLM(request.evidence),
          data_gaps: request.data_gaps,
          upstream_results: request.upstream_results ?? [],
          revision_context: request.revision_context
            ? {
                round: request.revision_context.round,
                max_rounds: request.revision_context.max_rounds,
                review: request.revision_context.review,
                prior_result: {
                  agent_id: request.revision_context.prior_result.agent_id,
                  task: request.revision_context.prior_result.task,
                  summary: request.revision_context.prior_result.summary,
                  findings: request.revision_context.prior_result.findings,
                  assumptions: request.revision_context.prior_result.assumptions,
                  open_questions: request.revision_context.prior_result.open_questions,
                  confidence: request.revision_context.prior_result.confidence,
                  data_gaps: request.revision_context.prior_result.data_gaps,
                  structured_output: request.revision_context.prior_result.structured_output,
                  needs_revision: request.revision_context.prior_result.needs_revision,
                },
              }
            : undefined,
          required_shape: {
            agent_id: request.task.agent_id,
            ...REQUIRED_RESULT_SHAPE_TEMPLATE,
            structured_output: getRequiredStructuredShape(request.task.agent_id),
          } satisfies LLMRequiredShape,
        },
        null,
        2,
      ),
    },
  ];
}

function parseAndNormalize(content: string, request: LLMGenerateRequest): SubagentResult {
  const parsed = JSON.parse(extractJson(content)) as Partial<SubagentResult>;
  const evidenceIds = new Set(request.evidence.map((item) => item.id));
  const findings = Array.isArray(parsed.findings)
    ? parsed.findings.map((finding) => ({
        statement: typeof finding.statement === "string" ? finding.statement : "",
        evidence_ids: Array.isArray(finding.evidence_ids)
          ? finding.evidence_ids.filter((id): id is string => typeof id === "string" && evidenceIds.has(id))
          : [],
        confidence: clampConfidence(finding.confidence),
        ...(finding.is_assumption ? { is_assumption: true } : {}),
      })).filter((finding) => finding.statement.trim().length > 0)
    : [];
  const structuredOutput = parseStructuredOutput(request.task.agent_id, parsed.structured_output);

  return {
    agent_id: request.task.agent_id,
    task: request.task.task,
    summary: typeof parsed.summary === "string" && parsed.summary.trim()
      ? parsed.summary
      : `${SUBAGENT_PROFILES[request.task.agent_id].name} 已完成分析。`,
    findings,
    evidence: request.evidence,
    assumptions: normalizeStringArray(parsed.assumptions),
    open_questions: normalizeStringArray(parsed.open_questions),
    confidence: clampConfidence(parsed.confidence),
    data_gaps: request.data_gaps,
    structured_output: structuredOutput,
    needs_revision: Boolean(parsed.needs_revision) || findings.length === 0,
  };
}

function buildHeuristicResult(request: LLMGenerateRequest): SubagentResult {
  const profile = SUBAGENT_PROFILES[request.task.agent_id];
  const evidenceIds = request.evidence.slice(0, 3).map((item) => item.id);
  const hasEvidence = evidenceIds.length > 0;
  return {
    agent_id: request.task.agent_id,
    task: request.task.task,
    summary: hasEvidence
      ? `${profile.name}基于 ${request.evidence.length} 条证据完成初步分析，仍需结合正式数据源复核。`
      : `${profile.name}完成任务框架，但当前缺少可引用证据。`,
    findings: [
      {
        statement: hasEvidence
          ? `${request.task.target} 的${profile.name}已有可引用证据，可进入汇总评审。`
          : `${request.task.target} 的${profile.name}判断缺少足够证据，暂列为待验证假设。`,
        evidence_ids: evidenceIds,
        confidence: hasEvidence ? 0.68 : 0.25,
        ...(!hasEvidence ? { is_assumption: true } : {}),
      },
    ],
    evidence: request.evidence,
    assumptions: hasEvidence ? [] : [`${request.task.target} 的 ${request.task.agent_id} 结论需要补充真实数据验证。`],
    open_questions: [],
    confidence: hasEvidence ? 0.68 : 0.3,
    data_gaps: request.data_gaps,
    structured_output: createFallbackStructuredOutput({
      agent_id: request.task.agent_id,
      target: request.task.target,
      evidence: request.evidence,
      data_gaps: request.data_gaps,
    }),
    needs_revision: !hasEvidence && request.task.required_evidence.length > 0,
  };
}

function buildLLMFailureResult(request: LLMGenerateRequest, error: unknown): SubagentResult {
  const occurredAt = new Date().toISOString();
  const gap: DataGap = {
    source_name: "openai-compatible-llm",
    query: request.task.task,
    reason: error instanceof Error ? error.message : String(error),
    occurred_at: occurredAt,
  };
  const fallback = buildHeuristicResult({
    ...request,
    data_gaps: [...request.data_gaps, gap],
  });
  return {
    ...fallback,
    needs_revision: true,
    open_questions: [...fallback.open_questions, "LLM 输出未通过 JSON 结构校验，需要重新生成。"],
  };
}

function extractJson(content: string): string {
  const trimmed = content.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  throw new Error("LLM output did not contain a JSON object.");
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function clampConfidence(value: unknown): number {
  if (typeof value !== "number" || Number.isNaN(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}
