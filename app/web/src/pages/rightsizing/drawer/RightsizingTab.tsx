// Drawer "Rightsizing" tab
import { useEffect, useMemo, useState } from 'react';
import {
  Area,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { getJson } from '../../../api/client';
import { usd, cpuFmt, memFmt } from '../../../lib/format';
import { tsLabel } from '../lib';
import { PolicyIcon } from '../ui';
import TimelineStrip from './TimelineStrip';
import type {
  RecommendationDetail,
  TimeseriesResponse,
  WhatIfResponse,
} from '../types';
import type { DrawerTarget } from '../lib';

export const PERIODS: [string, string][] = [
  ['1h', '1 hour'],
  ['1d', '1 day'],
  ['7d', '7 days'],
  ['2w', '2 weeks'],
  ['30d', '30 days'],
];

const TS_SERIES: [string, string, 'dot' | 'hatch'][] = [
  ['Usage (avg)', '#3b82f6', 'dot'],
  ['Usage (p90)', '#a5b4fc', 'dot'],
  ['Usage (max)', '#94a3b8', 'dot'],
  ['Optimized request', '#10b981', 'dot'],
  ['Request', '#f59e0b', 'dot'],
  ['Waste', '#f59e0b', 'hatch'],
  ['Original request', '#f9a8d4', 'dot'],
  ['Current limit', '#fcd34d', 'dot'],
  ['Original limit', '#fda4af', 'dot'],
];

interface ChartPt {
  label: string;
  avg: number | null;
  p90: number | null;
  max: number | null;
  rec: number | null;
  req: number | null;
  orig: number | null;
  lim: number | null;
  olim: number | null;
  j90: number | null;
  jmx: number | null;
  wasteBase: number | null;
  wasteBand: number | null;
}

const CHART_LABELS: Record<string, string> = {
  avg: 'Usage (avg)',
  p90: 'Usage (p90)',
  max: 'Usage (max)',
  rec: 'Optimized request',
  req: 'Request',
  orig: 'Original request',
  lim: 'Current limit',
  olim: 'Original limit',
  j90: 'Java real memory (p90)',
  jmx: 'Java real memory (max)',
};

function toChartData(ts: TimeseriesResponse): ChartPt[] {
  const pts = ts.points || [];
  const ln = ts.lines || {};
  const j90 = new Map((ts.javaPoints || []).map((p) => [p.t, p.p90 ?? null]));
  const jmx = new Map((ts.javaPoints || []).map((p) => [p.t, p.max ?? null]));
  const showWaste = (ln.current || 0) > (ln.optimized || 0);
  return pts.map((p) => {
    const req = p.currentRequest ?? ln.current ?? null;
    const rec = p.recommendedRequest ?? ln.optimized ?? null;
    const band = showWaste && req != null && rec != null ? Math.max(0, req - rec) : null;
    return {
      label: tsLabel(p.t, ts.period),
      avg: p.avg ?? null,
      p90: p.p90 ?? null,
      max: p.max ?? null,
      rec,
      req,
      orig: p.originRequest ?? ln.original ?? null,
      lim: (ln.limit || 0) > 0 ? (p.currentLimit ?? ln.limit ?? null) : null,
      olim: (ln.originalLimit || 0) > 0 ? (p.originalLimit ?? ln.originalLimit ?? null) : null,
      j90: j90.get(p.t) ?? null,
      jmx: jmx.get(p.t) ?? null,
      wasteBase: band != null ? Math.min(req!, rec!) : null,
      wasteBand: band,
    };
  });
}

function UsageChart({ ts, hasJava }: { ts: TimeseriesResponse | null; hasJava: boolean }) {
  const data = useMemo(() => (ts ? toChartData(ts) : []), [ts]);
  const fmt = (v?: number | null) => (ts?.unit === 'cores' ? cpuFmt(v) : memFmt(v));
  const hasLim = (ts?.lines?.limit || 0) > 0;
  const hasOlim = (ts?.lines?.originalLimit || 0) > 0;
  return (
    <div style={{ height: 170, position: 'relative' }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <XAxis dataKey="label" tick={{ fontSize: 9, fill: '#94a3b8' }} tickLine={false} axisLine={false} minTickGap={60} interval="preserveStartEnd" />
          <YAxis tick={{ fontSize: 9, fill: '#94a3b8' }} tickFormatter={(v: number) => fmt(v)} tickLine={false} axisLine={false} width={54} />
          <Tooltip
            formatter={(v: unknown, name: unknown) =>
              [fmt(typeof v === 'number' ? v : null), CHART_LABELS[String(name)] || String(name)] as [string, string]
            }
            labelStyle={{ fontSize: 11 }}
            itemStyle={{ fontSize: 11, padding: 0 }}
            contentStyle={{ borderRadius: 8, border: '1px solid #e9eaf0', fontSize: 11 }}
          />
          <Area type="monotone" dataKey="avg" stroke="#3b82f6" strokeWidth={1.6} fill="rgba(59,130,246,.12)" dot={false} isAnimationActive={false} />
          <Line type="monotone" dataKey="p90" stroke="#a5b4fc" strokeWidth={1.4} dot={false} isAnimationActive={false} />
          <Line type="monotone" dataKey="max" stroke="#94a3b8" strokeWidth={1.4} dot={false} isAnimationActive={false} />
          {/* waste band between Request and Optimized request */}
          <Area type="stepAfter" dataKey="wasteBase" stackId="w" stroke="none" fill="transparent" dot={false} isAnimationActive={false} tooltipType="none" />
          <Area type="stepAfter" dataKey="wasteBand" stackId="w" stroke="none" fill="rgba(245,158,11,.16)" dot={false} isAnimationActive={false} tooltipType="none" />
          <Line type="monotone" dataKey="rec" stroke="#10b981" strokeWidth={2} dot={false} isAnimationActive={false} />
          <Line type="stepAfter" dataKey="req" stroke="#f59e0b" strokeWidth={2} dot={false} isAnimationActive={false} />
          <Line type="monotone" dataKey="orig" stroke="#f9a8d4" strokeWidth={1} strokeDasharray="3 3" dot={false} isAnimationActive={false} />
          {hasJava && (
            <>
              <Area type="monotone" dataKey="j90" stroke="#16a34a" strokeWidth={1.6} fill="rgba(22,163,74,.10)" dot={false} isAnimationActive={false} connectNulls />
              <Line type="monotone" dataKey="jmx" stroke="#86efac" strokeWidth={1.2} dot={false} isAnimationActive={false} connectNulls />
            </>
          )}
          {hasLim && <Line type="stepAfter" dataKey="lim" stroke="#fcd34d" strokeWidth={1} strokeDasharray="6 3" dot={false} isAnimationActive={false} />}
          {hasOlim && <Line type="monotone" dataKey="olim" stroke="#fda4af" strokeWidth={1} strokeDasharray="2 2" dot={false} isAnimationActive={false} />}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

export default function RightsizingTab({
  data,
  target,
  policyNames,
  period,
  setPeriod,
  ro,
  policy,
  setPolicy,
  onOpenPolicy,
  onAttachPolicy,
}: {
  data: RecommendationDetail;
  target: DrawerTarget;
  policyNames: string[];
  period: string;
  setPeriod: (p: string) => void;
  ro: boolean;
  policy: string;
  setPolicy: (p: string) => void;
  onOpenPolicy: (p: string) => void;
  onAttachPolicy: (p: string) => void;
}) {
  const basePolicy = data.policyName || data.status?.policyName || '—';
  const containersRec = data.status?.rightSize?.containers || [];
  const contNames = (containersRec.length ? containersRec : data.containersLive || []).map((c) => c.name);
  const [container, setContainer] = useState(contNames[0] || '');
  const [showEph, setShowEph] = useState(false);
  const [cpuTs, setCpuTs] = useState<TimeseriesResponse | null>(null);
  const [memTs, setMemTs] = useState<TimeseriesResponse | null>(null);
  const [ephTs, setEphTs] = useState<TimeseriesResponse | null>(null);
  const [whatIf, setWhatIf] = useState<WhatIfResponse | null>(null);

  const previewing = policy !== basePolicy;

  // charts (loadDrawerCharts port)
  useEffect(() => {
    if (!container || container === '—') return;
    let dead = false;
    const enc = encodeURIComponent;
    const base = `/api/timeseries/${enc(target.namespace)}/${enc(target.kind)}/${enc(target.name)}?container=${enc(container)}&policy=${enc(policy)}&period=${period}`;
    Promise.all([getJson<TimeseriesResponse>(base + '&res=cpu'), getJson<TimeseriesResponse>(base + '&res=memory')])
      .then(([c, m]) => {
        if (dead) return;
        setCpuTs(c);
        setMemTs(m);
      })
      .catch(() => {});
    if (showEph)
      getJson<TimeseriesResponse>(base + '&res=ephemeral')
        .then((e) => !dead && setEphTs(e))
        .catch(() => {});
    return () => {
      dead = true;
    };
  }, [container, policy, period, showEph, target]);

  // what-if (drawerWhatIf port)
  useEffect(() => {
    if (!previewing) {
      setWhatIf(null);
      return;
    }
    let dead = false;
    const enc = encodeURIComponent;
    getJson<WhatIfResponse>(
      `/api/recommendation-whatif?ns=${enc(target.namespace)}&kind=${enc(target.kind)}&name=${enc(target.name)}&policy=${enc(policy)}`,
    )
      .then((w) => !dead && setWhatIf(w))
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [previewing, policy, target]);

  // patched cost view under the previewed policy
  const view = useMemo(() => {
    if (!whatIf) return { monthlyCost: data.monthlyCost, savings: data.savings };
    return {
      monthlyCost: whatIf.monthlyCost != null ? whatIf.monthlyCost : data.monthlyCost,
      savings: whatIf.savings != null ? whatIf.savings : data.savings,
    };
  }, [whatIf, data]);

  const curCost = view.monthlyCost != null ? view.monthlyCost : null;
  const sav = view.savings != null ? view.savings : 0;
  const optCost = curCost != null ? Math.max(0, curCost - (sav || 0)) : null;
  const barMax = Math.max(curCost || 0, optCost || 0, 1);
  const gapPct = curCost && curCost > 0 ? Math.min(100, Math.round(((sav || 0) / curCost) * 100)) : 0;
  const running = (data.podInfo || []).filter((p) => p.ready).length;
  const desired = data.replicas != null ? String(data.replicas) : '—';
  const autoSrc = data.automationSource || (data.automated ? 'user' : 'not automated');
  const hasEph = (data.reqEph || 0) > 0 || (data.recEph || 0) > 0;

  const bar = (label: string, val: number | null, color: string) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div
        style={{
          height: 16,
          borderRadius: 999,
          background: color,
          transition: 'all .3s',
          width: (val != null ? Math.max(6, Math.round((val / barMax) * 62)) : 6) + '%',
        }}
      />
      <span className="num" style={{ fontSize: 12, fontWeight: 600, color: '#475569', whiteSpace: 'nowrap' }}>
        {label}: {val != null ? usd(val) : '—'}
      </span>
    </div>
  );

  const chip = (content: React.ReactNode, tip: string) => (
    <span
      className="pill"
      title={tip}
      style={{ border: '1px solid #dfe2ec', background: '#fff', color: '#475569', fontWeight: 500, justifyContent: 'center', cursor: 'help' }}
    >
      {content}
    </span>
  );

  return (
    <div>
      {/* summary header */}
      <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="card" style={{ padding: 16 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'stretch', gap: 16 }}>
            <div style={{ minWidth: 168 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#475569', marginBottom: 6 }}>Policy</div>
              <span
                className="pill"
                title="What-if: preview the recommendation under another policy"
                style={{ background: '#eef2ff', color: '#4f46e5', border: '1px solid #c7d2fe', fontWeight: 600, padding: '6px 9px' }}
              >
                <PolicyIcon />
                <select
                  id="dwPolicySel"
                  value={policy}
                  onChange={(e) => setPolicy(e.target.value)}
                  style={{ background: 'transparent', fontWeight: 600, border: 'none', outline: 'none', cursor: 'pointer', maxWidth: 120, color: 'inherit', fontFamily: 'inherit', fontSize: 11 }}
                >
                  {policyNames.map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </select>
              </span>
              <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
                <a
                  onClick={() => onOpenPolicy(policy)}
                  style={{ fontSize: 11, color: '#6366f1', textDecoration: 'underline', cursor: 'pointer' }}
                >
                  view policy ↗
                </a>
                {previewing && !ro && (
                  <button
                    onClick={() => onAttachPolicy(policy)}
                    className="pill"
                    style={{ background: '#f0fdf4', color: '#16a34a', border: '1px solid #bbf7d0', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
                  >
                    Apply policy
                  </button>
                )}
              </div>
              {previewing && (
                <div style={{ marginTop: 4 }}>
                  <span
                    className="pill"
                    title={`Previewing ${policy} — not applied. Values recomputed under this policy.`}
                    style={{ background: '#fffbeb', color: '#d97706', border: '1px solid #fde68a' }}
                  >
                    preview: {policy}
                  </span>
                </div>
              )}
            </div>
            <div style={{ minWidth: 150 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#475569', marginBottom: 6 }}>Container</div>
              <select className="rs-selchip" style={{ width: '100%', padding: '6px 8px' }} value={container} onChange={(e) => setContainer(e.target.value)}>
                {(contNames.length ? contNames : ['—']).map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </div>
            <div style={{ flex: 1, minWidth: 230, borderLeft: '1px solid #eef0f6', paddingLeft: 16, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 8 }}>
              {bar('Current', curCost, '#6366f1')}
              {bar('Optimized', optCost, '#22c55e')}
            </div>
            <div style={{ borderLeft: '1px solid #eef0f6', paddingLeft: 16, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 6, minWidth: 168 }}>
              {chip(`Replicas: ${running} / ${desired}`, 'Running / desired replicas')}
              {chip(
                <>Optimization gap <span style={{ opacity: 0.6 }}>ⓘ</span></>,
                `Reclaimable ${gapPct}% of current spend (${sav != null ? usd(sav) : '—'}/mo available)`,
              )}
              {chip(
                <>Automation source <span style={{ opacity: 0.6 }}>ⓘ</span></>,
                `Automation source: ${autoSrc}`,
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-start' }}>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: '1px solid #dfe2ec', borderRadius: 8, padding: '6px 10px', fontSize: 12, color: '#475569', background: '#fff' }}>
                <svg style={{ width: 16, height: 16, color: '#94a3b8' }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
                  <rect x="3" y="5" width="18" height="16" rx="2" />
                  <path d="M8 3v4M16 3v4M3 10h18" />
                </svg>
                <select value={period} onChange={(e) => setPeriod(e.target.value)} style={{ background: 'transparent', border: 'none', outline: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, color: 'inherit' }}>
                  {PERIODS.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>
        </div>
      </div>

      {/* chart block */}
      <div style={{ padding: '0 20px 8px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div className="card" style={{ padding: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
            <label
              title={hasEph ? '' : 'No ephemeral-storage requests on this workload'}
              style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#64748b', cursor: hasEph ? 'pointer' : 'not-allowed', opacity: hasEph ? 1 : 0.5 }}
            >
              <input type="checkbox" disabled={!hasEph} checked={showEph} onChange={(e) => setShowEph(e.target.checked)} /> Show ephemeral storage
            </label>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <div style={{ textAlign: 'center', fontSize: 13, fontWeight: 700, color: '#475569', marginBottom: 4 }}>CPU over time</div>
              <UsageChart ts={cpuTs} hasJava={false} />
            </div>
            <div>
              <div style={{ textAlign: 'center', fontSize: 13, fontWeight: 700, color: '#475569', marginBottom: 4 }}>Memory over time</div>
              <UsageChart ts={memTs} hasJava={!!(memTs?.javaPoints || []).length} />
            </div>
          </div>
          {hasEph && showEph && (
            <div style={{ marginTop: 8 }}>
              <div style={{ textAlign: 'center', fontSize: 13, fontWeight: 700, color: '#475569', marginBottom: 4 }}>Ephemeral storage over time</div>
              <UsageChart ts={ephTs} hasJava={false} />
            </div>
          )}
          <div style={{ display: 'flex', flexWrap: 'wrap', columnGap: 12, rowGap: 4, justifyContent: 'center', fontSize: 11, color: '#64748b', marginTop: 8 }}>
            {TS_SERIES.map(([label, color, kind]) => (
              <span key={label} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <span
                  style={{
                    display: 'inline-block',
                    ...(kind === 'hatch'
                      ? { height: 8, width: 12, borderRadius: 2, background: `repeating-linear-gradient(45deg,${color},${color} 2px,transparent 2px,transparent 4px)` }
                      : { height: 8, width: 8, borderRadius: '50%', background: color }),
                  }}
                />
                {label}
              </span>
            ))}
          </div>
        </div>

        {/* Timeline */}
        <div className="card" style={{ padding: 12 }}>
          <div style={{ textAlign: 'center', fontSize: 13, fontWeight: 700, color: '#475569', marginBottom: 4 }}>Timeline</div>
          <TimelineStrip events={data.events || []} />
        </div>
      </div>

      {/* HPA / init / boot cards */}
      {(data.hpaConversions || []).length > 0 && (
        <div style={{ padding: '0 20px 4px' }}>
          <div className="card" style={{ padding: 12, borderColor: '#ede9fe', background: 'rgba(245,243,255,.3)' }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: '#8b5cf6', marginBottom: 4 }}>
              Horizontal scaling preserved (HPA/KEDA)
            </div>
            {(data.hpaConversions || []).map((c, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 0', fontSize: 12 }}>
                <span style={{ color: '#64748b' }}>
                  {c.source} · {c.resource}
                </span>
                <span className="num" style={{ color: '#64748b' }}>
                  {c.fromUtilization}% <span style={{ color: '#cbd5e1' }}>→</span>{' '}
                  <span style={{ color: '#7c3aed', fontWeight: 600 }}>{c.averageValue}</span>
                </span>
              </div>
            ))}
            <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 4 }}>
              Utilization triggers convert to absolute targetAverageValue off the original request.
            </div>
          </div>
        </div>
      )}
      {(data.initOptimization || []).length > 0 && (
        <div style={{ padding: '0 20px 4px' }}>
          <div className="card" style={{ padding: 12 }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: '#94a3b8', marginBottom: 4 }}>
              Init-container optimization{(data.initSavings || 0) > 0.5 ? ` · reclaims ${usd(data.initSavings)}/mo` : ''}
            </div>
            {(data.initOptimization || []).map((i) => (
              <div key={i.name} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 0', fontSize: 12 }}>
                <span style={{ color: '#64748b' }}>{i.name}</span>
                <span className="num" style={{ color: '#64748b' }}>
                  cpu {cpuFmt(i.recCpu)} · mem {memFmt(i.recMem)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
      {!!(data.signals?.boot || (data.bootCpu || 0) > 0) && (
        <div style={{ padding: '0 20px 4px' }}>
          <div className="card" style={{ padding: 12, borderColor: '#ede9fe', background: 'rgba(245,243,255,.3)' }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: '#8b5cf6', marginBottom: 4 }}>
              Boot-time optimization
            </div>
            <div style={{ fontSize: 12, color: '#64748b' }}>
              Startup CPU spike detected — CPU request raised by{' '}
              <span className="num" style={{ fontWeight: 600, color: '#7c3aed' }}>{cpuFmt(data.bootCpu || 0)}</span> for the boot window, then
              reduced to steady-state.
            </div>
          </div>
        </div>
      )}
      {(() => {
        const sig = data.signals as unknown as { heal?: boolean; healReason?: string } | undefined;
        if (!sig?.heal) return null;
        const burst = sig.healReason === 'BurstReaction';
        return (
          <div style={{ padding: '0 20px 4px' }}>
            <div className="card" style={{ padding: 12, borderColor: '#fee2e2', background: 'rgba(254,242,242,.35)' }}>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: '#ef4444', marginBottom: 4 }}>
                {burst ? 'Burst reaction active' : 'CPU-stress auto-healing active'}
              </div>
              <div style={{ fontSize: 12, color: '#64748b' }}>
                Sustained CPU pressure detected — the CPU recommendation is temporarily boosted to relieve throttling, and decays automatically once pressure clears.
              </div>
            </div>
          </div>
        );
      })()}

    </div>
  );
}
