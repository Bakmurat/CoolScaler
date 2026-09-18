// Response shapes for the Custom Workloads (CustomOwnerGrouping) surface.

export interface CogGroupByItem {
  labels?: string[];
  annotations?: string[];
  images?: string[];
  /* image incl. value/tag matching */
  imagesValues?: string[];
  envs?: string[];
  containerNames?: string[];
  nodeSize?: boolean | string;
  topOwnerController?: { kind?: string };
  /** per-rule Filters block (Add Filter → exclude labels/annotations) */
  exclude?: { labels?: string[]; annotations?: string[] };
}

export interface CustomWorkloadRow {
  name: string;
  builtIn?: boolean;
  enabled?: boolean;
  weight?: number;
  defaultPolicy?: string;
  defaultAuto?: boolean;
  cpu?: number;
  mem?: number;
  gpu?: number;
  /** GPU memory request total (new backend field, may be absent) */
  gpuMem?: number;
  workloads?: number;
  ownerKind?: string;
  groupBys?: CogGroupByItem[];
}

export interface UnrecognizedRow {
  ownerKind: string;
  cpu?: number;
  mem?: number;
  gpu?: number;
  pods?: number;
}

export interface UnrecognizedPod {
  name: string;
  namespace: string;
  cpu?: number;
  mem?: number;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  images?: string[];
  owner?: string;
}

export interface CustomWorkloadsResponse {
  customWorkloads?: CustomWorkloadRow[];
  unrecognized?: UnrecognizedRow[];
  unrecognizedPods?: Record<string, UnrecognizedPod[]>;
}

export interface CwOvertimePoint {
  timestamp: string;
  values: Record<string, number | null>;
  breakdown?: Record<string, { cpu?: number; mem?: number; gpu?: number }>;
}

export type CogGroupType =
  | 'annotationKey'
  | 'annotationKV'
  | 'envKey'
  | 'envKV'
  | 'image'
  | 'imageValue'
  | 'labelKey'
  | 'labelKV'
  | 'owner'
  | 'nodeSize'
  | 'containerName';

export interface CogRuleItem {
  type: CogGroupType;
  /** key for key/key-and-value kinds; owner kind / image regex / etc. otherwise */
  value: string;
  /** the value half for "key and value" kinds */
  kvValue?: string;
}

export interface CogFilterItem {
  type: 'excludeLabel' | 'excludeAnnotation';
  value: string;
}

export interface CogRule {
  grouping: CogRuleItem[];
  filters?: CogFilterItem[];
}

export interface CogSimGroup {
  name: string;
  namespaces?: string[];
  pods: number;
  cpu?: number;
  mem?: number;
  gpu?: number;
}
export interface CogSimResponse {
  matchedWorkloads?: number;
  matchedPods?: number;
  groups?: CogSimGroup[];
}
