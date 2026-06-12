import { createHeuristicLLMAdapter, createOpenAICompatibleLLMAdapter } from "./llm.js";
import type { OpenAICompatibleLLMOptions } from "./llm.js";
import { buildFinalReport } from "./report.js";
import { reviewSubagentResults } from "./review.js";
import type {
  DelegationPolicy,
  EvidenceProvider,
  FinalReport,
  LLMAdapter,
  NormalizedResearchRequest,
  ResearchDataAdapters,
  ResearchPlan,
  ResearchRequest,
  SubagentExecutionTrace,
  SubagentId,
  SubagentResult,
  SubagentTask,
  TaskType,
} from "./schemas.js";
import {
  collectEvidenceForTask,
  createEvidenceProviders,
  requiredEvidenceFor,
} from "./sources.js";
import { createFallbackStructuredOutput, describeOutputContract } from "./output-contracts.js";
import { SUBAGENT_PROFILES } from "./subagents.js";
import { normalizeResearchRequest } from "./target-parser.js";

const FULL_RESEARCH_AGENTS: SubagentId[] = ["research_evidence", "thesis_valuation", "risk_report"];
const EVIDENCE_AND_RISK_AGENTS: SubagentId[] = ["research_evidence", "risk_report"];
const DEFAULT_MAX_CONCURRENT_SUBAGENTS = 3;
const DEFAULT_MAX_SPAWN_DEPTH = 1;
const DEFAULT_LLM_TIMEOUT_MS = 120_000;

export interface OrchestratorOptions {
  adapters?: ResearchDataAdapters;
  evidenceProviders?: EvidenceProvider[];
  llmAdapter?: LLMAdapter;
  llmTimeoutMs?: number;
  signal?: AbortSignal;
  skillTextByAgent?: Partial<Record<SubagentId, string>>;
  delegation?: Partial<Pick<DelegationPolicy, "max_concurrency" | "max_spawn_depth" | "allow_nested_orchestrators">>;
}

export async function investResearch(
  input: ResearchRequest,
  options: OrchestratorOptions = {},
): Promise<FinalReport | { clarification_question: string }> {
  const plan = buildResearchPlan(input);
  if (plan.clarification_question) {
    return { clarification_question: plan.clarification_question };
  }

  const providers = options.evidenceProviders ?? createDefaultEvidenceProviders(input, options);
  const llmAdapter = options.llmAdapter ?? createDefaultLLMAdapter(input);
  const delegated = await runDelegatedSubagentBatch(
    plan.tasks,
    providers,
    llmAdapter,
    plan.normalized_request,
    options.skillTextByAgent ?? {},
    options.delegation?.max_concurrency ?? plan.delegation_policy.max_concurrency,
    options.llmTimeoutMs ?? DEFAULT_LLM_TIMEOUT_MS,
    options.signal,
  );

  const reviews = reviewSubagentResults(delegated.results);
  const revisedResults = delegated.results.map((result, index) => {
    const review = reviews[index];
    if (!review || review.pass) return result;
    return {
      ...result,
      needs_revision: true,
      open_questions: [...result.open_questions, ...(review.revision_instruction ? [review.revision_instruction] : [])],
    };
  });

  return buildFinalReport(plan, revisedResults, reviewSubagentResults(revisedResults), delegated.executions);
}

export function buildResearchPlan(input: ResearchRequest): ResearchPlan {
  const normalized = normalizeResearchRequest(input);
  if (!normalized.target) {
    return {
      normalized_request: normalized,
      target: "",
      selected_agents: [],
      tasks: [],
      delegation_policy: buildDelegationPolicy(0),
      clarification_question: "请告诉我需要研究的具体标的、行业或宏观指标。",
    };
  }

  const selected_agents = selectSubagents(normalized.task_type, normalized.request);
  const tasks = selected_agents.map((agent_id) =>
    buildSubagentTask(agent_id, normalized.target!, normalized.task_type, selected_agents),
  );
  return {
    normalized_request: normalized,
    target: normalized.target,
    selected_agents,
    tasks,
    delegation_policy: buildDelegationPolicy(tasks.length),
  };
}

export function selectSubagents(taskType: TaskType, request: string): SubagentId[] {
  if (taskType === "technical_review") return EVIDENCE_AND_RISK_AGENTS;
  if (taskType === "risk_review") return EVIDENCE_AND_RISK_AGENTS;
  if (taskType === "valuation") return FULL_RESEARCH_AGENTS;
  if (taskType === "news_event") return FULL_RESEARCH_AGENTS;
  if (taskType === "deep_research") return FULL_RESEARCH_AGENTS;
  return EVIDENCE_AND_RISK_AGENTS;
}

