import type {
  DataGap,
  EvidenceDomain,
  EvidenceItem,
  Finding,
  ResearchEvidenceDataGap,
  ResearchEvidenceFact,
  RiskSeverity,
  RiskStance,
  SubagentId,
  SubagentOutputContract,
  SubagentStructuredOutput,
  ThesisDirection,
  ValuationView,
} from "./schemas.js";

export const SUBAGENT_OUTPUT_SCHEMA_VERSION = "subagent-output.v1" as const;

export const SUBAGENT_OUTPUT_CONTRACTS: { [TAgent in SubagentId]: SubagentOutputContract<TAgent> } = {
  research_evidence: {
    schema_version: SUBAGENT_OUTPUT_SCHEMA_VERSION,
    agent_id: "research_evidence",
    description: "Produce a machine-readable fact table, explicit data gaps, and evidence coverage.",
    required_fields: ["fact_table", "data_gaps", "evidence_coverage"],
    example_shape: {
      schema_version: SUBAGENT_OUTPUT_SCHEMA_VERSION,
      agent_id: "research_evidence",
      fact_table: [
        {
          fact: "string",
          domain: "financials",
          evidence_ids: ["string"],
          confidence: 0.7,
          as_of: "YYYY-MM-DD",
        },
      ],
      data_gaps: [{ topic: "string", reason: "string" }],
      evidence_coverage: { covered_domains: ["financials"], missing_domains: ["news"], notes: "string" },
    },
  },
  thesis_valuation: {
    schema_version: SUBAGENT_OUTPUT_SCHEMA_VERSION,
    agent_id: "thesis_valuation",
    description: "Produce investment theses, a valuation framework, and scenario variables.",
    required_fields: ["theses", "valuation_framework", "scenario_variables"],
    example_shape: {
      schema_version: SUBAGENT_OUTPUT_SCHEMA_VERSION,
      agent_id: "thesis_valuation",
      theses: [{ statement: "string", direction: "mixed", evidence_ids: ["string"], confidence: 0.7 }],
      valuation_framework: {
        method: "string",
        key_assumptions: ["string"],
        valuation_view: "fairly_valued",
        evidence_ids: ["string"],
      },
      scenario_variables: [
        {
          name: "string",
          base: "string",
          bull: "string",
          bear: "string",
          unit: "string (optional)",
          evidence_ids: ["string"],
        },
      ],
    },
  },
  risk_report: {
    schema_version: SUBAGENT_OUTPUT_SCHEMA_VERSION,
    agent_id: "risk_report",
    description: "Produce counter-evidence, risk triggers, and a final structured summary.",
    required_fields: ["counter_evidence", "risk_triggers", "final_summary"],
    optional_fields: ["risk_triggers[].derived_from_counter_evidence_index"],
    example_shape: {
      schema_version: SUBAGENT_OUTPUT_SCHEMA_VERSION,
      agent_id: "risk_report",
      counter_evidence: [
        { claim_challenged: "string", counterpoint: "string", evidence_ids: ["string"], severity: "medium" },
      ],
      risk_triggers: [
        {
          trigger: "string",
          metric_or_event: "string",
          evidence_ids: ["string"],
        },
      ],
      final_summary: {
        stance: "insufficient_data",
        key_reasons: ["string"],
        major_risks: ["string"],
        data_gaps: ["string"],
        upstream_references: {
          research_evidence_fact_indices: [0],
          thesis_indices: [0],
        },
      },
    },
  },
};

const EVIDENCE_DOMAINS = new Set<EvidenceDomain | "other">([
  "quote",
  "financials",
  "announcement",
  "news",
  "profile",
  "macro",
  "other",
]);
const THESIS_DIRECTIONS = new Set<ThesisDirection>(["bullish", "neutral", "bearish", "mixed"]);
const VALUATION_VIEWS = new Set<ValuationView>(["overvalued", "fairly_valued", "undervalued", "insufficient_data"]);
const RISK_SEVERITIES = new Set<RiskSeverity>(["low", "medium", "high"]);
const RISK_STANCES = new Set<RiskStance>(["positive", "neutral", "negative", "mixed", "insufficient_data"]);

export function describeOutputContract(contract: SubagentOutputContract): string {
  return [
    contract.description,
    `schema_version=${contract.schema_version}`,
    `required_fields=${contract.required_fields.join(", ")}`,
    ...(contract.optional_fields ? [`optional_fields=${contract.optional_fields.join(", ")}`] : []),
    `required_shape=${JSON.stringify(contract.example_shape)}`,
  ].join("; ");
}

export function getRequiredStructuredShape(agentId: SubagentId): SubagentStructuredOutput {
  return SUBAGENT_OUTPUT_CONTRACTS[agentId].example_shape;
}

