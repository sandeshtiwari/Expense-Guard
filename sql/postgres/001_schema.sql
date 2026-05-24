CREATE EXTENSION IF NOT EXISTS vector;

DROP TABLE IF EXISTS pg_agent_runs CASCADE;
DROP TABLE IF EXISTS pg_expense_proposals CASCADE;
DROP TABLE IF EXISTS duplicate_signals CASCADE;
DROP TABLE IF EXISTS company_policy_chunks CASCADE;
DROP TABLE IF EXISTS card_transactions CASCADE;
DROP TABLE IF EXISTS expenses CASCADE;
DROP TABLE IF EXISTS employees CASCADE;
DROP TABLE IF EXISTS tenants CASCADE;

CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  region TEXT NOT NULL
);

CREATE TABLE employees (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  full_name TEXT NOT NULL,
  role TEXT NOT NULL,
  manager_id TEXT,
  department TEXT NOT NULL,
  spending_limit_cents INTEGER NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE expenses (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  employee_id TEXT NOT NULL REFERENCES employees(id),
  card_transaction_id TEXT,
  vendor TEXT NOT NULL,
  category TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  spend_date DATE NOT NULL,
  submitted_at TIMESTAMPTZ NOT NULL,
  trip_purpose TEXT NOT NULL,
  nights INTEGER NOT NULL DEFAULT 0,
  receipt_text TEXT NOT NULL,
  receipt_sha TEXT NOT NULL,
  state TEXT NOT NULL,
  reviewer TEXT,
  decision_note TEXT,
  reviewed_at TIMESTAMPTZ,
  source TEXT NOT NULL DEFAULT 'seed'
);

CREATE TABLE card_transactions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  employee_id TEXT NOT NULL REFERENCES employees(id),
  merchant TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  transaction_date DATE NOT NULL,
  status TEXT NOT NULL,
  memo TEXT NOT NULL
);

CREATE TABLE company_policy_chunks (
  chunk_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  title TEXT NOT NULL,
  topic TEXT NOT NULL,
  status TEXT NOT NULL,
  effective_from DATE NOT NULL,
  effective_to DATE,
  allowed_role TEXT NOT NULL,
  body TEXT NOT NULL,
  embedding vector(8) NOT NULL
);

CREATE INDEX company_policy_chunks_embedding_idx
  ON company_policy_chunks USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 4);

CREATE INDEX company_policy_chunks_text_idx
  ON company_policy_chunks
  USING GIN (to_tsvector('english', title || ' ' || body));

CREATE TABLE duplicate_signals (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  expense_id TEXT NOT NULL REFERENCES expenses(id),
  candidate_expense_id TEXT NOT NULL REFERENCES expenses(id),
  risk_score INTEGER NOT NULL,
  reason TEXT NOT NULL
);

CREATE TABLE pg_expense_proposals (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  expense_id TEXT NOT NULL,
  proposed_state TEXT NOT NULL,
  note TEXT NOT NULL,
  evidence_json JSONB NOT NULL,
  status TEXT NOT NULL,
  proposed_by TEXT NOT NULL,
  approved_by TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  approved_at TIMESTAMPTZ
);

CREATE TABLE pg_agent_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  lane TEXT NOT NULL,
  expense_id TEXT NOT NULL,
  question TEXT NOT NULL,
  final_answer TEXT NOT NULL,
  decision TEXT NOT NULL,
  tool_calls INTEGER NOT NULL,
  db_round_trips INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  total_tokens INTEGER NOT NULL,
  elapsed_ms INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL
);