export function buildSubagentTask(
  agent_id: SubagentId,
  target: string,
  task_type: TaskType,
  selectedAgents: SubagentId[] = [agent_id],
): SubagentTask {
  const profile = SUBAGENT_PROFILES[agent_id];
  const depends_on = dependenciesFor(agent_id, selectedAgents);
  return {
    agent_id,
    target,
    task_type,
    role: "leaf",
    depends_on,
    task: `${profile.name}: 围绕 ${target} 完成 ${profile.role}`,
    required_evidence: requiredEvidenceFor(agent_id),
    allowed_skills: profile.skills,
    allowed_toolsets: ["evidence", "llm"],
    result_contract: profile.output_contract,
    delegation_context: buildStaticDelegationContext(agent_id, target, task_type, depends_on),
    isolation: {
      fresh_context: true,
      memory_access: "blocked",
      user_interaction: "blocked",
      side_effects: "blocked",
      terminal_session: "dedicated",
      workspace: "dedicated",
    },
  };
}

export async function runSubagentTask(
  task: SubagentTask,
  providers: EvidenceProvider[],
  llmAdapter: LLMAdapter,
  normalizedRequest: NormalizedResearchRequest,
  skillText: string,
  upstreamResults: SubagentResult[] = [],
  llmTimeoutMs = DEFAULT_LLM_TIMEOUT_MS,
  parentSignal?: AbortSignal,
): Promise<SubagentResult> {
  let evidenceResult: Awaited<ReturnType<typeof collectEvidenceForTask>>;
  try {
    evidenceResult = await collectEvidenceForTask(task, providers);
  } catch (error) {
    const occurredAt = new Date().toISOString();
    return createLLMErrorResult(task, [], [
      {
        source_name: "source-provider",
        query: task.task,
        reason: error instanceof Error ? error.message : String(error),
        occurred_at: occurredAt,
      },
    ]);
  }

  const timeout = createTimeoutSignal(llmTimeoutMs, parentSignal);
  try {
    const request = {
      normalized_request: normalizedRequest,
      task,
      evidence: evidenceResult.evidence,
      data_gaps: evidenceResult.data_gaps,
      skill_text: skillText,
      delegation_context: buildRuntimeDelegationContext(task, normalizedRequest, upstreamResults),
      upstream_results: upstreamResults.map((result) => ({
        agent_id: result.agent_id,
        summary: result.summary,
        findings: result.findings,
        data_gaps: result.data_gaps,
        ...(result.structured_output ? { structured_output: result.structured_output } : {}),
        needs_revision: result.needs_revision,
      })),
      ...(timeout.signal ? { signal: timeout.signal } : {}),
    };
    return await withTimeout(
      llmAdapter.generateSubagentResult(request),
      llmTimeoutMs,
      timeout,
    );
  } catch (error) {
    const occurredAt = new Date().toISOString();
    return createLLMErrorResult(task, evidenceResult.evidence, [
      ...evidenceResult.data_gaps,
      {
        source_name: "llm",
        query: task.task,
        reason: error instanceof Error ? error.message : String(error),
        occurred_at: occurredAt,
      },
    ]);
  } finally {
    timeout.cleanup();
  }
}

