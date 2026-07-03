import { fetchJsonWithTimeout } from "./http";

export type BqCostUserRow = {
  user_email: string;
  jobs: number;
  bytes_billed: number;
  slot_ms: number;
  cost_usd: string;
  cost_brl: string;
};

export type BqCostStatementRow = {
  statement_type: string;
  jobs: number;
  bytes_billed: number;
  slot_ms: number;
  cost_usd: string;
  cost_brl: string;
};

export type BqCostTableRow = {
  table_fqn: string;
  jobs: number;
  bytes_billed: number;
  cost_usd: string;
  cost_brl: string;
};

export type BqCostUserDailyPoint = {
  day: string;
  user_email: string;
  cost_usd: string;
  cost_brl: string;
};

export type BqCostQueryRow = {
  job_id: string;
  user_email: string | null;
  statement_type: string | null;
  creation_time: string;
  bytes_billed: number;
  slot_ms: number;
  cost_usd: string;
  cost_brl: string;
  query_preview: string;
  region: string;
};

export type BqCostDashboardResponse = {
  from_date: string;
  to_date: string;
  regions: string[];
  exchange_rate: string;
  price_usd_per_tib: string;
  total_jobs: number;
  total_bytes_billed: number;
  total_slot_ms: number;
  total_cost_usd: string;
  total_cost_brl: string;
  by_user: BqCostUserRow[];
  by_statement_type: BqCostStatementRow[];
  by_table: BqCostTableRow[];
  top_queries: BqCostQueryRow[];
  by_user_daily: BqCostUserDailyPoint[];
  cached: boolean;
  fetched_at: string;
  currency: string;
  calibrated: boolean;
  analysis_cost_usd: string;
  analysis_cost_brl: string;
  storage_cost_usd: string;
  storage_cost_brl: string;
  other_cost_usd: string;
  other_cost_brl: string;
  price_by_region: Record<string, string>;
};

export function fetchBigQueryCostDashboard(
  url: string,
): Promise<BqCostDashboardResponse> {
  return fetchJsonWithTimeout<BqCostDashboardResponse>(url, {
    timeoutMs: 90000,
    errorMessage: "Falha ao carregar custos do BigQuery.",
  });
}

export type BqUserQueryGroup = {
  pattern_preview: string;
  sample_query: string;
  statement_type: string | null;
  jobs: number;
  bytes_billed: number;
  slot_ms: number;
  cost_usd: string;
  cost_brl: string;
};

export type BqUserQueriesResponse = {
  user_email: string;
  from_date: string;
  to_date: string;
  currency: string;
  exchange_rate: string;
  total_cost_usd: string;
  total_cost_brl: string;
  groups: BqUserQueryGroup[];
  cached: boolean;
  fetched_at: string;
};

export function fetchBqUserQueries(
  url: string,
): Promise<BqUserQueriesResponse> {
  return fetchJsonWithTimeout<BqUserQueriesResponse>(url, {
    timeoutMs: 90000,
    errorMessage: "Falha ao carregar as queries do usuário.",
  });
}

export type BqLimitStatusValue =
  | "unset"
  | "ok"
  | "projected"
  | "warning"
  | "exceeded";

export type BqEnforcementValue = "enforced" | "off" | "stray" | "error";

export type BqCostLimitStatus = {
  day: string;
  timezone: string;
  regions: string[];
  limit_brl: string | null;
  warn_pct: string;
  spent_brl: string;
  spent_bytes: number;
  spent_usd: string;
  projected_brl: string;
  pct_used: string | null;
  day_fraction_elapsed: string;
  status: BqLimitStatusValue;
  enforcement: BqEnforcementValue;
  enforced_limit_mib: number | null;
  enforced_limit_tib: string | null;
  quota_effective_tib: string | null;
  enforce_error: string | null;
  exchange_rate: string;
  price_usd_per_tib: string;
  updated_at: string | null;
  updated_by: string | null;
  fetched_at: string;
};

function limitUrl(apiBase: string): string {
  return `${apiBase.replace(/\/$/, "")}/api/bigquery-cost/limit`;
}

export function fetchBqLimitStatus(url: string): Promise<BqCostLimitStatus> {
  return fetchJsonWithTimeout<BqCostLimitStatus>(url, {
    timeoutMs: 60000,
    errorMessage: "Falha ao carregar o limite do BigQuery.",
  });
}

export function putBqLimit(
  apiBase: string,
  body: { limit_brl: number; warn_pct?: number },
  userEmail?: string,
): Promise<BqCostLimitStatus> {
  return fetchJsonWithTimeout<BqCostLimitStatus>(limitUrl(apiBase), {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      ...(userEmail ? { "X-User-Email": userEmail } : {}),
    },
    body: JSON.stringify(body),
    timeoutMs: 60000,
    errorMessage: "Falha ao salvar o limite.",
  });
}

export function deleteBqLimit(
  apiBase: string,
  userEmail?: string,
): Promise<BqCostLimitStatus> {
  return fetchJsonWithTimeout<BqCostLimitStatus>(limitUrl(apiBase), {
    method: "DELETE",
    headers: userEmail ? { "X-User-Email": userEmail } : undefined,
    timeoutMs: 60000,
    errorMessage: "Falha ao remover o limite.",
  });
}
