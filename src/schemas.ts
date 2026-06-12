export type TaskType =
  | "deep_research"
  | "technical_review"
  | "risk_review"
  | "valuation"
  | "news_event"
  | "general";

export type OutputFormat = "markdown" | "json";

export type ResearchSourceName = "ifind" | "fixture";

export type DelegationMode = "single" | "batch";

export type SubagentRole = "leaf" | "orchestrator";

export type SubagentExecutionStatus = "completed" | "failed";

export type SubagentId =
  | "research_evidence"
  | "thesis_valuation"
  | "risk_report";

export type EvidenceSourceType =
  | "ifind_mcp"
  | "api"
  | "knowledge_base"
  | "web_search"
  | "mock"
  | "manual";

export type EvidenceSourceServer = string;

export type EvidenceDomain =
  | "quote"
  | "financials"
  | "announcement"
  | "news"
  | "profile"
  | "macro";

export type EvidenceIntent = EvidenceDomain;

export type EvidenceSchemaVersion = "evidence.v1";

export type SubagentOutputSchemaVersion = "subagent-output.v1";

export type DataGapReasonCode =
  | "transport_error"
  | "tool_missing"
  | "parse_error"
  | "schema_invalid"
  | "stale_data"
  | "empty_result"
  | "source_unavailable";

export interface EvidenceSourceMeta {
  vendor: string;
  server?: EvidenceSourceServer;
  tool?: string;
  endpoint?: string;
  ref?: string;
  retrieved_at: string;
  as_of: string;
  query: string;
  target?: string;
  raw_hash: string;
}

export interface EvidenceQuality {
  confidence: number;
  freshness: number;
  completeness: number;
  dedupe_key: string;
  warnings: string[];
}

export interface QuoteEvidenceValue {
  schema: "quote.v1";
  symbol: string;
  name: string;
  market: string;
  price: number;
  open?: number;
  high?: number;
  low?: number;
  prev_close: number;
  change_pct: number;
  volume: number;
  turnover: number;
  trade_date: string;
}

export interface FinancialsEvidenceValue {
  schema: "financials.v1";
  symbol: string;
  name: string;
  period: string;
  report_type: string;
  revenue: number;
  net_profit: number;
  gross_margin: number;
  roe: number;
  total_assets: number;
  total_equity?: number;
  operating_cash_flow: number;
  currency: string;
}

export interface AnnouncementEvidenceValue {
  schema: "announcement.v1";
  symbol: string;
  name: string;
  title: string;
  published_at: string;
  category: string;
  source_url?: string;
  source_id?: string;
  summary: string;
}

export interface NewsEvidenceValue {
  schema: "news.v1";
  title: string;
  published_at: string;
  source: string;
  related_symbols: string[];
  summary: string;
  sentiment?: "positive" | "neutral" | "negative";
}

export interface ProfileEvidenceValue {
  schema: "profile.v1";
  symbol: string;
  name: string;
  market: string;
  industry: string;
  business_scope: string;
  as_of: string;
}

export interface MacroEvidenceValue {
  schema: "macro.v1";
  indicator_name: string;
  region: string;
  frequency: string;
  value: number;
  unit: string;
  period: string;
}

export type StructuredEvidenceValue =
  | QuoteEvidenceValue
  | FinancialsEvidenceValue
  | AnnouncementEvidenceValue
  | NewsEvidenceValue
  | ProfileEvidenceValue
  | MacroEvidenceValue
  | Record<string, unknown>;

export interface ResearchRequest {
  request: string;
  target?: string;
  market?: "A-share" | "HK" | "US" | "fund" | "macro" | "unknown";
  task_type?: TaskType;
  horizon?: string;
  output_format?: OutputFormat;
  use_live_ifind?: boolean;
  llm?: {
    provider: "openai-compatible";
    model?: string;
    base_url?: string;
  };
  sources?: ResearchSourceName[];
}

export type NormalizedResearchRequest = ResearchRequest & {
  request: string;
  task_type: TaskType;
  output_format: OutputFormat;
};