export function parseStructuredOutput(agentId: SubagentId, value: unknown): SubagentStructuredOutput {
  const issues = validateStructuredOutput(agentId, value);
  if (issues.length > 0) {
    throw new Error(`structured_output failed ${agentId} contract: ${issues.join("; ")}`);
  }
  return value as SubagentStructuredOutput;
}

export function validateStructuredOutput(agentId: SubagentId, value: unknown): string[] {
  if (!isRecord(value)) return ["structured_output must be an object"];
  const issues = validateBase(agentId, value);
  if (agentId === "research_evidence") validateResearchEvidence(value, issues);
  if (agentId === "thesis_valuation") validateThesisValuation(value, issues);
  if (agentId === "risk_report") validateRiskReport(value, issues);
  return issues;
}

export function createFallbackStructuredOutput(input: {
  agent_id: SubagentId;
  target: string;
  evidence: EvidenceItem[];
  data_gaps: DataGap[];
  findings?: Finding[];
}): SubagentStructuredOutput {
  const evidenceIds = input.evidence.slice(0, 3).map((item) => item.id);
  const firstEvidence = input.evidence[0];
  const hasEvidence = evidenceIds.length > 0;
  const gapTexts = input.data_gaps.map((gap) => `${gap.query}: ${gap.reason}`);
  const defaultAsOf = firstEvidence?.as_of ?? new Date().toISOString().slice(0, 10);
  const defaultStatement =
    input.findings?.find((finding) => finding.statement.trim())?.statement ??
    `${input.target} needs more verified evidence before a firm conclusion.`;

  if (input.agent_id === "research_evidence") {
    return {
      schema_version: SUBAGENT_OUTPUT_SCHEMA_VERSION,
      agent_id: "research_evidence",
      fact_table: [
        {
          fact: hasEvidence ? defaultStatement : `${input.target} has insufficient verified evidence in this run.`,
          domain: firstEvidence?.domain ?? "other",
          evidence_ids: evidenceIds,
          confidence: hasEvidence ? 0.55 : 0.2,
          as_of: defaultAsOf,
          ...(!hasEvidence ? { is_assumption: true } : {}),
        },
      ],
      data_gaps: buildResearchDataGaps(input.data_gaps),
      evidence_coverage: {
        covered_domains: [...new Set(input.evidence.map((item) => item.domain ?? "other"))],
        missing_domains: input.data_gaps.length > 0 ? [...new Set(input.data_gaps.map((gap) => gap.source_name))] : [],
        notes: hasEvidence ? "Evidence was normalized into a fallback fact table." : "No citable evidence was available.",
      },
    };
  }

  if (input.agent_id === "thesis_valuation") {
    return {
      schema_version: SUBAGENT_OUTPUT_SCHEMA_VERSION,
      agent_id: "thesis_valuation",
      theses: [
        {
          statement: hasEvidence ? defaultStatement : `${input.target} valuation stance is insufficient_data pending evidence.`,
          direction: "mixed",
          evidence_ids: evidenceIds,
          confidence: hasEvidence ? 0.55 : 0.2,
        },
      ],
      valuation_framework: {
        method: "evidence-led qualitative framework",
        key_assumptions: hasEvidence ? ["Available evidence is representative enough for a preliminary view."] : [],
        valuation_view: hasEvidence ? "fairly_valued" : "insufficient_data",
        evidence_ids: evidenceIds,
      },
      scenario_variables: [
        {
          name: "evidence quality",
          base: hasEvidence ? "limited verified evidence" : "insufficient evidence",
          bull: "more high-quality supporting evidence appears",
          bear: "evidence gaps remain or contradict the thesis",
          evidence_ids: evidenceIds,
        },
      ],
    };
  }

  return {
    schema_version: SUBAGENT_OUTPUT_SCHEMA_VERSION,
    agent_id: "risk_report",
    counter_evidence: [
      {
        claim_challenged: defaultStatement,
        counterpoint: hasEvidence
          ? "Current evidence is not enough to eliminate downside or contradiction risk."
          : "No evidence-backed thesis can be confirmed in this run.",
        evidence_ids: evidenceIds,
        severity: hasEvidence ? "medium" : "high",
      },
    ],
    risk_triggers: [
      {
        trigger: "Evidence quality deteriorates or key data remains unavailable.",
        metric_or_event: "new verified evidence or unresolved data gap",
        threshold: hasEvidence ? "material contradiction in fresh evidence" : "no verified evidence after rerun",
        watch_frequency: "per research update",
        derived_from_counter_evidence_index: 0,
        evidence_ids: evidenceIds,
      },
    ],
    final_summary: {
      stance: hasEvidence ? "mixed" : "insufficient_data",
      key_reasons: hasEvidence ? ["Evidence exists but requires risk-side validation."] : ["No citable evidence was available."],
      major_risks: ["Unsupported conclusion risk", "Data gap risk"],
      data_gaps: gapTexts,
      upstream_references: {
        research_evidence_fact_indices: [0],
        thesis_indices: [],
      },
    },
  };
}

