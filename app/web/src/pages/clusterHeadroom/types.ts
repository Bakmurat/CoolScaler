// Cluster Headroom (v2) types

export interface HeadroomOverview {
  cpuHeadroom: number; // cores
  memoryHeadroom: number; // bytes
  gpuHeadroom: number;
  nodePoolsWithHeadroomPct: number; // 0..100
}

export interface HeadroomGraphPoint {
  ts: number; // unix seconds
  usage: number;
  request: number;
  headroom: number;
  allocatable: number;
}

export interface HeadroomGraphResponse {
  cpu: HeadroomGraphPoint[];
  memory: HeadroomGraphPoint[];
  gpu: HeadroomGraphPoint[];
}

export type HeadroomResourceType = 'static' | 'dynamic';

export interface HeadroomResource {
  type: HeadroomResourceType;
  value: number; // static = absolute, dynamic = percentage
}

export interface HeadroomToleration {
  key: string;
  operator: string;
  value: string;
  effect: string;
}

export interface HeadroomSchedulePeriod {
  startTime: string; // HH:MM
  endTime: string; // HH:MM
  days: number[]; // 0=Sun .. 6=Sat
}

export type HeadroomLifecycle = '' | 'spot' | 'onDemand';

export interface HeadroomConfig {
  name: string;
  cpu: HeadroomResource;
  memory: HeadroomResource;
  gpu: HeadroomResource;
  lifecycle: HeadroomLifecycle;
  nodePools: string[];
  schedule: HeadroomSchedulePeriod[] | null;
  tolerations: HeadroomToleration[];
  nodeSelector: Record<string, string>;
}

export interface HeadroomConfigsResponse {
  configurations: HeadroomConfig[];
}

/** A blank config for the Create drawer. */
export function blankHeadroomConfig(): HeadroomConfig {
  return {
    name: '',
    cpu: { type: 'static', value: 0 },
    memory: { type: 'static', value: 0 },
    gpu: { type: 'static', value: 0 },
    lifecycle: '',
    nodePools: [],
    schedule: null,
    tolerations: [],
    nodeSelector: {},
  };
}