export interface EvidenceItem {
  schema_version?: EvidenceSchemaVersion;
  id: string;
  domain?: EvidenceDomain;
  source_type: EvidenceSourceType;
  source_name: string;
  query: string;
  as_of: string;
  retrieved_at: string;
  confidence: number;
  source_meta?: EvidenceSourceMeta;
  quality?: EvidenceQuality;
  value?: unknown;
  raw_text?: string;
  raw_ref?: string;
}

export interface DataGap {
  source_name: string;
  query: string;
  reason: string;
  occurred_at: string;
  reason_code?: DataGapReasonCode;
  source_meta?: EvidenceSourceMeta;
}

export interface Finding {
  statement: string;
  evidence_ids: string[];
  confidence: number;
  is_assumption?: boolean;
}

export interface SubagentOutputContract<TAgent extends SubagentId = SubagentId> {
  schema_version: SubagentOutputSchemaVersion;
  agent_id: TAgent;
  description: string;
  required_fields: string[];
  optional_fields?: string[];
  example_shape: SubagentStructuredOutputByAgent[TAgent];
}

export interface ResearchEvidenceFact {
  fact: string;
  domain: EvidenceDomain | "other";
  evidence_ids: string[];
  confidence: number;
  as_of: string;
  is_assumption?: boolean;
}

export interface ResearchEvidenceDataGap {
  topic: string;
  reason: string;
  needed_evidence?: string;
  impact?: string;
}

export interface EvidenceCoverage {
  covered_domains: string[];
  missing_domains: string[];
  notes: string;
}

export interface ResearchEvidenceStructuredOutput {
  schema_version: SubagentOutputSchemaVersion;
  agent_id: "research_evidence";
  fact_table: ResearchEvidenceFact[];
  data_gaps: ResearchEvidenceDataGap[];
  evidence_coverage: EvidenceCoverage;
}

export type ThesisDirection = "bullish" | "neutral" | "bearish" | "mixed";
export type ValuationView = "overvalued" | "fairly_valued" | "undervalued" | "insufficient_data";

export interface ThesisItem {
  statement: string;
  direction: ThesisDirection;
  evidence_ids: string[];
  confidence: number;
}

export interface ValuationFramework {
  method: string;
  key_assumptions: string[];
  valuation_view: ValuationView;
  evidence_ids: string[];
}

export interface ScenarioVariable {
  name: string;
  base: string;
  bull: string;
  bear: string;
  unit?: string;
  evidence_ids: string[];
}

export interface ThesisValuationStructuredOutput {
  schema_version: SubagentOutputSchemaVersion;
  agent_id: "thesis_valuation";
  theses: ThesisItem[];
  valuation_framework: ValuationFramework;
  scenario_variables: ScenarioVariable[];
}

export type RiskSeverity = "low" | "medium" | "high";
export type RiskStance = "positive" | "neutral" | "negative" | "mixed" | "insufficient_data";

export interface CounterEvidenceItem {
  claim_challenged: string;
  counterpoint: string;
  evidence_ids: string[];
  severity: RiskSeverity;
}

export interface RiskTrigger {
  trigger: string;
  metric_or_event: string;
  threshold?: string;
  watch_frequency?: string;
  derived_from_counter_evidence_index?: number;
  evidence_ids: string[];
}

export interface RiskUpstreamReferences {
  research_evidence_fact_indices: number[];
  thesis_indices: number[];
}

export interface RiskFinalSummary {
  stance: RiskStance;
  key_reasons: string[];
  major_risks: string[];
  data_gaps: string[];
  upstream_references: RiskUpstreamReferences;
}

export interface RiskReportStructuredOutput {
  schema_version: SubagentOutputSchemaVersion;
  agent_id: "risk_report";
  counter_evidence: CounterEvidenceItem[];
  risk_triggers: RiskTrigger[];
  final_summary: RiskFinalSummary;
}

export interface SubagentStructuredOutputByAgent {
  research_evidence: ResearchEvidenceStructuredOutput;
  thesis_valuation: ThesisValuationStructuredOutput;
  risk_report: RiskReportStructuredOutput;
}

