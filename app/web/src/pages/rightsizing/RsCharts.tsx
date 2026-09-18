// CPU / Memory over-time charts row (7d/30d + Show-ephemeral toggle)
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
import { cpuFmt, memFmt } from '../../lib/format';
import { timeFmt } from './lib';
import type { AnalyticsGraphResponse } from './types';

interface Pt {
  label: string;
  usage: number | null;
  opt: number | null;
  req: number | null;
  totalOrig: number | null;
  orig: number | null;
  alloc: number | null;
  wasteBase: number | null; // min(req, opt) — transparent stack base
  wasteBand: number | null; // max(0, req-opt) — amber band
}

function toPoints(values: AnalyticsGraphResponse['values'], prefix: 'cpu' | 'memory'): Pt[] {
  const cap = prefix[0].toUpperCase() + prefix.slice(1);
  return (values || []).map((p) => {
    const v = p.values || {};
    const usage = v[prefix + 'UsageTotal'] ?? null;
    const opt = v[prefix + 'Recommendation'] ?? null;
    const req = v[prefix + 'Requests'] ?? null;
    const band = req != null && opt != null ? Math.max(0, req - opt) : null;
    return {
      label: timeFmt(p.timestamp),
      usage,
      opt,
      req,
      totalOrig: v['total' + cap + 'RequestsOrigin'] ?? null,
      orig: v[prefix + 'RequestsOrigin'] ?? null,
      alloc: v[prefix + 'Allocatable'] ?? null,
      wasteBase: band != null ? Math.min(req!, opt!) : null,
      wasteBand: band,
    };
  });
}

// [color, label, swatch, seriesKey]
const RS_LEGEND: [string, string, 'solid' | 'dash' | 'hatch', string][] = [
  ['#9aa3c0', 'Usage', 'solid', 'usage'],
  ['#22c55e', 'Optimized request', 'dash', 'opt'],
  ['#f59e0b', 'Request', 'solid', 'req'],
  ['#f59e0b', 'Waste', 'hatch', 'waste'],
  ['#cbd0e0', 'Total request', 'solid', 'totalOrig'],
  ['#ec4899', 'Original request', 'solid', 'orig'],
  ['#f6a45c', 'Allocatable', 'solid', 'alloc'],
];
const DEFAULT_HIDDEN = ['totalOrig', 'orig', 'alloc'];

const SERIES_LABELS: Record<string, string> = {
  usage: 'Usage',
  opt: 'Optimized request',
  req: 'Request',
  totalOrig: 'Total request',
  orig: 'Original request',
  alloc: 'Allocatable',
};

