import type { DataGap, EvidenceItem, FinalReport, ResearchPlan, ReviewResult, SubagentExecutionTrace, SubagentResult } from "./schemas.js";
import { dedupeEvidence, EVIDENCE_SCHEMA_VERSION } from "./evidence.js";

export function buildMarkdownReport(
  plan: ResearchPlan,
  subagentResults: SubagentResult[],
  reviews: ReviewResult[],
): string {
  const evidence = dedupeEvidence(subagentResults.flatMap((result) => result.evidence));
  const dataGaps = subagentResults.flatMap((result) => result.data_gaps);
  const assumptions = subagentResults.flatMap((result) => result.assumptions);
  const researchOutput = subagentResults.find((result) => result.structured_output?.agent_id === "research_evidence")
    ?.structured_output;
  const thesisOutput = subagentResults.find((result) => result.structured_output?.agent_id === "thesis_valuation")
    ?.structured_output;
  const riskOutput = subagentResults.find((result) => result.structured_output?.agent_id === "risk_report")
    ?.structured_output;
  const qualityNotes = buildQualityNotes({
    evidence,
    dataGaps,
    reviews,
    researchOutput,
    thesisOutput,
    riskOutput,
  });
  const investmentConclusion = buildInvestmentConclusion(riskOutput, thesisOutput, qualityNotes, evidence, reviews);
  const metricRows = buildMetricRows(evidence);
  const technicalRows = buildTechnicalRows(evidence);
  const evidenceUsage = buildEvidenceUsageMap(researchOutput, thesisOutput, riskOutput);

  const lines: string[] = [
    `# ${plan.target} 投资研究 Memo`,
    "",
    "## 投资结论",
    "",
    `- **结论**：${investmentConclusion.stance}`,
    `- **置信度**：${confidenceLabel(investmentConclusion.confidence)}`,
    `- **证据基础**：${evidence.length} 条证据，${dataGaps.length} 个数据缺口。`,
    ...investmentConclusion.reasons.map((reason) => `- **核心理由**：${reason}`),
    ...qualityNotes.map((note) => `- **质量提示**：${note}`),
    "",
    "## 核心证据",
    "",
  ];

  if (researchOutput?.agent_id === "research_evidence" && researchOutput.fact_table.length > 0) {
    lines.push("| 事实 | 领域 | 日期 | 置信度 | 引用 |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const fact of researchOutput.fact_table) {
      lines.push(
        `| ${md(fact.fact)} | ${fact.domain} | ${md(fact.as_of)} | ${confidenceLabel(fact.confidence)} | ${citation(fact.evidence_ids)} |`,
      );
    }
  } else {
    lines.push("- 暂无可沉淀为事实表的证据。本报告只能作为研究框架，不能作为正式投资结论。");
  }

  lines.push("", "## 关键数据", "");
  lines.push("### 证据覆盖", "");
  lines.push("| 领域 | 证据条数 | 平均置信度 |");
  lines.push("| --- | ---: | --- |");
  for (const row of buildCoverageRows(evidence)) {
    lines.push(`| ${row.domain} | ${row.count} | ${confidenceLabel(row.confidence)} |`);
  }
  if (evidence.length === 0) lines.push("| 无 | 0 | 不足 |");

  lines.push("", "### 关键数据快照", "");
  if (metricRows.length === 0) {
    lines.push("- 当前证据没有可结构化展示的行情、财务或宏观指标。");
  } else {
    lines.push("| 指标 | 数值 | 日期/期间 | 引用 |");
    lines.push("| --- | ---: | --- | --- |");
    for (const row of metricRows) {
      lines.push(`| ${md(row.metric)} | ${md(row.value)} | ${md(row.period)} | ${row.evidenceId} |`);
    }
  }

  lines.push("", "## 估值/情景", "");
  if (thesisOutput?.agent_id === "thesis_valuation") {
    lines.push("### 投资观点", "");
    for (const thesis of thesisOutput.theses) {
      lines.push(`- **${translateDirection(thesis.direction)}**：${thesis.statement} ${citation(thesis.evidence_ids)}（${confidenceLabel(thesis.confidence)}）`);
    }
    lines.push("", "### 估值框架", "");
    lines.push("| 方法 | 估值判断 | 关键假设 | 引用 |");
    lines.push("| --- | --- | --- | --- |");
    lines.push(
      `| ${md(thesisOutput.valuation_framework.method)} | ${translateValuationView(thesisOutput.valuation_framework.valuation_view)} | ${md(thesisOutput.valuation_framework.key_assumptions.join("；") || "未提供")} | ${citation(thesisOutput.valuation_framework.evidence_ids)} |`,
    );
    lines.push("", "### 情景矩阵", "");
    lines.push("| 变量 | Bear | Base | Bull | 引用 |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const variable of thesisOutput.scenario_variables) {
      const unit = variable.unit ? `（${variable.unit}）` : "";
      lines.push(
        `| ${md(`${variable.name}${unit}`)} | ${md(variable.bear)} | ${md(variable.base)} | ${md(variable.bull)} | ${citation(variable.evidence_ids)} |`,
      );
    }
  } else {
    lines.push("### 价量/技术观察", "");
    if (technicalRows.length === 0) {
      lines.push("- 当前证据不足以生成估值、情景或价量观察。");
    } else {
      lines.push("| 观察项 | 读数 | 说明 | 引用 |");
      lines.push("| --- | ---: | --- | --- |");
      for (const row of technicalRows) {
        lines.push(`| ${md(row.metric)} | ${md(row.value)} | ${md(row.note)} | ${row.evidenceId} |`);
      }
    }
  }

  lines.push("", "## 风险与反证", "");
  if (riskOutput?.agent_id === "risk_report") {
    lines.push(`- **风险结论**：${translateRiskStance(riskOutput.final_summary.stance)}。`);
    if (riskOutput.final_summary.major_risks.length > 0) {
      lines.push(...riskOutput.final_summary.major_risks.map((risk) => `- **主要风险**：${risk}`));
    }
    lines.push("", "### 反证清单", "");
    lines.push("| 被挑战观点 | 反证/约束 | 严重性 | 引用 |");
    lines.push("| --- | --- | --- | --- |");
    for (const item of riskOutput.counter_evidence) {
      lines.push(
        `| ${md(item.claim_challenged)} | ${md(item.counterpoint)} | ${translateSeverity(item.severity)} | ${citation(item.evidence_ids)} |`,
      );
    }
    lines.push("", "### 风险触发器", "");
    lines.push("| 触发条件 | 指标/事件 | 阈值 | 观察频率 | 引用 |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const trigger of riskOutput.risk_triggers) {
      lines.push(
        `| ${md(trigger.trigger)} | ${md(trigger.metric_or_event)} | ${md(trigger.threshold ?? "未设定")} | ${md(trigger.watch_frequency ?? "按研究更新")} | ${citation(trigger.evidence_ids)} |`,
      );
    }
  } else {
    lines.push("- 本次没有可用的风险与反证结构化输出；需补充反向验证后再形成正式判断。");
  }

  lines.push("", "## 数据缺口", "");
  const researchDataGaps = researchOutput?.agent_id === "research_evidence" ? researchOutput.data_gaps : [];
  if (researchDataGaps.length === 0 && dataGaps.length === 0) {
    lines.push("- 未发现阻断性数据缺口。");
  } else {
    if (researchDataGaps.length > 0) {
      lines.push("| 主题 | 原因 | 影响 | 所需证据 |");
      lines.push("| --- | --- | --- | --- |");
      for (const gap of researchDataGaps) {
        lines.push(`| ${md(gap.topic)} | ${md(gap.reason)} | ${md(gap.impact ?? "影响待评估")} | ${md(gap.needed_evidence ?? "待补充")} |`);
      }
    }
    if (dataGaps.length > 0) {
      lines.push("", "### 数据源缺口", "");
      lines.push("| 来源 | 查询 | 原因 | 时间 |");
      lines.push("| --- | --- | --- | --- |");
      for (const gap of dataGaps) {
        lines.push(`| ${md(gap.source_name)} | ${md(gap.query)} | ${md(gap.reason)} | ${md(gap.occurred_at)} |`);
      }
    }
  }

  lines.push("", "## 研究质量说明", "");
  lines.push(`- 研究对象：${plan.target}；任务类型：${plan.normalized_request.task_type}；市场：${plan.normalized_request.market ?? "unknown"}。`);
  lines.push(`- 报告仅展示面向投研阅读的结论、证据、情景和风险；调试链路、子 agent 原始输出与评审明细请查看 trace.json。`);
  lines.push(`- 证据账本由 evidence-ledger.json 固化；本文附录只展示便于阅读的摘要。`);
  if (assumptions.length > 0) {
    lines.push(`- 关键假设：${assumptions.map((assumption) => md(assumption)).join("；")}。`);
  }
  if (reviews.some((review) => !review.pass)) {
    lines.push("- 质量门禁存在未通过项，正式使用前需优先处理 trace.json 中的评审问题。");
  }

  lines.push("", "## 附录 Evidence Ledger", "");
  if (evidence.length === 0) {
    lines.push("- 暂无可用证据。");
  } else {
    lines.push("| ID | 来源 | 领域 | 日期 | 查询 | 置信度 | 支撑位置 |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- |");
    for (const item of evidence) {
      lines.push(
        `| ${md(item.id)} | ${md(item.source_name)} | ${item.domain ?? "other"} | ${md(item.as_of)} | ${md(item.query)} | ${confidenceLabel(item.confidence)} | ${md(formatEvidenceUsage(evidenceUsage.get(item.id)))} |`,
      );
    }
  }

  return lines.join("\n");
}

