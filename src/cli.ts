#!/usr/bin/env node
import type { OutputFormat, ResearchRequest, TaskType } from "./schemas.js";
import { type AnalystAgentRunOptions, runAnalystAgent } from "./runner.js";

interface CliArgs {
  request?: string;
  target?: string;
  market?: ResearchRequest["market"];
  taskType?: TaskType;
  out?: string;
  format?: OutputFormat;
  useLiveIFind: boolean;
  fixture?: string | true;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.request) {
    throw new Error("缺少必填参数 --request。");
  }

  const usesFixture = args.fixture !== undefined;
  if (!usesFixture && !process.env.OPENAI_API_KEY) {
    throw new Error("缺少 OPENAI_API_KEY。使用真实 LLM 时必须配置该变量；离线验收可使用 --fixture。");
  }

  const input: ResearchRequest = {
    request: args.request,
    output_format: args.format ?? "markdown",
    use_live_ifind: args.useLiveIFind,
    ...(args.target ? { target: args.target } : {}),
    ...(args.market ? { market: args.market } : {}),
    ...(args.taskType ? { task_type: args.taskType } : {}),
    ...(usesFixture ? { sources: ["fixture"] } : {}),
  };
  const outputDir = args.out ?? defaultOutputDir();
  const runOptions: AnalystAgentRunOptions = {
    outputDir,
    mockLLM: usesFixture,
  };
  if (typeof args.fixture === "string") {
    runOptions.fixturePath = args.fixture;
  }
  const result = await runAnalystAgent(input, runOptions);

  if (result.clarification_question) {
    console.log(result.clarification_question);
    return;
  }

  if (!result.report) {
    throw new Error("agent 未返回报告。");
  }

  if (args.format === "json") {
    console.log(JSON.stringify({
      target: result.report.target,
      selected_agents: result.report.selected_agents,
      artifacts: result.artifacts,
    }, null, 2));
    return;
  }

  console.log(result.report.markdown);
  if (result.artifacts) {
    console.log("");
    console.log(`Artifacts written:`);
    console.log(`- report: ${result.artifacts.report}`);
    console.log(`- evidence_ledger: ${result.artifacts.evidence_ledger}`);
    console.log(`- trace: ${result.artifacts.trace}`);
  }
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    useLiveIFind: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      case "--request":
        args.request = requireValue(argv, index, token);
        index += 1;
        break;
      case "--target":
        args.target = requireValue(argv, index, token);
        index += 1;
        break;
      case "--market":
        args.market = requireValue(argv, index, token) as ResearchRequest["market"];
        index += 1;
        break;
      case "--task-type":
        args.taskType = requireValue(argv, index, token) as TaskType;
        index += 1;
        break;
      case "--out":
        args.out = requireValue(argv, index, token);
        index += 1;
        break;
      case "--format":
        args.format = requireValue(argv, index, token) as OutputFormat;
        index += 1;
        break;
      case "--no-live-ifind":
        args.useLiveIFind = false;
        break;
      case "--fixture": {
        const next = argv[index + 1];
        if (next && !next.startsWith("--")) {
          args.fixture = next;
          index += 1;
        } else {
          args.fixture = true;
        }
        break;
      }
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      default:
        throw new Error(`未知参数：${token}`);
    }
  }

  return args;
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} 需要一个值。`);
  }
  return value;
}

function defaultOutputDir(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `reports/run-${stamp}`;
}

function printHelp(): void {
  console.log(`analyst-agent

Usage:
  analyst-agent --request "做宁德时代深度研究" [options]

Options:
  --request <text>       必填，自然语言研究请求
  --target <text>        标的、行业或宏观指标
  --market <market>      A-share | HK | US | fund | macro | unknown
  --task-type <type>     deep_research | technical_review | risk_review | valuation | news_event | general
  --out <dir>            输出目录，默认 reports/run-<timestamp>
  --format <format>      markdown | json，默认 markdown
  --no-live-ifind        不调用实时 iFinD
  --fixture [path]       使用 fixture 证据和 mock LLM 离线运行
`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
