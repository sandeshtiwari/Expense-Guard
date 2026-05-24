CREATE AGENT CONTEXT expenses.expense_context
ROOT expenses AS expense
LOOKUP expense.id = SESSION current_expense_id
BIND tenant_id FROM SESSION tenant_id
OUTPUT SLOTS expense_id AS expense.id,
             employee_id AS expense.employee_id,
             card_transaction_id AS expense.card_transaction_id,
             amount_cents AS expense.amount_cents,
             vendor AS expense.vendor,
             category AS expense.category,
             state AS expense.state
EVIDENCE ON;

CREATE AGENT CAPABILITY expenses.review_expense_context
DESCRIPTION 'Retrieve one expense with employee, transaction, duplicate, and authoritative policy evidence'
ARG expense_question VARCHAR REQUIRED
HIDDEN tenant_id FROM SESSION tenant_id
HIDDEN principal FROM SESSION principal
HIDDEN current_expense_id FROM SESSION current_expense_id
USE CONTEXT expenses.expense_context
EXECUTION READ ONLY
TOKEN BUDGET MAX OUTPUT TOKENS 2200, MAX INLINE EVIDENCE ITEMS 8,
             MAX REASON COUNT 5, PREFER HANDLES
PLAN
DEFAULT DECISION review

SCAN expense_row FROM expenses AS expense
WHERE FIELD expense.tenant_id = ARG tenant_id
  AND FIELD expense.id = ARG current_expense_id
OUTPUT id = FIELD expense.id,
       employee_id = FIELD expense.employee_id,
       card_transaction_id = FIELD expense.card_transaction_id,
       vendor = FIELD expense.vendor,
       category = FIELD expense.category,
       amount_cents = FIELD expense.amount_cents,
       currency = FIELD expense.currency,
       spend_date = FIELD expense.spend_date,
       submitted_at = FIELD expense.submitted_at,
       trip_purpose = FIELD expense.trip_purpose,
       nights = FIELD expense.nights,
       receipt_text = FIELD expense.receipt_text,
       receipt_sha = FIELD expense.receipt_sha,
       state = FIELD expense.state

SCAN employee_row FROM employees AS employee
WHERE FIELD employee.tenant_id = ARG tenant_id
  AND FIELD employee.id = FIELD expense.employee_id
OUTPUT id = FIELD employee.id,
       full_name = FIELD employee.full_name,
       role = FIELD employee.role,
       manager_id = FIELD employee.manager_id,
       department = FIELD employee.department,
       spending_limit_cents = FIELD employee.spending_limit_cents,
       active = FIELD employee.active

SCAN card_transaction FROM card_transactions AS card
WHERE FIELD card.tenant_id = ARG tenant_id
  AND FIELD card.id = FIELD expense.card_transaction_id
OUTPUT id = FIELD card.id,
       employee_id = FIELD card.employee_id,
       merchant = FIELD card.merchant,
       amount_cents = FIELD card.amount_cents,
       currency = FIELD card.currency,
       transaction_date = FIELD card.transaction_date,
       status = FIELD card.status,
       memo = FIELD card.memo

EXISTS active_employee FROM employees AS active_employee
WHERE FIELD active_employee.tenant_id = ARG tenant_id
  AND FIELD active_employee.id = FIELD expense.employee_id
  AND FIELD active_employee.active = 'true'

EXISTS card_amount_match FROM card_transactions AS card_match
WHERE FIELD card_match.tenant_id = ARG tenant_id
  AND FIELD card_match.id = FIELD expense.card_transaction_id
  AND FIELD card_match.amount_cents = FIELD expense.amount_cents

SCAN duplicate_checks FROM duplicate_signals AS dup
WHERE FIELD dup.tenant_id = ARG tenant_id
  AND FIELD dup.expense_id = ARG current_expense_id
OUTPUT id = FIELD dup.id,
       candidate_expense_id = FIELD dup.candidate_expense_id,
       risk_score = FIELD dup.risk_score,
       reason = FIELD dup.reason

SCAN guardrail_signals FROM expense_guardrail_signals AS guardrail
WHERE FIELD guardrail.tenant_id = ARG tenant_id
  AND FIELD guardrail.expense_id = ARG current_expense_id
OUTPUT id = FIELD guardrail.id,
       signal_code = FIELD guardrail.signal_code,
       severity = FIELD guardrail.severity,
       source = FIELD guardrail.source,
       reason = FIELD guardrail.reason

HYBRID_SEARCH policy_hits
  TABLE expense_policy_chunks
  COLUMN body
  QUERY ARG expense_question
  LIMIT 5
  FILTER tenant_id = ARG tenant_id,
         status = 'active'

RULE security_review_required REASON receipt_instruction_injection
  WHEN STEP_COUNT guardrail_signals > 0
  TERMINAL

RULE finance_review_required REASON duplicate_or_fraud_signal
  WHEN STEP_COUNT duplicate_checks > 0
  TERMINAL

RULE rejected REASON employee_inactive
  WHEN STEP_COUNT active_employee = 0
  TERMINAL

RULE finance_review_required REASON card_transaction_missing
  WHEN STEP_COUNT card_transaction = 0
  TERMINAL

