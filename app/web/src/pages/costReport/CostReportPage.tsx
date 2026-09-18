// Cost Report - (range==='30d'?30:7)days, to = now.
import { useEffect, useMemo, useState } from 'react';

const fmtGib = (b: number): string => {
  if (!b || b <= 0) return '0';
  const gib = b / 2 ** 30;
  if (gib >= 1) return gib.toFixed(2) + ' GiB';
  return (b / 2 ** 20).toFixed(0) + ' MiB';
};
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { getJson, postJson } from '../../api/client';
import { useFeedback } from '../../providers/FeedbackProvider';
import { usd } from '../../lib/format';
import '../rightsizing/rightsizing.css';
import { dollarAxis, type GraphResponse } from '../analytics/lib';
import SeriesChart, { Legend, type SeriesSpec } from '../analytics/SeriesChart';
import type {
  CostByNamespace,
  CostConfigResponse,
  CostOverTimePoint,
  CostReportResponse,
  RbacResponse,
} from './types';

const CR_PALETTE = [
  '#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#06b6d4', '#8b5cf6', '#ec4899', '#84cc16',
  '#f97316', '#14b8a6', '#a855f7', '#3b82f6', '#eab308', '#f43f5e', '#10b981', '#64748b',
  '#0ea5e9', '#d946ef', '#65a30d', '#dc2626', '#94a3b8',
];

const costSeries: SeriesSpec[] = [
  { key: 'requestsCostMonthly', label: 'Current request cost', color: '#ef4444', fill: 'rgba(239,68,68,.08)' },
  { key: 'recommendedCostMonthly', label: 'Right-sized cost', color: '#22c55e', dash: '4 3' },
];

const cardTitle: React.CSSProperties = { fontSize: 14, fontWeight: 700, color: '#1e2536' };
const th: React.CSSProperties = {
  textAlign: 'left',
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: '.04em',
  color: '#94a3b8',
  fontWeight: 600,
  padding: '8px 12px',
  borderBottom: '1px solid #eef0f6',
};
const thR: React.CSSProperties = { ...th, textAlign: 'right' };
const td: React.CSSProperties = { padding: '8px 12px', fontSize: 12, borderBottom: '1px solid #f3f4f9' };
const tdR: React.CSSProperties = { ...td, textAlign: 'right' };

