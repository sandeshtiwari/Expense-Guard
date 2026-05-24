from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import anyio
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from app.agents.expense_agents import (
    POSTGRES_APP_GLUE_LINES,
    POSTGRES_POLICY_DUPLICATION_POINTS,
    POSTGRES_STORE,
    SYNAPSOR_APP_GLUE_LINES,
    SYNAPSOR_POLICY_DUPLICATION_POINTS,
    SYNAPSOR_STORE,
    policy_gate as evaluate_policy_gate,
    run_postgres_lane,
    run_synapsor_lane,
)
from app.config import get_settings
from app.schemas import (
    ApprovalRequest,
    ApprovalResponse,
    BackgroundState,
    BackgroundToggle,
    AgentContextBundle,
    EvidenceItem,
    Expense,
    LaneResult,
    MetricSet,
    ReviewRequest,
    ReviewResponse,
    UploadExpenseRequest,
)
from app.utils import new_id, sql_string

POLICY_DRIFT_EXPENSE_ID = "EXP-2001"
TIME_TRAVEL_RUN_CACHE: dict[str, int] = {}


class BackgroundRunner:
    def __init__(self) -> None:
        self.enabled = False
        self.task: asyncio.Task[None] | None = None
        self.processed: set[str] = set()
        self.last_run_at: str | None = None
        self.last_message: str | None = None
        self.processed_count = 0

    def state(self) -> BackgroundState:
        settings = get_settings()
        return BackgroundState(
            enabled=self.enabled,
            interval_seconds=settings.background_interval_seconds,
            last_run_at=self.last_run_at,
            last_message=self.last_message,
            processed_count=self.processed_count,
        )

    def set_enabled(self, enabled: bool) -> BackgroundState:
        self.enabled = enabled
        if enabled and self.task is None:
            self.task = asyncio.create_task(self._loop())
        if not enabled and self.task is not None:
            self.task.cancel()
            self.task = None
            self.last_message = "Background review paused."
        return self.state()

    async def _loop(self) -> None:
        settings = get_settings()
        while self.enabled:
            try:
                await self.run_once()
            except Exception as exc:  # pragma: no cover - surfaced in UI
                self.last_message = f"Background review error: {exc}"
            await asyncio.sleep(settings.background_interval_seconds)

    async def run_once(self) -> None:
        expenses = POSTGRES_STORE.list_expenses("acme")
        pending = [expense for expense in expenses if expense.state == "submitted" and expense.id not in self.processed]
        if not pending:
            self.last_message = "No new submitted expenses to review."
            self.last_run_at = datetime.now(UTC).isoformat()
            return
        expense = pending[0]
        request = ReviewRequest(
            expense_id=expense.id,
            question="Background review: check receipt, card transaction, policy, and duplicates. Stage the recommendation for human review.",
            tenant_id=expense.tenant_id,
            principal="expense_background_agent",
        )
        await run_review(request)
        self.processed.add(expense.id)
        self.processed_count += 1
        self.last_run_at = datetime.now(UTC).isoformat()
        self.last_message = f"Reviewed {expense.id} in both lanes."


BACKGROUND = BackgroundRunner()


@asynccontextmanager
async def lifespan(app: FastAPI):
    get_settings().configure_openai_environment()
    yield
    SYNAPSOR_STORE.close()


app = FastAPI(title="Synapsor Agent-Native DBMS Demo API", version="1.0.0", lifespan=lifespan)
settings = get_settings()
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "model": get_settings().agent_model}


@app.post("/api/reset")
def reset() -> dict[str, str]:
    POSTGRES_STORE.reset()
    SYNAPSOR_STORE.reset()
    TIME_TRAVEL_RUN_CACHE.clear()
    BACKGROUND.processed.clear()
    BACKGROUND.processed_count = 0
    return {"status": "seeded"}


@app.get("/api/expenses")
def expenses() -> list[Expense]:
    return POSTGRES_STORE.list_expenses("acme")


@app.get("/api/expense-state/{expense_id}")
def expense_state(expense_id: str) -> dict[str, LaneResult | None]:
    return {
        "postgres": _postgres_lane_snapshot(expense_id),
        "synapsor": _safe_synapsor_lane_snapshot(expense_id),
    }


@app.get("/api/synapsor/time-travel/{expense_id}")
def synapsor_time_travel(expense_id: str) -> dict:
    try:
        return _synapsor_time_travel_snapshot(expense_id)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/demo/policy-update/{expense_id}")
def policy_update_status(expense_id: str) -> dict:
    return _policy_update_demo_status(expense_id)


@app.post("/api/demo/policy-update/{expense_id}")
def apply_policy_update(expense_id: str) -> dict:
    if expense_id != POLICY_DRIFT_EXPENSE_ID:
        raise HTTPException(
            status_code=400,
            detail=f"The policy-update time-travel demo is only seeded for {POLICY_DRIFT_EXPENSE_ID}.",
        )
    POSTGRES_STORE.apply_policy_drift_demo("acme")
    SYNAPSOR_STORE.apply_policy_drift_demo("acme")
    return _policy_update_demo_status(expense_id) | {
        "status": "applied",
        "message": "Finance policy update applied after the agent run. Time Travel can now compare then versus now.",
    }


@app.post("/api/upload")
def upload_expense(payload: UploadExpenseRequest) -> Expense:
    pg_expense = POSTGRES_STORE.create_uploaded_expense(payload.model_dump())
    SYNAPSOR_STORE.create_uploaded_expense(payload.model_dump())
    return pg_expense


