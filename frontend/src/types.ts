export type LaneName = "postgres" | "synapsor";

export interface Expense {
  id: string;
  tenant_id: string;
  employee_id: string;
  employee_name?: string;
  vendor: string;
  category: string;
  amount_cents: number;
  currency: string;
  spend_date: string;
  trip_purpose: string;
  nights: number;
  receipt_text: string;
  state: string;
  duplicate_risk: number;
}

export interface MetricSet {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  tool_calls: number;
  db_round_trips: number;
  app_glue_lines: number;
  policy_duplication_points: number;
  safe_write_branch: boolean;
  evidence_complete: boolean;
  replay_or_audit: boolean;
  elapsed_ms: number;
}

export interface EvidenceItem {
  label: string;
  detail: string;
  source: string;
}

export interface LaneResult {
  lane: LaneName;
  title: string;
  decision: string;
  answer: string;
  proposal_id?: string;
  branch_name?: string;
  status: string;
  metrics: MetricSet;
  evidence: EvidenceItem[];
  steps: string[];
  raw: Record<string, unknown>;
}

export interface ReviewResponse {
  run_id: string;
  expense: Expense;
  postgres: LaneResult;
  synapsor: LaneResult;
}

export interface ApprovalResponse {
  lane: LaneName;
  proposal_id: string;
  status: string;
  message: string;
  expense?: Expense;
  raw: Record<string, unknown>;
}

export interface BackgroundState {
  enabled: boolean;
  interval_seconds: number;
  last_run_at?: string;
  last_message?: string;
  processed_count: number;
}

export interface QueueResponse {
  postgres: Record<string, unknown>[];
  synapsor: Record<string, unknown>[];
}

export type ExpenseStateResponse = Partial<Record<LaneName, LaneResult | null>>;

export interface SynapsorTimeTravelResponse {
  available: boolean;
  reason?: string;
  postgres?: Record<string, unknown>;
  run?: Record<string, unknown> | null;
  proposal?: Record<string, unknown>;
  current_row?: Record<string, unknown>;
  historical_row?: Record<string, unknown>;
  current_policy?: Record<string, unknown>[];
  historical_policy?: Record<string, unknown>[];
  drift?: Record<string, unknown>;
  historical_error?: string;
  replay?: Record<string, unknown>;
  replay_error?: string;
  commands: Record<string, string>;
}
