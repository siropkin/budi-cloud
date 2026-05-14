/**
 * Barrel for the dashboard Data Access Layer.
 *
 * The DAL is split by surface — overview / team / devices / models / repos /
 * surfaces / sessions / sync / pricing / user — under `src/lib/dal/`. This
 * file re-exports everything so existing `@/lib/dal` imports keep working
 * after the #278 split. Prefer importing through the barrel from page-level
 * callers; internal DAL files should import from their sibling modules
 * directly (or from `./types` for shared scoping helpers).
 */
export type { DateRange, ScopeOptions } from "./types";

export { getCurrentUser, getOrgMembers } from "./user";

export {
  type OverviewStats,
  type HeatmapCell,
  UNASSIGNED_USER_ID,
  getOverviewStats,
  getDailyActivity,
  getActivityHeatmap,
  getEarliestActivity,
  getCostByUser,
} from "./overview";

export { type TeamActivityDay, getTeamActivityByDay } from "./team";

export {
  type DeviceActivityDay,
  type DeviceCost,
  getDeviceActivityByDay,
  getCostByDevice,
} from "./devices";

export {
  type ModelActivityDay,
  getModelActivityByDay,
  getCostByModel,
} from "./models";

export { getCostByRepo, getCostByBranch, getCostByTicket } from "./repos";

export {
  type SurfaceCost,
  getCostBySurface,
  getKnownSurfaces,
} from "./surfaces";

export {
  type SessionsCursor,
  type SessionRow,
  SESSIONS_PAGE_SIZE,
  getSessions,
  getSessionDetail,
  getSessionDetailBySessionId,
} from "./sessions";

export { getSyncFreshness } from "./sync";

export {
  type RecalculationRunRow,
  getOrgHasActivePriceList,
  getRecalculationRuns,
} from "./pricing";
