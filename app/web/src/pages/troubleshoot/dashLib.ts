// Analytics-dashboards local types + chart catalog + time ranges + tolerant
// normalizer for the (new) GET /api/dashboards/data payload.

export type ChartKind = 'timeseries' | 'multiline' | 'events';
export type ChartUnit = 'pct' | 'int' | 'cores' | 'bytes' | 'usd';

export interface ChartDef {
  id: string;
  title: string;
  kind: ChartKind;
  category: string;
  sorted?: boolean;
  /** info-icon tooltip */
  info?: string;
  /** static legend row under the chart */
  legend?: [string, string][];
  /** y axis unit */
  unit?: ChartUnit;
}

// Catalog IDs are kebab-case and MUST match the backend dashChartCatalog in
// internal/engine/dashboards.go
export const CHART_CATALOG: ChartDef[] = [
  // ---- Optimization ----
  { id: 'automation-events', title: 'Automation Events', kind: 'events', unit: 'int', category: 'Optimization' },
  { id: 'optimized-pods', title: 'Optimized Pods', kind: 'multiline', unit: 'int', category: 'Optimization', info: 'Pods with automation vs total pods' },
  { id: 'automated-workloads', title: 'Automated Workloads', kind: 'multiline', unit: 'int', category: 'Optimization', info: 'Workloads with automation vs total workloads' },
  { id: 'downscaled-workloads', title: 'Downscaled Workloads', kind: 'timeseries', unit: 'int', category: 'Optimization', info: 'Workloads right-sized down vs their original request' },
  // ---- Performance ----
  { id: 'cpu-underprovisioned-stressed', title: 'CPU Under Provisioned Workloads on Stressed Nodes', kind: 'timeseries', sorted: true, unit: 'int', category: 'Performance', info: 'Workloads whose CPU request is below the recommendation while running on a stressed node' },
  { id: 'memory-underprovisioned-stressed', title: 'Memory Under Provisioned Workloads on Stressed Nodes', kind: 'timeseries', sorted: true, unit: 'int', category: 'Performance', info: 'Workloads whose memory request is below the recommendation while running on a stressed node' },
  { id: 'workload-disruptions', title: 'Workload Disruptions', kind: 'events', unit: 'int', category: 'Performance', info: 'Evictions / disruptions affecting workloads' },
  { id: 'oom-events', title: 'Out-of-Memory Events', kind: 'events', unit: 'int', category: 'Performance' },
  { id: 'downtime-events', title: 'Downtime Events', kind: 'timeseries', unit: 'int', category: 'Performance', info: 'Workloads with unavailable replicas over time' },
  { id: 'cpu-throttling', title: 'CPU Throttling', kind: 'timeseries', unit: 'pct', category: 'Performance' },
  { id: 'liveness-probe-failures', title: 'Liveness Probe Failures', kind: 'timeseries', unit: 'int', category: 'Performance' },
  { id: 'container-restarts', title: 'Container Restarts', kind: 'timeseries', unit: 'int', category: 'Performance' },
  { id: 'cpu-requests-by-type', title: 'CPU Requests by Workload Type', kind: 'multiline', unit: 'cores', category: 'Performance' },
  { id: 'memory-requests-by-type', title: 'Memory Requests by Workload Type', kind: 'multiline', unit: 'bytes', category: 'Performance' },
  { id: 'most-disruptive-workloads', title: 'Most Disruptive Workloads', kind: 'multiline', sorted: true, unit: 'int', category: 'Performance', info: 'Top workloads by disruption count' },
  { id: 'node-disruptions', title: 'Node Disruptions', kind: 'timeseries', unit: 'int', category: 'Performance', info: 'Node Ready-condition transitions' },
  { id: 'healing-statuses', title: 'CoolScaler Healing Statuses', kind: 'multiline', unit: 'int', category: 'Performance', info: 'Auto-healing + burst-reaction workloads over time' },
  // ---- Replicas ----
  { id: 'pod-count', title: 'Pod Count', kind: 'timeseries', unit: 'int', category: 'Replicas' },
  { id: 'hpa-current-replicas', title: 'HPA Scale Events', kind: 'multiline', unit: 'int', category: 'Replicas', info: 'Current replicas per HorizontalPodAutoscaler' },
  { id: 'hpa-trigger-change', title: 'HPA Resource Trigger Change Events', kind: 'multiline', unit: 'int', category: 'Replicas', info: 'HPA target-metric value per HPA' },
  { id: 'replicas-increase', title: 'Replicas Increase', kind: 'timeseries', unit: 'int', category: 'Replicas', info: 'HPAs that scaled up over time' },
  // ---- Cost ----
  { id: 'cpu-allocatable', title: 'CPU Allocatable', kind: 'timeseries', unit: 'cores', category: 'Cost' },
  { id: 'memory-allocatable', title: 'Memory Allocatable', kind: 'timeseries', unit: 'bytes', category: 'Cost' },
  { id: 'cluster-cpu', title: 'CPU Usage vs Request', kind: 'multiline', unit: 'cores', category: 'Cost' },
  { id: 'cluster-memory', title: 'Memory Usage vs Request', kind: 'multiline', unit: 'bytes', category: 'Cost' },
  { id: 'wasted-cpu', title: 'Wasted CPU', kind: 'timeseries', unit: 'cores', category: 'Cost', info: 'Requested minus used CPU' },
  { id: 'wasted-memory', title: 'Wasted Memory', kind: 'timeseries', unit: 'bytes', category: 'Cost', info: 'Requested minus used memory' },
  { id: 'init-cpu-overhead', title: 'Init Container CPU Request Overhead', kind: 'timeseries', unit: 'cores', category: 'Cost' },
  { id: 'init-memory-overhead', title: 'Init Container Memory Request Overhead', kind: 'timeseries', unit: 'bytes', category: 'Cost' },
  { id: 'expensive', title: 'Expensive', kind: 'multiline', sorted: true, unit: 'usd', category: 'Cost', info: 'Top workloads by monthly cost' },
  { id: 'wasteful', title: 'Wasteful', kind: 'multiline', sorted: true, unit: 'usd', category: 'Cost', info: 'Top workloads by reclaimable monthly savings' },
  { id: 'cpu-request-increase', title: 'CPU Request Increase', kind: 'timeseries', unit: 'int', category: 'Cost', info: 'Workloads whose CPU request grew' },
  { id: 'memory-request-increase', title: 'Memory Request Increase', kind: 'timeseries', unit: 'int', category: 'Cost', info: 'Workloads whose memory request grew' },
  // ---- Nodes ----
  { id: 'node-cpu-utilization', title: 'Node CPU Utilization', kind: 'multiline', sorted: true, unit: 'pct', category: 'Nodes' },
  { id: 'node-memory-utilization', title: 'Node Memory Utilization', kind: 'multiline', sorted: true, unit: 'pct', category: 'Nodes' },
  { id: 'pods-per-node', title: 'Pods per Node', kind: 'multiline', unit: 'int', category: 'Nodes' },
  { id: 'node-avg-load', title: 'Node Average Load', kind: 'multiline', unit: 'int', category: 'Nodes', info: '1-minute load average per node (netmon /proc/loadavg)' },
  { id: 'node-cpu-allocation', title: 'Node CPU Allocation', kind: 'multiline', unit: 'cores', category: 'Nodes', info: 'CPU requested per node' },
  { id: 'node-memory-allocation', title: 'Node Memory Allocation', kind: 'multiline', unit: 'bytes', category: 'Nodes', info: 'Memory requested per node' },
  { id: 'node-eph-utilization', title: 'Node Ephemeral Storage Utilization', kind: 'multiline', unit: 'pct', category: 'Nodes' },
  { id: 'node-eph-allocation', title: 'Node Ephemeral Storage Allocation', kind: 'multiline', unit: 'bytes', category: 'Nodes' },
  { id: 'node-conditions', title: 'Node Conditions', kind: 'multiline', unit: 'int', category: 'Nodes', info: 'Nodes per condition (Ready/MemoryPressure/…)' },
  { id: 'node-instance-type', title: 'Node Instance Type', kind: 'multiline', unit: 'int', category: 'Nodes' },
  { id: 'node-lifecycle', title: 'Node Life Cycle', kind: 'multiline', unit: 'int', category: 'Nodes', info: 'Nodes per lifecycle (spot/on-demand)' },
  { id: 'node-not-scaling-down', title: 'Node not Scaling Down Reason', kind: 'timeseries', unit: 'int', category: 'Nodes', info: 'Nodes pinned from scale-down by unevictable pods' },
  { id: 'node-blocked-cpu', title: 'Node Allocatable CPU Blocked by Reason', kind: 'timeseries', unit: 'cores', category: 'Nodes' },
  { id: 'node-blocked-memory', title: 'Node Allocatable Memory Blocked by Reason', kind: 'timeseries', unit: 'bytes', category: 'Nodes' },
  // ---- CoolScaler Workloads ----
  { id: 'coolscaler-cpu-usage', title: 'CoolScaler CPU Usage', kind: 'multiline', unit: 'cores', category: 'CoolScaler Workloads' },
  { id: 'coolscaler-memory-usage', title: 'CoolScaler Memory Usage', kind: 'multiline', unit: 'bytes', category: 'CoolScaler Workloads' },
  { id: 'coolscaler-cpu-requests', title: 'CoolScaler CPU Requests', kind: 'timeseries', unit: 'cores', category: 'CoolScaler Workloads' },
  { id: 'coolscaler-memory-requests', title: 'CoolScaler Memory Requests', kind: 'timeseries', unit: 'bytes', category: 'CoolScaler Workloads' },
  { id: 'prometheus-tsdb-size', title: 'CoolScaler Prometheus Volume', kind: 'timeseries', unit: 'bytes', category: 'CoolScaler Workloads' },
  { id: 'prometheus-retention', title: 'CoolScaler Prometheus Retention', kind: 'timeseries', unit: 'int', category: 'CoolScaler Workloads', info: 'Days of history retained' },
  // ---- Pressure Stall (PSI) ----
  { id: 'psi-cpu', title: 'Node CPU Wait Time (%)', kind: 'multiline', unit: 'pct', category: 'Pressure Stall (PSI)', info: 'PSI: % of time tasks waited on CPU' },
  { id: 'psi-memory', title: 'Node Memory Wait Time (%)', kind: 'multiline', unit: 'pct', category: 'Pressure Stall (PSI)', info: 'PSI: % of time tasks waited on memory' },
  { id: 'psi-io', title: 'Node Disk I/O Wait Time (%)', kind: 'multiline', unit: 'pct', category: 'Pressure Stall (PSI)', info: 'PSI: % of time tasks waited on disk I/O' },
  // ---- Resource Quotas ----
  { id: 'quota-cpu-requests', title: 'Namespace Limitation by CPU Requests', kind: 'multiline', unit: 'pct', category: 'Resource Quotas', info: 'Used vs hard requests.cpu quota per namespace' },
  { id: 'quota-memory-requests', title: 'Namespace Limitation by Memory Requests', kind: 'multiline', unit: 'pct', category: 'Resource Quotas', info: 'Used vs hard requests.memory quota per namespace' },
  { id: 'quota-cpu-limits', title: 'Namespace Limitation by CPU Limits', kind: 'multiline', unit: 'pct', category: 'Resource Quotas' },
  { id: 'quota-memory-limits', title: 'Namespace Limitation by Memory Limits', kind: 'multiline', unit: 'pct', category: 'Resource Quotas' },
  { id: 'quota-pods', title: 'Namespace Limitation by Pods', kind: 'multiline', unit: 'pct', category: 'Resource Quotas' },
  { id: 'quota-replicasets', title: 'Namespace Limitation by Replica Sets', kind: 'multiline', unit: 'pct', category: 'Resource Quotas' },
  // ---- Node I/O ----
  { id: 'node-network-throughput', title: 'Node Network Throughput', kind: 'multiline', unit: 'bytes', category: 'Node I/O', info: 'Receive + transmit bytes/s per node' },
  { id: 'node-network-throughput-agg', title: 'Node Network Throughput (Aggregated)', kind: 'multiline', unit: 'bytes', category: 'Node I/O', info: 'Average / p90 / max across nodes' },
  { id: 'node-dropped-packets', title: 'Total Network Dropped Packets per Node', kind: 'multiline', unit: 'int', category: 'Node I/O' },
  { id: 'node-disk-throughput', title: 'Node Disk Throughput', kind: 'multiline', unit: 'bytes', category: 'Node I/O', info: 'Read + write bytes/s per node' },
  { id: 'node-disk-throughput-agg', title: 'Node Disk Throughput (Aggregated)', kind: 'multiline', unit: 'bytes', category: 'Node I/O', info: 'Average / p90 / max across nodes' },
  { id: 'node-disk-iops', title: 'Node Disk IOPS', kind: 'multiline', unit: 'int', category: 'Node I/O' },
  { id: 'node-disk-iops-agg', title: 'Node Disk IOPS (Aggregated)', kind: 'multiline', unit: 'int', category: 'Node I/O', info: 'Average / p90 / max across nodes' },
  // ---- late additions ----
  { id: 'update-evictions', title: 'CoolScaler Update Evictions', kind: 'multiline', unit: 'int', category: 'Optimization', info: 'Updater-triggered optimizations by type' },
  { id: 'oom-limit-events', title: 'Out-of-Memory Limit Events', kind: 'events', unit: 'int', category: 'Performance', info: 'OOMKills caused by container limits' },
  { id: 'oom-node-events', title: 'Out-of-Memory Node Events', kind: 'events', unit: 'int', category: 'Performance', info: 'Evictions caused by node memory pressure' },
  { id: 'cpu-underprovisioned', title: 'CPU Under Provisioned', kind: 'timeseries', unit: 'int', category: 'Performance', info: 'Workloads whose CPU recommendation exceeds their request' },
  { id: 'memory-underprovisioned', title: 'Memory Under Provisioned', kind: 'timeseries', unit: 'int', category: 'Performance', info: 'Workloads whose memory recommendation exceeds their request' },
  { id: 'container-exit-codes', title: 'Container Exit Codes', kind: 'multiline', unit: 'int', category: 'Performance', info: 'Containers by last-terminated exit code (non-zero)' },
  { id: 'workloads-issues', title: 'CoolScaler Workloads Issues', kind: 'timeseries', unit: 'int', category: 'CoolScaler Workloads', info: 'Count of failing CoolScaler health checks' },
  { id: 'version', title: 'Version', kind: 'multiline', unit: 'int', category: 'CoolScaler Workloads', info: 'Running CoolScaler version over time' },
  { id: 'smart-policy-waste', title: 'Smart Policy Waste', kind: 'timeseries', unit: 'usd', category: 'Cost', info: 'Reclaimable $/mo on workloads not under automation' },
];

