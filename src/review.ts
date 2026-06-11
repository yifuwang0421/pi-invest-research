import type { EvidenceItem, ReviewResult, SubagentId, SubagentResult } from "./schemas.js";

type Severity = "critical" | "major" | "minor";

interface ReviewIssue {
  severity: Severity;
  message: string;
}

interface ContractRequirement {
  label: string;
  terms: string[];
}

const SEVERITY_PENALTY: Record<Severity, number> = {
  critical: 30,
  major: 15,
  minor: 6,
};

const CONTRACT_REQUIREMENTS: Record<SubagentId, ContractRequirement[]> = {
  research_evidence: [
    { label: "evidence summary", terms: ["evidence", "source", "证据"] },
    { label: "facts or observations", terms: ["fact", "observation", "事实", "观察"] },
    { label: "data gaps", terms: ["gap", "missing", "数据缺口", "缺口"] },
  ],
  thesis_valuation: [
    { label: "investment thesis", terms: ["thesis", "view", "观点", "投资"] },
    { label: "earnings or valuation assumptions", terms: ["valuation", "earnings", "assumption", "估值", "盈利", "假设"] },
    { label: "scenario or sensitivity", terms: ["scenario", "sensitivity", "情景", "敏感"] },
  ],
  risk_report: [
    { label: "core risks", terms: ["risk", "风险"] },
    { label: "counter-evidence checks", terms: ["counter", "disconfirm", "反证"] },
    { label: "risk triggers", terms: ["trigger", "触发"] },
    { label: "final report summary", terms: ["report", "summary", "报告", "摘要"] },
  ],
};

const GENERIC_TERMS = new Set([
  "agent",
  "analysis",
  "available",
  "claim",
  "complete",
  "conclusion",
  "data",
  "evidence",
  "finding",
  "report",
  "review",
  "summary",
  "公司",
  "分析",
  "研究",
  "证据",
  "可用",
  "引用",
  "进入",
  "汇总",
  "评审",
]);

const POSITIVE_THESIS_TERMS = [
  "buy",
  "bull",
  "positive",
  "upside",
  "undervalued",
  "乐观",
  "低估",
  "上行",
  "买入",
  "改善",
];

const HIGH_RISK_TERMS = [
  "avoid",
  "bear",
  "downside",
  "high risk",
  "negative",
  "高风险",
  "重大风险",
  "下行",
  "回避",
  "负面",
];

export function reviewSubagentResult(result: SubagentResult): ReviewResult {
  return buildReviewResult(result, collectSingleResultIssues(result));
}

export function reviewSubagentResults(results: SubagentResult[]): ReviewResult[] {
  const issueMap = new Map<SubagentId, ReviewIssue[]>();
  for (const result of results) {
    issueMap.set(result.agent_id, collectSingleResultIssues(result));
  }

  for (const issue of collectCrossAgentIssues(results)) {
    issueMap.set(issue.agentId, [...(issueMap.get(issue.agentId) ?? []), issue.issue]);
  }

  return results.map((result) => buildReviewResult(result, issueMap.get(result.agent_id) ?? []));
}

function collectSingleResultIssues(result: SubagentResult): ReviewIssue[] {
  const issues: ReviewIssue[] = [];

  if (!result.summary.trim()) issues.push({ severity: "critical", message: "Missing summary." });
  if (result.findings.length === 0) issues.push({ severity: "critical", message: "Missing structured findings." });

  for (const finding of result.findings) {
    if (!finding.statement.trim()) {
      issues.push({ severity: "major", message: "Finding has an empty statement." });
    }
    if (finding.confidence < 0 || finding.confidence > 1) {
      issues.push({ severity: "major", message: `Finding confidence is outside 0-1: ${finding.statement}` });
    }
    if (!finding.is_assumption && finding.evidence_ids.length === 0) {
      issues.push({ severity: "critical", message: `Factual finding lacks evidence: ${finding.statement}` });
    }

    const citedEvidence = finding.evidence_ids
      .map((id) => result.evidence.find((item) => item.id === id))
      .filter((item): item is EvidenceItem => Boolean(item));
    const missingIds = finding.evidence_ids.filter((id) => !citedEvidence.some((item) => item.id === id));
    if (missingIds.length > 0) {
      issues.push({ severity: "critical", message: `Finding cites missing evidence: ${missingIds.join(", ")}` });
    }
    if (!finding.is_assumption && citedEvidence.length > 0 && !hasEvidenceClaimRelevance(finding.statement, citedEvidence)) {
      issues.push({
        severity: "major",
        message: `Finding is weakly related to cited evidence: ${finding.statement}`,
      });
    }
    if (!finding.is_assumption && finding.confidence >= 0.65 && citedEvidence.length > 0 && !hasHighQualityEvidence(citedEvidence)) {
      issues.push({
        severity: "major",
        message: `High-confidence finding relies on low-quality evidence: ${finding.statement}`,
      });
    }
  }

  for (const evidence of result.evidence) {
    if (!evidence.source_name || !evidence.query || !evidence.as_of || !evidence.retrieved_at) {
      issues.push({ severity: "major", message: `Evidence metadata is incomplete: ${evidence.id}` });
    }
    if (evidence.confidence < 0 || evidence.confidence > 1) {
      issues.push({ severity: "major", message: `Evidence confidence is outside 0-1: ${evidence.id}` });
    }
    if (evidence.quality?.warnings.some((warning) => warning.startsWith("missing:")) && evidence.quality.completeness < 0.6) {
      issues.push({ severity: "major", message: `Evidence schema quality is too low: ${evidence.id}` });
    }
  }

  issues.push(...checkOutputContract(result));
  if (result.confidence < 0.35) issues.push({ severity: "major", message: "Subagent confidence is too low." });
  if (result.needs_revision) issues.push({ severity: "major", message: "Subagent self-marked the result as needing revision." });

  return issues;
}

