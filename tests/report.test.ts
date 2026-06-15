import assert from "node:assert/strict";
import test from "node:test";
import { buildMarkdownReport } from "../src/report.js";
import type {
  DataGap,
  EvidenceItem,
  ResearchPlan,
  ReviewResult,
  SubagentId,
  SubagentResult,
  SubagentStructuredOutput,
} from "../src/schemas.js";

const quoteEvidence: EvidenceItem = {
  id: "ev-quote",
  domain: "quote",
  source_type: "mock",
  source_name: "fixture-quote",
  query: "CATL quote",
  as_of: "2026-06-10",
  retrieved_at: "2026-06-10T00:00:00.000Z",
  confidence: 0.82,
  value: {
    schema: "quote.v1",
    symbol: "300750.SZ",
    name: "CATL",
    market: "A-share",
    price: 245.6,
    open: 242.1,
    high: 248.2,
    low: 240.3,
    prev_close: 241.26,
    change_pct: 1.8,
    volume: 12345678,
    turnover: 3012345678,
    trade_date: "2026-06-10",
  },
};

const financialEvidence: EvidenceItem = {
  id: "ev-fin",
  domain: "financials",
  source_type: "mock",
  source_name: "fixture-financials",
  query: "CATL financials",
  as_of: "2026-06-10",
  retrieved_at: "2026-06-10T00:00:00.000Z",
  confidence: 0.78,
  value: {
    schema: "financials.v1",
    symbol: "300750.SZ",
    name: "CATL",
    period: "2026Q1",
    report_type: "quarterly",
    revenue: 1000000000,
    net_profit: 120000000,
    gross_margin: 24.5,
    roe: 16.2,
    total_assets: 5000000000,
    operating_cash_flow: 90000000,
    currency: "CNY",
  },
};

const newsEvidence: EvidenceItem = {
  id: "ev-news",
  domain: "news",
  source_type: "mock",
  source_name: "fixture-news",
  query: "CATL policy risk",
  as_of: "2026-06-10",
  retrieved_at: "2026-06-10T00:00:00.000Z",
  confidence: 0.72,
  value: {
    schema: "news.v1",
    title: "Overseas policy risk remains relevant",
    published_at: "2026-06-10",
    source: "fixture",
    related_symbols: ["300750.SZ"],
    summary: "Policy uncertainty may affect overseas expansion.",
  },
};

