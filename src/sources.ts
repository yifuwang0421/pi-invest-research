import { IFindMcpAdapter } from "./ifind-adapter.js";
import { dedupeEvidence, makeDataGap, normalizeExistingEvidence, normalizeRawEvidence } from "./evidence.js";
import type {
  DataGap,
  EvidenceCollectionResult,
  EvidenceIntent,
  EvidenceItem,
  EvidenceProvider,
  IFindQueryRequest,
  ResearchDataAdapters,
  SubagentId,
  SubagentTask,
} from "./schemas.js";

export interface SourceProviderOptions {
  ifindAdapter?: ResearchDataAdapters;
  fixtureEvidence?: EvidenceItem[];
  fixtureDataGaps?: DataGap[];
}

export class IFindEvidenceProvider implements EvidenceProvider {
  readonly name = "ifind" as const;

  constructor(private readonly adapter: ResearchDataAdapters = new IFindMcpAdapter()) {}

  async collect(task: SubagentTask): Promise<EvidenceCollectionResult> {
    const requests = buildIFindRequests(task);
    const results = await Promise.all(requests.map((request) => this.adapter.queryIFind(request)));
    return {
      evidence: dedupeEvidence(results.flatMap((result) => result.evidence)),
      data_gaps: results.flatMap((result) => result.data_gaps),
    };
  }
}

export class FixtureEvidenceProvider implements EvidenceProvider {
  readonly name = "fixture" as const;

  constructor(
    private readonly evidence: EvidenceItem[] = [],
    private readonly dataGaps: DataGap[] = [],
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async collect(task: SubagentTask): Promise<EvidenceCollectionResult> {
    if (this.evidence.length > 0 || this.dataGaps.length > 0) {
      const evidence = this.evidence.map((item) => ({
        ...item,
        id: item.id.endsWith(`-${task.agent_id}`) ? item.id : `${item.id}-${task.agent_id}`,
        query: item.query || task.task,
      }));
      return {
        evidence: normalizeExistingEvidence(evidence),
        data_gaps: this.dataGaps,
      };
    }

    const retrievedAt = this.clock().toISOString();
    return normalizeRawEvidence({
      source_type: "mock",
      vendor: "fixture",
      source_name: "fixture-source",
      query: task.task,
      target: task.target,
      intent: intentForTask(task),
      retrieved_at: retrievedAt,
      raw: buildFixturePayload(task, retrievedAt),
    });
  }
}

export function createEvidenceProviders(
  sourceNames: Array<"ifind" | "fixture">,
  options: SourceProviderOptions = {},
): EvidenceProvider[] {
  return sourceNames.map((sourceName) => {
    if (sourceName === "fixture") {
      return new FixtureEvidenceProvider(options.fixtureEvidence, options.fixtureDataGaps);
    }
    return new IFindEvidenceProvider(options.ifindAdapter);
  });
}

export async function collectEvidenceForTask(
  task: SubagentTask,
  providers: EvidenceProvider[],
): Promise<EvidenceCollectionResult> {
  if (providers.length === 0) {
    const occurredAt = new Date().toISOString();
    return {
      evidence: [],
      data_gaps: [
        makeDataGap({
          source_name: "source-provider",
          query: task.task,
          reason: "No evidence provider is enabled.",
          reason_code: "source_unavailable",
          occurred_at: occurredAt,
        }),
      ],
    };
  }

  const results = await Promise.all(providers.map((provider) => provider.collect(task)));
  return {
    evidence: dedupeEvidence(results.flatMap((result) => result.evidence)),
    data_gaps: results.flatMap((result) => result.data_gaps),
  };
}

export function buildIFindRequests(task: SubagentTask): IFindQueryRequest[] {
  switch (task.agent_id) {
    case "research_evidence":
      return [
        { server: "edb", intent: "macro", target: task.target, query: `${task.target} 行业 指标 供需` },
        { server: "stock", intent: "profile", target: task.target, query: `${task.target} 公司基础资料` },
        { server: "stock", intent: "financials", target: task.target, query: `${task.target} 财务摘要` },
        { server: "stock", intent: "quote", target: task.target, query: `${task.target} 近一个月行情 量价` },
        { server: "news", intent: "news", target: task.target, query: `${task.target} 最新新闻 公告` },
      ];
    case "thesis_valuation":
      return [
        { server: "stock", intent: "financials", target: task.target, query: `${task.target} 盈利预测 估值 财务` },
        { server: "news", intent: "news", target: task.target, query: `${task.target} 经营变化 业绩驱动` },
      ];
    case "risk_report":
      return [
        { server: "stock", intent: "quote", target: task.target, query: `${task.target} 行情 波动 风险` },
        { server: "news", intent: "news", target: task.target, query: `${task.target} 风险 新闻 公告` },
      ];
  }
}

export function requiredEvidenceFor(agent_id: SubagentId): string[] {
  switch (agent_id) {
    case "research_evidence":
      return ["行业/公司/财务/行情/新闻证据", "数据缺口说明"];
    case "thesis_valuation":
      return ["财务摘要", "估值或情景假设", "关键驱动证据"];
    case "risk_report":
      return ["风险事件证据", "上游 agent 证据引用", "反证检查"];
  }
}

function intentForTask(task: SubagentTask): EvidenceIntent {
  if (task.agent_id === "thesis_valuation") return "financials";
  if (task.agent_id === "risk_report") return "news";
  return "quote";
}

function buildFixturePayload(task: SubagentTask, retrievedAt: string): unknown {
  if (task.agent_id === "thesis_valuation") {
    return {
      symbol: task.target,
      name: task.target,
      period: "2026Q1",
      report_type: "quarterly",
      revenue: 79700000000,
      net_profit: 10500000000,
      gross_margin: 24.5,
      roe: 6.7,
      total_assets: 765000000000,
      total_equity: 285000000000,
      operating_cash_flow: 13200000000,
      currency: "CNY",
    };
  }
  if (task.agent_id === "risk_report") {
    return {
      title: `${task.target} risk update`,
      published_at: retrievedAt,
      source: "fixture-source",
      related_symbols: [task.target],
      summary: "Offline risk evidence for deterministic validation.",
      sentiment: "neutral",
    };
  }
  return {
    symbol: task.target,
    name: task.target,
    market: "A-share",
    price: 245.6,
    open: 242.1,
    high: 248.2,
    low: 240.3,
    prev_close: 241.26,
    change_pct: 1.8,
    volume: 12345678,
    turnover: 3012345678,
    trade_date: retrievedAt.slice(0, 10),
  };
}
