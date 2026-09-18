// Java KPI strip — every value is feature-detected and falls back to totals / per-
// workload sums where honest, otherwise renders '—' (never fabricated).
import { useState, type CSSProperties } from 'react';
import { Cell, Pie, PieChart, ResponsiveContainer } from 'recharts';
import { postJson } from '../../api/client';
import { useFeedback } from '../../providers/FeedbackProvider';
import { usd, cpuFmt, memFmt } from '../../lib/format';
import type { JavaActionResponse, JavaResponse, JavaWorkload } from './types';

function DropBadge({ orig, opt }: { orig?: number | null; opt?: number | null }) {
  if (orig == null || opt == null || !(orig > 0)) return null;
  const d = Math.round((1 - opt / orig) * 100);
  if (!d) return null;
  return (
    <span style={{ fontWeight: 600, color: d > 0 ? '#16a34a' : '#f59e0b' }}>
      {d > 0 ? `(↓ ${d}%)` : `(↑ ${-d}%)`}
    </span>
  );
}

const isAutomated = (w: JavaWorkload) => (w.automated != null ? w.automated : !!w.javaAuto);

/** Sum a per-replica metric across the fleet (skips workloads without it). */
function fleetSum(ws: JavaWorkload[], pick: (w: JavaWorkload) => number | null | undefined): number | null {
  let sum = 0;
  let seen = false;
  for (const w of ws) {
    const v = pick(w);
    if (v == null) continue;
    seen = true;
    sum += v * (w.replicasDesired ?? w.replicas ?? 1);
  }
  return seen ? sum : null;
}

