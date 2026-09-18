// Resources analytics
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getJson } from '../../api/client';
import { usd, cpuFmt, memFmt } from '../../lib/format';
import '../rightsizing/rightsizing.css';
import {
  AN_AUTO_TRACKS,
  bytesAxis,
  coresAxis,
  dollarAxis,
  intAxis,
  type AnalyticsRange,
  type AutomationResponse,
  type GraphPoint,
  type GraphResponse,
  type NetworkCostResponse,
  type SingleResponse,
} from './lib';
import SeriesChart, { Legend, type SeriesSpec } from './SeriesChart';
import CostAnalyticsView from './CostAnalyticsView';

const RANGES: AnalyticsRange[] = ['6h', '24h', '7d', '30d'];

// ---- series specs (colors/fills copied from initAnalyticsCharts) ----
const cpuSeries: SeriesSpec[] = [
  { key: 'cpuUsageTotal', label: 'Total usage', color: '#9aa3c0', fill: 'rgba(154,163,192,.16)' },
  { key: 'cpuRecommendation', label: 'Total optimized request', color: '#22c55e', dash: '4 3' },
  { key: 'cpuRequests', label: 'Total request', color: '#f59e0b' },
  { key: 'cpuRequestsOrigin', label: 'Total original request', color: '#ef4444', width: 1.4 },
  { key: 'cpuAllocatable', label: 'Allocatable', color: '#f6a45c' },
  { key: 'cpuEstimatedAllocatable', label: 'Estimated original allocatable', color: '#e2b07f', dash: '3 3', width: 1.2 },
];
const memSeries: SeriesSpec[] = [
  { key: 'memoryUsageTotal', label: 'Total usage', color: '#9aa3c0', fill: 'rgba(154,163,192,.16)' },
  { key: 'memoryRecommendation', label: 'Total optimized request', color: '#22c55e', dash: '4 3' },
  { key: 'memoryRequests', label: 'Total request', color: '#f59e0b' },
  { key: 'memoryRequestsOrigin', label: 'Total original request', color: '#ef4444', width: 1.4 },
  { key: 'memoryAllocatable', label: 'Allocatable', color: '#f6a45c' },
  { key: 'memoryEstimatedAllocatable', label: 'Estimated original allocatable', color: '#e2b07f', dash: '3 3', width: 1.2 },
];
const autoResSeries = (p: 'autoCpu' | 'autoMemory' | 'hpaCpu' | 'hpaMemory'): SeriesSpec[] => [
  { key: p + 'Recommendation', label: 'Current optimized request', color: '#22c55e', dash: '4 3' },
  { key: p + 'Requests', label: 'Current request', color: '#f59e0b' },
  { key: p + 'RequestsOrigin', label: 'Original request', color: '#ef4444', width: 1.2 },
];
const schedPodsSeries: SeriesSpec[] = [
  { key: 'schedulingAutomatedPods', label: 'Automated pod scheduling pods', color: '#22c55e', fill: 'rgba(34,197,94,.10)' },
];
const lcSeries = (r: 'cpu' | 'memory'): SeriesSpec[] => [
  { key: r + 'AllocatableOnDemand', label: 'On-Demand allocatable', color: '#f6a45c', fill: 'rgba(246,164,92,.55)', width: 1.2 },
  { key: r + 'AllocatableSpot', label: 'Spot allocatable', color: '#f8d2ad', fill: 'rgba(248,210,173,.6)', width: 1.2 },
];
const autoPodsSeries: SeriesSpec[] = [
  { key: 'numberOfAutomatedPods', label: 'Number of automated pods', color: '#22c55e', fill: 'rgba(34,197,94,.10)' },
  { key: 'totalNumberOfPods', label: 'Number of pods', color: '#6366f1' },
];
const wlSeries: SeriesSpec[] = [
  { key: 'totalNumberOfWorkloads', label: 'Total workloads', color: '#8b5cf6', fill: 'rgba(139,92,246,.10)' },
  { key: 'performanceOptimizedWorkloads', label: 'Increased-resource workloads', color: '#f59e0b' },
];
const placeSeries: SeriesSpec[] = [
  { key: 'podPlacementAutomated', label: 'Automated unevictable pods', color: '#22c55e', fill: 'rgba(34,197,94,.10)' },
  { key: 'podPlacementTotal', label: 'Unevictable pods', color: '#6366f1' },
];
const replpSeries: SeriesSpec[] = [
  { key: 'replicasAutomated', label: 'Automated replicas pods', color: '#22c55e', fill: 'rgba(34,197,94,.10)' },
  { key: 'replicasTotal', label: 'Replicas workloads', color: '#6366f1' },
];
const blkCpuSeries: SeriesSpec[] = [
  { key: 'unevictableBlockedCpu', label: 'Allocatable CPU blocked', color: '#f59e0b', fill: 'rgba(245,158,11,.10)' },
];
const blkMemSeries: SeriesSpec[] = [
  { key: 'unevictableBlockedMemory', label: 'Allocatable memory blocked', color: '#ef4444', fill: 'rgba(239,68,68,.10)' },
];
const savingsSeries: SeriesSpec[] = [
  { key: 'activeSavings', label: 'Active (realized)', color: '#22c55e', fill: 'rgba(34,197,94,.14)' },
  { key: 'availableSavings', label: 'Available (potential)', color: '#f59e0b', fill: 'rgba(245,158,11,.10)' },
];
const costSeries: SeriesSpec[] = [
  { key: 'requestsCostMonthly', label: 'Current request cost', color: '#ef4444', fill: 'rgba(239,68,68,.08)' },
  { key: 'recommendedCostMonthly', label: 'Right-sized cost', color: '#22c55e', dash: '4 3' },
];
const wasteSeries: SeriesSpec[] = [
  { key: 'wasteCpuDollar', label: 'CPU waste ($/mo)', color: '#6366f1', fill: 'rgba(99,102,241,.45)', width: 1.2 },
  { key: 'wasteMemDollar', label: 'Memory waste ($/mo)', color: '#f59e0b', fill: 'rgba(245,158,11,.45)', width: 1.2 },
];
const ephSeries: SeriesSpec[] = [
  { key: 'ephemeralUsage', label: 'Usage', color: '#9aa3c0', fill: 'rgba(154,163,192,.16)' },
  { key: 'ephemeralRecommendation', label: 'Optimized request', color: '#22c55e', dash: '4 3' },
  { key: 'ephemeralRequests', label: 'Request', color: '#f59e0b' },
];
const repSeries: SeriesSpec[] = [
  { key: 'currentReplicas', label: 'Current replicas', color: '#6366f1', fill: 'rgba(99,102,241,.10)' },
  { key: 'numberOfUnevictablePods', label: 'Un-evictable pods', color: '#8b5cf6' },
];

