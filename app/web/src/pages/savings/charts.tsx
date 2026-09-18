// Shared recharts helpers for the Savings + Troubleshooting pages
import { useEffect, useState } from 'react';
import {
  Area,
  AreaChart,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { timeFmt } from '../rightsizing/lib';

/** One point of /api/analytics/graph or /api/nodes/graph. */
export interface GraphPoint {
  timestamp: string;
  values: Record<string, number | null | undefined>;
}
export interface GraphResponse {
  values?: GraphPoint[];
}

export const coresAxis = (v: number) => (v >= 1 ? (+v).toFixed(1) : Math.round(v * 1000) + 'm');
export const bytesAxis = (v: number) => {
  const g = v / 2 ** 30;
  return g >= 1 ? g.toFixed(0) + 'Gi' : Math.round(v / 2 ** 20) + 'Mi';
};
export const intAxis = (v: number) => String(Math.round(v));

export function useTick(ms = 30000): number {
  const [t, setT] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setT((x) => x + 1), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return t;
}

export interface TsDs {
  /** key into point.values — or use compute() */
  key?: string;
  compute?: (p: GraphPoint) => number | null;
  name: string;
  stroke: string;
  /** set → rendered as filled Area */
  fill?: string;
  dash?: string;
  width?: number;
  noTooltip?: boolean;
}

const val = (p: GraphPoint, ds: TsDs): number | null => {
  if (ds.compute) return ds.compute(p);
  const v = ds.key != null ? p.values?.[ds.key] : null;
  return v == null ? null : v;
};

/* Multi-series time chart */
export function TsChart({
  values,
  datasets,
  yFmt,
  height,
}: {
  values: GraphPoint[];
  datasets: TsDs[];
  yFmt: (v: number) => string;
  height: number;
}) {
  const data = (values || []).map((p) => {
    const row: Record<string, string | number | null> = { label: timeFmt(p.timestamp) };
    datasets.forEach((ds, i) => {
      row['k' + i] = val(p, ds);
    });
    return row;
  });
  const sparse = data.length <= 3;
  // Paint areas first, lines on top (Chart.js z-order equivalent).
  const order = datasets
    .map((ds, i) => ({ ds, i }))
    .sort((a, b) => (a.ds.fill ? 0 : 1) - (b.ds.fill ? 0 : 1));
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <XAxis
            dataKey="label"
            tick={{ fontSize: 9, fill: '#aab' }}
            tickLine={false}
            axisLine={false}
            minTickGap={32}
          />
          <YAxis
            tick={{ fontSize: 9, fill: '#aab' }}
            tickFormatter={yFmt}
            tickLine={false}
            axisLine={false}
            width={44}
          />
          <Tooltip
            formatter={(v: unknown, name: unknown) => {
              const i = Number(String(name).slice(1));
              const ds = datasets[i];
              if (!ds || ds.noTooltip) return [null as unknown as string, null as unknown as string];
              return [typeof v === 'number' ? yFmt(v) : '—', ds.name] as [string, string];
            }}
            labelStyle={{ fontSize: 11 }}
            itemStyle={{ fontSize: 11, padding: 0 }}
            contentStyle={{ borderRadius: 8, border: '1px solid #e9eaf0', fontSize: 11 }}
          />
          {order.map(({ ds, i }) =>
            ds.fill ? (
              <Area
                key={i}
                type="monotone"
                dataKey={'k' + i}
                stroke={ds.stroke}
                strokeWidth={ds.width ?? 1.6}
                strokeDasharray={ds.dash}
                fill={ds.fill}
                fillOpacity={1}
                dot={sparse ? { r: 3 } : false}
                isAnimationActive={false}
                connectNulls
              />
            ) : (
              <Line
                key={i}
                type="monotone"
                dataKey={'k' + i}
                stroke={ds.stroke}
                strokeWidth={ds.width ?? 1.6}
                strokeDasharray={ds.dash}
                dot={sparse ? { r: 3 } : false}
                isAnimationActive={false}
                connectNulls
              />
            ),
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

/* Axis-less hero sparkline */
export function Spark({
  values,
  seriesKey,
  color,
  fill,
  height = 80,
}: {
  values: GraphPoint[];
  seriesKey: string;
  color: string;
  fill: string;
  height?: number;
}) {
  const data = (values || []).map((p) => ({ v: p.values?.[seriesKey] ?? null }));
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
          {/* Chart.js sparklines auto-scale the y-min to the data */}
          <YAxis hide domain={['auto', 'auto']} />
          <Area
            type="monotone"
            dataKey="v"
            stroke={color}
            strokeWidth={2}
            fill={fill}
            fillOpacity={1}
            dot={false}
            isAnimationActive={false}
            connectNulls
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/* Inline color-swatch legend row */
export function SwatchLegend({ items, style }: { items: [string, string][]; style?: React.CSSProperties }) {
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        columnGap: 16,
        rowGap: 4,
        fontSize: 11,
        color: '#64748b',
        ...style,
      }}
    >
      {items.map(([c, t]) => (
        <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ height: 8, width: 12, borderRadius: 2, background: c }} />
          {t}
        </span>
      ))}
    </div>
  );
}

