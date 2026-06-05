/**
 * Registry de abas-ferramenta (seção "Ferramentas" do sidebar).
 *
 * Cada item declara uma vez: chave, label, slug da rota, ícone, componente e
 * flag `enabled`. Todo o resto (sidebar, render, route resolution) deriva
 * daqui. Para ocultar uma aba: `enabled: false`. Para adicionar uma nova:
 * acrescente um item.
 *
 * Por que não usar `NEXT_PUBLIC_*`? Toggles de aba são deploy-time, não
 * runtime — bake-in no bundle evita flash, simplifica build e mantém o type
 * system consciente das chaves disponíveis.
 */

import type { ComponentType } from "react";
import BigQueryTab from "../components/BigQueryTab";
import GoogleCloudTab from "../components/GoogleCloudTab";
import InvoiceCostTab from "../components/InvoiceCostTab";

export type ToolTabKey = "BigQuery" | "GoogleCloud" | "InvoiceCost";

export type ToolTab = {
  key: ToolTabKey;
  label: string;
  slug: string;
  enabled: boolean;
  Component: ComponentType;
  Icon: ComponentType;
};

function BigQueryIcon() {
  return (
    <span className="brandIcon" aria-hidden="true">
      <svg
        className="brandIconSvg"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <ellipse cx="8" cy="4" rx="5.5" ry="2" />
        <path d="M2.5 4v4c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2V4" />
        <path d="M2.5 8v4c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2V8" />
      </svg>
    </span>
  );
}

function GoogleCloudIcon() {
  return (
    <span className="brandIcon" aria-hidden="true">
      <svg
        className="brandIconSvg"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M4.5 10.5a2.5 2.5 0 0 1 .4-4.97 3.5 3.5 0 0 1 6.7-.4 2.6 2.6 0 0 1 .9 5.07" />
        <path d="M5.5 10.5h6" />
      </svg>
    </span>
  );
}

function InvoiceIcon() {
  return (
    <span className="brandIcon" aria-hidden="true">
      <svg
        className="brandIconSvg"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M4 2h6l2.5 2.5V14H4z" />
        <path d="M6 6.5h4M6 9h4M6 11.5h2.5" />
      </svg>
    </span>
  );
}

/** Fonte da verdade. Mude `enabled` para ocultar/exibir. */
export const TOOL_TABS: readonly ToolTab[] = [
  {
    key: "BigQuery",
    label: "BigQuery",
    slug: "bigquery",
    enabled: true,
    Component: BigQueryTab,
    Icon: BigQueryIcon,
  },
  {
    key: "GoogleCloud",
    label: "Google Cloud",
    slug: "google-cloud",
    enabled: true,
    Component: GoogleCloudTab,
    Icon: GoogleCloudIcon,
  },
  {
    key: "InvoiceCost",
    label: "Notas Fiscais",
    slug: "notas-fiscais",
    enabled: true,
    Component: InvoiceCostTab,
    Icon: InvoiceIcon,
  },
];

/** Todas as chaves de ferramenta, independentemente de visibilidade. */
export const TOOL_TAB_KEYS: ReadonlySet<ToolTabKey> = new Set(
  TOOL_TABS.map((t) => t.key),
);

/** Apenas as visíveis, na ordem declarada. */
export const VISIBLE_TOOL_TABS: readonly ToolTab[] = TOOL_TABS.filter(
  (t) => t.enabled,
);

/** Lookup direto por chave (qualquer tab, mesmo oculta). */
export const TOOL_TAB_BY_KEY: Record<ToolTabKey, ToolTab> = Object.fromEntries(
  TOOL_TABS.map((t) => [t.key, t]),
) as Record<ToolTabKey, ToolTab>;

/** Slugs → chave. Só inclui visíveis: rotas de tabs ocultas não resolvem. */
export const VISIBLE_TOOL_SLUG_TO_KEY: Record<string, ToolTabKey> =
  Object.fromEntries(VISIBLE_TOOL_TABS.map((t) => [t.slug, t.key]));

/** Helper: tab visível para esta chave, ou undefined. */
export function getVisibleToolTab(key: ToolTabKey): ToolTab | undefined {
  const tab = TOOL_TAB_BY_KEY[key];
  return tab?.enabled ? tab : undefined;
}
