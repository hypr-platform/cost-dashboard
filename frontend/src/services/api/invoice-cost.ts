import { fetchJsonWithTimeout } from "./http";

export type InvoiceDailyRow = {
  day: string;
  invoices: number;
  captcha_brl: string;
  invoice_reader_brl: string;
  total_brl: string;
  cost_per_invoice_brl: string;
  source: "label" | "estimated";
};

export type InvoiceCostResponse = {
  from_date: string;
  to_date: string;
  total_invoices: number;
  total_captcha_brl: string;
  total_invoice_reader_brl: string;
  total_cost_brl: string;
  avg_cost_per_invoice_brl: string;
  daily: InvoiceDailyRow[];
  cached: boolean;
  fetched_at: string;
};

export function fetchInvoiceCostDashboard(
  url: string,
): Promise<InvoiceCostResponse> {
  return fetchJsonWithTimeout<InvoiceCostResponse>(url, {
    timeoutMs: 60000,
    errorMessage: "Falha ao carregar custo de notas fiscais.",
  });
}