/** RES_LEGEND — legend of the "Core resources over time" charts. */
export const RES_LEGEND: [string, string][] = [
  ['#9aa3c0', 'Total usage'],
  ['#f59e0b', 'Total request'],
  ['#f6a45c', 'Allocatable'],
  ['#f9c4cd', 'Waste (alloc − request)'],
];

/** resCfg() datasets — usage (filled) / request / allocatable / waste band. */
export function resDatasets(aK: string, rK: string, uK: string): TsDs[] {
  return [
    {
      name: 'Waste (unrequested)',
      compute: (p) => {
        const a = p.values?.[aK];
        const r = p.values?.[rK];
        return a != null && r != null ? Math.max(0, a - r) : null;
      },
      stroke: 'transparent',
      fill: 'rgba(244,63,94,.10)',
      width: 0,
    },
    { name: 'Total usage', key: uK, stroke: '#9aa3c0', fill: 'rgba(154,163,192,.16)' },
    { name: 'Total request', key: rK, stroke: '#f59e0b' },
    { name: 'Allocatable', key: aK, stroke: '#f6a45c' },
  ];
}

/** autoCfg() datasets — automated pods (green fill) vs total pods (indigo line). */
export function autoDatasets(autoKey: string, totalKey: string): TsDs[] {
  return [
    { name: 'Automated pods', key: autoKey, stroke: '#22c55e', fill: 'rgba(34,197,94,.14)' },
    { name: 'Total pods', key: totalKey, stroke: '#6366f1' },
  ];
}

/** resrcCfg() datasets — optimized request (green dashed fill) vs current request. */
export function resrcDatasets(optKey: string, curKey: string): TsDs[] {
  return [
    { name: 'Optimized request', key: optKey, stroke: '#22c55e', fill: 'rgba(34,197,94,.10)', dash: '4 3' },
    { name: 'Current request', key: curKey, stroke: '#f59e0b' },
  ];
}

// =========================================================================== Period
// A / Period B comparison helpers.
// ===========================================================================

export const PERIOD_A_COLOR = '#4a9df8';
export const PERIOD_B_COLOR = '#5b5bd6';

/** Split one time-series into the two comparison periods the page already
 *  knows: Period B = last `winHours`, Period A = the `winHours` before it. */
export function splitPeriods(values: GraphPoint[], winHours: number): { a: GraphPoint[]; b: GraphPoint[] } {
  const now = Date.now();
  const boundary = now - winHours * 3600e3;
  const start = now - 2 * winHours * 3600e3;
  const a: GraphPoint[] = [];
  const b: GraphPoint[] = [];
  for (const p of values || []) {
    const t = Date.parse(p.timestamp);
    if (Number.isNaN(t) || t < start) continue;
    (t < boundary ? a : b).push(p);
  }
  return { a, b };
}

/** true if any point carries a non-null value for `key`. */
export function hasSeries(values: GraphPoint[], key?: string): boolean {
  if (!key) return false;
  return (values || []).some((p) => p.values?.[key] != null);
}