function csvEscape(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function downloadCsv(name: string, rows: (string | number)[][]) {
  const blob = new Blob([rows.map((r) => r.map(csvEscape).join(',')).join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

function EmptyRow({ n, msg }: { n: number; msg?: string }) {
  return (
    <tr>
      <td colSpan={n} style={{ padding: '24px 16px', textAlign: 'center', color: '#94a3b8', fontSize: 12 }}>
        {msg || 'no data'}
      </td>
    </tr>
  );
}

/** crBuildStack() port — stacked per-workload $ rate over time (top 20 + other). */
function StackChart({ series }: { series: CostOverTimePoint[] }) {
  const { data, ids } = useMemo(() => {
    const idList: string[] = [];
    series.forEach((p) => (p.costs || []).forEach((c) => {
      if (!idList.includes(c.id)) idList.push(c.id);
    }));
    const rows = series.map((p) => {
      const d = new Date(p.timestamp);
      const row: Record<string, string | number> = {
        __label:
          d.getMonth() + 1 + '/' + d.getDate() + ' ' +
          String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'),
      };
      for (const id of idList) {
        const c = (p.costs || []).find((x) => x.id === id);
        row[id] = c ? c.value : 0;
      }
      return row;
    });
    return { data: rows, ids: idList };
  }, [series]);
  const short = (id: string) => (id === 'other' ? 'other' : id.split('/').slice(-1)[0]);
  return (
    <div style={{ height: 208 }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <XAxis dataKey="__label" tick={{ fontSize: 9, fill: '#94a3b8' }} tickLine={false} axisLine={false} minTickGap={80} />
          <YAxis
            tick={{ fontSize: 9, fill: '#94a3b8' }}
            tickFormatter={(v: number) => usd(v)}
            tickLine={false}
            axisLine={false}
            width={48}
            domain={[0, 'auto']}
          />
          <Tooltip
            formatter={(v: unknown, name: unknown) =>
              [typeof v === 'number' ? usd(v) : '—', short(String(name))] as [string, string]
            }
            labelStyle={{ fontSize: 11 }}
            itemStyle={{ fontSize: 11, padding: 0 }}
            contentStyle={{ borderRadius: 8, border: '1px solid #e9eaf0', fontSize: 11, maxHeight: 260, overflow: 'hidden' }}
          />
          {ids.map((id, i) => {
            const col = CR_PALETTE[i % CR_PALETTE.length];
            return (
              <Area
                key={id}
                type="monotone"
                dataKey={id}
                stackId="a"
                stroke={col}
                strokeWidth={1}
                fill={col + '55'}
                fillOpacity={1}
                dot={false}
                isAnimationActive={false}
              />
            );
          })}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

const numInput: React.CSSProperties = {
  width: '100%',
  background: '#fff',
  border: '1px solid #e3e5ee',
  borderRadius: 8,
  padding: '6px 10px',
  fontSize: 12,
  outline: 'none',
  fontFamily: 'inherit',
  color: '#1e2536',
  boxSizing: 'border-box',
};

/** renderCostSettings()/costSettingsSave() port — editable /api/cost/config. */
function CostSettingsCard() {
  const { toast } = useFeedback();
  const [err, setErr] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [unalloc, setUnalloc] = useState(false);
  const [vals, setVals] = useState<Record<string, string>>({});

  const load = async () => {
    try {
      const d = await getJson<CostConfigResponse>('/api/cost/config');
      const cc = d.costConfig || {};
      const crp = cc.customResourcesPricing || {};
      const man = crp.manual || {};
      const spot = crp['manual-spot'] || {};
      setUnalloc(!!cc.includeUnallocatedCost);
      const s = (v: number | null | undefined) => (v == null ? '' : String(v));
      setVals({
        ccCpu: s(man.cpu), ccMem: s(man.memory), ccGpu: s(man.gpu),
        ccSpotCpu: s(spot.cpu), ccSpotMem: s(spot.memory), ccSpotGpu: s(spot.gpu),
      });
      setLoaded(true);
      setErr(false);
    } catch {
      setErr(true);
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async () => {
    const num = (id: string) => (vals[id] === '' || vals[id] == null ? null : Number(vals[id]));
    const body = {
      costConfig: {
        includeUnallocatedCost: unalloc,
        customResourcesPricing: {
          manual: { cpu: num('ccCpu'), memory: num('ccMem'), gpu: num('ccGpu') },
          'manual-spot': { cpu: num('ccSpotCpu'), memory: num('ccSpotMem'), gpu: num('ccSpotGpu') },
        },
      },
    };
    try {
      const r = await postJson<{ ok?: boolean; error?: string }>('/api/cost/config', body);
      if (r && r.ok) {
        toast('Cost settings saved — pricing applied live');
        void load();
      } else toast('Save failed' + (r && r.error ? ': ' + r.error : ''), 'error');
    } catch (e) {
      toast('Save failed: ' + e, 'error');
    }
  };

  const fields: [string, string][] = [
    ['ccCpu', 'On-demand CPU ($/core·h)'],
    ['ccMem', 'On-demand memory ($/GB·h)'],
    ['ccGpu', 'On-demand GPU ($/GPU·h)'],
    ['ccSpotCpu', 'Spot CPU ($/core·h)'],
    ['ccSpotMem', 'Spot memory ($/GB·h)'],
    ['ccSpotGpu', 'Spot GPU ($/GPU·h)'],
  ];

  return (
    <section className="card" style={{ padding: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
        <div style={cardTitle}>Cost settings</div>
        <button
          onClick={() => void save()}
          style={{
            padding: '6px 12px',
            fontSize: 12,
            fontWeight: 600,
            borderRadius: 8,
            background: '#6366f1',
            color: '#fff',
            border: 'none',
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          Save
        </button>
      </div>
      <p style={{ fontSize: 12, color: '#64748b', margin: '0 0 12px' }}>
        Hourly per-resource pricing used by the cost model (CPU per core·h, memory per GB·h, GPU per GPU·h). Saved to
        the <code>coolscaler-cost-config</code> ConfigMap and applied live.
      </p>
      {err ? (
        <div style={{ color: '#94a3b8', fontSize: 12 }}>cost config unavailable</div>
      ) : !loaded ? (
        <div style={{ color: '#94a3b8', fontSize: 12 }}>loading…</div>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 12 }}>
            {fields.map(([id, label]) => (
              <div key={id}>
                <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>{label}</div>
                <input
                  type="number"
                  step="any"
                  min={0}
                  className="num"
                  value={vals[id] ?? ''}
                  onChange={(e) => setVals((v) => ({ ...v, [id]: e.target.value }))}
                  style={numInput}
                />
              </div>
            ))}
          </div>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 12, color: '#475569' }}>
            <input type="checkbox" checked={unalloc} onChange={(e) => setUnalloc(e.target.checked)} />
            Include unallocated cost
          </label>
        </>
      )}
    </section>
  );
}

export default function CostReportPage() {
  const [range, setRange] = useState<'7d' | '30d'>('7d');
  const [aggTab, setAggTab] = useState<'aggregations' | 'workloads'>('workloads');
  const [aggMetric, setAggMetric] = useState<'cost' | 'savings'>('cost');
  const [report, setReport] = useState<CostReportResponse | null>(null);
  const [reportErr, setReportErr] = useState(false);
  const [costGraph, setCostGraph] = useState<GraphResponse['values']>([]);
  const [rbac, setRbac] = useState<RbacResponse | null>(null);
  const [rbacErr, setRbacErr] = useState(false);

  useEffect(() => {
    let dead = false;
    getJson<GraphResponse>('/api/analytics/graph?range=7d&groupBy=hour&types=requestsCostMonthly&types=recommendedCostMonthly')
      .then((g) => {
        if (!dead) setCostGraph(g.values || []);
      })
      .catch(() => {});
    getJson<RbacResponse>('/api/auth/rbac')
      .then((r) => {
        if (!dead) setRbac(r);
      })
      .catch(() => {
        if (!dead) setRbacErr(true);
      });
    return () => {
      dead = true;
    };
  }, []);

  // /api/cost-report with from/to millis derived from the 7d/30d range.
  useEffect(() => {
    let dead = false;
    const to = Date.now();
    const from = to - (range === '30d' ? 30 : 7) * 86400000;
    getJson<CostReportResponse>('/api/cost-report?from=' + from + '&to=' + to)
      .then((d) => {
        if (!dead) {
          setReport(d);
          setReportErr(false);
        }
      })
      .catch(() => {
        if (!dead) setReportErr(true);
      });
    return () => {
      dead = true;
    };
  }, [range]);

  const t = report?.totals || {};
  const cot = report?.costOverTime || [];
  const rules = rbac?.rules || [];
  const join = (a?: string[]) => (a && a.length ? a.join(', ') : '—');

  const exportCsv = () => {
    const rows: (string | number)[][] = [['Section', 'Name', 'Namespace', 'Kind', 'Cost/mo', 'Savings', 'Workloads', 'Pods', 'InstanceType', 'Lifecycle']];
    for (const n of report?.byNamespace || [])
      rows.push(['Namespace', n.namespace, n.namespace, '', n.monthlyCost ?? '', n.savings ?? '', n.workloads ?? '', n.pods ?? '', '', '']);
    for (const w of report?.topWorkloads || [])
      rows.push(['Workload', w.name, w.namespace, w.kind, w.monthlyCost ?? '', w.savings ?? '', '', '', '', '']);
    for (const nd of report?.byNode || [])
      rows.push(['Node', nd.name, '', '', nd.monthlyCost ?? '', '', '', nd.runningPods ?? '', nd.instanceType || '', nd.lifecycle || '']);
    downloadCsv('CostReport.csv', rows);
  };

  const rangeBtn = (r: '7d' | '30d'): React.CSSProperties => ({
    padding: '4px 10px',
    fontSize: 11,
    fontWeight: 600,
    borderRadius: 8,
    border: 'none',
    cursor: 'pointer',
    fontFamily: 'inherit',
    background: range === r ? '#6366f1' : '#f1f5f9',
    color: range === r ? '#fff' : '#64748b',
  });

  return (
    <main style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* header */}
      <section style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ height: 32, width: 32, borderRadius: 8, background: '#eef2ff', display: 'grid', placeItems: 'center' }}>
            <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth={1.8}>
              <path d="M4 5h16v14H4z" />
              <path d="M4 9h16M8 13h5" />
            </svg>
          </div>
          <div>
            <h1 style={{ fontSize: 17, fontWeight: 700, color: '#1e2536', margin: 0 }}>Cost Report</h1>
            <p style={{ fontSize: 12, color: '#64748b', margin: 0 }}>
              Monthly cost &amp; reclaimable savings by namespace, workload and node.
            </p>
          </div>
        </div>
        <button
          onClick={exportCsv}
          disabled={!report}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, border: '1px solid #e3e5ee', borderRadius: 999,
            background: '#fff', color: report ? '#475569' : '#c3c9d6', fontSize: 13, fontWeight: 600,
            fontFamily: 'inherit', padding: '7px 16px', cursor: report ? 'pointer' : 'default',
          }}
        >
          Export
          <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M12 3v12M7 10l5 5 5-5M5 21h14" /></svg>
        </button>
      </section>

      {/* cloud-integration honesty note */}
      <section
        className="card"
        style={{
          padding: 12,
          borderColor: '#e0e7ff',
          background: 'rgba(238,242,255,.4)',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth={1.8} style={{ flexShrink: 0 }}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8h.01M11 12h1v4h1" />
        </svg>
        <div style={{ fontSize: 12, color: '#475569' }}>
          {report?.cloudIntegration?.note ||
            'Cost is modeled from node resources; no cloud Cost & Usage Report is connected on this cluster.'}
        </div>
      </section>

      {/* totals tiles */}
      <section className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)' }}>
          {(
            [
              ['Monthly node cost', t.monthlyNodeCost, '#4f46e5'],
              ['Monthly workload cost', t.monthlyWorkloadCost, '#1e2536'],
              ['Savings available', t.monthlySavingsAvailable, '#16a34a'],
            ] as [string, number | undefined, string][]
          ).map(([label, v, color], i) => (
            <div key={label} style={{ padding: 20, textAlign: 'center', borderLeft: i ? '1px solid #eef0f6' : 'none' }}>
              <div style={{ fontSize: 12, fontWeight: 500, color: '#64748b' }}>{label}</div>
              <div className="num" style={{ marginTop: 4, fontSize: 26, lineHeight: 1, fontWeight: 700, color }}>
                {report ? usd(v) : '—'}
              </div>
            </div>
          ))}
          <div style={{ padding: 20, textAlign: 'center', borderLeft: '1px solid #eef0f6' }}>
            <div style={{ fontSize: 12, fontWeight: 500, color: '#64748b' }}>Savings %</div>
            <div className="num" style={{ marginTop: 4, fontSize: 26, lineHeight: 1, fontWeight: 700, color: '#16a34a' }}>
              {report ? (t.savingsPct || 0) + '%' : '—'}
            </div>
          </div>
        </div>
      </section>

      {/* Cost over time */}
      <section className="card" style={{ padding: 20 }}>
        <div style={{ ...cardTitle, marginBottom: 4 }}>Cost over time</div>
        <div style={{ marginBottom: 8, display: 'flex', justifyContent: 'flex-start' }}>
          <Legend
            square
            items={[
              ['#ef4444', 'Current request cost'],
              ['#22c55e', 'Right-sized cost'],
            ]}
          />
        </div>
        <SeriesChart values={costGraph || []} series={costSeries} yFmt={dollarAxis} height={176} />
      </section>

      {/* Cost over time by workload (stacked) */}
      <section className="card" style={{ padding: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <div style={cardTitle}>Cost over time by workload</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <button style={rangeBtn('7d')} onClick={() => setRange('7d')}>
              7d
            </button>
            <button style={rangeBtn('30d')} onClick={() => setRange('30d')}>
              30d
            </button>
          </div>
        </div>
        <StackChart series={cot} />
        <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 6 }}>
          {cot.length
            ? 'Stacked monthly-cost rate per workload (top 20 + other), sampled at every refresh — history starts when the recommender started.'
            : 'No cost samples in this range yet — the recorder samples at every refresh from recommender start.'}
        </div>
      </section>

      {/* Cost by aggregation */}
      <section className="card" style={{ padding: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div style={cardTitle}>Cost by aggregation <span style={{ fontSize: 11, fontWeight: 400, color: '#94a3b8' }}>· namespaces · entire window</span></div>
          <select value={aggMetric} onChange={(e) => setAggMetric(e.target.value as 'cost' | 'savings')} style={{ border: '1px solid #dfe2ec', borderRadius: 8, background: '#fff', color: '#475569', fontSize: 12.5, fontFamily: 'inherit', padding: '6px 10px', outline: 'none', cursor: 'pointer' }}>
            <option value="cost">Cost</option>
            <option value="savings">Savings Available</option>
          </select>
        </div>
        {(() => {
          const rows = (report?.byNamespace || []).slice();
          const val = (n: CostByNamespace) => (aggMetric === 'cost' ? n.monthlyCost || 0 : n.savings || 0);
          rows.sort((a, b) => val(b) - val(a));
          const topN = rows.slice(0, 10);
          const others = rows.slice(10).reduce((acc, r) => acc + val(r), 0);
          const bars = [...topN.map((r) => ({ label: r.namespace, v: val(r) })), ...(others > 0 ? [{ label: 'others', v: others }] : [])];
          const max = Math.max(1e-9, ...bars.map((b) => b.v));
          return (
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 14, height: 190, padding: '0 8px' }}>
              {bars.map((b) => (
                <div key={b.label} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, minWidth: 0 }}>
                  <span style={{ fontSize: 10.5, color: '#64748b' }}>{usd(b.v)}</span>
                  <div title={`${b.label}: ${usd(b.v)}`} style={{ width: '70%', height: Math.max(3, (b.v / max) * 140), background: '#a5b4fc', borderRadius: '6px 6px 0 0' }} />
                  <span style={{ fontSize: 10, color: '#64748b', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.label}</span>
                </div>
              ))}
              {!bars.length && <div style={{ margin: 'auto', color: '#94a3b8', fontSize: 13 }}>No cost data.</div>}
            </div>
          );
        })()}
      </section>

      {/* Workloads / Aggregations tabs */}
      <section className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', borderBottom: '1px solid #eef0f6', padding: '0 12px', gap: 4 }}>
          {(['workloads', 'aggregations'] as const).map((t) => (
            <button key={t} onClick={() => setAggTab(t)} style={{ border: 'none', background: 'transparent', fontFamily: 'inherit', fontSize: 14, padding: '10px 18px', cursor: 'pointer', color: aggTab === t ? '#1e2536' : '#64748b', fontWeight: aggTab === t ? 700 : 500, borderBottom: aggTab === t ? '2px solid #4338ca' : '2px solid transparent', textTransform: 'capitalize' }}>
              {t}
            </button>
          ))}
        </div>
        <div style={{ overflowX: 'auto' }}>
          {aggTab === 'aggregations' ? (
            <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ ...th, padding: '8px 16px' }}>Name</th>
                  <th style={th}>Cluster</th>
                  <th style={thR}>Total Cost</th>
                  <th style={thR}>Savings Available</th>
                  <th style={thR}>Spot %</th>
                  <th style={thR}>On-demand %</th>
                  <th style={thR}>CPU Request</th>
                  <th style={thR}>Memory Request</th>
                </tr>
              </thead>
              <tbody>
                {reportErr ? (
                  <EmptyRow n={8} msg="cost report unavailable" />
                ) : (report?.byNamespace || []).length ? (
                  (report?.byNamespace || []).map((n) => (
                    <tr key={n.namespace}>
                      <td style={{ ...td, padding: '8px 16px', fontWeight: 500, color: '#1e2536' }}>{n.namespace}</td>
                      <td style={{ ...td, color: '#64748b' }}>{report?.clusterName || ''}</td>
                      <td className="num" style={{ ...tdR, color: '#475569' }}>{usd(n.monthlyCost)}</td>
                      <td className="num" style={{ ...tdR, color: '#16a34a', fontWeight: 600 }}>{usd(n.savings)}</td>
                      <td className="num" style={{ ...tdR, color: '#64748b' }}>{n.spotPct == null ? '—' : n.spotPct + '%'}</td>
                      <td className="num" style={{ ...tdR, color: '#64748b' }}>{n.onDemandPct == null ? '—' : n.onDemandPct + '%'}</td>
                      <td className="num" style={{ ...tdR, color: '#475569' }}>{(n.cpuRequest ?? 0).toFixed(2)}</td>
                      <td className="num" style={{ ...tdR, color: '#475569' }}>{fmtGib(n.memRequest ?? 0)}</td>
                    </tr>
                  ))
                ) : (
                  <EmptyRow n={8} />
                )}
              </tbody>
            </table>
          ) : (
            <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ ...th, padding: '8px 16px' }}>Workload</th>
                  <th style={th}>Type</th>
                  <th style={th}>Namespace</th>
                  <th style={th}>Cluster</th>
                  <th style={thR}>Total Cost</th>
                  <th style={thR}>Savings Available</th>
                  <th style={thR}>CPU Request</th>
                  <th style={thR}>Memory Request</th>
                </tr>
              </thead>
              <tbody>
                {(report?.topWorkloads || []).length ? (
                  (report?.topWorkloads || []).map((w) => (
                    <tr key={w.namespace + '/' + w.kind + '/' + w.name}>
                      <td style={{ ...td, padding: '8px 16px', fontWeight: 500, color: '#1e2536' }}>{w.name}</td>
                      <td style={{ ...td, color: '#64748b' }}>{w.kind}</td>
                      <td style={{ ...td, color: '#64748b' }}>{w.namespace}</td>
                      <td style={{ ...td, color: '#64748b' }}>{report?.clusterName || ''}</td>
                      <td className="num" style={{ ...tdR, color: '#475569' }}>{usd(w.monthlyCost)}</td>
                      <td className="num" style={{ ...tdR, color: '#16a34a', fontWeight: 600 }}>{usd(w.savings)}</td>
                      <td className="num" style={{ ...tdR, color: '#475569' }}>{(w.cpuRequest ?? 0).toFixed(2)}</td>
                      <td className="num" style={{ ...tdR, color: '#475569' }}>{fmtGib(w.memRequest ?? 0)}</td>
                    </tr>
                  ))
                ) : (
                  <EmptyRow n={8} />
                )}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {/* by node */}
      <section className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid #eef0f6', ...cardTitle }}>Cost by node</div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ ...th, padding: '8px 16px' }}>Node</th>
                <th style={th}>Instance type</th>
                <th style={th}>Lifecycle</th>
                <th style={thR}>Cost/mo</th>
                <th style={thR}>Pods</th>
              </tr>
            </thead>
            <tbody>
              {(report?.byNode || []).length ? (
                (report?.byNode || []).map((n) => (
                  <tr key={n.name}>
                    <td style={{ ...td, padding: '8px 16px', fontWeight: 500, color: '#1e2536' }}>{n.name}</td>
                    <td style={{ ...td, color: '#64748b' }}>{n.instanceType}</td>
                    <td style={td}>
                      {n.lifecycle === 'spot' ? (
                        <span className="pill" style={{ background: '#f5f3ff', color: '#7c3aed' }}>Spot</span>
                      ) : (
                        <span className="pill" style={{ background: '#f1f5f9', color: '#64748b' }}>On-Demand</span>
                      )}
                    </td>
                    <td className="num" style={{ ...tdR, color: '#475569' }}>{usd(n.monthlyCost)}</td>
                    <td className="num" style={{ ...tdR, color: '#64748b' }}>{n.runningPods}</td>
                  </tr>
                ))
              ) : (
                <EmptyRow n={5} />
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Access & RBAC */}
      <section className="card" style={{ padding: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <div style={cardTitle}>Access &amp; RBAC</div>
          <span style={{ fontSize: 11, color: '#94a3b8' }}>
            {rbac ? rules.length + ' rule' + (rules.length === 1 ? '' : 's') : '—'}
          </span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 12, fontSize: 12 }}>
          <div>
            <div style={{ color: '#94a3b8' }}>Auth mode</div>
            <div style={{ fontWeight: 600, color: '#1e2536' }}>
              {rbac ? (rbac.authMode === 'none' ? 'No per-user auth' : rbac.authMode || '—') : '—'}
            </div>
          </div>
          <div>
            <div style={{ color: '#94a3b8' }}>Identity</div>
            <div style={{ fontWeight: 600, color: '#1e2536', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {rbac?.currentUser?.name || '—'}
            </div>
          </div>
          <div>
            <div style={{ color: '#94a3b8' }}>Cluster role</div>
            <div>
              {rbac ? (
                rbac.clusterAdmin ? (
                  <span className="pill" style={{ background: '#fff1f2', color: '#e11d48', border: '1px solid #fecdd3' }}>
                    cluster-admin · wildcard
                  </span>
                ) : (
                  <span className="pill" style={{ background: '#ecfdf5', color: '#059669', border: '1px solid #d1fae5' }}>
                    scoped role
                  </span>
                )
              ) : (
                '—'
              )}
            </div>
          </div>
          <div>
            <div style={{ color: '#94a3b8' }}>Automation</div>
            <div>
              {rbac ? (
                rbac.canAutomateCluster ? (
                  <span className="pill" style={{ background: '#f0fdf4', color: '#16a34a', border: '1px solid #dcfce7' }}>
                    can automate
                  </span>
                ) : (
                  <span className="pill" style={{ background: '#f1f5f9', color: '#64748b' }}>read-only</span>
                )
              ) : (
                '—'
              )}
            </div>
          </div>
        </div>
        {rbac?.note && <div style={{ fontSize: 12, color: '#64748b', marginBottom: 12 }}>{rbac.note}</div>}
        <div style={{ overflowX: 'auto', borderTop: '1px solid #eef0f6', paddingTop: 8 }}>
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ ...th, borderBottom: 'none', padding: '6px 8px' }}>API groups</th>
                <th style={{ ...th, borderBottom: 'none', padding: '6px 8px' }}>Resources</th>
                <th style={{ ...th, borderBottom: 'none', padding: '6px 8px' }}>Verbs</th>
              </tr>
            </thead>
            <tbody>
              {rbacErr ? (
                <EmptyRow n={3} msg="rbac unavailable" />
              ) : rules.length ? (
                rules.slice(0, 40).map((ru, i) => (
                  <tr key={i} style={{ borderTop: '1px solid #f6f7fb' }}>
                    <td style={{ padding: '6px 8px', color: '#64748b', verticalAlign: 'top' }}>
                      {join((ru.apiGroups || []).map((g) => (g === '' ? 'core' : g)))}
                    </td>
                    <td style={{ padding: '6px 8px', color: '#475569', verticalAlign: 'top' }}>{join(ru.resources)}</td>
                    <td
                      className="num"
                      style={{
                        padding: '6px 8px',
                        verticalAlign: 'top',
                        color: (ru.verbs || []).includes('*') ? '#f43f5e' : '#64748b',
                        fontWeight: (ru.verbs || []).includes('*') ? 600 : 400,
                      }}
                    >
                      {join(ru.verbs)}
                    </td>
                  </tr>
                ))
              ) : (
                <EmptyRow n={3} msg="no rules readable" />
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Editable pricing */}
      <CostSettingsCard />

      <footer style={{ textAlign: 'center', fontSize: 12, color: '#94a3b8', paddingTop: 8, paddingBottom: 24 }}>
        CoolScaler · Cost Report · priced from the node resource model (no cloud billing connected)
      </footer>
    </main>
  );
}
