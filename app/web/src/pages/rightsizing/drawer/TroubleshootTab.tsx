// Drawer "Troubleshoot" tab — empty charts render honest empty axes, clean
// titles, no '???').
import { useEffect, useMemo, useState } from 'react';
import { Area, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { getJson } from '../../../api/client';
import { tbFmt } from '../lib';
import { Dropdown } from '../ui';
import TimelineStrip from './TimelineStrip';
import type { DrawerTarget } from '../lib';
import type { RecommendationDetail, TbChart, TroubleshootResponse } from '../types';

const TB_PERIODS: [string, string][] = [
  ['1h', '1 hour'],
  ['1d', '1 day'],
  ['7d', '7 days'],
  ['2w', '2 weeks'],
];

/** ids that belong to the hero (first) card, not the grid */
const HERO_IDS = new Set(['cpu', 'mem', 'eph']);

function tbLabel(t: number, period: string): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return period === '1h' || period === '1d'
    ? p(d.getHours()) + ':' + p(d.getMinutes())
    : d.getMonth() + 1 + '/' + d.getDate() + ' ' + p(d.getHours());
}

/** defensive title cleanup — never show literal '???' */
function cleanTitle(t: string): string {
  return (t || '').replace(/\s*\?{2,}\s*/g, ' ').trim();
}

function isCategorical(ch: TbChart): boolean {
  return ch.unit === 'cat' || ch.unit === 'categorical' || ch.id === 'automated' || ch.id === 'auto';
}

