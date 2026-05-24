import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Activity,
  AlertTriangle,
  Bot,
  CheckCircle2,
  Clock,
  Database,
  Eye,
  FileText,
  GitBranch,
  GitMerge,
  GitPullRequest,
  Lock,
  Play,
  RefreshCw,
  Search,
  ServerCog,
  ShieldCheck,
  Sparkles,
  Table2,
  Terminal,
  X
} from "lucide-react";
import { api } from "./api";
import type { BackgroundState, EvidenceItem, Expense, LaneName, LaneResult, SynapsorTimeTravelResponse } from "./types";

const defaultQuestion =
  "Review this expense against company policy, receipt text, card transaction, duplicate history, and approval requirements.";

function money(cents: number) {
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function stateLabel(state: string) {
  return state.replace(/_/g, " ");
}

function branchLabel(branchName?: string) {
  if (!branchName) return "Review branch";
  const suffix = branchName.split("_").filter(Boolean).slice(-1)[0]?.toUpperCase();
  return suffix ? `Review branch ${suffix}` : "Review branch";
}

function proposalLabel(proposalId?: string) {
  if (!proposalId) return "Proposal";
  return proposalId.replace("wrp://", "Proposal ");
}

function runSessionId(expenseId?: string) {
  return `agent_run_${(expenseId || "EXP-1001").toLowerCase().replace(/-/g, "_")}`;
}

function synapsorHttpEnvelope(expenseId?: string, question = defaultQuestion) {
  return {
    project_id: "expense_guard",
    database_id: "db_expense_guard_dev_1779596067",
    session: {
      tenant_id: "acme",
      principal: "expense_agent_01",
      session_id: runSessionId(expenseId),
      current_expense_id: expenseId || "EXP-1001",
      snapshot_ts: "20260514"
    },
    capability: "expenses.review_expense_context",
    arguments: {
      expense_question: question
    },
    mode: "read_only",
    response_envelope: true,
    include_audit_trail: true
  };
}

function synapsorSqlInvocation(expenseId?: string, question = defaultQuestion) {
  return `SET SESSION tenant_id = 'acme';
SET SESSION principal = 'expense_agent_01';
SET SESSION session_id = '${runSessionId(expenseId)}';
SET SESSION current_expense_id = '${expenseId || "EXP-1001"}';
SET SESSION snapshot_ts = '20260514';

INVOKE AGENT CAPABILITY expenses.review_expense_context
WITH JSON '${JSON.stringify({ expense_question: question })}';

PROPOSE AGENT CAPABILITY expenses.propose_expense_decision
WITH JSON '{"expense_id":"${expenseId || "EXP-1001"}","decision":"manager_review_required","note":"Stage reviewed decision."}';`;
}

function branchDiffLines(result: LaneResult) {
  const proposal = result.raw?.proposal;
  const diff = typeof proposal === "object" && proposal !== null && "diff" in proposal ? (proposal as { diff?: unknown }).diff : undefined;
  if (Array.isArray(diff)) {
    return diff.slice(0, 3).map((item) => String(item));
  }
  if (typeof diff === "string" && diff.trim()) {
    return diff.split("\n").filter(Boolean).slice(0, 3);
  }
  return [`Expense state`, `submitted -> ${stateLabel(result.decision)}`];
}

function isFinalStatus(status: string) {
  return ["approved", "auto_applied", "auto_settled", "rejected", "cancelled", "handled"].includes(status);
}

function isAppliedStatus(status: string) {
  return ["approved", "auto_applied", "auto_settled", "handled"].includes(status);
}

function isAutoSettledStatus(status: string) {
  return ["auto_applied", "auto_settled"].includes(status);
}

function isNotReviewedStatus(status: string) {
  return status === "not_reviewed";
}

export default function App() {
  const [model, setModel] = useState("gpt-5-mini");
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [selectedId, setSelectedId] = useState("EXP-1001");
  const [question, setQuestion] = useState(defaultQuestion);
  const [laneResults, setLaneResults] = useState<Partial<Record<LaneName, LaneResult>>>({});
  const [running, setRunning] = useState<Record<LaneName, boolean>>({ postgres: false, synapsor: false });
  const [startedAt, setStartedAt] = useState<Partial<Record<LaneName, number>>>({});
  const [updatedAt, setUpdatedAt] = useState<Partial<Record<LaneName, number>>>({});
  const [clock, setClock] = useState(Date.now());
  const [loading, setLoading] = useState(false);
  const [stateLoading, setStateLoading] = useState(false);
  const [stateRefresh, setStateRefresh] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<{ lane: string; items: EvidenceItem[] } | null>(null);
  const [graphResult, setGraphResult] = useState<LaneResult | null>(null);
  const [rowResult, setRowResult] = useState<LaneResult | null>(null);
  const [whyResult, setWhyResult] = useState<LaneResult | null>(null);
  const [timeTravel, setTimeTravel] = useState<SynapsorTimeTravelResponse | null>(null);
  const [timeTravelLoading, setTimeTravelLoading] = useState(false);
  const [timeTravelError, setTimeTravelError] = useState<string | null>(null);
  const [policyUpdate, setPolicyUpdate] = useState<Record<string, unknown> | null>(null);
  const [policyUpdateLoading, setPolicyUpdateLoading] = useState(false);
  const [requestTab, setRequestTab] = useState<"natural" | "http" | "sql">("http");
  const [describeModal, setDescribeModal] = useState<"capability" | "context" | null>(null);
  const [background, setBackground] = useState<BackgroundState | null>(null);
  const stateRequestId = useRef(0);

  const selected = useMemo(
    () => expenses.find((expense) => expense.id === selectedId) || expenses[0],
    [expenses, selectedId]
  );

  async function load(preferredSelectedId = selectedId) {
    const [health, rows, bg] = await Promise.all([api.health(), api.expenses(), api.background()]);
    setModel(health.model);
    setExpenses(rows);
    setBackground(bg);
    if (!rows.find((row) => row.id === preferredSelectedId) && rows[0]) setSelectedId(rows[0].id);
  }

  async function hydrateExpenseState(expenseId: string) {
    const requestId = ++stateRequestId.current;
    setStateLoading(true);
    setLaneResults({});
    try {
      const state = await api.expenseState(expenseId);
      if (requestId !== stateRequestId.current) return;
      setLaneResults({
        postgres: state.postgres || undefined,
        synapsor: state.synapsor || undefined,
      });
    } catch (err) {
      if (requestId === stateRequestId.current) setError(String(err));
    } finally {
      if (requestId === stateRequestId.current) setStateLoading(false);
    }
  }

  async function refreshPolicyUpdateStatus(expenseId: string) {
    try {
      setPolicyUpdate(await api.policyUpdateStatus(expenseId));
    } catch {
      setPolicyUpdate(null);
    }
  }

  useEffect(() => {
    load().catch((err) => setError(String(err)));
  }, []);

  useEffect(() => {
    if (!running.postgres && !running.synapsor) return;
    const id = window.setInterval(() => setClock(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [running]);

  useEffect(() => {
    if (!evidence && !graphResult && !rowResult && !whyResult && !timeTravel && !timeTravelLoading && !timeTravelError && !describeModal) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setEvidence(null);
      if (event.key === "Escape") setGraphResult(null);
      if (event.key === "Escape") setRowResult(null);
      if (event.key === "Escape") setWhyResult(null);
      if (event.key === "Escape") setTimeTravel(null);
      if (event.key === "Escape") setTimeTravelLoading(false);
      if (event.key === "Escape") setTimeTravelError(null);
      if (event.key === "Escape") setDescribeModal(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [evidence, graphResult, rowResult, whyResult, timeTravel, timeTravelLoading, timeTravelError, describeModal]);

  useEffect(() => {
    if (!selectedId || expenses.length === 0 || running.postgres || running.synapsor) return;
    hydrateExpenseState(selectedId).finally(() => {});
    refreshPolicyUpdateStatus(selectedId).finally(() => {});
  }, [selectedId, expenses.length, stateRefresh]);

  async function runReview() {
    if (!selected) return;
    setLoading(true);
    setError(null);
    setLaneResults({});
    setUpdatedAt({});
    const now = Date.now();
    setStartedAt({ postgres: now, synapsor: now });
    setRunning({ postgres: true, synapsor: true });
    try {
      await Promise.allSettled(
        (["postgres", "synapsor"] as LaneName[]).map(async (lane) => {
          try {
            const result = await api.reviewLane(lane, selected.id, question);
            setLaneResults((current) => ({ ...current, [lane]: result }));
            setUpdatedAt((current) => ({ ...current, [lane]: Date.now() }));
          } catch (err) {
            setError(`${lane === "postgres" ? "Postgres" : "Synapsor"} lane failed: ${String(err)}`);
          } finally {
            setRunning((current) => ({ ...current, [lane]: false }));
          }
        })
      );
      await load();
      await refreshPolicyUpdateStatus(selected.id);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  function selectExpense(expenseId: string) {
    setError(null);
    setEvidence(null);
    setGraphResult(null);
    setRowResult(null);
    setWhyResult(null);
    setTimeTravel(null);
    setTimeTravelLoading(false);
    setTimeTravelError(null);
    setPolicyUpdate(null);
    setDescribeModal(null);
    setLaneResults({});
    setStateLoading(true);
    if (expenseId === selectedId) {
      setStateRefresh((current) => current + 1);
    } else {
      setSelectedId(expenseId);
    }
  }

  async function approve(lane: "postgres" | "synapsor", result?: LaneResult) {
    if (!result?.proposal_id) return;
    setLoading(true);
    setError(null);
    try {
      const approval = await api.approve(lane, result.proposal_id, result.branch_name);
      setLaneResults((current) => ({
        ...current,
        [lane]: {
          ...result,
          status: "approved",
          raw: {
            ...result.raw,
            approval: approval.raw,
            data_state: approval.raw?.data_state || approvedDataState(result)
          }
        }
      }));
      setUpdatedAt((current) => ({ ...current, [lane]: Date.now() }));
      await load();
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  async function reject(lane: "postgres" | "synapsor", result?: LaneResult) {
    if (!result?.proposal_id) return;
    setLoading(true);
    setError(null);
    try {
      const rejection = await api.reject(lane, result.proposal_id, result.branch_name);
      setLaneResults((current) => ({
        ...current,
        [lane]: {
          ...result,
          status: "rejected",
          raw: {
            ...result.raw,
            rejection: rejection.raw,
            data_state: rejection.raw?.data_state || rejectedDataState(result)
          }
        }
      }));
      setUpdatedAt((current) => ({ ...current, [lane]: Date.now() }));
      await load();
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  async function toggleBackground() {
    setBackground(await api.setBackground(!background?.enabled));
  }

  async function reset() {
    setLoading(true);
    setLaneResults({});
    setRunning({ postgres: false, synapsor: false });
    setStartedAt({});
    setUpdatedAt({});
    setEvidence(null);
    setGraphResult(null);
    setRowResult(null);
    setWhyResult(null);
    setTimeTravel(null);
    setTimeTravelLoading(false);
    setTimeTravelError(null);
    setDescribeModal(null);
    setError(null);
    try {
      await api.reset();
      const resetSelected = "EXP-1001";
      setSelectedId(resetSelected);
      setQuestion(defaultQuestion);
      await load(resetSelected);
      await hydrateExpenseState(resetSelected);
      await refreshPolicyUpdateStatus(resetSelected);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  async function openTimeTravel() {
    if (!selected) return;
    setError(null);
    setTimeTravel(null);
    setTimeTravelError(null);
    setTimeTravelLoading(true);
    try {
      setTimeTravel(await api.synapsorTimeTravel(selected.id));
    } catch (err) {
      setTimeTravelError(String(err));
    } finally {
      setTimeTravelLoading(false);
    }
  }

  async function applyFinancePolicyUpdate() {
    if (!selected) return;
    setPolicyUpdateLoading(true);
    setError(null);
    try {
      const status = await api.applyPolicyUpdate(selected.id);
      setPolicyUpdate(status);
      setTimeTravel(null);
      setTimeTravelError(null);
      setStateRefresh((current) => current + 1);
    } catch (err) {
      setError(String(err));
    } finally {
      setPolicyUpdateLoading(false);
    }
  }

  return (
    <main>
      <section className="hero">
        <div>
          <div className="eyebrow"><ShieldCheck size={16} /> Demo workload: Expense approvals</div>
          <h1>Synapsor Agent-Native DBMS</h1>
          <p>
            Synapsor is the database trust layer for AI agents. This demo uses expense approvals as
            the workload to show DB-native agent sessions, hidden context, capabilities, hybrid
            evidence, branch-staged writes, policy gates, and replayable audit.
          </p>
          <div className="slogan" aria-label="Synapsor DBMS primitives">
            <span>Agent Session</span>
            <span>Hidden Bindings</span>
            <span>Agent Context</span>
            <span>Capability</span>
            <span>Hybrid Evidence</span>
            <span>Branch</span>
            <span>Write Proposal</span>
            <span>Agent Time Travel</span>
          </div>
        </div>
        <div className="heroCard">
          <div className="heroMetric"><ServerCog size={18} /> DBMS owns the agent action lifecycle</div>
          <div className="heroMetric"><Sparkles size={18} /> Model: {model}</div>
          <div className="heroMetric"><Database size={18} /> Normal DBMS path vs Synapsor path</div>
        </div>
      </section>

      {error && <div className="error">{error}</div>}

      <PlainEnglishDemoMap />
      <ExecutionSpine />
      <section className="notExpenseBanner">
        <strong>This is not an expense product demo.</strong>
        <p>
          Expense approval is only the workload. The product being demonstrated is Synapsor&apos;s
          DB-native trust layer for agents: session-bound authority, deterministic context,
          governed evidence, branch-staged writes, policy gates, and replayable audit.
        </p>
      </section>
      <ResponsibilitySplit />

      <section className="workspace">
        <aside className="panel expensePicker">
          <div className="panelTitle"><Table2 size={18} /> Workload rows: expenses table</div>
          <p className="panelIntro">
            These are ordinary application rows. The point is what Synapsor does when an agent
            tries to act on one of them.
          </p>
          <div className="expenseList">
            {expenses.map((expense) => (
              <button
                key={expense.id}
                className={`expenseButton ${expense.id === selectedId ? "active" : ""}`}
                onClick={() => selectExpense(expense.id)}
              >
                <span>{expense.vendor}</span>
                <strong>{money(expense.amount_cents)}</strong>
                <small>{expense.employee_name} · {expense.category} · {stateLabel(expense.state)}</small>
              </button>
            ))}
          </div>
        </aside>

        <section className="panel requestPanel">
          <div className="panelTitle"><Terminal size={18} /> Agent Capability Invocation</div>
          {selected && (
            <div className="receiptCard">
              <div className="receiptTop">
                <div>
                  <strong>{selected.vendor}</strong>
                  <span>{selected.employee_name} · {selected.category}</span>
                </div>
                <div className="amount">{money(selected.amount_cents)}</div>
              </div>
              <p>{selected.receipt_text}</p>
            </div>
          )}
          {selected && (
            <ExpenseSituationPanel
              expense={selected}
              postgres={laneResults.postgres}
              synapsor={laneResults.synapsor}
            />
          )}
          {selected && (
            <TimeTravelDemoStepper
              expense={selected}
              synapsor={laneResults.synapsor}
              policyUpdate={policyUpdate}
              applying={policyUpdateLoading}
              onApplyPolicyUpdate={applyFinancePolicyUpdate}
              onOpenTimeTravel={openTimeTravel}
            />
          )}
          <div className="requestTabs" aria-label="Synapsor invocation views">
            <button className={requestTab === "natural" ? "active" : ""} onClick={() => setRequestTab("natural")}>Natural language</button>
            <button className={requestTab === "http" ? "active" : ""} onClick={() => setRequestTab("http")}>HTTP envelope</button>
            <button className={requestTab === "sql" ? "active" : ""} onClick={() => setRequestTab("sql")}>SQL invocation</button>
          </div>
          {requestTab === "natural" ? (
            <textarea value={question} onChange={(event) => setQuestion(event.target.value)} />
          ) : requestTab === "http" ? (
            <pre className="codePanel">{JSON.stringify(synapsorHttpEnvelope(selected?.id, question), null, 2)}</pre>
          ) : (
            <pre className="codePanel">{synapsorSqlInvocation(selected?.id, question)}</pre>
          )}
          <div className="actionDisclosure">
            <ShieldCheck size={15} />
            <span>
              This run may stage a proposal or auto-apply a low-risk approval in each lane. The result cards show exactly
              whether Postgres app workflow applied it or Synapsor settlement policy merged it.
            </span>
          </div>
          <div className="actions">
            <button className="primary" onClick={runReview} disabled={loading || !selected}>
              {loading ? <RefreshCw className="spin" size={17} /> : <Play size={17} />}
              Run same agent through both data layers
            </button>
            <button className="ghost" onClick={reset} disabled={loading}><RefreshCw size={17} /> Reset full demo seed data</button>
          </div>
        </section>

        <section className="panel automationPanel">
          <div className="panelTitle"><Clock size={18} /> Background agent using Synapsor</div>
          <p>
            Explicit demo mode. When enabled, it periodically reviews submitted rows with the same visible lane logic;
            it is paused by default and reset clears its processed list.
          </p>
          <button className={background?.enabled ? "danger" : "primary"} onClick={toggleBackground}>
            <Activity size={17} /> {background?.enabled ? "Pause background capability calls" : "Run background capability calls"}
          </button>
          <button className="ghost" onClick={() => api.runBackgroundOnce().then(setBackground)}>
            <Play size={17} /> Invoke once
          </button>
          <div className="bgStatus">
            <span>{background?.last_message || "Idle"}</span>
            <small>Processed: {background?.processed_count ?? 0}</small>
          </div>
        </section>
      </section>

      {(laneResults.postgres || laneResults.synapsor || running.postgres || running.synapsor) && (
        <ExpenseRunSummary
          selected={selected}
          postgres={laneResults.postgres}
          synapsor={laneResults.synapsor}
          running={running}
        />
      )}

      <section className="comparison">
        <LaneCard
          title="General-purpose DBMS path: Postgres"
          subtitle="The app must assemble context, run policy logic, stage approval state, and log audit evidence itself."
          accent="amber"
          result={laneResults.postgres}
          running={running.postgres}
          hydrating={stateLoading}
          startedAt={startedAt.postgres}
          updatedAt={updatedAt.postgres}
          now={clock}
          onEvidence={(items) => setEvidence({ lane: "Postgres lane evidence", items })}
          onWhy={setWhyResult}
          onApprove={() => approve("postgres", laneResults.postgres)}
          onReject={() => reject("postgres", laneResults.postgres)}
          onGraph={setGraphResult}
          onRows={setRowResult}
        />
        <LaneCard
          title="Synapsor agent-native DBMS path"
          subtitle="Synapsor owns session context, hidden bindings, capability execution, evidence, branch staging, write proposal lifecycle, and replay."
          accent="green"
          result={laneResults.synapsor}
          running={running.synapsor}
          hydrating={stateLoading}
          startedAt={startedAt.synapsor}
          updatedAt={updatedAt.synapsor}
          now={clock}
          onEvidence={(items) => setEvidence({ lane: "Synapsor lane evidence", items })}
          onWhy={setWhyResult}
          onApprove={() => approve("synapsor", laneResults.synapsor)}
          onReject={() => reject("synapsor", laneResults.synapsor)}
          onGraph={setGraphResult}
          onRows={setRowResult}
          onDescribeCapability={() => setDescribeModal("capability")}
          onDescribeContext={() => setDescribeModal("context")}
          onTimeTravel={openTimeTravel}
        />
      </section>

      <AnimatePresence>
        {evidence && (
          <motion.div
            className="modalBackdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onMouseDown={() => setEvidence(null)}
          >
            <motion.div
              className="modal"
              initial={{ y: 28, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 28, opacity: 0 }}
              onMouseDown={(event) => event.stopPropagation()}
            >
              <button className="close" onClick={() => setEvidence(null)}><X size={18} /></button>
              <h2>{evidence.lane}</h2>
              <EvidenceModalContent items={evidence.items} />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {graphResult && (
          <BranchGraphModal
            result={graphResult}
            onClose={() => setGraphResult(null)}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {rowResult && (
          <RowLevelModal
            result={rowResult}
            onClose={() => setRowResult(null)}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {whyResult && (
          <WhyAuditModal
            result={whyResult}
            onClose={() => setWhyResult(null)}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {(timeTravel || timeTravelLoading || timeTravelError) && (
          <TimeTravelModal
            data={timeTravel}
            loading={timeTravelLoading}
            error={timeTravelError}
            onClose={() => {
              setTimeTravel(null);
              setTimeTravelLoading(false);
              setTimeTravelError(null);
            }}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {describeModal && (
          <DescribeSynapsorModal
            kind={describeModal}
            onClose={() => setDescribeModal(null)}
          />
        )}
      </AnimatePresence>
    </main>
  );
}

function PlainEnglishDemoMap() {
  return (
    <section className="plainDemoMap">
      <div className="plainDemoIntro">
        <span><Eye size={16} /> 10-second read</span>
        <strong>One expense. Same AI question. Two database responsibility models.</strong>
        <p>
          Postgres is a capable storage layer, but the app has to assemble context, policy checks,
          approvals, audit, and replay. Synapsor moves those agent-control responsibilities into
          database objects.
        </p>
      </div>
      <div className="plainDemoSteps">
        <article>
          <em>1</em>
          <strong>Pick an expense</strong>
          <p>Choose coffee, hotel, duplicate airfare, receipt injection, or the Uber time-travel case.</p>
        </article>
        <article>
          <em>2</em>
          <strong>Run both lanes</strong>
          <p>The same agent request runs through Postgres app glue and Synapsor capabilities.</p>
        </article>
        <article>
          <em>3</em>
          <strong>Compare ownership</strong>
          <p>Look for who owns evidence, policy gates, safe writes, branch/merge, and replay.</p>
        </article>
      </div>
    </section>
  );
}

function ExpenseRunSummary({
  selected,
  postgres,
  synapsor,
  running,
}: {
  selected?: Expense;
  postgres?: LaneResult;
  synapsor?: LaneResult;
  running: Record<LaneName, boolean>;
}) {
  const status = running.postgres || running.synapsor ? "running" : "done";
  const pgText = postgres ? lanePlainOutcome(postgres) : running.postgres ? "Postgres lane is still running." : "Postgres lane has not returned yet.";
  const synText = synapsor ? lanePlainOutcome(synapsor) : running.synapsor ? "Synapsor lane is still running." : "Synapsor lane has not returned yet.";
  const tokenDelta =
    postgres && synapsor
      ? Math.max(0, postgres.metrics.input_tokens - synapsor.metrics.input_tokens)
      : 0;
  const glueDelta =
    postgres && synapsor
      ? Math.max(0, postgres.metrics.app_glue_lines - synapsor.metrics.app_glue_lines)
      : 0;
  return (
    <section className="runSummaryPanel">
      <div className="runSummaryHeader">
        <span>{status === "running" ? "Running now" : "What just happened"}</span>
        <strong>{selected ? `${selected.vendor}: ${money(selected.amount_cents)}` : "Expense review"}</strong>
        <p>
          This panel gives the quick summary first. The detailed cards below show the raw evidence,
          DB objects, branch/proposal state, and metrics.
        </p>
      </div>
      <div className="runSummaryGrid">
        <article>
          <Database size={19} />
          <span>Postgres lane</span>
          <strong>{pgText}</strong>
          <p>Correctness can be good; the app owns more workflow and audit responsibility.</p>
        </article>
        <article className="syn">
          <ServerCog size={19} />
          <span>Synapsor lane</span>
          <strong>{synText}</strong>
          <p>Synapsor owns session context, evidence, policy gate, settlement, branch, and replay.</p>
        </article>
        <article className="metric">
          <Sparkles size={19} />
          <span>Why it matters</span>
          <strong>{tokenDelta ? `${tokenDelta.toLocaleString()} fewer input tokens` : "Less app-owned agent glue"}</strong>
          <p>{glueDelta ? `${glueDelta.toLocaleString()} app glue LOC avoided in the Synapsor lane.` : "The difference is where authority lives."}</p>
        </article>
      </div>
    </section>
  );
}

function lanePlainOutcome(result: LaneResult) {
  if (isAutoSettledStatus(result.status)) {
    return result.lane === "synapsor"
      ? "Approved and auto-settled by Synapsor policy."
      : "Approved and auto-applied by app workflow.";
  }
  if (result.status === "branch_staged") return "Staged safely; production waits for review.";
  if (result.status === "pending_review") return "Needs human review before production changes.";
  if (result.status === "approved") return "Approved into production.";
  if (result.status === "rejected") return "Rejected; production stayed unchanged.";
  if (isNotReviewedStatus(result.status)) return "No fresh review yet.";
  return `${stateLabel(result.status)}: ${stateLabel(result.decision)}.`;
}

function TimeTravelDemoStepper({
  expense,
  synapsor,
  policyUpdate,
  applying,
  onApplyPolicyUpdate,
  onOpenTimeTravel
}: {
  expense: Expense;
  synapsor?: LaneResult;
  policyUpdate: Record<string, unknown> | null;
  applying: boolean;
  onApplyPolicyUpdate: () => void;
  onOpenTimeTravel: () => void;
}) {
  if (expense.id !== "EXP-2001") return null;
  const agentRan = Boolean(synapsor);
  const policyApplied = Boolean(policyUpdate?.applied);
  return (
    <section className="timeTravelDemoStepper">
      <div className="stepperHeader">
        <span><Clock size={15} /> Agent Time Travel demo row</span>
        <strong>Keep the story in three separate clicks</strong>
        <p>
          This Uber ride is seeded to show policy drift. The agent does not change policy.
          First run the agent, then explicitly simulate a later finance policy update, then inspect Time Travel.
        </p>
      </div>
      <div className="stepperSteps">
        <div className={`stepperStep ${agentRan ? "done" : ""}`}>
          <span>{agentRan ? <CheckCircle2 size={17} /> : "1"}</span>
          <div>
            <strong>Run Synapsor review</strong>
            <p>Agent sees the $92 Uber ride and the original policy: rides under $100 can be approved.</p>
          </div>
        </div>
        <div className={`stepperStep ${policyApplied ? "done" : ""}`}>
          <span>{policyApplied ? <CheckCircle2 size={17} /> : "2"}</span>
          <div>
            <strong>Apply later finance policy update</strong>
            <p>This is a separate demo action. It retires the $100 policy and makes rides above $50 require review.</p>
            <button className="ghost compactAction" onClick={onApplyPolicyUpdate} disabled={!agentRan || applying || policyApplied}>
              {applying ? <RefreshCw className="spin" size={15} /> : <GitMerge size={15} />}
              {policyApplied ? "Policy update applied" : "Simulate finance policy update"}
            </button>
          </div>
        </div>
        <div className="stepperStep">
          <span>3</span>
          <div>
            <strong>Open Agent Time Travel</strong>
            <p>Synapsor compares what the agent saw then with current production policy now.</p>
            <button className="ghost compactAction" onClick={onOpenTimeTravel} disabled={!agentRan}>
              <Clock size={15} /> Open Time Travel
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function ExecutionSpine() {
  const steps = [
    { label: "SET SESSION", detail: "tenant_id, principal, current_expense_id, and snapshot_ts are bound by the DBMS. The LLM does not choose these values." },
    { label: "USE AGENT CONTEXT", detail: "Synapsor prepares deterministic joins, tenant filters, policy search, and evidence handles before the model responds." },
    { label: "INVOKE CAPABILITY", detail: "The agent calls a named database capability instead of receiving arbitrary read/write access." },
    { label: "SEARCH HYBRID EVIDENCE", detail: "Policy chunks are retrieved through a Synapsor hybrid index with tenant/status filters below app code." },
    { label: "CREATE BRANCH", detail: "Write-capable actions get an isolated branch so production rows remain protected." },
    { label: "STAGE WRITE PROPOSAL", detail: "The agent does not directly mutate production rows. Synapsor stages the change as a DB-native proposal." },
    { label: "POLICY GATE", detail: "DB-owned evidence and capability rules choose green, yellow, or red action control." },
    { label: "SETTLEMENT POLICY", detail: "Green can auto-approve, auto-commit, and auto-merge inside Synapsor; yellow waits for review and red is blocked or escalated." },
    { label: "AGENT TIME TRAVEL", detail: "Synapsor can query AS OF AGENT RUN, replay the run, branch from the run snapshot, and diff against current data." },
  ];
  return (
    <section className="executionSpine" aria-label="Synapsor DBMS execution spine">
      <div className="sectionHeader">
        <span><ServerCog size={16} /> Synapsor DBMS execution spine</span>
        <strong>What happens inside the database when the agent acts</strong>
      </div>
      <div className="spineTrack">
        {steps.map((step, index) => (
          <div className="spineStep" tabIndex={0} key={step.label} aria-label={`${step.label}: ${step.detail}`}>
            <em>{index + 1}</em>
            <strong>{step.label}</strong>
            <p>{step.detail}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function ResponsibilitySplit() {
  const rows = [
    ["Session/tenant scope", "App code", "DB session"],
    ["Policy retrieval", "App/vector glue", "Agent context + hybrid index"],
    ["Sensitive IDs", "Prompt/tool args", "Hidden session bindings"],
    ["Write safety", "App approval rows", "Native write proposals"],
    ["Isolation", "App convention", "DB branch"],
    ["Evidence", "App logs", "DB resource handles"],
    ["Replay/time travel", "Custom tracing", "AS OF AGENT RUN + replay"],
  ];
  return (
    <section className="responsibilitySplit">
      <div className="sectionHeader">
        <span><GitPullRequest size={16} /> Same workload, different responsibility split</span>
        <strong>Normal DBMS stores rows. Synapsor also governs agent authority and actions.</strong>
      </div>
      <div className="splitTable">
        <div className="splitHead">Responsibility</div>
        <div className="splitHead">Normal DBMS path</div>
        <div className="splitHead syn">Synapsor path</div>
        {rows.map(([responsibility, normal, synapsor]) => (
          <div className="splitRow" key={responsibility}>
            <span>{responsibility}</span>
            <span>{normal}</span>
            <strong>{synapsor}</strong>
          </div>
        ))}
      </div>
    </section>
  );
}

function ExpenseSituationPanel({
  expense,
  postgres,
  synapsor,
}: {
  expense: Expense;
  postgres?: LaneResult | null;
  synapsor?: LaneResult | null;
}) {
  const situation = expenseSituation(expense.id);
  return (
    <section className="situationPanel">
      <div className="situationHeader">
        <span>Selected workload situation</span>
        <strong>{situation.title}</strong>
      </div>
      <p>{situation.summary}</p>
      <div className="situationGrid">
        <SituationLane title="General-purpose DBMS path: Postgres" expected={situation.postgres} result={postgres} tone="app" />
        <SituationLane title="Synapsor agent-native DBMS path" expected={situation.synapsor} result={synapsor} tone="db" />
      </div>
      <div className="situationTruth">
        <ShieldCheck size={15} />
        <span>{situation.truth}</span>
      </div>
    </section>
  );
}

function SituationLane({
  title,
  expected,
  result,
  tone,
}: {
  title: string;
  expected: string;
  result?: LaneResult | null;
  tone: "app" | "db";
}) {
  const actual = result ? `${stateLabel(result.status)}: ${stateLabel(result.decision)}` : "Not run yet";
  return (
    <section className={`situationLane ${tone}`}>
      <h3>{title}</h3>
      <div>
        <span>Expected</span>
        <strong>{expected}</strong>
      </div>
      <div>
        <span>Actual run</span>
        <strong>{actual}</strong>
      </div>
    </section>
  );
}

function expenseSituation(expenseId: string) {
  const fallback = {
    title: "Standard expense review",
    summary: "Both lanes review the same row, evidence, policy, and duplicate signals.",
    postgres: "App gathers context and policy, then stages or applies the result through app-owned workflow code.",
    synapsor: "DB capability gathers hidden context and evidence, then stages or applies the result through Synapsor write proposals.",
    truth: "The demo compares ownership, not fake business outcomes.",
  };
  const situations: Record<string, typeof fallback> = {
    "EXP-1001": {
      title: "Low-risk meal auto-approval",
      summary: "Coffee is under the meal threshold with receipt, card match, active employee, and no duplicate or guardrail signal.",
      postgres: "Can auto-approve. The app owns joins, policy checks, approval row, audit, and production update.",
      synapsor: "Auto-settles through the DB-owned green policy gate, write proposal, settlement policy, branch merge, and replay record.",
      truth: "Both lanes may approve; Synapsor's advantage is that authority and replay are database objects.",
    },
    "EXP-1002": {
      title: "Hotel review threshold",
      summary: "The hotel expense exceeds the review threshold, so production should stay submitted until review.",
      postgres: "Stages a manager-review recommendation in app-owned proposal tables.",
      synapsor: "Stages the recommendation on a Synapsor branch with a DB-owned write proposal; production remains unchanged.",
      truth: "Then and now can match here because branch staging intentionally avoids production mutation.",
    },
    "EXP-1003": {
      title: "Prompt-injection receipt",
      summary: "The receipt contains instruction-like text asking the agent to approve and skip review.",
      postgres: "App glue must detect or encode the guardrail and route the recommendation to security review.",
      synapsor: "DB context includes guardrail signals, so the capability returns a red/security-review path.",
      truth: "The receipt is data, not instructions. Synapsor makes that boundary DB-owned.",
    },
    "EXP-1004": {
      title: "Duplicate airfare risk",
      summary: "The airfare has a high duplicate signal against an already-approved matching expense.",
      postgres: "App code fetches duplicate rows and must enforce finance review or rejection.",
      synapsor: "DB capability includes duplicate evidence and returns finance review through governed evidence.",
      truth: "Both should avoid auto-approval; Synapsor owns evidence handles and replay for why.",
    },
    "EXP-1005": {
      title: "Already-approved comparison row",
      summary: "This row is the prior approved airfare used as duplicate evidence for EXP-1004.",
      postgres: "Acts mostly as app-visible historical business data.",
      synapsor: "Acts as DB-visible evidence that can be attached to an agent run and replay trail.",
      truth: "This is mostly evidence, not the primary review target.",
    },
    "EXP-2001": {
      title: "Policy drift time-travel audit",
      summary: "Uber is under the original $100 ground-transport threshold. The later $50 policy change is a separate demo step you trigger after the agent run.",
      postgres: "Can auto-approve too. But old-policy evidence and time-travel explanation are app-owned conventions.",
      synapsor: "Auto-approves through the DB-owned capability. After you explicitly apply the later policy update, Agent Time Travel shows old policy versus current policy.",
      truth: "This does not claim Postgres cannot approve. It shows Synapsor owns the agent-run snapshot and replay semantics inside the DBMS.",
    },
  };
  return situations[expenseId] || fallback;
}

function DescribeSynapsorModal({ kind, onClose }: { kind: "capability" | "context"; onClose: () => void }) {
  const isCapability = kind === "capability";
  return (
    <motion.div
      className="modalBackdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onMouseDown={onClose}
    >
      <motion.div
        className="modal describeModal"
        initial={{ y: 28, opacity: 0, scale: .98 }}
        animate={{ y: 0, opacity: 1, scale: 1 }}
        exit={{ y: 28, opacity: 0, scale: .98 }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button className="close" onClick={onClose}><X size={18} /></button>
        <div className="graphModalHeader">
          <div>
            <span>{isCapability ? "Capability catalog" : "Context catalog"}</span>
            <h2>{isCapability ? "DESCRIBE AGENT CAPABILITY" : "DESCRIBE AGENT CONTEXT"}</h2>
            <p>
              {isCapability
                ? "The agent is allowed to call a named DB capability. Hidden bindings and write proposal semantics live in catalog state."
                : "The context tells Synapsor how to bind the workload row and prepare deterministic evidence before the model responds."}
            </p>
          </div>
        </div>
        <pre className="codePanel largeCode">{isCapability ? `DESCRIBE AGENT CAPABILITY expenses.propose_expense_decision;

Capability: expenses.propose_expense_decision
Execution: PROPOSAL
Context: expenses.expense_context

Hidden bindings:
- tenant_id FROM SESSION tenant_id
- principal FROM SESSION principal
- current_expense_id FROM SESSION current_expense_id

Write proposal:
TARGET expenses
OPERATION UPDATE
LOOKUP id FROM ARG expense_id
TENANT tenant_id FROM BINDING tenant_id
COLUMNS state, reviewer, decision_note, reviewed_at
AUDIT expense_audit` : `DESCRIBE AGENT CONTEXT expenses.expense_context;

ROOT expenses AS expense
LOOKUP expense.id = SESSION current_expense_id

OUTPUT SLOTS:
- expense_id AS expense.id
- employee_id AS expense.employee_id
- card_transaction_id AS expense.card_transaction_id
- amount_cents AS expense.amount_cents

Capability plan includes:
- SCAN employees with tenant filter
- SCAN card_transactions with tenant filter
- SCAN duplicate_signals
- SCAN expense_guardrail_signals
- HYBRID_SEARCH expense_policy_chunks(body)
  FILTER tenant_id = SESSION tenant_id, status = 'active'

EVIDENCE ON`}</pre>
      </motion.div>
    </motion.div>
  );
}

function TimeTravelModal({
  data,
  loading,
  error,
  onClose,
}: {
  data: SynapsorTimeTravelResponse | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
}) {
  if (loading || error || !data) {
    return (
      <motion.div
        className="modalBackdrop timeTravelBackdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onMouseDown={onClose}
      >
        <motion.div
          className="modal timeTravelModal"
          initial={{ y: 28, opacity: 0, scale: .98 }}
          animate={{ y: 0, opacity: 1, scale: 1 }}
          exit={{ y: 28, opacity: 0, scale: .98 }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <button className="close" onClick={onClose}><X size={18} /></button>
          <div className="graphModalHeader">
            <div>
              <span>Agent Time Travel</span>
              <h2>Loading agent-run snapshot</h2>
              <p>Synapsor is resolving the saved run, historical read, replay record, and current comparison.</p>
            </div>
          </div>
          <div className={`timeTravelLoading ${error ? "error" : ""}`}>
            {error ? <AlertTriangle size={22} /> : <RefreshCw className="spin" size={22} />}
            <div>
              <strong>{error ? "Could not load time travel" : "Opening immediately; data is still loading"}</strong>
              <p>{error || "The modal is ready. The DBMS time-travel data will fill in as soon as the endpoint returns."}</p>
            </div>
          </div>
        </motion.div>
      </motion.div>
    );
  }
  const run = asRecord(data.run);
  const postgres = asRecord(data.postgres);
  const pgRun = asRecord(postgres.run);
  const pgCommands = asRecord(postgres.commands);
  const current = asRecord(data.current_row);
  const historical = asRecord(data.historical_row);
  const drift = asRecord(data.drift);
  const replay = asRecord(data.replay);
  const replaySummary = asRecord(replay.replay);
  const commands = data.commands || {};
  return (
    <motion.div
      className="modalBackdrop timeTravelBackdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onMouseDown={onClose}
    >
      <motion.div
        className="modal timeTravelModal"
        initial={{ y: 28, opacity: 0, scale: .98 }}
        animate={{ y: 0, opacity: 1, scale: 1 }}
        exit={{ y: 28, opacity: 0, scale: .98 }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button className="close" onClick={onClose}><X size={18} /></button>
        <div className="graphModalHeader">
          <div>
            <span>Agent Time Travel</span>
            <h2>Go back to what the agent saw</h2>
            <p>
              This button is for debugging or audit: Synapsor reads the row as of the saved agent run,
              then replays the same DB capability without changing production data.
            </p>
          </div>
          <div className="branchRef"><Clock size={15} /><span className="branchRefText">agent-run://{String(run.id || "none")}</span></div>
        </div>

        {!data.available ? (
          <div className="timeTravelEmpty">{data.reason || "No agent run is available yet."}</div>
        ) : (
          <>
            <section className="timeTravelPlain">
              <div>
                <strong>1. Read the past snapshot</strong>
                <span>Synapsor uses the agent-run record to answer: what did the agent see at decision time?</span>
              </div>
              <div>
                <strong>2. Replay safely</strong>
                <span>The DBMS reruns the saved capability with the same session bindings and evidence handles, without mutating production.</span>
              </div>
            </section>

            <div className="timeTravelSummary shortSummary">
              <div><span>DBMS run record</span><strong>agent-run://{String(run.id)}</strong></div>
              <div><span>Capability replayed</span><strong>{String(run.capability_full_name || "unknown")}</strong></div>
              <div><span>Snapshot version</span><strong>{String(run.snapshot_ts || "0")}</strong></div>
            </div>

            <div className="timeTravelRows compactRows">
              <section>
                <h3>Then: agent run snapshot</h3>
                <p className="timeTravelHint">This is the `AS OF AGENT RUN` view: the row as the agent should have seen it.</p>
                <RowKV row={historical} empty={data.historical_error || "Historical row was not returned."} />
              </section>
              <section>
                <h3>Now: current production row</h3>
                <p className="timeTravelHint">This is the normal current read, useful for seeing drift after the agent acted.</p>
                <RowKV row={current} empty="Current row was not returned." />
              </section>
            </div>

            {drift.kind === "policy_drift" ? (
              <section className="timeTravelDrift">
                <div>
                  <span>Policy drift example</span>
                  <h3>{String(drift.title || "Policy changed after the agent decision")}</h3>
                  <p><strong>Question:</strong> {String(drift.question || "")}</p>
                  <p>{String(drift.answer || "")}</p>
                </div>
                <div className="timeTravelPolicyGrid">
                  <PolicySnapshot title={String(drift.then_label || "Then")} policy={asRecord(drift.historical_active_policy)} />
                  <PolicySnapshot title={String(drift.now_label || "Now")} policy={asRecord(drift.current_active_policy)} />
                </div>
              </section>
            ) : drift.kind === "policy_drift_pending" ? (
              <section className="timeTravelNoDrift">
                <strong>{String(drift.title || "No later policy update has been applied yet")}</strong>
                <span>{String(drift.answer || "Run the finance-policy update as a separate step, then reopen Agent Time Travel.")}</span>
              </section>
            ) : rowsSame(historical, current) ? (
              <section className="timeTravelNoDrift">
                <strong>No production drift detected.</strong>
                <span>This is expected for branch-staged proposals: the proposed state lives on the branch, not in the current production row.</span>
              </section>
            ) : null}

            <details className="timeTravelDetails">
              <summary>Show the Synapsor commands behind this</summary>
              <div className="timeTravelCommands">
                <section>
                  <h3>Read old snapshot</h3>
                  <p>Database-owned historical query. No app log reconstruction.</p>
                  <pre>{commands.historical_read}</pre>
                </section>
                <section>
                  <h3>Replay the run</h3>
                  <p>Compare original snapshot behavior with current-state behavior.</p>
                  <pre>{`${commands.replay_original}\n${commands.replay_current}`}</pre>
                </section>
                <section>
                  <h3>Branch from old run</h3>
                  <p>Open a writable investigation branch from the exact agent snapshot.</p>
                  <pre>{commands.branch_from_run}</pre>
                </section>
                <section>
                  <h3>Diff old vs current</h3>
                  <p>Ask the DBMS what changed after the agent made the decision.</p>
                  <pre>{commands.diff_current}</pre>
                </section>
              </div>
            </details>

            <details className="auditRawTrace">
              <summary>Show raw replay response</summary>
              <pre>{JSON.stringify(data.replay_error ? { error: data.replay_error, replay } : replay, null, 2)}</pre>
            </details>
          </>
        )}

        <section className="timeTravelCompare">
          <div className="sectionHeader">
            <span><GitPullRequest size={16} /> Same need, different owner</span>
            <strong>Postgres stores app logs; Synapsor owns agent-time semantics.</strong>
          </div>
          <div className="timeTravelCompareGrid">
            <section>
              <h3>General-purpose DBMS path</h3>
              <strong className="timeTravelOwner app">App-owned approximation</strong>
              <p>{String(postgres.limitation || "The app must persist run logs, evidence snapshots, replay inputs, and diff logic itself.")}</p>
              <div className="timeTravelSummary compact">
                <div><span>App run row</span><strong>{String(pgRun.id || "none")}</strong></div>
                <div><span>Replay owner</span><strong>application code</strong></div>
              </div>
              <details className="timeTravelDetails nested">
                <summary>Show app-owned queries</summary>
                <pre>{String(pgCommands.app_log_lookup || "")}</pre>
                <pre>{String(pgCommands.proposal_evidence || "")}</pre>
              </details>
            </section>
            <section>
              <h3>Synapsor DBMS path</h3>
              <strong className="timeTravelOwner db">DBMS-owned time travel</strong>
              <p>Agent-run snapshot, historical read, replay, branch-from-run, and diff are DBMS-owned operations tied to the capability run.</p>
              <div className="timeTravelSummary compact">
                <div><span>Agent run</span><strong>agent-run://{String(run.id || "none")}</strong></div>
                <div><span>Replay owner</span><strong>Synapsor DBMS</strong></div>
              </div>
              <details className="timeTravelDetails nested">
                <summary>Show DBMS commands</summary>
                <pre>{commands.historical_read}</pre>
                <pre>{commands.branch_from_run}</pre>
              </details>
            </section>
          </div>
        </section>
      </motion.div>
    </motion.div>
  );
}

function RowKV({ row, empty }: { row: Record<string, unknown>; empty: string }) {
  const entries = Object.entries(row).filter(([, value]) => value !== undefined && value !== null && value !== "");
  if (!entries.length) return <div className="evidenceEmpty">{empty}</div>;
  return (
    <div className="rowKv">
      {entries.map(([key, value]) => (
        <div key={key}>
          <span>{key}</span>
          <code>{String(value)}</code>
        </div>
      ))}
    </div>
  );
}

function PolicySnapshot({ title, policy }: { title: string; policy: Record<string, unknown> }) {
  if (!Object.keys(policy).length) {
    return (
      <section>
        <h4>{title}</h4>
        <div className="timeTravelEmpty">No active policy row was returned.</div>
      </section>
    );
  }
  return (
    <section>
      <h4>{title}</h4>
      <strong>{String(policy.title || policy.chunk_id || "Policy row")}</strong>
      <span>{String(policy.chunk_id || "")}</span>
      <p>{String(policy.body || "")}</p>
    </section>
  );
}

function rowsSame(left: Record<string, unknown>, right: Record<string, unknown>) {
  const leftEntries = Object.entries(left).filter(([, value]) => value !== undefined && value !== null && value !== "");
  const rightEntries = Object.entries(right).filter(([, value]) => value !== undefined && value !== null && value !== "");
  if (!leftEntries.length || !rightEntries.length) return false;
  return JSON.stringify(Object.fromEntries(leftEntries)) === JSON.stringify(Object.fromEntries(rightEntries));
}

function EvidenceModalContent({ items }: { items: EvidenceItem[] }) {
  const visuals = items.map(evidenceVisual);
  const passed = visuals.filter((item) => item.status === "pass").length;
  const warnings = visuals.filter((item) => item.status === "warn").length;
  const authority = visuals.filter((item) => item.kind === "policy").length;
  const synapsorEvidence = items.some((item) => `${item.label} ${item.source}`.toLowerCase().includes("synapsor") || item.source.toLowerCase().includes("policy evidence"));
  return (
    <div className="evidenceVisualShell">
      {synapsorEvidence && (
        <div className="dbEvidenceBanner">
          <strong>READ RESOURCE 'last_evidence/hits'</strong>
          <span>Hybrid search executed inside Synapsor. Tenant and status filters are applied below app code; the LLM receives governed evidence, not raw authority.</span>
        </div>
      )}
      <div className="evidenceScoreboard">
        <div className="evidenceScore pass"><CheckCircle2 size={18} /><strong>{passed}</strong><span>checks passed</span></div>
        <div className="evidenceScore policy"><ShieldCheck size={18} /><strong>{authority}</strong><span>policy authority</span></div>
        <div className={`evidenceScore ${warnings ? "warn" : "quiet"}`}><AlertTriangle size={18} /><strong>{warnings}</strong><span>risk signals</span></div>
      </div>

      <div className="evidenceBoard">
        {visuals.length === 0 ? (
          <div className="evidenceEmpty">No evidence returned for this lane.</div>
        ) : (
          visuals.map((item, index) => <EvidenceTile key={`${item.label}-${index}`} item={item} />)
        )}
      </div>

      {items.length > 0 && (
        <details className="rawEvidence">
          <summary>Show raw evidence text</summary>
          <div className="rawEvidenceList">
            {items.map((item, index) => (
              <div key={`${item.source}-${item.label}-${index}`}>
                <strong>{item.label}</strong>
                <p>{item.detail}</p>
                <small>{item.source}</small>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

type EvidenceVisual = EvidenceItem & {
  kind: "receipt" | "card" | "policy" | "risk" | "filter" | "other";
  status: "pass" | "warn" | "info";
  badge: string;
};

function evidenceVisual(item: EvidenceItem): EvidenceVisual {
  const text = `${item.label} ${item.detail} ${item.source}`.toLowerCase();
  if (text.includes("excluded policy") || text.includes("policy filter")) {
    return { ...item, kind: "filter", status: "pass", badge: "Filtered out" };
  }
  if (item.source.includes("policy")) {
    return { ...item, kind: "policy", status: "pass", badge: "Authoritative" };
  }
  if (item.source.includes("guardrail") || text.includes("receipt_instruction_injection")) {
    return { ...item, kind: "risk", status: "warn", badge: "DB guardrail" };
  }
  if (item.source.includes("card")) {
    return { ...item, kind: "card", status: text.includes("mismatch") ? "warn" : "pass", badge: text.includes("mismatch") ? "Mismatch" : "Matched" };
  }
  if (item.source.includes("duplicate") || text.includes("duplicate")) {
    const safe = text.includes("no duplicate") || text.includes("none") || text.includes("0.");
    return { ...item, kind: "risk", status: safe ? "pass" : "warn", badge: safe ? "Clear" : "Review" };
  }
  if (item.source.includes("expense") || text.includes("receipt")) {
    const suspicious = text.includes("ignore") || text.includes("bypass") || text.includes("approve this");
    return { ...item, kind: "receipt", status: suspicious ? "warn" : "pass", badge: suspicious ? "Untrusted text" : "Receipt read" };
  }
  return { ...item, kind: "other", status: "info", badge: "Context" };
}

function EvidenceTile({ item }: { item: EvidenceVisual }) {
  const Icon = evidenceIconForKind(item.kind);
  return (
    <section className={`evidenceTile ${item.status} ${item.kind}`}>
      <div className="evidenceTileIcon"><Icon size={20} /></div>
      <div>
        <div className="evidenceTileTop">
          <strong>{item.label}</strong>
          <span>{item.badge}</span>
        </div>
        <p>{compactEvidenceDetail(item.detail)}</p>
        <small>{item.source}</small>
      </div>
    </section>
  );
}

function evidenceIconForKind(kind: EvidenceVisual["kind"]) {
  return kind === "policy" ? ShieldCheck :
    kind === "risk" ? AlertTriangle :
      kind === "filter" ? ShieldCheck :
        kind === "card" ? Database :
          FileText;
}

function compactEvidenceDetail(detail: string) {
  const clean = detail.replace(/\s+/g, " ").trim();
  return clean.length > 110 ? `${clean.slice(0, 107)}...` : clean;
}

function EvidenceSection({ title, items, empty }: { title: string; items: EvidenceItem[]; empty: string }) {
  return (
    <section className="evidenceSection">
      <h3>{title}</h3>
      {items.length === 0 ? (
        <div className="evidenceEmpty">{empty}</div>
      ) : (
        <div className="evidenceList">
          {items.map((item, index) => (
            <div key={`${item.label}-${index}`} className="evidenceItem">
              <strong>{item.label}</strong>
              <p>{item.detail}</p>
              <small>{item.source}</small>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function WhyAuditModal({ result, onClose }: { result: LaneResult; onClose: () => void }) {
  const gate = policyGate(result);
  const reason = auditReason(result);
  const flow = auditFlow(result);
  const evidence = result.evidence.map(evidenceVisual).slice(0, 6);
  const reasonCodes = [...gate.reasons.slice(0, 5), ...gate.blockers.slice(0, 3)];
  const isSynapsor = result.lane === "synapsor";
  const drillSections = auditDrillSections(result);
  const [activeDrill, setActiveDrill] = useState(drillSections[0]?.id || "decision");
  const activeSection = drillSections.find((section) => section.id === activeDrill) || drillSections[0];
  return (
    <motion.div
      className="modalBackdrop whyModalBackdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onMouseDown={onClose}
    >
      <motion.div
        className={`modal whyModal ${isSynapsor ? "synapsor" : "postgres"}`}
        initial={{ y: 28, opacity: 0, scale: .98 }}
        animate={{ y: 0, opacity: 1, scale: 1 }}
        exit={{ y: 28, opacity: 0, scale: .98 }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button className="close" onClick={onClose}><X size={18} /></button>
        <div className="whyHeader">
          <div>
            <span>{isSynapsor ? "Database-native audit trail" : "App-assembled audit trail"}</span>
            <h2>{isSynapsor ? "Replayable DBMS audit trail" : "Application audit reconstruction"}</h2>
            <p>
              {isSynapsor
                ? "Synapsor persisted the session bindings, capability call, context plan, evidence handles, branch, proposal, and policy gate result for this agent run."
                : "The Postgres lane can explain the decision, but the application has to assemble the trace across tool calls, policy search, workflow rows, and logs."}
            </p>
          </div>
          <div className="whyDecision">
            <span>Decision</span>
            <strong>{stateLabel(result.decision)}</strong>
          </div>
        </div>

        <section className="whyReason">
          <div className="whyReasonIcon"><Bot size={22} /></div>
          <div>
            <span>Agent-facing explanation</span>
            <p>{reason}</p>
          </div>
        </section>

        <div className="whyAuditGrid">
          <section className="whyFlowPanel">
            <h3>Audit path</h3>
            <div className="whyFlow">
              {flow.map((step, index) => (
                <div className="whyFlowStep" key={step.title}>
                  <div className="whyFlowIndex">{index + 1}</div>
                  <div>
                    <strong>{step.title}</strong>
                    <p>{step.detail}</p>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="whySignalsPanel">
            <h3>Decision signals</h3>
            <div className={`riskLane ${gate.riskLane}`}>
              <div>
                <strong>{isSynapsor ? `Synapsor policy gate: ${gate.riskLane.toUpperCase()}` : `${gate.riskLane.toUpperCase()} lane`}</strong>
                <span>{gate.action.replace(/_/g, " ")}</span>
              </div>
              <em>{gate.humanNeeded ? "Human review" : "Auto allowed"}</em>
            </div>
            <div className="whyChips">
              {reasonCodes.length === 0 ? (
                <span>Reason codes unavailable</span>
              ) : (
                reasonCodes.map((code) => <span key={code}>{stateLabel(code)}</span>)
              )}
            </div>
            <div className="whyEvidenceMini">
              {evidence.length === 0 ? (
                <div className="evidenceEmpty">No evidence rows returned.</div>
              ) : (
                evidence.map((item, index) => (
                  <div className={`whyEvidencePill ${item.status}`} key={`${item.label}-${index}`}>
                    <strong>{item.label}</strong>
                    <span>{item.badge}</span>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>

        {activeSection && (
          <section className="whyDrilldown">
            <div className="whyDrillTabs" aria-label="Audit detail sections">
              {drillSections.map((section) => (
                <button
                  key={section.id}
                  className={section.id === activeSection.id ? "active" : ""}
                  onClick={() => setActiveDrill(section.id)}
                >
                  {section.title}
                </button>
              ))}
            </div>
            <div className="whyDrillPanel">
              <div>
                <span>{activeSection.kicker}</span>
                <h3>{activeSection.title}</h3>
              </div>
              {activeSection.id === "write" && <AuditStateRail result={result} />}
              {activeSection.id === "evidence" && <AuditEvidenceStrip items={result.evidence} />}
              <div className={`auditRows auditRowsVisual ${activeSection.id}`}>
                {activeSection.rows.map((row) => (
                  <AuditRowTile key={`${activeSection.id}-${row.label}`} row={row} sectionId={activeSection.id} />
                ))}
              </div>
              {activeSection.raw !== undefined && (
                <details className="auditRawTrace">
                  <summary>Show raw audit payload</summary>
                  <pre>{JSON.stringify(activeSection.raw, null, 2)}</pre>
                </details>
              )}
            </div>
          </section>
        )}
      </motion.div>
    </motion.div>
  );
}

function auditReason(result: LaneResult) {
  const rawReason = result.raw?.reason;
  if (typeof rawReason === "string" && rawReason.trim()) return rawReason;
  return result.answer;
}

function auditFlow(result: LaneResult) {
  const proposalId = result.proposal_id ? proposalLabel(result.proposal_id) : "proposal";
  if (result.lane === "synapsor") {
    return [
      { title: "Session bound", detail: "tenant_id, principal, and current_expense_id came from SET SESSION, not from the LLM." },
      { title: "Capability selected", detail: "expenses.review_expense_context was invoked. The agent did not receive arbitrary write access." },
      { title: "Context prepared", detail: "Synapsor joined expense, employee, card transaction, duplicate signals, guardrails, and policy hits with tenant filters." },
      { title: "Evidence recorded", detail: "Receipt, card match, duplicate check, guardrail, and policy chunks were attached as evidence handles." },
      { title: "Policy gate evaluated", detail: "Green/yellow/red lane was chosen by DB-backed rules." },
      { title: "Write proposal created", detail: result.branch_name ? `${proposalId} is linked to ${branchLabel(result.branch_name)}. The production row was not mutated directly.` : `${proposalId} records the proposed action.` },
      { title: "Branch lifecycle recorded", detail: isAppliedStatus(result.status) ? "The approved branch was committed and merged with audit state attached." : result.status === "rejected" ? "The proposal was rejected and the branch was discarded." : "The branch can be diffed, merged, dropped, or replayed." },
    ];
  }
  return [
    { title: "Tool selection", detail: "The OpenAI agent uses separate app tools to fetch context, search policy, and stage a decision." },
    { title: "App joins", detail: "Application code reads expense, employee, card transaction, and duplicate rows from Postgres." },
    { title: "Policy search", detail: "Application glue runs text search plus pgvector and must filter authoritative policy rows." },
    { title: "Workflow row", detail: `${proposalId} stores the proposed state in an app-owned approval table.` },
    { title: "Audit reconstruction", detail: "Evidence and approval status are reconstructed from app workflow rows and logs." },
    { title: "Review outcome", detail: isAppliedStatus(result.status) ? "App code applied the approved update to production." : result.status === "rejected" ? "App code rejected the proposal and production stayed unchanged." : "Production remains unchanged until review." },
  ];
}

type AuditDrillSection = {
  id: string;
  title: string;
  kicker: string;
  rows: AuditDrillRow[];
  raw?: unknown;
};

type AuditDrillRow = {
  label: string;
  value: string;
  hint?: string;
  tone?: "neutral" | "good" | "warn" | "danger" | "db" | "branch" | "metric";
};

function auditDrillSections(result: LaneResult): AuditDrillSection[] {
  const raw = asRecord(result.raw);
  const gate = policyGate(result);
  const state = dataState(result);
  const proposal = asRecord(raw.proposal);
  const latestRun = asRecord(raw.latest_run);
  const contextAudit = asRecord(asRecord(raw.context_capability).audit_trail);
  const proposalAudit = asRecord(asRecord(asRecord(proposal.raw).audit_trail));
  const who = asRecord(contextAudit.who);
  const bindingAudit = asRecord(contextAudit.bindings);
  const proposalWho = asRecord(proposalAudit.who);
  const proposalBinding = asRecord(proposalAudit.bindings);
  const evidenceRows: AuditDrillRow[] = result.evidence.slice(0, 8).map((item) => {
    const visual = evidenceVisual(item);
    return {
      label: visual.label,
      value: visual.badge,
      hint: visual.source,
      tone: visual.status === "warn" ? "danger" as const : visual.kind === "policy" ? "db" as const : "good" as const,
    };
  });
  if (evidenceRows.length === 0) {
    evidenceRows.push({ label: "Evidence rows", value: "None", hint: "No evidence rows returned for this snapshot.", tone: "warn" });
  }

  const sections: AuditDrillSection[] = [
    {
      id: "decision",
      title: "Decision row",
      kicker: result.lane === "synapsor" ? "Synapsor capability outcome" : "Application agent outcome",
      rows: [
        { label: "Lane", value: result.lane === "synapsor" ? "Synapsor" : "Postgres", hint: result.title, tone: result.lane === "synapsor" ? "db" : "neutral" },
        { label: "Decision", value: stateLabel(result.decision), tone: gate.riskLane === "red" ? "danger" : gate.riskLane === "yellow" ? "warn" : "good" },
        { label: "Status", value: stateLabel(result.status), tone: isAppliedStatus(result.status) ? "good" : result.status === "rejected" ? "danger" : "warn" },
        { label: "Risk lane", value: gate.riskLane, hint: gate.humanNeeded ? "Human review" : "Auto allowed", tone: gate.riskLane === "red" ? "danger" : gate.riskLane === "yellow" ? "warn" : "good" },
        { label: "Evidence", value: result.metrics.evidence_complete ? "Complete" : "Partial", tone: result.metrics.evidence_complete ? "good" : "warn" },
      ],
      raw: {
        reason: raw.reason,
        risk_level: raw.risk_level,
        requires_human_approval: raw.requires_human_approval,
        policy_gate: raw.policy_gate,
      },
    },
    {
      id: "context",
      title: result.lane === "synapsor" ? "Session context" : "App context",
      kicker: result.lane === "synapsor" ? "Hidden bindings from the DB session" : "Rows assembled by app code",
      rows: result.lane === "synapsor"
        ? [
          { label: "Tenant", value: String(who.tenant_id || proposalWho.tenant_id || "acme"), tone: "db" },
          { label: "Principal", value: String(who.principal || proposalWho.principal || "expense_agent_01"), tone: "db" },
          { label: "Expense", value: String(asRecord(bindingAudit.bound_args).current_expense_id || asRecord(proposalBinding.bound_args).current_expense_id || state.expense_id || "current expense"), tone: "branch" },
          { label: "Visible args", value: `${countItems(bindingAudit.visible_arg_names || proposalBinding.visible_arg_names)} visible`, hint: listValue(bindingAudit.visible_arg_names || proposalBinding.visible_arg_names), tone: "neutral" },
          { label: "Hidden args", value: `${countItems(bindingAudit.hidden_arg_names || proposalBinding.hidden_arg_names)} hidden`, hint: listValue(bindingAudit.hidden_arg_names || proposalBinding.hidden_arg_names), tone: "good" },
        ]
        : [
          { label: "Expense", value: state.expense_id || "current expense", tone: "neutral" },
          { label: "Context", value: "App joins", hint: "Expense, employee, card, and duplicate rows are assembled by backend code.", tone: "warn" },
          { label: "Policy", value: "Search glue", hint: "App query over text search plus pgvector.", tone: "warn" },
          { label: "Audit owner", value: "App logs", hint: "Trace is reconstructed from workflow tables and logs.", tone: "neutral" },
        ],
      raw: result.lane === "synapsor" ? contextAudit : raw,
    },
    {
      id: "evidence",
      title: "Evidence rows",
      kicker: "What the agent and policy gate relied on",
      rows: evidenceRows,
      raw: result.evidence,
    },
    {
      id: "write",
      title: result.lane === "synapsor" ? "Branch/proposal row" : "Workflow proposal row",
      kicker: result.lane === "synapsor" ? "Native DB proposal and branch state" : "App-owned approval state",
      rows: [
        { label: "Proposal", value: result.proposal_id ? proposalLabel(result.proposal_id) : "None", tone: result.proposal_id ? "branch" : "neutral" },
        { label: "Branch", value: result.branch_name ? branchLabel(result.branch_name) : "None", tone: result.branch_name ? "branch" : "warn" },
        { label: "Before", value: stateLabel(state.production_before), hint: "Production row before review.", tone: "neutral" },
        { label: result.lane === "synapsor" ? "Staged" : "Proposed", value: stateLabel(state.staged_state), hint: state.staging_location, tone: result.lane === "synapsor" ? "branch" : "warn" },
        { label: "After", value: stateLabel(state.production_after), hint: state.production_after_label, tone: isAppliedStatus(result.status) ? "good" : result.status === "rejected" ? "danger" : "neutral" },
        { label: "Location", value: result.lane === "synapsor" ? "DB-native" : "App-owned", hint: state.staging_location, tone: result.lane === "synapsor" ? "db" : "warn" },
      ],
      raw: proposal,
    },
    {
      id: "metrics",
      title: "Run metrics",
      kicker: raw.latest_run_metrics ? "Loaded from the last real OpenAI run" : "Current snapshot metrics",
      rows: [
        { label: "Input tokens", value: result.metrics.input_tokens.toLocaleString(), tone: "metric" },
        { label: "Output tokens", value: result.metrics.output_tokens.toLocaleString(), tone: "metric" },
        { label: "Tool calls", value: result.metrics.tool_calls.toLocaleString(), tone: result.metrics.tool_calls <= 2 ? "good" : "warn" },
        { label: "DB trips", value: result.metrics.db_round_trips.toLocaleString(), tone: result.metrics.db_round_trips <= 3 ? "good" : "warn" },
        { label: "Elapsed", value: `${(result.metrics.elapsed_ms / 1000).toFixed(1)}s`, tone: "metric" },
        { label: "Policy copies", value: result.metrics.policy_duplication_points.toLocaleString(), tone: result.metrics.policy_duplication_points === 0 ? "good" : "warn" },
      ],
      raw: latestRun,
    },
  ];
  return sections;
}

function countItems(value: unknown) {
  if (Array.isArray(value)) return value.length;
  return value ? 1 : 0;
}

function listValue(value: unknown) {
  return Array.isArray(value) ? value.map(String).join(", ") : value ? String(value) : "none";
}

function AuditStateRail({ result }: { result: LaneResult }) {
  const state = dataState(result);
  const applied = isAppliedStatus(result.status);
  const rejected = result.status === "rejected" || result.status === "cancelled";
  const stagedLabel = result.lane === "synapsor" ? "Branch" : "Proposal";
  return (
    <div className={`auditStateRail ${result.lane} ${applied ? "applied" : rejected ? "rejected" : "pending"}`}>
      <div className="auditStateNode">
        <Database size={16} />
        <span>Before</span>
        <strong>{stateLabel(state.production_before)}</strong>
      </div>
      <div className="auditRailLine" aria-hidden="true" />
      <div className="auditStateNode staged">
        {result.lane === "synapsor" ? <GitBranch size={16} /> : <FileText size={16} />}
        <span>{stagedLabel}</span>
        <strong>{stateLabel(state.staged_state)}</strong>
      </div>
      <div className="auditRailLine" aria-hidden="true" />
      <div className="auditStateNode">
        {applied ? <CheckCircle2 size={16} /> : rejected ? <X size={16} /> : <Lock size={16} />}
        <span>After</span>
        <strong>{stateLabel(state.production_after)}</strong>
      </div>
    </div>
  );
}

function AuditEvidenceStrip({ items }: { items: EvidenceItem[] }) {
  const visuals = items.map(evidenceVisual).slice(0, 5);
  if (visuals.length === 0) return null;
  return (
    <div className="auditEvidenceStrip" aria-label="Evidence summary">
      {visuals.map((item, index) => {
        const Icon = evidenceIconForKind(item.kind);
        return (
          <div className={`auditEvidenceDot ${item.status} ${item.kind}`} key={`${item.label}-${index}`}>
            <Icon size={15} />
            <strong>{item.badge}</strong>
            <span>{item.label}</span>
          </div>
        );
      })}
    </div>
  );
}

function AuditRowTile({ row, sectionId }: { row: AuditDrillRow; sectionId: string }) {
  const Icon = auditRowIcon(row, sectionId);
  return (
    <div className={`auditRowTile ${row.tone || "neutral"}`}>
      <div className="auditRowIcon"><Icon size={17} /></div>
      <div>
        <span>{row.label}</span>
        <strong>{row.value}</strong>
        {row.hint && <em>{row.hint}</em>}
      </div>
    </div>
  );
}

function auditRowIcon(row: AuditDrillRow, sectionId: string) {
  const key = `${sectionId} ${row.label}`.toLowerCase();
  if (key.includes("branch") || key.includes("staged")) return GitBranch;
  if (key.includes("proposal") || key.includes("evidence")) return FileText;
  if (key.includes("decision") || key.includes("risk") || key.includes("review")) return ShieldCheck;
  if (key.includes("token") || key.includes("elapsed") || key.includes("metric")) return Clock;
  if (key.includes("tool") || key.includes("db") || key.includes("tenant") || key.includes("context") || key.includes("location")) return Database;
  if (row.tone === "danger" || row.tone === "warn") return AlertTriangle;
  if (row.tone === "good") return CheckCircle2;
  return Bot;
}

function LaneCard({
  title,
  subtitle,
  accent,
  result,
  running,
  hydrating,
  startedAt,
  updatedAt,
  now,
  onEvidence,
  onWhy,
  onApprove,
  onReject,
  onGraph,
  onRows,
  onDescribeCapability,
  onDescribeContext,
  onTimeTravel
}: {
  title: string;
  subtitle: string;
  accent: "amber" | "green";
  result?: LaneResult;
  running: boolean;
  hydrating: boolean;
  startedAt?: number;
  updatedAt?: number;
  now: number;
  onEvidence: (items: EvidenceItem[]) => void;
  onWhy: (result: LaneResult) => void;
  onApprove: () => void;
  onReject: () => void;
  onGraph: (result: LaneResult) => void;
  onRows: (result: LaneResult) => void;
  onDescribeCapability?: () => void;
  onDescribeContext?: () => void;
  onTimeTravel?: () => void;
}) {
  const elapsedMs = running && startedAt ? now - startedAt : result?.metrics.elapsed_ms ?? 0;
  const elapsed = elapsedMs ? `${(elapsedMs / 1000).toFixed(1)}s` : "0.0s";
  const gate = result ? policyGate(result) : null;
  return (
    <motion.article className={`lane ${accent}`} layout>
      <div className="laneHeader">
        <div>
          <h2>{title}</h2>
          <p>{subtitle}</p>
        </div>
        <div className={`runPill ${running ? "live" : ""}`}>
          {running ? <RefreshCw className="spin" size={15} /> : accent === "green" ? <Lock size={16} /> : <Database size={16} />}
          {running ? `Running ${elapsed}` : updatedAt ? `Updated ${new Date(updatedAt).toLocaleTimeString()}` : "Ready"}
        </div>
      </div>
      {(running || hydrating) && !result ? (
        <div className="runningState">
          <div className="pulseLine" />
          <strong>{hydrating ? "Loading current database state" : "Agent is running"}</strong>
          <p>
            {hydrating
              ? "Checking whether this expense is already staged, approved, rejected, or still untouched in this lane."
              : "Metrics will populate from this request as soon as the lane finishes. Token counts arrive from the OpenAI run usage."}
          </p>
          {!hydrating && <div className="liveMetric"><Clock size={16} /> Elapsed {elapsed}</div>}
        </div>
      ) : !result ? (
        <div className="emptyState">Run a review to see this lane act on the same expense.</div>
      ) : isNotReviewedStatus(result.status) ? (
        <NotReviewedState result={result} />
      ) : (
        <>
          <div className="decision">
            <span>{stateLabel(result.decision)}</span>
            <strong>{result.status === "branch_staged" ? "Branch staged" : stateLabel(result.status)}</strong>
          </div>
          <section className={`agentFinalAnswer ${result.lane}`}>
            <div>
              <Bot size={18} />
              <span>Agent final response</span>
            </div>
            <p>{result.answer}</p>
          </section>
          {gate && <RiskLane gate={gate} lane={result.lane} />}
          <div className="metricCompareLead">
            <span>Comparable run metrics</span>
            <strong>{result.lane === "synapsor" ? "Synapsor lane" : "Postgres lane"}</strong>
          </div>
          <div className="metrics">
            <Metric label="Input tokens" value={result.metrics.input_tokens} />
            <Metric label="Tool calls" value={result.metrics.tool_calls} tooltip="Actual tool calls made by the OpenAI agent during this run." />
            <Metric label="DB trips" value={result.metrics.db_round_trips} tooltip="Database round trips counted by the lane adapter. Postgres needs separate row, policy, proposal, and approval calls; Synapsor collapses more of that into capabilities." />
            <Metric label="App glue LOC" value={result.metrics.app_glue_lines} tooltip={result.lane === "synapsor"
              ? "Architecture metric. This counts the thin app adapter around Synapsor capabilities and the time-travel display endpoint; SQL-authored capability rules, branching, evidence, settlement policy, proposal lifecycle, replay, and AS OF AGENT RUN are owned by Synapsor and are not app glue."
              : "Architecture metric. This counts app-owned retrieval, pgvector/search, policy gate, proposal, approval, audit, replay approximation, evidence snapshots, and time-travel-style inspection glue needed around Postgres."} />
            <Metric label="Elapsed" value={Number((result.metrics.elapsed_ms / 1000).toFixed(1))} suffix="s" tooltip="Wall-clock time for this lane's agent run, including model and tool calls." />
            <Metric label="App policy copies" value={result.metrics.policy_duplication_points} tooltip={result.lane === "synapsor"
              ? "Architecture metric. Zero means the business decision gate is centralized in Synapsor SQL capability rules instead of being copied into prompts, app filters, workflow code, and audit glue."
              : "Architecture metric. Counts app-layer places that must independently carry policy or safety logic outside Postgres, including prompts, retrieval filters, workflow code, and audit glue."} />
          </div>
          <DataStatePanel result={result} />
          {result.lane === "synapsor" && <SynapsorGuardrailCallout result={result} />}
          {result.lane === "synapsor" && <SynapsorAutoApprovalCallout result={result} />}
          <div className={`metricNote ${result.lane}`}>
            <Sparkles size={15} />
            <div>
              <p>
                {result.raw?.snapshot
                  ? result.raw?.latest_run_metrics
                    ? "This is saved proposal/state loaded from the database, with token/tool metrics restored from the last real OpenAI run for this expense."
                    : "This is saved proposal/state loaded from the database. Run a review to collect fresh OpenAI token and tool-call metrics."
                  : result.lane === "synapsor"
                  ? "Input tokens are real OpenAI usage, not a manual discount. They are lower here because Synapsor returns a compact DB-native capability envelope with policy, evidence, and branch semantics already bound."
                  : "Input tokens are real OpenAI usage. This lane is heavier because the app must pass raw context, policy hits, exclusions, and safety/workflow responsibilities to the agent."}
              </p>
              <p>
                Live-measured: tokens, tool calls, DB trips, elapsed time, and action outcomes. Architecture metrics: App glue LOC and App policy copies, including the Agent Time Travel responsibility split.
              </p>
            </div>
          </div>
          {running && <div className="inlineRunning"><RefreshCw className="spin" size={15} /> refreshing from new request</div>}
          <div className="badges">
            <span className={result.metrics.safe_write_branch ? "good" : "warn"}>
              <GitBranch size={14} /> {result.metrics.safe_write_branch ? "Safe branch" : "No DB branch"}
            </span>
            <span className={result.metrics.evidence_complete ? "good" : "warn"}>
              <ShieldCheck size={14} /> {result.metrics.evidence_complete ? "DB evidence" : "App audit glue"}
            </span>
          </div>
          {result.lane === "synapsor" && <SynapsorOwnedObjects result={result} />}
          {result.lane === "synapsor" && <SynapsorSystemViews result={result} />}
          {result.lane === "synapsor" && result.branch_name && <BranchPreview result={result} gate={gate} onGraph={onGraph} />}
          <div className="flow">
            {result.steps.map((step) => <div key={step}>{step}</div>)}
          </div>
          <div className="laneActions">
            {result.lane === "synapsor" && onDescribeCapability && <button className="ghost clickable" onClick={onDescribeCapability}><Terminal size={17} /> DESCRIBE CAPABILITY</button>}
            {result.lane === "synapsor" && onDescribeContext && <button className="ghost clickable" onClick={onDescribeContext}><ServerCog size={17} /> DESCRIBE CONTEXT</button>}
            {result.lane === "synapsor" && onTimeTravel && <button className="ghost clickable auditButton" onClick={onTimeTravel}><Clock size={17} /> Agent Time Travel: what did the agent see?</button>}
            <button className="ghost clickable auditButton" onClick={() => onWhy(result)}><ShieldCheck size={17} /> Replay agent run</button>
            <button className="ghost clickable" onClick={() => onEvidence(result.evidence)}>READ RESOURCE 'last_evidence'</button>
            <button className="ghost clickable" onClick={() => onRows(result)}><Database size={17} /> Query DBMS rows</button>
            <button className="danger" disabled={!result.proposal_id || isFinalStatus(result.status)} onClick={onReject}>
              <X size={17} /> {result.status === "rejected" ? "Rejected" : result.lane === "synapsor" ? "REJECT WRITE + DROP BRANCH" : "Reject app proposal"}
            </button>
            <button className="primary" disabled={!result.proposal_id || isFinalStatus(result.status)} onClick={onApprove}>
              <CheckCircle2 size={17} /> {isAutoSettledStatus(result.status) ? "Settled automatically" : result.status === "approved" ? "Approved" : result.lane === "synapsor" ? "APPROVE WRITE + MERGE BRANCH" : "Approve app proposal"}
            </button>
          </div>
        </>
      )}
    </motion.article>
  );
}

function SynapsorOwnedObjects({ result }: { result: LaneResult }) {
  const raw = asRecord(result.raw);
  const context = asRecord(raw.context_capability);
  const action = asRecord(asRecord(raw.proposal).raw);
  const actionEnvelope = asRecord(action.action);
  const replay = asRecord(actionEnvelope.replay);
  const proposal = asRecord(actionEnvelope.proposal);
  const evidence = asRecord(actionEnvelope.evidence);
  const state = dataState(result);
  const rows = [
    ["Session", `tenant_id=acme, principal=expense_agent_01, current_expense_id=${state.expense_id || "current expense"}`],
    ["Agent Context", "expenses.expense_context"],
    ["Capability", "expenses.review_expense_context + expenses.propose_expense_decision"],
    ["Evidence Resource", String(evidence.bundle || evidence.id || "resource://last_evidence/hits")],
    ["Branch", result.branch_name || "auto-created when proposal runs"],
    ["Write Proposal", result.proposal_id || String(proposal.handle || "wrp://last")],
    ["Agent Run", String(replay.run_resource || asRecord(action.audit_trail).run_resource || "agent-run://last")],
  ];
  return (
    <section className="dbmsObjects">
      <div className="dbmsObjectsHeader">
        <Database size={17} />
        <strong>DBMS-owned objects created/read during this run</strong>
      </div>
      <div className="dbmsObjectRows">
        {rows.map(([label, value]) => (
          <div key={label}>
            <span>{label}</span>
            <code>{value}</code>
          </div>
        ))}
      </div>
    </section>
  );
}

function SynapsorSystemViews({ result }: { result: LaneResult }) {
  return (
    <section className="systemViews">
      <div className="systemViewTitle"><Search size={16} /> Query Synapsor system views</div>
      <pre>{`SELECT run_id, capability_full_name, principal, branch_name
FROM synapsor_agent_runs
ORDER BY run_id DESC;`}</pre>
      <div className="systemRows">
        <div><span>capability_full_name</span><strong>expenses.propose_expense_decision</strong></div>
        <div><span>principal</span><strong>expense_agent_01</strong></div>
        <div><span>branch_name</span><strong>{result.branch_name || "none yet"}</strong></div>
      </div>
      <pre>{`SELECT handle_uri, capability_full_name, state, principal, branch_name
FROM synapsor_agent_write_proposals
ORDER BY id DESC;`}</pre>
      <pre>{`SELECT table_name, profile, physical_layout, retention_status
FROM synapsor_table_storage_profiles;`}</pre>
    </section>
  );
}

function SynapsorGuardrailCallout({ result }: { result: LaneResult }) {
  if (!synapsorGuardrailBlocked(result)) return null;
  return (
    <section className="synapsorGuardrailCallout">
      <div><ShieldCheck size={20} /></div>
      <div>
        <strong>Synapsor blocked the receipt instruction</strong>
        <p>
          The receipt text asked the agent to approve and skip review. Synapsor returned a DB-owned
          guardrail signal, so the staged action became <b>security review required</b> instead of approved.
        </p>
      </div>
    </section>
  );
}

function synapsorGuardrailBlocked(result: LaneResult) {
  const gate = asRecord(result.raw?.policy_gate);
  const blockers = Array.isArray(gate.blockers) ? gate.blockers.map(String) : [];
  const reasons = Array.isArray(gate.reason_codes) ? gate.reason_codes.map(String) : [];
  const evidenceHit = result.evidence.some((item) =>
    `${item.label} ${item.detail} ${item.source}`.toLowerCase().includes("receipt_instruction_injection") ||
    item.source.toLowerCase().includes("synapsor guardrail")
  );
  return blockers.includes("receipt_instruction_injection") ||
    reasons.includes("synapsor_db_guardrail") ||
    evidenceHit;
}

function SynapsorAutoApprovalCallout({ result }: { result: LaneResult }) {
  if (!synapsorAutoApproved(result)) return null;
  return (
    <section className="synapsorAutoApprovalCallout">
      <div><CheckCircle2 size={20} /></div>
      <div>
        <strong>Synapsor owned the auto-approval gate</strong>
        <p>
          The database capability returned the green-lane reason <b>synapsor_auto_approval_gate</b>.
          Synapsor evaluated the DB-native settlement policy, then executed AUTO APPROVE, AUTO COMMIT, and AUTO MERGE inside the database.
        </p>
      </div>
    </section>
  );
}

function synapsorAutoApproved(result: LaneResult) {
  const gate = asRecord(result.raw?.policy_gate);
  const reasons = Array.isArray(gate.reason_codes) ? gate.reason_codes.map(String) : [];
  const context = asRecord(result.raw?.context_capability);
  const payload = asRecord(context.payload);
  const compactReasons = Array.isArray(payload.r) ? payload.r.map(String) : [];
  const fullReasons = Array.isArray(payload.reason_codes) ? payload.reason_codes.map(String) : [];
  return isAutoSettledStatus(result.status) && (
    reasons.includes("synapsor_db_auto_approval") ||
    compactReasons.includes("synapsor_auto_approval_gate") ||
    fullReasons.includes("synapsor_auto_approval_gate")
  );
}

function NotReviewedState({ result }: { result: LaneResult }) {
  const state = dataState(result);
  const isSynapsor = result.lane === "synapsor";
  return (
    <section className="notReviewedState">
      <div className="notReviewedIcon">
        {isSynapsor ? <Lock size={24} /> : <Database size={24} />}
      </div>
      <div>
        <span>Current database row</span>
        <h3>No agent recommendation yet</h3>
        <p>{result.answer}</p>
      </div>
      <div className="notReviewedFacts">
        <div>
          <span>Production row</span>
          <strong>{stateLabel(state.production_before)}</strong>
        </div>
        <div>
          <span>{isSynapsor ? "Synapsor branch" : "App proposal"}</span>
          <strong>none yet</strong>
        </div>
        <div>
          <span>Next step</span>
          <strong>run review</strong>
        </div>
      </div>
    </section>
  );
}

type DataState = {
  expense_id?: string;
  target_table?: string;
  production_before: string;
  staged_state: string;
  production_after: string;
  staging_location: string;
  production_after_label: string;
};

function dataState(result: LaneResult): DataState {
  const raw = result.raw?.data_state;
  if (typeof raw === "object" && raw !== null) {
    const row = raw as Partial<Record<keyof DataState, unknown>>;
    return {
      expense_id: row.expense_id ? String(row.expense_id) : undefined,
      target_table: row.target_table ? String(row.target_table) : undefined,
      production_before: String(row.production_before || "submitted"),
      staged_state: String(row.staged_state || result.decision),
      production_after: String(row.production_after || (isFinalStatus(result.status) ? result.decision : row.production_before || "submitted")),
      staging_location: String(row.staging_location || (result.lane === "synapsor" ? "Synapsor branch" : "Postgres approval row")),
      production_after_label: String(row.production_after_label || (isFinalStatus(result.status) ? "Applied to production" : "Production unchanged until approval"))
    };
  }
  return {
    expense_id: undefined,
    target_table: "expenses",
    production_before: "submitted",
    staged_state: result.decision,
    production_after: isFinalStatus(result.status) ? result.decision : "submitted",
    staging_location: result.lane === "synapsor" ? "Synapsor branch" : "Postgres approval row",
    production_after_label: isFinalStatus(result.status) ? "Applied to production" : "Production unchanged until approval"
  };
}

function approvedDataState(result: LaneResult): DataState {
  const current = dataState(result);
  return {
    ...current,
    production_after: current.staged_state,
    production_after_label: result.lane === "synapsor" ? "Settled and merged to production by Synapsor" : "Approved into production"
  };
}

function rejectedDataState(result: LaneResult): DataState {
  const current = dataState(result);
  return {
    ...current,
    production_after: current.production_before,
    production_after_label: result.lane === "synapsor" ? "Rejected; branch discarded and production unchanged" : "Rejected; production unchanged"
  };
}

function DataStatePanel({ result }: { result: LaneResult }) {
  const state = dataState(result);
  const applied = isAppliedStatus(result.status);
  return (
    <section className={`dataStatePanel ${applied ? "final" : ""}`}>
      <div className="dataStateHeader">
        <strong>Data state</strong>
        <span>{applied ? "Production changed" : "Production protected"}</span>
      </div>
      <div className="stateSteps">
        <div className="stateStep before">
          <span>Before</span>
          <strong>{stateLabel(state.production_before)}</strong>
          <small>production row</small>
        </div>
        <div className="stateArrow">→</div>
        <div className="stateStep staged">
          <span>{result.lane === "synapsor" ? "Staged" : "Proposed"}</span>
          <strong>{stateLabel(state.staged_state)}</strong>
          <small>{state.staging_location}</small>
        </div>
        <div className="stateArrow">→</div>
        <div className="stateStep after">
          <span>After</span>
          <strong>{stateLabel(state.production_after)}</strong>
          <small>{state.production_after_label}</small>
        </div>
      </div>
    </section>
  );
}

type RowField = {
  label: string;
  value: string;
};

type RowDiagramCard = {
  table: string;
  title: string;
  note: string;
  tone: "main" | "branch" | "proposal" | "audit" | "app";
  fields: RowField[];
};

function RowLevelModal({ result, onClose }: { result: LaneResult; onClose: () => void }) {
  const state = dataState(result);
  const rows = rowDiagramRows(result, state);
  const isSynapsor = result.lane === "synapsor";
  return (
    <motion.div
      className="modalBackdrop graphModalBackdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onMouseDown={onClose}
    >
      <motion.div
        className="modal graphModal rowModal"
        initial={{ y: 28, opacity: 0, scale: .98 }}
        animate={{ y: 0, opacity: 1, scale: 1 }}
        exit={{ y: 28, opacity: 0, scale: .98 }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button className="close" onClick={onClose}><X size={18} /></button>
        <div className="graphModalHeader">
          <div>
            <span>{isSynapsor ? "Synapsor row-level flow" : "Postgres row-level flow"}</span>
            <h2>{isSynapsor ? "Proposal lives in the database trust layer" : "Proposal lives in app workflow tables"}</h2>
            <p>
              {isSynapsor
                ? "Synapsor stages the changed expense row on a database branch and ties it to a native write proposal. Production stays unchanged until the branch is approved and merged."
                : "Postgres stores the production expense row and an app-owned proposal row. The application must enforce approval, evidence, and safe-write behavior because there is no native branch row."}
            </p>
          </div>
          <div className="branchRef"><Database size={15} /><span className="branchRefText">{state.expense_id || "current expense"}</span></div>
        </div>

        {isSynapsor ? (
          <SynapsorRowGraph rows={rows} result={result} state={state} />
        ) : (
          <PostgresRowGraph rows={rows} />
        )}

        <div className="rowModalExplain">
          <section>
            <strong>What changed?</strong>
            <p>
              Production before was <b>{stateLabel(state.production_before)}</b>. The agent proposed <b>{stateLabel(state.staged_state)}</b>. Production after is currently <b>{stateLabel(state.production_after)}</b>.
            </p>
          </section>
          <section>
            <strong>Why this matters</strong>
            <p>
              {isSynapsor
                ? "The staged row is represented as DB-native branch/proposal state, so preview, settlement policy evaluation, approval, evidence, and merge are owned by Synapsor."
                : "The staged row is an application workflow record, so the app must keep proposal state, evidence, approval, and final writes consistent."}
            </p>
          </section>
        </div>
      </motion.div>
    </motion.div>
  );
}

function SynapsorRowGraph({
  rows,
  result,
  state,
}: {
  rows: RowDiagramCard[];
  result: LaneResult;
  state: DataState;
}) {
  const applied = isAppliedStatus(result.status);
  const closed = isFinalStatus(result.status);
  const [before, staged, proposal, audit, after] = rows;
  return (
    <section className={`synapsorRowCanvas ${applied ? "final" : closed ? "closed" : "pending"}`} aria-label="Synapsor row-level branch graph">
      <svg className="rowBranchSvg" viewBox="0 0 1000 420" preserveAspectRatio="none" aria-hidden="true">
        <path className="rowMainPath" d="M92 82 H908" />
        <path className="rowForkPath" d="M252 82 C318 82 320 254 382 254 H692" />
        <path className={applied ? "rowMergePath active" : "rowMergePath"} d="M692 254 C780 254 780 82 908 82" />
        {!applied && <path className="rowHoldPath" d="M692 254 H908" />}
      </svg>

      <div className="rowBranchLabel rowBranchLabelMain">production main</div>
      <div className="rowBranchLabel rowBranchLabelReview">Synapsor review branch</div>
      <div className="rowBranchStatus">
        <GitBranch size={15} />
        {applied ? "branch merged" : result.status === "rejected" ? "branch rejected" : "production unchanged"}
      </div>

      <div className="rowNode rowNodeBefore"><RowTableCard row={before} compact /></div>
      <div className="rowNode rowNodeStage"><RowTableCard row={staged} compact /></div>
      <div className="rowNode rowNodeProposal"><RowTableCard row={proposal} compact /></div>
      <div className="rowNode rowNodeEvidence"><RowTableCard row={audit} compact /></div>
      <div className="rowNode rowNodeAfter"><RowTableCard row={after} compact /></div>

      <div className="rowBranchDiffPill">
        <span>{stateLabel(state.production_before)}</span>
        <strong>{stateLabel(state.staged_state)}</strong>
        <span>{applied ? stateLabel(state.production_after) : result.status === "rejected" ? "rejected" : "waiting"}</span>
      </div>
    </section>
  );
}

function PostgresRowGraph({ rows }: { rows: RowDiagramCard[] }) {
  return (
    <section className="postgresRowCanvas" aria-label="Postgres row-level workflow graph">
      <div className="postgresRailLabel production">production table</div>
      <div className="postgresRailLabel app">application workflow tables</div>
      <div className="postgresRail production" />
      <div className="postgresRail app" />
      <div className="postgresRowGrid">
        {rows.map((row, index) => (
          <div className="postgresRowItem" key={`${row.table}-${row.title}-${index}`}>
            <RowTableCard row={row} compact />
            {index < rows.length - 1 && <div className="rowFlowArrow">→</div>}
          </div>
        ))}
      </div>
    </section>
  );
}

function RowTableCard({ row, compact = false }: { row: RowDiagramCard; compact?: boolean }) {
  return (
    <section className={`rowTableCard ${row.tone} ${compact ? "compact" : ""}`}>
      <div className="rowTableHeader">
        <span>{row.table}</span>
        <strong>{row.title}</strong>
        <small>{row.note}</small>
      </div>
      <div className="rowFields">
        {row.fields.map((field) => (
          <div key={field.label}>
            <span>{field.label}</span>
            <code>{field.value}</code>
          </div>
        ))}
      </div>
    </section>
  );
}

function rowDiagramRows(result: LaneResult, state: DataState): RowDiagramCard[] {
  const proposal = asRecord(result.raw?.proposal);
  const auto = isAutoSettledStatus(result.status);
  const applied = isAppliedStatus(result.status);
  const rejected = result.status === "rejected" || result.status === "cancelled";
  const expenseId = state.expense_id || "current_expense";
  const proposalId = result.proposal_id || String(proposal.id || proposal.proposal_handle || "proposal");
  if (result.lane === "synapsor") {
    return [
      {
        table: "main.expenses",
        title: "Production row before",
        note: "authoritative row remains protected",
        tone: "main",
        fields: [
          { label: "id", value: expenseId },
          { label: "state", value: state.production_before },
          { label: "write access", value: "no direct agent write" },
        ],
      },
      {
        table: `${branchLabel(result.branch_name)}.expenses`,
        title: applied ? "Branch row merged" : rejected ? "Branch row discarded" : "Branch-staged row",
        note: "native Synapsor branch overlay",
        tone: "branch",
        fields: [
          { label: "id", value: expenseId },
          { label: "state", value: state.staged_state },
          { label: "branch", value: branchLabel(result.branch_name) },
        ],
      },
      {
        table: "synapsor_agent_write_proposals",
        title: "Native write proposal",
        note: "settlement policy, approval, preview, commit, and merge are DB-native",
        tone: "proposal",
        fields: [
          { label: "handle", value: proposalId },
          { label: "state", value: applied ? "committed" : rejected ? "rejected" : "pending_review" },
          { label: "target", value: "expenses.state" },
        ],
      },
      {
        table: "expense_audit / evidence",
        title: "Evidence row",
        note: "policy, receipt, duplicate checks, and decision trace",
        tone: "audit",
        fields: [
          { label: "evidence", value: result.metrics.evidence_complete ? "complete" : "partial" },
          { label: "branch", value: result.branch_name ? "linked" : "none" },
          { label: "approval", value: auto ? "auto policy gate" : applied ? "human approved" : rejected ? "rejected" : "waiting" },
        ],
      },
      {
        table: "main.expenses",
        title: "Production row after",
        note: state.production_after_label,
        tone: applied ? "main" : "audit",
        fields: [
          { label: "id", value: expenseId },
          { label: "state", value: state.production_after },
          { label: "source", value: applied ? "branch merge" : rejected ? "rejected; unchanged" : "unchanged" },
        ],
      },
    ];
  }
  return [
    {
      table: "expenses",
      title: "Production row before",
      note: "normal Postgres row",
      tone: "main",
      fields: [
        { label: "id", value: expenseId },
        { label: "state", value: state.production_before },
        { label: "branch", value: "none" },
      ],
    },
    {
      table: "pg_expense_proposals",
      title: "App-owned proposal row",
      note: "workflow state created by application code",
      tone: "app",
      fields: [
        { label: "id", value: proposalId },
        { label: "expense_id", value: expenseId },
        { label: "proposed_state", value: state.staged_state },
        { label: "status", value: applied ? "approved" : rejected ? "rejected" : "pending" },
      ],
    },
    {
      table: "app evidence / logs",
      title: "Evidence assembled by app",
      note: "not a DB-native branch/proposal lifecycle",
      tone: "audit",
      fields: [
        { label: "evidence_json", value: "attached to proposal row" },
        { label: "safe_write_branch", value: "false" },
        { label: "approval", value: auto ? "auto app code" : applied ? "human approved" : rejected ? "rejected" : "waiting" },
      ],
    },
    {
      table: "expenses",
      title: "Production row after",
      note: state.production_after_label,
      tone: applied ? "main" : "audit",
      fields: [
        { label: "id", value: expenseId },
        { label: "state", value: state.production_after },
        { label: "source", value: applied ? "app update" : rejected ? "rejected; unchanged" : "unchanged" },
      ],
    },
  ];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function policyGate(result: LaneResult) {
  const raw = result.raw?.policy_gate;
  if (typeof raw === "object" && raw !== null) {
    const gate = raw as {
      risk_lane?: string;
      human_needed?: boolean;
      action?: string;
      reason_codes?: unknown;
      blockers?: unknown;
    };
    return {
      riskLane: gate.risk_lane || (isAutoSettledStatus(result.status) ? "green" : result.decision.includes("review") ? "yellow" : "red"),
      humanNeeded: Boolean(gate.human_needed),
      action: gate.action || result.status,
      reasons: Array.isArray(gate.reason_codes) ? gate.reason_codes.map(String) : [],
      blockers: Array.isArray(gate.blockers) ? gate.blockers.map(String) : []
    };
  }
  return {
    riskLane: isAutoSettledStatus(result.status) ? "green" : result.decision.includes("review") ? "yellow" : "red",
    humanNeeded: !isAutoSettledStatus(result.status),
    action: result.status,
    reasons: [],
    blockers: []
  };
}

function RiskLane({ gate, lane }: { gate: ReturnType<typeof policyGate>; lane: LaneName }) {
  const laneLabel = gate.riskLane === "green" ? "GREEN" : gate.riskLane === "yellow" ? "YELLOW" : "RED";
  const label = lane === "synapsor" ? `Synapsor policy gate: ${laneLabel}` : `${laneLabel} lane`;
  const text =
    gate.riskLane === "green"
      ? "Safe policy gate passed. The write can be auto-settled and merged by Synapsor."
      : gate.riskLane === "yellow"
        ? "Risk or ambiguity found. The write is branch-staged for human review."
        : "Suspicious signal found. The action is blocked or escalated.";
  return (
    <div className={`riskLane ${gate.riskLane}`}>
      <div>
        <strong>{label}</strong>
        <span>{text}</span>
      </div>
      <em>{gate.humanNeeded ? "Human needed" : "No human needed"}</em>
    </div>
  );
}

function BranchPreview({
  result,
  gate,
  onGraph
}: {
  result: LaneResult;
  gate: ReturnType<typeof policyGate> | null;
  onGraph: (result: LaneResult) => void;
}) {
  const approved = isAppliedStatus(result.status);
  const autoApplied = isAutoSettledStatus(result.status);
  const diffLines = branchDiffLines(result);
  const rejected = result.status === "rejected";

  return (
    <section className={`branchPreview ${approved ? "approved" : ""} ${autoApplied ? "auto" : ""} ${rejected ? "rejected" : ""}`}>
      <div className="branchPreviewHeader">
        <div>
          <span>Synapsor branch safety</span>
          <strong>{autoApplied ? "Auto-settled by Synapsor" : approved ? "Merged after approval" : rejected ? "Rejected and discarded" : "Staged outside production"}</strong>
        </div>
        <div className="branchHeaderActions">
          <div className="branchRef"><GitBranch size={15} /><span className="branchRefText">{branchLabel(result.branch_name)}</span></div>
          <button className="branchExpand" onClick={() => onGraph(result)}><Eye size={15} /> Full graph</button>
        </div>
      </div>

      <BranchGraph result={result} approved={approved} autoApplied={autoApplied} />

      <div className="branchDiff">
        <div>
          <span>Previewed change</span>
          <strong>{stateLabel(result.decision)}</strong>
        </div>
        <div className="diffLines">
          {diffLines.map((line, index) => <code key={`${line}-${index}`}>{line}</code>)}
        </div>
      </div>
      {gate && (
        <div className="gateChecklist">
          {gate.reasons.slice(0, 5).map((reason) => <span key={reason} className="pass"><CheckCircle2 size={13} /> {stateLabel(reason)}</span>)}
          {gate.blockers.slice(0, 3).map((blocker) => <span key={blocker} className="block"><AlertTriangle size={13} /> {stateLabel(blocker)}</span>)}
        </div>
      )}
    </section>
  );
}

function BranchGraph({
  result,
  approved,
  autoApplied
}: {
  result: LaneResult;
  approved: boolean;
  autoApplied: boolean;
}) {
  const [hovered, setHovered] = useState<GraphTooltipData | null>(null);
  const nodes = branchGraphNodes(approved, autoApplied);

  return (
    <div className={`branchGraph ${approved ? "merged" : "open"}`} aria-label="Synapsor branch graph">
      {hovered && (
        <div className="graphTooltipPanel">
          <b>{hovered.tooltipTitle}</b>
          <p>{hovered.tooltip}</p>
        </div>
      )}
      <svg viewBox="0 0 860 260" role="img" aria-label="Production branch splits into a Synapsor review branch, then merges back only after the policy gate passes.">
        <defs>
          <filter id="nodeShadow" x="-20%" y="-20%" width="140%" height="150%">
            <feDropShadow dx="0" dy="8" stdDeviation="8" floodColor="#0f172a" floodOpacity="0.14" />
          </filter>
        </defs>

        <path className="mainLine" d="M86 74 H758" />
        <path className="branchSplit" d="M232 74 C280 74 286 174 350 174 H626" />
        <path className={approved ? "mergeLine active" : "mergeLine"} d="M626 174 C688 174 694 74 758 74" />
        {!approved && <path className="blockedLine" d="M626 174 H758" />}

        {nodes.map((node) => (
          <GraphNode
            key={`${node.x}-${node.label}`}
            node={node}
            onHover={setHovered}
          />
        ))}

        <text className="graphLaneLabel main" x="24" y="24">production main</text>
        <text className="graphLaneLabel branch" x="318" y="238">Synapsor review branch</text>
      </svg>
    </div>
  );
}

function BranchGraphModal({
  result,
  onClose
}: {
  result: LaneResult;
  onClose: () => void;
}) {
  const gate = policyGate(result);
  const approved = isAppliedStatus(result.status);
  const autoApplied = isAutoSettledStatus(result.status);
  const nodes = branchGraphNodes(approved, autoApplied);
  const diffLines = branchDiffLines(result);

  return (
    <motion.div
      className="modalBackdrop graphModalBackdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onMouseDown={onClose}
    >
      <motion.div
        className="modal graphModal"
        initial={{ y: 28, opacity: 0, scale: .98 }}
        animate={{ y: 0, opacity: 1, scale: 1 }}
        exit={{ y: 28, opacity: 0, scale: .98 }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button className="close" onClick={onClose}><X size={18} /></button>
        <div className="graphModalHeader">
          <div>
            <span>Synapsor branch lifecycle</span>
            <h2>{autoApplied ? "Auto-settled low-risk action" : approved ? "Reviewed branch merged to main" : "Proposal isolated from production"}</h2>
            <p>
              The agent stages the expense decision on a Synapsor branch. Production changes only when Synapsor settlement policy auto-settles a green-lane action or a reviewer approves the proposal.
            </p>
          </div>
          <div className="branchRef"><GitBranch size={15} /><span className="branchRefText">{branchLabel(result.branch_name)}</span></div>
        </div>

        <BranchGraph result={result} approved={approved} autoApplied={autoApplied} />

        <div className="branchCommandGrid">
          <pre className="codePanel">{`CREATE BRANCH ${result.branch_name || "review_branch"} FROM main;
USE BRANCH ${result.branch_name || "review_branch"};

PROPOSE AGENT CAPABILITY expenses.propose_expense_decision
WITH JSON '{...}';

PREVIEW WRITE '${result.proposal_id || "last_proposal"}';
SETTLE WRITE '${result.proposal_id || "last_proposal"}'
USING POLICY expenses.green_auto_settle;
DIFF BRANCH ${result.branch_name || "review_branch"} AGAINST main;`}</pre>
          <div className="branchOverlayTable">
            <div><span>main.expenses</span><strong>{dataState(result).expense_id || "EXP"} state = {stateLabel(dataState(result).production_before)}</strong></div>
            <div><span>{branchLabel(result.branch_name)}.expenses</span><strong>{dataState(result).expense_id || "EXP"} state = {stateLabel(dataState(result).staged_state)}</strong></div>
            <p>Production remains unchanged until Synapsor settlement policy approves, commits, and merges the branch, or a reviewer handles the staged proposal.</p>
          </div>
        </div>

        <div className="graphDetailGrid">
          {nodes.map((node) => (
            <section key={`${node.label}-${node.x}`} className={`graphDetailCard ${node.active ? "active" : ""} ${node.done ? "done" : ""}`}>
              <strong>{node.label}: {node.tooltipTitle}</strong>
              <p>{node.tooltip}</p>
            </section>
          ))}
        </div>

        <div className="graphModalBottom">
          <section>
            <h3>Previewed write</h3>
            <div className="diffLines graphDiffLines">
              {diffLines.map((line, index) => <code key={`${line}-${index}`}>{line}</code>)}
            </div>
          </section>
          <section>
            <h3>Policy gate</h3>
            <div className="gateChecklist modalGateChecklist">
              {(gate?.reasons || []).slice(0, 6).map((reason) => <span key={reason} className="pass"><CheckCircle2 size={13} /> {stateLabel(reason)}</span>)}
              {(gate?.blockers || []).slice(0, 4).map((blocker) => <span key={blocker} className="block"><AlertTriangle size={13} /> {stateLabel(blocker)}</span>)}
              {!gate && <span className="block"><AlertTriangle size={13} /> Gate details unavailable</span>}
            </div>
          </section>
        </div>
      </motion.div>
    </motion.div>
  );
}

function branchGraphNodes(approved: boolean, autoApplied: boolean): GraphNodeData[] {
  return [
    { x: 86, y: 74, label: "Main", tooltipTitle: "Production main", tooltip: "Live expense data stays protected. The agent cannot mutate production rows directly." },
    { x: 232, y: 74, label: "Fork", tooltipTitle: "Branch split", tooltip: "Synapsor creates an isolated branch from main before staging the proposed write." },
    { x: 350, y: 174, label: "Stage", active: true, tooltipTitle: "Agent write sandbox", tooltip: "The proposed expense change is staged on the branch, not applied to production." },
    { x: 500, y: 174, label: "Proof", active: true, tooltipTitle: "Evidence-backed proposal", tooltip: "The proposal is tied to receipt evidence, card matching, duplicate checks, policy retrieval, and the policy gate." },
    { x: 626, y: 174, label: autoApplied ? "Settle" : "Gate", active: !approved, done: approved, tooltipTitle: autoApplied ? "Synapsor settlement policy" : "Review gate", tooltip: autoApplied ? "Green-lane checks passed, so Synapsor ran AUTO APPROVE, AUTO COMMIT, and AUTO MERGE through the database-owned settlement policy." : approved ? "A reviewer approved the branch before it merged." : "The branch remains isolated until review passes or the proposal is rejected." },
    { x: 758, y: 74, label: approved ? "Merge" : "Safe", done: approved, tooltipTitle: approved ? "Safe merge completed" : "No production write", tooltip: approved ? "The approved branch merged back to main with audit evidence attached." : "Production remains unchanged while the branch waits or is blocked." }
  ];
}

type GraphTooltipData = {
  tooltipTitle: string;
  tooltip: string;
};

type GraphNodeData = GraphTooltipData & {
  x: number;
  y: number;
  label: string;
  active?: boolean;
  done?: boolean;
};

function GraphNode({
  node,
  onHover
}: {
  node: GraphNodeData;
  onHover: (node: GraphTooltipData | null) => void;
}) {
  const { x, y, label, active = false, done = false } = node;
  return (
    <g
      className={`graphNode ${active ? "active" : ""} ${done ? "done" : ""}`}
      transform={`translate(${x} ${y})`}
      tabIndex={0}
      onMouseEnter={() => onHover(node)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(node)}
      onBlur={() => onHover(null)}
    >
      <circle className="graphNodeCircle" r="40" filter="url(#nodeShadow)" />
      <text className="graphNodeIconText" textAnchor="middle" dominantBaseline="middle">{label}</text>
    </g>
  );
}

function Metric({ label, value, suffix = "", tooltip }: { label: string; value: number; suffix?: string; tooltip?: string }) {
  return (
    <div className={`metricCard ${tooltip ? "hasTooltip" : ""}`} tabIndex={tooltip ? 0 : -1} aria-label={tooltip ? `${label}: ${tooltip}` : label}>
      <strong>{value.toLocaleString()}{suffix}</strong>
      <span>{label}</span>
      {tooltip && <div className="metricTooltip" role="tooltip">{tooltip}</div>}
    </div>
  );
}
