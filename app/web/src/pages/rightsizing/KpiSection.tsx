// Top KPI row of /rightSizing/workloads
import { useEffect, useRef, useState } from 'react';
import { Area, AreaChart, Cell, Pie, PieChart, ResponsiveContainer } from 'recharts';
import { getJson, postJson } from '../../api/client';
import { usd, cpuFmt, memFmt } from '../../lib/format';
import { useClusterData, automationCounts } from '../../providers/ClusterDataProvider';
import { useFeedback } from '../../providers/FeedbackProvider';
import type { AnalyticsGraphResponse } from './types';
import type { CustomWorkloadsResponse } from '../../api/types';

const HIST: { t: number; cost: number; waste: number }[] = [];
const MAXPTS = 40;

function DropBadge({ orig, opt }: { orig?: number | null; opt?: number | null }) {
  const d = orig && orig > 0 ? Math.round((1 - (opt || 0) / orig) * 100) : 0;
  if (!d) return null;
  return (
    <span style={{ fontWeight: 600, color: d > 0 ? '#16a34a' : '#f59e0b' }}>
      {d > 0 ? `(↓ ${d}%)` : `(↑ ${-d}%)`}
    </span>
  );
}

function Spark({ data, color, fill }: { data: number[]; color: string; fill: string }) {
  const series = data.length === 1 ? [data[0], data[0]] : data;
  const pts = series.map((v, i) => ({ i, v }));
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={pts} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
        <Area type="monotone" dataKey="v" stroke={color} strokeWidth={2} fill={fill} isAnimationActive={false} dot={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export default function KpiSection({ onIssueFilter, onUnrecognized }: {
  onIssueFilter: (chip: 'under' | 'inits') => void;
  onUnrecognized: () => void;
}) {
  const { overview: ov, workloads, ro, refresh } = useClusterData();
  const { toast, confirm } = useFeedback();
  const [win, setWin] = useState<'live' | '30d'>('live');
  const [g30, setG30] = useState<{ cost: number[] } | null>(null);
  const [unrec, setUnrec] = useState<number>(0);
  const [, force] = useState(0);
  const lastT = useRef(0);

  // accumulate the live sparkline ring buffer from polls
  useEffect(() => {
    if (!ov || !ov.lastUpdate || ov.lastUpdate === lastT.current) return;
    lastT.current = ov.lastUpdate;
    HIST.push({ t: ov.lastUpdate, cost: ov.monthlyCost || 0, waste: ov.savingsPct || 0 });
    if (HIST.length > MAXPTS) HIST.shift();
    force((n) => n + 1);
  }, [ov]);

  useEffect(() => {
    if (win !== '30d') return;
    let dead = false;
    getJson<AnalyticsGraphResponse>('/api/analytics/graph?range=30d&groupBy=day&types=requestsCostMonthly')
      .then((c) => {
        if (dead) return;
        setG30({
          cost: (c.values || []).map((p) => p.values.requestsCostMonthly ?? 0) as number[],
        });
      })
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [win]);

  useEffect(() => {
    let dead = false;
    getJson<CustomWorkloadsResponse>('/api/custom-workloads')
      .then((d) => !dead && setUnrec(d.totals?.unrecognizedPods || 0))
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [ov]);

  const origCpu = ov?.origCpu != null ? ov.origCpu : ov?.reqCpu;
  const origMem = ov?.origMem != null ? ov.origMem : ov?.reqMem;
  const wastePct = Math.round(ov?.savingsPct || 0);
  const { auto, total, pct } = automationCounts(ov);
  const notAuto = Math.max(total - auto, 0);
  const sig = ov?.signals || {};

  const costSeries = win === 'live' ? HIST.map((h) => h.cost) : g30?.cost || [];

  const automateAll = async () => {
    if (ro) {
      toast('Cluster is in READ-ONLY mode.\nSet readOnly: false in Helm values to enable automation.');
      return;
    }
    const targets = workloads.filter((w) => w.sizable && !w.automated && !w.excluded);
    if (!targets.length) {
      toast('All eligible workloads are already automated.');
      return;
    }
    if (!(await confirm(`Enable automation for the entire cluster (${targets.length} workload(s), current + future)?`)))
      return;
    await postJson('/api/automate-bulk', { scope: 'cluster', enabled: true }).catch(() => {});
    toast('Cluster automated successfully', 'ok');
    refresh();
  };

  const issCls = (n: number) => ({ fontWeight: 700, flexShrink: 0, color: n > 0 ? '#f43f5e' : '#cbd5e1' });

  return (
    <>
      {/* Live | 30 days switch */}
      <div style={{ display: 'inline-flex', gap: 2, width: 'max-content' }}>
        <span className={'tabline' + (win === 'live' ? ' active' : '')} onClick={() => setWin('live')}>Live</span>
        <span className={'tabline' + (win === '30d' ? ' active' : '')} onClick={() => setWin('30d')}>30 days</span>
      </div>

      <section style={{ display: 'grid', gridTemplateColumns: '1.9fr 1fr', gap: 16, marginTop: 8 }}>
        {/* Monthly cost + Wasted spend */}
        <div className="card" style={{ padding: 16, display: 'grid', gridTemplateColumns: '1fr 1fr' }}>
          <div style={{ paddingRight: 16, borderRight: '1px solid #eef0f6' }}>
            <div style={{ textAlign: 'center', fontSize: 15, fontWeight: 600, color: '#1e2536' }}>
              Monthly cost{' '}
              <span style={{ color: '#cbd5e1', fontWeight: 400, fontSize: 12 }}>
                ({win === 'live' ? 'live' : '30 days'})
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'center', gap: 12, marginTop: 4 }}>
              <div className="num" style={{ fontSize: 36, lineHeight: 1, fontWeight: 700, letterSpacing: '-0.03em', color: '#4f46e5' }}>
                {ov ? usd(ov.monthlyCost) : '$—'}
              </div>
              <div style={{ width: 96, height: 38 }}>
                <Spark data={costSeries} color="#6366f1" fill="rgba(99,102,241,.14)" />
              </div>
            </div>
            <div style={{ borderTop: '1px solid #eef0f6', marginTop: 12, paddingTop: 10, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, fontSize: 11 }}>
              {(
                [
                  ['CPU request', cpuFmt(origCpu), cpuFmt(ov?.reqCpu), origCpu, ov?.reqCpu],
                  ['Memory request', memFmt(origMem), memFmt(ov?.reqMem), origMem, ov?.reqMem],
                ] as [string, string, string, number | null | undefined, number | null | undefined][]
              ).map(([label, a, b, oa, ob]) => (
                <div key={label}>
                  <div style={{ color: '#64748b', fontWeight: 600 }}>
                    {label} <DropBadge orig={oa} opt={ob} />
                  </div>
                  <div className="num" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 15, fontWeight: 700, marginTop: 2 }}>
                    <span style={{ color: '#1e2536' }}>{a}</span>
                    <span style={{ color: '#cbd5e1', fontSize: 12 }}>⇒</span>
                    <span style={{ color: '#16a34a' }}>{b}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: '#94a3b8' }}>
                    <span>⛁ Original</span>
                    <span style={{ marginLeft: 'auto', marginRight: 4 }}>⚡ Current</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Wasted spend */}
          <div style={{ paddingLeft: 16, display: 'flex', flexDirection: 'column' }}>
            <div style={{ textAlign: 'center', fontSize: 15, fontWeight: 600, color: '#1e2536' }}>Wasted spend</div>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
              <div className="num" style={{ fontSize: 40, lineHeight: 1, fontWeight: 700, letterSpacing: '-0.03em', color: '#f43f5e' }}>
                {ov ? wastePct + '%' : '—%'}
              </div>
              <div style={{ width: '80%', height: 6, marginTop: 12, borderRadius: 999, background: '#e0e7ff', overflow: 'hidden' }}>
                <div
                  style={{
                    height: '100%',
                    background: '#fb7185',
                    borderRadius: 999,
                    transition: 'all .3s',
                    width: Math.max(0, Math.min(100, wastePct)) + '%',
                  }}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Issues + Automated donut + Automate All */}
        <div className="card" style={{ padding: 16, display: 'flex', alignItems: 'stretch', gap: 16 }}>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 10, paddingRight: 16, borderRight: '1px solid #eef0f6', fontSize: 12 }}>
            <button onClick={() => onIssueFilter('under')} style={btnReset}>
              <div>
                <div style={{ fontWeight: 600, color: '#4f46e5', textDecoration: 'underline', textDecorationColor: '#c7d2fe', lineHeight: 1.25 }}>
                  Under provisioned workloads
                </div>
                <div style={{ fontSize: 10, color: '#94a3b8', textDecoration: 'underline', textDecorationColor: '#e2e8f0' }}>
                  CPU, Memory and Ephemeral Storage
                </div>
              </div>
              <span style={issCls(sig.underProvisioned || 0)}>{sig.underProvisioned || 0}</span>
            </button>
            <button onClick={() => onIssueFilter('inits')} style={btnReset}>
              <div style={{ fontWeight: 600, color: '#4f46e5', textDecoration: 'underline', textDecorationColor: '#c7d2fe', lineHeight: 1.25 }}>
                Unoptimized workloads with init containers
              </div>
              <span style={issCls(sig.initOpt || 0)}>{sig.initOpt || 0}</span>
            </button>
            <button onClick={onUnrecognized} style={{ ...btnReset, alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontWeight: 600, color: '#4f46e5', textDecoration: 'underline', textDecorationColor: '#c7d2fe' }}>
                  Unrecognized Pods
                </span>
                <span style={{ fontSize: 10, color: '#64748b', border: '1px solid #c9cddc', borderRadius: 4, padding: '2px 6px', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <svg style={{ width: 10, height: 10 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4}>
                    <circle cx="11" cy="11" r="7" />
                    <path d="M21 21l-4-4" />
                  </svg>
                  Explore more
                </span>
              </div>
              <span style={issCls(unrec)}>{unrec}</span>
            </button>
          </div>

          {/* automation donut */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
            <div style={{ position: 'relative', width: 104, height: 104, flexShrink: 0 }}>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={total ? [{ v: auto }, { v: notAuto }] : [{ v: 0 }, { v: 1 }]}
                    dataKey="v"
                    innerRadius="74%"
                    outerRadius="100%"
                    startAngle={90}
                    endAngle={-270}
                    stroke="none"
                    isAnimationActive={false}
                  >
                    <Cell fill="#22c55e" />
                    <Cell fill="#e7e9f0" />
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
              <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: '#1e2536', lineHeight: 1.2 }}>Automated</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: '#16a34a', lineHeight: 1, marginTop: 2 }}>
                    {ov ? pct + '%' : '—%'}
                  </div>
                </div>
              </div>
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                <span style={{ fontSize: 24, fontWeight: 700, color: '#1e2536' }}>{ov ? total : '—'}</span>
                <span style={{ fontSize: 12, color: '#64748b', fontWeight: 500 }}>Rightsize workloads</span>
              </div>
              <div style={{ marginTop: 4, fontSize: 11 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ height: 8, width: 16, borderRadius: 999, background: '#22c55e' }} />
                  <span style={{ color: '#64748b' }}>automated</span>
                  <span style={{ marginLeft: 'auto', fontWeight: 600, color: '#1e2536' }}>{ov ? auto : '—'}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}>
                  <span style={{ height: 8, width: 16, borderRadius: 999, background: '#e0e7ff' }} />
                  <span style={{ color: '#64748b' }}>un-automated</span>
                  <span style={{ marginLeft: 'auto', fontWeight: 600, color: '#1e2536' }}>{ov ? notAuto : '—'}</span>
                </div>
              </div>
              <button
                onClick={automateAll}
                disabled={ro}
                style={{
                  marginTop: 8,
                  width: '100%',
                  fontSize: 13,
                  fontWeight: 600,
                  color: '#fff',
                  background: '#22c55e',
                  border: 'none',
                  borderRadius: 8,
                  padding: '6px 0',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                  cursor: ro ? 'not-allowed' : 'pointer',
                  opacity: ro ? 0.5 : 1,
                  fontFamily: 'inherit',
                }}
              >
                <svg style={{ width: 14, height: 14 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
                  <circle cx="12" cy="12" r="9" />
                  <path d="M10 8.5l5 3.5-5 3.5z" fill="currentColor" stroke="none" />
                </svg>
                Automate All
              </button>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

const btnReset: React.CSSProperties = {
  width: '100%',
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 8,
  textAlign: 'left',
  background: 'transparent',
  border: 'none',
  padding: 0,
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 12,
};
