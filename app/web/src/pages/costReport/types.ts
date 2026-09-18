// Local response types for the Cost Report page (/api/cost-report,
// /api/auth/rbac, /api/cost/config) — kept out of the shared api/types.ts.

export interface CostReportTotals {
  monthlyNodeCost?: number;
  monthlyWorkloadCost?: number;
  monthlySavingsAvailable?: number;
  savingsPct?: number;
}

export interface CostByNamespace {
  cpuRequest?: number;
  memRequest?: number;
  spotPct?: number | null;
  onDemandPct?: number | null;
  namespace: string;
  monthlyCost?: number;
  savings?: number;
  workloads?: number;
  pods?: number;
}

export interface CostTopWorkload {
  cpuRequest?: number;
  memRequest?: number;
  namespace: string;
  name: string;
  kind: string;
  monthlyCost?: number;
  savings?: number;
}

export interface CostByNode {
  name: string;
  instanceType?: string;
  lifecycle?: string;
  monthlyCost?: number;
  runningPods?: number;
}

export interface CostOverTimePoint {
  timestamp: string;
  costs?: { id: string; value: number }[];
}

export interface CostReportResponse {
  clusterName?: string;
  totals?: CostReportTotals;
  byNamespace?: CostByNamespace[];
  topWorkloads?: CostTopWorkload[];
  byNode?: CostByNode[];
  costOverTime?: CostOverTimePoint[];
  cloudIntegration?: { configured?: boolean; provider?: string; note?: string };
  [key: string]: unknown;
}

export interface RbacRule {
  apiGroups: string[];
  resources: string[];
  verbs: string[];
}

export interface RbacResponse {
  authMode?: string;
  currentUser?: { name?: string; groups?: string[]; role?: string };
  canAutomateCluster?: boolean;
  clusterAdmin?: boolean;
  note?: string;
  rules?: RbacRule[];
}

export interface CostPricing {
  cpu?: number | null;
  memory?: number | null;
  gpu?: number | null;
}

export interface CostConfigResponse {
  costConfig?: {
    includeUnallocatedCost?: boolean;
    customResourcesPricing?: {
      manual?: CostPricing;
      'manual-spot'?: CostPricing;
    };
  };
}
