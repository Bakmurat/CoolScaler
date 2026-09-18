// Chart renderers for the Analytics-dashboards grid: per-node multi-line time
// series, event scatter (points on a time axis) and single/multi keyed lines —
// all on a numeric epoch-ms x axis so sparse event data lines up with dense
// utilization data.
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { LINE_PALETTE, tickFmt, type DashChartData } from './dashLib';

const AXIS_TICK = { fontSize: 10, fill: '#94a3b8' };
const GRID = { stroke: '#eef0f6', strokeDasharray: '3 3' };

function timeAxisProps(from: number, to: number) {
  return {
    dataKey: 't',
    type: 'number' as const,
    domain: [from, to] as [number, number],
    tickFormatter: tickFmt,
    tick: AXIS_TICK,
    tickLine: false,
    axisLine: { stroke: '#e3e5ee' },
    minTickGap: 70,
  };
}

/**
 * Multi-line time series (one line per series — e.g. one per node).
 * Rows are built from the union of timestamps across series.
 */
export function MultiLine({
  data,
  from,
  to,
  yFmt,
  yMax,
  height = 220,
}: {
  data: DashChartData;
  from: number;
  to: number;
  yFmt: (v: number) => string;
  yMax?: number;
  height?: number;
}) {
  const keys = data.series.map((_, i) => 's' + i);
  const byT: Record<number, Record<string, number | null>> = {};
  data.series.forEach((s, i) => {
    for (const p of s.points) {
      if (p.t < from || p.t > to) continue;
      (byT[p.t] = byT[p.t] || {})['s' + i] = p.v;
    }
  });
  const rows = Object.entries(byT)
    .map(([t, vals]) => ({ t: +t, ...vals }))
    .sort((a, b) => a.t - b.t);
  const nameOf = (k: string) => data.series[+k.slice(1)]?.name ?? k;
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} margin={{ top: 6, right: 10, bottom: 0, left: 0 }}>
          <CartesianGrid {...GRID} vertical={false} />
          <XAxis {...timeAxisProps(from, to)} />
          <YAxis
            tick={AXIS_TICK}
            tickFormatter={yFmt}
            tickLine={false}
            axisLine={false}
            width={46}
            domain={[0, yMax ?? 'auto']}
          />
          <Tooltip
            labelFormatter={(t) => tickFmt(Number(t))}
            formatter={(v: unknown, name: unknown) =>
              [typeof v === 'number' ? yFmt(v) : '-', nameOf(String(name))] as [string, string]
            }
            labelStyle={{ fontSize: 11 }}
            itemStyle={{ fontSize: 11, padding: 0 }}
            contentStyle={{ borderRadius: 8, border: '1px solid #e9eaf0', fontSize: 11, maxHeight: 220, overflow: 'hidden' }}
          />
          {keys.map((k, i) => (
            <Line
              key={k}
              dataKey={k}
              type="monotone"
              stroke={LINE_PALETTE[i % LINE_PALETTE.length]}
              strokeWidth={1.3}
              dot={false}
              isAnimationActive={false}
              connectNulls
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/* Event scatter — discrete markers on a time axis. Only points with v > 0 are drawn. */
export function EventScatter({
  data,
  from,
  to,
  color = '#4338ca',
  height = 220,
}: {
  data: DashChartData;
  from: number;
  to: number;
  color?: string;
  height?: number;
}) {
  const pts = data.series.flatMap((s) =>
    s.points
      .filter((p) => p.t >= from && p.t <= to && (p.v ?? 0) > 0)
      .map((p) => ({ t: p.t, v: p.v as number, name: s.name })),
  );
  const maxV = Math.max(2, ...pts.map((p) => p.v));
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <ScatterChart margin={{ top: 6, right: 10, bottom: 0, left: 0 }}>
          <CartesianGrid {...GRID} vertical={false} />
          <XAxis {...timeAxisProps(from, to)} />
          <YAxis
            dataKey="v"
            type="number"
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
            width={46}
            domain={[0, maxV]}
            allowDecimals={false}
          />
          <Tooltip
            cursor={{ strokeDasharray: '3 3' }}
            formatter={(v: unknown, name: unknown) => {
              if (name === 't') return [tickFmt(Number(v)), 'time'] as [string, string];
              return [String(v), 'events'] as [string, string];
            }}
            labelStyle={{ fontSize: 11 }}
            itemStyle={{ fontSize: 11, padding: 0 }}
            contentStyle={{ borderRadius: 8, border: '1px solid #e9eaf0', fontSize: 11 }}
          />
          <Scatter data={pts} fill={color} isAnimationActive={false} shape="circle" />
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Single/multi keyed line-with-area for count series (OOM, throttling,...). */
export function CountLines({
  data,
  from,
  to,
  colors,
  height = 220,
}: {
  data: DashChartData;
  from: number;
  to: number;
  colors?: string[];
  height?: number;
}) {
  return (
    <MultiLineColored data={data} from={from} to={to} colors={colors} height={height} />
  );
}

function MultiLineColored({
  data,
  from,
  to,
  colors,
  height,
}: {
  data: DashChartData;
  from: number;
  to: number;
  colors?: string[];
  height: number;
}) {
  const byT: Record<number, Record<string, number | null>> = {};
  data.series.forEach((s, i) => {
    for (const p of s.points) {
      if (p.t < from || p.t > to) continue;
      (byT[p.t] = byT[p.t] || {})['s' + i] = p.v;
    }
  });
  const rows = Object.entries(byT)
    .map(([t, vals]) => ({ t: +t, ...vals }))
    .sort((a, b) => a.t - b.t);
  const nameOf = (k: string) => data.series[+k.slice(1)]?.name ?? k;
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} margin={{ top: 6, right: 10, bottom: 0, left: 0 }}>
          <CartesianGrid {...GRID} vertical={false} />
          <XAxis {...timeAxisProps(from, to)} />
          <YAxis
            tick={AXIS_TICK}
            tickFormatter={(v: number) => String(Math.round(v))}
            tickLine={false}
            axisLine={false}
            width={46}
            domain={[0, (max: number) => Math.max(2, Math.ceil(max))]}
            allowDecimals={false}
          />
          <Tooltip
            labelFormatter={(t) => tickFmt(Number(t))}
            formatter={(v: unknown, name: unknown) =>
              [typeof v === 'number' ? String(Math.round(v * 100) / 100) : '-', nameOf(String(name))] as [string, string]
            }
            labelStyle={{ fontSize: 11 }}
            itemStyle={{ fontSize: 11, padding: 0 }}
            contentStyle={{ borderRadius: 8, border: '1px solid #e9eaf0', fontSize: 11 }}
          />
          {data.series.map((_, i) => (
            <Line
              key={i}
              dataKey={'s' + i}
              type="monotone"
              stroke={(colors && colors[i]) || LINE_PALETTE[i % LINE_PALETTE.length]}
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
              connectNulls
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/* Empty-chart placeholder that still shows the time axis. */
export function EmptyAxis({ from, to, height = 220, note }: { from: number; to: number; height?: number; note?: string }) {
  return (
    <div style={{ position: 'relative', height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={[]} margin={{ top: 6, right: 10, bottom: 0, left: 0 }}>
          <CartesianGrid {...GRID} vertical={false} />
          <XAxis {...timeAxisProps(from, to)} ticks={[from, from + (to - from) / 2, to]} />
          <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} width={46} domain={[0, 2]} allowDecimals={false} />
        </LineChart>
      </ResponsiveContainer>
      {note && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'grid',
            placeItems: 'center',
            color: '#b6bdcc',
            fontSize: 12,
            pointerEvents: 'none',
          }}
        >
          {note}
        </div>
      )}
    </div>
  );
}