/** pctCell port — total 0 → "–", else automated/total %. */
function PctCell({ a }: { a?: { automated?: number; total?: number } }) {
  if (!a || !a.total) return <span style={{ color: '#cbd5e1', fontWeight: 700 }}>–</span>;
  const p = Math.round(((a.automated || 0) / a.total) * 100);
  const col = p >= 80 ? '#16a34a' : p > 0 ? '#f59e0b' : '#94a3b8';
  return (
    <span className="num" style={{ color: col, fontWeight: 800 }}>
      {p}%
    </span>
  );
}

const cardTitle: React.CSSProperties = { fontSize: 14, fontWeight: 700, color: '#1e2536' };
const chartTitle: React.CSSProperties = {
  textAlign: 'center',
  fontSize: 13,
  fontWeight: 600,
  color: '#64748b',
  marginBottom: 8,
};

interface Singles {
  cpuAllocatable?: number;
  memoryAllocatable?: number;
  performanceOptimizedWorkloads?: number;
  totalNumberOfWorkloads?: number;
  totalNumberOfPods?: number;
  wastedSpendPct?: number;
  availableSavings?: number;
}

const Bps = (v?: number | null) => {
  let x = v || 0;
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (x >= 1024 && i < 3) {
    x /= 1024;
    i++;
  }
  return Math.round(x * 10) / 10 + u[i] + '/s';
};

