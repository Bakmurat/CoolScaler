// Typed shapes of the CoolScaler backend API responses.

/* GET /api/version */
export interface VersionResponse {
  currentVersion: string; // e.g. "v0.61.2"
  namespace: string;
  nextVersion: string;
  shouldUpdate: boolean;
  cloudProvider: string;
}

/** ov.products — per-product workload/automation counts. */
export interface ProductCounts {
  workloads?: number;
  eligible?: number;
  automated?: number;
  wastePct?: number;
  blockedNodes?: number;
  spotNodes?: number;
  spotPct?: number;
}

/** ov.features.rightsize.automation — the eligible-set automation counters
 * (both sides over the same denominator; raw ov.automated can read >100%). */
export interface RightsizeAutomation {
  percentage?: number;
  autoAmount?: number;
  unAutoAmount?: number;
  totalAmount?: number;
  excludedAmount?: number;
  actionableUnautomated?: number;
  isClusterAutomated?: boolean;
}

/** ov.signals — cluster-level auto-healing / pressure counters. */
export interface OverviewSignals {
  throttling?: number;
  oom?: number;
  underProvisioned?: number;
  bootTime?: number;
  burst?: number;
  initOpt?: number;
}

/** GET /api/overview — cluster-wide headline payload (partial typing; the
 * backend returns many more fields, add them as pages need them). */
export interface OverviewResponse {
  clusterName: string;
  readOnly: boolean;
  ready?: boolean;
  lastUpdate?: number;
  dataSource?: string;
  nodes: number;
  /** total workload count */
  workloads: number;
  sizable?: number;
  automated?: number;
  optimized?: number;
  autoEligible?: number;
  isClusterAutomated?: boolean;
  monthlyCost?: number;
  potentialSavings?: number;
  savingsPct?: number;
  activeSavings?: number;
  availableSavings?: number;
  reqCpu?: number;
  reqMem?: number;
  useCpu?: number;
  useMem?: number;
  recCpu?: number;
  recMem?: number;
  origCpu?: number;
  origMem?: number;
  allocCpu?: number;
  allocMem?: number;
  cpuWastePct?: number;
  memWastePct?: number;
  products?: {
    rightsizing?: ProductCounts;
    podPlacement?: ProductCounts;
    replicas?: ProductCounts;
    java?: ProductCounts;
    [key: string]: ProductCounts | undefined;
  };
  features?: {
    rightsize?: {
      automation?: RightsizeAutomation;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  signals?: OverviewSignals;
  namespaces?: unknown[];
  savingsBreakdown?: {
    rightsizing?: number;
    initContainers?: number;
    unrecognized?: number;
  };
  [key: string]: unknown;
}

/** One row of GET /api/workloads (partial — what the overview page needs). */
export interface Workload {
  key: string; // "ns/Kind/name"
  namespace: string;
  kind: string;
  name: string;
  replicas?: number;
  reqCpu?: number | null;
  reqMem?: number | null;
  useCpu?: number | null;
  useMem?: number | null;
  recCpu?: number | null;
  recMem?: number | null;
  monthlyCost?: number;
  savings: number;
  sizable: boolean;
  automated: boolean;
  excluded: boolean;
  hpaManaged?: boolean;
  policyName?: string;
  health?: string;
  [key: string]: unknown;
}

/** GET /api/workloads */
export interface WorkloadsResponse {
  workloads: Workload[];
  [key: string]: unknown;
}

/** One firing alert from GET /api/alerts. */
export interface AlertItem {
  type: string;
  severity: 'critical' | 'warning' | 'info' | string;
  message: string;
  workload?: string;
  value?: number | null;
  since?: string;
}

/** GET /api/alerts */
export interface AlertsResponse {
  alerts: AlertItem[];
  counts?: { critical?: number; warning?: number; info?: number };
  [key: string]: unknown;
}

/** GET /api/placement →.totals (pod-placement engine headline). */
export interface PlacementTotals {
  monthlyCost?: number;
  unevictablePods?: number;
  unevictableWorkloads?: number;
  blockedNodes?: number;
  automated?: number;
  savings?: number;
  wastePct?: number;
  nodes?: number;
  freedNodes?: number;
  pinnedNodes?: number;
  optimizedNodes?: number;
  readOnly?: boolean;
  [key: string]: unknown;
}

/** GET /api/scheduling →.totals (pod-scheduling engine headline). */
export interface SchedulingTotals {
  monthlyCost?: number;
  blockedNodes?: number;
  savings?: number;
  wastePct?: number;
  workloads?: number;
  automated?: number;
  nodes?: number;
  optimizedNodes?: number;
  readOnly?: boolean;
  [key: string]: unknown;
}

export interface PlacementResponse {
  totals?: PlacementTotals;
  [key: string]: unknown;
}

export interface SchedulingResponse {
  totals?: SchedulingTotals;
  [key: string]: unknown;
}

/** GET /api/health — component health probe. */
export interface HealthResponse {
  healthy: boolean;
  components?: { component: string; ready: number; total: number; healthy: boolean }[];
}

/** GET /api/custom-workloads →.totals */
export interface CustomWorkloadsResponse {
  totals?: {
    builtins?: number;
    unrecognizedPods?: number;
    daemonsetGroups?: number;
    userCogs?: number;
  };
  [key: string]: unknown;
}

/** GET /api/available-actions — drives the sidebar action-count badges. */
export interface AvailableActionsResponse {
  features?: {
    replicasOptimization?: { shouldDisplay?: boolean; workloadsWaste?: number };
    podPlacement?: { shouldDisplay?: boolean; workloadsWaste?: number };
    nodes?: { shouldDisplay?: boolean; blockedNodesCount?: number };
    [key: string]: unknown;
  };
}

/** Generic mutation response ({ok, message?}). */
export interface ActionResponse {
  ok?: boolean;
  message?: string;
  [key: string]: unknown;
}