function checkOutputContract(result: SubagentResult): ReviewIssue[] {
  const text = [
    result.summary,
    ...result.findings.map((finding) => finding.statement),
    ...result.assumptions,
    ...result.open_questions,
  ].join("\n").toLowerCase();

  return CONTRACT_REQUIREMENTS[result.agent_id]
    .filter((requirement) => !requirement.terms.some((term) => text.includes(term.toLowerCase())))
    .map((requirement) => ({
      severity: "major" as const,
      message: `Output contract missing ${requirement.label}.`,
    }));
}

function collectCrossAgentIssues(
  results: SubagentResult[],
): Array<{ agentId: SubagentId; issue: ReviewIssue }> {
  const issues: Array<{ agentId: SubagentId; issue: ReviewIssue }> = [];
  const thesis = results.find((result) => result.agent_id === "thesis_valuation");
  const risk = results.find((result) => result.agent_id === "risk_report");
  if (!risk) return issues;

  const riskText = collectResultText(risk);
  if (thesis) {
    const thesisText = collectResultText(thesis);
    if (containsAny(thesisText, POSITIVE_THESIS_TERMS) && containsAny(riskText, HIGH_RISK_TERMS)) {
      issues.push({
        agentId: "risk_report",
        issue: {
          severity: "major",
          message: "Potential inconsistency: thesis_valuation is positive while risk_report is materially negative.",
        },
      });
    }
    if (!containsAny(riskText, ["thesis", "valuation", "观点", "估值", "反证"])) {
      issues.push({
        agentId: "risk_report",
        issue: {
          severity: "minor",
          message: "Risk report does not show an explicit counter-check against upstream thesis_valuation.",
        },
      });
    }
  }

  return issues;
}

function buildReviewResult(result: SubagentResult, issues: ReviewIssue[]): ReviewResult {
  const score = Math.max(
    0,
    100 - issues.reduce((total, issue) => total + SEVERITY_PENALTY[issue.severity], 0),
  );
  return {
    agent_id: result.agent_id,
    pass: issues.length === 0,
    score,
    issues: issues.map((issue) => `[${issue.severity}] ${issue.message}`),
    ...(issues.length > 0
      ? {
          revision_instruction: `Revise ${result.agent_id}: satisfy its output contract, fix evidence citations, and resolve consistency issues.`,
        }
      : {}),
  };
}

function hasEvidenceClaimRelevance(statement: string, evidence: EvidenceItem[]): boolean {
  const ignoredTerms = new Set(GENERIC_TERMS);
  for (const item of evidence) {
    const target = extractEvidenceTarget(item);
    if (target) {
      for (const term of extractSignalTerms(target, new Set())) ignoredTerms.add(term);
    }
  }

  const claimTerms = extractSignalTerms(statement, ignoredTerms);
  if (claimTerms.size === 0) return false;

  const evidenceText = evidence.map(evidenceToText).join("\n");
  const evidenceTerms = extractSignalTerms(evidenceText, ignoredTerms);
  let overlap = 0;
  for (const term of claimTerms) {
    if (evidenceTerms.has(term)) overlap += 1;
    if (overlap >= 2) return true;
  }
  return overlap >= Math.min(2, claimTerms.size);
}

function hasHighQualityEvidence(evidence: EvidenceItem[]): boolean {
  return evidence.some((item) => {
    const confidence = item.quality?.confidence ?? item.confidence;
    const completeness = item.quality?.completeness ?? 0.7;
    const hasInvalidSchema = item.quality?.warnings.some((warning) => warning.startsWith("missing:")) ?? false;
    return confidence >= 0.55 && completeness >= 0.6 && !hasInvalidSchema;
  });
}

function extractSignalTerms(text: string, ignoredTerms: Set<string>): Set<string> {
  const terms = new Set<string>();
  const normalized = text.toLowerCase();

  for (const match of normalized.matchAll(/[a-z0-9][a-z0-9_-]{2,}/g)) {
    const term = match[0] ?? "";
    if (!ignoredTerms.has(term)) terms.add(term);
  }

  for (const match of normalized.matchAll(/\p{Script=Han}{2,}/gu)) {
    const sequence = match[0] ?? "";
    for (let index = 0; index < sequence.length - 1; index += 1) {
      const term = sequence.slice(index, index + 2);
      if (!ignoredTerms.has(term)) terms.add(term);
    }
  }

  return terms;
}

function evidenceToText(item: EvidenceItem): string {
  return [
    item.source_name,
    item.query,
    item.raw_text ?? "",
    item.raw_ref ?? "",
    stringifyValue(item.value),
  ].join("\n").toLowerCase();
}

function extractEvidenceTarget(item: EvidenceItem): string | undefined {
  if (item.value && typeof item.value === "object" && "target" in item.value) {
    const target = (item.value as { target?: unknown }).target;
    if (typeof target === "string") return target;
  }
  return undefined;
}

function collectResultText(result: SubagentResult): string {
  return [
    result.summary,
    ...result.findings.map((finding) => finding.statement),
    ...result.assumptions,
    ...result.open_questions,
  ].join("\n").toLowerCase();
}

function containsAny(text: string, terms: string[]): boolean {
  const normalized = text.toLowerCase();
  return terms.some((term) => normalized.includes(term.toLowerCase()));
}

function stringifyValue(value: unknown): string {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
