import type { ApprovalResponse, BackgroundState, Expense, ExpenseStateResponse, LaneName, LaneResult, QueueResponse, ReviewResponse, SynapsorTimeTravelResponse } from "./types";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    ...init
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || res.statusText);
  }
  return (await res.json()) as T;
}

export const api = {
  health: () => request<{ status: string; model: string }>("/api/health"),
  reset: () => request<{ status: string }>("/api/reset", { method: "POST" }),
  expenses: () => request<Expense[]>("/api/expenses"),
  expenseState: (expense_id: string) => request<ExpenseStateResponse>(`/api/expense-state/${expense_id}`),
  review: (expense_id: string, question: string) =>
    request<ReviewResponse>("/api/review", {
      method: "POST",
      body: JSON.stringify({ expense_id, question })
    }),
  reviewLane: (lane: LaneName, expense_id: string, question: string) =>
    request<LaneResult>(`/api/review/${lane}`, {
      method: "POST",
      body: JSON.stringify({ expense_id, question })
    }),
  approve: (lane: "postgres" | "synapsor", proposal_id: string, branch_name?: string) =>
    request<ApprovalResponse>("/api/approve", {
      method: "POST",
      body: JSON.stringify({ lane, proposal_id, branch_name, approver: "MGR-200" })
    }),
  reject: (lane: "postgres" | "synapsor", proposal_id: string, branch_name?: string) =>
    request<ApprovalResponse>("/api/reject", {
      method: "POST",
      body: JSON.stringify({
        lane,
        proposal_id,
        branch_name,
        approver: "MGR-200",
        reason: "Manager rejected the recommendation after review."
      })
    }),
  queue: () => request<QueueResponse>("/api/queue"),
  synapsorTimeTravel: (expense_id: string) => request<SynapsorTimeTravelResponse>(`/api/synapsor/time-travel/${expense_id}`),
  policyUpdateStatus: (expense_id: string) => request<Record<string, unknown>>(`/api/demo/policy-update/${expense_id}`),
  applyPolicyUpdate: (expense_id: string) =>
    request<Record<string, unknown>>(`/api/demo/policy-update/${expense_id}`, { method: "POST" }),
  background: () => request<BackgroundState>("/api/background"),
  setBackground: (enabled: boolean) =>
    request<BackgroundState>("/api/background", {
      method: "POST",
      body: JSON.stringify({ enabled })
    }),
  runBackgroundOnce: () => request<BackgroundState>("/api/background/run-once", { method: "POST" })
};
