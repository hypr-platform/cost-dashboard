import { fetchJson, fetchJsonWithTimeout } from "./http";
import type { DashboardResponse, RefreshMetricsResponse, RefreshStatusResponse } from "./types";

export function fetchDashboard(url: string): Promise<DashboardResponse> {
  return fetchJsonWithTimeout<DashboardResponse>(url, {
    timeoutMs: 15000,
    errorMessage: "Falha ao carregar dados do backend.",
  });
}

export function fetchRefreshMetrics(url: string): Promise<RefreshMetricsResponse> {
  return fetchJson<RefreshMetricsResponse>(url, {
    errorMessage: "Falha ao carregar métricas de atualização.",
  });
}

export function fetchRefreshStatus(url: string): Promise<RefreshStatusResponse> {
  return fetchJson<RefreshStatusResponse>(`${url}?_=${Date.now()}`, {
    errorMessage: "Falha ao carregar status de atualização.",
  });
}

export async function triggerDashboardRefresh(url: string): Promise<void> {
  const response = await fetch(url, { method: "POST" });
  if (!response.ok) {
    throw new Error("Falha ao disparar atualizacao na fonte.");
  }
}
