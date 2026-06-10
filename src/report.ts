import type { FinalReport, ResearchPlan, ReviewResult, SubagentExecutionTrace, SubagentResult } from "./schemas.js";
import { SUBAGENT_PROFILES } from "./subagents.js";

export function buildMarkdownReport(
  plan: ResearchPlan,
  subagentResults: SubagentResult[],
  reviews: ReviewResult[],
): string {
  const evidence = subagentResults.flatMap((result) => result.evidence);
  const dataGaps = subagentResults.flatMap((result) => result.data_gaps);
  const findings = subagentResults.flatMap((result) =>
    result.findings.map((finding) => ({ ...finding, agent_id: result.agent_id })),
  );
  const assumptions = subagentResults.flatMap((result) => result.assumptions);

  const lines: string[] = [
    `# ${plan.target} 投研分析报告`,
    "",
    "## 研究对象",
    "",
    `- 标的：${plan.target}`,
    `- 任务类型：${plan.normalized_request.task_type}`,
    `- 市场：${plan.normalized_request.market ?? "unknown"}`,
    `- 调用子 agent：${plan.selected_agents.map((agent) => SUBAGENT_PROFILES[agent].name).join("、")}`,
    `- 证据条目：${evidence.length}`,
    `- 数据缺口：${dataGaps.length}`,
    "",
    "## 核心结论",
    "",
  ];

  if (findings.length === 0) {
    lines.push("- 暂无可用结论。");
  } else {
    for (const finding of findings) {
      const evidenceSuffix =
        finding.evidence_ids.length > 0 ? `（证据：${finding.evidence_ids.join(", ")}）` : "（假设，待证实）";
      lines.push(`- [${SUBAGENT_PROFILES[finding.agent_id].name}] ${finding.statement}${evidenceSuffix}`);
    }
  }

  lines.push("", "## 三段式 agent 摘要", "");
  for (const result of subagentResults) {
    lines.push(`- **${SUBAGENT_PROFILES[result.agent_id].name}**：${result.summary}`);
  }

  lines.push("", "## 证据表", "");
  if (evidence.length === 0) {
    lines.push("- 暂无可用证据。");
  } else {
    lines.push("| ID | 来源 | 日期 | 查询 | 置信度 |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const item of evidence) {
      lines.push(`| ${item.id} | ${item.source_name} | ${item.as_of} | ${item.query} | ${item.confidence.toFixed(2)} |`);
    }
  }

  lines.push("", "## 关键假设", "");
  if (assumptions.length === 0) {
    lines.push("- 暂无额外假设。");
  } else {
    for (const assumption of assumptions) lines.push(`- ${assumption}`);
  }

  lines.push("", "## 风险与数据缺口", "");
  if (dataGaps.length === 0) {
    lines.push("- 未发现阻断性数据缺口。");
  } else {
    for (const gap of dataGaps) {
      lines.push(`- ${gap.source_name}: ${gap.query} -> ${gap.reason}`);
    }
  }

  lines.push("", "## 评审结果", "");
  for (const review of reviews) {
    const label = review.pass ? "PASS" : "NEEDS_REVISION";
    const issues = review.issues.length > 0 ? `；问题：${review.issues.join("；")}` : "";
    lines.push(`- ${SUBAGENT_PROFILES[review.agent_id].name}: ${label} (${review.score})${issues}`);
  }

  lines.push(
    "",
    "## 下一步建议",
    "",
    "- 对低置信度或数据缺口较多的结论补充真实数据源交叉验证。",
    "- 若用于正式投资决策，应补充财务模型、估值敏感性和风险触发条件。",
  );

  return lines.join("\n");
}

export function buildFinalReport(
  plan: ResearchPlan,
  subagentResults: SubagentResult[],
  reviewResults: ReviewResult[],
  delegationExecutions: SubagentExecutionTrace[] = [],
): FinalReport {
  return {
    target: plan.target,
    task_type: plan.normalized_request.task_type,
    selected_agents: plan.selected_agents,
    markdown: buildMarkdownReport(plan, subagentResults, reviewResults),
    evidence_ledger: subagentResults.flatMap((result) => result.evidence),
    data_gaps: subagentResults.flatMap((result) => result.data_gaps),
    review_results: reviewResults,
    trace: {
      plan,
      subagent_results: subagentResults,
      delegation_executions: delegationExecutions,
    },
  };
}
