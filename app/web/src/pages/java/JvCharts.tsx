// "Java fleet resources over time" charts
import { useEffect, useState } from 'react';
import {
  Area,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { getJson } from '../../api/client';
import { timeFmt } from '../rightsizing/lib';
import type { JavaGraphResponse } from './types';

const coresAxis = (v: number) => (v >= 1 ? (+v).toFixed(1) : Math.round(v * 1000) + 'm');
const bytesAxis = (v: number) => {
  const g = v / 2 ** 30;
  return g >= 1 ? g.toFixed(0) + 'Gi' : Math.round(v / 2 ** 20) + 'Mi';
};

export interface LegendItem {
  key: string;
  color: string;
  label: string;
  /* info-style ⓘ tooltip */
  info?: string;
}

export const JV_MEM_SERIES: LegendItem[] = [
  { key: 'memOptimized', color: '#10b981', label: 'Optimized memory usage' },
  { key: 'memUsage', color: '#9aa3c0', label: 'Usage' },
  { key: 'waste', color: '#f43f5e', label: 'Waste' },
  { key: 'memRequest', color: '#f59e0b', label: 'Request' },
  {
    key: 'javaRealMem',
    color: '#0ea5e9',
    label: 'Java real memory usage',
    info: 'Real JVM memory usage (heap used + non-heap used), collected via the injected JMX agent.',
  },
  { key: 'jvmHeapUsed', color: '#6366f1', label: 'Heap used' },
  { key: 'jvmHeapCommitted', color: '#a5b4fc', label: 'Heap committed' },
  { key: 'jvmNonHeap', color: '#8b5cf6', label: 'Non-heap used' },
];
export const JV_CPU_SERIES: LegendItem[] = [
  { key: 'cpuRequest', color: '#f59e0b', label: 'CPU request' },
  { key: 'cpuUsage', color: '#9aa3c0', label: 'CPU usage' },
];

export function ChartLegend({
  items,
  hidden,
  onToggle,
}: {
  items: LegendItem[];
  hidden?: Set<string>;
  onToggle?: (key: string) => void;
}) {
  return (
    <>
      {items.map((it) => {
        const off = hidden?.has(it.key);
        return (
          <span
            key={it.key}
            onClick={onToggle ? () => onToggle(it.key) : undefined}
            title={onToggle ? (off ? 'Show series' : 'Hide series') : undefined}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              cursor: onToggle ? 'pointer' : undefined,
              userSelect: 'none',
              opacity: off ? 0.4 : 1,
              textDecoration: off ? 'line-through' : undefined,
            }}
          >
            <span style={{ height: 8, width: 12, borderRadius: 2, background: it.color, display: 'inline-block' }} />
            {it.label}
            {it.info && (
              <span title={it.info} style={{ color: '#94a3b8', cursor: 'help', marginLeft: 2 }}>
                ⓘ
              </span>
            )}
          </span>
        );
      })}
    </>
  );
}

interface Pt {
  label: string;
  memRequest: number | null;
  memUsage: number | null;
  memOptimized: number | null;
  waste: number | null;
  wasteBase: number | null;
  javaRealMem: number | null;
  jvmHeapUsed: number | null;
  jvmHeapCommitted: number | null;
  jvmNonHeap: number | null;
  cpuRequest: number | null;
  cpuUsage: number | null;
}

const MEM_NAMES: Record<string, string> = {
  memRequest: 'Request',
  memUsage: 'Usage',
  memOptimized: 'Optimized memory usage',
  waste: 'Waste',
  javaRealMem: 'Java real memory usage',
  jvmHeapUsed: 'Heap used',
  jvmHeapCommitted: 'Heap committed',
  jvmNonHeap: 'Non-heap used',
};
const CPU_NAMES: Record<string, string> = {
  cpuRequest: 'CPU request',
  cpuUsage: 'CPU usage',
};

export function useJavaGraph(range: '7d' | '30d', tick = 0) {
  const [series, setSeries] = useState<JavaGraphResponse['values']>([]);
  useEffect(() => {
    let dead = false;
    const grp = range === '30d' ? 'day' : 'hour';
    getJson<JavaGraphResponse>('/api/java/graph?range=' + range + '&groupBy=' + grp)
      .then((g) => {
        if (!dead) setSeries(g.values || []);
      })
      .catch(() => {
      });
    return () => {
      dead = true;
    };
  }, [range, tick]);
  return series;
}

