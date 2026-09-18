// Time-series "Resource graphs" for the Replicas Optimization page
import { Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { cpuAxisFmt, memAxisFmt } from './AllocReqChart';
import type { RoReplicasPoint, RoResourcePoint } from './types';

const C = {
  optimized: '#22c55e',
  current: '#f43f5e',
  request: '#eab308',
  waste: '#f472b6',
  original: '#f43f5e',
  originalRequest: '#e75480',
  totalRequest: '#94a3b8',
  allocatable: '#fb923c',
};

const RANGE_MS: Record<'7d' | '30d', number> = { '7d': 7 * 864e5, '30d': 30 * 864e5 };

function clipRange<T extends { ts: number }>(pts: T[], range: '7d' | '30d'): T[] {
  if (!pts.length) return pts;
  // backend timestamps may be seconds or milliseconds — normalize to ms first
  const norm = pts.map((p) => (p.ts > 1e12 ? p : { ...p, ts: p.ts * 1000 }));
  const cutoff = norm[norm.length - 1].ts - RANGE_MS[range];
  return norm.filter((p) => p.ts >= cutoff);
}

const tooltipStyle = { borderRadius: 8, border: '1px solid #e9eaf0', fontSize: 11 };

function tsLabel(ts: number): string {
  return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function ReplicasOverTimeChart({
  points,
  range,
  height = 160,
}: {
  points: RoReplicasPoint[];
  range: '7d' | '30d';
  height?: number;
}) {
  const data = clipRange(points, range).map((p) => ({ ...p, label: tsLabel(p.ts) }));
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <XAxis dataKey="label" tick={{ fontSize: 9, fill: '#aab' }} tickLine={false} axisLine={false} minTickGap={60} />
          <YAxis tick={{ fontSize: 9, fill: '#aab' }} allowDecimals={false} tickLine={false} axisLine={false} width={28} />
          <Tooltip contentStyle={tooltipStyle} labelStyle={{ fontSize: 11 }} itemStyle={{ fontSize: 11, padding: 0 }} />
          <Legend verticalAlign="bottom" wrapperStyle={{ fontSize: 10, paddingTop: 2 }} iconSize={10} iconType="plainline" />
          <Line type="stepAfter" dataKey="optimized" name="Optimized replicas" stroke={C.optimized} strokeWidth={1.6} dot={false} isAnimationActive={false} connectNulls />
          <Line type="stepAfter" dataKey="current" name="Current replicas" stroke={C.current} strokeWidth={1.6} dot={false} isAnimationActive={false} connectNulls />
          <Line type="stepAfter" dataKey="waste" name="Waste" stroke={C.waste} strokeWidth={1.4} strokeDasharray="4 3" dot={false} isAnimationActive={false} connectNulls />
          <Line type="stepAfter" dataKey="original" name="Original replicas" stroke={C.totalRequest} strokeWidth={1.4} dot={false} isAnimationActive={false} connectNulls />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function ResourceOverTimeChart({
  points,
  resource,
  range,
  additionalMetrics,
  height = 160,
}: {
  points: RoResourcePoint[];
  resource: 'cpu' | 'memory';
  range: '7d' | '30d';
  /** when ON, the totalRequest + allocatable series are shown */
  additionalMetrics: boolean;
  height?: number;
}) {
  const fmt = resource === 'cpu' ? cpuAxisFmt : memAxisFmt;
  const data = clipRange(points, range).map((p) => ({ ...p, label: tsLabel(p.ts) }));
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <XAxis dataKey="label" tick={{ fontSize: 9, fill: '#aab' }} tickLine={false} axisLine={false} minTickGap={60} />
          <YAxis tick={{ fontSize: 9, fill: '#aab' }} tickFormatter={fmt} tickLine={false} axisLine={false} width={48} />
          <Tooltip
            formatter={(v: unknown, name: unknown) => [typeof v === 'number' ? fmt(v) : '—', String(name)] as [string, string]}
            contentStyle={tooltipStyle}
            labelStyle={{ fontSize: 11 }}
            itemStyle={{ fontSize: 11, padding: 0 }}
          />
          <Legend verticalAlign="bottom" wrapperStyle={{ fontSize: 10, paddingTop: 2 }} iconSize={10} iconType="plainline" />
          <Line type="monotone" dataKey="optimized" name="Optimized request" stroke={C.optimized} strokeWidth={1.6} dot={false} isAnimationActive={false} connectNulls />
          <Line type="monotone" dataKey="request" name="Request" stroke={C.request} strokeWidth={1.6} dot={false} isAnimationActive={false} connectNulls />
          <Line type="monotone" dataKey="waste" name="Waste" stroke={C.waste} strokeWidth={1.4} strokeDasharray="4 3" dot={false} isAnimationActive={false} connectNulls />
          {additionalMetrics && (
            <Line type="monotone" dataKey="totalRequest" name="Total request" stroke={C.totalRequest} strokeWidth={1.4} dot={false} isAnimationActive={false} connectNulls />
          )}
          <Line type="monotone" dataKey="originalRequest" name="Original request" stroke={C.originalRequest} strokeWidth={1.4} dot={false} isAnimationActive={false} connectNulls />
          {additionalMetrics && (
            <Line type="monotone" dataKey="allocatable" name="Allocatable" stroke={C.allocatable} strokeWidth={1.4} dot={false} isAnimationActive={false} connectNulls />
          )}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
