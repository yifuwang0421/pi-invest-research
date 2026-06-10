import { IFindMcpAdapter } from "./ifind-adapter.js";
import type {
  DataGap,
  EvidenceItem,
  EvidenceProvider,
  IFindQueryRequest,
  IFindQueryResult,
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

  async collect(task: SubagentTask): Promise<IFindQueryResult> {
    const requests = buildIFindRequests(task);
    const results = await Promise.all(requests.map((request) => this.adapter.queryIFind(request)));
    return {
      evidence: results.flatMap((result) => result.evidence),
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

  async collect(task: SubagentTask): Promise<IFindQueryResult> {
    if (this.evidence.length > 0 || this.dataGaps.length > 0) {
      return {
        evidence: this.evidence.map((item) => ({
          ...item,
          id: item.id.includes(task.agent_id) ? item.id : `${item.id}-${task.agent_id}`,
          query: item.query || task.task,
        })),
        data_gaps: this.dataGaps,
      };
    }

    const retrievedAt = this.clock().toISOString();
    return {
      evidence: [
        {
          id: `fixture-${task.agent_id}-${safeId(task.target)}`,
          source_type: "mock",
          source_name: "fixture-source",
          query: task.task,
          as_of: retrievedAt.slice(0, 10),
          retrieved_at: retrievedAt,
          confidence: 0.72,
          value: {
            target: task.target,
            agent_id: task.agent_id,
            note: "离线 fixture 证据，用于 CLI 验收和无凭证环境。",
          },
        },
      ],
      data_gaps: [],
    };
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
): Promise<IFindQueryResult> {
  if (providers.length === 0) {
    const occurredAt = new Date().toISOString();
    return {
      evidence: [],
      data_gaps: [
        {
          source_name: "source-provider",
          query: task.task,
          reason: "未启用任何证据源。",
          occurred_at: occurredAt,
        },
      ],
    };
  }

  const results = await Promise.all(providers.map((provider) => provider.collect(task)));
  return {
    evidence: results.flatMap((result) => result.evidence),
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

function safeId(value: string): string {
  return value.replace(/[^\p{Letter}\p{Number}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 32).toLowerCase() || "target";
}