export default function AnalyticsPage() {
  const [range, setRange] = useState<AnalyticsRange>('7d');
  const [profile, setProfile] = useState<'resources' | 'cost'>('resources');
  const [singles, setSingles] = useState<Singles>({});
  const [auto, setAuto] = useState<AutomationResponse>({});
  const [graphs, setGraphs] = useState<Record<string, GraphPoint[]>>({});
  const [net, setNet] = useState<NetworkCostResponse | null>(null);
  const [footer, setFooter] = useState('CoolScaler · Resources analytics · averages over the selected range');

  useEffect(() => {
    let dead = false;
    const load = async () => {
      const R = range;
      const grp = R === '6h' || R === '24h' ? '15m' : R === '7d' ? 'hour' : 'day';
      const q = (types: string[]) =>
        '/api/analytics/graph?range=' + R + '&groupBy=' + grp + types.map((t) => '&types=' + t).join('');
      try {
        // 1) summary singles
        const singleKeys = [
          'cpuAllocatable',
          'memoryAllocatable',
          'performanceOptimizedWorkloads',
          'totalNumberOfWorkloads',
          'totalNumberOfPods',
          'wastedSpendPct',
          'availableSavings',
        ] as const;
        const sv: Singles = {};
        await Promise.all(
          singleKeys.map(async (t) => {
            (sv as Record<string, number | undefined>)[t] = (
              await getJson<SingleResponse>('/api/analytics/single?range=' + R + '&type=' + t)
            ).value;
          }),
        );
        if (dead) return;
        setSingles(sv);

        // 2) automation row
        const a = await getJson<AutomationResponse>('/api/analytics/automation?range=' + R);
        if (dead) return;
        setAuto(a);

        // 3) graphs
        const [gCpu, gMem, gCpuLc, gMemLc, gPods, gWl] = await Promise.all([
          getJson<GraphResponse>(q(['cpuUsageTotal', 'cpuRecommendation', 'cpuRequests', 'cpuRequestsOrigin', 'cpuAllocatable', 'cpuEstimatedAllocatable'])),
          getJson<GraphResponse>(
            q(['memoryUsageTotal', 'memoryRecommendation', 'memoryRequests', 'memoryRequestsOrigin', 'memoryAllocatable', 'memoryEstimatedAllocatable']),
          ),
          getJson<GraphResponse>(q(['cpuAllocatableOnDemand', 'cpuAllocatableSpot'])),
          getJson<GraphResponse>(q(['memoryAllocatableOnDemand', 'memoryAllocatableSpot'])),
          getJson<GraphResponse>(q(['numberOfAutomatedPods', 'totalNumberOfPods'])),
          getJson<GraphResponse>(q(['totalNumberOfWorkloads', 'performanceOptimizedWorkloads'])),
        ]);
        const [gSav, gCost, gWaste, gEph, gRep] = await Promise.all([
          getJson<GraphResponse>(q(['activeSavings', 'availableSavings'])),
          getJson<GraphResponse>(q(['requestsCostMonthly', 'recommendedCostMonthly'])),
          getJson<GraphResponse>(q(['wasteCpuDollar', 'wasteMemDollar'])),
          getJson<GraphResponse>(q(['ephemeralUsage', 'ephemeralRecommendation', 'ephemeralRequests'])),
          getJson<GraphResponse>(q(['currentReplicas', 'numberOfUnevictablePods'])),
        ]);
        const [gPlace, gReplp, gBlkC, gBlkM] = await Promise.all([
          getJson<GraphResponse>(q(['podPlacementAutomated', 'podPlacementTotal'])),
          getJson<GraphResponse>(q(['replicasAutomated', 'replicasTotal'])),
          getJson<GraphResponse>(q(['unevictableBlockedCpu'])),
          getJson<GraphResponse>(q(['unevictableBlockedMemory'])),
        ]);
        const [gAutoCpu, gAutoMem, gHpaCpu, gHpaMem, gSched] = await Promise.all([
          getJson<GraphResponse>(q(['autoCpuRecommendation', 'autoCpuRequests', 'autoCpuRequestsOrigin'])),
          getJson<GraphResponse>(q(['autoMemoryRecommendation', 'autoMemoryRequests', 'autoMemoryRequestsOrigin'])),
          getJson<GraphResponse>(q(['hpaCpuRecommendation', 'hpaCpuRequests', 'hpaCpuRequestsOrigin'])),
          getJson<GraphResponse>(q(['hpaMemoryRecommendation', 'hpaMemoryRequests', 'hpaMemoryRequestsOrigin'])),
          getJson<GraphResponse>(q(['schedulingAutomatedPods'])),
        ]);
        if (dead) return;
        setGraphs({
          cpu: gCpu.values || [],
          mem: gMem.values || [],
          cpuLc: gCpuLc.values || [],
          memLc: gMemLc.values || [],
          pods: gPods.values || [],
          wl: gWl.values || [],
          sav: gSav.values || [],
          cost: gCost.values || [],
          waste: gWaste.values || [],
          eph: gEph.values || [],
          rep: gRep.values || [],
          place: gPlace.values || [],
          replp: gReplp.values || [],
          autoCpu: gAutoCpu.values || [],
          autoMem: gAutoMem.values || [],
          hpaCpu: gHpaCpu.values || [],
          hpaMem: gHpaMem.values || [],
          sched: gSched.values || [],
          blkCpu: gBlkC.values || [],
          blkMem: gBlkM.values || [],
        });
        const n = (gCpu.values || []).length;
        setFooter(
          n >= 2
            ? 'CoolScaler · Resources analytics · ' + n + ' points over ' + R + ' · averages over the selected range'
            : 'CoolScaler · Resources analytics · collecting history… (time-series fills in as samples accrue every 30s)',
        );
      } catch {
        if (!dead) setFooter('analytics: connection error');
      }
      try {
        const d = await getJson<NetworkCostResponse>('/api/network/cost');
        if (!dead) setNet(d);
      } catch {
        /* keep last */
      }
    };
    void load();
    const t = window.setInterval(() => void load(), 30000);
    return () => {
      dead = true;
      window.clearInterval(t);
    };
  }, [range]);

  const wasted = Math.round(singles.wastedSpendPct || 0);
  const wastedColor = wasted >= 15 ? '#f43f5e' : wasted > 0 ? '#f59e0b' : '#16a34a';

  const nss = (net?.namespaces || []).slice(0, 8);
  const nsMax = Math.max(1, ...nss.map((n) => (n.ingressBps || 0) + (n.egressBps || 0)));

  return (
    <main style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Header: title + node-group filter + range selector */}
      <section
        className="card"
        style={{ padding: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ height: 32, width: 32, borderRadius: 8, background: '#eef2ff', display: 'grid', placeItems: 'center' }}>
            <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth={1.8}>
              <circle cx="11" cy="11" r="7" />
              <path d="M21 21l-3.5-3.5M8 11h6M11 8v6" />
            </svg>
          </div>
          <h1 style={{ fontSize: 17, fontWeight: 700, color: '#1e2536', margin: 0 }}>{profile === 'cost' ? 'Cost analytics' : 'Resources analytics'}</h1>
          <div style={{ display: 'flex', gap: 2, background: '#f1f2f7', borderRadius: 8, padding: 2, marginLeft: 4 }}>
            {(['resources', 'cost'] as const).map((p) => (
              <span key={p} className={'seg' + (profile === p ? ' active' : '')} onClick={() => setProfile(p)} style={{ textTransform: 'capitalize' }}>
                {p === 'resources' ? 'Resources' : 'Cost'}
              </span>
            ))}
          </div>
          <Link
            to="/troubleshoot"
            className="chip"
            style={{ textDecoration: 'none', color: '#4f46e5', background: '#eef2ff', border: '1px solid #e0e7ff', fontWeight: 600 }}
            title="Analytics dashboards (Performance and custom dashboards)"
          >
            Open dashboards &rarr;
          </Link>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 13,
              fontWeight: 500,
              color: '#64748b',
              border: '1px solid #e3e5ee',
              borderRadius: 8,
              padding: '6px 12px',
              background: '#fff',
            }}
          >
            <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth={1.8}>
              <rect x="3" y="4" width="18" height="6" rx="1.5" />
              <rect x="3" y="14" width="18" height="6" rx="1.5" />
            </svg>
            All nodes
          </div>
          <div style={{ display: 'flex', gap: 2, background: '#f1f2f7', borderRadius: 8, padding: 2 }}>
            {RANGES.map((r) => (
              <span key={r} className={'seg' + (range === r ? ' active' : '')} onClick={() => setRange(r)}>
                {r}
              </span>
            ))}
          </div>
        </div>
      </section>

      {profile === 'cost' && <CostAnalyticsView range={range} />}
      {profile === 'resources' && (
        <>
      {/* Summary stat cards (avg over range) */}
      <section className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr' }}>
          <div style={{ padding: 24, display: 'grid', gridTemplateRows: '1fr 1fr', gap: 16, borderRight: '1px solid #eef0f6' }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 13, fontWeight: 500, color: '#64748b' }}>
                Allocatable CPU <span style={{ color: '#cbd5e1' }}>(avg.)</span>
              </div>
              <div className="num" style={{ marginTop: 4, fontSize: 30, lineHeight: 1, fontWeight: 700, letterSpacing: '-0.02em', color: '#1e2536' }}>
                {singles.cpuAllocatable != null ? cpuFmt(singles.cpuAllocatable) : '—'}
              </div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 13, fontWeight: 500, color: '#64748b' }}>
                Allocatable memory <span style={{ color: '#cbd5e1' }}>(avg.)</span>
              </div>
              <div className="num" style={{ marginTop: 4, fontSize: 30, lineHeight: 1, fontWeight: 700, letterSpacing: '-0.02em', color: '#1e2536' }}>
                {singles.memoryAllocatable != null ? memFmt(singles.memoryAllocatable) : '—'}
              </div>
            </div>
          </div>
          <div style={{ padding: 24, display: 'grid', placeItems: 'center', borderRight: '1px solid #eef0f6' }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 13, fontWeight: 500, color: '#64748b' }}>
                Wasted spend <span style={{ color: '#cbd5e1' }}>(avg.)</span>
              </div>
              <div
                className="num"
                style={{ marginTop: 4, fontSize: 52, lineHeight: 1, fontWeight: 800, letterSpacing: '-0.02em', color: wastedColor }}
              >
                {singles.wastedSpendPct != null ? wasted + '%' : '—'}
              </div>
            </div>
          </div>
          <div style={{ padding: 24, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 12 }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 13, fontWeight: 500, color: '#64748b', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                Increased resource workloads <span style={{ color: '#cbd5e1' }}>(avg.)</span>
                <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="#cbd5e1" strokeWidth={2}>
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 16v-4M12 8h.01" />
                </svg>
              </div>
              <div className="num" style={{ marginTop: 4, fontSize: 26, lineHeight: 1, fontWeight: 700, color: '#1e2536' }}>
                {singles.performanceOptimizedWorkloads != null ? Math.round(singles.performanceOptimizedWorkloads) : '—'}
              </div>
            </div>
            <div style={{ textAlign: 'center', borderTop: '1px solid #eef0f6', paddingTop: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 500, color: '#64748b' }}>
                Available savings <span style={{ color: '#cbd5e1' }}>/mo</span>
              </div>
              <div className="num" style={{ marginTop: 4, fontSize: 26, lineHeight: 1, fontWeight: 700, color: '#16a34a' }}>
                {singles.availableSavings != null ? usd(singles.availableSavings) : '—'}
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, borderTop: '1px solid #eef0f6', paddingTop: 12 }}>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: '#64748b' }}>
                  Total workloads <span style={{ color: '#cbd5e1' }}>(avg.)</span>
                </div>
                <div className="num" style={{ marginTop: 4, fontSize: 22, lineHeight: 1, fontWeight: 700, color: '#1e2536' }}>
                  {singles.totalNumberOfWorkloads != null ? Math.round(singles.totalNumberOfWorkloads) : '—'}
                </div>
              </div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: '#64748b' }}>
                  Total pods <span style={{ color: '#cbd5e1' }}>(avg.)</span>
                </div>
                <div className="num" style={{ marginTop: 4, fontSize: 22, lineHeight: 1, fontWeight: 700, color: '#1e2536' }}>
                  {singles.totalNumberOfPods != null ? Math.round(singles.totalNumberOfPods) : '—'}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Automation (avg.) */}
      <section className="card" style={{ padding: 20 }}>
        <div style={{ ...cardTitle, marginBottom: 16 }}>
          Automation <span style={{ color: '#cbd5e1', fontWeight: 500, fontSize: 12 }}>(avg.)</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 12 }}>
          {AN_AUTO_TRACKS.map(([label, key, icon]) => (
            <div
              key={key}
              style={{ borderRadius: 12, border: '1px solid #eef0f6', background: '#fafbff', padding: '12px', textAlign: 'center' }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                  fontSize: 11,
                  fontWeight: 500,
                  color: '#64748b',
                  marginBottom: 6,
                }}
              >
                <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth={1.8}>
                  <path d={icon} />
                </svg>
                {label}
              </div>
              <div style={{ fontSize: 20, lineHeight: 1 }}>
                <PctCell a={auto[key]} />
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Total cluster resources */}
      <section className="card" style={{ padding: 20 }}>
        <div style={{ ...cardTitle, marginBottom: 4 }}>Total cluster resources</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, marginTop: 12 }}>
          <div>
            <div style={chartTitle}>CPU</div>
            <SeriesChart values={graphs.cpu || []} series={cpuSeries} yFmt={coresAxis} height={224} />
          </div>
          <div>
            <div style={chartTitle}>Memory</div>
            <SeriesChart values={graphs.mem || []} series={memSeries} yFmt={bytesAxis} height={224} />
          </div>
        </div>
        <Legend
          square
          items={[
            ['#9aa3c0', 'Total usage'],
            ['#22c55e', 'Total optimized request'],
            ['#f59e0b', 'Total request'],
            ['#ef4444', 'Total original request'],
            ['#f6a45c', 'Allocatable'],
            ['#e2b07f', 'Estimated original allocatable'],
          ]}
        />
      </section>

      {/* Allocatable by lifecycle */}
      <section className="card" style={{ padding: 20 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
          <div>
            <div style={chartTitle}>
              CPU allocatable by lifecycle <span style={{ color: '#cbd5e1', fontWeight: 400 }}>(stacked)</span>
            </div>
            <SeriesChart values={graphs.cpuLc || []} series={lcSeries('cpu')} yFmt={coresAxis} stacked />
          </div>
          <div>
            <div style={chartTitle}>
              Memory allocatable by lifecycle <span style={{ color: '#cbd5e1', fontWeight: 400 }}>(stacked)</span>
            </div>
            <SeriesChart values={graphs.memLc || []} series={lcSeries('memory')} yFmt={bytesAxis} stacked />
          </div>
        </div>
        <Legend
          square
          items={[
            ['#f6a45c', 'On-Demand allocatable'],
            ['#f8d2ad', 'Spot allocatable'],
          ]}
        />
      </section>

      {/* Automation progress */}
      <section className="card" style={{ padding: 20 }}>
        <div style={{ ...cardTitle, marginBottom: 12 }}>Automation progress</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
          <div>
            <div style={chartTitle}>Automated rightsizing pods</div>
            <SeriesChart values={graphs.pods || []} series={autoPodsSeries} yFmt={intAxis} />
            <Legend
              items={[
                ['#22c55e', 'Number of automated pods'],
                ['#6366f1', 'Number of pods'],
              ]}
            />
          </div>
          <div>
            <div style={chartTitle}>Workloads over time</div>
            <SeriesChart values={graphs.wl || []} series={wlSeries} yFmt={intAxis} />
            <Legend
              items={[
                ['#8b5cf6', 'Total workloads'],
                ['#f59e0b', 'Increased-resource workloads'],
              ]}
            />
          </div>
          <div>
            <div style={chartTitle}>Automated unevictable pods</div>
            <SeriesChart values={graphs.place || []} series={placeSeries} yFmt={intAxis} />
            <Legend items={[['#22c55e', 'Automated unevictable pods'], ['#6366f1', 'Unevictable pods']]} />
          </div>
          <div>
            <div style={chartTitle}>Automated replicas optimization pods</div>
            <SeriesChart values={graphs.replp || []} series={replpSeries} yFmt={intAxis} />
            <Legend items={[['#22c55e', 'Automated replicas pods'], ['#6366f1', 'Replicas workloads']]} />
          </div>
          <div>
            <div style={chartTitle}>Automated pod scheduling pods</div>
            <SeriesChart values={graphs.sched || []} series={schedPodsSeries} yFmt={intAxis} />
            <Legend items={[['#22c55e', 'Automated pod scheduling pods']]} />
          </div>
          <div>
            <div style={chartTitle}>Allocatable CPU blocked by unevictable pods</div>
            <SeriesChart values={graphs.blkCpu || []} series={blkCpuSeries} yFmt={coresAxis} />
            <Legend items={[['#f59e0b', 'Allocatable CPU blocked (cores)']]} />
          </div>
          <div>
            <div style={chartTitle}>Allocatable memory blocked by unevictable pods</div>
            <SeriesChart values={graphs.blkMem || []} series={blkMemSeries} yFmt={bytesAxis} />
            <Legend items={[['#ef4444', 'Allocatable memory blocked']]} />
          </div>
        </div>
      </section>

      {/* Automated resources progress */}
      <section className="card" style={{ padding: 20 }}>
        <div style={{ ...cardTitle, marginBottom: 12 }}>Automated resources progress</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
          <div>
            <div style={chartTitle}>Automated rightsizing CPU requests</div>
            <SeriesChart values={graphs.autoCpu || []} series={autoResSeries('autoCpu')} yFmt={coresAxis} />
            <Legend items={[['#22c55e', 'Current optimized request'], ['#f59e0b', 'Current request'], ['#ef4444', 'Original request']]} />
          </div>
          <div>
            <div style={chartTitle}>Automated rightsizing memory requests</div>
            <SeriesChart values={graphs.autoMem || []} series={autoResSeries('autoMemory')} yFmt={bytesAxis} />
            <Legend items={[['#22c55e', 'Current optimized request'], ['#f59e0b', 'Current request'], ['#ef4444', 'Original request']]} />
          </div>
          <div>
            <div style={chartTitle}>Automated replicas optimization CPU requests</div>
            <SeriesChart values={graphs.hpaCpu || []} series={autoResSeries('hpaCpu')} yFmt={coresAxis} />
            <Legend items={[['#22c55e', 'Current optimized request'], ['#f59e0b', 'Current request'], ['#ef4444', 'Original request']]} />
          </div>
          <div>
            <div style={chartTitle}>Automated replicas optimization memory requests</div>
            <SeriesChart values={graphs.hpaMem || []} series={autoResSeries('hpaMemory')} yFmt={bytesAxis} />
            <Legend items={[['#22c55e', 'Current optimized request'], ['#f59e0b', 'Current request'], ['#ef4444', 'Original request']]} />
          </div>
        </div>
      </section>

      {/* Savings & cost over time ($) */}
      <section className="card" style={{ padding: 20 }}>
        <div style={{ ...cardTitle, marginBottom: 12 }}>Savings &amp; cost over time</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
          <div>
            <div style={chartTitle}>Savings over time ($/mo)</div>
            <SeriesChart values={graphs.sav || []} series={savingsSeries} yFmt={dollarAxis} />
            <Legend
              items={[
                ['#22c55e', 'Active (realized)'],
                ['#f59e0b', 'Available (potential)'],
              ]}
            />
          </div>
          <div>
            <div style={chartTitle}>Cost over time ($/mo)</div>
            <SeriesChart values={graphs.cost || []} series={costSeries} yFmt={dollarAxis} />
            <Legend
              items={[
                ['#ef4444', 'Current request cost'],
                ['#22c55e', 'Right-sized cost'],
              ]}
            />
          </div>
        </div>
      </section>

      {/* Waste breakdown over time ($) */}
      <section className="card" style={{ padding: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div style={cardTitle}>Waste breakdown over time</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, fontSize: 11, color: '#64748b' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span style={{ height: 8, width: 12, borderRadius: 2, background: '#6366f1' }} />
              CPU waste ($/mo)
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span style={{ height: 8, width: 12, borderRadius: 2, background: '#f59e0b' }} />
              Memory waste ($/mo)
            </span>
          </div>
        </div>
        <SeriesChart values={graphs.waste || []} series={wasteSeries} yFmt={dollarAxis} height={224} stacked />
      </section>

      {/* Ephemeral storage + Replicas over time */}
      <section className="card" style={{ padding: 20 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
          <div>
            <div style={chartTitle}>Ephemeral storage over time</div>
            <SeriesChart values={graphs.eph || []} series={ephSeries} yFmt={bytesAxis} />
            <Legend
              items={[
                ['#9aa3c0', 'Usage'],
                ['#22c55e', 'Optimized request'],
                ['#f59e0b', 'Request'],
              ]}
            />
          </div>
          <div>
            <div style={chartTitle}>Replicas &amp; pods over time</div>
            <SeriesChart values={graphs.rep || []} series={repSeries} yFmt={intAxis} />
            <Legend
              items={[
                ['#6366f1', 'Current replicas'],
                ['#8b5cf6', 'Un-evictable pods'],
              ]}
            />
          </div>
        </div>
      </section>

      {/* Network cost rollup + service dependency map */}
      <section className="card" style={{ padding: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div>
            <div style={cardTitle}>Network cost &amp; dependencies</div>
            <div style={{ fontSize: 12, color: '#64748b' }}>
              Cross-AZ traffic cost by namespace + top service-to-service talkers.
            </div>
          </div>
          <span className="pill" style={{ background: '#eef2ff', color: '#4f46e5' }}>
            {net ? 'cross-AZ $ ??? · ingress ' + Bps(net.totals?.ingressBps) + ' · egress ' + Bps(net.totals?.egressBps) : '—'}
          </span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#64748b', marginBottom: 8 }}>
              Cross-AZ cost by namespace ($/mo)
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {nss.length ? (
                nss.map((n) => {
                  const tot = (n.ingressBps || 0) + (n.egressBps || 0);
                  return (
                    <div key={n.namespace} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <div
                        style={{
                          width: 112,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          fontSize: 12,
                          color: '#475569',
                        }}
                      >
                        {n.namespace}
                      </div>
                      <div style={{ flex: 1, background: '#eef0f6', borderRadius: 999, height: 10, overflow: 'hidden' }}>
                        <div
                          style={{
                            height: 10,
                            borderRadius: 999,
                            background: 'linear-gradient(to right, #3b82f6, #8b5cf6)',
                            width: ((tot / nsMax) * 100).toFixed(1) + '%',
                          }}
                        />
                      </div>
                      <div style={{ width: 80, textAlign: 'right', fontSize: 12, fontWeight: 600, color: '#4f46e5' }}>
                        {Bps(tot)}
                      </div>
                    </div>
                  );
                })
              ) : (
                <div style={{ color: '#94a3b8', fontSize: 12 }}>No network traffic.</div>
              )}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#64748b', marginBottom: 8 }}>Top service dependencies</div>
            <div style={{ color: '#94a3b8', fontSize: 12 }}>
              Service dependency map &amp; cross-AZ cost <b>???</b> — require an eBPF flow agent (not collected).
              Per-namespace ingress/egress above are real cAdvisor metrics.
            </div>
          </div>
        </div>
      </section>

        </>
      )}

      <footer style={{ textAlign: 'center', fontSize: 12, color: '#94a3b8', paddingTop: 8, paddingBottom: 24 }}>{footer}</footer>
    </main>
  );
}