type ResearchOutput = NonNullable<SubagentResult["structured_output"]>;
type QualityInputs = {
  evidence: EvidenceItem[];
  dataGaps: DataGap[];
  reviews: ReviewResult[];
  researchOutput: ResearchOutput | undefined;
  thesisOutput: ResearchOutput | undefined;
  riskOutput: ResearchOutput | undefined;
};

function buildInvestmentConclusion(
  riskOutput: ResearchOutput | undefined,
  thesisOutput: ResearchOutput | undefined,
  qualityNotes: string[],
  evidence: EvidenceItem[],
  reviews: ReviewResult[],
): { stance: string; confidence: number; reasons: string[] } {
  const risk = riskOutput?.agent_id === "risk_report" ? riskOutput : undefined;
  const thesis = thesisOutput?.agent_id === "thesis_valuation" ? thesisOutput : undefined;
  const reasons = risk?.final_summary.key_reasons.length
    ? risk.final_summary.key_reasons
    : thesis?.theses.map((item) => item.statement) ?? [];
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  const thesisConfidence = thesis
    ? weightedAverage(thesis.theses.map((item) => ({
        value: item.confidence,
        weight: evidenceSupportWeight(item.evidence_ids, evidenceById),
      })))
    : 0;
  const evidenceConfidence = average(evidence.map((item) => item.confidence)) * Math.min(1, evidence.length / 3);
  const reviewConfidence = average(reviews.map((review) => Math.max(0, Math.min(1, review.score / 100))));
  const contradictionPenalty = risk ? riskContradictionPenalty(risk) : 0;
  const qualityPenalty = Math.min(0.2, qualityNotes.length * 0.04);
  const baseConfidence = thesis
    ? weightedAverage([
        { value: thesisConfidence, weight: 0.55 },
        { value: evidenceConfidence, weight: 0.3 },
        { value: reviewConfidence, weight: 0.15 },
      ])
    : weightedAverage([
        { value: evidenceConfidence, weight: 0.65 },
        { value: 1 - contradictionPenalty, weight: 0.2 },
        { value: reviewConfidence, weight: 0.15 },
      ]);
  const confidence = thesis
    ? clampConfidence(baseConfidence - contradictionPenalty - qualityPenalty)
    : clampConfidence(baseConfidence - qualityPenalty);
  const shouldDowngrade =
    qualityNotes.length > 0 ||
    risk?.final_summary.stance === "insufficient_data" ||
    thesis?.valuation_framework.valuation_view === "insufficient_data";
  const stance = shouldDowngrade
    ? "暂不形成强结论，需补证据后复核"
    : buildStanceText(risk?.final_summary.stance, thesis?.valuation_framework.valuation_view);
  return {
    stance,
    confidence,
    reasons: reasons.length > 0 ? reasons.slice(0, 3) : ["当前结构化输出不足，无法提炼可靠投资理由。"],
  };
}