RULE finance_review_required REASON card_amount_mismatch
  WHEN STEP_COUNT card_amount_match = 0
  TERMINAL

RULE manager_review_required REASON receipt_missing
  WHEN FIELD expense.receipt_text = ''
  TERMINAL

RULE manager_review_required REASON policy_missing
  WHEN STEP_COUNT policy_hits = 0
  TERMINAL

RULE approved REASON synapsor_auto_approval_gate DETAIL 'Meal expense is under the auto-approval threshold, employee is active, card amount matches, and no duplicate or guardrail signal exists.'
  WHEN FIELD expense.category = 'Meals'
  AND FIELD expense.amount_cents <= 7500
  AND STEP_COUNT active_employee > 0
  AND STEP_COUNT card_amount_match > 0
  AND STEP_COUNT duplicate_checks = 0
  AND STEP_COUNT guardrail_signals = 0
  TERMINAL REQUIRE NO PRIOR REASONS

RULE approved REASON synapsor_transport_policy_gate DETAIL 'Ground transport was under the original $100 auto-approval threshold at the agent-run snapshot.'
  WHEN FIELD expense.category = 'Ground Transport'
  AND FIELD expense.amount_cents <= 10000
  AND STEP_COUNT active_employee > 0
  AND STEP_COUNT card_amount_match > 0
  AND STEP_COUNT duplicate_checks = 0
  AND STEP_COUNT guardrail_signals = 0
  TERMINAL REQUIRE NO PRIOR REASONS

RULE manager_review_required REASON hotel_review_required
  WHEN FIELD expense.category = 'Hotel'
  TERMINAL REQUIRE NO PRIOR REASONS

RULE manager_review_required REASON expense_context_loaded
  WHEN STEP_COUNT expense_row > 0
  TERMINAL

PAYLOAD expense = STEP_OUTPUT expense_row,
        employee = STEP_OUTPUT employee_row,
        card_transaction = STEP_OUTPUT card_transaction,
        active_employee = STEP_COUNT active_employee,
        card_amount_match = STEP_COUNT card_amount_match,
        duplicate_checks = STEP_OUTPUT duplicate_checks,
        guardrail_signals = STEP_OUTPUT guardrail_signals,
        policy_hits = STEP_OUTPUT policy_hits

EVIDENCE expense = STEP_OUTPUT expense_row,
         employee = STEP_OUTPUT employee_row,
         card_transaction = STEP_OUTPUT card_transaction,
         active_employee = STEP_COUNT active_employee,
         card_amount_match = STEP_COUNT card_amount_match,
         duplicate_checks = STEP_OUTPUT duplicate_checks,
         guardrail_signals = STEP_OUTPUT guardrail_signals,
         policy_hits = STEP_OUTPUT policy_hits
END PLAN
RETURNS JSON '{"type":"object","properties":{"decision":{},"reason_codes":{},"expense":{},"employee":{},"card_transaction":{},"active_employee":{},"card_amount_match":{},"duplicate_checks":{},"guardrail_signals":{},"policy_hits":{},"evidence":{}}}'
PROFILE MINIMAL
INLINE EVIDENCE handles_only;

CREATE AGENT CAPABILITY expenses.propose_expense_decision
DESCRIPTION 'Create a branch-staged approval decision proposal for one employee expense'
ARG expense_id VARCHAR REQUIRED
ARG decision VARCHAR REQUIRED
ARG reason_codes VARCHAR REQUIRED
ARG risk_lane VARCHAR REQUIRED
ARG note VARCHAR REQUIRED
ARG reviewed_at VARCHAR REQUIRED
HIDDEN tenant_id FROM SESSION tenant_id
HIDDEN principal FROM SESSION principal
HIDDEN current_expense_id FROM SESSION current_expense_id
USE CONTEXT expenses.expense_context
EXECUTION PROPOSAL
RETURNS JSON '{"type":"object","properties":{"proposal":{},"branch":{},"decision":{},"reason_codes":{},"risk_lane":{},"evidence_bundle":{}}}'
FIELD ALIASES decision AS d, reason_codes AS r, risk_lane AS rl, evidence_bundle AS ev
WRITE PROPOSAL TARGET expenses
OPERATION UPDATE
LOOKUP id FROM ARG expense_id
TENANT tenant_id FROM BINDING tenant_id
COLUMNS state FROM ARG decision,
        reviewer FROM BINDING principal,
        decision_note FROM ARG note,
        reviewed_at FROM ARG reviewed_at
AUDIT expense_audit
SUMMARY TEMPLATE 'Propose {decision} for expense {current_expense_id}';

CREATE SETTLEMENT POLICY expenses.green_auto_settle
FOR CAPABILITY expenses.propose_expense_decision
TARGET BRANCH main
AUTO APPROVE WHEN
  PAYLOAD trusted_after.state = 'approved'
  AND PAYLOAD target_table = 'expenses'
  AND PAYLOAD operation = 'update'
  AND PAYLOAD trusted_after.reviewer = 'expense_agent_01'
AUTO COMMIT
AUTO MERGE
ELSE LEAVE PROPOSED;
