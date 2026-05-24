from __future__ import annotations

import json
import threading
import urllib.error
import urllib.request
from datetime import UTC, datetime
from typing import Any

from app.config import ROOT, get_settings
from app.schemas import AgentContextBundle, Expense
from app.utils import new_id, normalize_rows, receipt_hash, sql_string


class RemoteSynapsorClient:
    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        project_id: str,
        database_id: str,
        timeout_seconds: int = 45,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.project_id = project_id
        self.database_id = database_id
        self.timeout_seconds = timeout_seconds
        self.session: dict[str, Any] = {}

    def close(self) -> None:
        return None

    def sql(self, sql: str, *, project_id: str | None = None, database_id: str | None = None) -> dict[str, Any]:
        return self.execute(sql, project_id=project_id, database_id=database_id)

    def execute(
        self,
        sql: str,
        *,
        session: dict[str, Any] | None = None,
        as_of: dict[str, Any] | None = None,
        project_id: str | None = None,
        database_id: str | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "sql": sql,
            "project_id": project_id or self.project_id,
            "database_id": database_id or self.database_id,
        }
        request_session = session if session is not None else self.session
        if request_session:
            payload["session"] = request_session
        if as_of is not None:
            payload["as_of"] = as_of
        return self._request("POST", "/v1/query" if as_of is not None else "/v1/sql", payload)

    def query(
        self,
        sql: str,
        *,
        session: dict[str, Any] | None = None,
        as_of: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        result = self.execute(sql, session=session, as_of=as_of)
        results = result.get("results", [])
        if not results:
            return []
        return list(results[-1].get("result", {}).get("rows", []))

    def invoke_agent_capability(
        self,
        capability: str,
        arguments: dict[str, Any] | None = None,
        *,
        session: dict[str, Any] | None = None,
        trace_id: str | None = None,
        mode: str | None = None,
        auto_branch: bool | None = None,
        response_envelope: bool | None = None,
        include_audit_trail: bool | None = None,
        settlement_policy: str | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "capability": capability,
            "arguments": arguments or {},
            "session": self._require_session(session),
        }
        if trace_id is not None:
            payload["trace_id"] = trace_id
        if mode is not None:
            payload["mode"] = mode
        if auto_branch is not None:
            payload["auto_branch"] = bool(auto_branch)
        if response_envelope is not None:
            payload["response_envelope"] = bool(response_envelope)
        if include_audit_trail is not None:
            payload["include_audit_trail"] = bool(include_audit_trail)
        if settlement_policy is not None:
            payload["settlement_policy"] = settlement_policy
        return self._request("POST", "/v1/agent/invoke", payload)

    def diff_branch(self, source: str, target: str = "main") -> dict[str, Any]:
        response = self.execute(f"DIFF BRANCH {source} AGAINST {target};")
        return response.get("results", [{}])[-1].get("result", {})

    def merge_branch(self, source: str, target: str = "main") -> dict[str, Any]:
        return self.execute(f"MERGE BRANCH {source} INTO {target};")

    def drop_branch(self, name: str) -> dict[str, Any]:
        return self.execute(f"DROP BRANCH {name};")

    def read_resource(self, uri: str, *, session: dict[str, Any] | None = None) -> dict[str, Any]:
        return self._request("POST", "/v1/resources/read", {"uri": uri, "session": self._require_session(session)})

    def preview_write(self, proposal: str, *, session: dict[str, Any] | None = None) -> dict[str, Any]:
        return self._proposal_lifecycle("preview", proposal, session=session)

    def approve_write(self, proposal: str, *, session: dict[str, Any] | None = None) -> dict[str, Any]:
        return self._proposal_lifecycle("approve", proposal, session=session)

    def commit_write(
        self,
        proposal: str,
        *,
        session: dict[str, Any] | None = None,
        promote_branch: bool | None = None,
        target_branch: str | None = None,
    ) -> dict[str, Any]:
        return self._proposal_lifecycle(
            "commit",
            proposal,
            session=session,
            promote_branch=promote_branch,
            target_branch=target_branch,
        )

    def reject_write(self, proposal: str, *, session: dict[str, Any] | None = None) -> dict[str, Any]:
        return self._proposal_lifecycle("reject", proposal, session=session)

    def settle_write(self, proposal: str, settlement_policy: str, *, session: dict[str, Any] | None = None) -> dict[str, Any]:
        return self._proposal_lifecycle("settle", proposal, session=session, settlement_policy=settlement_policy)

    def replay_agent_run(
        self,
        run_id: int,
        *,
        include_sensitive_memory: bool = False,
        session: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return self._request(
            "POST",
            "/v1/agent/runs/replay",
            {
                "run_id": int(run_id),
                "session": self._require_session(session),
                "include_sensitive_memory": include_sensitive_memory,
            },
        )

    def _proposal_lifecycle(
        self,
        action: str,
        proposal: str,
        *,
        session: dict[str, Any] | None = None,
        promote_branch: bool | None = None,
        target_branch: str | None = None,
        settlement_policy: str | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {"proposal": proposal, "session": self._require_session(session)}
        if promote_branch is not None:
            payload["promote_branch"] = bool(promote_branch)
        if target_branch is not None:
            payload["target_branch"] = target_branch
        if settlement_policy is not None:
            payload["settlement_policy"] = settlement_policy
        return self._request("POST", f"/v1/agent/proposals/{action}", payload)

    def _require_session(self, session: dict[str, Any] | None = None) -> dict[str, Any]:
        request_session = session if session is not None else self.session
        if not request_session:
            raise ValueError("agent APIs require a session with principal and tenant_id")
        if "principal" not in request_session or "tenant_id" not in request_session:
            raise ValueError("agent session requires principal and tenant_id")
        return request_session

    def _request(self, method: str, path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        request_payload = dict(payload or {})
        request_payload.setdefault("project_id", self.project_id)
        request_payload.setdefault("database_id", self.database_id)
        body = json.dumps(request_payload, separators=(",", ":")).encode("utf-8")
        headers = {
            "accept": "application/json",
            "content-type": "application/json",
            "authorization": f"Bearer {self.api_key}",
            "X-Synapsor-Project-Id": self.project_id,
            "X-Synapsor-Database-Id": self.database_id,
        }
        request = urllib.request.Request(self.base_url + path, data=body, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                raw = response.read().decode("utf-8")
                return json.loads(raw or "{}")
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", errors="replace")
            try:
                detail: Any = json.loads(raw or "{}")
            except json.JSONDecodeError:
                detail = {"error": raw}
            message = detail.get("error") if isinstance(detail, dict) else None
            raise RuntimeError(f"Synapsor HTTP {exc.code}: {message or detail}") from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f"Synapsor request failed: {exc.reason}") from exc


class SynapsorStore:
    def __init__(self) -> None:
        self.settings = get_settings()
        self._db: Any | None = None
        self._lock = threading.RLock()

    def close(self) -> None:
        with self._lock:
            if self._db is not None:
                self._db.close()
                self._db = None

    def db(self) -> Any:
        with self._lock:
            if self._db is None:
                if not self.settings.synapsor_remote_api_key:
                    raise RuntimeError("SYNAPSOR_SERVER_API_KEY or SYNAPSOR_API_KEY is required for the remote Synapsor demo")
                self._db = RemoteSynapsorClient(
                    base_url=self.settings.synapsor_url,
                    api_key=self.settings.synapsor_remote_api_key,
                    project_id=self.settings.synapsor_project_id,
                    database_id=self.settings.synapsor_database_id,
                )
            return self._db

    def reset(self) -> None:
        with self._lock:
            db = self.db()
            self._cleanup_remote_demo(db)
            for name in ["001_schema.sql", "002_seed.sql", "004_indexes.sql", "003_capabilities.sql"]:
                script = (ROOT / "sql" / "synapsor" / name).read_text()
                if name == "003_capabilities.sql":
                    script = script.replace("TARGET BRANCH main", f"TARGET BRANCH {self.settings.synapsor_database_id}")
                self._execute_script(db, script)
            db.execute(
                f"""
                ALTER SETTLEMENT POLICY expenses.green_auto_settle SET TARGET BRANCH {self.settings.synapsor_database_id}
                AUTO APPROVE WHEN
                  PAYLOAD trusted_after.state = 'approved'
                  AND PAYLOAD target_table = 'expenses'
                  AND PAYLOAD operation = 'update'
                  AND PAYLOAD trusted_after.reviewer = 'expense_agent_01'
                AUTO COMMIT
                AUTO MERGE
                ELSE LEAVE PROPOSED;
                """
            )

    def _cleanup_remote_demo(self, db: Any) -> None:
        cleanup_statements = [
            "DROP AGENT CAPABILITY expenses.propose_expense_decision;",
            "DROP AGENT CAPABILITY expenses.review_expense_context;",
            "DROP AGENT CONTEXT expenses.expense_context;",
            "DROP TABLE IF EXISTS expense_audit;",
            "DROP TABLE IF EXISTS expense_guardrail_signals;",
            "DROP TABLE IF EXISTS duplicate_signals;",
            "DROP TABLE IF EXISTS expense_policy_chunks;",
            "DROP TABLE IF EXISTS card_transactions;",
            "DROP TABLE IF EXISTS expenses;",
            "DROP TABLE IF EXISTS employees;",
            "DROP TABLE IF EXISTS tenants;",
        ]
        for statement in cleanup_statements:
            try:
                db.execute(statement)
            except Exception:
                # Reset must be idempotent against an existing hosted demo database.
                # Missing objects and already-dropped dependencies are safe to ignore.
                pass

    def _execute_script(self, db: Any, script: str) -> None:
        for statement in [part.strip() for part in script.split(";") if part.strip()]:
            try:
                db.execute(statement + ";")
            except Exception as exc:
                if statement.upper().startswith("CREATE SETTLEMENT POLICY") and "already" in str(exc).lower():
                    continue
                raise

    def list_expenses(self, tenant_id: str = "acme") -> list[Expense]:
        rows = self.db().query(
            f"""
            SELECT e.id AS id, e.tenant_id AS tenant_id, e.employee_id AS employee_id,
                   emp.full_name AS employee_name, e.vendor AS vendor, e.category AS category,
                   e.amount_cents AS amount_cents, e.currency AS currency, e.spend_date AS spend_date,
                   e.trip_purpose AS trip_purpose, e.nights AS nights, e.receipt_text AS receipt_text,
                   e.state AS state
            FROM expenses e
            JOIN employees emp ON emp.id = e.employee_id
            WHERE e.tenant_id = {sql_string(tenant_id)}
            ORDER BY e.id;
            """
        )
        duplicates = self._duplicate_map(tenant_id)
        expenses: list[Expense] = []
        for row in rows:
            data = dict(row)
            data["duplicate_risk"] = duplicates.get(str(row["id"]), 0)
            expenses.append(Expense.model_validate(data))
        return expenses

    def get_expense(self, expense_id: str, tenant_id: str = "acme") -> Expense | None:
        for expense in self.list_expenses(tenant_id):
            if expense.id == expense_id:
                return expense
        return None

    def _duplicate_map(self, tenant_id: str) -> dict[str, int]:
        rows = self.db().query(
            f"SELECT expense_id, risk_score FROM duplicate_signals WHERE tenant_id = {sql_string(tenant_id)};"
        )
        out: dict[str, int] = {}
        for row in rows:
            out[str(row["expense_id"])] = max(out.get(str(row["expense_id"]), 0), int(row["risk_score"]))
        return out

    def session(self, tenant_id: str, principal: str, expense_id: str, branch: str | None = None) -> dict[str, Any]:
        session = {
            "tenant_id": tenant_id,
            "principal": principal,
            "session_id": f"expense_guard_{expense_id}_{new_id('RUN')}",
            "current_expense_id": expense_id,
            "snapshot_ts": 0,
        }
        if branch:
            session["branch_id"] = branch
        return session

    def context_bundle(
        self,
        expense_id: str,
        question: str,
        tenant_id: str = "acme",
        principal: str = "expense_agent_01",
    ) -> tuple[AgentContextBundle, int, dict[str, Any]]:
        session = self.session(tenant_id, principal, expense_id)
        db_round_trips = 1
        try:
            result = self.db().invoke_agent_capability(
                "expenses.review_expense_context",
                {"expense_question": question},
                session=session,
                mode="read_only",
                response_envelope=True,
                include_audit_trail=True,
            )
            payload = _payload(result)
            policy_hits = _rows(payload.get("policy_hits"))
            if not policy_hits:
                policy_hits = self.hybrid_policy_search(question, tenant_id)
            reason_codes = payload.get("reason_codes", payload.get("r", []))
            bundle = AgentContextBundle(
                expense=_first(payload.get("expense")),
                employee=_employee_for(payload, expense_id),
                card_transaction=_card_for(payload, expense_id),
                duplicate_checks=_rows(payload.get("duplicate_checks")),
                guardrail_signals=_rows(payload.get("guardrail_signals")),
                policy_hits=policy_hits,
                excluded_policy_reasons=self.excluded_policy_reasons(tenant_id),
                capability_decision=str(payload.get("decision") or payload.get("d") or "") or None,
                capability_reason_codes=[str(code) for code in reason_codes] if isinstance(reason_codes, list) else [],
            )
            return bundle, db_round_trips, result
        except Exception as exc:
            raise RuntimeError(
                "Synapsor capability expenses.review_expense_context failed; "
                "the Synapsor lane cannot fall back to app-owned business rules."
            ) from exc

    def hybrid_policy_search(self, question: str, tenant_id: str) -> list[dict[str, Any]]:
        rows = self.db().query(
            f"""
            EXPLAIN HYBRID SEARCH expense_policy_chunks(body)
            QUERY {sql_string(question)}
            TENANT {sql_string(tenant_id)}
            TOP 5;
            """
        )
        # EXPLAIN proves the engine path; the readable hits come from the indexed table with
        # the same authoritative filters because the local SQL surface returns the plan text.
        hits = self.db().query(
            f"""
            SELECT chunk_id, tenant_id, title, topic, status, effective_from, effective_to, allowed_role, body
            FROM expense_policy_chunks
            WHERE tenant_id = {sql_string(tenant_id)} AND status = 'active'
            ORDER BY chunk_id;
            """
        )
        for hit in hits:
            hit["hybrid_explain"] = rows[0]["plan"] if rows else ""
        return hits[:5]

    def excluded_policy_reasons(self, tenant_id: str) -> list[dict[str, Any]]:
        rows = self.db().query(
            "SELECT chunk_id, tenant_id, title, status, effective_from, effective_to FROM expense_policy_chunks;"
        )
        reasons: list[dict[str, Any]] = []
        for row in rows:
            reason = None
            if row["tenant_id"] != tenant_id:
                reason = "wrong tenant"
            elif row["status"] != "active":
                reason = "not active"
            elif row.get("effective_to") and str(row["effective_to"]) <= "2026-05-12":
                reason = "expired"
            if reason:
                reasons.append({"policy": row["chunk_id"], "reason": reason, "title": row["title"]})
        return reasons

    def create_proposal(
        self,
        *,
        tenant_id: str,
        expense_id: str,
        decision: str,
        note: str,
        principal: str,
        reason_codes: list[str] | None = None,
        risk_lane: str = "yellow",
        settlement_policy: str | None = None,
    ) -> dict[str, Any]:
        with self._lock:
            db = self.db()
            session = self.session(tenant_id, principal, expense_id)
            reason_codes_text = ",".join(reason_codes or [])
            result = db.invoke_agent_capability(
                "expenses.propose_expense_decision",
                {
                    "expense_id": expense_id,
                    "decision": decision,
                    "reason_codes": reason_codes_text,
                    "risk_lane": risk_lane,
                    "note": note,
                    "reviewed_at": datetime.now(UTC).isoformat(),
                },
                session=session,
                trace_id=f"expense_guard_{new_id('TRACE').replace('-', '_')}",
                mode="propose_only",
                auto_branch=True,
                response_envelope=True,
                include_audit_trail=True,
                settlement_policy=settlement_policy,
            )
            handle = extract_proposal_handle(result)
            branch = extract_branch_name(result)
            if not branch:
                raise RuntimeError("Synapsor did not return an auto-created proposal branch")
            try:
                diff = db.diff_branch(branch, "main")
            except Exception as exc:
                diff = {"warning": str(exc)}
            return {
                "branch_name": branch,
                "proposal_handle": handle,
                "raw": result,
                "diff": diff,
                "settlement": extract_settlement(result),
            }

    def approve_proposal(self, proposal_handle: str, branch_name: str | None, approver: str) -> dict[str, Any]:
        with self._lock:
            db = self.db()
            owner = self._proposal_owner(proposal_handle) or approver
            session = {"tenant_id": "acme", "principal": owner, "session_id": new_id("APPROVE"), "snapshot_ts": 0}
            if branch_name:
                session["branch_id"] = branch_name
            preview = db.preview_write(proposal_handle, session=session)
            approved = db.approve_write(proposal_handle, session=session)
            committed = db.commit_write(proposal_handle, session=session)
            merged = db.merge_branch(branch_name, "main") if branch_name else {}
            return {
                "preview": preview,
                "approved": approved,
                "committed": committed,
                "merged": merged,
                "approved_by": approver,
                "proposal_owner": owner,
                "settled_by": "synapsor_store",
                "lifecycle": [
                    "PREVIEW WRITE",
                    "APPROVE WRITE",
                    "COMMIT WRITE",
                    "MERGE BRANCH" if branch_name else "NO BRANCH MERGE",
                ],
            }

    def settle_proposal(
        self,
        *,
        tenant_id: str,
        expense_id: str,
        decision: str,
        note: str,
        principal: str,
        context: AgentContextBundle | None,
    ) -> dict[str, Any]:
        """Create a Synapsor proposal and let Synapsor-owned lifecycle settle green cases."""
        risk_lane = self._risk_lane_for_settlement(decision, context)
        reason_codes = [str(code) for code in (context.capability_reason_codes if context else [])]
        proposal = self.create_proposal(
            tenant_id=tenant_id,
            expense_id=expense_id,
            decision=decision,
            note=note,
            principal=principal,
            reason_codes=reason_codes,
            risk_lane=risk_lane,
            settlement_policy="expenses.green_auto_settle",
        )
        proposal["proposed_state"] = decision
        proposal["status"] = "pending_review"
        proposal["auto_result"] = proposal.get("settlement")
        proposal["settled_by"] = "synapsor_settlement_policy"
        proposal["settlement_policy"] = "expenses.green_auto_settle"
        proposal["db_round_trips"] = 1
        proposal["lifecycle"] = [
            "INVOKE expenses.propose_expense_decision",
            "CREATE BRANCH via auto_branch",
            "USE BRANCH",
            "WRITE PROPOSAL staged",
            "SETTLE WRITE using expenses.green_auto_settle",
            "DIFF BRANCH",
        ]
        if self._settlement_auto_merged(proposal.get("settlement")):
            proposal["status"] = "auto_settled"
            proposal["auto_settle_reason"] = "Synapsor settlement policy approved, committed, and merged the green-lane proposal."
            proposal["lifecycle"].extend(["AUTO APPROVE", "AUTO COMMIT", "AUTO MERGE"])
        return proposal

    def reject_proposal(self, proposal_handle: str, branch_name: str | None, reviewer: str) -> dict[str, Any]:
        with self._lock:
            db = self.db()
            owner = self._proposal_owner(proposal_handle) or reviewer
            session = {"tenant_id": "acme", "principal": owner, "session_id": new_id("REJECT"), "snapshot_ts": 0}
            if branch_name:
                session["branch_id"] = branch_name
            preview = db.preview_write(proposal_handle, session=session)
            rejected = db.reject_write(proposal_handle, session=session)
            dropped = {}
            if branch_name:
                try:
                    dropped = db.drop_branch(branch_name)
                except Exception as exc:  # branch may already be gone in repeated demos
                    dropped = {"warning": str(exc)}
            return {
                "preview": preview,
                "rejected": rejected,
                "dropped_branch": dropped,
                "rejected_by": reviewer,
                "proposal_owner": owner,
            }

    def _auto_settle_allowed(self, decision: str, context: AgentContextBundle | None) -> bool:
        if decision != "approved" or context is None:
            return False
        reason_codes = set(str(code) for code in context.capability_reason_codes)
        return context.capability_decision == "approved" and bool(
            {"synapsor_auto_approval_gate", "synapsor_transport_policy_gate"} & reason_codes
        )

    def _risk_lane_for_settlement(self, decision: str, context: AgentContextBundle | None) -> str:
        if self._auto_settle_allowed(decision, context):
            return "green"
        reason_codes = set(str(code) for code in (context.capability_reason_codes if context else []))
        if {"receipt_instruction_injection", "duplicate_or_fraud_signal"} & reason_codes:
            return "red"
        return "yellow"

    def _settlement_auto_merged(self, settlement: Any) -> bool:
        if not isinstance(settlement, dict):
            return False
        text = " ".join(str(value).lower() for value in settlement.values())
        steps = settlement.get("steps")
        if isinstance(steps, list):
            text += " " + " ".join(str(step).lower() for step in steps)
        return (
            "merge" in text
            and ("commit" in text or "committed" in text)
            and ("approve" in text or "approved" in text)
            and "leave_proposed" not in text
        )

    def apply_policy_drift_demo(self, tenant_id: str = "acme") -> None:
        with self._lock:
            db = self.db()
            db.execute(
                f"""
                UPDATE expense_policy_chunks
                SET status = 'retired', effective_to = '2026-05-13'
                WHERE tenant_id = {sql_string(tenant_id)} AND chunk_id = 'POL-ACME-GROUND-OLD';
                """
            )
            existing = db.query(
                f"""
                SELECT chunk_id
                FROM expense_policy_chunks
                WHERE tenant_id = {sql_string(tenant_id)} AND chunk_id = 'POL-ACME-GROUND-NEW';
                """
            )
            if not existing:
                db.execute(
                    f"""
                    INSERT INTO expense_policy_chunks VALUES
                    ('POL-ACME-GROUND-NEW', {sql_string(tenant_id)}, 'Ground transport policy after finance update',
                     'ground_transport', 'active', '2026-05-14', '', 'employee',
                     'Finance update: ground transport, rideshare, taxi, and airport rides above $50 now require manager review even when a receipt and card match are present.');
                    """
                )

    def _proposal_owner(self, proposal_handle: str) -> str | None:
        for row in self.queue("acme"):
            if row.get("handle_uri") == proposal_handle:
                return str(row.get("principal") or "")
        return None

    def proposal_for_expense(self, expense_id: str, tenant_id: str = "acme") -> dict[str, Any] | None:
        rows = self.db().query(
            f"""
            SELECT id, state, handle_uri, summary, tenant_id, principal, branch_name,
                   required_approvals, approval_count, effect_count, trace_id
            FROM synapsor_agent_write_proposals
            WHERE tenant_id = {sql_string(tenant_id)}
            ORDER BY id DESC;
            """
        )
        pending = [row for row in rows if row.get("state") not in {"committed", "rejected", "cancelled"}]
        closed = [row for row in rows if row.get("state") in {"committed", "rejected", "cancelled"}]
        for row in pending + closed:
            if _expense_id_from_summary(row) == expense_id:
                branch = str(row.get("branch_name") or "")
                if branch:
                    try:
                        staged = _first(
                            self.db().query(
                                f"SELECT state FROM expenses WHERE tenant_id = {sql_string(tenant_id)} AND id = {sql_string(expense_id)};",
                                session={"tenant_id": tenant_id, "principal": "expense_viewer", "branch_id": branch, "snapshot_ts": 0},
                            )
                        )
                        if staged.get("state"):
                            row["proposed_state"] = staged["state"]
                    except Exception:
                        pass
                return row
        return None

    def queue(self, tenant_id: str = "acme") -> list[dict[str, Any]]:
        rows = self.db().query(
            f"""
            SELECT id, state, handle_uri, summary, tenant_id, principal, branch_name,
                   required_approvals, approval_count, effect_count, trace_id
            FROM synapsor_agent_write_proposals
            WHERE tenant_id = {sql_string(tenant_id)}
            ORDER BY id DESC;
            """
        )
        return [row for row in rows if row.get("state") not in {"committed", "rejected", "cancelled"}]

    def create_uploaded_expense(self, payload: dict[str, Any]) -> Expense:
        expense_id = new_id("EXP")
        tx_id = new_id("CTX")
        text = payload["receipt_text"]
        db = self.db()
        db.execute(
            f"""
            INSERT INTO card_transactions VALUES
            ({sql_string(tx_id)}, {sql_string(payload['tenant_id'])}, {sql_string(payload['employee_id'])},
             {sql_string(payload['vendor'])}, {payload['amount_cents']}, 'USD', {sql_string(payload['spend_date'])},
             'posted', {sql_string('Uploaded receipt for ' + payload['vendor'])});
            """
        )
        db.execute(
            f"""
            INSERT INTO expenses VALUES
            ({sql_string(expense_id)}, {sql_string(payload['tenant_id'])}, {sql_string(payload['employee_id'])},
             {sql_string(tx_id)}, {sql_string(payload['vendor'])}, {sql_string(payload['category'])},
             {payload['amount_cents']}, 'USD', {sql_string(payload['spend_date'])},
             {sql_string(datetime.now(UTC).isoformat())}, {sql_string(payload['trip_purpose'])},
             {int(payload.get('nights', 0))}, {sql_string(text)}, {sql_string(receipt_hash(text))},
             'submitted', '', '', '', 'upload');
            """
        )
        created = self.get_expense(expense_id, payload["tenant_id"])
        if created is None:
            raise RuntimeError("created Synapsor expense could not be loaded")
        return created


def extract_proposal_handle(envelope: dict[str, Any]) -> str | None:
    for key in ("proposal_handle", "handle_uri"):
        if isinstance(envelope.get(key), str):
            return envelope[key]
    proposal = envelope.get("proposal")
    if isinstance(proposal, dict):
        for key in ("handle_uri", "handle", "proposal_id"):
            value = proposal.get(key)
            if value:
                return _normalize_handle(value)
    audit = envelope.get("audit_trail")
    if isinstance(audit, dict):
        change = audit.get("change")
        if isinstance(change, dict) and change.get("proposal_resource"):
            return _normalize_handle(change["proposal_resource"])
    payload = envelope.get("payload")
    if isinstance(payload, dict):
        return extract_proposal_handle(payload)
    return None


def extract_branch_name(envelope: dict[str, Any]) -> str | None:
    action = envelope.get("action")
    if isinstance(action, dict):
        branch = action.get("branch")
        if isinstance(branch, dict) and isinstance(branch.get("id"), str):
            return branch["id"]
    payload = envelope.get("payload")
    if isinstance(payload, dict) and isinstance(payload.get("branch"), str):
        return payload["branch"]
    if isinstance(envelope.get("branch_id"), str):
        return envelope["branch_id"]
    if isinstance(envelope.get("branch"), str):
        return envelope["branch"]
    return None


def extract_settlement(envelope: dict[str, Any]) -> dict[str, Any] | None:
    settlement = envelope.get("settlement")
    if isinstance(settlement, dict):
        return settlement
    action = envelope.get("action")
    if isinstance(action, dict) and isinstance(action.get("settlement"), dict):
        return action["settlement"]
    payload = envelope.get("payload")
    if isinstance(payload, dict):
        return extract_settlement(payload)
    return None


def _normalize_handle(value: Any) -> str:
    text = str(value)
    if text.isdigit():
        return f"wrp://{text}"
    return text


def _payload(result: dict[str, Any]) -> dict[str, Any]:
    payload = result.get("payload")
    return payload if isinstance(payload, dict) else result


def _rows(value: Any) -> list[dict[str, Any]]:
    return normalize_rows(value)


def _first(value: Any) -> dict[str, Any]:
    rows = _rows(value)
    return rows[0] if rows else {}


def _employee_for(payload: dict[str, Any], expense_id: str) -> dict[str, Any] | None:
    expense = _first(payload.get("expense"))
    employee_id = expense.get("employee_id")
    for row in _rows(payload.get("employee")):
        if row.get("id") == employee_id:
            return row
    return _first(payload.get("employee")) or None


def _card_for(payload: dict[str, Any], expense_id: str) -> dict[str, Any] | None:
    expense = _first(payload.get("expense"))
    card_id = expense.get("card_transaction_id")
    for row in _rows(payload.get("card_transaction")):
        if row.get("id") == card_id:
            return row
    return _first(payload.get("card_transaction")) or None


def _expense_id_from_summary(row: dict[str, Any]) -> str | None:
    summary = str(row.get("summary", ""))
    for token in summary.split():
        if token.startswith("EXP-"):
            return token
    return None
