import { investResearch } from "./orchestrator.js";
import type { ResearchRequest } from "./schemas.js";

interface PiToolDefinition {
  name: string;
  label?: string;
  description: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: ResearchRequest,
    signal?: AbortSignal,
    onUpdate?: (update: unknown) => void,
    ctx?: unknown,
  ) => Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
}

interface PiLikeApi {
  registerTool?: (tool: PiToolDefinition) => void;
  tools?: {
    register?: (tool: PiToolDefinition) => void;
  };
}

export function createInvestResearchTool(): PiToolDefinition {
  return {
    name: "invest_research",
    label: "Invest Research",
    description:
      "Run an investment research workflow with selective analyst subagents, iFind MCP evidence, review gates, and a Markdown final report.",
    parameters: {
      type: "object",
      properties: {
        request: { type: "string", description: "Natural-language research request." },
        target: { type: "string", description: "Ticker, company, fund, industry, or macro target." },
        market: { type: "string", enum: ["A-share", "HK", "US", "fund", "macro", "unknown"] },
        task_type: {
          type: "string",
          enum: ["deep_research", "technical_review", "risk_review", "valuation", "news_event", "general"],
        },
        horizon: { type: "string" },
        output_format: { type: "string", enum: ["markdown", "json"] },
        use_live_ifind: { type: "boolean" },
      },
      required: ["request"],
      additionalProperties: false,
    },
    execute: async (_toolCallId, params, signal) => {
      const result = await investResearch(params, signal ? { signal } : {});
      if ("clarification_question" in result) {
        return {
          content: [{ type: "text", text: result.clarification_question }],
          details: result,
        };
      }
      return {
        content: [{ type: "text", text: result.markdown }],
        details: {
          selected_agents: result.selected_agents,
          evidence_ledger: result.evidence_ledger,
          data_gaps: result.data_gaps,
          review_results: result.review_results,
          trace: result.trace,
        },
      };
    },
  };
}

export default function piInvestResearchExtension(api: PiLikeApi): void {
  const tool = createInvestResearchTool();
  if (api.registerTool) {
    api.registerTool(tool);
    return;
  }
  api.tools?.register?.(tool);
}
