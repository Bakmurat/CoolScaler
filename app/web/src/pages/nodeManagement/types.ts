// Local response types for the Node Management page (do not add to api/types.ts).

export interface NdTotals {
  nodes?: number;
  monthlyCost?: number;
  cpuAllocatable?: number;
  memoryAllocatable?: number;
  cpuRequestPct?: number;
  cpuUsagePct?: number;
  memoryRequestPct?: number;
  memoryUsagePct?: number;
  spotNodes?: number;
  blockedNodes?: number;
}

export interface NdNode {
  name: string;
  instanceType?: string;
  isSpot?: boolean;
  cpuAllocatable?: number;
  memoryAllocatable?: number;
  maxPods?: number;
  cpuRequest?: number;
  memoryRequest?: number;
  cpuUsage?: number;
  memoryUsage?: number;
  runningPods?: number;
  daemonSetPods?: number;
  pendingPods?: number;
  blockers?: number;
  blockerReasons?: Record<string, number>;
  ready?: boolean;
  taints?: { key: string; value?: string; effect: string }[];
  gpus?: number;
  cost?: number;
  pricedBy?: string;
  /** Node group / pool name (feature-detected — live backend may not send it yet). */
  nodeGroup?: string;
  /** Pricing discount type, e.g. Reserved / Savings Plan (feature-detected). */
  discountType?: string;
  /** Node labels (feature-detected; enables the Labels filter when present). */
  labels?: Record<string, string>;
}

export interface NodesResponse {
  nodes?: NdNode[];
  totals?: NdTotals;
}

export interface GraphPoint {
  timestamp: string;
  values?: Record<string, number | null>;
}
export interface GraphResponse {
  values?: GraphPoint[];
}

export interface PlacementTotalsResponse {
  totals?: { blockedNodes?: number };
}

export interface NodeOptCandidate {
  node: string;
  instanceType?: string;
  runningPods?: number;
  cpuRequestPct?: number;
  monthlyCost: number;
}
export interface NodeOptInstanceType {
  instanceType: string;
  nodes: number;
  monthlyCost: number;
  status: string; // allowed | blocked | not-allowed
}
export interface NodeOptResponse {
  instanceTypes?: NodeOptInstanceType[];
  consolidation?: {
    candidates?: NodeOptCandidate[];
    candidateCount?: number;
    potentialMonthlySavings?: number;
    currentNodes?: number;
    optimizedNodes?: number;
  };
}

export interface PvVolume {
  namespace: string;
  pvc: string;
  usedBytes?: number;
  capacityBytes?: number;
  utilizationPct?: number;
  overProvisionedBytes?: number;
  recommendedBytes?: number;
}
export interface VolumesResponse {
  volumes?: PvVolume[];
  totals?: {
    count?: number;
    usedBytes?: number;
    capacityBytes?: number;
    overProvisionedPct?: number;
  };
}

export interface NodePod {
  namespace: string;
  name: string;
  workloadKind?: string;
  cpuReq?: number;
  cpuUse?: number;
  memReq?: number;
  memUse?: number;
  blockers?: string[];
  creationTimestamp?: string;
}
export interface NodeEvent {
  type?: string;
  reason?: string;
  message?: string;
  count?: number;
  lastTimestamp?: string;
}
export interface NodeDetail {
  found?: boolean;
  name?: string;
  cost?: number;
  pricedBy?: string;
  isSpot?: boolean;
  instanceType?: string;
  ready?: boolean;
  schedulable?: boolean;
  creationTimestamp?: string;
  kubeletVersion?: string;
  os?: string;
  containerRuntime?: string;
  allocatable?: { cpu?: number; mem?: number };
  request?: { cpu?: number; mem?: number };
  usage?: { cpu?: number; mem?: number };
  taints?: { key: string; value?: string; effect: string }[];
  labels?: Record<string, string>;
  podCount?: number;
  pods?: NodePod[];
  events?: NodeEvent[];
  node?: unknown;
}
