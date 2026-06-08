"use client";

import { useRouter } from "next/navigation";
import { VISIBLE_TOOL_TABS, type ToolTabKey } from "../config/tool-tabs";

/**
 * Grupo "Ferramentas" da sidebar. Fonte única para o sidebar real do
 * DashboardPage e para o preview exibido durante o initial loading skeleton —
 * antes existia uma lista hardcoded duplicada que perdia tabs novas adicionadas
 * em `tool-tabs.tsx`.
 */
export function SidebarToolsSection({ activeKey }: { activeKey?: ToolTabKey }) {
  const router = useRouter();
  if (VISIBLE_TOOL_TABS.length === 0) return null;
  return (
    <section className="sidebarGroup" aria-label="Ferramentas">
      <p className="sidebarGroupTitle">Ferramentas</p>
      <div className="sidebarGroupItems">
        {VISIBLE_TOOL_TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            className={`navButton ${activeKey === tab.key ? "navButtonActive" : ""}`}
            onClick={() => router.push(`/${tab.slug}`)}
          >
            <tab.Icon />
            <span>{tab.label}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