/** Category display order for the grouped Charts picker. */
export const CHART_CATEGORIES = [
  'Optimization',
  'Performance',
  'Replicas',
  'Cost',
  'Nodes',
  'CoolScaler Workloads',
  'Pressure Stall (PSI)',
  'Resource Quotas',
  'Node I/O',
];

export const PERFORMANCE_CHARTS = [
  'node-cpu-utilization',
  'node-memory-utilization',
  'automation-events',
  'workload-disruptions',
  'oom-events',
  'downtime-events',
  'cpu-underprovisioned-stressed',
  'memory-underprovisioned-stressed',
  'cpu-throttling',
];

/* Built-in dashboards (fallback when /api/dashboards is unreachable */
export const BUILTIN_DASHBOARDS: { name: string; charts: string[] }[] = [
  { name: 'Performance', charts: PERFORMANCE_CHARTS },
  { name: 'Overall Costs', charts: ['cpu-allocatable', 'memory-allocatable', 'cluster-cpu', 'cluster-memory', 'wasted-cpu', 'wasted-memory', 'init-cpu-overhead', 'init-memory-overhead'] },
  { name: 'CoolScaler Health', charts: ['coolscaler-cpu-usage', 'coolscaler-memory-usage', 'coolscaler-cpu-requests', 'coolscaler-memory-requests', 'prometheus-tsdb-size', 'pod-count', 'optimized-pods', 'automated-workloads'] },
  { name: 'Advanced Performance', charts: ['psi-cpu', 'psi-memory', 'psi-io', 'pods-per-node', 'node-network-throughput', 'node-disk-throughput', 'node-disk-iops', 'node-dropped-packets'] },
];

