// Savings / Allocatable Comparison
import { useEffect, useState } from 'react';
import { getJson } from '../../api/client';
import { useClusterData } from '../../providers/ClusterDataProvider';
import { usd } from '../../lib/format';
import '../rightsizing/rightsizing.css';
import {
  bytesAxis,
  coresAxis,
  intAxis,
  blockedDatasets,
  corePeriodDatasets,
  firstSeriesKey,
  pairDatasets,
  pairLegend,
  req3Datasets,
  splitPeriods,
  CORE_PERIOD_LEGEND,
  REQ3_LEGEND,
  PairedPeriodCharts,
  ResourceChartCard,
  Spark,
  SwatchLegend,
  useTick,
  type GraphPoint,
  type GraphResponse,
} from './charts';

interface CmpSide {
  allocatable?: number | null;
  request?: number | null;
  usage?: number | null;
  /** feature-detected — the backend may add either spelling */
  originRequest?: number | null;
  originalRequest?: number | null;
}
interface CmpPeriod {
  cpu?: CmpSide;
  mem?: CmpSide;
  /** feature-detected per-period series (backend may add) */
  series?: GraphPoint[];
}
interface ComparisonResponse {
  windowHours?: number;
  periodA?: CmpPeriod;
  periodB?: CmpPeriod;
}
interface HeadroomResponse {
  enabled?: boolean;
  cpuClusterProportion?: number;
  memoryClusterProportion?: number;
  computed?: {
    headroomCpu?: number;
    headroomMem?: number;
    targetAllocatableCpu?: number;
    estimatedAllocatableCpu?: number;
  };
}

// coreFmt / giFmt — CPU cores & GiB at 2 dp
const coreFmt = (c?: number | null) => (c == null ? '—' : c.toFixed(2));
const giFmt = (b?: number | null) => (b == null ? '—' : (b / 2 ** 30).toFixed(2));

// deltaPct — Δ% = (B-A)/A*100; grew→red, shrank→green, 0/unknown→gray
function deltaPct(a?: number | null, b?: number | null): { txt: string; color: string } {
  if (a == null || b == null || a === 0) return { txt: '—', color: '#94a3b8' };
  const r = Math.round(((b - a) / a) * 1000) / 10;
  const color = r > 0 ? '#f43f5e' : r < 0 ? '#16a34a' : '#94a3b8';
  return { txt: (r > 0 ? '+' : '') + r.toFixed(1) + '%', color };
}

function CmpRow({ label, a, b, fmt }: { label: string; a?: number | null; b?: number | null; fmt: (v?: number | null) => string }) {
  const d = deltaPct(a, b);
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '8px 0',
        borderTop: '1px solid #f1f2f7',
      }}
    >
      <span style={{ color: '#64748b' }}>{label}</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="num" style={{ color: '#94a3b8' }}>{fmt(a)}</span>
        <span style={{ color: '#cbd5e1' }}>→</span>
        <span className="num" style={{ fontWeight: 600, color: '#1e2536' }}>{fmt(b)}</span>
        <span className="num" style={{ fontWeight: 600, color: d.color, width: 64, textAlign: 'right' }}>({d.txt})</span>
      </span>
    </div>
  );
}

/** One "Average CPU/Memory Resources" comparison card (fillCmp port). */
function CmpCard({
  title,
  unit,
  a,
  b,
  aOrig,
  bOrig,
  fmt,
}: {
  title: string;
  unit: string;
  a: CmpSide;
  b: CmpSide;
  /** "Original request" row values (feature-detected key or series average) */
  aOrig?: number | null;
  bOrig?: number | null;
  fmt: (v?: number | null) => string;
}) {
  const ad = deltaPct(a.allocatable, b.allocatable);
  const anyNull = a.allocatable == null || b.allocatable == null;
  return (
    <div className="card" style={{ padding: 20 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: '#64748b' }}>{title}</div>
      <div style={{ textAlign: 'center', marginTop: 12, marginBottom: 16 }}>
        <div style={{ fontSize: 12, fontWeight: 500, color: '#64748b' }}>
          Allocatable <span className="num" style={{ color: ad.color }}>({ad.txt})</span>
        </div>
        <div className="num" style={{ marginTop: 4, fontSize: 26, lineHeight: 1, fontWeight: 700, letterSpacing: '-.02em', color: '#1e2536' }}>
          <span>{fmt(a.allocatable)}</span>
          <span style={{ color: '#cbd5e1', fontWeight: 400, margin: '0 4px' }}>→</span>
          <span>{fmt(b.allocatable)}</span>
        </div>
        <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>{unit}</div>
        {anyNull && <div style={{ fontSize: 11, color: '#f59e0b', marginTop: 4 }}>collecting history…</div>}
      </div>
      <div style={{ fontSize: 13 }}>
        <CmpRow label="Request" a={a.request} b={b.request} fmt={fmt} />
        <CmpRow label="Original request" a={aOrig} b={bOrig} fmt={fmt} />
        <CmpRow label="Usage" a={a.usage} b={b.usage} fmt={fmt} />
      </div>
    </div>
  );
}

