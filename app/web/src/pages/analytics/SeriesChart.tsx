// Generic multi-series time chart used by the analytics + cost-report pages —
// Chart.js configs (same colors, fills, dashed lines, stacked areas).
import { Area, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { timeFmtA, type GraphPoint } from './lib';

export interface SeriesSpec {
  key: string;
  label: string;
  color: string;
  /** rgba fill → rendered as an Area (like Chart.js fill:true). */
  fill?: string;
  dash?: string; // e.g. '4 3'
  width?: number;
}

export function Legend({ items, square }: { items: [string, string][]; square?: boolean }) {
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'center',
        columnGap: 20,
        rowGap: 6,
        marginTop: 8,
        fontSize: 11,
        color: '#64748b',
      }}
    >
      {items.map(([c, t]) => (
        <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span
            style={{
              height: 8,
              width: square ? 12 : 8,
              borderRadius: square ? 2 : 999,
              background: c,
              display: 'inline-block',
            }}
          />
          {t}
        </span>
      ))}
    </div>
  );
}

export default function SeriesChart({
  values,
  series,
  yFmt,
  height = 208,
  stacked = false,
}: {
  values: GraphPoint[];
  series: SeriesSpec[];
  yFmt: (v: number) => string;
  height?: number;
  stacked?: boolean;
}) {
  const data = (values || []).map((p) => {
    const row: Record<string, string | number | null> = { __label: timeFmtA(p.timestamp) };
    for (const s of series) row[s.key] = p.values?.[s.key] ?? null;
    return row;
  });
  const byKey = Object.fromEntries(series.map((s) => [s.key, s.label]));
  // Chart.js paints dataset 0 on top; recharts paints last-rendered on top —
  // charts must keep declaration order (it defines the stack order).
  const ordered = stacked ? series : [...series].reverse();
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <XAxis
            dataKey="__label"
            tick={{ fontSize: 9, fill: '#aab' }}
            tickLine={false}
            axisLine={false}
            minTickGap={60}
          />
          <YAxis
            tick={{ fontSize: 9, fill: '#aab' }}
            tickFormatter={yFmt}
            tickLine={false}
            axisLine={false}
            width={48}
            domain={[0, 'auto']}
          />
          <Tooltip
            formatter={(v: unknown, name: unknown) =>
              [typeof v === 'number' ? yFmt(v) : '—', byKey[String(name)] ?? String(name)] as [string, string]
            }
            labelStyle={{ fontSize: 11 }}
            itemStyle={{ fontSize: 11, padding: 0 }}
            contentStyle={{ borderRadius: 8, border: '1px solid #e9eaf0', fontSize: 11 }}
          />
          {ordered.map((s) =>
            s.fill ? (
              <Area
                key={s.key}
                type="monotone"
                dataKey={s.key}
                stroke={s.color}
                strokeWidth={s.width ?? 1.6}
                fill={s.fill}
                fillOpacity={1}
                dot={false}
                isAnimationActive={false}
                stackId={stacked ? 'a' : undefined}
                connectNulls
              />
            ) : (
              <Line
                key={s.key}
                type="monotone"
                dataKey={s.key}
                stroke={s.color}
                strokeWidth={s.width ?? 1.6}
                strokeDasharray={s.dash}
                dot={false}
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