export const chartDef = (id: string): ChartDef | undefined => CHART_CATALOG.find((c) => c.id === id);

// ---- time ranges ----
export interface TimeRange {
  key: string;
  label: string;
  ms: number;
  /** nearest range supported by the legacy /api/analytics/graph fallback */
  fallbackRange: '6h' | '24h' | '7d' | '30d';
  groupBy: 'hour' | 'day';
}

export const TIME_RANGES: TimeRange[] = [
  { key: '1h', label: 'Last 1 hour', ms: 3600e3, fallbackRange: '6h', groupBy: 'hour' },
  { key: '6h', label: 'Last 6 hours', ms: 6 * 3600e3, fallbackRange: '6h', groupBy: 'hour' },
  { key: '24h', label: 'Last 24 hours', ms: 24 * 3600e3, fallbackRange: '24h', groupBy: 'hour' },
  { key: '3d', label: 'Last 3 days', ms: 3 * 86400e3, fallbackRange: '7d', groupBy: 'hour' },
  { key: '7d', label: 'Last 7 days', ms: 7 * 86400e3, fallbackRange: '7d', groupBy: 'hour' },
  { key: '2w', label: 'Last 2 weeks', ms: 14 * 86400e3, fallbackRange: '30d', groupBy: 'day' },
];