export type SubagentStructuredOutput = SubagentStructuredOutputByAgent[SubagentId];

export interface SubagentProfile<TAgent extends SubagentId = SubagentId> {
  id: TAgent;
  name: string;
  role: string;
  skills: string[];
  boundaries: string[];
  output_contract: SubagentOutputContract<TAgent>;
}

export interface SubagentTask<TAgent extends SubagentId = SubagentId> {
  agent_id: TAgent;
  task: string;
  target: string;
  task_type: TaskType;
  role: SubagentRole;
  depends_on: SubagentId[];
  required_evidence: string[];
  allowed_skills: string[];
  allowed_toolsets: string[];
  result_contract: SubagentOutputContract<TAgent>;
  delegation_context: string;
  isolation: {
    fresh_context: true;
    memory_access: "blocked";
    user_interaction: "blocked";
    side_effects: "blocked";
    terminal_session: "dedicated";
    workspace: "dedicated";
  };
}

export interface SubagentResult {
  agent_id: SubagentId;
  task: string;
  summary: string;
  findings: Finding[];
  evidence: EvidenceItem[];
  assumptions: string[];
  open_questions: string[];
  confidence: number;
  data_gaps: DataGap[];
  structured_output?: SubagentStructuredOutput;
  needs_revision: boolean;
}

export interface ReviewResult {
  agent_id: SubagentId;
  pass: boolean;
  score: number;
  issues: string[];
  revision_instruction?: string;
}

export interface ResearchPlan {
  normalized_request: NormalizedResearchRequest;
  target: string;
  selected_agents: SubagentId[];
  tasks: SubagentTask[];
  delegation_policy: DelegationPolicy;
  clarification_question?: string;
}

export interface DelegationPolicy {
  mode: DelegationMode;
  max_concurrency: number;
  max_spawn_depth: number;
  allow_nested_orchestrators: boolean;
  summary_only: boolean;
}

export interface SubagentExecutionTrace {
  task_index: number;
  agent_id: SubagentId;
  role: SubagentRole;
  status: SubagentExecutionStatus;
  started_at: string;
  completed_at: string;
  duration_ms: number;
  evidence_count: number;
  data_gap_count: number;
  upstream_agents: SubagentId[];
  context_id: string;
  terminal_session_id: string;
  workspace_id: string;
  error?: string;
}

export interface FinalReport {
  evidence_schema_version: EvidenceSchemaVersion;
  target: string;
  task_type: TaskType;
  selected_agents: SubagentId[];
  markdown: string;
  evidence_ledger: EvidenceItem[];
  data_gaps: DataGap[];
  review_results: ReviewResult[];
  trace: {
    plan: ResearchPlan;
    subagent_results: SubagentResult[];
    delegation_executions: SubagentExecutionTrace[];
  };
}

export interface IFindQueryRequest {
  server: "stock" | "fund" | "news" | "edb";
  intent: Exclude<EvidenceIntent, "announcement">;
  query: string;
  target?: string;
}

export interface EvidenceCollectionResult {
  evidence: EvidenceItem[];
  data_gaps: DataGap[];
}

export type IFindQueryResult = EvidenceCollectionResult;

export interface ResearchDataAdapters {
  queryIFind(request: IFindQueryRequest): Promise<IFindQueryResult>;
}

export interface EvidenceProvider {
  name: ResearchSourceName;
  collect(task: SubagentTask): Promise<EvidenceCollectionResult>;
}

export interface LLMGenerateRequest {
  normalized_request: NormalizedResearchRequest;
  task: SubagentTask;
  evidence: EvidenceItem[];
  data_gaps: DataGap[];
  skill_text: string;
  delegation_context?: string;
  upstream_results?: Array<Pick<SubagentResult, "agent_id" | "summary" | "findings" | "data_gaps" | "structured_output" | "needs_revision">>;
  signal?: AbortSignal;
}

export interface LLMAdapter {
  generateSubagentResult(request: LLMGenerateRequest): Promise<SubagentResult>;
}