@app.post("/api/review", response_model=ReviewResponse)
async def review(payload: ReviewRequest) -> ReviewResponse:
    try:
        return await run_review(payload)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/review/{lane}", response_model=LaneResult)
async def review_lane(lane: str, payload: ReviewRequest) -> LaneResult:
    try:
        expense = POSTGRES_STORE.get_expense(payload.expense_id, payload.tenant_id)
        if expense is None:
            raise ValueError(f"Expense not found: {payload.expense_id}")
        if lane == "postgres":
            result = await run_postgres_lane(
                tenant_id=payload.tenant_id,
                principal=payload.principal,
                expense_id=payload.expense_id,
                question=payload.question,
            )
        elif lane == "synapsor":
            result = await run_synapsor_lane(
                tenant_id=payload.tenant_id,
                principal=payload.principal,
                expense_id=payload.expense_id,
                question=payload.question,
            )
        else:
            raise ValueError("lane must be postgres or synapsor")
        POSTGRES_STORE.record_run(
            {
                "id": new_id("RUN"),
                "tenant_id": payload.tenant_id,
                "lane": lane,
                "expense_id": payload.expense_id,
                "question": payload.question,
                "final_answer": result.answer,
                "decision": result.decision,
                "tool_calls": result.metrics.tool_calls,
                "db_round_trips": result.metrics.db_round_trips,
                "input_tokens": result.metrics.input_tokens,
                "output_tokens": result.metrics.output_tokens,
                "total_tokens": result.metrics.total_tokens,
                "elapsed_ms": result.metrics.elapsed_ms,
            }
        )
        if lane == "synapsor":
            _cache_latest_synapsor_context_run(payload.expense_id)
        return result
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


async def run_review(payload: ReviewRequest) -> ReviewResponse:
    expense = POSTGRES_STORE.get_expense(payload.expense_id, payload.tenant_id)
    if expense is None:
        raise ValueError(f"Expense not found: {payload.expense_id}")
    async with anyio.create_task_group() as tg:
        pg_result = None
        syn_result = None

        async def run_pg() -> None:
            nonlocal pg_result
            pg_result = await run_postgres_lane(
                tenant_id=payload.tenant_id,
                principal=payload.principal,
                expense_id=payload.expense_id,
                question=payload.question,
            )

        async def run_syn() -> None:
            nonlocal syn_result
            syn_result = await run_synapsor_lane(
                tenant_id=payload.tenant_id,
                principal=payload.principal,
                expense_id=payload.expense_id,
                question=payload.question,
            )

        tg.start_soon(run_pg)
        tg.start_soon(run_syn)
    assert pg_result is not None
    assert syn_result is not None
    run_id = new_id("RUN")
    POSTGRES_STORE.record_run(
        {
            "id": new_id("RUN"),
            "tenant_id": payload.tenant_id,
            "lane": "postgres",
            "expense_id": payload.expense_id,
            "question": payload.question,
            "final_answer": pg_result.answer,
            "decision": pg_result.decision,
            "tool_calls": pg_result.metrics.tool_calls,
            "db_round_trips": pg_result.metrics.db_round_trips,
            "input_tokens": pg_result.metrics.input_tokens,
            "output_tokens": pg_result.metrics.output_tokens,
            "total_tokens": pg_result.metrics.total_tokens,
            "elapsed_ms": pg_result.metrics.elapsed_ms,
        }
    )
    POSTGRES_STORE.record_run(
        {
            "id": new_id("RUN"),
            "tenant_id": payload.tenant_id,
            "lane": "synapsor",
            "expense_id": payload.expense_id,
            "question": payload.question,
            "final_answer": syn_result.answer,
            "decision": syn_result.decision,
            "tool_calls": syn_result.metrics.tool_calls,
            "db_round_trips": syn_result.metrics.db_round_trips,
            "input_tokens": syn_result.metrics.input_tokens,
            "output_tokens": syn_result.metrics.output_tokens,
            "total_tokens": syn_result.metrics.total_tokens,
            "elapsed_ms": syn_result.metrics.elapsed_ms,
        }
    )
    POSTGRES_STORE.record_run(
        {
            "id": run_id,
            "tenant_id": payload.tenant_id,
            "lane": "comparison",
            "expense_id": payload.expense_id,
            "question": payload.question,
            "final_answer": f"PG: {pg_result.answer} | Synapsor: {syn_result.answer}",
            "decision": syn_result.decision,
            "tool_calls": pg_result.metrics.tool_calls + syn_result.metrics.tool_calls,
            "db_round_trips": pg_result.metrics.db_round_trips + syn_result.metrics.db_round_trips,
            "input_tokens": pg_result.metrics.input_tokens + syn_result.metrics.input_tokens,
            "output_tokens": pg_result.metrics.output_tokens + syn_result.metrics.output_tokens,
            "total_tokens": pg_result.metrics.total_tokens + syn_result.metrics.total_tokens,
            "elapsed_ms": max(pg_result.metrics.elapsed_ms, syn_result.metrics.elapsed_ms),
        }
    )
    _cache_latest_synapsor_context_run(payload.expense_id)
    return ReviewResponse(run_id=run_id, expense=expense, postgres=pg_result, synapsor=syn_result)


@app.get("/api/queue")
def queue() -> dict[str, list[dict]]:
    return {"postgres": POSTGRES_STORE.queue("acme"), "synapsor": SYNAPSOR_STORE.queue("acme")}


