from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


JsonDict = dict[str, Any]
LaneName = Literal["postgres", "synapsor"]


class Expense(BaseModel):
    id: str
    tenant_id: str
    employee_id: str
    employee_name: str | None = None
    vendor: str
    category: str
    amount_cents: int
    currency: str = "USD"
    spend_date: str
    trip_purpose: str
    nights: int = 0
    receipt_text: str
    state: str
    duplicate_risk: int = 0


class ReviewRequest(BaseModel):
    expense_id: str
    question: str = "Review this expense against policy, receipt, card transaction, and duplicate history."
    tenant_id: str = "acme"
    principal: str = "expense_agent_01"


class UploadExpenseRequest(BaseModel):
    employee_id: str = "EMP-100"
    vendor: str
    category: str
    amount_cents: int
    spend_date: str
    trip_purpose: str
    nights: int = 0
    receipt_text: str
    tenant_id: str = "acme"


class MetricSet(BaseModel):
    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    tool_calls: int = 0
    db_round_trips: int = 0
    app_glue_lines: int = 0
    policy_duplication_points: int = 0
    safe_write_branch: bool = False
    evidence_complete: bool = False
    replay_or_audit: bool = False
    elapsed_ms: int = 0


class EvidenceItem(BaseModel):
    label: str
    detail: str
    source: str


class LaneResult(BaseModel):
    lane: LaneName
    title: str
    decision: str
    answer: str
    proposal_id: str | None = None
    branch_name: str | None = None
    status: str
    metrics: MetricSet
    evidence: list[EvidenceItem] = Field(default_factory=list)
    steps: list[str] = Field(default_factory=list)
    raw: JsonDict = Field(default_factory=dict)


class ReviewResponse(BaseModel):
    run_id: str
    expense: Expense
    postgres: LaneResult
    synapsor: LaneResult


class ApprovalRequest(BaseModel):
    lane: LaneName
    proposal_id: str
    branch_name: str | None = None
    approver: str = "MGR-200"
    reason: str = "Manager approved after reviewing evidence."


class ApprovalResponse(BaseModel):
    lane: LaneName
    proposal_id: str
    status: str
    message: str
    expense: Expense | None = None
    raw: JsonDict = Field(default_factory=dict)


class BackgroundState(BaseModel):
    enabled: bool
    interval_seconds: int
    last_run_at: str | None = None
    last_message: str | None = None
    processed_count: int = 0


class BackgroundToggle(BaseModel):
    enabled: bool


class AgentDecisionOutput(BaseModel):
    decision: Literal["approved", "manager_review_required", "rejected", "finance_review_required", "security_review_required"]
    short_answer: str
    reason: str
    evidence_labels: list[str]
    requires_human_approval: bool
    proposed_state: str
    risk_level: Literal["low", "medium", "high"]


class AgentContextBundle(BaseModel):
    expense: JsonDict
    employee: JsonDict | None = None
    card_transaction: JsonDict | None = None
    duplicate_checks: list[JsonDict] = Field(default_factory=list)
    guardrail_signals: list[JsonDict] = Field(default_factory=list)
    policy_hits: list[JsonDict] = Field(default_factory=list)
    excluded_policy_reasons: list[JsonDict] = Field(default_factory=list)
    capability_decision: str | None = None
    capability_reason_codes: list[str] = Field(default_factory=list)
