// Local response types for /api/placement (GET)
export interface PpTotals {
  monthlyCost?: number;
  unevictablePods?: number;
  unevictableWorkloads?: number;
  blockedNodes?: number;
  automated?: number;
  savings?: number;
  wastePct?: number;
  blockedByReason?: Record<string, number>;
  nodes?: number;
  freedNodes?: number;
  pinnedNodes?: number;
  optimizedNodes?: number;
  readOnly?: boolean;
}

export interface PpCategory {
  key: string;
  label: string;
  desc: string;
  canOptimize?: boolean;
  pods?: number;
  automated?: number;
  savings?: number;
}

export interface PpWorkload {
  key: string;
  namespace: string;
  kind: string;
  name: string;
  reasons?: string[];
  reasonChips?: string[];
  replicas?: number;
  savings?: number;
  automated?: boolean;
  optimized?: boolean;
  nodes?: string[];
  /** workload template labels/annotations — feed the Pod Placement
   * labels / annotations filter dropdowns (backend actions.go wlRowP). */
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  rolloutEligible?: boolean;
}

export interface PpBlockedNode {
  node: string;
  savings?: number;
  freeable?: boolean;
  pinned?: boolean;
  pods?: number;
  reasons?: string[];
  reasonChips?: string[];
  /** Per-node unevictable category counts — NEW backend field (may be absent on
   * older backends; feature-detected in unevictableByNode.tsx which also accepts
   * a few alternative key spellings/nestings). */
  podCategories?: {
    optimized?: number;
    unevictable?: number;
    notReady?: number;
    ownerless?: number;
  };
}

export interface PlacementResponse {
  categories?: PpCategory[];
  workloads?: PpWorkload[];
  blockedNodes?: PpBlockedNode[];
  totals?: PpTotals;
  clusterName?: string;
}