test("buildMarkdownReport renders a formal investment memo from three structured agents", () => {
  const markdown = buildMarkdownReport(
    plan(["research_evidence", "thesis_valuation", "risk_report"]),
    [
      result("research_evidence", [quoteEvidence, financialEvidence], researchOutput()),
      result("thesis_valuation", [quoteEvidence, financialEvidence], thesisOutput()),
      result("risk_report", [newsEvidence], riskOutput()),
    ],
    passReviews(["research_evidence", "thesis_valuation", "risk_report"]),
  );

  assert.match(markdown, /^# 宁德时代 投资研究 Memo/);
  for (const heading of [
    "## 投资结论",
    "## 核心证据",
    "## 关键数据",
    "## 估值/情景",
    "## 风险与反证",
    "## 数据缺口",
    "## 研究质量说明",
    "## 附录 Evidence Ledger",
  ]) {
    assert.match(markdown, new RegExp(heading));
  }
  assert.match(markdown, /情景矩阵/);
  assert.match(markdown, /反证清单/);
  assert.match(markdown, /最新价/);
  assert.match(markdown, /ev-fin/);
  assert.match(markdown, /支撑位置/);
  assert.match(markdown, /核心证据#1/);
  assert.match(markdown, /投资观点#1/);
  assert.doesNotMatch(markdown, /Structured Agent Outputs/);
  assert.doesNotMatch(markdown, /三段式 agent 摘要/);
  assert.doesNotMatch(markdown, /## 评审结果/);
});

test("buildMarkdownReport handles an evidence plus risk report without valuation output", () => {
  const markdown = buildMarkdownReport(
    plan(["research_evidence", "risk_report"], "technical_review"),
    [
      result("research_evidence", [quoteEvidence], researchOutput()),
      result("risk_report", [newsEvidence], riskOutput()),
    ],
    passReviews(["research_evidence", "risk_report"]),
  );

  assert.match(markdown, /价量\/技术观察/);
  assert.match(markdown, /相对前收盘/);
  assert.match(markdown, /日内区间/);
  assert.doesNotMatch(markdown, /本次流程未调度估值 agent/);
  assert.match(markdown, /## 风险与反证/);
  assert.match(markdown, /可引用证据少于 3 条/);
});

test("buildMarkdownReport discounts confidence when strong thesis evidence conflicts with high-severity counter evidence", () => {
  const markdown = buildMarkdownReport(
    plan(["research_evidence", "thesis_valuation", "risk_report"]),
    [
      result("research_evidence", [quoteEvidence, financialEvidence, newsEvidence], researchOutput()),
      result("thesis_valuation", [financialEvidence], thesisOutput()),
      result("risk_report", [newsEvidence], riskOutput("mixed", "high")),
    ],
    passReviews(["research_evidence", "thesis_valuation", "risk_report"]),
  );

  assert.match(markdown, /存在高严重性反证，结论置信度已下调/);
  assert.match(markdown, /\*\*置信度\*\*：低/);
  assert.doesNotMatch(markdown, /\*\*置信度\*\*：高/);
});

test("buildMarkdownReport downgrades to a framework when no evidence is available", () => {
  const markdown = buildMarkdownReport(
    plan(["research_evidence", "risk_report"]),
    [
      result("research_evidence", [], undefined, { confidence: 0.2 }),
      result("risk_report", [], riskOutput("insufficient_data"), { confidence: 0.2 }),
    ],
    passReviews(["research_evidence", "risk_report"]),
  );

  assert.match(markdown, /暂不形成强结论，需补证据后复核/);
  assert.match(markdown, /本次没有可引用证据/);
  assert.match(markdown, /暂无可沉淀为事实表的证据/);
  assert.match(markdown, /暂无可用证据/);
});

test("buildMarkdownReport omits non-finite metric values from key data", () => {
  const brokenQuote: EvidenceItem = {
    ...quoteEvidence,
    id: "ev-broken-quote",
    value: {
      ...(quoteEvidence.value as Record<string, unknown>),
      price: Number.NaN,
      prev_close: Number.NaN,
      change_pct: Number.NaN,
      turnover: Number.NaN,
    },
  };
  const markdown = buildMarkdownReport(
    plan(["research_evidence", "risk_report"], "technical_review"),
    [
      result("research_evidence", [brokenQuote], researchOutput()),
      result("risk_report", [newsEvidence], riskOutput()),
    ],
    passReviews(["research_evidence", "risk_report"]),
  );

  assert.doesNotMatch(markdown, /NaN/);
  assert.match(markdown, /价量\/技术观察/);
});

test("buildMarkdownReport exposes research and source data gaps without leaking review details", () => {
  const dataGap: DataGap = {
    source_name: "fixture-source",
    query: "CATL customer concentration",
    reason: "Customer-level revenue split unavailable.",
    occurred_at: "2026-06-10T00:00:00.000Z",
    reason_code: "empty_result",
  };
  const markdown = buildMarkdownReport(
    plan(["research_evidence", "thesis_valuation", "risk_report"]),
    [
      result("research_evidence", [quoteEvidence], researchOutput(), { data_gaps: [dataGap] }),
      result("thesis_valuation", [quoteEvidence], thesisOutput("insufficient_data")),
      result("risk_report", [newsEvidence], riskOutput()),
    ],
    [
      ...passReviews(["research_evidence", "thesis_valuation"]),
      { agent_id: "risk_report", pass: false, score: 70, issues: ["[major] Citation issue."] },
    ],
  );

  assert.match(markdown, /存在数据源缺口/);
  assert.match(markdown, /估值输出标记为数据不足/);
  assert.match(markdown, /质量门禁存在未通过项/);
  assert.match(markdown, /Customer-level revenue split unavailable/);
  assert.doesNotMatch(markdown, /Citation issue/);
});

function plan(selectedAgents: SubagentId[], taskType: ResearchPlan["normalized_request"]["task_type"] = "deep_research"): ResearchPlan {
  return {
    normalized_request: {
      request: "做宁德时代深度研究",
      target: "宁德时代",
      market: "A-share",
      task_type: taskType,
      output_format: "markdown",
      sources: ["fixture"],
      use_live_ifind: false,
    },
    target: "宁德时代",
    selected_agents: selectedAgents,
    tasks: [],
    delegation_policy: {
      mode: selectedAgents.length > 1 ? "batch" : "single",
      max_concurrency: 3,
      max_spawn_depth: 1,
      max_revision_rounds: 2,
      allow_nested_orchestrators: false,
      summary_only: true,
    },
  };
}

function result(
  agentId: SubagentId,
  evidence: EvidenceItem[],
  structuredOutput: SubagentStructuredOutput | undefined,
  overrides: Partial<SubagentResult> = {},
): SubagentResult {
  return {
    agent_id: agentId,
    task: `${agentId} task`,
    summary: `${agentId} summary`,
    findings: evidence.length > 0
      ? [{ statement: `${agentId} finding`, evidence_ids: evidence.slice(0, 1).map((item) => item.id), confidence: 0.7 }]
      : [],
    evidence,
    assumptions: [],
    open_questions: [],
    confidence: 0.7,
    data_gaps: [],
    ...(structuredOutput ? { structured_output: structuredOutput } : {}),
    needs_revision: false,
    ...overrides,
  };
}

function researchOutput(): SubagentStructuredOutput {
  return {
    schema_version: "subagent-output.v1",
    agent_id: "research_evidence",
    fact_table: [
      {
        fact: "宁德时代行情与财务证据可用于初步判断。",
        domain: "financials",
        evidence_ids: ["ev-quote", "ev-fin"],
        confidence: 0.76,
        as_of: "2026-06-10",
      },
    ],
    data_gaps: [
      {
        topic: "客户集中度",
        reason: "缺少客户级收入拆分。",
        needed_evidence: "客户收入结构",
        impact: "限制需求稳定性判断。",
      },
    ],
    evidence_coverage: {
      covered_domains: ["quote", "financials"],
      missing_domains: ["announcement"],
      notes: "Fixture coverage.",
    },
  };
}

function thesisOutput(valuationView: "fairly_valued" | "insufficient_data" = "fairly_valued"): SubagentStructuredOutput {
  return {
    schema_version: "subagent-output.v1",
    agent_id: "thesis_valuation",
    theses: [
      {
        statement: "经营质量与估值情景共同指向分歧但可跟踪的投资观点。",
        direction: "mixed",
        evidence_ids: ["ev-fin"],
        confidence: 0.72,
      },
    ],
    valuation_framework: {
      method: "scenario framework",
      key_assumptions: ["毛利率保持稳定。"],
      valuation_view: valuationView,
      evidence_ids: valuationView === "insufficient_data" ? [] : ["ev-fin"],
    },
    scenario_variables: [
      {
        name: "毛利率",
        base: "稳定",
        bull: "改善",
        bear: "压缩",
        unit: "pct",
        evidence_ids: ["ev-fin"],
      },
    ],
  };
}

function riskOutput(
  stance: "mixed" | "insufficient_data" = "mixed",
  severity: "medium" | "high" = "medium",
): SubagentStructuredOutput {
  return {
    schema_version: "subagent-output.v1",
    agent_id: "risk_report",
    counter_evidence: [
      {
        claim_challenged: "毛利率压力可控。",
        counterpoint: "海外政策和客户集中度仍可能放大波动。",
        evidence_ids: stance === "insufficient_data" ? [] : ["ev-news"],
        severity,
      },
    ],
    risk_triggers: [
      {
        trigger: "海外政策压力上升。",
        metric_or_event: "政策事件",
        threshold: "出现实质限制",
        watch_frequency: "每次研究更新",
        derived_from_counter_evidence_index: 0,
        evidence_ids: stance === "insufficient_data" ? [] : ["ev-news"],
      },
    ],
    final_summary: {
      stance,
      key_reasons: ["成长证据和风险证据同时存在，需要情景化跟踪。"],
      major_risks: ["政策风险", "客户集中度"],
      data_gaps: [],
      upstream_references: {
        research_evidence_fact_indices: [0],
        thesis_indices: [0],
      },
    },
  };
}

function passReviews(agentIds: SubagentId[]): ReviewResult[] {
  return agentIds.map((agent_id) => ({
    agent_id,
    pass: true,
    score: 100,
    issues: [],
  }));
}