function buildQualityNotes(input: QualityInputs): string[] {
  const notes: string[] = [];
  const confidence = average(input.evidence.map((item) => item.confidence));
  const thesis = input.thesisOutput?.agent_id === "thesis_valuation" ? input.thesisOutput : undefined;
  const risk = input.riskOutput?.agent_id === "risk_report" ? input.riskOutput : undefined;

  if (input.evidence.length === 0) notes.push("本次没有可引用证据，报告只能作为研究框架。");
  if (input.evidence.length > 0 && input.evidence.length < 3) notes.push("可引用证据少于 3 条，结论需要额外交叉验证。");
  if (confidence > 0 && confidence < 0.45) notes.push("证据平均置信度偏低，暂不适合形成强投资判断。");
  if (input.dataGaps.length > 0) notes.push("存在数据源缺口，可能影响结论完整性。");
  if (thesis?.valuation_framework.valuation_view === "insufficient_data") notes.push("估值输出标记为数据不足。");
  if (risk?.final_summary.stance === "insufficient_data") notes.push("风险输出标记为数据不足。");
  if (risk?.counter_evidence.some((item) => item.severity === "high")) notes.push("存在高严重性反证，结论置信度已下调。");
  if (input.reviews.some((review) => !review.pass)) notes.push("自动评审存在未通过项，需查看 trace.json 处理。");
  return [...new Set(notes)];
}