@app.post("/api/approve", response_model=ApprovalResponse)
def approve(payload: ApprovalRequest) -> ApprovalResponse:
    try:
        if payload.lane == "postgres":
            raw = POSTGRES_STORE.approve_proposal(payload.proposal_id, payload.approver)
            expense = POSTGRES_STORE.get_expense(raw["expense_id"], "acme")
            return ApprovalResponse(
                lane="postgres",
                proposal_id=payload.proposal_id,
                status="approved",
                message="Postgres lane applied the app-owned approval workflow.",
                expense=expense,
                raw=raw,
            )
        proposal_row = _synapsor_proposal_row(payload.proposal_id)
        branch = payload.branch_name or (proposal_row or {}).get("branch_name")
        expense_id = _expense_id_from_summary_row(proposal_row) or "EXP-1001"
        before = SYNAPSOR_STORE.get_expense(expense_id, "acme")
        raw = SYNAPSOR_STORE.approve_proposal(payload.proposal_id, branch, payload.approver)
        expense = SYNAPSOR_STORE.get_expense(expense_id, "acme")
        raw["data_state"] = {
            "expense_id": expense_id,
            "target_table": "expenses",
            "production_before": before.state if before else "unknown",
            "staged_state": expense.state if expense else "approved",
            "production_after": expense.state if expense else "approved",
            "staging_location": "Synapsor branch",
            "production_after_label": "Synapsor native lifecycle approved, committed, and merged to production",
        }
        return ApprovalResponse(
            lane="synapsor",
            proposal_id=payload.proposal_id,
            status="approved",
            message="Synapsor native lifecycle approved, committed, and merged the branch-staged proposal.",
            expense=expense,
            raw=raw,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/reject", response_model=ApprovalResponse)
def reject(payload: ApprovalRequest) -> ApprovalResponse:
    try:
        if payload.lane == "postgres":
            raw = POSTGRES_STORE.reject_proposal(payload.proposal_id, payload.approver, payload.reason)
            expense = POSTGRES_STORE.get_expense(raw["expense_id"], "acme")
            return ApprovalResponse(
                lane="postgres",
                proposal_id=payload.proposal_id,
                status="rejected",
                message="Postgres lane marked the app-owned proposal rejected. Production stayed unchanged.",
                expense=expense,
                raw=raw,
            )
        proposal_row = _synapsor_proposal_row(payload.proposal_id)
        branch = payload.branch_name or (proposal_row or {}).get("branch_name")
        expense_id = _expense_id_from_summary_row(proposal_row) or "EXP-1001"
        before = SYNAPSOR_STORE.get_expense(expense_id, "acme")
        raw = SYNAPSOR_STORE.reject_proposal(payload.proposal_id, branch, payload.approver)
        expense = SYNAPSOR_STORE.get_expense(expense_id, "acme")
        raw["data_state"] = {
            "expense_id": expense_id,
            "target_table": "expenses",
            "production_before": before.state if before else "unknown",
            "staged_state": _state_from_synapsor_proposal(proposal_row) or "proposal_rejected",
            "production_after": expense.state if expense else before.state if before else "unknown",
            "staging_location": "Synapsor branch",
            "production_after_label": "Rejected; branch discarded and production unchanged",
        }
        return ApprovalResponse(
            lane="synapsor",
            proposal_id=payload.proposal_id,
            status="rejected",
            message="Synapsor rejected the branch-staged proposal and discarded the review branch.",
            expense=expense,
            raw=raw,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


def _synapsor_proposal_row(handle: str) -> dict | None:
    rows = SYNAPSOR_STORE.db().query(
        """
        SELECT id, state, handle_uri, summary, tenant_id, principal, branch_name,
               required_approvals, approval_count, effect_count, trace_id
        FROM synapsor_agent_write_proposals
        ORDER BY id DESC;
        """
    )
    for row in rows:
        if row.get("handle_uri") == handle:
            return row
    return None


def _expense_id_from_summary_row(row: dict | None) -> str | None:
    summary = str((row or {}).get("summary", ""))
    for token in summary.split():
        if token.startswith("EXP-"):
            return token
    return None


def _state_from_synapsor_proposal(row: dict | None) -> str | None:
    if row and row.get("proposed_state"):
        return str(row.get("proposed_state"))
    summary = str((row or {}).get("summary", ""))
    lowered = summary.lower()
    for state in ["manager_review_required", "finance_review_required", "security_review_required", "approved", "rejected"]:
        if state in lowered:
            return state
    return None


def _postgres_lane_snapshot(expense_id: str) -> LaneResult | None:
    expense = POSTGRES_STORE.get_expense(expense_id, "acme")
    if expense is None:
        return None
    proposal = POSTGRES_STORE.proposal_for_expense(expense_id, "acme")
    latest_run = POSTGRES_STORE.latest_run_for_expense(expense_id, "postgres", "acme")
    proposed = str((proposal or {}).get("proposed_state") or expense.state)
    status = _postgres_snapshot_status(proposal, expense)
    data_state = _snapshot_data_state(
        expense=expense,
        proposed_state=proposed,
        status=status,
        staging_location="Postgres approval row",
        lane="postgres",
    )
    policy_gate = _policy_gate_from_context_dict((proposal or {}).get("evidence_json"), proposed)
    return LaneResult(
        lane="postgres",
        title="General-purpose DBMS path",
        decision=proposed,
        answer=_snapshot_answer(expense, status, proposed, "Postgres app workflow"),
        proposal_id=str(proposal["id"]) if proposal else None,
        status=status,
        metrics=_snapshot_metrics("postgres", has_proposal=proposal is not None, latest_run=latest_run),
        evidence=_evidence_from_context_dict((proposal or {}).get("evidence_json")),
        steps=_postgres_snapshot_steps(status),
        raw={
            "snapshot": True,
            "latest_run_metrics": latest_run is not None,
            "latest_run": latest_run or {},
            "policy_gate": policy_gate,
            "proposal": {
                "id": str(proposal["id"]) if proposal else None,
                "status": str(proposal.get("status")) if proposal else "none",
                "proposed_state": proposed,
                "safe_write_branch": False,
            },
            "data_state": data_state,
        },
    )


def _synapsor_lane_snapshot(expense_id: str) -> LaneResult | None:
    expense = SYNAPSOR_STORE.get_expense(expense_id, "acme")
    if expense is None:
        return None
    proposal = SYNAPSOR_STORE.proposal_for_expense(expense_id, "acme")
    latest_run = POSTGRES_STORE.latest_run_for_expense(expense_id, "synapsor", "acme")
    proposal_state = _state_from_synapsor_proposal(proposal)
    run_state = str((latest_run or {}).get("decision") or "")
    proposed = proposal_state if proposal_state and proposal_state != expense.state else run_state or proposal_state or expense.state
    status = _synapsor_snapshot_status(proposal, expense)
    branch_name = str(proposal.get("branch_name") or "") if proposal else None
    data_state = _snapshot_data_state(
        expense=expense,
        proposed_state=proposed,
        status=status,
        staging_location="Synapsor branch",
        lane="synapsor",
    )
    evidence, policy_gate = (
        ([], {})
        if status == "not_reviewed"
        else _synapsor_snapshot_evidence_and_gate(expense_id, proposed)
    )
    return LaneResult(
        lane="synapsor",
        title="Synapsor agent-native DBMS path",
        decision=proposed,
        answer=_snapshot_answer(expense, status, proposed, "Synapsor database trust layer"),
        proposal_id=str(proposal.get("handle_uri")) if proposal else None,
        branch_name=branch_name or None,
        status=status,
        metrics=_snapshot_metrics(
            "synapsor",
            has_proposal=proposal is not None,
            has_branch=bool(branch_name),
            latest_run=latest_run,
        ),
        evidence=evidence,
        steps=_synapsor_snapshot_steps(status),
        raw={
            "snapshot": True,
            "latest_run_metrics": latest_run is not None,
            "latest_run": latest_run or {},
            "policy_gate": policy_gate,
            "proposal": {
                "proposal_handle": str(proposal.get("handle_uri")) if proposal else None,
                "branch_name": branch_name or None,
                "status": str(proposal.get("state")) if proposal else "none",
                "proposed_state": proposed,
                "safe_write_branch": bool(branch_name),
            },
            "data_state": data_state,
        },
    )


def _safe_synapsor_lane_snapshot(expense_id: str) -> LaneResult | None:
    try:
        return _synapsor_lane_snapshot(expense_id)
    except Exception as exc:
        expense = POSTGRES_STORE.get_expense(expense_id, "acme")
        if expense is None:
            return None
        data_state = _snapshot_data_state(
            expense=expense,
            proposed_state=expense.state,
            status="not_reviewed",
            staging_location="No proposal yet",
            lane="synapsor",
        )
        return LaneResult(
            lane="synapsor",
            title="Synapsor agent-native DBMS path",
            decision=expense.state,
            answer=(
                "Synapsor snapshot could not be loaded automatically. No reset or data repair was "
                "performed; use the explicit reset button if you want to reseed the demo."
            ),
            proposal_id=None,
            branch_name=None,
            status="not_reviewed",
            metrics=_snapshot_metrics("synapsor"),
            evidence=[],
            steps=[
                "Synapsor state read failed",
                "No implicit reset was performed",
                "Use Reset full demo seed data only if you want to reseed explicitly",
            ],
            raw={
                "snapshot": True,
                "warning": str(exc),
                "proposal": {
                    "proposal_handle": None,
                    "branch_name": None,
                    "status": "none",
                    "proposed_state": expense.state,
                    "safe_write_branch": False,
                },
                "data_state": data_state,
            },
        )


def _snapshot_metrics(
    lane: str,
    *,
    has_proposal: bool = False,
    has_branch: bool = False,
    latest_run: dict | None = None,
) -> MetricSet:
    return MetricSet(
        input_tokens=int((latest_run or {}).get("input_tokens") or 0),
        output_tokens=int((latest_run or {}).get("output_tokens") or 0),
        total_tokens=int((latest_run or {}).get("total_tokens") or 0),
        tool_calls=int((latest_run or {}).get("tool_calls") or 0),
        db_round_trips=int((latest_run or {}).get("db_round_trips") or 1),
        app_glue_lines=POSTGRES_APP_GLUE_LINES if lane == "postgres" else SYNAPSOR_APP_GLUE_LINES,
        policy_duplication_points=POSTGRES_POLICY_DUPLICATION_POINTS if lane == "postgres" else SYNAPSOR_POLICY_DUPLICATION_POINTS,
        safe_write_branch=lane == "synapsor" and has_branch,
        evidence_complete=has_proposal and lane == "synapsor",
        replay_or_audit=True,
        elapsed_ms=int((latest_run or {}).get("elapsed_ms") or 0),
    )


def _postgres_snapshot_status(proposal: dict | None, expense: Expense) -> str:
    if proposal:
        status = str(proposal.get("status") or "")
        if status == "pending":
            return "pending_review"
        if status in {"approved", "rejected"}:
            return status
    if expense.state == "approved":
        return "approved"
    if expense.state != "submitted":
        return "handled"
    return "not_reviewed"


def _synapsor_snapshot_status(proposal: dict | None, expense: Expense) -> str:
    if proposal:
        state = str(proposal.get("state") or "")
        if state == "committed":
            return "approved"
        if state == "rejected":
            return "rejected"
        if state == "cancelled":
            return "cancelled"
        return "branch_staged"
    if expense.state == "approved":
        return "approved"
    if expense.state != "submitted":
        return "handled"
    return "not_reviewed"


def _snapshot_data_state(*, expense: Expense, proposed_state: str, status: str, staging_location: str, lane: str) -> dict:
    applied = status in {"approved", "auto_applied", "auto_settled", "handled"} and expense.state != "submitted"
    rejected = status in {"rejected", "cancelled"}
    if applied:
        after = expense.state
        label = "Already applied to production"
    elif rejected:
        after = expense.state
        label = "Rejected; production unchanged"
    elif status == "not_reviewed":
        after = expense.state
        proposed_state = expense.state
        staging_location = "No proposal yet"
        label = "No review has run yet"
    else:
        after = expense.state
        label = "Production unchanged until branch approval" if lane == "synapsor" else "Production unchanged until app approval"
    return {
        "expense_id": expense.id,
        "target_table": "expenses",
        "production_before": "submitted" if applied else expense.state,
        "staged_state": proposed_state,
        "production_after": after,
        "staging_location": staging_location,
        "production_after_label": label,
    }


def _snapshot_answer(expense: Expense, status: str, proposed_state: str, lane_label: str) -> str:
    if status in {"pending_review", "branch_staged"}:
        return f"{lane_label} has a staged recommendation for {expense.vendor}: {proposed_state.replace('_', ' ')}. Production is unchanged until review."
    if status == "rejected":
        return f"{lane_label} rejected the recommendation for {expense.vendor}. Production stayed unchanged."
    if status in {"approved", "auto_applied", "auto_settled", "handled"}:
        return f"{lane_label} shows {expense.vendor} is already handled as {expense.state.replace('_', ' ')}."
    if status == "not_reviewed":
        return f"{lane_label} has not reviewed {expense.vendor} yet. The production row is currently {expense.state.replace('_', ' ')}."
    return f"{lane_label} has no active recommendation for {expense.vendor}."


def _postgres_snapshot_steps(status: str) -> list[str]:
    if status == "pending_review":
        return ["Loaded existing app-owned proposal row", "Production row is unchanged", "Reviewer can approve or reject"]
    if status == "rejected":
        return ["Loaded rejected app-owned proposal row", "Production row stayed unchanged"]
    if status == "not_reviewed":
        return ["Loaded current Postgres expense row", "No recommendation has been staged yet", "Run review to ask the agent to act"]
    return ["Loaded current production expense row", "No native DB branch exists in this lane"]


def _synapsor_snapshot_steps(status: str) -> list[str]:
    if status == "branch_staged":
        return ["Loaded existing Synapsor write proposal", "Branch-staged row is isolated from production", "Reviewer can approve or reject"]
    if status == "rejected":
        return ["Loaded rejected Synapsor proposal", "Review branch was discarded", "Production row stayed unchanged"]
    if status == "not_reviewed":
        return ["Loaded current Synapsor expense row", "No branch proposal exists yet", "Run review to create a capability-backed recommendation"]
    return ["Loaded current production expense row", "Synapsor audit/proposal state remains queryable"]


def _evidence_from_context_dict(value: object) -> list[EvidenceItem]:
    bundle = value if isinstance(value, dict) else {}
    expense = bundle.get("expense") if isinstance(bundle.get("expense"), dict) else {}
    card = bundle.get("card_transaction") if isinstance(bundle.get("card_transaction"), dict) else {}
    duplicates = bundle.get("duplicate_checks") if isinstance(bundle.get("duplicate_checks"), list) else []
    policies = bundle.get("policy_hits") if isinstance(bundle.get("policy_hits"), list) else []
    excluded = bundle.get("excluded_policy_reasons") if isinstance(bundle.get("excluded_policy_reasons"), list) else []
    items: list[EvidenceItem] = []
    if expense:
        amount = int(expense.get("amount_cents", 0) or 0) / 100
        items.append(EvidenceItem(label="Receipt", detail=f"{expense.get('vendor')} {expense.get('category')} ${amount:,.2f}", source="expense row"))
    if card:
        amount = int(card.get("amount_cents", 0) or 0) / 100
        items.append(EvidenceItem(label="Card match", detail=f"{card.get('merchant')} ${amount:,.2f}", source="card transaction"))
    for duplicate in duplicates[:2]:
        if isinstance(duplicate, dict):
            items.append(EvidenceItem(label="Duplicate signal", detail=str(duplicate.get("reason")), source="duplicate check"))
    for policy in policies[:3]:
        if isinstance(policy, dict):
            items.append(EvidenceItem(label=str(policy.get("title", "Policy")), detail=str(policy.get("body", ""))[:180], source="policy evidence"))
    for row in excluded[:3]:
        if isinstance(row, dict):
            items.append(EvidenceItem(label="Excluded policy", detail=f"{row.get('policy')}: {row.get('reason')}", source="policy filter"))
    return items


def _policy_gate_from_context_dict(value: object, proposed_state: str) -> dict:
    if not isinstance(value, dict):
        return {}
    try:
        return evaluate_policy_gate(AgentContextBundle.model_validate(value), proposed_state)
    except Exception:
        return {}


def _synapsor_snapshot_evidence_and_gate(expense_id: str, proposed_state: str) -> tuple[list[EvidenceItem], dict]:
    try:
        bundle, _, _ = SYNAPSOR_STORE.context_bundle(
            expense_id,
            "Load current evidence for the existing expense recommendation.",
            "acme",
            "expense_viewer",
        )
        return _evidence_from_context_dict(bundle.model_dump()), evaluate_policy_gate(bundle, proposed_state)
    except Exception:
        return [], {}


def _policy_update_demo_status(expense_id: str) -> dict:
    eligible = expense_id == POLICY_DRIFT_EXPENSE_ID
    active_policy: dict = {}
    applied = False
    if eligible:
        try:
            rows = _current_synapsor_policy_drift_rows(SYNAPSOR_STORE.db(), expense_id)
            active_rows = [row for row in rows if str(row.get("status") or "") == "active"]
            active_policy = active_rows[0] if active_rows else {}
            applied = str(active_policy.get("chunk_id") or "") == "POL-ACME-GROUND-NEW"
        except Exception:
            active_policy = {}
            applied = False
    return {
        "eligible": eligible,
        "applied": applied,
        "expense_id": expense_id,
        "active_policy": active_policy,
        "message": (
            "Finance policy update has been applied. Agent Time Travel will show old policy versus current policy."
            if applied
            else "Run the agent first, then apply the finance policy update as a separate demo step."
        ),
    }


def _cache_latest_synapsor_context_run(expense_id: str) -> None:
    try:
        rows = SYNAPSOR_STORE.db().query(
            """
            SELECT id, capability_full_name
            FROM synapsor_agent_runs
            ORDER BY id DESC;
            """
        )
    except Exception:
        return
    for row in rows:
        if str(row.get("capability_full_name") or "") != "expenses.review_expense_context":
            continue
        try:
            TIME_TRAVEL_RUN_CACHE[expense_id] = int(row["id"])
        except Exception:
            return
        return


def _synapsor_time_travel_snapshot(expense_id: str) -> dict:
    db = SYNAPSOR_STORE.db()
    postgres_run = POSTGRES_STORE.latest_run_for_expense(expense_id, "postgres", "acme")
    postgres_proposal = POSTGRES_STORE.proposal_for_expense(expense_id, "acme")
    postgres_current = POSTGRES_STORE.get_expense(expense_id, "acme")
    runs = db.query(
        """
        SELECT id, capability_full_name, status, status_code, principal, tenant_id,
               snapshot_ts, trace_id, evidence_id, proposal_id
        FROM synapsor_agent_runs
        ORDER BY id DESC;
        """
    )
    read_runs = [
        row for row in runs
        if str(row.get("capability_full_name") or "") == "expenses.review_expense_context"
    ]
    run, replay = _matching_synapsor_agent_run(db, read_runs, expense_id)
    system_proposals = db.query(
        """
        SELECT id, state, handle_uri, summary, tenant_id, principal,
               capability_full_name, branch_name, snapshot_ts, evidence_id, trace_id
        FROM synapsor_agent_write_proposals
        ORDER BY id DESC;
        """
    )
    proposal = next(
        (row for row in system_proposals if _expense_id_from_summary_row(row) == expense_id),
        None,
    )
    current_rows = db.query(
        f"""
        SELECT id, tenant_id, vendor, category, amount_cents, state, reviewer, decision_note
        FROM expenses
        WHERE tenant_id = 'acme' AND id = {sql_string(expense_id)};
        """
    )
    current_row = current_rows[0] if current_rows else {}
    current_policy = _current_synapsor_policy_drift_rows(db, expense_id)
    if run is None:
        return {
            "available": False,
            "reason": f"No matching Synapsor agent run was found for {expense_id}. Run Synapsor review for this expense first.",
            "postgres": _postgres_time_travel_snapshot(expense_id, postgres_run, postgres_proposal, postgres_current),
            "run": None,
            "proposal": proposal or {},
            "current_row": current_row,
            "historical_row": {},
            "current_policy": current_policy,
            "historical_policy": [],
            "drift": _time_travel_drift_summary(expense_id, [], current_policy),
            "replay": {},
            "commands": _time_travel_commands(None, expense_id, proposal),
        }

    run_id = int(run["id"])
    run_session = _time_travel_session(run, expense_id, run_id)
    historical_row: dict = {}
    historical_policy: list[dict] = []
    historical_error = ""
    try:
        historical_rows = db.query(
            f"""
            AS OF AGENT RUN '{run_id}'
            SELECT id, tenant_id, vendor, category, amount_cents, state, reviewer, decision_note
            FROM expenses
            WHERE tenant_id = 'acme' AND id = {sql_string(expense_id)};
            """,
            session=run_session,
        )
        historical_row = historical_rows[0] if historical_rows else {}
        historical_policy = _historical_synapsor_policy_drift_rows(db, expense_id, run_id, run_session)
    except Exception as exc:
        historical_error = _time_travel_error_message(exc)

    replay_error = ""
    if not replay:
        try:
            replay = db.replay_agent_run(
                run_id,
                session=run_session,
            )
        except Exception as exc:
            replay_error = _time_travel_error_message(exc)
    if not historical_row:
        historical_row = _historical_expense_from_replay(replay)
    if not historical_policy:
        historical_policy = _historical_policy_from_replay_or_demo(expense_id, replay)

    return {
        "available": True,
        "postgres": _postgres_time_travel_snapshot(expense_id, postgres_run, postgres_proposal, postgres_current),
        "run": run,
        "proposal": proposal or {},
        "current_row": current_row,
        "historical_row": historical_row,
        "current_policy": current_policy,
        "historical_policy": historical_policy,
        "drift": _time_travel_drift_summary(expense_id, historical_policy, current_policy),
        "historical_error": historical_error,
        "replay": replay,
        "replay_error": replay_error,
        "commands": _time_travel_commands(run_id, expense_id, proposal),
    }


def _matching_synapsor_agent_run(db: Any, runs: list[dict], expense_id: str) -> tuple[dict | None, dict]:
    cached_run_id = TIME_TRAVEL_RUN_CACHE.get(expense_id)
    if cached_run_id is not None:
        cached_run = next((run for run in runs if _safe_int(run.get("id")) == cached_run_id), None)
        if cached_run is not None:
            session = _time_travel_session(cached_run, expense_id, cached_run_id)
            try:
                replay = db.replay_agent_run(cached_run_id, session=session)
                if _expense_id_from_agent_run(replay) == expense_id:
                    return cached_run, replay
            except Exception:
                pass
    candidates = list(reversed(runs)) if expense_id == POLICY_DRIFT_EXPENSE_ID else runs
    for run in candidates:
        run_id = int(run["id"])
        session = _time_travel_session(run, expense_id, run_id)
        try:
            replay = db.replay_agent_run(run_id, session=session)
        except Exception:
            continue
        if _expense_id_from_agent_run(replay) == expense_id:
            TIME_TRAVEL_RUN_CACHE[expense_id] = run_id
            return run, replay
    return None, {}


def _safe_int(value: object) -> int | None:
    try:
        return int(value)  # type: ignore[arg-type]
    except Exception:
        return None


def _expense_id_from_agent_run(run: dict | None) -> str | None:
    if not isinstance(run, dict):
        return None
    candidates: list[object] = [
        run.get("current_expense_id"),
        run.get("expense_id"),
    ]
    for key in ["bound_args", "session", "audit_trail", "result_payload"]:
        value = run.get(key)
        if isinstance(value, dict):
            candidates.append(value.get("current_expense_id"))
            candidates.append(value.get("expense_id"))
    session = run.get("session")
    if isinstance(session, dict):
        attributes = session.get("attributes")
        if isinstance(attributes, dict):
            candidates.append(attributes.get("current_expense_id"))
    audit = run.get("audit_trail")
    if isinstance(audit, dict):
        bindings = audit.get("bindings")
        if isinstance(bindings, dict):
            bound_args = bindings.get("bound_args")
            if isinstance(bound_args, dict):
                candidates.append(bound_args.get("current_expense_id"))
                candidates.append(bound_args.get("expense_id"))
    payload = run.get("result_payload")
    if isinstance(payload, dict):
        expenses = payload.get("expense")
        if isinstance(expenses, list) and expenses and isinstance(expenses[0], dict):
            candidates.append(expenses[0].get("id"))
    for candidate in candidates:
        if candidate:
            return str(candidate)
    return None


def _time_travel_session(run: dict, expense_id: str, run_id: int) -> dict:
    return {
        "tenant_id": str(run.get("tenant_id") or "acme"),
        "principal": str(run.get("principal") or "expense_agent_01"),
        "session_id": f"time_travel_{expense_id}_{run_id}",
        "current_expense_id": expense_id,
        "snapshot_ts": 0,
    }


def _time_travel_error_message(exc: Exception) -> str:
    message = str(exc)
    if "agent run not found" in message.lower():
        return "agent run not found: wrong run selection or wrong session authorization"
    return message


def _historical_expense_from_replay(replay: dict) -> dict:
    payload = replay.get("result_payload") if isinstance(replay, dict) else None
    if not isinstance(payload, dict):
        return {}
    expenses = payload.get("expense")
    if isinstance(expenses, list) and expenses and isinstance(expenses[0], dict):
        row = dict(expenses[0])
        return {
            "id": row.get("id"),
            "tenant_id": replay.get("tenant_id", "acme"),
            "vendor": row.get("vendor"),
            "category": row.get("category"),
            "amount_cents": row.get("amount_cents"),
            "state": row.get("state"),
        }
    return {}


def _historical_policy_from_replay_or_demo(expense_id: str, replay: dict) -> list[dict]:
    payload = replay.get("result_payload") if isinstance(replay, dict) else None
    if isinstance(payload, dict):
        policies = payload.get("policy_hits")
        if isinstance(policies, list):
            rows = [row for row in policies if isinstance(row, dict)]
            if rows:
                return rows
    if expense_id == POLICY_DRIFT_EXPENSE_ID:
        return [
            {
                "chunk_id": "POL-ACME-GROUND-OLD",
                "title": "Ground transport policy before finance update",
                "topic": "ground_transport",
                "status": "active",
                "effective_from": "2026-01-01",
                "effective_to": "",
                "body": "Ground transport, rideshare, taxi, and airport rides under $100 with a receipt and matching card transaction may be auto-approved for customer travel.",
            }
        ]
    return []


def _current_synapsor_policy_drift_rows(db: Any, expense_id: str) -> list[dict]:
    if expense_id != POLICY_DRIFT_EXPENSE_ID:
        return []
    return db.query(
        """
        SELECT chunk_id, title, topic, status, effective_from, effective_to, body
        FROM expense_policy_chunks
        WHERE tenant_id = 'acme' AND topic = 'ground_transport'
        ORDER BY chunk_id;
        """
    )


def _historical_synapsor_policy_drift_rows(db: Any, expense_id: str, run_id: int, session: dict) -> list[dict]:
    if expense_id != POLICY_DRIFT_EXPENSE_ID:
        return []
    return db.query(
        f"""
        AS OF AGENT RUN '{run_id}'
        SELECT chunk_id, title, topic, status, effective_from, effective_to, body
        FROM expense_policy_chunks
        WHERE tenant_id = 'acme' AND topic = 'ground_transport'
        ORDER BY chunk_id;
        """,
        session=session,
    )


def _time_travel_drift_summary(expense_id: str, historical_policy: list[dict], current_policy: list[dict]) -> dict:
    if expense_id != POLICY_DRIFT_EXPENSE_ID:
        return {}
    historical_active = [row for row in historical_policy if str(row.get("status") or "") == "active"]
    current_active = [row for row in current_policy if str(row.get("status") or "") == "active"]
    historical_row = historical_active[0] if historical_active else {}
    current_row = current_active[0] if current_active else {}
    current_policy_changed = (
        str(current_row.get("chunk_id") or "") == "POL-ACME-GROUND-NEW"
        or (
            bool(historical_row)
            and bool(current_row)
            and str(historical_row.get("body") or "") != str(current_row.get("body") or "")
        )
    )
    if not current_policy_changed:
        return {
            "kind": "policy_drift_pending",
            "title": "No later policy update has been applied yet",
            "question": "Why do Then and Now still look the same?",
            "answer": "Only the agent review has run. Use the separate finance-policy update button to simulate a later policy change, then reopen Agent Time Travel.",
            "then_label": "Agent-run snapshot policy",
            "now_label": "Current production policy",
            "historical_active_policy": historical_row,
            "current_active_policy": current_row,
            "historical_policy_count": len(historical_policy),
            "current_policy_count": len(current_policy),
        }
    return {
        "kind": "policy_drift",
        "title": "Policy changed after the agent decision",
        "question": "Why was a $92 Uber ride auto-approved if today's policy says rides over $50 need manager review?",
        "answer": "Synapsor replays the run against the DB snapshot attached to the agent run. At that snapshot, the active policy allowed ground transport under $100. The stricter $50 policy is current now, but it was not the authority for the old decision.",
        "then_label": "Agent-run snapshot policy",
        "now_label": "Current production policy",
        "historical_active_policy": historical_row,
        "current_active_policy": current_row,
        "historical_policy_count": len(historical_policy),
        "current_policy_count": len(current_policy),
    }


def _time_travel_commands(run_id: int | None, expense_id: str, proposal: dict | None) -> dict[str, str]:
    run_ref = str(run_id) if run_id is not None else "last_run"
    branch_name = str((proposal or {}).get("branch_name") or f"review_{expense_id.lower().replace('-', '_')}")
    return {
        "historical_read": (
            f"AS OF AGENT RUN '{run_ref}'\n"
            "SELECT id, tenant_id, state, reviewer, decision_note\n"
            "FROM expenses\n"
            f"WHERE tenant_id = 'acme' AND id = '{expense_id}';"
        ),
        "replay_original": f"REPLAY AGENT RUN '{run_ref}' AS OF ORIGINAL SNAPSHOT;",
        "replay_current": f"REPLAY AGENT RUN '{run_ref}' AS OF CURRENT;",
        "branch_from_run": (
            f"CREATE BRANCH {branch_name}_investigation\n"
            f"FROM main AS OF AGENT RUN '{run_ref}';"
        ),
        "diff_current": (
            "DIFF TABLE expenses\n"
            f"BETWEEN AS OF AGENT RUN '{run_ref}'\n"
            "AND CURRENT\n"
            f"WHERE id = '{expense_id}';"
        ),
    }


def _postgres_time_travel_snapshot(
    expense_id: str,
    run: dict | None,
    proposal: dict | None,
    current: Expense | None,
) -> dict:
    evidence = (proposal or {}).get("evidence_json") if proposal else None
    return {
        "available": run is not None,
        "run": run or {},
        "proposal": proposal or {},
        "current_row": current.model_dump() if current else {},
        "historical_row": {},
        "evidence_snapshot": evidence if isinstance(evidence, dict) else {},
        "commands": {
            "app_log_lookup": (
                "SELECT id, lane, expense_id, question, final_answer, decision, created_at\n"
                "FROM pg_agent_runs\n"
                f"WHERE expense_id = '{expense_id}'\n"
                "ORDER BY created_at DESC;"
            ),
            "proposal_evidence": (
                "SELECT id, proposed_state, evidence_json, status\n"
                "FROM pg_expense_proposals\n"
                f"WHERE expense_id = '{expense_id}';"
            ),
        },
        "limitation": (
            "Postgres can store app logs and JSON snapshots, but AS OF AGENT RUN, replay, "
            "branch-from-run, and DB-owned diff are application features you would have to build."
        ),
    }


@app.get("/api/background", response_model=BackgroundState)
def background_state() -> BackgroundState:
    return BACKGROUND.state()


@app.post("/api/background", response_model=BackgroundState)
def toggle_background(payload: BackgroundToggle) -> BackgroundState:
    return BACKGROUND.set_enabled(payload.enabled)


@app.post("/api/background/run-once", response_model=BackgroundState)
async def background_run_once() -> BackgroundState:
    await BACKGROUND.run_once()
    return BACKGROUND.state()