export const rangeByKey = (k: string): TimeRange => TIME_RANGES.find((r) => r.key === k) || TIME_RANGES[3];

// ---- normalized chart data ----
export interface DashPoint {
  t: number; // epoch ms
  v: number | null;
}
export interface DashSeries {
  name: string;
  points: DashPoint[];
}
export interface DashChartData {
  series: DashSeries[];
}

/* Per-node line palette (cycled) */
export const LINE_PALETTE = [
  '#4338ca',
  '#f97316',
  '#0ea5e9',
  '#ec4899',
  '#16a34a',
  '#8b5cf6',
  '#f43f5e',
  '#eab308',
  '#14b8a6',
  '#64748b',
  '#a855f7',
  '#22c55e',
];

const toMs = (x: unknown): number | null => {
  if (typeof x === 'number') return x > 1e12 ? x : x * 1000; // sec vs ms
  if (typeof x === 'string') {
    const t = Date.parse(x);
    return Number.isNaN(t) ? null : t;
  }
  return null;
};

const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);

type Rec = Record<string, unknown>;
const isRec = (x: unknown): x is Rec => typeof x === 'object' && x != null && !Array.isArray(x);

/**
 * Tolerant normalizer for one chart's payload from GET /api/dashboards/data.
 * Accepts any of:
 *  - { series: [{ name, points: [[ts, v],...] }] }
 *  - { series: [{ name, values: [{ timestamp, value }] }] }
 *  - { values: [{ timestamp, values: { key: v,... } }] }   (analytics-graph shape)
 */
