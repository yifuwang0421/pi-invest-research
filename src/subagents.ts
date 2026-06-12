import type { SubagentId, SubagentProfile } from "./schemas.js";
import { SUBAGENT_OUTPUT_CONTRACTS } from "./output-contracts.js";

export const SUBAGENT_PROFILES: { [TAgent in SubagentId]: SubagentProfile<TAgent> } = {
  research_evidence: {
    id: "research_evidence",
    name: "研究与证据",
    role: "收集并整理行业、公司、财务、行情、新闻和宏观证据，形成事实摘要、初步观察和数据缺口。",
    skills: ["research-evidence"],
    boundaries: ["不独立给出目标价", "不把观察写成最终投资结论", "不隐藏证据缺口"],
    output_contract: SUBAGENT_OUTPUT_CONTRACTS.research_evidence,
  },
  thesis_valuation: {
    id: "thesis_valuation",
    name: "观点与估值",
    role: "基于证据形成投资 thesis、盈利驱动、估值框架、情景假设和关键变量。",
    skills: ["thesis-valuation"],
    boundaries: ["估值必须写明假设", "不能把缺证据假设写成事实", "不负责最终风控背书"],
    output_contract: SUBAGENT_OUTPUT_CONTRACTS.thesis_valuation,
  },
  risk_report: {
    id: "risk_report",
    name: "风险与报告",
    role: "反证投资 thesis、识别风险触发条件、检查证据引用，并整合为最终结构化投研报告。",
    skills: ["risk-report"],
    boundaries: ["不新增未证实事实", "不隐藏数据缺口", "不替 thesis agent 美化结论"],
    output_contract: SUBAGENT_OUTPUT_CONTRACTS.risk_report,
  },
};

export const ALL_SUBAGENT_IDS = Object.keys(SUBAGENT_PROFILES) as SubagentId[];
