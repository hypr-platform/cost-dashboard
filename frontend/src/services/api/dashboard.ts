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

export type SaveNoTokenObservationInput = {
  platform: string;
  line: string;
  line_item_id?: string | null;
  observation: string;
};

export async function saveNoTokenObservation(
  apiBase: string,
  body: SaveNoTokenObservationInput,
): Promise<void> {
  const response = await fetch(
    `${apiBase.replace(/\/$/, "")}/api/attention/no-token-lines/observation`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        platform: body.platform,
        line: body.line,
        line_item_id: body.line_item_id ?? null,
        observation: body.observation,
      }),
    },
  );
  if (!response.ok) {
    let detail = "";
    try {
      const parsed = (await response.json()) as { detail?: unknown };
      if (typeof parsed.detail === "string") {
        detail = parsed.detail;
      }
    } catch {
      /* ignore */
    }
    throw new Error(detail || `Falha ao salvar observação (${response.status}).`);
  }
}
