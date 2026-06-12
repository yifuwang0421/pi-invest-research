import type { FinalReport, ResearchPlan, ReviewResult, SubagentExecutionTrace, SubagentResult } from "./schemas.js";
import { dedupeEvidence, EVIDENCE_SCHEMA_VERSION } from "./evidence.js";
import { SUBAGENT_PROFILES } from "./subagents.js";

export function buildMarkdownReport(
  plan: ResearchPlan,
  subagentResults: SubagentResult[],
  reviews: ReviewResult[],
): string {
  const evidence = dedupeEvidence(subagentResults.flatMap((result) => result.evidence));
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

  lines.push("", "## Structured Agent Outputs", "");
  for (const result of subagentResults) {
    const output = result.structured_output;
    if (!output) continue;
    if (output.agent_id === "research_evidence") {
      lines.push(`### ${SUBAGENT_PROFILES[result.agent_id].name} - Fact Table`, "");
      for (const fact of output.fact_table) {
        const suffix = fact.evidence_ids.length > 0 ? ` (evidence: ${fact.evidence_ids.join(", ")})` : " (assumption)";
        lines.push(`- [${fact.domain}] ${fact.fact}${suffix}`);
      }
      if (output.data_gaps.length > 0) {
        lines.push("", "Data gaps:");
        for (const gap of output.data_gaps) lines.push(`- ${gap.topic}: ${gap.reason}`);
      }
      lines.push("");
    }

    if (output.agent_id === "thesis_valuation") {
      lines.push(`### ${SUBAGENT_PROFILES[result.agent_id].name} - Thesis And Valuation`, "");
      for (const thesis of output.theses) {
        lines.push(`- [${thesis.direction}] ${thesis.statement} (evidence: ${thesis.evidence_ids.join(", ") || "none"})`);
      }
      lines.push(
        `- Valuation framework: ${output.valuation_framework.method}; ${output.valuation_framework.valuation_view}`,
      );
      for (const variable of output.scenario_variables) {
        lines.push(`- Scenario variable: ${variable.name} | base=${variable.base} | bull=${variable.bull} | bear=${variable.bear}`);
      }
      lines.push("");
    }

    if (output.agent_id === "risk_report") {
      lines.push(`### ${SUBAGENT_PROFILES[result.agent_id].name} - Risk And Counter Evidence`, "");
      lines.push(`- Final stance: ${output.final_summary.stance}`);
      for (const item of output.counter_evidence) {
        lines.push(`- Counter-evidence [${item.severity}]: ${item.claim_challenged} -> ${item.counterpoint}`);
      }
      for (const trigger of output.risk_triggers) {
        const threshold = trigger.threshold ? `; threshold=${trigger.threshold}` : "";
        lines.push(`- Trigger: ${trigger.trigger}; metric/event=${trigger.metric_or_event}${threshold}`);
      }
      lines.push("");
    }
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
  const normalizedSubagentResults = canonicalizeSubagentEvidence(subagentResults);
  const evidenceLedger = dedupeEvidence(normalizedSubagentResults.flatMap((result) => result.evidence));
  return {
    evidence_schema_version: EVIDENCE_SCHEMA_VERSION,
    target: plan.target,
    task_type: plan.normalized_request.task_type,
    selected_agents: plan.selected_agents,
    markdown: buildMarkdownReport(plan, normalizedSubagentResults, reviewResults),
    evidence_ledger: evidenceLedger,
    data_gaps: normalizedSubagentResults.flatMap((result) => result.data_gaps),
    review_results: reviewResults,
    trace: {
      plan,
      subagent_results: normalizedSubagentResults,
      delegation_executions: delegationExecutions,
    },
  };
}

function canonicalizeSubagentEvidence(results: SubagentResult[]): SubagentResult[] {
  const allEvidence = results.flatMap((result) => result.evidence);
  const canonicalEvidence = dedupeEvidence(allEvidence);
  const canonicalByKey = new Map(canonicalEvidence.map((item) => [item.quality?.dedupe_key ?? item.id, item]));
  const canonicalIdByOriginalId = new Map<string, string>();

  for (const item of allEvidence) {
    const key = item.quality?.dedupe_key ?? item.id;
    canonicalIdByOriginalId.set(item.id, canonicalByKey.get(key)?.id ?? item.id);
  }

  return results.map((result) => {
    const evidenceById = new Map<string, SubagentResult["evidence"][number]>();
    for (const item of result.evidence) {
      const key = item.quality?.dedupe_key ?? item.id;
      const canonical = canonicalByKey.get(key) ?? item;
      evidenceById.set(canonical.id, canonical);
    }

    return {
      ...result,
      evidence: [...evidenceById.values()],
      findings: result.findings.map((finding) => ({
        ...finding,
        evidence_ids: [...new Set(finding.evidence_ids.map((id) => canonicalIdByOriginalId.get(id) ?? id))],
      })),
      ...(result.structured_output
        ? { structured_output: canonicalizeStructuredOutputEvidenceIds(result.structured_output, canonicalIdByOriginalId) }
        : {}),
    };
  });
}

function canonicalizeStructuredOutputEvidenceIds(
  output: NonNullable<SubagentResult["structured_output"]>,
  canonicalIdByOriginalId: Map<string, string>,
): NonNullable<SubagentResult["structured_output"]> {
  const mapIds = (ids: string[]) => [...new Set(ids.map((id) => canonicalIdByOriginalId.get(id) ?? id))];
  if (output.agent_id === "research_evidence") {
    return {
      ...output,
      fact_table: output.fact_table.map((fact) => ({ ...fact, evidence_ids: mapIds(fact.evidence_ids) })),
    };
  }
  if (output.agent_id === "thesis_valuation") {
    return {
      ...output,
      theses: output.theses.map((thesis) => ({ ...thesis, evidence_ids: mapIds(thesis.evidence_ids) })),
      valuation_framework: {
        ...output.valuation_framework,
        evidence_ids: mapIds(output.valuation_framework.evidence_ids),
      },
      scenario_variables: output.scenario_variables.map((variable) => ({
        ...variable,
        evidence_ids: mapIds(variable.evidence_ids),
      })),
    };
  }
  return {
    ...output,
    counter_evidence: output.counter_evidence.map((item) => ({ ...item, evidence_ids: mapIds(item.evidence_ids) })),
    risk_triggers: output.risk_triggers.map((trigger) => ({ ...trigger, evidence_ids: mapIds(trigger.evidence_ids) })),
  };
}