function buildCoverageRows(evidence: EvidenceItem[]): Array<{ domain: string; count: number; confidence: number }> {
  const groups = new Map<string, EvidenceItem[]>();
  for (const item of evidence) {
    const domain = item.domain ?? "other";
    groups.set(domain, [...(groups.get(domain) ?? []), item]);
  }
  return [...groups.entries()]
    .map(([domain, items]) => ({ domain, count: items.length, confidence: average(items.map((item) => item.confidence)) }))
    .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain));
}

function buildMetricRows(evidence: EvidenceItem[]): Array<{ metric: string; value: string; period: string; evidenceId: string }> {
  const rows: Array<{ metric: string; value: string; period: string; evidenceId: string }> = [];
  for (const item of evidence) {
    const value = isRecord(item.value) ? item.value : undefined;
    if (!value || typeof value.schema !== "string") continue;
    if (value.schema === "quote.v1") {
      pushMetric(rows, item, "最新价", value.price, value.trade_date ?? item.as_of);
      pushMetric(rows, item, "涨跌幅", percentValue(value.change_pct), value.trade_date ?? item.as_of);
      pushMetric(rows, item, "成交额", value.turnover, value.trade_date ?? item.as_of);
    }
    if (value.schema === "financials.v1") {
      pushMetric(rows, item, "营业收入", value.revenue, value.period ?? item.as_of);
      pushMetric(rows, item, "净利润", value.net_profit, value.period ?? item.as_of);
      pushMetric(rows, item, "毛利率", percentValue(value.gross_margin), value.period ?? item.as_of);
      pushMetric(rows, item, "ROE", percentValue(value.roe), value.period ?? item.as_of);
    }
    if (value.schema === "macro.v1") {
      const macroValue = numberValue(value.value);
      if (macroValue !== undefined) {
        pushMetric(rows, item, String(value.indicator_name ?? "宏观指标"), `${formatNumber(macroValue)}${value.unit ? ` ${value.unit}` : ""}`, value.period ?? item.as_of);
      }
    }
  }
  return rows.slice(0, 12);
}

