import { fetchJsonWithTimeout } from "./http";

export type VercelServiceRow = {
  service_name: string;
  service_category: string;
  billed_usd: string;
  billed_brl: string;
  effective_usd: string;
  effective_brl: string;
  consumed_quantity: number | null;
  consumed_unit: string | null;
  share_pct: string;
};

export type VercelProjectRow = {
  project_id: string | null;
  project_name: string;
  billed_usd: string;
  billed_brl: string;
  effective_usd: string;
  effective_brl: string;
  share_pct: string;
};

export type VercelRegionRow = {
  region: string;
  billed_usd: string;
  billed_brl: string;
  share_pct: string;
};

export type VercelChargeCategoryRow = {
  category: string;
  billed_usd: string;
  billed_brl: string;
  share_pct: string;
};

export type VercelDailyRow = {
  day: string;
  billed_usd: string;
  billed_brl: string;
  effective_usd: string;
  effective_brl: string;
};

export type VercelCategoryDailyPoint = {
  day: string;
  category: string;
  billed_usd: string;
  billed_brl: string;
};

export type VercelCostResponse = {
  from_date: string;
  to_date: string;
  currency: string;
  exchange_rate: string;
  total_billed_usd: string;
  total_billed_brl: string;
  total_effective_usd: string;
  total_effective_brl: string;
  total_cost_usd: string;
  total_cost_brl: string;
  usage_billed_brl: string;
  credits_billed_brl: string;
  tax_billed_brl: string;
  projects_count: number;
  services_count: number;
  by_service: VercelServiceRow[];
  by_project: VercelProjectRow[];
  by_region: VercelRegionRow[];
  by_charge_category: VercelChargeCategoryRow[];
  daily: VercelDailyRow[];
  daily_by_category: VercelCategoryDailyPoint[];
  service_categories: string[];
  cached: boolean;
  fetched_at: string;
};

export function fetchVercelCostDashboard(
  url: string,
): Promise<VercelCostResponse> {
  return fetchJsonWithTimeout<VercelCostResponse>(url, {
    timeoutMs: 90000,
    errorMessage: "Falha ao carregar custos da Vercel.",
  });
}
