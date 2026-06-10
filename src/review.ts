import type { ReviewResult, SubagentResult } from "./schemas.js";

export function reviewSubagentResult(result: SubagentResult): ReviewResult {
  const issues: string[] = [];

  if (!result.summary.trim()) issues.push("缺少摘要。");
  if (result.findings.length === 0) issues.push("缺少结构化 findings。");

  for (const finding of result.findings) {
    if (!finding.is_assumption && finding.evidence_ids.length === 0) {
      issues.push(`事实判断缺少 evidence: ${finding.statement}`);
    }
    const missingIds = finding.evidence_ids.filter(
      (id) => !result.evidence.some((item) => item.id === id),
    );
    if (missingIds.length > 0) {
      issues.push(`finding 引用了不存在的 evidence: ${missingIds.join(", ")}`);
    }
  }

  for (const evidence of result.evidence) {
    if (!evidence.source_name || !evidence.query || !evidence.as_of || !evidence.retrieved_at) {
      issues.push(`evidence 元数据不完整: ${evidence.id}`);
    }
    if (evidence.confidence < 0 || evidence.confidence > 1) {
      issues.push(`evidence confidence 超出 0-1: ${evidence.id}`);
    }
  }

  if (result.confidence < 0.35) issues.push("子 agent 置信度过低。");
  if (result.needs_revision) issues.push("子 agent 自评需要返工。");

  const score = Math.max(0, 100 - issues.length * 20);
  return {
    agent_id: result.agent_id,
    pass: issues.length === 0,
    score,
    issues,
    ...(issues.length > 0
      ? {
          revision_instruction: `请补齐证据、修正引用并重新提交 ${result.agent_id} 的结构化结果。`,
        }
      : {}),
  };
}
