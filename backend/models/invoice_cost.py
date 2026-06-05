"""Pydantic models para o dashboard de custo de notas fiscais.

Cruza duas fontes no BigQuery:
- Volume: `hypr_invoice_data.invoices-processed` (notas processadas por dia).
- Custo: billing export do GCP — Cloud Run `hypr-captcha-solver` (isolado pela
  região europe-west1, onde é o único service) + `invoice-reader` (via label
  `service`, disponível a partir do dia em que os labels foram aplicados).

Custo por nota = custo_total_brl / notas_processadas.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from pydantic import BaseModel


class InvoiceDailyRow(BaseModel):
    day: date
    invoices: int
    captcha_brl: Decimal
    invoice_reader_brl: Decimal
    total_brl: Decimal
    cost_per_invoice_brl: Decimal
    # "label" = custo exato via label `service` no billing; "estimated" = rateio
    # por CPU (Cloud Monitoring) para dias anteriores aos labels.
    source: str = "estimated"


class InvoiceCostResponse(BaseModel):
    from_date: date
    to_date: date
    total_invoices: int
    total_captcha_brl: Decimal
    total_invoice_reader_brl: Decimal
    total_cost_brl: Decimal
    avg_cost_per_invoice_brl: Decimal
    daily: list[InvoiceDailyRow]
    cached: bool = False
    fetched_at: str
