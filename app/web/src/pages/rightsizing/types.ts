// Response shapes for the Rightsizing surface.
import type { Workload } from '../../api/types';

/** Full workload row shape used by the Rightsizing table (superset of Workload). */
export interface WorkloadRow extends Workload {
  activeSavings?: number;
  origCpu?: number | null;
  origMem?: number | null;
  automationSource?: string;
  policySuggested?: string;
  policyActive?: string | null;
  detectedTag?: string | null;
  smartPolicyWorkloadType?: string | null;
  isPrivileged?: boolean;
  isSleeping?: boolean;
  agentic?: boolean;
  java?: boolean;
  priorityClass?: string;
  rolloutStrategy?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  initOptimization?: InitOpt[];
  initSavings?: number;
  unevictableReasons?: string[];
  nodeSelectorKeys?: string[];
  tolerationKeys?: string[];
  podInfo?: PodInfo[];
  containers?: ContainerLive[];
  signals?: WorkloadSignals;
  events?: WlEvent[];
  bootCpu?: number;
  hpaConversions?: HpaConversion[];
  reqEph?: number;
  initOverCpu?: number;
  initOverMem?: number;
  workloadErrors?: string[];
}

export interface InitOpt {
  name: string;
  reqCpu?: number | null;
  reqMem?: number | null;
  recCpu?: number | null;
  recMem?: number | null;
}

export interface PodInfo {
  name: string;
  node?: string;
  restarts: number;
  oom?: number;
  crashloop?: boolean;
  reqCpu?: number | null;
  reqMem?: number | null;
  useCpu?: number | null;
  useMem?: number | null;
  phase?: string;
  qos?: string;
  startTime?: string;
  ready?: boolean;
}

export interface ContainerLive {
  name: string;
  excluded?: boolean;
  reqCpu?: number | null;
  reqMem?: number | null;
  useCpu?: number | null;
  useMem?: number | null;
  recCpu?: number | null;
  recMem?: number | null;
  qos?: Record<string, { cpuReq: number; cpuLim: number; memReq: number; memLim: number }>;
  capStatuses?: Record<string, CapStatus>;
}

export interface WorkloadSignals {
  throttle?: number;
  oom?: number;
  oomNode?: number;
  restarts?: number;
  crashloop?: number;
  liveness?: number;
  burst?: boolean;
  boot?: boolean;
  diskEvict?: number;
  psiCpu?: number;
  psiMem?: number;
}

export interface WlEvent {
  type: string;
  level?: string;
  message?: string;
  ageMin?: number;
  active?: boolean;
}

export interface HpaConversion {
  source: string;
  resource: string;
  fromUtilization: number;
  averageValue: string;
  origRequest?: string;
  newRequest?: string;
}

export interface CapStatus {
  isCapped?: boolean;
  cappedSource?: string;
  cappedType?: string;
  message?: string;
  originalCappedValue?: string | number | null;
}

/** status.rightSize.containers[] on the Recommendation CR. */
export interface RecContainer {
  name: string;
  containerName?: string;
  requests?: Record<string, string>;
  originRequests?: Record<string, string>;
  limits?: Record<string, string>;
  originLimitResources?: Record<string, string>;
  capStatuses?: Record<string, CapStatus>;
  limitCapStatuses?: Record<string, CapStatus>;
  resourceStatuses?: Record<
    string,
    { maxObserved?: string | number; readyWindowCoveragePercentage?: number }
  >;
  [key: string]: unknown;
}

export interface ReplicasOpt {
  policyName: string;
  policies?: string[];
  automated?: boolean;
  predictable?: boolean;
  origMin?: number;
  recMin?: number;
  maxReplicas?: number | null;
  curThreshold?: number | null;
  recThreshold?: number | null;
  triggerType?: string;
  savings?: number;
  monthlyCost?: number;
  optimizedCost?: number;
  trend?: number[];
}

export interface SchedulingOpt {
  has?: boolean;
  policyName?: string;
  minimumNodesSpread?: number;
  zones?: boolean;
  replicas?: number;
  selfBefore?: number;
  selfAfter?: number;
  nodesBefore?: number;
  nodesAfter?: number;
  savings?: number;
  automated?: boolean;
  required?: boolean;
  topologyKey?: string | null;
  concerns?: string[];
  nodesTrend?: number[];
  nodesOptTrend?: number[];
  selfTrend?: number[];
  selfOptTrend?: number[];
  timeline?: unknown[];
}