export async function runDelegatedSubagentBatch(
  tasks: SubagentTask[],
  providers: EvidenceProvider[],
  llmAdapter: LLMAdapter,
  normalizedRequest: NormalizedResearchRequest,
  skillTextByAgent: Partial<Record<SubagentId, string>> = {},
  maxConcurrency = DEFAULT_MAX_CONCURRENT_SUBAGENTS,
  llmTimeoutMs = DEFAULT_LLM_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<{ results: SubagentResult[]; executions: SubagentExecutionTrace[] }> {
  const pending = new Map(tasks.map((task, index) => [task.agent_id, { task, index }]));
  const completed = new Map<SubagentId, SubagentResult>();
  const executions: SubagentExecutionTrace[] = [];
  const concurrency = Math.max(1, Math.floor(maxConcurrency));

  while (pending.size > 0) {
    const ready = [...pending.values()].filter(({ task }) => task.depends_on.every((agentId) => completed.has(agentId)));
    if (ready.length === 0) {
      throw new Error(`Subagent dependency cycle or missing dependency: ${[...pending.keys()].join(", ")}`);
    }

    const stage = await runReadySubagentStage(
      ready,
      concurrency,
      providers,
      llmAdapter,
      normalizedRequest,
      skillTextByAgent,
      completed,
      llmTimeoutMs,
      signal,
    );

    for (const item of stage) {
      completed.set(item.task.agent_id, item.result);
      pending.delete(item.task.agent_id);
      executions.push(item.execution);
    }
  }

  return {
    results: tasks.map((task) => completed.get(task.agent_id)).filter((result): result is SubagentResult => Boolean(result)),
    executions: executions.sort((a, b) => a.task_index - b.task_index),
  };
}

function dependenciesFor(agentId: SubagentId, selectedAgents: SubagentId[]): SubagentId[] {
  if (agentId === "risk_report") {
    return selectedAgents.filter((id) => id !== "risk_report");
  }
  return [];
}

function createDefaultEvidenceProviders(input: ResearchRequest, options: OrchestratorOptions): EvidenceProvider[] {
  const sources = input.sources ?? (input.use_live_ifind === false ? [] : ["ifind"]);
  return createEvidenceProviders(sources, options.adapters ? { ifindAdapter: options.adapters } : {});
}

function createDefaultLLMAdapter(input: ResearchRequest): LLMAdapter {
  if (process.env.OPENAI_API_KEY) {
    const llmOptions: OpenAICompatibleLLMOptions = {};
    if (input.llm?.base_url) llmOptions.baseUrl = input.llm.base_url;
    if (input.llm?.model) llmOptions.model = input.llm.model;
    return createOpenAICompatibleLLMAdapter(llmOptions);
  }
  return createHeuristicLLMAdapter();
}

function buildDelegationPolicy(taskCount: number): DelegationPolicy {
  return {
    mode: taskCount <= 1 ? "single" : "batch",
    max_concurrency: DEFAULT_MAX_CONCURRENT_SUBAGENTS,
    max_spawn_depth: DEFAULT_MAX_SPAWN_DEPTH,
    allow_nested_orchestrators: false,
    summary_only: true,
  };
}

function buildStaticDelegationContext(
  agentId: SubagentId,
  target: string,
  taskType: TaskType,
  dependsOn: SubagentId[],
): string {
  const profile = SUBAGENT_PROFILES[agentId];
  const dependencyLine =
    dependsOn.length > 0
      ? `依赖上游子 agent：${dependsOn.map((id) => SUBAGENT_PROFILES[id].name).join("、")}。`
      : "无上游依赖，可独立并行执行。";
  return [
    "你是被父级投研 agent 委托的隔离子 agent。",
    `父任务：${target} / ${taskType}。`,
    `你的边界：${profile.boundaries.join("；")}。`,
    `返回契约：${describeOutputContract(profile.output_contract)}。`,
    dependencyLine,
    "你拥有独立上下文、独立终端会话和独立工作区标识；不能读取父会话历史，不能向用户追问，不能写共享记忆，不能产生外部副作用。",
    "只返回结构化摘要和可验证 evidence_ids；父 agent 负责最终合成与复核。",
  ].join("\n");
}

function buildRuntimeDelegationContext(
  task: SubagentTask,
  normalizedRequest: NormalizedResearchRequest,
  upstreamResults: SubagentResult[],
): string {
  const upstreamContext =
    upstreamResults.length === 0
      ? "当前没有上游子 agent 结果。"
      : upstreamResults
          .map((result) => {
            const profile = SUBAGENT_PROFILES[result.agent_id];
            const findings = result.findings.map((finding) => `- ${finding.statement}`).join("\n");
            return `上游 ${profile.name} 摘要：${result.summary}\n${findings || "- 无可用结论。"}`;
          })
          .join("\n\n");

  return [
    task.delegation_context,
    "",
    `用户原始请求：${normalizedRequest.request}`,
    "输出语言：中文。",
    "",
    "上游结果：",
    upstreamContext,
  ].join("\n");
}

async function runReadySubagentStage(
  ready: Array<{ task: SubagentTask; index: number }>,
  maxConcurrency: number,
  providers: EvidenceProvider[],
  llmAdapter: LLMAdapter,
  normalizedRequest: NormalizedResearchRequest,
  skillTextByAgent: Partial<Record<SubagentId, string>>,
  completed: Map<SubagentId, SubagentResult>,
  llmTimeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<Array<{ task: SubagentTask; result: SubagentResult; execution: SubagentExecutionTrace }>> {
  const output: Array<{ task: SubagentTask; result: SubagentResult; execution: SubagentExecutionTrace }> = [];
  let cursor = 0;
  const workerCount = Math.min(maxConcurrency, ready.length);

  async function worker(): Promise<void> {
    while (cursor < ready.length) {
      const item = ready[cursor++];
      if (!item) continue;
      const upstreamResults = item.task.depends_on
        .map((agentId) => completed.get(agentId))
        .filter((result): result is SubagentResult => Boolean(result));
      output.push(
        await runTracedSubagentTask(
          item.task,
          item.index,
          providers,
          llmAdapter,
          normalizedRequest,
          skillTextByAgent[item.task.agent_id] ?? "",
          upstreamResults,
          llmTimeoutMs,
          signal,
        ),
      );
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return output;
}

async function runTracedSubagentTask(
  task: SubagentTask,
  taskIndex: number,
  providers: EvidenceProvider[],
  llmAdapter: LLMAdapter,
  normalizedRequest: NormalizedResearchRequest,
  skillText: string,
  upstreamResults: SubagentResult[],
  llmTimeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<{ task: SubagentTask; result: SubagentResult; execution: SubagentExecutionTrace }> {
  const started = new Date();
  const executionIds = buildExecutionIds(task.agent_id, taskIndex);
  try {
    const result = await runSubagentTask(
      task,
      providers,
      llmAdapter,
      normalizedRequest,
      skillText,
      upstreamResults,
      llmTimeoutMs,
      signal,
    );
    const completed = new Date();
    return {
      task,
      result,
      execution: {
        task_index: taskIndex,
        agent_id: task.agent_id,
        role: task.role,
        status: "completed",
        started_at: started.toISOString(),
        completed_at: completed.toISOString(),
        duration_ms: completed.getTime() - started.getTime(),
        evidence_count: result.evidence.length,
        data_gap_count: result.data_gaps.length,
        upstream_agents: task.depends_on,
        ...executionIds,
      },
    };
  } catch (error) {
    const completed = new Date();
    const result = createLLMErrorResult(task, [], [
      {
        source_name: "orchestrator",
        query: task.task,
        reason: error instanceof Error ? error.message : String(error),
        occurred_at: completed.toISOString(),
      },
    ]);
    return {
      task,
      result,
      execution: {
        task_index: taskIndex,
        agent_id: task.agent_id,
        role: task.role,
        status: "failed",
        started_at: started.toISOString(),
        completed_at: completed.toISOString(),
        duration_ms: completed.getTime() - started.getTime(),
        evidence_count: 0,
        data_gap_count: result.data_gaps.length,
        upstream_agents: task.depends_on,
        error: error instanceof Error ? error.message : String(error),
        ...executionIds,
      },
    };
  }
}

function buildExecutionIds(agentId: SubagentId, taskIndex: number): Pick<
  SubagentExecutionTrace,
  "context_id" | "terminal_session_id" | "workspace_id"
> {
  const ordinal = String(taskIndex + 1).padStart(2, "0");
  return {
    context_id: `ctx-${ordinal}-${agentId}`,
    terminal_session_id: `term-${ordinal}-${agentId}`,
    workspace_id: `workspace-${ordinal}-${agentId}`,
  };
}

function createTimeoutSignal(
  timeoutMs: number,
  parentSignal?: AbortSignal,
): { signal?: AbortSignal; cleanup: () => void } {
  if (timeoutMs <= 0) {
    return parentSignal ? { signal: parentSignal, cleanup: () => undefined } : { cleanup: () => undefined };
  }

  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const abortFromParent = () => controller.abort(parentSignal?.reason ?? new Error("Parent signal aborted."));
  if (parentSignal?.aborted) {
    abortFromParent();
  } else {
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
    timeout = setTimeout(() => {
      controller.abort(new Error(`LLM subagent timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      if (timeout) clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", abortFromParent);
    },
  };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeout: { signal?: AbortSignal },
): Promise<T> {
  if (timeoutMs <= 0 || !timeout.signal) return promise;
  if (timeout.signal.aborted) throw timeout.signal.reason ?? new Error("LLM subagent aborted.");

  return await Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timeout.signal?.addEventListener(
        "abort",
        () => reject(timeout.signal?.reason ?? new Error("LLM subagent aborted.")),
        { once: true },
      );
    }),
  ]);
}

function createLLMErrorResult(
  task: SubagentTask,
  evidence: SubagentResult["evidence"],
  dataGaps: SubagentResult["data_gaps"],
): SubagentResult {
  const profile = SUBAGENT_PROFILES[task.agent_id];
  const evidenceIds = evidence.slice(0, 2).map((item) => item.id);
  return {
    agent_id: task.agent_id,
    task: task.task,
    summary: `${profile.name}未能完成 LLM 结构化生成，已记录为数据缺口。`,
    findings: [
      {
        statement: `${task.target} 的${profile.name}结论需要在 LLM 恢复后重新生成。`,
        evidence_ids: evidenceIds,
        confidence: evidenceIds.length > 0 ? 0.35 : 0.2,
        is_assumption: true,
      },
    ],
    evidence,
    assumptions: [`${task.agent_id} 的分析结果由错误兜底生成，不应作为正式结论。`],
    open_questions: ["LLM 调用失败或输出结构无效，需要重新运行。"],
    confidence: 0.25,
    data_gaps: dataGaps,
    structured_output: createFallbackStructuredOutput({
      agent_id: task.agent_id,
      target: task.target,
      evidence,
      data_gaps: dataGaps,
    }),
    needs_revision: true,
  };
}
