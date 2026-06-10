import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createMockLLMAdapter, createOpenAICompatibleLLMAdapter } from "./llm.js";
import type { OpenAICompatibleLLMOptions } from "./llm.js";
import { investResearch } from "./orchestrator.js";
import type {
  DataGap,
  EvidenceItem,
  EvidenceProvider,
  FinalReport,
  LLMAdapter,
  ResearchRequest,
  SubagentId,
} from "./schemas.js";
import { createEvidenceProviders } from "./sources.js";
import { SUBAGENT_PROFILES } from "./subagents.js";

export interface AnalystAgentRunOptions {
  outputDir?: string;
  fixturePath?: string;
  mockLLM?: boolean;
  llmAdapter?: LLMAdapter;
  evidenceProviders?: EvidenceProvider[];
}

export interface AnalystAgentRunResult {
  report?: FinalReport;
  clarification_question?: string;
  artifacts?: {
    report: string;
    evidence_ledger: string;
    trace: string;
  };
}

interface FixturePayload {
  evidence?: EvidenceItem[];
  data_gaps?: DataGap[];
}

export async function runAnalystAgent(
  input: ResearchRequest,
  options: AnalystAgentRunOptions = {},
): Promise<AnalystAgentRunResult> {
  const fixture = options.fixturePath ? await readFixture(options.fixturePath) : undefined;
  const sourceNames = input.sources ?? (fixture ? ["fixture"] : input.use_live_ifind === false ? [] : ["ifind"]);
  const sourceOptions = {
    ...(fixture?.evidence ? { fixtureEvidence: fixture.evidence } : {}),
    ...(fixture?.data_gaps ? { fixtureDataGaps: fixture.data_gaps } : {}),
  };
  const evidenceProviders = options.evidenceProviders ?? createEvidenceProviders(sourceNames, sourceOptions);
  const llmOptions: OpenAICompatibleLLMOptions = {};
  if (input.llm?.base_url) llmOptions.baseUrl = input.llm.base_url;
  if (input.llm?.model) llmOptions.model = input.llm.model;
  const llmAdapter = options.llmAdapter ?? (options.mockLLM ? createMockLLMAdapter() : createOpenAICompatibleLLMAdapter(llmOptions));
  const skillTextByAgent = await loadSkillTextByAgent();
  const result = await investResearch(
    {
      ...input,
      sources: sourceNames,
    },
    {
      evidenceProviders,
      llmAdapter,
      skillTextByAgent,
    },
  );

  if ("clarification_question" in result) {
    return { clarification_question: result.clarification_question };
  }

  const artifacts = options.outputDir ? await writeRunArtifacts(result, options.outputDir) : undefined;
  return {
    report: result,
    ...(artifacts ? { artifacts } : {}),
  };
}

export async function writeRunArtifacts(
  report: FinalReport,
  outputDir: string,
): Promise<AnalystAgentRunResult["artifacts"]> {
  const dir = resolve(outputDir);
  await mkdir(dir, { recursive: true });
  const reportPath = resolve(dir, "report.md");
  const ledgerPath = resolve(dir, "evidence-ledger.json");
  const tracePath = resolve(dir, "trace.json");
  await writeFile(reportPath, report.markdown, "utf8");
  await writeFile(ledgerPath, `${JSON.stringify(report.evidence_ledger, null, 2)}\n`, "utf8");
  await writeFile(tracePath, `${JSON.stringify(report.trace, null, 2)}\n`, "utf8");
  return {
    report: reportPath,
    evidence_ledger: ledgerPath,
    trace: tracePath,
  };
}

async function loadSkillTextByAgent(): Promise<Partial<Record<SubagentId, string>>> {
  const entries = await Promise.all(
    Object.values(SUBAGENT_PROFILES).map(async (profile) => {
      const skillFolder = profile.skills[0];
      if (!skillFolder) return [profile.id, ""] as const;
      try {
        const url = new URL(`../../skills/${skillFolder}/SKILL.md`, import.meta.url);
        return [profile.id, await readFile(url, "utf8")] as const;
      } catch {
        return [profile.id, ""] as const;
      }
    }),
  );
  return Object.fromEntries(entries);
}

async function readFixture(path: string): Promise<FixturePayload> {
  const text = await readFile(resolve(path), "utf8");
  const parsed = JSON.parse(text) as FixturePayload | EvidenceItem[];
  if (Array.isArray(parsed)) {
    return { evidence: parsed };
  }
  return {
    evidence: Array.isArray(parsed.evidence) ? parsed.evidence : [],
    data_gaps: Array.isArray(parsed.data_gaps) ? parsed.data_gaps : [],
  };
}
