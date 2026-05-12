import Image from "next/image";
import type { ReactNode } from "react";
import { Skeleton } from "./Skeleton";

interface AppShellSkeletonProps {
  /** Page body — usually a per-page body skeleton component. */
  children: ReactNode;
  /** Hide the topbar (rare; e.g. focused tool pages). */
  showTopbar?: boolean;
  /**
   * Override the sidebar (e.g. inject the real `<Sidebar />` so the user can
   * navigate while the page body loads). Defaults to a static preview that
   * mirrors the canonical nav structure with no shimmer.
   */
  sidebar?: ReactNode;
}

/**
 * Shell wrapper shared by every page skeleton: real sidebar + topbar shell.
 * Only the page-specific body skeletons shimmer — the sidebar is never a
 * skeleton, because shimmer there gets in the way of navigation.
 */
export function AppShellSkeleton({
  children,
  showTopbar = true,
  sidebar,
}: AppShellSkeletonProps) {
  return (
    <main className="appLayout">
      {sidebar ?? <SidebarPreview />}
      <section className="content">
        {showTopbar ? <TopbarSkeleton /> : null}
        {children}
      </section>
    </main>
  );
}

interface NavItemSpec {
  label: string;
  letter?: string;
  icon?: "stack" | "journey" | "warn" | "danger" | "bigquery";
}

const CAMPAIGN_ITEMS: readonly NavItemSpec[] = [
  { label: "DeepDive", icon: "stack" },
  { label: "Campaign Journey", icon: "journey" },
  { label: "StackAdapt", letter: "S" },
  { label: "DV360", letter: "D" },
  { label: "Xandr", letter: "X" },
  { label: "Hivestack", letter: "H" },
  { label: "Nexd", letter: "N" },
];

const ATTENTION_ITEMS: readonly NavItemSpec[] = [
  { label: "Lines sem token", icon: "warn" },
  { label: "Gasto fora do mês", icon: "danger" },
];

const TOOL_ITEMS: readonly NavItemSpec[] = [
  { label: "BigQuery", icon: "bigquery" },
];

/**
 * Static, fully-rendered sidebar shown during initial page skeletons. Mirrors
 * the real sidebar layout so the only thing that visually changes when data
 * lands is the page body.
 */
function SidebarPreview() {
  return (
    <aside className="sidebar">
      <div className="sidebarBrand">
        <Image
          src="/hypr-logo-white.png"
          alt="HYPR"
          width={188}
          height={48}
          className="sidebarBrandLogo"
          priority
        />
      </div>
      <nav className="sidebarNav" aria-label="Navegação principal">
        <section className="sidebarGroup" aria-label="Campanhas">
          <p className="sidebarGroupTitle">Campanhas</p>
          <div className="sidebarGroupItems">
            {CAMPAIGN_ITEMS.map((item) => (
              <span key={item.label} className="navButton" aria-disabled="true">
                <NavItemIcon spec={item} />
                <span>{item.label}</span>
              </span>
            ))}
          </div>
        </section>
        <section className="sidebarGroup" aria-label="Atenção">
          <p className="sidebarGroupTitle">Atenção</p>
          <div className="sidebarGroupItems">
            {ATTENTION_ITEMS.map((item) => (
              <span key={item.label} className="navButton" aria-disabled="true">
                <NavItemIcon spec={item} />
                <span>{item.label}</span>
              </span>
            ))}
          </div>
        </section>
        <section className="sidebarGroup" aria-label="Ferramentas">
          <p className="sidebarGroupTitle">Ferramentas</p>
          <div className="sidebarGroupItems">
            {TOOL_ITEMS.map((item) => (
              <span key={item.label} className="navButton" aria-disabled="true">
                <NavItemIcon spec={item} />
                <span>{item.label}</span>
              </span>
            ))}
          </div>
        </section>
      </nav>
    </aside>
  );
}

function NavItemIcon({ spec }: { spec: NavItemSpec }) {
  if (spec.icon === "stack") {
    return (
      <span className="brandIcon" aria-hidden="true">
        <svg
          className="brandIconSvg"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M8 2 2 5l6 3 6-3-6-3Z" />
          <path d="M2 8l6 3 6-3" />
          <path d="M2 11l6 3 6-3" />
        </svg>
      </span>
    );
  }
  if (spec.icon === "journey") {
    return (
      <span className="brandIcon" aria-hidden="true">
        <svg
          className="brandIconSvg"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <line x1="5" y1="4" x2="13" y2="4" />
          <line x1="5" y1="8" x2="13" y2="8" />
          <line x1="5" y1="12" x2="13" y2="12" />
          <circle cx="3" cy="4" r="0.6" fill="currentColor" />
          <circle cx="3" cy="8" r="0.6" fill="currentColor" />
          <circle cx="3" cy="12" r="0.6" fill="currentColor" />
        </svg>
      </span>
    );
  }
  if (spec.icon === "warn") {
    return (
      <svg className="ico ico-warn" viewBox="0 0 14 14" aria-hidden="true">
        <path className="icoShape" d="M7 1.4 13.4 12.6H.6L7 1.4Z" />
        <path className="icoMark" d="M7 5.6v3" />
        <circle className="icoMarkDot" cx="7" cy="10.6" r="0.7" />
      </svg>
    );
  }
  if (spec.icon === "bigquery") {
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
        >
          <ellipse cx="8" cy="4" rx="5.5" ry="2" />
          <path d="M2.5 4v4c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2V4" />
          <path d="M2.5 8v4c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2V8" />
        </svg>
      </span>
    );
  }
  if (spec.icon === "danger") {
    return (
      <svg className="ico ico-danger" viewBox="0 0 14 14" aria-hidden="true">
        <circle className="icoShape" cx="7" cy="7" r="5.8" />
        <path className="icoMark" d="M7 4v3.2" />
        <circle className="icoMarkDot" cx="7" cy="9.6" r="0.7" />
      </svg>
    );
  }
  return (
    <span className="brandIcon" aria-hidden="true">
      {spec.letter ?? ""}
    </span>
  );
}

function TopbarSkeleton() {
  return (
    <div className="topbar" aria-hidden="true">
      <div className="topbarLeft">
        <Skeleton variant="heading" />
        <Skeleton variant="subtitleLarge" />
      </div>
      <div className="topbarControls">
        <Skeleton variant="buttonWide" />
        <Skeleton variant="buttonWide" />
        <Skeleton variant="button" />
      </div>
    </div>
  );
}
