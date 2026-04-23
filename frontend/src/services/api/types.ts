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

/** Metadados da API Display & Video (inventário) para achar a line no DV360. */
export type Dv360LineContext = {
  dv360_advertiser_id?: string | null;
  dv360_insertion_order_id?: string | null;
  dv360_campaign_id?: string | null;
  dv360_entity_status?: string | null;
  dv360_partner_id?: string | null;
};

export type PlatformPageRow = {
  line: string;
  /** Present for DV360 when o relatório agrega por line item. */
  line_item_id?: string | null;
  token: string;
  cliente: string;
  campanha: string;
  account_management: string;
  gasto: number;
  investido: number | null;
  pct_invest: number | null;
} & Dv360LineContext;

export type AttentionOutOfPeriodRow = {
  platform: string;
  token: string;
  line: string;
  line_item_id?: string | null;
  cliente: string;
  campanha: string;
  account_management: string;
  vigencia_start: string | null;
  vigencia_end: string | null;
  gasto: number;
} & Dv360LineContext;

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
      lines?: { name: string; spend: number; line_item_id?: string | null }[];
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
      /** Só em DV360: escopo do .env (partner e anunciantes consultados). */
      dv360_context?: { partner_id: string | null; advertiser_ids: string[] };
    }
  >;
  attention: {
    no_token_rows: ({
      platform: string;
      line: string;
      line_item_id?: string | null;
      gasto: number;
    } & Dv360LineContext)[];
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
  line_item_id?: string | null;
  cliente: string;
  campanha: string;
  account_management?: string;
  gasto: number;
  investido: number | null;
  pct_invest: number | null;
} & Dv360LineContext;

export type CampaignResponse = {
  token: string;
  period: { start: string; end: string };
  campaign: JourneyRow | null;
  line_rows: CampaignLineRow[];
  daily: Array<{ date: string; total: number; [platform: string]: string | number }>;
  active_platforms: string[];
};
