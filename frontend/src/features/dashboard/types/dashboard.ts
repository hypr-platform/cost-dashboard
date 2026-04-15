export type StackAdaptSortKey =
  | "line"
  | "token"
  | "cliente"
  | "campanha"
  | "gasto"
  | "investido"
  | "pct_invest"
  | "total";

export type StackAdaptSortDirection = "asc" | "desc";
export type AttentionNoTokenSortKey = "platform" | "line" | "gasto";
export type AttentionOutOfPeriodSortKey = "platform" | "token" | "cliente" | "campanha" | "account_management" | "vigencia" | "gasto";
export type AttentionSortDirection = "asc" | "desc";
export type NexdFormatSortKey = "layout" | "pct_imp" | "impressions" | "creatives" | "per_creative" | "estimated_cost_brl";
export type CampaignJourneySortKey =
  | "token"
  | "cliente"
  | "campanha"
  | "account_management"
  | "status"
  | "investido"
  | "total_plataformas"
  | "pct_investido"
  | "campaign_start"
  | "campaign_end"
  | `platform:${string}`;

export type AnalysisViewMode = "month" | "year";
export type RefreshPhase = "idle" | "starting" | "running" | "success" | "error";