export function normalizeChartData(raw: unknown): DashChartData | null {
  if (!isRec(raw)) return null;
  if (Array.isArray(raw.series)) {
    const series: DashSeries[] = [];
    for (const s of raw.series) {
      if (!isRec(s)) continue;
      const name = typeof s.name === 'string' ? s.name : typeof s.label === 'string' ? s.label : '';
      const pts: DashPoint[] = [];
      if (Array.isArray(s.points)) {
        for (const p of s.points) {
          if (Array.isArray(p) && p.length >= 2) {
            const t = toMs(p[0]);
            if (t != null) pts.push({ t, v: num(p[1]) });
          } else if (isRec(p)) {
            const t = toMs(p.t ?? p.timestamp);
            if (t != null) pts.push({ t, v: num(p.v ?? p.value) });
          }
        }
      } else if (Array.isArray(s.values)) {
        for (const p of s.values) {
          if (!isRec(p)) continue;
          const t = toMs(p.timestamp ?? p.t);
          if (t != null) pts.push({ t, v: num(p.value ?? p.v) });
        }
      }
      series.push({ name, points: pts.sort((a, b) => a.t - b.t) });
    }
    return { series };
  }
  if (Array.isArray(raw.values)) {
    // keyed graph shape: one series per key
    const byKey: Record<string, DashPoint[]> = {};
    for (const p of raw.values) {
      if (!isRec(p)) continue;
      const t = toMs(p.timestamp);
      if (t == null || !isRec(p.values)) continue;
      for (const [k, v] of Object.entries(p.values)) {
        (byKey[k] = byKey[k] || []).push({ t, v: num(v) });
      }
    }
    return { series: Object.entries(byKey).map(([name, points]) => ({ name, points: points.sort((a, b) => a.t - b.t) })) };
  }
  return null;
}

/* Short tick label for an epoch-ms x axis. */
export const tickFmt = (t: number) =>
  new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export const pctAxis = (v: number) => Math.round(v) + '%';
export const intAxisD = (v: number) => String(Math.round(v));
