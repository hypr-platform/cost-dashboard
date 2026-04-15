import { fetchJsonWithTimeout } from "./http";
import type { CampaignResponse } from "./types";

export function fetchCampaign(url: string): Promise<CampaignResponse> {
  return fetchJsonWithTimeout<CampaignResponse>(url, {
    timeoutMs: 15000,
    errorMessage: "Falha ao carregar dados do backend.",
  });
}
