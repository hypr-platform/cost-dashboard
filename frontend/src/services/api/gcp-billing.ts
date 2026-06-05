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