function buildTechnicalRows(evidence: EvidenceItem[]): Array<{ metric: string; value: string; note: string; evidenceId: string }> {
  const rows: Array<{ metric: string; value: string; note: string; evidenceId: string }> = [];
  for (const item of evidence) {
    const value = isRecord(item.value) ? item.value : undefined;
    if (!value || value.schema !== "quote.v1") continue;

    const price = numberValue(value.price);
    const prevClose = numberValue(value.prev_close);
    const open = numberValue(value.open);
    const high = numberValue(value.high);
    const low = numberValue(value.low);
    const changePct = numberValue(value.change_pct);
    const volume = numberValue(value.volume);
    const turnover = numberValue(value.turnover);

    if (price !== undefined && prevClose !== undefined) {
      rows.push({
        metric: "相对前收盘",
        value: `${formatNumber(price)} / ${formatNumber(prevClose)}`,
        note: changePct !== undefined ? `涨跌幅 ${changePct.toFixed(2)}%` : relativeNote(price, prevClose),
        evidenceId: item.id,
      });
    }
    if (price !== undefined && open !== undefined) {
      rows.push({
        metric: "盘中方向",
        value: formatSpread(price - open),
        note: price >= open ? "当前价高于开盘价" : "当前价低于开盘价",
        evidenceId: item.id,
      });
    }
    if (high !== undefined && low !== undefined) {
      rows.push({
        metric: "日内区间",
        value: `${formatNumber(low)} - ${formatNumber(high)}`,
        note: price !== undefined ? rangePositionNote(price, low, high) : "用于观察波动区间",
        evidenceId: item.id,
      });
    }
    for (const average of movingAverageRows(value, item.id, price)) {
      rows.push(average);
    }
    if (volume !== undefined) {
      rows.push({ metric: "成交量", value: formatNumber(volume), note: "价量确认仍需历史均量对比", evidenceId: item.id });
    }
    if (turnover !== undefined) {
      rows.push({ metric: "成交额", value: formatNumber(turnover), note: "用于衡量当日交易活跃度", evidenceId: item.id });
    }
  }
  return rows.slice(0, 10);
}

function pushMetric(
  rows: Array<{ metric: string; value: string; period: string; evidenceId: string }>,
  evidence: EvidenceItem,
  metric: string,
  value: unknown,
  period: unknown,
): void {
  if (value === undefined || value === null || value === "") return;
  if (typeof value === "number" && !Number.isFinite(value)) return;
  rows.push({
    metric,
    value: typeof value === "number" ? formatNumber(value) : String(value),
    period: typeof period === "string" ? period : evidence.as_of,
    evidenceId: evidence.id,
  });
}

function buildEvidenceUsageMap(
  researchOutput: ResearchOutput | undefined,
  thesisOutput: ResearchOutput | undefined,
  riskOutput: ResearchOutput | undefined,
): Map<string, string[]> {
  const usage = new Map<string, string[]>();
  const add = (ids: string[], label: string) => {
    for (const id of ids) {
      usage.set(id, [...(usage.get(id) ?? []), label]);
    }
  };

  if (researchOutput?.agent_id === "research_evidence") {
    researchOutput.fact_table.forEach((fact, index) => add(fact.evidence_ids, `核心证据#${index + 1}`));
  }
  if (thesisOutput?.agent_id === "thesis_valuation") {
    thesisOutput.theses.forEach((thesis, index) => add(thesis.evidence_ids, `投资观点#${index + 1}`));
    add(thesisOutput.valuation_framework.evidence_ids, "估值框架");
    thesisOutput.scenario_variables.forEach((variable, index) => add(variable.evidence_ids, `情景变量#${index + 1}`));
  }
  if (riskOutput?.agent_id === "risk_report") {
    riskOutput.counter_evidence.forEach((item, index) => add(item.evidence_ids, `反证#${index + 1}`));
    riskOutput.risk_triggers.forEach((trigger, index) => add(trigger.evidence_ids, `风险触发器#${index + 1}`));
  }

  return usage;
}

function formatEvidenceUsage(usage: string[] | undefined): string {
  return usage && usage.length > 0 ? [...new Set(usage)].join("；") : "未被结构化结论引用";
}

function buildStanceText(riskStance: string | undefined, valuationView: string | undefined): string {
  const riskText = riskStance ? translateRiskStance(riskStance) : "风险结论未形成";
  const valuationText = valuationView ? translateValuationView(valuationView) : "估值判断未形成";
  return `${riskText}，${valuationText}`;
}

function translateRiskStance(stance: string): string {
  const labels: Record<string, string> = {
    positive: "正面",
    neutral: "中性",
    negative: "负面",
    mixed: "分歧/审慎",
    insufficient_data: "数据不足",
  };
  return labels[stance] ?? stance;
}

function translateValuationView(view: string): string {
  const labels: Record<string, string> = {
    overvalued: "估值偏高",
    fairly_valued: "估值相对合理",
    undervalued: "估值偏低",
    insufficient_data: "估值数据不足",
  };
  return labels[view] ?? view;
}

