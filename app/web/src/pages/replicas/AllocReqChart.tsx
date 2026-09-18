// "CPU/Memory over time (allocatable vs requested)" chart used by the Replicas
// page and the Downscale tab
import { useEffect, useState } from 'react';
import { Area, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { getJson } from '../../api/client';
import { timeFmt } from '../rightsizing/lib';
import type { AnalyticsGraphResponse } from '../rightsizing/types';

export const cpuAxisFmt = (v: number) => (v >= 1 ? String(Math.round(v * 10) / 10) : Math.round(v * 1000) + 'm');
export const memAxisFmt = (v: number) => {
  const g = v / 2 ** 30;
  return g >= 1 ? Math.round(g * 10) / 10 + 'Gi' : Math.round(v / 2 ** 20) + 'Mi';
};

interface Pt {
  label: string;
  alloc: number | null;
  req: number | null;
}

export function useAllocReqSeries(range: '7d' | '30d') {
  const [values, setValues] = useState<AnalyticsGraphResponse['values']>([]);
  useEffect(() => {
    let dead = false;
    const grp = range === '30d' ? 'day' : 'hour';
    getJson<AnalyticsGraphResponse>(
      '/api/analytics/graph?range=' +
        range +
        '&groupBy=' +
        grp +
        '&types=cpuAllocatable&types=cpuRequests&types=memoryAllocatable&types=memoryRequests',
    )
      .then((g) => {
        if (!dead) setValues(g.values || []);
      })
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [range]);
  return values;
}

export default function AllocReqChart({
  values,
  resource,
  height = 160,
}: {
  values: AnalyticsGraphResponse['values'];
  resource: 'cpu' | 'memory';
  height?: number;
}) {
  const fmt = resource === 'cpu' ? cpuAxisFmt : memAxisFmt;
  const data: Pt[] = (values || []).map((p) => ({
    label: timeFmt(p.timestamp),
    alloc: p.values?.[resource + 'Allocatable'] ?? null,
    req: p.values?.[resource + 'Requests'] ?? null,
  }));
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <XAxis dataKey="label" tick={{ fontSize: 9, fill: '#aab' }} tickLine={false} axisLine={false} minTickGap={60} />
          <YAxis tick={{ fontSize: 9, fill: '#aab' }} tickFormatter={fmt} tickLine={false} axisLine={false} width={48} />
          <Tooltip
            formatter={(v: unknown, name: unknown) =>
              [typeof v === 'number' ? fmt(v) : '—', name === 'alloc' ? 'Allocatable' : 'Requested'] as [string, string]
            }
            labelStyle={{ fontSize: 11 }}
            itemStyle={{ fontSize: 11, padding: 0 }}
            contentStyle={{ borderRadius: 8, border: '1px solid #e9eaf0', fontSize: 11 }}
          />
          <Area type="monotone" dataKey="alloc" stroke="#f6a45c" strokeWidth={1.6} fill="rgba(246,164,92,.15)" dot={false} isAnimationActive={false} />
          <Line type="monotone" dataKey="req" stroke="#6366f1" strokeWidth={1.6} dot={false} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
