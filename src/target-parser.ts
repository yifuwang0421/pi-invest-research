import type { NormalizedResearchRequest, ResearchRequest, TaskType } from "./schemas.js";

const A_SHARE_HINTS = ["茅台", "宁德", "贵州", "A股", "上证", "深证", "创业板"];

export function normalizeResearchRequest(input: ResearchRequest): NormalizedResearchRequest {
  const task_type = input.task_type ?? inferTaskType(input.request);
  const market = input.market ?? inferMarket(input.request);
  const target = input.target ?? inferTarget(input.request);
  return {
    ...input,
    request: input.request.trim(),
    task_type,
    output_format: input.output_format ?? "markdown",
    ...(market ? { market } : {}),
    ...(target ? { target } : {}),
  };
}

export function inferTaskType(request: string): TaskType {
  const text = request.toLowerCase();
  if (containsAny(text, ["技术", "k线", "均线", "量价", "复盘", "动量"])) return "technical_review";
  if (containsAny(text, ["风险", "回撤", "暴露", "集中度", "风控"])) return "risk_review";
  if (containsAny(text, ["估值", "dcf", "目标价", "预测", "盈利预测"])) return "valuation";
  if (containsAny(text, ["新闻", "公告", "事件", "舆情"])) return "news_event";
  if (containsAny(text, ["深度", "完整", "全面", "报告", "研究"])) return "deep_research";
  return "general";
}

export function inferMarket(request: string): ResearchRequest["market"] | undefined {
  if (A_SHARE_HINTS.some((hint) => request.includes(hint))) return "A-share";
  if (containsAny(request, ["港股", "恒生", "HK"])) return "HK";
  if (containsAny(request, ["美股", "纳斯达克", "NYSE", "NASDAQ", "NVDA", "TSLA"])) return "US";
  if (containsAny(request, ["基金", "ETF"])) return "fund";
  if (containsAny(request, ["宏观", "利率", "社融", "PMI"])) return "macro";
  return undefined;
}

export function inferTarget(request: string): string | undefined {
  const trimmed = request.replace(/^对/, "").trim();
  const known = ["贵州茅台", "宁德时代", "英伟达", "NVDA", "茅台"];
  const found = known.find((name) => trimmed.includes(name));
  if (found === "茅台") return "贵州茅台";
  if (found) return found;

  const stockCode = trimmed.match(/\b(?:60|00|30|68)\d{4}\b/);
  if (stockCode) return stockCode[0];

  const parenTicker = trimmed.match(/[（(]([A-Z]{1,6})[）)]/);
  if (parenTicker?.[1]) return parenTicker[1];

  return undefined;
}

function containsAny(text: string, terms: string[]): boolean {
  return terms.some((term) => text.includes(term.toLowerCase()));
}