function translateDirection(direction: string): string {
  const labels: Record<string, string> = {
    bullish: "看多",
    neutral: "中性",
    bearish: "看空",
    mixed: "分歧",
  };
  return labels[direction] ?? direction;
}

function translateSeverity(severity: string): string {
  const labels: Record<string, string> = {
    low: "低",
    medium: "中",
    high: "高",
  };
  return labels[severity] ?? severity;
}

function riskContradictionPenalty(risk: Extract<ResearchOutput, { agent_id: "risk_report" }>): number {
  const severityPenalty = Math.max(0, ...risk.counter_evidence.map((item) => {
    if (item.severity === "high") return 0.28;
    if (item.severity === "medium") return 0.16;
    return 0.07;
  }));
  const stancePenalty = risk.final_summary.stance === "negative"
    ? 0.12
    : risk.final_summary.stance === "mixed"
      ? 0.06
      : risk.final_summary.stance === "insufficient_data"
        ? 0.18
        : 0;
  const counterEvidenceBreadth = Math.min(0.08, Math.max(0, risk.counter_evidence.length - 1) * 0.03);
  return Math.min(0.45, severityPenalty + stancePenalty + counterEvidenceBreadth);
}

function confidenceLabel(value: number): string {
  if (value <= 0) return "不足";
  const label = value >= 0.7 ? "高" : value >= 0.45 ? "中" : "低";
  return `${label}（${value.toFixed(2)}）`;
}

function citation(ids: string[]): string {
  return ids.length > 0 ? ids.map((id) => `[${md(id)}]`).join(", ") : "待补证据";
}

function average(values: number[]): number {
  const valid = values.filter((value) => Number.isFinite(value));
  if (valid.length === 0) return 0;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function weightedAverage(items: Array<{ value: number; weight: number }>): number {
  const valid = items.filter((item) => Number.isFinite(item.value) && Number.isFinite(item.weight) && item.weight > 0);
  const totalWeight = valid.reduce((sum, item) => sum + item.weight, 0);
  if (totalWeight === 0) return 0;
  return valid.reduce((sum, item) => sum + item.value * item.weight, 0) / totalWeight;
}

function evidenceSupportWeight(ids: string[], evidenceById: Map<string, EvidenceItem>): number {
  const cited = ids.map((id) => evidenceById.get(id)).filter((item): item is EvidenceItem => Boolean(item));
  if (cited.length === 0) return 0.25;
  const countWeight = 1 + Math.min(3, cited.length) * 0.2;
  const qualityWeight = 0.5 + average(cited.map((item) => item.confidence));
  return countWeight * qualityWeight;
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function percentValue(value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(2)}%` : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function numberFromKeys(value: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const parsed = numberValue(value[key]);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function movingAverageRows(
  value: Record<string, unknown>,
  evidenceId: string,
  price: number | undefined,
): Array<{ metric: string; value: string; note: string; evidenceId: string }> {
  const configs = [
    { label: "MA5", keys: ["ma5", "ma_5", "moving_average_5"] },
    { label: "MA10", keys: ["ma10", "ma_10", "moving_average_10"] },
    { label: "MA20", keys: ["ma20", "ma_20", "moving_average_20"] },
    { label: "MA60", keys: ["ma60", "ma_60", "moving_average_60"] },
  ];
  return configs.flatMap((config) => {
    const averageValue = numberFromKeys(value, config.keys);
    if (averageValue === undefined) return [];
    return [{
      metric: `${config.label} 位置`,
      value: formatNumber(averageValue),
      note: price !== undefined ? relativeNote(price, averageValue) : "均线数据来自行情证据",
      evidenceId,
    }];
  });
}

function relativeNote(left: number, right: number): string {
  if (left === right) return "基本持平";
  return left > right ? "当前价位于对比值上方" : "当前价位于对比值下方";
}

function rangePositionNote(price: number, low: number, high: number): string {
  if (high <= low) return "区间数据不足";
  const position = (price - low) / (high - low);
  if (position >= 0.75) return "当前价接近日内高位";
  if (position <= 0.25) return "当前价接近日内低位";
  return "当前价位于日内区间中部";
}

function formatSpread(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${formatNumber(value)}`;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "不可用";
  return Number.isInteger(value) ? value.toLocaleString("en-US") : value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function md(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