export default function JvKpiSection({
  data,
  ro,
  onReload,
}: {
  data: JavaResponse | null;
  ro: boolean;
  onReload: (ms: number) => void;
}) {
  const { toast, confirm } = useFeedback();
  const [win, setWin] = useState<'live' | '30d'>('live');

  const ws = data?.workloads || [];
  const t = data?.totals || {};
  const kpi = data?.kpi || {};

  // ---- feature-detected values (NEW kpi block → totals → honest fallbacks) ----
  const monthlyCost = kpi.monthlyCost ?? t.monthlyCost ?? null;
  const cpuCur = kpi.cpuRequestCurrent ?? fleetSum(ws, (w) => w.cpuRequest);
  // Original request QUANTITIES are not in the payload (totals only carry the
  // cost-model $ originals) — no fabrication: original falls back to current.
  const cpuOrig = kpi.cpuRequestOriginal ?? cpuCur;
  const memCur = kpi.memRequestCurrent ?? fleetSum(ws, (w) => w.memoryRequest ?? w.memRequest);
  const memOrig = kpi.memRequestOriginal ?? memCur;
  const wastedPct =
    kpi.wastedSpendPct ??
    t.wastedSpendPct ??
    (monthlyCost && monthlyCost > 0 ? ((t.savings || 0) / monthlyCost) * 100 : null);
  const overProv = kpi.overProvisioned ?? t.overProvisioned ?? null;
  const total = kpi.total ?? t.javaWorkloads ?? ws.length;
  const auto = kpi.automated ?? t.automated ?? ws.filter(isAutomated).length;
  const notAuto = Math.max((total || 0) - (auto || 0), 0);
  const pct = total ? Math.round(((auto || 0) / total) * 100) : 0;

  const automateAll = async () => {
    if (ro) {
      toast('Cluster is in READ-ONLY mode.\nSet readOnly: false in Helm values to enable automation.');
      return;
    }
    const targets = ws
      .filter((w) => !isAutomated(w))
      .map((w) => ({ namespace: w.namespace, kind: w.kind, name: w.name }));
    if (!targets.length) {
      toast('All Java workloads are already automated.');
      return;
    }
    if (!(await confirm(`Automate Java optimization for ${targets.length} workload(s)? This rolls the affected workloads.`)))
      return;
    try {
      const r = await postJson<JavaActionResponse>('/api/java/action', { scope: 'workload', action: 'automate', targets });
      toast(r.ok === false ? 'Failed: ' + (r.message || '') : `Automated ${r.count ?? targets.length} Java workload(s).`, r.ok === false ? undefined : 'ok');
    } catch {
      toast('Request failed.');
    }
    onReload(700);
  };

  return (
    <>
      {/* Live | 30 days switch */}
      <div style={{ display: 'inline-flex', gap: 2, width: 'max-content' }}>
        <span className={'tabline' + (win === 'live' ? ' active' : '')} onClick={() => setWin('live')}>Live</span>
        <span className={'tabline' + (win === '30d' ? ' active' : '')} onClick={() => setWin('30d')}>30 days</span>
      </div>

      <section style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 16, marginTop: 8 }}>
        {/* Monthly cost + Wasted spend */}
        <div className="card" style={{ padding: 16, display: 'grid', gridTemplateColumns: '1.2fr 1fr' }}>
          <div style={{ paddingRight: 16, borderRight: '1px solid #eef0f6' }}>
            <div style={{ textAlign: 'center', fontSize: 15, fontWeight: 600, color: '#1e2536' }}>
              Monthly cost{' '}
              <span style={{ color: '#cbd5e1', fontWeight: 400, fontSize: 12 }}>
                ({win === 'live' ? 'live' : '30 days'})
              </span>
            </div>
            <div
              className="num"
              title={monthlyCost == null ? 'Java fleet monthly cost — pending backend KPI block' : undefined}
              style={{ textAlign: 'center', marginTop: 4, fontSize: 36, lineHeight: 1, fontWeight: 700, letterSpacing: '-0.03em', color: '#4f46e5' }}
            >
              {monthlyCost != null ? usd(monthlyCost) : '$—'}
            </div>
            <div style={{ borderTop: '1px solid #eef0f6', marginTop: 12, paddingTop: 10, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, fontSize: 11 }}>
              {(
                [
                  ['CPU request', cpuFmt(cpuOrig), cpuFmt(cpuCur), cpuOrig, cpuCur],
                  ['Memory request', memFmt(memOrig), memFmt(memCur), memOrig, memCur],
                ] as [string, string, string, number | null, number | null][]
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
                {wastedPct != null ? Math.round(wastedPct) + '%' : '—%'}
              </div>
              <div style={{ width: '80%', height: 6, marginTop: 12, borderRadius: 999, background: '#e0e7ff', overflow: 'hidden' }}>
                <div
                  style={{
                    height: '100%',
                    background: '#fb7185',
                    borderRadius: 999,
                    transition: 'all .3s',
                    width: Math.max(0, Math.min(100, Math.round(wastedPct || 0))) + '%',
                  }}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Over-provisioned + Automated donut + Automate All */}
        <div className="card" style={{ padding: 16, display: 'flex', alignItems: 'stretch', gap: 16 }}>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, paddingRight: 16, borderRight: '1px solid #eef0f6' }}>
            <div
              style={{ fontSize: 13, fontWeight: 600, color: '#1e2536', textAlign: 'center', lineHeight: 1.3 }}
              title="Java workloads whose memory request exceeds the JVM-aware recommendation"
            >
              Java over provisioned workloads{' '}
              <span style={{ color: '#94a3b8', fontWeight: 400, cursor: 'help' }}>ⓘ</span>
            </div>
            <div className="num" style={{ fontSize: 32, lineHeight: 1, fontWeight: 700, color: overProv ? '#f59e0b' : '#94a3b8' }}>
              {data == null || overProv == null ? '—' : overProv || '–'}
            </div>
            <div style={{ width: '70%', height: 6, borderRadius: 999, background: '#e0e7ff', overflow: 'hidden' }}>
              <div
                style={{
                  height: '100%',
                  background: '#fbbf24',
                  borderRadius: 999,
                  width: total ? Math.min(100, Math.round(((overProv || 0) / total) * 100)) + '%' : '0%',
                }}
              />
            </div>
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
                    {data ? pct + '%' : '—%'}
                  </div>
                </div>
              </div>
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                <span style={{ fontSize: 24, fontWeight: 700, color: '#1e2536' }}>{data ? total : '—'}</span>
                <span style={{ fontSize: 12, color: '#64748b', fontWeight: 500 }}>Java workloads</span>
              </div>
              <div style={{ marginTop: 4, fontSize: 11 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ height: 8, width: 16, borderRadius: 999, background: '#22c55e' }} />
                  <span style={{ color: '#64748b' }}>automated</span>
                  <span style={{ marginLeft: 'auto', fontWeight: 600, color: '#1e2536' }}>{data ? auto : '—'}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}>
                  <span style={{ height: 8, width: 16, borderRadius: 999, background: '#e0e7ff' }} />
                  <span style={{ color: '#64748b' }}>un-automated</span>
                  <span style={{ marginLeft: 'auto', fontWeight: 600, color: '#1e2536' }}>{data ? notAuto : '—'}</span>
                </div>
              </div>
              <button onClick={automateAll} disabled={ro} style={automateBtn(ro)}>
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

const automateBtn = (ro: boolean): CSSProperties => ({
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
});
