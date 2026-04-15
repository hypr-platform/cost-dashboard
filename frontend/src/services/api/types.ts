export type JourneyRow = {
  token: string;
  cliente: string;
  campanha: string;
  campaign_start?: string | null;
  campaign_end?: string | null;
  produto_vendido?: string;
  account_management?: string;
  status: string;
  investido: number;
  total_plataformas: number;
  pct_investido: number;
  [platform: string]: string | number | null | undefined;
};

export type PlatformPageRow = {
  line: string;
  token: string;
  cliente: string;
  campanha: string;
  account_management: string;
  gasto: number;
  investido: number | null;
  pct_invest: number | null;
};

export type AttentionOutOfPeriodRow = {
  platform: string;
  token: string;
  line: string;
  cliente: string;
  campanha: string;
  account_management: string;
  vigencia_start: string | null;
  vigencia_end: string | null;
  gasto: number;
};

export type BudgetData = {
  month_key: string;
  share_percent?: Partial<Record<string, number>>;
  general: {
    target_brl: number | null;
    spent_brl: number;
    progress_pct: number | null;
    remaining_brl: number | null;
  };
  platforms: Record<
    string,
    {
      target_brl: number | null;
      spent_brl: number;
      progress_pct: number | null;
      remaining_brl: number | null;
    }
  >;
};

export type DashboardResponse = {
  period: { start: string; end: string };
  exchange_rate_usd_brl: number;
  total_brl: number;
  journey_status?: string;
  journey_message?: string;
  platform_results: Record<
    string,
    {
      status: "ok" | "error" | "no_credentials";
      message?: string;
      spend?: number;
      currency?: "USD" | "BRL";
      daily?: { date: string; spend: number }[];
      lines?: { name: string; spend: number }[];
    }
  >;
  dashboard: {
    spend_by_platform: { platform: string; spend_brl: number }[];
    daily: Array<{ date: string; total: number; [platform: string]: string | number }>;
    daily_filtered?: Array<{ date: string; total: number; [platform: string]: string | number }>;
    campaign_journey_rows: JourneyRow[];
    active_platforms: string[];
  };
  platform_pages: Record<
    string,
    {
      spend_brl: number;
      spend_usd?: number;
      currency?: "USD" | "BRL";
      rows?: PlatformPageRow[];
      impressions?: number;
      cap?: number;
      pct_cap?: number;
      campaigns?: { name: string; impressions: number }[];
      layouts?: {
        layout: string;
        impressions: number;
        creatives?: number;
        estimated_cost_brl?: number;
        pct_estimated_cost?: number;
      }[];
    }
  >;
  attention: {
    no_token_rows: { platform: string; line: string; gasto: number }[];
    no_token_total_brl: number;
    out_of_period_rows: AttentionOutOfPeriodRow[];
    out_of_period_total_brl: number;
  };
  budget: BudgetData;
  nexd?: {
    status: "ok" | "error" | "no_credentials";
    message?: string;
    impressions?: number;
    cap?: number;
  };
  _meta?: {
    snapshot_at?: string;
    source?: string;
    cache_ttl_seconds?: number;
  };
};

export type RefreshStatusResponse = {
  running?: boolean;
  run_id?: string | null;
  trigger?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  status?: string;
  error?: string | null;
};

export type RefreshMetricsResponse = {
  window_hours: number;
  trigger: string;
  sample_size: number;
  avg_duration_seconds: number | null;
  p50_duration_seconds: number | null;
  p95_duration_seconds: number | null;
};

export type CampaignLineRow = {
  platform: string;
  line: string;
  cliente: string;
  campanha: string;
  account_management?: string;
  gasto: number;
  investido: number | null;
  pct_invest: number | null;
};

export type CampaignResponse = {
  token: string;
  period: { start: string; end: string };
  campaign: JourneyRow | null;
  line_rows: CampaignLineRow[];
  daily: Array<{ date: string; total: number; [platform: string]: string | number }>;
  active_platforms: string[];
};
