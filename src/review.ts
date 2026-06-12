import type { EvidenceDomain, EvidenceItem, ReviewResult, SubagentId, SubagentResult } from "./schemas.js";
import { validateStructuredOutput } from "./output-contracts.js";

type Severity = "critical" | "major" | "minor";

interface ReviewIssue {
  severity: Severity;
  message: string;
}

const SEVERITY_PENALTY: Record<Severity, number> = {
  critical: 30,
  major: 15,
  minor: 6,
};
const OTHER_DOMAIN_WARNING_RATIO = 0.5;
const STRUCTURED_CONFIDENCE_MIN = 0.35;
const AGENT_EVIDENCE_DOMAINS: Record<SubagentId, EvidenceDomain[]> = {
  research_evidence: ["quote", "financials", "announcement", "news", "profile", "macro"],
  thesis_valuation: ["quote", "financials", "profile", "macro"],
  risk_report: ["quote", "financials", "announcement", "news"],
};

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
    if (!finding.is_assumption && citedEvidence.length > 0 && !hasAgentDomainEvidence(result.agent_id, citedEvidence)) {
      issues.push({
        severity: "major",
        message: `Finding cites evidence outside ${result.agent_id} domain expectations: ${finding.statement}`,
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
  }

  issues.push(...checkOutputContract(result));
  if (result.confidence < 0.35) issues.push({ severity: "major", message: "Subagent confidence is too low." });
  if (result.needs_revision) issues.push({ severity: "major", message: "Subagent self-marked the result as needing revision." });

  return issues;
}

function checkOutputContract(result: SubagentResult): ReviewIssue[] {
  const issues: ReviewIssue[] = [];
  const structuredOutput = (result as { structured_output?: unknown }).structured_output;
  const contractIssues = validateStructuredOutput(result.agent_id, structuredOutput);
  for (const issue of contractIssues) {
    issues.push({ severity: "major", message: `Structured output contract invalid: ${issue}.` });
  }
  if (contractIssues.length === 0) {
    issues.push(...checkStructuredEvidenceReferences(result));
  }
  return issues;
}

function checkStructuredEvidenceReferences(result: SubagentResult): ReviewIssue[] {
  const issues: ReviewIssue[] = [];
  const evidenceIds = new Set(result.evidence.map((item) => item.id));
  const output = result.structured_output;
  if (!output) return issues;

  if (output.agent_id === "research_evidence") {
    output.fact_table.forEach((fact, index) => {
      checkEvidenceIds(`research_evidence.fact_table[${index}].evidence_ids`, fact.evidence_ids, evidenceIds, {
        allowEmpty: Boolean(fact.is_assumption),
      }, issues);
      if (fact.confidence < STRUCTURED_CONFIDENCE_MIN) {
        issues.push({
          severity: "major",
          message: `research_evidence.fact_table[${index}].confidence is below review threshold.`,
        });
      }
    });
    const factDomains = new Set(output.fact_table.map((fact) => fact.domain).filter((domain) => domain !== "other"));
    const coveredDomains = new Set(output.evidence_coverage.covered_domains);
    const missingCoveredDomains = [...factDomains].filter((domain) => !coveredDomains.has(domain));
    if (missingCoveredDomains.length > 0) {
      issues.push({
        severity: "minor",
        message: `Research evidence coverage omits fact_table domains: ${missingCoveredDomains.join(", ")}.`,
      });
    }
    const otherDomainCount = output.fact_table.filter((fact) => fact.domain === "other").length;
    if (output.fact_table.length > 0 && otherDomainCount / output.fact_table.length > OTHER_DOMAIN_WARNING_RATIO) {
      issues.push({
        severity: "minor",
        message: "Research evidence overuses domain=other; classify facts into specific evidence domains when possible.",
      });
    }
    if (output.data_gaps.length > 0 && output.data_gaps.every((gap) => !hasText(gap.impact))) {
      issues.push({
        severity: "minor",
        message: "Research evidence data gaps do not include impact assessments.",
      });
    }
    return issues;
  }

  if (output.agent_id === "thesis_valuation") {
    output.theses.forEach((thesis, index) => {
      checkEvidenceIds(`thesis_valuation.theses[${index}].evidence_ids`, thesis.evidence_ids, evidenceIds, {}, issues);
      if (thesis.confidence < STRUCTURED_CONFIDENCE_MIN) {
        issues.push({
          severity: "major",
          message: `thesis_valuation.theses[${index}].confidence is below review threshold.`,
        });
      }
    });
    checkEvidenceIds(
      "thesis_valuation.valuation_framework.evidence_ids",
      output.valuation_framework.evidence_ids,
      evidenceIds,
      { allowEmpty: output.valuation_framework.valuation_view === "insufficient_data" },
      issues,
    );
    output.scenario_variables.forEach((variable, index) => {
      checkEvidenceIds(
        `thesis_valuation.scenario_variables[${index}].evidence_ids`,
        variable.evidence_ids,
        evidenceIds,
        {},
        issues,
      );
    });
    const valuationView = output.valuation_framework.valuation_view;
    if (valuationView === "overvalued" && output.theses.some((thesis) => thesis.direction === "bullish")) {
      issues.push({
        severity: "minor",
        message: "Thesis direction is bullish while valuation_view is overvalued.",
      });
    }
    if (valuationView === "undervalued" && output.theses.some((thesis) => thesis.direction === "bearish")) {
      issues.push({
        severity: "minor",
        message: "Thesis direction is bearish while valuation_view is undervalued.",
      });
    }
    return issues;
  }

  const allowRiskWithoutEvidence = output.final_summary.stance === "insufficient_data";
  output.counter_evidence.forEach((item, index) => {
    checkEvidenceIds(`risk_report.counter_evidence[${index}].evidence_ids`, item.evidence_ids, evidenceIds, {
      allowEmpty: allowRiskWithoutEvidence,
    }, issues);
  });
  output.risk_triggers.forEach((trigger, index) => {
    checkEvidenceIds(`risk_report.risk_triggers[${index}].evidence_ids`, trigger.evidence_ids, evidenceIds, {
      allowEmpty: allowRiskWithoutEvidence,
    }, issues);
    if (
      trigger.derived_from_counter_evidence_index !== undefined &&
      trigger.derived_from_counter_evidence_index >= output.counter_evidence.length
    ) {
      issues.push({
        severity: "major",
        message: `risk_report.risk_triggers[${index}].derived_from_counter_evidence_index points outside counter_evidence.`,
      });
    }
  });
  const upstreamReferences = output.final_summary.upstream_references;
  const severities = output.counter_evidence.map((item) => item.severity);
  if (output.final_summary.stance === "negative" && severities.length > 0 && severities.every((severity) => severity === "low")) {
    issues.push({
      severity: "minor",
      message: "Risk final_summary stance is negative while all counter_evidence severity values are low.",
    });
  }
  if (output.final_summary.stance === "positive" && severities.some((severity) => severity === "high")) {
    issues.push({
      severity: "minor",
      message: "Risk final_summary stance is positive despite high-severity counter_evidence.",
    });
  }
  if (
    upstreamReferences.research_evidence_fact_indices.length === 0 &&
    upstreamReferences.thesis_indices.length === 0 &&
    output.final_summary.stance !== "insufficient_data"
  ) {
    issues.push({
      severity: "minor",
      message: "Risk final_summary does not explicitly reference upstream research_evidence facts or thesis_valuation theses.",
    });
  }
  return issues;
}

function checkEvidenceIds(
  path: string,
  ids: string[],
  evidenceIds: Set<string>,
  options: { allowEmpty?: boolean },
  issues: ReviewIssue[],
): void {
  if (ids.length === 0 && !options.allowEmpty) {
    issues.push({ severity: "critical", message: `${path} must cite at least one evidence id.` });
    return;
  }
  const missingIds = ids.filter((id) => !evidenceIds.has(id));
  if (missingIds.length > 0) {
    issues.push({ severity: "critical", message: `${path} cites missing evidence: ${missingIds.join(", ")}.` });
  }
}

function hasText(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function hasAgentDomainEvidence(agentId: SubagentId, evidence: EvidenceItem[]): boolean {
  const allowedDomains = new Set(AGENT_EVIDENCE_DOMAINS[agentId]);
  return evidence.some((item) => item.domain !== undefined && allowedDomains.has(item.domain));
}

function collectCrossAgentIssues(
  results: SubagentResult[],
): Array<{ agentId: SubagentId; issue: ReviewIssue }> {
  const issues: Array<{ agentId: SubagentId; issue: ReviewIssue }> = [];
  const research = results.find((result) => result.agent_id === "research_evidence");
  const thesis = results.find((result) => result.agent_id === "thesis_valuation");
  const risk = results.find((result) => result.agent_id === "risk_report");
  if (!risk) return issues;

  const researchOutput = research?.structured_output;
  const thesisOutput = thesis?.structured_output;
  const riskOutput = risk.structured_output;
  if (riskOutput?.agent_id === "risk_report") {
    const upstreamReferences = riskOutput.final_summary.upstream_references;
    if (researchOutput?.agent_id === "research_evidence") {
      const invalidFactIndices = upstreamReferences.research_evidence_fact_indices.filter(
        (index) => index < 0 || index >= researchOutput.fact_table.length,
      );
      if (invalidFactIndices.length > 0) {
        issues.push({
          agentId: "risk_report",
          issue: {
            severity: "major",
            message: `Risk final_summary references missing research_evidence fact indices: ${invalidFactIndices.join(", ")}.`,
          },
        });
      }
    } else if (upstreamReferences.research_evidence_fact_indices.length > 0) {
      issues.push({
        agentId: "risk_report",
        issue: {
          severity: "major",
          message: "Risk final_summary references research_evidence facts but no structured research_evidence output is available.",
        },
      });
    }

    if (thesisOutput?.agent_id === "thesis_valuation") {
      const invalidThesisIndices = upstreamReferences.thesis_indices.filter(
        (index) => index < 0 || index >= thesisOutput.theses.length,
      );
      if (invalidThesisIndices.length > 0) {
        issues.push({
          agentId: "risk_report",
          issue: {
            severity: "major",
            message: `Risk final_summary references missing thesis_valuation thesis indices: ${invalidThesisIndices.join(", ")}.`,
          },
        });
      }
    } else if (upstreamReferences.thesis_indices.length > 0) {
      issues.push({
        agentId: "risk_report",
        issue: {
          severity: "major",
          message: "Risk final_summary references thesis_valuation theses but no structured thesis_valuation output is available.",
        },
      });
    }
  }

  if (thesis) {
    const hasPositiveThesis =
      thesisOutput?.agent_id === "thesis_valuation"
        ? thesisOutput.theses.some((item) => item.direction === "bullish")
        : false;
    const hasMaterialNegativeRisk =
      riskOutput?.agent_id === "risk_report"
        ? riskOutput.final_summary.stance === "negative" ||
          riskOutput.counter_evidence.some((item) => item.severity === "high")
        : false;
    if (hasPositiveThesis && hasMaterialNegativeRisk) {
      issues.push({
        agentId: "risk_report",
        issue: {
          severity: "major",
          message: "Potential inconsistency: thesis_valuation is positive while risk_report is materially negative.",
        },
      });
    }
    if (riskOutput?.agent_id === "risk_report" && riskOutput.counter_evidence.length === 0) {
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
