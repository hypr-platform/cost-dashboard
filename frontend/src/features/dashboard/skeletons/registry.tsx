import type { ComponentType } from "react";
import { AppShellSkeleton } from "@/shared/skeletons";
import { HomeDashboardSkeleton } from "./HomeDashboardSkeleton";
import { JourneySkeleton } from "./JourneySkeleton";
import { NoTokenLinesSkeleton, OutOfPeriodSkeleton } from "./AttentionSkeleton";
import { PlatformPageSkeleton } from "./PlatformPageSkeleton";
import { BigQuerySkeleton } from "./BigQuerySkeleton";
import { GoogleCloudSkeleton } from "./GoogleCloudSkeleton";

/**
 * Mirror of the DashboardPage NavKey union. Kept local to avoid a circular
 * import with DashboardPage.tsx (the canonical type lives there); update both
 * when adding a page.
 */
export type SkeletonPageKey =
  | "Dashboard"
  | "Jornada de campanhas"
  | "⚠️ Lines sem token"
  | "🚨 Gasto fora do mês vigente"
  | "Nexd"
  | "StackAdapt"
  | "DV360"
  | "Xandr"
  | "Hivestack"
  | "Amazon DSP"
  | "BigQuery"
  | "GoogleCloud";

/**
 * Registry of body skeletons per page. Adding a new page = add an entry here
 * and (optionally) a dedicated body component. Falls back to the home body
 * when a key isn't mapped, so this can never crash a render.
 */
const BODY_BY_PAGE: Record<SkeletonPageKey, ComponentType> = {
  Dashboard: HomeDashboardSkeleton,
  "Jornada de campanhas": JourneySkeleton,
  "⚠️ Lines sem token": NoTokenLinesSkeleton,
  "🚨 Gasto fora do mês vigente": OutOfPeriodSkeleton,
  Nexd: PlatformPageSkeleton,
  StackAdapt: PlatformPageSkeleton,
  DV360: PlatformPageSkeleton,
  Xandr: PlatformPageSkeleton,
  Hivestack: PlatformPageSkeleton,
  "Amazon DSP": PlatformPageSkeleton,
  BigQuery: BigQuerySkeleton,
  GoogleCloud: GoogleCloudSkeleton,
};

/**
 * Renders the AppShell + the body skeleton matched to `page`.
 * Single entry-point for the dashboard's "initial loading" UI.
 */
export function PageSkeleton({ page }: { page: SkeletonPageKey }) {
  const Body = BODY_BY_PAGE[page] ?? HomeDashboardSkeleton;
  return (
    <AppShellSkeleton>
      <Body />
    </AppShellSkeleton>
  );
}
