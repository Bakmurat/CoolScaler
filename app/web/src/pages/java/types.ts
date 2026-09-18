// Local response types for the Java Resource Management page (/api/java*).

export interface JavaWorkload {
  namespace: string;
  kind: string;
  name: string;
  container: string;
  image: string;
  replicas: number;
  xmx: number;
  nonHeapReserve: number;
  jvmCeiling: number;
  memRequest: number;
  memUsage: number;
  memRec: number;
  recommendedXmx: number;
  status: 'oom-risk' | 'over-provisioned' | 'ok' | string;
  savings: number;
  observability: boolean;
  policyName?: string;
  javaAuto?: boolean;
  obsExcluded?: boolean;
  injectionFatal?: boolean;
  injectionGap?: string;
  realUsage?: boolean;
  javaRealMem?: number;
  heapUsedP90?: number;
  heapUsedMax?: number;
  nonHeapUsed?: number;
  heapCommitted?: number;
  jvmXmx?: number;
  gcSecondsRate?: number;
  hpaManaged?: boolean;
  // ---- NEW backend fields (feature-detected; LIVE backend may not send them yet) ----
  /** Monthly reclaimable $ per workload (falls back to `savings`). */
  savingsAvailable?: number;
  /** CPU request per replica, cores. No fallback — '—' until the backend ships it. */
  cpuRequest?: number;
  /** Memory request per replica, bytes (falls back to `memRequest`). */
  memoryRequest?: number;
  replicasRunning?: number;
  replicasDesired?: number;
  /** Java automation flag (falls back to `javaAuto`). */
  automated?: boolean;
  /** Workload labels for the labels filter (absent on the live backend today). */
  labels?: Record<string, string>;
}

export interface JavaTotals {
  javaWorkloads?: number;
  oomRisk?: number;
  overProvisioned?: number;
  savings?: number;
  withXmx?: number;
  automated?: number;
  injectionGaps?: number;
  observability?: number;
  realObservability?: number;
  enabled?: boolean; // forced on via Helm (java.enabled=true)
  jmxAgentImage?: string;
  observabilityEnabled?: boolean;
  optimizeEnabled?: boolean;
  readOnly?: boolean;
  savingsAvailable?: number;
  monthlyCost?: number;
  costCpuOriginal?: number;
  costCpuCurrent?: number;
  costMemOriginal?: number;
  costMemCurrent?: number;
  wastedSpendPct?: number;
  unautomated?: number;
}

/*
 * GET /api/java/policies — the java-memory-aware policy management surface. Falls back to a static
 * single builtin row.
*/
export interface JavaPolicy {
  name: string;
  builtin?: boolean;
  description?: string;
  usedBy?: string;
  usedByCount?: number;
  recommendation?: { realUsageCalculation?: boolean };
  automation?: {
    memoryOptimization?: boolean;
    gcOptimization?: boolean;
    oomAutoHealing?: boolean;
  };
}

/** NEW backend KPI block (feature-detected — every field optional). */
export interface JavaKpi {
  monthlyCost?: number;
  monthlyCostOriginal?: number;
  cpuRequestOriginal?: number;
  cpuRequestCurrent?: number;
  memRequestOriginal?: number;
  memRequestCurrent?: number;
  wastedSpendPct?: number;
  overProvisioned?: number;
  automated?: number;
  total?: number;
}

export interface JavaResponse {
  workloads: JavaWorkload[];
  totals: JavaTotals;
  /** NEW backend KPI block — absent on the live backend today. */
  kpi?: JavaKpi;
  clusterName?: string;
}

/* /api/java/graph */
export interface JavaGraphPoint {
  timestamp: string;
  values?: Record<string, number | null | undefined>;
}
export interface JavaGraphResponse {
  values: JavaGraphPoint[];
  clusterName?: string;
  error?: string;
}

export interface JavaActionResponse {
  ok?: boolean;
  message?: string;
  count?: number;
  rolledOut?: number;
}
