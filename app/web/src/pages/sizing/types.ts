// Local response types for the Sizing page (qos sub-shape of /api/workloads
// containers — not in the shared api/types.ts on purpose, per porting rules).

export interface QosLevel {
  cpuReq: number;
  cpuLim: number;
  memReq: number;
  memLim: number;
}

export interface SizingContainer {
  name: string;
  excluded?: boolean;
  reqCpu?: number | null;
  reqMem?: number | null;
  qos?: {
    guaranteed?: QosLevel;
    burstable?: QosLevel;
  };
}

export interface SizingWorkload {
  key: string;
  namespace: string;
  kind: string;
  name: string;
  replicas?: number;
  monthlyCost?: number;
  savings: number;
  sizable: boolean;
  containers?: SizingContainer[];
}