export interface JavaJvm {
  realUsage?: boolean;
  observability?: boolean;
  heapUsedP90?: number;
  heapUsedMax?: number;
  nonHeapUsed?: number;
  heapCommitted?: number;
  jvmXmx?: number;
  recommendedXmx?: number;
  gcSecondsRate?: number | null;
  memRec?: number;
  memRequest?: number;
  status?: string;
}

/** GET /api/recommendation/{ns}/{kind}/{name}. */
export interface RecommendationDetail {
  found: boolean;
  crName?: string | null;
  namespace?: string;
  apiVersion?: string;
  kind?: string;
  spec?: Record<string, unknown>;
  status?: {
    rightSize?: { containers?: RecContainer[] };
    policyName?: string;
    source?: string;
    lastUpdated?: string;
    [key: string]: unknown;
  };
  replicasOpt?: ReplicasOpt | null;
  schedulingOpt?: SchedulingOpt | null;
  javaJvm?: JavaJvm | null;
  replicas?: number;
  monthlyCost?: number | null;
  savings?: number | null;
  sizable?: boolean;
  automated?: boolean;
  excluded?: boolean;
  automationSource?: string;
  policyName?: string;
  policySuggested?: string;
  policyActive?: string | null;
  detectedTag?: string | null;
  smartPolicyWorkloadType?: string | null;
  /** detected runtime language ("Go", "Java", …) — new backend field */
  language?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  java?: boolean;
  gpuReq?: number;
  spotEligible?: boolean | null;
  reqEph?: number;
  recEph?: number;
  hpaManaged?: boolean;
  hpaConversions?: HpaConversion[];
  health?: string;
  signals?: WorkloadSignals;
  events?: WlEvent[];
  initOptimization?: InitOpt[];
  initSavings?: number;
  bootCpu?: number;
  containersLive?: ContainerLive[];
  podInfo?: PodInfo[];
  inPlace?: { capable?: boolean };
  readOnly?: boolean;
  [key: string]: unknown;
}

/** GET /api/timeseries/... */
export interface TimeseriesPoint {
  t: number;
  avg?: number | null;
  p90?: number | null;
  max?: number | null;
  currentRequest?: number | null;
  originRequest?: number | null;
  recommendedRequest?: number | null;
  currentLimit?: number | null;
  originalLimit?: number | null;
}
export interface TimeseriesResponse {
  found?: boolean;
  unit: string; // 'cores' | 'bytes'
  period: string;
  dataSource?: string;
  points?: TimeseriesPoint[];
  javaPoints?: { t: number; p90?: number | null; max?: number | null }[];
  lines?: {
    optimized?: number;
    current?: number;
    original?: number;
    limit?: number;
    originalLimit?: number;
  };
}

/** GET /api/troubleshoot/... */
export interface TbSeries {
  label: string;
  color: string;
  dash?: boolean;
  flat?: number | null;
  points?: { t: number; v: number | null }[];
}
export interface TbChart {
  id: string;
  title: string;
  unit: string;
  series: TbSeries[];
  /** false → chart starts unselected in the Charts picker (backend catalog) */
  selected?: boolean;
}
export interface TroubleshootResponse {
  found?: boolean;
  period?: string;
  dataSource?: string;
  charts?: TbChart[];
}

/** GET /api/diagnostics. */
export interface DiagnosticsResponse {
  diagnosticEventsSeries?: ({ timestamp: string } & Record<string, unknown>)[];
}

/** GET /api/analytics/graph. */
export interface AnalyticsGraphResponse {
  values?: { timestamp: string; values: Record<string, number | null> }[];
}

/** GET /api/policies. */
export interface PoliciesResponse {
  policies?: { name: string; [key: string]: unknown }[];
}

/** GET /api/recommendation-whatif. */
export interface WhatIfResponse {
  monthlyCost?: number | null;
  savings?: number | null;
  containers?: { name: string; requests?: Record<string, string> }[];
}

/** GET /api/workload-yaml/... */
export interface WorkloadYamlResponse {
  workload?: unknown;
  hpa?: unknown;
  pdb?: unknown;
  scaledObject?: unknown;
  limitRange?: unknown;
  resourceQuota?: unknown;
}

/** GET /api/network/... */
export interface NetworkResponse {
  found?: boolean;
  totals?: { ingressBps?: number; egressBps?: number };
  series?: { t?: number; in?: number; out?: number }[];
}

/** GET /api/apis/... */
export interface ApisResponse {
  found?: boolean;
  available?: boolean;
  totals?: { rps?: number; errorRate?: number; p99?: number };
}