const statLbl: React.CSSProperties = { fontSize: 11, color: '#94a3b8', fontWeight: 500 };
const statSub: React.CSSProperties = { fontSize: 11, color: '#94a3b8' };

export default function SavingsPage() {
  const { overview: ov } = useClusterData();
  const tick = useTick(30000);

  const [win, setWin] = useState(24); // SAVINGS_WIN
  const [range, setRange] = useState<'7d' | '30d'>('7d'); // SV_RES_RANGE

  const [cmp, setCmp] = useState<ComparisonResponse | null>(null);
  const [hr, setHr] = useState<HeadroomResponse | null>(null);
  const [costSpark, setCostSpark] = useState<GraphPoint[]>([]);
  const [wasteSpark, setWasteSpark] = useState<GraphPoint[]>([]);
  const [periodG, setPeriodG] = useState<GraphPoint[]>([]);
  const [resrcG, setResrcG] = useState<GraphPoint[]>([]);

  // comparison — refetches on window change (setSavingsWindow) + 30s
  useEffect(() => {
    let dead = false;
    getJson<ComparisonResponse>('/api/comparison?windowHours=' + win)
      .then((j) => !dead && setCmp(j))
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [win, tick]);

  // headroom + hero sparklines — 30s
  useEffect(() => {
    let dead = false;
    getJson<HeadroomResponse>('/api/headroom')
      .then((j) => !dead && setHr(j))
      .catch(() => {});
    const q = (t: string) => '/api/analytics/graph?range=7d&groupBy=hour&types=' + t;
    getJson<GraphResponse>(q('totalWorkloadCostMonthly'))
      .then((g) => !dead && setCostSpark(g.values || []))
      .catch(() => {});
    getJson<GraphResponse>(q('wastedSpendPct'))
      .then((g) => !dead && setWasteSpark(g.values || []))
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [tick]);

  // period-comparison series — one fetch covering 2×window, split client-side
  // into Period A / Period B (unknown types are silently dropped by the API,
  // so the feature-detected candidates below are safe to request).
  useEffect(() => {
    let dead = false;
    const rng = win === 1 ? '6h' : win === 6 ? '12h' : '2d';
    const grp = win === 1 ? '5m' : win === 6 ? '15m' : 'hour';
    const types = [
      // core resources
      'cpuAllocatable', 'cpuRequests', 'cpuRequestsOrigin', 'cpuUsageTotal',
      'memoryAllocatable', 'memoryRequests', 'memoryRequestsOrigin', 'memoryUsageTotal',
      // automation progress
      'numberOfAutomatedPods', 'totalNumberOfPods',
      'podPlacementAutomated', 'podPlacementTotal',
      'replicasAutomated', 'replicasTotal',
      'nodes', 'optimizedNodes', 'numberOfOptimizedNodes', 'nodesOptimized',
      'podSchedulingAutomated', 'podSchedulingTotal',
      'selfAntiAffinityPods', 'automatedSelfAntiAffinityPods',
    ];
    getJson<GraphResponse>(
      '/api/analytics/graph?range=' + rng + '&groupBy=' + grp + types.map((t) => '&types=' + t).join(''),
    )
      .then((g) => !dead && setPeriodG(g.values || []))
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [win, tick]);

  // automated-resources graphs — refetch on range change (setSvResRange) + 30s
  useEffect(() => {
    let dead = false;
    const grp = range === '30d' ? 'day' : 'hour';
    const types = [
      // rightsizing 3-series (live)
      'cpuRecommendation', 'cpuRequests', 'cpuRequestsOrigin',
      'memoryRecommendation', 'memoryRequests', 'memoryRequestsOrigin',
      // feature-detected candidates (backend may add; dropped if unknown)
      'unevictableBlockedCpu', 'cpuBlockedByUnevictable',
      'unevictableBlockedMemory', 'memoryBlockedByUnevictable',
      'replicasCpuRecommendation', 'replicasCpuRequests', 'replicasCpuRequestsOrigin',
      'replicasMemoryRecommendation', 'replicasMemoryRequests', 'replicasMemoryRequestsOrigin',
      'antiAffinityBlockedCpu', 'cpuBlockedBySelfAntiAffinity',
      'antiAffinityBlockedMemory', 'memoryBlockedBySelfAntiAffinity',
    ];
    getJson<GraphResponse>(
      '/api/analytics/graph?range=' + range + '&groupBy=' + grp + types.map((t) => '&types=' + t).join(''),
    )
      .then((g) => !dead && setResrcG(g.values || []))
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [range, tick]);

  const A = cmp?.periodA || {};
  const B = cmp?.periodB || {};
  const hc = hr?.computed || {};
  const bk = ov?.savingsBreakdown || {};

  // Period A/B series: prefer a backend per-period series if it appears
  // (feature-detected), else split the combined series at the window boundary.
  const split = splitPeriods(periodG, win);
  const perA = A.series && A.series.length ? A.series : split.a;
  const perB = B.series && B.series.length ? B.series : split.b;

  // "Original request" comparison-card row — feature-detected /api/comparison
  // key only (originRequest | originalRequest). No series fallback: the
  // analytics originRequests series covers sizable workloads only, a
  // different scope than the card's cluster-wide Request row — mixing them
  // would mislead. Honest "—" until the backend ships the key.
  const orig = (s: CmpSide | undefined) => s?.originRequest ?? s?.originalRequest ?? null;
  const origCpuA = orig(A.cpu);
  const origCpuB = orig(B.cpu);
  const origMemA = orig(A.mem);
  const origMemB = orig(B.mem);

  // Feature-detected series keys for optimized-nodes + pod-scheduling charts.
  const optNodesKey = firstSeriesKey(periodG, ['optimizedNodes', 'numberOfOptimizedNodes', 'nodesOptimized']);
  const nodesKey = firstSeriesKey(periodG, ['nodes']);
  const schedAutoKey = firstSeriesKey(periodG, ['podSchedulingAutomated', 'automatedSelfAntiAffinityPods']);
  const schedTotalKey = firstSeriesKey(periodG, ['podSchedulingTotal', 'selfAntiAffinityPods']);

  // Feature-detected keys for the Automated-resources-progress grid.
  const unevCpuKey = firstSeriesKey(resrcG, ['unevictableBlockedCpu', 'cpuBlockedByUnevictable']);
  const unevMemKey = firstSeriesKey(resrcG, ['unevictableBlockedMemory', 'memoryBlockedByUnevictable']);
  const affCpuKey = firstSeriesKey(resrcG, ['antiAffinityBlockedCpu', 'cpuBlockedBySelfAntiAffinity']);
  const affMemKey = firstSeriesKey(resrcG, ['antiAffinityBlockedMemory', 'memoryBlockedBySelfAntiAffinity']);

  const wp = Math.round(ov?.savingsPct || 0);
  const wasteColor = wp >= 15 ? '#f43f5e' : wp > 0 ? '#f59e0b' : '#16a34a';

  return (
    <main style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Hero trend cards: live monthly cost + wasted spend (moved from the Overview) */}
      <section style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div className="card" style={{ padding: 16 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#64748b' }}>Live monthly cost</div>
              <div className="num" style={{ marginTop: 4, fontSize: 32, lineHeight: 1, fontWeight: 800, letterSpacing: '-.02em', color: '#1e2536' }}>
                {ov ? usd(ov.monthlyCost) : '$—'}
              </div>
              <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>
                <span className="num">{ov?.nodes ?? '—'}</span> nodes · request-based estimate
              </div>
            </div>
            <span className="pill" style={{ background: '#eef2ff', color: '#4f46e5' }}>7d</span>
          </div>
          <div style={{ marginTop: 8 }}>
            <Spark values={costSpark} seriesKey="totalWorkloadCostMonthly" color="#6366f1" fill="rgba(99,102,241,.12)" />
          </div>
        </div>
        <div className="card" style={{ padding: 16 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#64748b' }}>Wasted spend</div>
              <div className="num" style={{ marginTop: 4, fontSize: 32, lineHeight: 1, fontWeight: 800, letterSpacing: '-.02em', color: ov ? wasteColor : '#f43f5e' }}>
                {ov ? wp + '%' : '—%'}
              </div>
              <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>
                <span className="num">{ov ? usd(((ov.monthlyCost || 0) * (ov.savingsPct || 0)) / 100) : '$—'}</span>/mo reclaimable if right-sized
              </div>
            </div>
            <span className="pill" style={{ background: '#fff1f2', color: '#e11d48' }}>reclaimable</span>
          </div>
          <div style={{ marginTop: 8 }}>
            <Spark values={wasteSpark} seriesKey="wastedSpendPct" color="#f43f5e" fill="rgba(244,63,94,.12)" />
          </div>
        </div>
      </section>

      {/* Header */}
      <section style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 700, color: '#1e2536', margin: 0 }}>Allocatable Comparison</h1>
          <p style={{ fontSize: 14, color: '#64748b', margin: '2px 0 0' }}>
            Compare resource metrics and automation between two periods.
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {/* window selector (re-fetches) */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.04em', color: '#94a3b8', fontWeight: 500 }}>window</span>
            <div style={{ display: 'flex', gap: 2, background: '#f1f2f7', borderRadius: 8, padding: 2 }}>
              {([1, 6, 24] as const).map((h) => (
                <span key={h} className={'seg' + (win === h ? ' active' : '')} onClick={() => setWin(h)}>
                  {h}h
                </span>
              ))}
            </div>
          </div>
          {/* segmented period label (visual only) */}
          <div style={{ display: 'flex', gap: 2, background: '#f1f2f7', borderRadius: 8, padding: 2 }}>
            <span className="seg">Prior 24h</span>
            <span className="seg active">Last 24h</span>
          </div>
        </div>
      </section>

      {/* Cluster headroom buffer */}
      <section className="card" style={{ padding: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#1e2536' }}>Cluster headroom</div>
            <div style={{ fontSize: 12, color: '#64748b' }}>Reserved scale-up buffer kept free for bursts &amp; new pods.</div>
          </div>
          <span
            className="pill"
            style={hr?.enabled ? { background: '#eef2ff', color: '#4f46e5' } : { background: '#f1f5f9', color: '#94a3b8' }}
          >
            {hr == null
              ? '—'
              : hr.enabled
                ? 'CPU ' + Math.round(hr.cpuClusterProportion || 0) + '% · Mem ' + Math.round(hr.memoryClusterProportion || 0) + '%'
                : 'disabled'}
          </span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 16 }}>
          <div>
            <div style={statLbl}>CPU headroom</div>
            <div className="num" style={{ fontSize: 20, fontWeight: 700, color: '#1e2536' }}>{hr ? coreFmt(hc.headroomCpu) + ' cores' : '—'}</div>
            <div style={statSub}>reserved / allocatable</div>
          </div>
          <div>
            <div style={statLbl}>Memory headroom</div>
            <div className="num" style={{ fontSize: 20, fontWeight: 700, color: '#1e2536' }}>{hr ? giFmt(hc.headroomMem) + ' Gi' : '—'}</div>
            <div style={statSub}>reserved / allocatable</div>
          </div>
          <div>
            <div style={statLbl}>Target allocatable (CPU)</div>
            <div className="num" style={{ fontSize: 20, fontWeight: 700, color: '#16a34a' }}>{hr ? coreFmt(hc.targetAllocatableCpu) + ' cores' : '—'}</div>
            <div style={statSub}>usable below buffer</div>
          </div>
          <div>
            <div style={statLbl}>Est. allocatable needed (CPU)</div>
            <div className="num" style={{ fontSize: 20, fontWeight: 700, color: '#4f46e5' }}>{hr ? coreFmt(hc.estimatedAllocatableCpu) + ' cores' : '—'}</div>
            <div style={statSub}>right-sized + buffer</div>
          </div>
        </div>
      </section>

      {/* Two big comparison cards */}
      <section style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <CmpCard title="Average CPU Resources" unit="cores" a={A.cpu || {}} b={B.cpu || {}} aOrig={origCpuA} bOrig={origCpuB} fmt={coreFmt} />
        <CmpCard title="Average Memory Resources" unit="GiB" a={A.mem || {}} b={B.mem || {}} aOrig={origMemA} bOrig={origMemB} fmt={giFmt} />
      </section>

      {/* Available savings breakdown */}
      <section className="card" style={{ padding: 20 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#1e2536', marginBottom: 12 }}>Available savings breakdown</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12 }}>
          {(
            [
              ['Rightsizing', bk.rightsizing, '#16a34a', 'unautomated workload requests'],
              ['Init containers', bk.initContainers, '#1e2536', 'init-container request waste'],
              ['Unrecognized', bk.unrecognized, '#1e2536', 'non-standard owner workloads'],
            ] as [string, number | undefined, string, string][]
          ).map(([label, v, color, sub]) => (
            <div key={label} style={{ borderRadius: 12, border: '1px solid #eef0f6', padding: 12 }}>
              <div style={statLbl}>{label}</div>
              <div className="num" style={{ fontSize: 22, fontWeight: 700, color, marginTop: 4 }}>{ov ? usd(v || 0) : '—'}</div>
              <div style={{ fontSize: 10, color: '#94a3b8' }}>{sub}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Core resources over time — Period A | Period B side-by-side */}
      <section className="card" style={{ padding: 20 }}>
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#1e2536' }}>Core resources over time</div>
          <div style={{ fontSize: 12, color: '#64748b' }}>
            Cluster allocatable vs request vs usage across the two comparison periods.
          </div>
        </div>
        <SwatchLegend items={CORE_PERIOD_LEGEND} style={{ justifyContent: 'center', marginBottom: 8 }} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <PairedPeriodCharts
            a={perA}
            b={perB}
            datasets={corePeriodDatasets('cpu')}
            yFmt={coresAxis}
            height={220}
            titleSuffix="CPU over time"
            bordered={false}
          />
          <PairedPeriodCharts
            a={perA}
            b={perB}
            datasets={corePeriodDatasets('memory')}
            yFmt={bytesAxis}
            height={220}
            titleSuffix="Memory over time"
            bordered={false}
          />
        </div>
      </section>

      {/* Automation progress: paired Period A/B charts per product */}
      <section className="card" style={{ padding: 20 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#1e2536', marginBottom: 2 }}>Automation progress</div>
        <div style={{ fontSize: 12, color: '#64748b', marginBottom: 12 }}>
          Automated (green) vs total (line) over time, by optimization product — Period A vs Period B.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <PairedPeriodCharts
            title="Automated rightsizing pods"
            a={perA}
            b={perB}
            datasets={pairDatasets('numberOfAutomatedPods', 'totalNumberOfPods', 'Number of automated pods', 'Number of pods')}
            yFmt={intAxis}
            height={190}
            legend={pairLegend('Number of automated pods', 'Number of pods')}
          />
          <PairedPeriodCharts
            title="Automated unevictable pods"
            a={perA}
            b={perB}
            datasets={pairDatasets('podPlacementAutomated', 'podPlacementTotal', 'Number of automated unevictable pods', 'Number of unevictable pods')}
            yFmt={intAxis}
            height={190}
            legend={pairLegend('Number of automated unevictable pods', 'Number of unevictable pods')}
          />
          <PairedPeriodCharts
            title="Automated replicas optimization pods"
            a={perA}
            b={perB}
            datasets={pairDatasets('replicasAutomated', 'replicasTotal', 'Number of automated pods', 'Number of pods')}
            yFmt={intAxis}
            height={190}
            legend={pairLegend('Number of automated pods', 'Number of pods')}
          />
          <PairedPeriodCharts
            title="Optimized nodes"
            a={perA}
            b={perB}
            datasets={pairDatasets(optNodesKey, nodesKey, 'Number of optimized nodes', 'Number of nodes')}
            yFmt={intAxis}
            height={190}
            legend={pairLegend('Number of optimized nodes', 'Number of nodes')}
          />
          <PairedPeriodCharts
            title="Automated pod scheduling pods"
            a={perA}
            b={perB}
            datasets={pairDatasets(schedAutoKey, schedTotalKey, 'Number of automated self anti-affinity pods', 'Number of self anti-affinity pods')}
            yFmt={intAxis}
            height={190}
            legend={pairLegend('Number of automated self anti-affinity pods', 'Number of self anti-affinity pods')}
          />
        </div>
      </section>

      {/* Automated resources progress — 3-series charts grid */}
      <section className="card" style={{ padding: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#1e2536', marginBottom: 2 }}>Automated resources progress</div>
            <div style={{ fontSize: 12, color: '#64748b' }}>
              Current optimized vs current vs original requests — the gap is reclaimed on automation.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 2, background: '#f1f2f7', borderRadius: 8, padding: 2 }}>
            {(['7d', '30d'] as const).map((r) => (
              <span key={r} className={'seg' + (range === r ? ' active' : '')} onClick={() => setRange(r)}>
                {r === '7d' ? '7 Days' : '30 Days'}
              </span>
            ))}
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <ResourceChartCard
            title="Automated rightsizing CPU requests"
            values={resrcG}
            datasets={req3Datasets('cpuRecommendation', 'cpuRequests', 'cpuRequestsOrigin')}
            yFmt={coresAxis}
            legend={REQ3_LEGEND}
          />
          <ResourceChartCard
            title="Automated rightsizing Memory requests"
            values={resrcG}
            datasets={req3Datasets('memoryRecommendation', 'memoryRequests', 'memoryRequestsOrigin')}
            yFmt={bytesAxis}
            legend={REQ3_LEGEND}
          />
          <ResourceChartCard
            title="Allocatable CPUs blocked by unevictable pods"
            values={resrcG}
            datasets={blockedDatasets(unevCpuKey, 'Blocked CPU')}
            yFmt={coresAxis}
          />
          <ResourceChartCard
            title="Allocatable Memory blocked by unevictable pods"
            values={resrcG}
            datasets={blockedDatasets(unevMemKey, 'Blocked Memory')}
            yFmt={bytesAxis}
          />
          <ResourceChartCard
            title="Automated replicas optimization CPU requests"
            values={resrcG}
            datasets={req3Datasets(
              firstSeriesKey(resrcG, ['replicasCpuRecommendation']),
              firstSeriesKey(resrcG, ['replicasCpuRequests']),
              firstSeriesKey(resrcG, ['replicasCpuRequestsOrigin']),
            )}
            yFmt={coresAxis}
            legend={REQ3_LEGEND}
          />
          <ResourceChartCard
            title="Automated replicas optimization Memory requests"
            values={resrcG}
            datasets={req3Datasets(
              firstSeriesKey(resrcG, ['replicasMemoryRecommendation']),
              firstSeriesKey(resrcG, ['replicasMemoryRequests']),
              firstSeriesKey(resrcG, ['replicasMemoryRequestsOrigin']),
            )}
            yFmt={bytesAxis}
            legend={REQ3_LEGEND}
          />
          <ResourceChartCard
            title="Allocatable CPU blocked by self anti-affinity pods"
            values={resrcG}
            datasets={blockedDatasets(affCpuKey, 'Blocked CPU')}
            yFmt={coresAxis}
          />
          <ResourceChartCard
            title="Allocatable Memory blocked by self anti-affinity pods"
            values={resrcG}
            datasets={blockedDatasets(affMemKey, 'Blocked Memory')}
            yFmt={bytesAxis}
          />
        </div>
      </section>

      <footer style={{ textAlign: 'center', fontSize: 12, color: '#94a3b8', paddingTop: 8, paddingBottom: 24 }}>
        CoolScaler · Allocatable comparison · refreshes every 30s
      </footer>
    </main>
  );
}