/* Categorical rows chart. */
function TbCatChart({ ch, period, height }: { ch: TbChart; period: string; height: number }) {
  const n = ch.series.length || 1;
  const { data } = useMemo(() => {
    let times: number[] = [];
    ch.series.forEach((s) => (s.points || []).forEach((p) => times.push(p.t)));
    times = [...new Set(times)].sort((a, b) => a - b);
    if (!times.length) times = [0, 1];
    const rows = times.map((t) => {
      const row: Record<string, number | string | null> = { label: times.length > 1 && t > 1 ? tbLabel(t, period) : '' };
      ch.series.forEach((s, i) => {
        const y = n - 1 - i; // first series on top
        if (s.flat != null) row['s' + i] = s.flat >= 0.5 ? y : null;
        else {
          const m = new Map((s.points || []).map((p) => [p.t, p.v]));
          const v = m.get(t);
          row['s' + i] = v != null && v >= 0.5 ? y : null;
        }
      });
      return row;
    });
    return { data: rows };
  }, [ch, period, n]);
  return (
    <div style={{ height, position: 'relative' }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 6, bottom: 0, left: 8 }}>
          <XAxis dataKey="label" tick={{ fontSize: 9, fill: '#94a3b8' }} tickLine={false} axisLine={false} minTickGap={50} interval="preserveStartEnd" />
          <YAxis
            tick={{ fontSize: 9, fill: '#94a3b8' }}
            tickLine={false}
            axisLine={false}
            width={70}
            domain={[-0.5, n - 0.5]}
            ticks={Array.from({ length: n }, (_, i) => i)}
            tickFormatter={(v: number) => ch.series[n - 1 - Math.round(v)]?.label || ''}
          />
          <Tooltip
            formatter={(_v: unknown, name: unknown) => {
              const i = name ? +String(name).slice(1) : 0;
              return ['On', ch.series[i]?.label || ''] as [string, string];
            }}
            labelStyle={{ fontSize: 10 }}
            itemStyle={{ fontSize: 10, padding: 0 }}
            contentStyle={{ borderRadius: 8, border: '1px solid #e9eaf0', fontSize: 10 }}
          />
          {ch.series.map((s, i) => (
            <Line key={i} type="stepAfter" dataKey={'s' + i} stroke={s.color} strokeWidth={2.4} dot={false} isAnimationActive={false} connectNulls={false} />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function TbChartBody({ ch, period, height }: { ch: TbChart; period: string; height: number }) {
  const { data, keys } = useMemo(() => {
    let times: number[] = [];
    ch.series.forEach((s) => (s.points || []).forEach((p) => times.push(p.t)));
    times = [...new Set(times)].sort((a, b) => a - b);
    if (!times.length) times = [0, 1]; // flat-only or empty chart — still draw axes
    const rows = times.map((t) => {
      const row: Record<string, number | string | null> = { label: times.length > 1 && t > 1 ? tbLabel(t, period) : '' };
      ch.series.forEach((s, i) => {
        if (s.flat != null) row['s' + i] = s.flat;
        else {
          const m = new Map((s.points || []).map((p) => [p.t, p.v]));
          row['s' + i] = m.has(t) ? (m.get(t) as number | null) : null;
        }
      });
      return row;
    });
    return { data: rows, keys: ch.series.map((_, i) => 's' + i) };
  }, [ch, period]);
  const stepped = ch.unit === 'bool';
  const noData = !ch.series.some((s) => (s.points || []).length || s.flat != null);
  return (
    <div style={{ height, position: 'relative' }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 4, right: 6, bottom: 0, left: 0 }}>
          <XAxis dataKey="label" tick={{ fontSize: 9, fill: '#94a3b8' }} tickLine={false} axisLine={false} minTickGap={50} interval="preserveStartEnd" />
          <YAxis
            tick={{ fontSize: 9, fill: '#94a3b8' }}
            tickFormatter={(v: number) => tbFmt(ch.unit, v)}
            tickLine={false}
            axisLine={false}
            width={48}
            domain={ch.unit === 'bool' || noData ? [0, 1] : [0, 'auto']}
            ticks={ch.unit === 'bool' ? [0, 1] : noData && ch.unit === 'ratio' ? [0, 0.5, 1] : undefined}
          />
          <Tooltip
            formatter={(v: unknown, name: unknown) => {
              const i = name ? +String(name).slice(1) : 0;
              return [tbFmt(ch.unit, typeof v === 'number' ? v : null), ch.series[i]?.label || ''] as [string, string];
            }}
            labelStyle={{ fontSize: 10 }}
            itemStyle={{ fontSize: 10, padding: 0 }}
            contentStyle={{ borderRadius: 8, border: '1px solid #e9eaf0', fontSize: 10 }}
          />
          {ch.series.map((s, i) =>
            s.label === 'Usage' && s.flat == null ? (
              <Area
                key={i}
                type={stepped ? 'stepBefore' : 'monotone'}
                dataKey={keys[i]}
                stroke={s.color}
                strokeWidth={1.6}
                fill="rgba(59,130,246,.10)"
                strokeDasharray={s.dash ? '5 3' : undefined}
                dot={false}
                isAnimationActive={false}
                connectNulls
              />
            ) : (
              <Line
                key={i}
                type={stepped ? 'stepBefore' : 'monotone'}
                dataKey={keys[i]}
                stroke={s.color}
                strokeWidth={s.flat != null ? 2 : 1.6}
                strokeDasharray={s.dash ? '5 3' : undefined}
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

function TbLegend({ ch }: { ch: TbChart }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', columnGap: 8, rowGap: 2, justifyContent: 'center', fontSize: 9, color: '#64748b', marginTop: 4 }}>
      {ch.series.map((s) => (
        <span key={s.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <span style={{ height: 6, width: 6, borderRadius: '50%', background: s.color }} />
          {s.label}
        </span>
      ))}
    </div>
  );
}

function TbChartCard({ ch, period }: { ch: TbChart; period: string }) {
  return (
    <div className="card" style={{ padding: 8 }}>
      <div style={{ textAlign: 'center', fontSize: 11, fontWeight: 700, color: '#64748b', marginBottom: 4 }}>{cleanTitle(ch.title)}</div>
      {isCategorical(ch) ? <TbCatChart ch={ch} period={period} height={130} /> : <TbChartBody ch={ch} period={period} height={130} />}
      {!isCategorical(ch) && <TbLegend ch={ch} />}
    </div>
  );
}

export default function TroubleshootTab({
  data,
  target,
  onCopyKubectl,
}: {
  data: RecommendationDetail;
  target: DrawerTarget;
  onCopyKubectl: () => void;
}) {
  const [period, setPeriod] = useState('1d');
  const [resp, setResp] = useState<TroubleshootResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [hidden, setHidden] = useState<Set<string> | null>(null); // null until catalog arrives
  const [showEph, setShowEph] = useState(false);
  const conts = (data.containersLive || []).map((c) => c.name);

  useEffect(() => {
    let dead = false;
    const enc = encodeURIComponent;
    const load = () =>
      getJson<TroubleshootResponse>(
        `/api/troubleshoot/${enc(target.namespace)}/${enc(target.kind)}/${enc(target.name)}?period=${period}`,
      )
        .then((d) => {
          if (dead) return;
          setResp(d);
          setFailed(false);
          setHidden((prev) => {
            if (prev) return prev;
            const h = new Set<string>();
            (d.charts || []).forEach((c) => {
              if (c.selected === false) h.add(c.id);
            });
            return h;
          });
        })
        .catch(() => !dead && setFailed(true));
    load();
    const id = window.setInterval(load, 60000);
    return () => {
      dead = true;
      window.clearInterval(id);
    };
  }, [target, period]);

  const charts = resp?.charts || [];
  const hiddenSet = hidden || new Set<string>();
  const heroCpu = charts.find((c) => c.id === 'cpu');
  const heroMem = charts.find((c) => c.id === 'mem');
  const heroEph = charts.find((c) => c.id === 'eph');
  const gridCharts = charts.filter((c) => !HERO_IDS.has(c.id));
  const visible = gridCharts.filter((c) => !hiddenSet.has(c.id));
  const selectedCount = charts.filter((c) => !hiddenSet.has(c.id)).length;

  return (
    <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#475569', marginBottom: 4 }}>Dashboards</div>
          <select className="rs-selchip" style={{ padding: '6px 8px' }}>
            <option>Performance ✕ Built in</option>
          </select>
        </div>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#475569', marginBottom: 4 }}>Charts</div>
          <div style={{ position: 'relative' }}>
            <button className="rs-selchip" style={{ padding: '6px 8px' }} onClick={() => setMenuOpen((o) => !o)}>
              Selected ({selectedCount}) ▾
            </button>
            <Dropdown open={menuOpen} onClose={() => setMenuOpen(false)} style={{ left: 0, width: 240, maxHeight: 288, overflowY: 'auto', padding: 6, fontSize: 12 }}>
              {charts.map((ch) => (
                <label key={ch.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px', borderRadius: 6, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={!hiddenSet.has(ch.id)}
                    onChange={(e) =>
                      setHidden((prev) => {
                        const n = new Set(prev || []);
                        if (e.target.checked) n.delete(ch.id);
                        else n.add(ch.id);
                        return n;
                      })
                    }
                  />
                  {cleanTitle(ch.title)}
                </label>
              ))}
            </Dropdown>
          </div>
        </div>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#475569', marginBottom: 4 }}>Container</div>
          <select className="rs-selchip" style={{ padding: '6px 8px' }} title="The CPU/Memory charts aggregate across the workload's containers">
            {(conts.length ? conts : ['—']).map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, borderLeft: '1px solid #eef0f6', paddingLeft: 12, paddingBottom: 2 }}>
          <button disabled title="Custom dashboards are not available yet" style={tbBtn}>Clear</button>
          <button disabled title="Custom dashboards are not available yet" style={tbBtn}>Save</button>
          <button
            onClick={onCopyKubectl}
            title="Copy kubectl for this workload"
            style={{ height: 32, width: 32, display: 'grid', placeItems: 'center', borderRadius: 8, color: '#94a3b8', border: '1px solid #e9eaf0', background: '#fff', cursor: 'pointer' }}
          >
            <svg style={{ width: 16, height: 16 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
              <rect x="9" y="9" width="11" height="11" rx="2" />
              <path d="M5 15V5a2 2 0 0 1 2-2h10" />
            </svg>
          </button>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 2 }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: '1px solid #dfe2ec', borderRadius: 8, padding: '6px 10px', fontSize: 12, color: '#475569', background: '#fff' }}>
            <svg style={{ width: 16, height: 16, color: '#94a3b8' }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
              <rect x="3" y="5" width="18" height="16" rx="2" />
              <path d="M8 3v4M16 3v4M3 10h18" />
            </svg>
            <select value={period} onChange={(e) => setPeriod(e.target.value)} style={{ background: 'transparent', border: 'none', outline: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12 }}>
              {TB_PERIODS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {failed && <div style={{ textAlign: 'center', fontSize: 14, color: '#94a3b8', padding: '24px 0' }}>Troubleshoot data unavailable.</div>}
      {!failed && !charts.length && (
        <div style={{ textAlign: 'center', fontSize: 14, color: '#94a3b8', padding: '24px 0' }}>
          {resp ? 'No diagnostic data available.' : 'Loading diagnostics…'}
        </div>
      )}

      {/* FIRST CARD — CPU + Memory side-by-side + Timeline inside */}
      {!failed && (heroCpu || heroMem) && (
        <div className="card" style={{ padding: 12 }}>
          <label
            title={heroEph ? '' : 'No ephemeral-storage requests on this workload'}
            style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#64748b', cursor: heroEph ? 'pointer' : 'not-allowed', opacity: heroEph ? 1 : 0.5, width: 'max-content' }}
          >
            <input type="checkbox" disabled={!heroEph} checked={showEph} onChange={(e) => setShowEph(e.target.checked)} /> Show ephemeral storage
          </label>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 4 }}>
            {heroCpu && (
              <div>
                <div style={{ textAlign: 'center', fontSize: 13, fontWeight: 700, color: '#475569', marginBottom: 4 }}>{cleanTitle(heroCpu.title)}</div>
                <TbChartBody ch={heroCpu} period={period} height={170} />
                <TbLegend ch={heroCpu} />
              </div>
            )}
            {heroMem && (
              <div>
                <div style={{ textAlign: 'center', fontSize: 13, fontWeight: 700, color: '#475569', marginBottom: 4 }}>{cleanTitle(heroMem.title)}</div>
                <TbChartBody ch={heroMem} period={period} height={170} />
                <TbLegend ch={heroMem} />
              </div>
            )}
          </div>
          {heroEph && showEph && (
            <div style={{ marginTop: 8 }}>
              <div style={{ textAlign: 'center', fontSize: 13, fontWeight: 700, color: '#475569', marginBottom: 4 }}>{cleanTitle(heroEph.title)}</div>
              <TbChartBody ch={heroEph} period={period} height={130} />
              <TbLegend ch={heroEph} />
            </div>
          )}
          <div style={{ marginTop: 12, borderTop: '1px solid #f1f2f7', paddingTop: 8 }}>
            <div style={{ textAlign: 'center', fontSize: 12, fontWeight: 700, color: '#475569', marginBottom: 4 }}>Timeline</div>
            <TimelineStrip events={data.events || []} />
          </div>
        </div>
      )}

      {/* Selected (N) grid */}
      {!failed && visible.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          {visible.map((ch) => (
            <TbChartCard key={ch.id} ch={ch} period={period} />
          ))}
        </div>
      )}
    </div>
  );
}

const tbBtn: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: '#cbd5e1',
  border: '1px solid #eef0f5',
  borderRadius: 8,
  padding: '6px 12px',
  cursor: 'not-allowed',
  background: '#fff',
  fontFamily: 'inherit',
};
