# pi-invest-research

`pi-invest-research` 是一个独立可运行的投研 Agent，同时保留 Pi 扩展兼容能力。它提供 `analyst-agent` CLI、三段式子 agent 编排、iFinD MCP 证据采集、OpenAI-compatible LLM 调用、评审门禁、Markdown 报告和可审计运行产物。

## 能力概览

- CLI 命令：`analyst-agent --request "做宁德时代深度研究"`。
- NPM 脚本：`npm run agent -- --request "做宁德时代深度研究"`。
- Pi 兼容工具：`invest_research({ request, target?, market?, task_type?, horizon?, output_format?, use_live_ifind?, sources?, llm? })`。
- 三个压缩后的子 agent：
  - `research_evidence`：研究与证据，负责事实、证据和数据缺口。
  - `thesis_valuation`：观点与估值，负责 thesis、盈利驱动、估值框架和情景假设。
  - `risk_report`：风险与报告，负责反证、风险触发条件、证据引用检查和最终报告摘要。
- 选择性调度：深度研究、估值、新闻事件走三 agent 全流程；技术复盘和风险检查走较轻的 `research_evidence -> risk_report`。
- Hermes-style 委托 trace：每个子 agent 都有独立上下文、独立终端会话 ID、独立工作区 ID、禁止共享记忆、禁止直接追问用户、禁止外部副作用，并通过 summary-only 的方式向父 agent 回传结果。
- 证据源：支持实时 iFinD MCP 和 fixture/mock 证据；`web_search` 和 `knowledge_base` 类型已预留给后续扩展。
- 运行产物：每次 CLI 运行可生成 `report.md`、`evidence-ledger.json` 和 `trace.json`。

## 委托模型

编排器借鉴 Hermes Agent 的安全委托思路，但本包不是通用 agent runtime，而是投研任务专用运行时：

- 父上下文保持紧凑：子 agent 只接收明确任务、证据、数据缺口和上游摘要。
- 子 agent 默认是 leaf worker：不能向用户追问，不能写共享记忆，不能产生外部副作用。
- 可独立执行的子任务会并行运行，默认最大并发为 `3`。
- 有依赖的任务会等待上游结果；例如 `risk_report` 会等待 `research_evidence` 和 `thesis_valuation` 的摘要。
- `trace.json` 会记录 plan、delegation policy、subagent results 和每个子 agent 的执行元数据，便于审计。

## 安装与构建

```powershell
npm.cmd install
npm.cmd run build
npm.cmd run typecheck
npm.cmd test
```

如果 PowerShell 执行策略阻止 `npm`，请使用 `npm.cmd`。

## 离线验收

离线验收不依赖 LLM key 或 iFinD token：

```powershell
npm.cmd run agent -- --request "做宁德时代深度研究" --no-live-ifind --fixture tests/fixtures/basic-evidence.json --out reports/demo
```

预期生成：

- `reports/demo/report.md`
- `reports/demo/evidence-ledger.json`
- `reports/demo/trace.json`

## 直接启动 CLI

在项目目录内运行：

```powershell
npm.cmd run agent -- --request "做贵州茅台深度研究" --out reports/maotai
```

也可以直接运行编译后的入口：

```powershell
node dist/src/cli.js --request "做宁德时代深度研究" --no-live-ifind --fixture tests/fixtures/basic-evidence.json --out reports/catl
```

如需在任意目录使用 `analyst-agent` 命令，先执行：

```powershell
npm.cmd link
```

然后运行：

```powershell
analyst-agent --request "做贵州茅台深度研究" --out reports/maotai
```

## 使用 DeepSeek 作为真实 LLM

本项目通过 OpenAI-compatible Chat Completions 接口调用模型，因此 DeepSeek 可以直接通过环境变量配置：

```powershell
$env:OPENAI_API_KEY="你的 DeepSeek API Key"
$env:OPENAI_BASE_URL="https://api.deepseek.com"
$env:OPENAI_MODEL="deepseek-v4-pro"

npm.cmd run agent -- --request "做贵州茅台深度研究" --out reports/maotai-deepseek
```

如需离线验证流程，但不调用真实 LLM，请加 `--fixture`：

```powershell
npm.cmd run agent -- --request "做贵州茅台深度研究" --no-live-ifind --fixture tests/fixtures/basic-evidence.json --out reports/maotai-fixture
```

## CLI 参数

- `--request <text>`：必填，自然语言研究请求。
- `--target <text>`：可选，股票、公司、基金、行业或宏观指标。
- `--market <market>`：可选，`A-share`、`HK`、`US`、`fund`、`macro` 或 `unknown`。
- `--task-type <type>`：可选，`deep_research`、`technical_review`、`risk_review`、`valuation`、`news_event` 或 `general`。
- `--out <dir>`：输出目录，默认是 `reports/run-<timestamp>`。
- `--format <format>`：输出格式，`markdown` 或 `json`，默认 `markdown`。
- `--no-live-ifind`：禁用实时 iFinD 调用。
- `--fixture [path]`：使用 fixture 证据和 mock LLM，适合离线验收。

## 环境变量

- `OPENAI_API_KEY`：真实 LLM 调用所需的 API key。
- `OPENAI_BASE_URL`：OpenAI-compatible Chat Completions base URL，默认 `https://api.openai.com/v1`。
- `OPENAI_MODEL`：模型名称，默认 `gpt-4.1-mini`。
- `IFIND_MCP_AUTH_TOKEN`：可选，iFinD MCP bearer token。
- `IFIND_STOCK_MCP_URL`、`IFIND_FUND_MCP_URL`、`IFIND_NEWS_MCP_URL`、`IFIND_EDB_MCP_URL`：可选，iFinD endpoint override。

## 验收标准

基础质量：

```powershell
npm.cmd run typecheck
npm.cmd run build
npm.cmd test
```

离线 CLI：

```powershell
npm.cmd run agent -- --request "做宁德时代深度研究" --no-live-ifind --fixture tests/fixtures/basic-evidence.json --out reports/acceptance-offline
```

真实 LLM：

```powershell
$env:OPENAI_API_KEY="你的 DeepSeek API Key"
$env:OPENAI_BASE_URL="https://api.deepseek.com"
$env:OPENAI_MODEL="deepseek-v4-pro"
npm.cmd run agent -- --request "做贵州茅台深度研究" --out reports/acceptance-deepseek
```

预期：

- 测试全部通过。
- CLI 能生成 `report.md`、`evidence-ledger.json`、`trace.json`。
- 报告是可读中文，没有乱码。
- trace 中只出现三个子 agent：`research_evidence`、`thesis_valuation`、`risk_report`。
- trace 中每个子 agent 都有 `context_id`、`terminal_session_id` 和 `workspace_id`。

## 安全说明

不要提交 API key、MCP token、投研凭证或专有数据。所有密钥都应通过环境变量传入。