function validateBase(agentId: SubagentId, value: Record<string, unknown>): string[] {
  const issues: string[] = [];
  if (value.schema_version !== SUBAGENT_OUTPUT_SCHEMA_VERSION) {
    issues.push(`schema_version must be ${SUBAGENT_OUTPUT_SCHEMA_VERSION}`);
  }
  if (value.agent_id !== agentId) issues.push(`agent_id must be ${agentId}`);
  return issues;
}

function validateResearchEvidence(value: Record<string, unknown>, issues: string[]): void {
  if (!Array.isArray(value.fact_table) || value.fact_table.length === 0) {
    issues.push("research_evidence.fact_table must be a non-empty array");
  } else {
    value.fact_table.forEach((item, index) => {
      if (!isRecord(item)) {
        issues.push(`research_evidence.fact_table[${index}] must be an object`);
        return;
      }
      requireString(item.fact, `research_evidence.fact_table[${index}].fact`, issues);
      if (typeof item.domain !== "string" || !EVIDENCE_DOMAINS.has(item.domain as EvidenceDomain | "other")) {
        issues.push(`research_evidence.fact_table[${index}].domain is invalid`);
      }
      requireStringArray(item.evidence_ids, `research_evidence.fact_table[${index}].evidence_ids`, issues);
      requireConfidence(item.confidence, `research_evidence.fact_table[${index}].confidence`, issues);
      requireString(item.as_of, `research_evidence.fact_table[${index}].as_of`, issues);
    });
  }

  if (!Array.isArray(value.data_gaps)) {
    issues.push("research_evidence.data_gaps must be an array");
  } else {
    value.data_gaps.forEach((item, index) => {
      if (!isRecord(item)) {
        issues.push(`research_evidence.data_gaps[${index}] must be an object`);
        return;
      }
      requireString(item.topic, `research_evidence.data_gaps[${index}].topic`, issues);
      requireString(item.reason, `research_evidence.data_gaps[${index}].reason`, issues);
    });
  }
  if (!isRecord(value.evidence_coverage)) {
    issues.push("research_evidence.evidence_coverage must be an object");
  } else {
    requireStringArray(value.evidence_coverage.covered_domains, "research_evidence.evidence_coverage.covered_domains", issues);
    requireStringArray(value.evidence_coverage.missing_domains, "research_evidence.evidence_coverage.missing_domains", issues);
    requireString(value.evidence_coverage.notes, "research_evidence.evidence_coverage.notes", issues);
  }
}

function validateThesisValuation(value: Record<string, unknown>, issues: string[]): void {
  if (!Array.isArray(value.theses) || value.theses.length === 0) {
    issues.push("thesis_valuation.theses must be a non-empty array");
  } else {
    value.theses.forEach((item, index) => {
      if (!isRecord(item)) {
        issues.push(`thesis_valuation.theses[${index}] must be an object`);
        return;
      }
      requireString(item.statement, `thesis_valuation.theses[${index}].statement`, issues);
      if (typeof item.direction !== "string" || !THESIS_DIRECTIONS.has(item.direction as ThesisDirection)) {
        issues.push(`thesis_valuation.theses[${index}].direction is invalid`);
      }
      requireStringArray(item.evidence_ids, `thesis_valuation.theses[${index}].evidence_ids`, issues);
      requireConfidence(item.confidence, `thesis_valuation.theses[${index}].confidence`, issues);
    });
  }

  if (!isRecord(value.valuation_framework)) {
    issues.push("thesis_valuation.valuation_framework must be an object");
  } else {
    requireString(value.valuation_framework.method, "thesis_valuation.valuation_framework.method", issues);
    requireStringArray(
      value.valuation_framework.key_assumptions,
      "thesis_valuation.valuation_framework.key_assumptions",
      issues,
    );
    if (
      typeof value.valuation_framework.valuation_view !== "string" ||
      !VALUATION_VIEWS.has(value.valuation_framework.valuation_view as ValuationView)
    ) {
      issues.push("thesis_valuation.valuation_framework.valuation_view is invalid");
    }
    requireStringArray(value.valuation_framework.evidence_ids, "thesis_valuation.valuation_framework.evidence_ids", issues);
  }

  if (!Array.isArray(value.scenario_variables) || value.scenario_variables.length === 0) {
    issues.push("thesis_valuation.scenario_variables must be a non-empty array");
  } else {
    value.scenario_variables.forEach((item, index) => {
      if (!isRecord(item)) {
        issues.push(`thesis_valuation.scenario_variables[${index}] must be an object`);
        return;
      }
      requireString(item.name, `thesis_valuation.scenario_variables[${index}].name`, issues);
      requireString(item.base, `thesis_valuation.scenario_variables[${index}].base`, issues);
      requireString(item.bull, `thesis_valuation.scenario_variables[${index}].bull`, issues);
      requireString(item.bear, `thesis_valuation.scenario_variables[${index}].bear`, issues);
      requireStringArray(item.evidence_ids, `thesis_valuation.scenario_variables[${index}].evidence_ids`, issues);
    });
  }
}