/** First candidate key that actually has data (feature-detection of new
 *  backend series names — LIVE backend may not ship them yet). */
export function firstSeriesKey(values: GraphPoint[], candidates: string[]): string | undefined {
  return candidates.find((k) => hasSeries(values, k));
}

/** Mean of a series over a set of points (used for the comparison-card
 *  "Original request" fallback when /api/comparison lacks the key). */
export function seriesAvg(values: GraphPoint[], key: string): number | null {
  let sum = 0;
  let n = 0;
  for (const p of values || []) {
    const v = p.values?.[key];
    if (typeof v === 'number') {
      sum += v;
      n++;
    }
  }
  return n ? sum / n : null;
}

/** Outlined right-arrow glyph between the Period A and Period B charts. */
export function ArrowGlyph() {
  return (
    <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#1e2536" strokeWidth="1.5" strokeLinejoin="round" aria-hidden>
      <path d="M3 9.5h9.5V5.5L21 12l-8.5 6.5v-4H3z" />
    </svg>
  );
}

/** Honest-empty chart frame — axes-style box + "No data", never fabricated. */
export function EmptyFrame({ height }: { height: number }) {
  return (
    <div
      style={{
        height,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderLeft: '1px solid #e2e5ee',
        borderBottom: '1px solid #e2e5ee',
        background:
          'repeating-linear-gradient(to top, transparent, transparent 39px, #f1f2f7 39px, #f1f2f7 40px)',
        color: '#94a3b8',
        fontSize: 12,
      }}
    >
      No data
    </div>
  );
}

/*
 * One period chart card: centered colored "Period A/B" title + chart (or honest-empty frame) + its
 * own centered legend.
*/
export function PeriodChartCard({
  period,
  titleSuffix,
  values,
  datasets,
  yFmt,
  height,
  legend,
  bordered = true,
}: {
  period: 'A' | 'B';
  titleSuffix?: string;
  values: GraphPoint[];
  datasets: TsDs[];
  yFmt: (v: number) => string;
  height: number;
  legend?: [string, string][];
  bordered?: boolean;
}) {
  const color = period === 'A' ? PERIOD_A_COLOR : PERIOD_B_COLOR;
  const hasAny = datasets.some((ds) => (ds.key ? hasSeries(values, ds.key) : false));
  return (
    <div
      style={
        bordered
          ? { border: '1px solid #d9dce6', borderRadius: 6, padding: '12px 12px 8px', background: '#fff' }
          : undefined
      }
    >
      <div style={{ textAlign: 'center', fontSize: 13, fontWeight: 700, marginBottom: 8 }}>
        <span style={{ color }}>Period {period}</span>
        {titleSuffix && <span style={{ color: '#1e2536', fontWeight: 500 }}> - {titleSuffix}</span>}
      </div>
      {hasAny ? <TsChart values={values} datasets={datasets} yFmt={yFmt} height={height} /> : <EmptyFrame height={height} />}
      {legend && <SwatchLegend items={legend} style={{ justifyContent: 'center', marginTop: 8 }} />}
    </div>
  );
}

