import type { components } from "./schema";
import { fetchJsonWithTimeout } from "./http";

/**
 * Tipos derivados do schema OpenAPI do backend (`schema.d.ts`, gerado por
 * `npm run gen:api`). São a fonte única de verdade: qualquer mudança nos
 * modelos Pydantic da Vercel se propaga aqui ao regerar, sem edição manual.
 */
type Schemas = components["schemas"];

export type VercelServiceRow = Schemas["VercelServiceRow"];
export type VercelProjectRow = Schemas["VercelProjectRow"];
export type VercelRegionRow = Schemas["VercelRegionRow"];
export type VercelChargeCategoryRow = Schemas["VercelChargeCategoryRow"];
export type VercelDailyRow = Schemas["VercelDailyRow"];
export type VercelCategoryDailyPoint = Schemas["VercelCategoryDailyPoint"];
export type VercelCostResponse = Schemas["VercelCostResponse"];

export function fetchVercelCostDashboard(
  url: string,
): Promise<VercelCostResponse> {
  return fetchJsonWithTimeout<VercelCostResponse>(url, {
    timeoutMs: 90000,
    errorMessage: "Falha ao carregar custos da Vercel.",
  });
}
