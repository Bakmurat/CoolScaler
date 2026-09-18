// Local types + axis formatters for the Resources-analytics page.

export interface GraphPoint {
  timestamp: string;
  values: Record<string, number | null>;
}

export interface GraphResponse {
  values?: GraphPoint[];
}

export interface SingleResponse {
  value?: number;
  clusters?: string[];
}

export interface AutomationTrack {
  automated?: number;
  total?: number;
}

export type AutomationResponse = Record<string, AutomationTrack | undefined>;

export interface NetworkCostResponse {
  totals?: { ingressBps?: number; egressBps?: number; crossAzMonthlyCost?: number | null };
  namespaces?: { namespace: string; ingressBps?: number; egressBps?: number }[];
}

/** CPU axis values are cores; memory values are bytes. */
export const coresAxis = (v: number) => (v >= 1 ? (+v).toFixed(1) : Math.round(v * 1000) + 'm');
export const bytesAxis = (v: number) => {
  const g = v / 2 ** 30;
  return g >= 1 ? g.toFixed(0) + 'Gi' : Math.round(v / 2 ** 20) + 'Mi';
};
export const intAxis = (v: number) => String(Math.round(v));
export const dollarAxis = (v: number) => '$' + (v >= 1000 ? (v / 1000).toFixed(1) + 'k' : Math.round(v));

/** TIME_FMT port. */
export const timeFmtA = (iso: string) => {
  const d = new Date(iso);
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

/** Automation tracks shown in the "Automation (avg.)" row (label, key, svg path). */
export const AN_AUTO_TRACKS: [string, string, string][] = [
  ['Rightsizing', 'rightsizing', 'M3 12h4l3-8 4 16 3-8h4'],
  ['Pod Placement', 'podPlacement', 'M4 4h7v7H4zM13 13h7v7h-7z'],
  ['Pod Scheduling', 'podScheduling', 'M12 3v18M3 12h18'],
  ['Replicas Optimization', 'replicas', 'M4 4h11v11H4zM9 9h11v11H9z'],
  ['Automated Fractional GPUs', 'gpuRightsizing', 'M5 7h14v10H5zM9 11v2M12 11v2M15 11v2'],
  ['Spot Optimization', 'spotOptimization', 'M13 2L4 14h6l-1 8 9-12h-6z'],
];

export type AnalyticsRange = '6h' | '24h' | '7d' | '30d';