function validateRiskReport(value: Record<string, unknown>, issues: string[]): void {
  if (!Array.isArray(value.counter_evidence) || value.counter_evidence.length === 0) {
    issues.push("risk_report.counter_evidence must be a non-empty array");
  } else {
    value.counter_evidence.forEach((item, index) => {
      if (!isRecord(item)) {
        issues.push(`risk_report.counter_evidence[${index}] must be an object`);
        return;
      }
      requireString(item.claim_challenged, `risk_report.counter_evidence[${index}].claim_challenged`, issues);
      requireString(item.counterpoint, `risk_report.counter_evidence[${index}].counterpoint`, issues);
      requireStringArray(item.evidence_ids, `risk_report.counter_evidence[${index}].evidence_ids`, issues);
      if (typeof item.severity !== "string" || !RISK_SEVERITIES.has(item.severity as RiskSeverity)) {
        issues.push(`risk_report.counter_evidence[${index}].severity is invalid`);
      }
    });
  }

  if (!Array.isArray(value.risk_triggers) || value.risk_triggers.length === 0) {
    issues.push("risk_report.risk_triggers must be a non-empty array");
  } else {
    value.risk_triggers.forEach((item, index) => {
      if (!isRecord(item)) {
        issues.push(`risk_report.risk_triggers[${index}] must be an object`);
        return;
      }
      requireString(item.trigger, `risk_report.risk_triggers[${index}].trigger`, issues);
      requireString(item.metric_or_event, `risk_report.risk_triggers[${index}].metric_or_event`, issues);
      const derivedIndex = item.derived_from_counter_evidence_index;
      if (derivedIndex !== undefined && (typeof derivedIndex !== "number" || !Number.isInteger(derivedIndex) || derivedIndex < 0)) {
        issues.push(`risk_report.risk_triggers[${index}].derived_from_counter_evidence_index is invalid`);
      }
      requireStringArray(item.evidence_ids, `risk_report.risk_triggers[${index}].evidence_ids`, issues);
    });
  }

  if (!isRecord(value.final_summary)) {
    issues.push("risk_report.final_summary must be an object");
  } else {
    if (typeof value.final_summary.stance !== "string" || !RISK_STANCES.has(value.final_summary.stance as RiskStance)) {
      issues.push("risk_report.final_summary.stance is invalid");
    }
    requireStringArray(value.final_summary.key_reasons, "risk_report.final_summary.key_reasons", issues);
    requireStringArray(value.final_summary.major_risks, "risk_report.final_summary.major_risks", issues);
    requireStringArray(value.final_summary.data_gaps, "risk_report.final_summary.data_gaps", issues);
    if (!isRecord(value.final_summary.upstream_references)) {
      issues.push("risk_report.final_summary.upstream_references must be an object");
    } else {
      requireNumberArray(
        value.final_summary.upstream_references.research_evidence_fact_indices,
        "risk_report.final_summary.upstream_references.research_evidence_fact_indices",
        issues,
      );
      requireNumberArray(
        value.final_summary.upstream_references.thesis_indices,
        "risk_report.final_summary.upstream_references.thesis_indices",
        issues,
      );
    }
  }
}

function buildResearchDataGaps(dataGaps: DataGap[]): ResearchEvidenceDataGap[] {
  return dataGaps.map((gap) => ({
    topic: gap.query,
    reason: gap.reason,
    needed_evidence: gap.source_name,
    impact: "May limit confidence in the final research view.",
  }));
}

function requireString(value: unknown, path: string, issues: string[]): void {
  if (typeof value !== "string" || value.trim().length === 0) issues.push(`${path} must be a non-empty string`);
}

function requireStringArray(value: unknown, path: string, issues: string[]): void {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    issues.push(`${path} must be a string array`);
  }
}

function requireNumberArray(value: unknown, path: string, issues: string[]): void {
  if (!Array.isArray(value) || !value.every((item) => Number.isInteger(item) && item >= 0)) {
    issues.push(`${path} must be a non-negative integer array`);
  }
}

function requireConfidence(value: unknown, path: string, issues: string[]): void {
  if (typeof value !== "number" || Number.isNaN(value) || value < 0 || value > 1) {
    issues.push(`${path} must be a number between 0 and 1`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
