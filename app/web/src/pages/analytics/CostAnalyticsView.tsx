// Cost analytics
import { useEffect, useState } from 'react';
import { getJson } from '../../api/client';
import SeriesChart, { type SeriesSpec } from './SeriesChart';
import type { AnalyticsRange, GraphPoint } from './lib';

interface GraphResp {
  values?: GraphPoint[];
}
interface SingleResp {
  value?: number;
}
interface AutoResp {
  [k: string]: { automated: number; total: number } | unknown;
}

const usd = (v: number) => '$' + Math.round(v).toLocaleString();
const dollarAxis = (v: number) => '$' + Math.round(v);
const intAxis = (v: number) => String(Math.round(v));
const coresFmt = (v: number) => (v >= 1 ? (+v).toFixed(0) : Math.round(v * 1000) + 'm');
const memFmt = (v: number) => {
  if (v <= 0) return '0';
  const g = v / (1 << 30);
  return g >= 1 ? g.toFixed(0) + ' GiB' : Math.round(v / (1 << 20)) + ' MiB';
};

const cardTitle: React.CSSProperties = { fontSize: 14, fontWeight: 700, color: '#1e2536' };
const chartTitle: React.CSSProperties = { fontSize: 12, color: '#64748b', textAlign: 'center', marginBottom: 6 };

const AUTO_TRACKS: [string, string][] = [
  ['Rightsizing', 'rightsizing'],
  ['Pod Placement', 'podPlacement'],
  ['Pod Scheduling', 'podScheduling'],
  ['Replicas Optimization', 'replicas'],
  ['Automated Fractional GPUs', 'gpuRightsizing'],
  ['Spot Optimization', 'spotOptimization'],
];

function pct(a: unknown): string {
  const o = a as { automated: number; total: number } | undefined;
  if (!o || !o.total) return '-';
  return Math.round((o.automated / o.total) * 100) + '%';
}

