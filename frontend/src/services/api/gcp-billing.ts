import { fetchJsonWithTimeout } from "./http";

export type GcpBillingProjectRow = {
  project_id: string;
  project_name: string | null;
  cost_usd: string;
  cost_brl: string;
  credits_usd: string;
};

export type GcpBillingServiceRow = {
  service_id: string;
  service_description: string;
  cost_usd: string;
  cost_brl: string;
};

export type GcpBillingSkuRow = {
  sku_id: string;
  sku_description: string;
  service_description: string;
  cost_usd: string;
  cost_brl: string;
  usage_amount: string;
  usage_unit: string | null;
};

export type GcpBillingDailyPoint = {
  day: string;
  cost_usd: string;
  cost_brl: string;
};

export type GcpCloudRunByLabelRow = {
  service_name: string;
  cost_usd: string;
  cost_brl: string;
  requests: number;
  cost_per_million_usd: string | null;
  cost_per_million_brl: string | null;
  latency_p50_ms: string | null;
  latency_p95_ms: string | null;
  latency_p99_ms: string | null;
  error_rate: string | null;
};

export type GcpBillingDashboardResponse = {
  from_date: string;
  to_date: string;
  currency: string;
  exchange_rate: string;
  total_cost_usd: string;
  total_cost_brl: string;
  total_credits_usd: string;
  total_gross_usd: string;
  by_project: GcpBillingProjectRow[];
  by_service: GcpBillingServiceRow[];
  by_sku: GcpBillingSkuRow[];
  daily: GcpBillingDailyPoint[];
  cloud_run_by_label: GcpCloudRunByLabelRow[];
  cached: boolean;
  fetched_at: string;
};

export function fetchGcpBillingDashboard(
  url: string,
): Promise<GcpBillingDashboardResponse> {
  return fetchJsonWithTimeout<GcpBillingDashboardResponse>(url, {
    timeoutMs: 60000,
    errorMessage: "Falha ao carregar custos do Google Cloud.",
  });
}

export type GcpBillingDayDetailResponse = {
  date: string;
  currency: string;
  exchange_rate: string;
  total_cost_usd: string;
  total_cost_brl: string;
  total_credits_usd: string;
  total_gross_usd: string;
  by_project: GcpBillingProjectRow[];
  by_service: GcpBillingServiceRow[];
  by_sku: GcpBillingSkuRow[];
  cached: boolean;
  fetched_at: string;
};

export function fetchGcpBillingDayDetail(
  url: string,
): Promise<GcpBillingDayDetailResponse> {
  return fetchJsonWithTimeout<GcpBillingDayDetailResponse>(url, {
    timeoutMs: 60000,
    errorMessage: "Falha ao carregar detalhamento do dia.",
  });
}

export type GcpServiceDeltaRow = {
  service_id: string;
  service_description: string;
  current_usd: string;
  current_brl: string;
  previous_usd: string;
  previous_brl: string;
  delta_usd: string;
  delta_brl: string;
  delta_pct: string | null;
};

export type GcpBillingComparisonResponse = {
  from_date: string;
  to_date: string;
  prev_from_date: string;
  prev_to_date: string;
  currency: string;
  exchange_rate: string;
  current_total_usd: string;
  current_total_brl: string;
  previous_total_usd: string;
  previous_total_brl: string;
  delta_total_usd: string;
  delta_total_brl: string;
  delta_total_pct: string | null;
  by_service_delta: GcpServiceDeltaRow[];
  cached: boolean;
  fetched_at: string;
};

export function fetchGcpBillingComparison(
  url: string,
): Promise<GcpBillingComparisonResponse> {
  return fetchJsonWithTimeout<GcpBillingComparisonResponse>(url, {
    timeoutMs: 60000,
    errorMessage: "Falha ao carregar comparação de períodos.",
  });
}

export type GcpBillingDaySkusResponse = {
  date: string;
  service_id: string;
  service_description: string | null;
  currency: string;
  exchange_rate: string;
  by_sku: GcpBillingSkuRow[];
  cached: boolean;
  fetched_at: string;
};

export function fetchGcpBillingDaySkus(
  url: string,
): Promise<GcpBillingDaySkusResponse> {
  return fetchJsonWithTimeout<GcpBillingDaySkusResponse>(url, {
    timeoutMs: 60000,
    errorMessage: "Falha ao carregar SKUs do serviço.",
  });
}