/* Period A | arrow | Period B paired row. */
export function PairedPeriodCharts({
  title,
  a,
  b,
  datasets,
  yFmt,
  height,
  legend,
  titleSuffix,
  bordered = true,
}: {
  title?: string;
  a: GraphPoint[];
  b: GraphPoint[];
  datasets: TsDs[];
  yFmt: (v: number) => string;
  height: number;
  legend?: [string, string][];
  titleSuffix?: string;
  bordered?: boolean;
}) {
  return (
    <div>
      {title && <div style={{ fontSize: 13, fontWeight: 600, color: '#1e2536', margin: '4px 0 8px' }}>{title}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 40px 1fr', alignItems: 'center', gap: 8 }}>
        <PeriodChartCard period="A" titleSuffix={titleSuffix} values={a} datasets={datasets} yFmt={yFmt} height={height} legend={legend} bordered={bordered} />
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <ArrowGlyph />
        </div>
        <PeriodChartCard period="B" titleSuffix={titleSuffix} values={b} datasets={datasets} yFmt={yFmt} height={height} legend={legend} bordered={bordered} />
      </div>
    </div>
  );
}

/* Automated-vs-total pods pair, with per-product legend names. */
export function pairDatasets(autoKey: string | undefined, totalKey: string | undefined, autoName: string, totalName: string): TsDs[] {
  const out: TsDs[] = [];
  if (autoKey) out.push({ name: autoName, key: autoKey, stroke: '#4caf82', fill: 'rgba(76,175,130,.30)' });
  if (totalKey) out.push({ name: totalName, key: totalKey, stroke: '#6366f1', width: 2 });
  return out;
}

/** Legend swatches matching pairDatasets. */
export function pairLegend(autoName: string, totalName: string): [string, string][] {
  return [
    ['#4caf82', autoName],
    ['#6366f1', totalName],
  ];
}

/*
 * Core-resources datasets: Allocatable / Original request / Request / Usage. prefix = 'cpu' |
 * 'memory'.
*/
export function corePeriodDatasets(prefix: 'cpu' | 'memory'): TsDs[] {
  return [
    { name: 'Allocatable', key: prefix + 'Allocatable', stroke: '#f6a45c', width: 2 },
    { name: 'Original request', key: prefix + 'RequestsOrigin', stroke: '#f43f5e' },
    { name: 'Request', key: prefix + 'Requests', stroke: '#eab308' },
    { name: 'Usage', key: prefix + 'UsageTotal', stroke: '#16a34a' },
  ];
}

export const CORE_PERIOD_LEGEND: [string, string][] = [
  ['#f6a45c', 'Allocatable'],
  ['#f43f5e', 'Original request'],
  ['#eab308', 'Request'],
  ['#16a34a', 'Usage'],
];

/*
 * Three-series "Automated resources progress" datasets — Current optimized request / Current
 * request / Original request. Missing keys simply draw nothing (honest); pass undefined to omit a
 * series.
*/
export function req3Datasets(optKey?: string, curKey?: string, origKey?: string): TsDs[] {
  // paint order: original first, current over it, optimized on top — so the
  // yellow "Current request" stays visible where it coincides with original.
  const out: TsDs[] = [];
  if (origKey) out.push({ name: 'Original request', key: origKey, stroke: '#f4587a' });
  if (curKey) out.push({ name: 'Current request', key: curKey, stroke: '#e0b520' });
  if (optKey) out.push({ name: 'Current optimized request', key: optKey, stroke: '#2fbf71' });
  return out;
}

export const REQ3_LEGEND: [string, string][] = [
  ['#2fbf71', 'Current optimized request'],
  ['#e0b520', 'Current request'],
  ['#f4587a', 'Original request'],
];

/* Single blocked-allocatable series. */
export function blockedDatasets(key: string | undefined, name: string): TsDs[] {
  return key ? [{ name, key, stroke: '#f6a45c', width: 2 }] : [];
}

/** Titled chart card for the "Automated resources progress" grid. */
export function ResourceChartCard({
  title,
  values,
  datasets,
  yFmt,
  legend,
  height = 190,
}: {
  title: string;
  values: GraphPoint[];
  datasets: TsDs[];
  yFmt: (v: number) => string;
  legend?: [string, string][];
  height?: number;
}) {
  const hasAny = datasets.some((ds) => (ds.key ? hasSeries(values, ds.key) : false));
  return (
    <div style={{ border: '1px solid #d9dce6', borderRadius: 6, padding: '12px 12px 8px', background: '#fff' }}>
      <div style={{ textAlign: 'center', fontSize: 13, fontWeight: 600, color: '#1e2536', marginBottom: 8 }}>{title}</div>
      {hasAny ? <TsChart values={values} datasets={datasets} yFmt={yFmt} height={height} /> : <EmptyFrame height={height} />}
      {legend && <SwatchLegend items={legend} style={{ justifyContent: 'center', marginTop: 8 }} />}
    </div>
  );
}