export default function CostAnalyticsView({ range }: { range: AnalyticsRange }) {
  const [singles, setSingles] = useState<Record<string, number | undefined>>({});
  const [auto, setAuto] = useState<AutoResp>({});
  const [g, setG] = useState<Record<string, GraphPoint[]>>({});
  const [footer, setFooter] = useState('collecting history…');

  useEffect(() => {
    let dead = false;
    const load = async () => {
      const R = range;
      const grp = R === '6h' || R === '24h' ? '15m' : R === '7d' ? 'hour' : 'day';
      const q = (types: string[]) => '/api/analytics/graph?range=' + R + '&groupBy=' + grp + types.map((t) => '&types=' + t).join('');
      try {
        const singleKeys = ['totalWorkloadCostMonthly', 'nodes', 'cpuRequests', 'cpuRequestsOrigin', 'memoryRequests', 'memoryRequestsOrigin', 'availableSavings'];
        const sv: Record<string, number | undefined> = {};
        await Promise.all(
          singleKeys.map(async (t) => {
            sv[t] = (await getJson<SingleResp>('/api/analytics/single?range=' + R + '&type=' + t)).value;
          }),
        );
        if (dead) return;
        setSingles(sv);
        const a = await getJson<AutoResp>('/api/analytics/automation?range=' + R);
        if (dead) return;
        setAuto(a);
        const [gCost, gNodes, gSav, gPods, gWl, gHpa, gSpot] = await Promise.all([
          getJson<GraphResp>(q(['totalWorkloadCostMonthly'])),
          getJson<GraphResp>(q(['nodes'])),
          getJson<GraphResp>(q(['availableSavings'])),
          getJson<GraphResp>(q(['numberOfAutomatedPods', 'totalNumberOfPods'])),
          getJson<GraphResp>(q(['rightsizingAutomated', 'totalNumberOfWorkloads'])),
          getJson<GraphResp>(q(['replicasAutomated', 'replicasTotal'])),
          getJson<GraphResp>(q(['spotAutomated', 'spotTotal'])),
        ]);
        if (dead) return;
        // Daily spend + daily savings-available (monthly ÷ 30)
        const daily = (rows: GraphPoint[], key: string): GraphPoint[] =>
          rows.map((r) => ({ timestamp: r.timestamp, values: { daily: (r.values?.[key] || 0) / 30 } }));
        setG({
          cost: gCost.values || [],
          dailySpend: daily(gCost.values || [], 'totalWorkloadCostMonthly'),
          nodes: gNodes.values || [],
          savDaily: daily(gSav.values || [], 'availableSavings'),
          pods: gPods.values || [],
          wl: gWl.values || [],
          hpa: gHpa.values || [],
          spot: gSpot.values || [],
        });
        const n = (gCost.values || []).length;
        setFooter(n >= 2 ? `CoolScaler · Cost analytics · ${n} points over ${R}` : 'CoolScaler · Cost analytics · collecting history…');
      } catch {
        if (!dead) setFooter('cost analytics: connection error');
      }
    };
    void load();
    // Nudge recharts ResponsiveContainer to measure its width after this view
    // mounts into the (already-painted) page on the profile toggle — otherwise
    // the first measurement can be 0 and the charts render bunched at x=0.
    const r1 = window.setTimeout(() => window.dispatchEvent(new Event('resize')), 60);
    const r2 = window.setTimeout(() => window.dispatchEvent(new Event('resize')), 400);
    const t = window.setInterval(() => void load(), 30000);
    return () => {
      dead = true;
      window.clearInterval(t);
      window.clearTimeout(r1);
      window.clearTimeout(r2);
    };
  }, [range]);

  const costSeries: SeriesSpec[] = [{ key: 'totalWorkloadCostMonthly', label: 'Monthly cost', color: '#6366f1', fill: 'rgba(99,102,241,.08)' }];
  const dailySeries: SeriesSpec[] = [{ key: 'daily', label: 'Daily spend', color: '#818cf8', fill: 'rgba(129,140,248,.35)' }];
  const nodesSeries: SeriesSpec[] = [{ key: 'nodes', label: 'Nodes', color: '#f59e0b', fill: 'rgba(245,158,11,.3)' }];
  const savSeries: SeriesSpec[] = [{ key: 'daily', label: 'Savings available', color: '#f43f5e', fill: 'rgba(244,63,94,.25)' }];
  const podsSeries: SeriesSpec[] = [
    { key: 'numberOfAutomatedPods', label: 'Total automated pods', color: '#22c55e', fill: 'rgba(34,197,94,.35)' },
    { key: 'totalNumberOfPods', label: 'Total number of pods', color: '#6366f1' },
  ];
  const wlSeries: SeriesSpec[] = [
    { key: 'rightsizingAutomated', label: 'Total automated workloads', color: '#22c55e', fill: 'rgba(34,197,94,.35)' },
    { key: 'totalNumberOfWorkloads', label: 'Total number of workloads', color: '#6366f1' },
  ];
  const hpaSeries: SeriesSpec[] = [
    { key: 'replicasAutomated', label: 'Automated HPA workloads', color: '#22c55e', fill: 'rgba(34,197,94,.35)' },
    { key: 'replicasTotal', label: 'Workloads with HPA', color: '#6366f1' },
  ];
  const spotSeries: SeriesSpec[] = [
    { key: 'spotAutomated', label: 'Total automated workloads', color: '#22c55e', fill: 'rgba(34,197,94,.35)' },
    { key: 'spotTotal', label: 'Total number of workloads', color: '#6366f1' },
  ];

  const cpuReqPct = singles.cpuRequestsOrigin ? Math.round((1 - (singles.cpuRequests || 0) / singles.cpuRequestsOrigin) * 100) : 0;

  return (
    <>
      {/* KPI row */}
      <section className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1.4fr' }}>
          <div style={{ padding: 24, textAlign: 'center', borderRight: '1px solid #eef0f6', display: 'grid', placeItems: 'center' }}>
            <div>
              <div style={{ fontSize: 13, color: '#64748b' }}>Average monthly cost</div>
              <div className="num" style={{ marginTop: 4, fontSize: 44, fontWeight: 700, color: '#4f46e5', letterSpacing: '-.02em' }}>
                {singles.totalWorkloadCostMonthly != null ? usd(singles.totalWorkloadCostMonthly) : '—'}
              </div>
            </div>
          </div>
          <div style={{ padding: 24, borderRight: '1px solid #eef0f6', display: 'grid', gridTemplateRows: 'auto auto', gap: 10, placeItems: 'center' }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 13, color: '#64748b' }}>
                Nodes <span style={{ color: '#cbd5e1' }}>(avg.)</span>
              </div>
              <div className="num" style={{ marginTop: 4, fontSize: 30, fontWeight: 700, color: '#1e2536' }}>
                {singles.nodes != null ? Math.round(singles.nodes) : '—'}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 20, fontSize: 12, color: '#475569', borderTop: '1px solid #eef0f6', paddingTop: 10 }}>
              <div style={{ textAlign: 'center' }}>
                <div style={{ color: '#64748b' }}>
                  CPU request {cpuReqPct !== 0 && <span style={{ color: cpuReqPct > 0 ? '#16a34a' : '#e11d48' }}>({cpuReqPct > 0 ? '↓' : '↑'}{Math.abs(cpuReqPct)}%)</span>}
                </div>
                <div className="num" style={{ fontWeight: 700 }}>
                  {singles.cpuRequestsOrigin != null ? coresFmt(singles.cpuRequestsOrigin) : '—'} →{' '}
                  <span style={{ color: '#16a34a' }}>{singles.cpuRequests != null ? coresFmt(singles.cpuRequests) : '—'}</span>
                </div>
              </div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ color: '#64748b' }}>Memory request</div>
                <div className="num" style={{ fontWeight: 700 }}>
                  {singles.memoryRequestsOrigin != null ? memFmt(singles.memoryRequestsOrigin) : '—'} →{' '}
                  <span style={{ color: '#16a34a' }}>{singles.memoryRequests != null ? memFmt(singles.memoryRequests) : '—'}</span>
                </div>
              </div>
            </div>
          </div>
          <div style={{ padding: 24 }}>
            <div style={{ ...cardTitle, textAlign: 'center', fontSize: 13, color: '#64748b', marginBottom: 10 }}>
              Automation <span style={{ color: '#cbd5e1' }}>(avg.)</span>
            </div>
            {AUTO_TRACKS.map(([label, key]) => {
              const p = pct(auto[key]);
              const w = p === '-' ? 0 : parseInt(p);
              return (
                <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, fontSize: 12 }}>
                  <span style={{ width: 160, color: '#475569' }}>{label}</span>
                  <div style={{ flex: 1, height: 8, borderRadius: 4, background: '#eef0f5', overflow: 'hidden' }}>
                    <div style={{ width: w + '%', height: 8, background: '#22c55e' }} />
                  </div>
                  <span style={{ width: 42, textAlign: 'right', color: p === '-' ? '#94a3b8' : '#16a34a', fontWeight: 600 }} className="num">
                    {p}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Cost + infra charts */}
      <section className="card" style={{ padding: 20 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
          <div>
            <div style={chartTitle}>Monthly cost <span style={{ color: '#cbd5e1' }}>(live)</span></div>
            <SeriesChart values={g.cost || []} series={costSeries} yFmt={dollarAxis} height={200} />
          </div>
          <div>
            <div style={chartTitle}>Daily spend</div>
            <SeriesChart values={g.dailySpend || []} series={dailySeries} yFmt={dollarAxis} height={200} />
          </div>
          <div>
            <div style={chartTitle}>Nodes</div>
            <SeriesChart values={g.nodes || []} series={nodesSeries} yFmt={intAxis} height={200} />
          </div>
          <div>
            <div style={chartTitle}>Savings available <span style={{ color: '#cbd5e1' }}>(daily)</span></div>
            <SeriesChart values={g.savDaily || []} series={savSeries} yFmt={dollarAxis} height={200} />
          </div>
          <div>
            <div style={chartTitle}>Number of pods</div>
            <SeriesChart values={g.pods || []} series={podsSeries} yFmt={intAxis} height={200} />
          </div>
          <div>
            <div style={chartTitle}>Number of workloads</div>
            <SeriesChart values={g.wl || []} series={wlSeries} yFmt={intAxis} height={200} />
          </div>
          <div>
            <div style={chartTitle}>Workloads with HPA</div>
            <SeriesChart values={g.hpa || []} series={hpaSeries} yFmt={intAxis} height={200} />
          </div>
          <div>
            <div style={chartTitle}>Spot optimization workloads</div>
            <SeriesChart values={g.spot || []} series={spotSeries} yFmt={intAxis} height={200} />
          </div>
        </div>
        <div style={{ marginTop: 12, fontSize: 11, color: '#94a3b8', textAlign: 'center' }}>{footer}</div>
      </section>
    </>
  );
}
