// Node Management charts
import { useEffect, useState } from 'react';
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { getJson } from '../../api/client';
import { timeFmt } from '../rightsizing/lib';
import type { GraphResponse, PlacementTotalsResponse } from './types';

export const coresAxis = (v: number) => (v >= 1 ? (+v).toFixed(1) : Math.round(v * 1000) + 'm');
export const bytesAxis = (v: number) => {
  const g = v / 2 ** 30;
  return g >= 1 ? g.toFixed(0) + 'Gi' : Math.round(v / 2 ** 20) + 'Mi';
};
const dollar = (v: number) => '$' + Math.round(v);

const tooltipProps = {
  labelStyle: { fontSize: 11 },
  itemStyle: { fontSize: 11, padding: 0 },
  contentStyle: { borderRadius: 8, border: '1px solid #e9eaf0', fontSize: 11 },
} as const;

/** Cluster node cost over time — /api/analytics/graph types=nodeCost. */
export function NdCostChart({ range, tick }: { range: '6h' | '24h' | '7d'; tick: number }) {
  const [values, setValues] = useState<GraphResponse['values']>([]);
  useEffect(() => {
    let dead = false;
    const grp = range === '7d' ? 'hour' : '15m';
    getJson<GraphResponse>('/api/analytics/graph?range=' + range + '&groupBy=' + grp + '&types=nodeCost')
      .then((g) => {
        if (!dead) setValues(g.values || []);
      })
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [range, tick]);
  const data = (values || []).map((p) => ({
    label: timeFmt(p.timestamp),
    nodeCost: p.values?.nodeCost ?? null,
  }));
  return (
    <div style={{ height: 192 }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="#f0f1f6" vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 9, fill: '#aab' }} tickLine={false} axisLine={false} minTickGap={80} />
          <YAxis tick={{ fontSize: 9, fill: '#aab' }} tickFormatter={dollar} tickLine={false} axisLine={false} width={44} />
          <Tooltip
            {...tooltipProps}
            formatter={(v: unknown) => [typeof v === 'number' ? dollar(v) : '—', 'Node cost ($/mo)'] as [string, string]}
          />
          <Area
            type="monotone"
            dataKey="nodeCost"
            stroke="#6366f1"
            strokeWidth={1.8}
            fill="rgba(99,102,241,.12)"
            dot={false}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

/* Blocked nodes by actions */
export function NdBlockedChart({ tick }: { tick: number }) {
  const [counts, setCounts] = useState<[number, number]>([0, 0]);
  useEffect(() => {
    let dead = false;
    const empty: PlacementTotalsResponse = { totals: {} };
    Promise.all([
      getJson<PlacementTotalsResponse>('/api/placement').catch(() => empty),
      getJson<PlacementTotalsResponse>('/api/scheduling').catch(() => empty),
    ]).then(([pp, sc]) => {
      if (!dead) setCounts([pp.totals?.blockedNodes || 0, sc.totals?.blockedNodes || 0]);
    });
    return () => {
      dead = true;
    };
  }, [tick]);
  const data = [
    { name: 'Optimize Unevictable Pods', value: counts[0], fill: '#7c3aed' },
    { name: 'Change Cluster Auto Scaler Configuration', value: 0, fill: '#f59e0b' },
    { name: 'Explore Scheduling Reasons', value: counts[1], fill: '#6dd3cd' },
    { name: 'Explore Node Restriction', value: 0, fill: '#f43f5e' },
  ];
  return (
    <div style={{ height: 220 }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 0 }} barCategoryGap="28%">
          <CartesianGrid stroke="#f0f1f6" vertical={false} />
          <XAxis
            dataKey="name"
            interval={0}
            tick={{ fontSize: 10, fill: '#8a93a8' }}
            tickLine={false}
            axisLine={{ stroke: '#e2e5ef' }}
          />
          <YAxis
            type="number"
            allowDecimals={false}
            domain={[0, (dataMax: number) => Math.max(2, Math.ceil(dataMax))]}
            tick={{ fontSize: 9, fill: '#aab' }}
            tickLine={false}
            axisLine={false}
            width={32}
          />
          <Tooltip
            {...tooltipProps}
            cursor={{ fill: 'rgba(148,163,184,.08)' }}
            formatter={(v: unknown) => [(v as number) + ' node' + (v === 1 ? '' : 's'), ''] as [string, string]}
          />
          <Bar dataKey="value" maxBarSize={260} isAnimationActive={false}>
            {data.map((d) => (
              <Cell key={d.name} fill={d.fill} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export const RES_LEGEND: [string, string][] = [
  ['#9aa3c0', 'Total usage'],
  ['#f59e0b', 'Total request'],
  ['#f6a45c', 'Allocatable'],
  ['#f9c4cd', 'Waste (alloc − request)'],
];

export function ResLegend() {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', columnGap: 16, rowGap: 4, fontSize: 11, color: '#64748b', marginBottom: 8 }}>
      {RES_LEGEND.map(([c, t]) => (
        <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ height: 8, width: 12, borderRadius: 2, background: c, display: 'inline-block' }} />
          {t}
        </span>
      ))}
    </div>
  );
}

export function useNodesGraph(range: '7d' | '30d', tick: number) {
  const [values, setValues] = useState<GraphResponse['values']>([]);
  useEffect(() => {
    let dead = false;
    const grp = range === '30d' ? 'day' : 'hour';
    getJson<GraphResponse>('/api/nodes/graph?range=' + range + '&groupBy=' + grp)
      .then((g) => {
        if (!dead) setValues(g.values || []);
      })
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [range, tick]);
  return values;
}

const RES_NAMES: Record<string, string> = {
  use: 'Total usage',
  req: 'Total request',
  alloc: 'Allocatable',
  waste: 'Waste (unrequested)',
};

/** Resources over time — allocatable vs request vs usage + waste band. */
export function NdResChart({
  values,
  resource,
}: {
  values: GraphResponse['values'];
  resource: 'cpu' | 'memory';
}) {
  const fmt = resource === 'cpu' ? coresAxis : bytesAxis;
  const aK = resource === 'cpu' ? 'cpuAllocatable' : 'memoryAllocatable';
  const rK = resource === 'cpu' ? 'cpuRequests' : 'memoryRequests';
  const uK = resource === 'cpu' ? 'cpuUsageTotal' : 'memoryUsageTotal';
  const data = (values || []).map((p) => {
    const a = p.values?.[aK] ?? null;
    const r = p.values?.[rK] ?? null;
    return {
      label: timeFmt(p.timestamp),
      use: p.values?.[uK] ?? null,
      req: r,
      alloc: a,
      waste: a != null && r != null ? Math.max(0, a - r) : null,
    };
  });
  return (
    <div style={{ height: 224 }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="#f0f1f6" vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 9, fill: '#aab' }} tickLine={false} axisLine={false} minTickGap={70} />
          <YAxis tick={{ fontSize: 9, fill: '#aab' }} tickFormatter={fmt} tickLine={false} axisLine={false} width={48} />
          <Tooltip
            {...tooltipProps}
            formatter={(v: unknown, name: unknown) =>
              [typeof v === 'number' ? fmt(v) : '—', RES_NAMES[String(name)] || String(name)] as [string, string]
            }
          />
          <Area type="monotone" dataKey="waste" stroke="transparent" fill="rgba(244,63,94,.10)" dot={false} isAnimationActive={false} />
          <Area
            type="monotone"
            dataKey="use"
            stroke="#9aa3c0"
            strokeWidth={1.6}
            fill="rgba(154,163,192,.16)"
            dot={false}
            isAnimationActive={false}
          />
          <Line type="monotone" dataKey="req" stroke="#f59e0b" strokeWidth={1.6} dot={false} isAnimationActive={false} />
          <Line type="monotone" dataKey="alloc" stroke="#f6a45c" strokeWidth={1.6} dot={false} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