function toPoints(series: JavaGraphResponse['values']): Pt[] {
  return (series || []).map((p) => {
    const v = p.values || {};
    // Optimized memory usage — feature-detected new backend series (several
    // candidate names); absent on the live backend → series stays empty.
    const opt = v.memOptimized ?? v.memRecommendation ?? v.memRec ?? null;
    const req = v.memRequest ?? null;
    // Waste band = request − optimized (only when both ends exist).
    const waste = opt != null && req != null ? Math.max(0, req - opt) : null;
    const heapUsed = v.jvmHeapUsed ?? null;
    const nonHeap = v.jvmNonHeap ?? null;
    return {
      label: timeFmt(p.timestamp),
      memRequest: req,
      memUsage: v.memUsage ?? null,
      memOptimized: opt,
      waste,
      wasteBase: waste != null ? opt : null,
      javaRealMem: heapUsed != null ? heapUsed + (nonHeap ?? 0) : null,
      jvmHeapUsed: v.jvmHeapUsed ?? null,
      jvmHeapCommitted: v.jvmHeapCommitted ?? null,
      jvmNonHeap: v.jvmNonHeap ?? null,
      cpuRequest: v.cpuRequest ?? null,
      cpuUsage: v.cpuUsage ?? null,
    };
  });
}

const tipProps = (fmt: (v: number) => string, names: Record<string, string>) => ({
  formatter: (v: unknown, name: unknown) =>
    [typeof v === 'number' ? fmt(v) : '—', names[String(name)] || String(name)] as [string, string],
  labelStyle: { fontSize: 11 },
  itemStyle: { fontSize: 11, padding: 0 },
  contentStyle: { borderRadius: 8, border: '1px solid #e9eaf0', fontSize: 11 },
});

const AXIS_TICK = { fontSize: 9, fill: '#aab' };
const NONE = new Set<string>();

export function JvMemChart({ series, hidden = NONE }: { series: JavaGraphResponse['values']; hidden?: Set<string> }) {
  const data = toPoints(series);
  const on = (k: string) => !hidden.has(k);
  return (
    <div style={{ height: 224 }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={false} minTickGap={40} />
          <YAxis tick={AXIS_TICK} tickFormatter={bytesAxis} tickLine={false} axisLine={false} width={48} />
          <Tooltip {...tipProps(bytesAxis, MEM_NAMES)} />
          {on('memUsage') && (
            <Area type="monotone" dataKey="memUsage" stroke="#9aa3c0" strokeWidth={1.6} fill="rgba(154,163,192,.16)" dot={false} isAnimationActive={false} connectNulls />
          )}
          {/* Waste band: transparent base up to Optimized, red band up to Request. */}
          {on('waste') && (
            <Area type="monotone" dataKey="wasteBase" stackId="waste" stroke="none" fill="transparent" dot={false} isAnimationActive={false} connectNulls tooltipType="none" />
          )}
          {on('waste') && (
            <Area type="monotone" dataKey="waste" stackId="waste" stroke="#f43f5e" strokeWidth={1} strokeDasharray="3 3" fill="rgba(244,63,94,.14)" dot={false} isAnimationActive={false} connectNulls />
          )}
          {on('memOptimized') && (
            <Line type="monotone" dataKey="memOptimized" stroke="#10b981" strokeWidth={1.8} dot={false} isAnimationActive={false} connectNulls />
          )}
          {on('memRequest') && (
            <Line type="monotone" dataKey="memRequest" stroke="#f59e0b" strokeWidth={1.6} dot={false} isAnimationActive={false} connectNulls />
          )}
          {on('javaRealMem') && (
            <Line type="monotone" dataKey="javaRealMem" stroke="#0ea5e9" strokeWidth={1.8} dot={false} isAnimationActive={false} connectNulls />
          )}
          {on('jvmHeapUsed') && (
            <Line type="monotone" dataKey="jvmHeapUsed" stroke="#6366f1" strokeWidth={1.6} dot={false} isAnimationActive={false} connectNulls />
          )}
          {on('jvmHeapCommitted') && (
            <Line type="monotone" dataKey="jvmHeapCommitted" stroke="#a5b4fc" strokeWidth={1.4} strokeDasharray="4 3" dot={false} isAnimationActive={false} connectNulls />
          )}
          {on('jvmNonHeap') && (
            <Line type="monotone" dataKey="jvmNonHeap" stroke="#8b5cf6" strokeWidth={1.4} dot={false} isAnimationActive={false} connectNulls />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

export function JvCpuChart({ series, hidden = NONE }: { series: JavaGraphResponse['values']; hidden?: Set<string> }) {
  const data = toPoints(series);
  const on = (k: string) => !hidden.has(k);
  return (
    <div style={{ height: 208 }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={false} minTickGap={40} />
          <YAxis tick={AXIS_TICK} tickFormatter={coresAxis} tickLine={false} axisLine={false} width={48} />
          <Tooltip {...tipProps(coresAxis, CPU_NAMES)} />
          {on('cpuUsage') && (
            <Area type="monotone" dataKey="cpuUsage" stroke="#9aa3c0" strokeWidth={1.6} fill="rgba(154,163,192,.16)" dot={false} isAnimationActive={false} connectNulls />
          )}
          {on('cpuRequest') && (
            <Line type="monotone" dataKey="cpuRequest" stroke="#f59e0b" strokeWidth={1.6} dot={false} isAnimationActive={false} connectNulls />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
