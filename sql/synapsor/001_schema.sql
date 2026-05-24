CREATE TABLE tenants (
  id VARCHAR PRIMARY KEY,
  name VARCHAR,
  region VARCHAR
) WITH PROFILE reference_data;

CREATE TABLE employees (
  id VARCHAR PRIMARY KEY,
  tenant_id VARCHAR,
  full_name VARCHAR,
  role VARCHAR,
  manager_id VARCHAR,
  department VARCHAR,
  spending_limit_cents INT64,
  active VARCHAR
) WITH PROFILE hot_state;

CREATE TABLE expenses (
  id VARCHAR PRIMARY KEY,
  tenant_id VARCHAR,
  employee_id VARCHAR,
  card_transaction_id VARCHAR,
  vendor VARCHAR,
  category VARCHAR,
  amount_cents INT64,
  currency VARCHAR,
  spend_date VARCHAR,
  submitted_at VARCHAR,
  trip_purpose VARCHAR,
  nights INT64,
  receipt_text VARCHAR,
  receipt_sha VARCHAR,
  state VARCHAR,
  reviewer VARCHAR,
  decision_note VARCHAR,
  reviewed_at VARCHAR,
  source VARCHAR
) WITH PROFILE hot_state;

CREATE TABLE card_transactions (
  id VARCHAR PRIMARY KEY,
  tenant_id VARCHAR,
  employee_id VARCHAR,
  merchant VARCHAR,
  amount_cents INT64,
  currency VARCHAR,
  transaction_date VARCHAR,
  status VARCHAR,
  memo VARCHAR
) WITH PROFILE append_log;

CREATE TABLE expense_policy_chunks (
  chunk_id VARCHAR PRIMARY KEY,
  tenant_id VARCHAR,
  title VARCHAR,
  topic VARCHAR,
  status VARCHAR,
  effective_from VARCHAR,
  effective_to VARCHAR,
  allowed_role VARCHAR,
  body VARCHAR
) WITH (
  profile = 'searchable_knowledge',
  lexical_index = 'body',
  vector_index = 'body',
  filter_keys = 'tenant_id,topic,status,allowed_role',
  zone_map = 'tenant_id,topic,status'
);

CREATE TABLE duplicate_signals (
  id VARCHAR PRIMARY KEY,
  tenant_id VARCHAR,
  expense_id VARCHAR,
  candidate_expense_id VARCHAR,
  risk_score INT64,
  reason VARCHAR
) WITH PROFILE audit_log;

CREATE TABLE expense_guardrail_signals (
  id VARCHAR PRIMARY KEY,
  tenant_id VARCHAR,
  expense_id VARCHAR,
  signal_code VARCHAR,
  severity VARCHAR,
  source VARCHAR,
  reason VARCHAR
) WITH (
  profile = 'audit_log',
  compact_after = '1 day',
  hot_window = '30 days',
  zone_map = 'tenant_id,signal_code,severity'
);

CREATE TABLE expense_audit (
  id INT,
  tenant_id VARCHAR,
  principal VARCHAR,
  capability VARCHAR,
  resource VARCHAR,
  action VARCHAR
) WITH (
  profile = 'audit_log',
  compact_after = '1 day',
  hot_window = '30 days',
  zone_map = 'tenant_id,action'
);
