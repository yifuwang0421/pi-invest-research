import type {
  DataGap,
  LLMAdapter,
  LLMAttemptPhase,
  LLMAttemptTrace,
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
  retryMaxDelayMs?: number;
  retryJitterRatio?: number;
  retryJitterMaxMs?: number;
  requestMinIntervalMs?: number;
  circuitBreakerFailureThreshold?: number;
  circuitBreakerOpenMs?: number;
  sharedStateKey?: string;
  random?: () => number;
  delayImpl?: (ms: number, signal?: AbortSignal) => Promise<void>;
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
  private readonly retryMaxDelayMs: number;
  private readonly retryJitterRatio: number;
  private readonly retryJitterMaxMs: number;
  private readonly requestMinIntervalMs: number;
  private readonly circuitBreakerFailureThreshold: number;
  private readonly circuitBreakerOpenMs: number;
  private readonly random: () => number;
  private readonly delayImpl: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly sharedState: SharedEndpointState;

  constructor(options: OpenAICompatibleLLMOptions) {
    this.apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
    this.baseUrl = options.baseUrl ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
    this.model = options.model ?? process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 500;
    this.retryMaxDelayMs = options.retryMaxDelayMs ?? 30_000;
    this.retryJitterRatio = options.retryJitterRatio ?? 0.2;
    this.retryJitterMaxMs = options.retryJitterMaxMs ?? 1_000;
    this.requestMinIntervalMs = options.requestMinIntervalMs ?? readPositiveIntegerEnv("OPENAI_REQUEST_MIN_INTERVAL_MS", 6_000);
    this.circuitBreakerFailureThreshold = options.circuitBreakerFailureThreshold ?? 3;
    this.circuitBreakerOpenMs = options.circuitBreakerOpenMs ?? 60_000;
    this.random = options.random ?? Math.random;
    this.delayImpl = options.delayImpl ?? delay;
    this.sharedState = getSharedEndpointState(options.sharedStateKey ?? `${this.baseUrl.replace(/\/$/, "")}/chat/completions`);
  }

  async generateSubagentResult(request: LLMGenerateRequest): Promise<SubagentResult> {
    if (!this.apiKey) {
      throw new Error("OPENAI_API_KEY is required for OpenAI-compatible LLM execution.");
    }

    request.onLLMRetryBudget?.(Math.max(0, this.maxRetries));
    const messages = buildMessages(request);
    const retryBudget = { remaining: Math.max(0, this.maxRetries) };
    try {
      const first = await this.callModel(messages, "initial", request, retryBudget);
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
        const repaired = await this.callModel(repairMessages, "repair", request, retryBudget);
        return parseAndNormalize(repaired, request);
      } catch (secondError) {
        return buildLLMFailureResult(request, secondError);
      }
    }
  }

  private async callModel(
    messages: ChatMessage[],
    phase: LLMAttemptPhase,
    request: LLMGenerateRequest,
    retryBudget: { remaining: number },
  ): Promise<string> {
    const endpoint = `${this.baseUrl.replace(/\/$/, "")}/chat/completions`;
    let attempt = 0;

    while (true) {
      const started = new Date();
      let rateLimitDelayMs = 0;
      try {
        this.sharedState.circuitBreaker.assertClosed(this.circuitBreakerOpenMs);
        rateLimitDelayMs = await this.sharedState.rateLimiter.wait(
          this.requestMinIntervalMs,
          this.delayImpl,
          request.signal,
        );
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
        if (request.signal) init.signal = request.signal;
        const response = await this.fetchImpl(endpoint, init);

        if (!response.ok) {
          const error = new LLMHttpError(response.status, response.statusText, retryAfterMs(response.headers));
          const canRetry = retryBudget.remaining > 0 && isRetryableHttpStatus(response.status);
          if (canRetry) {
            retryBudget.remaining -= 1;
            if (isCircuitBreakerFailureStatus(response.status)) {
              this.sharedState.circuitBreaker.recordFailure(this.circuitBreakerFailureThreshold, this.circuitBreakerOpenMs);
            }
            const retryDelay = retryDelayMs(
              attempt,
              this.retryBaseDelayMs,
              this.retryMaxDelayMs,
              this.retryJitterRatio,
              this.retryJitterMaxMs,
              this.random,
              error.retryAfterMs,
            );
            request.onLLMAttempt?.(buildAttemptTrace({
              phase,
              attempt,
              started,
              status: "retry",
              httpStatus: response.status,
              rateLimitDelayMs,
              retryAfterMs: error.retryAfterMs,
              retryDelayMs: retryDelay,
              error,
            }));
            await this.delayImpl(retryDelay, request.signal);
            attempt += 1;
            continue;
          }
          if (isCircuitBreakerFailureStatus(response.status)) {
            this.sharedState.circuitBreaker.recordFailure(this.circuitBreakerFailureThreshold, this.circuitBreakerOpenMs);
          }
          request.onLLMAttempt?.(buildAttemptTrace({
            phase,
            attempt,
            started,
            status: "failed",
            httpStatus: response.status,
            rateLimitDelayMs,
            retryAfterMs: error.retryAfterMs,
            error,
          }));
          throw error;
        }

        const payload = (await response.json()) as ChatCompletionResponse;
        const content = payload.choices?.[0]?.message?.content;
        if (!content) {
          throw new Error("LLM response had no message content.");
        }
        this.sharedState.circuitBreaker.recordSuccess();
        request.onLLMAttempt?.(buildAttemptTrace({
          phase,
          attempt,
          started,
          status: "success",
          httpStatus: response.status,
          rateLimitDelayMs,
        }));
        return content;
      } catch (error) {
        if (error instanceof LLMHttpError) throw error;
        if (request.signal?.aborted || isAbortError(error)) {
          request.onLLMAttempt?.(buildAttemptTrace({
            phase,
            attempt,
            started,
            status: "failed",
            rateLimitDelayMs,
            error,
          }));
          throw error;
        }
        const canRetry = retryBudget.remaining > 0 && isRetryableNetworkError(error);
        if (canRetry) {
          retryBudget.remaining -= 1;
          this.sharedState.circuitBreaker.recordFailure(this.circuitBreakerFailureThreshold, this.circuitBreakerOpenMs);
          const retryDelay = retryDelayMs(
            attempt,
            this.retryBaseDelayMs,
            this.retryMaxDelayMs,
            this.retryJitterRatio,
            this.retryJitterMaxMs,
            this.random,
          );
          request.onLLMAttempt?.(buildAttemptTrace({
            phase,
            attempt,
            started,
            status: "retry",
            rateLimitDelayMs,
            retryDelayMs: retryDelay,
            error,
          }));
          await this.delayImpl(retryDelay, request.signal);
          attempt += 1;
          continue;
        }
        if (isRetryableNetworkError(error)) {
          this.sharedState.circuitBreaker.recordFailure(this.circuitBreakerFailureThreshold, this.circuitBreakerOpenMs);
        }
        request.onLLMAttempt?.(buildAttemptTrace({
          phase,
          attempt,
          started,
          status: "failed",
          rateLimitDelayMs,
          error,
        }));
        throw error;
      }
    }
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

class LLMCircuitOpenError extends Error {
  constructor(readonly openUntil: number) {
    super(`LLM circuit breaker is open until ${new Date(openUntil).toISOString()}.`);
    this.name = "LLMCircuitOpenError";
  }
}

class SharedRateLimiter {
  private nextReadyAt = 0;
  private queue: Promise<void> = Promise.resolve();

  async wait(
    minIntervalMs: number,
    delayImpl: (ms: number, signal?: AbortSignal) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<number> {
    if (minIntervalMs <= 0) return 0;

    const previous = this.queue;
    let release: () => void = () => undefined;
    this.queue = previous.then(() => new Promise<void>((resolve) => {
      release = resolve;
    }));

    await previous;
    const now = Date.now();
    const scheduledAt = Math.max(now, this.nextReadyAt);
    const waitMs = Math.max(0, scheduledAt - now);
    this.nextReadyAt = scheduledAt + minIntervalMs;
    release();

    await delayImpl(waitMs, signal);
    return waitMs;
  }
}

class CircuitBreaker {
  private consecutiveFailures = 0;
  private openUntil = 0;

  assertClosed(openMs: number): void {
    const now = Date.now();
    if (this.openUntil > now) {
      throw new LLMCircuitOpenError(this.openUntil);
    }
    if (this.openUntil > 0 && this.openUntil <= now) {
      this.openUntil = 0;
      this.consecutiveFailures = 0;
    }
    if (openMs <= 0) {
      this.openUntil = 0;
    }
  }

  recordFailure(threshold: number, openMs: number): void {
    if (threshold <= 0 || openMs <= 0) return;
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= threshold) {
      this.openUntil = Date.now() + Math.max(1, openMs);
    }
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.openUntil = 0;
  }

}

interface SharedEndpointState {
  rateLimiter: SharedRateLimiter;
  circuitBreaker: CircuitBreaker;
}

const SHARED_ENDPOINT_STATES = new Map<string, SharedEndpointState>();

function getSharedEndpointState(key: string): SharedEndpointState {
  const existing = SHARED_ENDPOINT_STATES.get(key);
  if (existing) return existing;
  const created = {
    rateLimiter: new SharedRateLimiter(),
    circuitBreaker: new CircuitBreaker(),
  };
  SHARED_ENDPOINT_STATES.set(key, created);
  return created;
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function isCircuitBreakerFailureStatus(status: number): boolean {
  return status >= 500;
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

function retryDelayMs(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  jitterRatio: number,
  jitterMaxMs: number,
  random: () => number,
  retryAfter?: number,
): number {
  const exponential = Math.max(0, baseDelayMs * 2 ** attempt);
  const cappedBase = Math.min(maxDelayMs, exponential);
  const minimumDelay = retryAfter !== undefined ? Math.max(retryAfter, cappedBase) : cappedBase;
  const jitterBase = retryAfter !== undefined ? minimumDelay : cappedBase;
  const jitter = Math.min(Math.max(0, jitterMaxMs), jitterBase * Math.max(0, jitterRatio)) * random();
  if (retryAfter !== undefined) return minimumDelay + jitter;
  return Math.min(maxDelayMs, minimumDelay + jitter);
}

function buildAttemptTrace(input: {
  phase: LLMAttemptPhase;
  attempt: number;
  started: Date;
  status: LLMAttemptTrace["status"];
  httpStatus?: number;
  rateLimitDelayMs?: number;
  retryAfterMs?: number | undefined;
  retryDelayMs?: number | undefined;
  error?: unknown;
}): LLMAttemptTrace {
  const completed = new Date();
  return {
    phase: input.phase,
    attempt: input.attempt + 1,
    status: input.status,
    started_at: input.started.toISOString(),
    completed_at: completed.toISOString(),
    duration_ms: completed.getTime() - input.started.getTime(),
    ...(input.httpStatus !== undefined ? { http_status: input.httpStatus } : {}),
    ...(input.rateLimitDelayMs !== undefined ? { rate_limit_delay_ms: input.rateLimitDelayMs } : {}),
    ...(input.retryAfterMs !== undefined ? { retry_after_ms: input.retryAfterMs } : {}),
    ...(input.retryDelayMs !== undefined ? { retry_delay_ms: input.retryDelayMs } : {}),
    ...(input.error ? { error_type: errorType(input.error), error_message: safeErrorMessage(input.error) } : {}),
  };
}

function errorType(error: unknown): string {
  if (error instanceof LLMHttpError) return "LLMHttpError";
  if (error instanceof Error) return error.name || "Error";
  return typeof error;
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
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