function RsChart({ data, fmt, height = 150, hidden = [] }: { data: Pt[]; fmt: (v?: number | null) => string; height?: number; hidden?: string[] }) {
  const off = (k: string) => hidden.includes(k);
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <XAxis
            dataKey="label"
            tick={{ fontSize: 9, fill: '#aab' }}
            tickLine={false}
            axisLine={false}
            interval="preserveStartEnd"
            minTickGap={60}
          />
          <YAxis
            tick={{ fontSize: 9, fill: '#aab' }}
            tickFormatter={(v: number) => fmt(v)}
            tickLine={false}
            axisLine={false}
            width={52}
          />
          <Tooltip
            formatter={(v: unknown, name: unknown) =>
              [fmt(typeof v === 'number' ? v : null), SERIES_LABELS[String(name)] || String(name)] as [string, string]
            }
            labelStyle={{ fontSize: 11 }}
            itemStyle={{ fontSize: 11, padding: 0 }}
            contentStyle={{ borderRadius: 8, border: '1px solid #e9eaf0', fontSize: 11 }}
          />
          <Area type="monotone" dataKey="usage" stroke="#9aa3c0" strokeWidth={1.6} fill="rgba(154,163,192,.16)" dot={false} isAnimationActive={false} />
          {/* waste band — Request filled down to Optimized request */}
          <Area type="monotone" dataKey="wasteBase" stackId="w" stroke="none" fill="transparent" dot={false} isAnimationActive={false} tooltipType="none" legendType="none" />
          <Area type="monotone" dataKey="wasteBand" stackId="w" stroke="none" fill="rgba(245,158,11,.16)" dot={false} isAnimationActive={false} tooltipType="none" legendType="none" />
          <Line type="monotone" dataKey="opt" stroke="#22c55e" strokeWidth={1.6} strokeDasharray="4 3" dot={false} isAnimationActive={false} />
          <Line type="monotone" dataKey="req" stroke="#f59e0b" strokeWidth={1.6} dot={false} isAnimationActive={false} />
          {!off('totalOrig') && <Line type="monotone" dataKey="totalOrig" stroke="#cbd0e0" strokeWidth={1.2} dot={false} isAnimationActive={false} />}
          {!off('orig') && <Line type="monotone" dataKey="orig" stroke="#ec4899" strokeWidth={1.2} dot={false} isAnimationActive={false} />}
          {!off('alloc') && <Line type="monotone" dataKey="alloc" stroke="#f6a45c" strokeWidth={1.4} dot={false} isAnimationActive={false} />}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

export function LegendSwatch({ color, style }: { color: string; style: 'solid' | 'dash' | 'hatch' }) {
  const bg =
    style === 'hatch'
      ? `repeating-linear-gradient(45deg,${color},${color} 2px,transparent 2px,transparent 4px)`
      : style === 'dash'
        ? `repeating-linear-gradient(90deg,${color},${color} 4px,transparent 4px,transparent 7px)`
        : color;
  return <span style={{ height: 8, width: 12, borderRadius: 2, background: bg, display: 'inline-block' }} />;
}

export default function RsCharts() {
  const [range, setRange] = useState<'7d' | '30d'>('7d');
  const [eph, setEph] = useState(false);
  const [hidden, setHidden] = useState<string[]>(DEFAULT_HIDDEN);
  const toggleSeries = (k: string) => {
    if (k === 'usage' || k === 'waste') return;
    setHidden((h) => (h.includes(k) ? h.filter((x) => x !== k) : [...h, k]));
  };
  const [cpu, setCpu] = useState<Pt[]>([]);
  const [mem, setMem] = useState<Pt[]>([]);
  const [ephData, setEphData] = useState<Pt[]>([]);

  useEffect(() => {
    let dead = false;
    const grp = range === '7d' ? 'hour' : 'day';
    const q = (types: string[]) =>
      `/api/analytics/graph?range=${range}&groupBy=${grp}&types=${types.join('&types=')}`;
    const cpuT = ['cpuUsageTotal', 'cpuRecommendation', 'cpuRequests', 'totalCpuRequestsOrigin', 'cpuRequestsOrigin', 'cpuAllocatable'];
    const memT = ['memoryUsageTotal', 'memoryRecommendation', 'memoryRequests', 'totalMemoryRequestsOrigin', 'memoryRequestsOrigin', 'memoryAllocatable'];
    Promise.all([getJson<AnalyticsGraphResponse>(q(cpuT)), getJson<AnalyticsGraphResponse>(q(memT))])
      .then(([c, m]) => {
        if (dead) return;
        setCpu(toPoints(c.values, 'cpu'));
        setMem(toPoints(m.values, 'memory'));
      })
      .catch(() => {});
    if (eph) {
      getJson<AnalyticsGraphResponse>(q(['ephemeralUsage', 'ephemeralRecommendation', 'ephemeralRequests']))
        .then((e) => {
          if (dead) return;
          setEphData(
            (e.values || []).map((p) => {
              const v = p.values || {};
              const req = v.ephemeralRequests ?? null;
              const opt = v.ephemeralRecommendation ?? null;
              return {
                label: timeFmt(p.timestamp),
                usage: v.ephemeralUsage ?? null,
                opt,
                req,
                totalOrig: null,
                orig: null,
                alloc: null,
                wasteBase: null,
                wasteBand: null,
              };
            }),
          );
        })
        .catch(() => {});
    }
    return () => {
      dead = true;
    };
  }, [range, eph]);

  return (
    <section className="card" style={{ padding: 16 }}>
      <div style={{ marginBottom: 4 }}>
        <div style={{ display: 'inline-flex', gap: 2, background: '#f1f2f7', borderRadius: 8, padding: 2 }}>
          <span className={'tabline' + (range === '7d' ? ' active' : '')} onClick={() => setRange('7d')}>7 Days</span>
          <span className={'tabline' + (range === '30d' ? ' active' : '')} onClick={() => setRange('30d')}>30 Days</span>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#64748b', cursor: 'pointer', userSelect: 'none', marginTop: 6, width: 'max-content' }}>
          <input type="checkbox" checked={eph} onChange={(e) => setEph(e.target.checked)} style={{ borderRadius: 4 }} />
          Show ephemeral storage
        </label>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#64748b', marginBottom: 4 }}>
            CPU over time <span style={{ color: '#94a3b8', fontWeight: 400 }}>(cores)</span>
          </div>
          <RsChart data={cpu} fmt={cpuFmt} hidden={hidden} />
        </div>
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#64748b', marginBottom: 4 }}>
            Memory over time <span style={{ color: '#94a3b8', fontWeight: 400 }}>(GiB)</span>
          </div>
          <RsChart data={mem} fmt={memFmt} hidden={hidden} />
        </div>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', columnGap: 16, rowGap: 4, marginTop: 12, fontSize: 11, color: '#64748b' }}>
        {RS_LEGEND.map(([c, t, st, k]) => (
          <span
            key={t}
            onClick={() => toggleSeries(k)}
            title={k === 'usage' || k === 'waste' ? undefined : 'Click to toggle'}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              cursor: k === 'usage' || k === 'waste' ? 'default' : 'pointer',
              opacity: hidden.includes(k) ? 0.4 : 1, userSelect: 'none',
            }}
          >
            <LegendSwatch color={c} style={st} />
            {t}
          </span>
        ))}
      </div>
      {eph && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#64748b', marginBottom: 4 }}>
            Ephemeral storage over time <span style={{ color: '#94a3b8', fontWeight: 400 }}>(GiB)</span>
          </div>
          <RsChart data={ephData} fmt={memFmt} height={140} />
        </div>
      )}
    </section>
  );
}
