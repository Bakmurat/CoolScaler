// Response shapes for the Replicas Optimization + Downscale surfaces.

export interface RoWorkload {
  key: string; // ns/kind/name
  name: string;
  namespace: string;
  kind: string;
  automated?: boolean;
  predictable?: boolean;
  savings?: number;
  monthlyCost?: number;
  replicas?: number;
  maxReplicas?: number | null;
  origMin?: number | null;
  recMin?: number | null;
  curThreshold?: number | null;
  recThreshold?: number | null;
  triggerType?: string;
  kedaName?: string;
  policyName?: string;
  trend?: number[];
  /** Optional metadata (feature-detected — used by the labels chip / More filters). */
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

export interface RoTotals {
  monthlyCost?: number;
  wastedPct?: number;
  origCpu?: number;
  curCpu?: number;
  origMem?: number;
  curMem?: number;
  unoptimizedMinReplicas?: number;
  unoptimizedThresholds?: number;
  predictable?: number;
  automated?: number;
  total?: number;
}

/** HPA-scoped "Replicas over time" point (new backend key, feature-detected). */
export interface RoReplicasPoint {
  ts: number;
  optimized?: number | null;
  current?: number | null;
  original?: number | null;
  waste?: number | null;
}

/** HPA-scoped CPU/Memory over-time point (new backend key, feature-detected). */
export interface RoResourcePoint {
  ts: number;
  optimized?: number | null;
  request?: number | null;
  waste?: number | null;
  totalRequest?: number | null;
  originalRequest?: number | null;
  allocatable?: number | null;
}

export interface ReplicasResponse {
  workloads?: RoWorkload[];
  totals?: RoTotals;
  /** New keys (backend in flight) — absent on the live backend today. */
  replicasOverTime?: RoReplicasPoint[];
  cpuOverTime?: RoResourcePoint[];
  memOverTime?: RoResourcePoint[];
}

export interface RoPolicy {
  name: string;
  builtin?: boolean;
  schedule?: boolean;
  description?: string;
  usedBy: number;
  total: number;
  minStrategy?: string;
  prediction?: boolean;
  lookAhead?: string;
  staticPct?: number;
  predictablePct?: number;
  threshold?: boolean;
  maxBoundary?: number;
}

/** GET /api/hpa-policy?name= (editor working model). */
export interface HpaPolicyDetail {
  name: string;
  builtin?: boolean;
  isNew?: boolean;
  type?: string; // undefined | 'Schedule'
  description?: string;
  strategy?: string;
  minBoundary?: number;
  minHeadroom?: number;
  capByOrigin?: boolean;
  setMin?: number;
  setMaxEnabled?: boolean;
  setMax?: number;
  requiredHistory?: string;
  prediction?: boolean;
  lookAhead?: string;
  predHistoryWindow?: string;
  predMinEnabled?: boolean;
  predWindow?: string;
  predPct?: number;
  staticMinEnabled?: boolean;
  staticWindow?: string;
  staticPct?: number;
  threshold?: { enabled: boolean; requiredHistory: number; historyWindow: string; maxBoundary: number };
  // Schedule type
  defaultPolicy?: string;
  rules?: { policyName: string; days: number[]; beginTime: string; endTime: string }[];
  policyNames?: string[];
  error?: string;
}

// ---- Downscale ----
export interface DsSchedule {
  name: string;
  builtIn?: boolean;
  activeNow?: boolean;
  attachedWorkloads?: number;
  hpaMinReplicas?: number;
  targetReplicas?: number;
  sleep?: boolean;
  hpaEnabled?: boolean;
  windows: boolean[][] | number[][];
  periods?: { days: string | number; beginTime: string; endTime: string }[];
}

export interface DsWorkload {
  key: string;
  name: string;
  namespace: string;
  kind: string;
  hpaManaged?: boolean;
  currentlyDownscaled?: boolean;
  automated?: boolean;
  savings?: number;
  reqCpu?: number;
  reqMem?: number;
  reqGpu?: number;
  replicas: number;
  target: number;
  downscalable?: boolean;
  schedule?: string;
}

export interface DsTotals {
  monthlyCost?: number;
  cpuSaved?: number;
  memSaved?: number;
  gpuSaved?: number;
  wastedPct?: number;
  activeScaledDown?: number;
  downscalerWorkloads?: number;
  automated?: number;
  readOnly?: boolean;
  curDay?: number;
  curHour?: number;
}

export interface DownscaleResponse {
  totals?: DsTotals;
  schedules?: DsSchedule[];
  workloads?: DsWorkload[];
}
