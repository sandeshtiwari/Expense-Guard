from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import psycopg
from psycopg.rows import dict_row

from app.config import ROOT, get_settings
from app.schemas import AgentContextBundle, Expense
from app.utils import json_dumps, new_id, receipt_hash, simple_policy_vector, vector_literal


class PostgresStore:
    def __init__(self) -> None:
        self.settings = get_settings()

    def connect(self):
        return psycopg.connect(self.settings.postgres_dsn, row_factory=dict_row)

    def reset(self) -> None:
        sql_dir = ROOT / "sql" / "postgres"
        with self.connect() as conn:
            for path in sorted(sql_dir.glob("*.sql")):
                self._execute_script(conn, path.read_text())
            conn.commit()

    def _execute_script(self, conn: psycopg.Connection[Any], script: str) -> None:
        for statement in [part.strip() for part in script.split(";") if part.strip()]:
            conn.execute(statement)

    def list_expenses(self, tenant_id: str = "acme") -> list[Expense]:
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT e.*, emp.full_name AS employee_name,
                       COALESCE(MAX(d.risk_score), 0) AS duplicate_risk
                FROM expenses e
                JOIN employees emp ON emp.id = e.employee_id
                LEFT JOIN duplicate_signals d ON d.expense_id = e.id AND d.tenant_id = e.tenant_id
                WHERE e.tenant_id = %s
                GROUP BY e.id, emp.full_name
                ORDER BY e.id
                """,
                (tenant_id,),
            ).fetchall()
        return [Expense.model_validate(_expense_row(row)) for row in rows]

    def get_expense(self, expense_id: str, tenant_id: str = "acme") -> Expense | None:
        with self.connect() as conn:
            row = conn.execute(
                """
                SELECT e.*, emp.full_name AS employee_name,
                       COALESCE(MAX(d.risk_score), 0) AS duplicate_risk
                FROM expenses e
                JOIN employees emp ON emp.id = e.employee_id
                LEFT JOIN duplicate_signals d ON d.expense_id = e.id AND d.tenant_id = e.tenant_id
                WHERE e.tenant_id = %s AND e.id = %s
                GROUP BY e.id, emp.full_name
                """,
                (tenant_id, expense_id),
            ).fetchone()
        return Expense.model_validate(_expense_row(row)) if row else None

    def context_bundle(self, expense_id: str, question: str, tenant_id: str = "acme") -> tuple[AgentContextBundle, int]:
        db_round_trips = 0
        with self.connect() as conn:
            expense = conn.execute(
                "SELECT * FROM expenses WHERE tenant_id = %s AND id = %s",
                (tenant_id, expense_id),
            ).fetchone()
            db_round_trips += 1
            if not expense:
                raise ValueError(f"expense not found: {expense_id}")
            employee = conn.execute(
                "SELECT * FROM employees WHERE tenant_id = %s AND id = %s",
                (tenant_id, expense["employee_id"]),
            ).fetchone()
            db_round_trips += 1
            card = conn.execute(
                "SELECT * FROM card_transactions WHERE tenant_id = %s AND id = %s",
                (tenant_id, expense["card_transaction_id"]),
            ).fetchone()
            db_round_trips += 1
            duplicates = conn.execute(
                "SELECT * FROM duplicate_signals WHERE tenant_id = %s AND expense_id = %s ORDER BY risk_score DESC",
                (tenant_id, expense_id),
            ).fetchall()
            db_round_trips += 1
            policy_hits = self._policy_search(conn, question, tenant_id)
            db_round_trips += 1
            excluded = self._excluded_policies(conn, tenant_id)
            db_round_trips += 1
        return (
            AgentContextBundle(
                expense=_jsonable_row(expense),
                employee=_jsonable_row(employee) if employee else None,
                card_transaction=_jsonable_row(card) if card else None,
                duplicate_checks=[_jsonable_row(row) for row in duplicates],
                policy_hits=[_jsonable_row(row) for row in policy_hits],
                excluded_policy_reasons=excluded,
            ),
            db_round_trips,
        )

    def _policy_search(self, conn: psycopg.Connection[Any], question: str, tenant_id: str) -> list[dict[str, Any]]:
        query_vector = vector_literal(simple_policy_vector(question))
        return conn.execute(
            """
            SELECT chunk_id, tenant_id, title, topic, status, effective_from, effective_to,
                   allowed_role, body,
                   ts_rank(to_tsvector('english', title || ' ' || body), plainto_tsquery('english', %s)) AS lexical_score,
                   1 - (embedding <=> %s::vector) AS vector_score,
                   (0.55 * ts_rank(to_tsvector('english', title || ' ' || body), plainto_tsquery('english', %s))
                    + 0.45 * (1 - (embedding <=> %s::vector))) AS fused_score
            FROM company_policy_chunks
            WHERE tenant_id = %s
              AND status = 'active'
              AND effective_from <= DATE '2026-05-12'
              AND (effective_to IS NULL OR effective_to > DATE '2026-05-12')
            ORDER BY fused_score DESC
            LIMIT 5
            """,
            (question, query_vector, question, query_vector, tenant_id),
        ).fetchall()

    def _excluded_policies(self, conn: psycopg.Connection[Any], tenant_id: str) -> list[dict[str, Any]]:
        rows = conn.execute(
            "SELECT chunk_id, tenant_id, title, status, effective_from, effective_to FROM company_policy_chunks"
        ).fetchall()
        reasons: list[dict[str, Any]] = []
        for row in rows:
            reason = None
            if row["tenant_id"] != tenant_id:
                reason = "wrong tenant"
            elif row["status"] != "active":
                reason = "not active"
            elif row["effective_to"] is not None and str(row["effective_to"]) <= "2026-05-12":
                reason = "expired"
            if reason:
                reasons.append({"policy": row["chunk_id"], "reason": reason, "title": row["title"]})
        return reasons

    def create_proposal(
        self,
        *,
        tenant_id: str,
        expense_id: str,
        proposed_state: str,
        note: str,
        evidence: dict[str, Any],
        proposed_by: str,
    ) -> str:
        proposal_id = new_id("PGP")
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO pg_expense_proposals
                VALUES (%s, %s, %s, %s, %s, %s::jsonb, 'pending', %s, NULL, now(), NULL)
                """,
                (proposal_id, tenant_id, expense_id, proposed_state, note, json_dumps(evidence), proposed_by),
            )
            conn.commit()
        return proposal_id

    def approve_proposal(self, proposal_id: str, approver: str) -> dict[str, Any]:
        with self.connect() as conn:
            proposal = conn.execute(
                "SELECT * FROM pg_expense_proposals WHERE id = %s",
                (proposal_id,),
            ).fetchone()
            if not proposal:
                raise ValueError("proposal not found")
            before = conn.execute(
                "SELECT state FROM expenses WHERE tenant_id = %s AND id = %s",
                (proposal["tenant_id"], proposal["expense_id"]),
            ).fetchone()
            before_state = str((before or {}).get("state") or "unknown")
            conn.execute(
                """
                UPDATE expenses
                SET state = %s, reviewer = %s, decision_note = %s, reviewed_at = now()
                WHERE tenant_id = %s AND id = %s
                """,
                (
                    proposal["proposed_state"],
                    approver,
                    proposal["note"],
                    proposal["tenant_id"],
                    proposal["expense_id"],
                ),
            )
            conn.execute(
                "UPDATE pg_expense_proposals SET status = 'approved', approved_by = %s, approved_at = now() WHERE id = %s",
                (approver, proposal_id),
            )
            conn.commit()
        return {
            "proposal_id": proposal_id,
            "status": "approved",
            "expense_id": proposal["expense_id"],
            "data_state": {
                "expense_id": proposal["expense_id"],
                "target_table": "expenses",
                "production_before": before_state,
                "staged_state": proposal["proposed_state"],
                "production_after": proposal["proposed_state"],
                "staging_location": "Postgres approval row",
                "production_after_label": "Approved into production",
            },
        }

    def reject_proposal(self, proposal_id: str, reviewer: str, reason: str) -> dict[str, Any]:
        with self.connect() as conn:
            proposal = conn.execute(
                "SELECT * FROM pg_expense_proposals WHERE id = %s",
                (proposal_id,),
            ).fetchone()
            if not proposal:
                raise ValueError("proposal not found")
            before = conn.execute(
                "SELECT state FROM expenses WHERE tenant_id = %s AND id = %s",
                (proposal["tenant_id"], proposal["expense_id"]),
            ).fetchone()
            before_state = str((before or {}).get("state") or "unknown")
            conn.execute(
                "UPDATE pg_expense_proposals SET status = 'rejected', approved_by = %s, approved_at = now() WHERE id = %s",
                (reviewer, proposal_id),
            )
            conn.commit()
        return {
            "proposal_id": proposal_id,
            "status": "rejected",
            "expense_id": proposal["expense_id"],
            "reason": reason,
            "data_state": {
                "expense_id": proposal["expense_id"],
                "target_table": "expenses",
                "production_before": before_state,
                "staged_state": proposal["proposed_state"],
                "production_after": before_state,
                "staging_location": "Postgres approval row",
                "production_after_label": "Rejected; production unchanged",
            },
        }

    def apply_policy_drift_demo(self, tenant_id: str = "acme") -> None:
        with self.connect() as conn:
            conn.execute(
                """
                UPDATE company_policy_chunks
                SET status = 'retired', effective_to = DATE '2026-05-13'
                WHERE tenant_id = %s AND chunk_id = 'POL-ACME-GROUND-OLD'
                """,
                (tenant_id,),
            )
            conn.execute(
                """
                INSERT INTO company_policy_chunks
                VALUES (
                  'POL-ACME-GROUND-NEW', %s, 'Ground transport policy after finance update',
                  'ground_transport', 'active', DATE '2026-05-14', NULL, 'employee',
                  'Finance update: ground transport, rideshare, taxi, and airport rides above $50 now require manager review even when a receipt and card match are present.',
                  %s::vector
                )
                ON CONFLICT (chunk_id) DO NOTHING
                """,
                (tenant_id, vector_literal(simple_policy_vector("ground transport rideshare above 50 manager review"))),
            )
            conn.commit()

    def proposal_for_expense(self, expense_id: str, tenant_id: str = "acme") -> dict[str, Any] | None:
        with self.connect() as conn:
            row = conn.execute(
                """
                SELECT p.*, e.state AS expense_state, e.vendor, e.amount_cents, e.category
                FROM pg_expense_proposals p
                JOIN expenses e ON e.id = p.expense_id AND e.tenant_id = p.tenant_id
                WHERE p.tenant_id = %s AND p.expense_id = %s
                ORDER BY CASE WHEN p.status = 'pending' THEN 0 ELSE 1 END, p.created_at DESC
                LIMIT 1
                """,
                (tenant_id, expense_id),
            ).fetchone()
        return _jsonable_row(row) if row else None

    def latest_run_for_expense(self, expense_id: str, lane: str, tenant_id: str = "acme") -> dict[str, Any] | None:
        with self.connect() as conn:
            row = conn.execute(
                """
                SELECT id, lane, expense_id, question, final_answer, decision,
                       tool_calls, db_round_trips, input_tokens, output_tokens,
                       total_tokens, elapsed_ms, created_at
                FROM pg_agent_runs
                WHERE tenant_id = %s AND expense_id = %s AND lane = %s
                ORDER BY created_at DESC
                LIMIT 1
                """,
                (tenant_id, expense_id, lane),
            ).fetchone()
        return _jsonable_row(row) if row else None

    def queue(self, tenant_id: str = "acme") -> list[dict[str, Any]]:
        with self.connect() as conn:
            return list(
                conn.execute(
                    """
                    SELECT p.*, e.vendor, e.amount_cents, e.category
                    FROM pg_expense_proposals p
                    JOIN expenses e ON e.id = p.expense_id
                    WHERE p.tenant_id = %s AND p.status = 'pending'
                    ORDER BY p.created_at DESC
                    LIMIT 20
                    """,
                    (tenant_id,),
                ).fetchall()
            )

    def create_uploaded_expense(self, payload: dict[str, Any]) -> Expense:
        expense_id = new_id("EXP")
        tx_id = new_id("CTX")
        text = payload["receipt_text"]
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO card_transactions VALUES
                (%s, %s, %s, %s, %s, 'USD', %s, 'posted', %s)
                """,
                (
                    tx_id,
                    payload["tenant_id"],
                    payload["employee_id"],
                    payload["vendor"],
                    payload["amount_cents"],
                    payload["spend_date"],
                    f"Uploaded receipt for {payload['vendor']}",
                ),
            )
            conn.execute(
                """
                INSERT INTO expenses VALUES
                (%s, %s, %s, %s, %s, %s, %s, 'USD', %s, now(), %s, %s, %s, %s,
                 'submitted', NULL, NULL, NULL, 'upload')
                """,
                (
                    expense_id,
                    payload["tenant_id"],
                    payload["employee_id"],
                    tx_id,
                    payload["vendor"],
                    payload["category"],
                    payload["amount_cents"],
                    payload["spend_date"],
                    payload["trip_purpose"],
                    payload.get("nights", 0),
                    text,
                    receipt_hash(text),
                ),
            )
            conn.commit()
        created = self.get_expense(expense_id, payload["tenant_id"])
        if created is None:
            raise RuntimeError("created expense could not be loaded")
        return created

    def record_run(self, row: dict[str, Any]) -> None:
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO pg_agent_runs
                (id, tenant_id, lane, expense_id, question, final_answer, decision,
                 tool_calls, db_round_trips, input_tokens, output_tokens, total_tokens,
                 elapsed_ms, created_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now())
                """,
                (
                    row["id"],
                    row["tenant_id"],
                    row["lane"],
                    row["expense_id"],
                    row["question"],
                    row["final_answer"],
                    row["decision"],
                    row["tool_calls"],
                    row["db_round_trips"],
                    row["input_tokens"],
                    row["output_tokens"],
                    row["total_tokens"],
                    row.get("elapsed_ms", 0),
                ),
            )
            conn.commit()


def _jsonable_row(row: dict[str, Any]) -> dict[str, Any]:
    out = dict(row)
    for key, value in list(out.items()):
        if isinstance(value, datetime):
            out[key] = value.isoformat()
        elif hasattr(value, "isoformat"):
            out[key] = value.isoformat()
    return out


def _expense_row(row: dict[str, Any]) -> dict[str, Any]:
    data = _jsonable_row(row)
    data["spend_date"] = str(data["spend_date"])
    return data
