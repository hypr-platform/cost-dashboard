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
  cached: boolean;
  fetched_at: string;
};

export function fetchBigQueryCostDashboard(
  url: string,
): Promise<BqCostDashboardResponse> {
  return fetchJsonWithTimeout<BqCostDashboardResponse>(url, {
    timeoutMs: 90000,
    errorMessage: "Falha ao carregar custos do BigQuery.",
  });
}
