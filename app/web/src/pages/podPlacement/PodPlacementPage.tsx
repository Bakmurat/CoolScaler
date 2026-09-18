// Pod Placement page
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { getJson, postJson } from '../../api/client';
import { useFeedback } from '../../providers/FeedbackProvider';
import { useClusterData } from '../../providers/ClusterDataProvider';
import { useGlobalSearchString } from '../../hooks/useUrlState';
import { usd } from '../../lib/format';
import { workloadOverviewId } from '../rightsizing/lib';
import { Dropdown, Toggle } from '../rightsizing/ui';
import '../rightsizing/rightsizing.css';
import NodeDrawer from '../nodeManagement/NodeDrawer';
import type { AnalyticsGraphResponse } from '../rightsizing/types';
import type { PlacementResponse, PpBlockedNode, PpWorkload } from './types';
import {
  AllocReqWasteChart,
  AutoDonut,
  FilterChipSelect,
  GoodButton,
  IllusBox,
  IllusButton,
  IllusModal,
  IndigoButton,
  NodesBarChart,
  ReasonPill,
  TrendChart,
  cardStyle,
  dollarAxis,
  intAxis,
  thStyle,
  type GraphValues,
} from './shared';
import { UnevictableByNodeChart, hasNodeCategoryData } from './unevictableByNode';

const REASON_LABELS: [string, string][] = [
  ['pdb', 'PDB / Annotation'],
  ['localstorage', 'Local storage'],
  ['kube-system', 'kube-system'],
  ['unready', 'Un-ready workloads'],
  ['ownerless', 'Pods without owner'],
];

const trunc = (s: string, n = 42) => (s.length > n ? s.slice(0, n) + '…' : s);

const filtSel: CSSProperties = {
  background: '#f4f5f8',
  border: '1px solid #e9eaf0',
  borderRadius: 8,
  padding: '4px 8px',
  fontSize: 12,
  color: '#334155',
  cursor: 'pointer',
  fontFamily: 'inherit',
  outline: 'none',
};

export function useGraph(range: '7d' | '30d', types: string[]): GraphValues {
  const [values, setValues] = useState<GraphValues>([]);
  const typesKey = types.join(',');
  useEffect(() => {
    let dead = false;
    const grp = range === '30d' ? 'day' : 'hour';
    getJson<AnalyticsGraphResponse>(
      '/api/analytics/graph?range=' + range + '&groupBy=' + grp + typesKey.split(',').map((t) => '&types=' + t).join(''),
    )
      .then((g) => {
        if (!dead) setValues(g.values || []);
      })
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [range, typesKey]);
  return values;
}

export default function PodPlacementPage() {
  const { toast, confirm } = useFeedback();
  const { ro: RO, overview } = useClusterData();
  const navigate = useNavigate();
  const search = useGlobalSearchString();

  const [data, setData] = useState<PlacementResponse>({});
  const [resRange, setResRange] = useState<'7d' | '30d'>('7d');
  const [trRange, setTrRange] = useState<'7d' | '30d'>('7d');
  const [tab, setTab] = useState<'wl' | 'nd'>('wl');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [actionsOpen, setActionsOpen] = useState(false);
  const [illusOpen, setIllusOpen] = useState(false);
  const [openNode, setOpenNode] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [nsF, setNsF] = useState('');
  const [reasonF, setReasonF] = useState('');
  const [nodeF, setNodeF] = useState('');
  const [labelF, setLabelF] = useState('');
  const [annF, setAnnF] = useState('');
  const [ndQ, setNdQ] = useState('');
  const [ndReason, setNdReason] = useState('');
  const [chips, setChips] = useState<Set<'automated' | 'unautomated' | 'savings'>>(new Set());

  const resTypes = useMemo(() => ['cpuAllocatable', 'cpuRequests', 'memoryAllocatable', 'memoryRequests'], []);
  const trTypes = useMemo(() => ['wastedSpend', 'numberOfUnevictablePods', 'blockedNodes'], []);
  const [kpiMode, setKpiMode] = useState<'live' | '1d'>('live');
  const [avg24, setAvg24] = useState<{ cost?: number; waste?: number }>({});
  useEffect(() => {
    if (kpiMode !== '1d') return;
    let dead = false;
    Promise.all([
      getJson<{ value?: number }>('/api/analytics/single?range=24h&type=totalWorkloadCostMonthly'),
      getJson<{ value?: number }>('/api/analytics/single?range=24h&type=wastedSpendPct'),
    ])
      .then(([c, w]) => !dead && setAvg24({ cost: c.value, waste: w.value }))
      .catch(() => {});
    return () => { dead = true; };
  }, [kpiMode]);
  const resVals = useGraph(resRange, resTypes);
  const trVals = useGraph(trRange, trTypes);

  const load = useCallback(async () => {
    try {
      setData(await getJson<PlacementResponse>('/api/placement'));
    } catch {
      /* keep last */
    }
  }, []);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), 30000);
    return () => window.clearInterval(t);
  }, [load]);

  const t = data.totals || {};
  const cats = data.categories || [];
  const allWl = data.workloads || [];
  const blockedNodes = data.blockedNodes || [];
  const cluster = data.clusterName || overview?.clusterName || 'cluster';
  const tot = t.unevictableWorkloads || 0;
  const auto = t.automated || 0;
  const br = t.blockedByReason || {};

  /* ---- filters (renderPlacement filterOnly path) ---- */
  const nsList = useMemo(() => [...new Set(allWl.map((w) => w.namespace))].sort(), [allWl]);
  const reasonList = useMemo(() => [...new Set(allWl.flatMap((w) => w.reasonChips || []))].sort(), [allWl]);
  const labelList = useMemo(
    () => [...new Set(allWl.flatMap((w) => Object.entries(w.labels || {}).map(([k, v]) => k + '=' + v)))].sort(),
    [allWl],
  );
  const annList = useMemo(
    () => [...new Set(allWl.flatMap((w) => Object.entries(w.annotations || {}).map(([k, v]) => k + '=' + v)))].sort(),
    [allWl],
  );
  const nodeList = useMemo(() => [...new Set(allWl.flatMap((w) => w.nodes || []))].sort(), [allWl]);
  const fw = allWl.filter((w) => {
    if (q && !(w.name + w.namespace + w.kind).toLowerCase().includes(q.toLowerCase())) return false;
    if (nsF && w.namespace !== nsF) return false;
    if (reasonF && !(w.reasonChips || []).includes(reasonF)) return false;
    if (nodeF && !(w.nodes || []).includes(nodeF)) return false;
    if (labelF && !Object.entries(w.labels || {}).some(([k, v]) => k + '=' + v === labelF)) return false;
    if (annF && !Object.entries(w.annotations || {}).some(([k, v]) => k + '=' + v === annF)) return false;
    if (chips.has('automated') && !w.automated) return false;
    if (chips.has('unautomated') && w.automated) return false;
    if (chips.has('savings') && !((w.savings || 0) > 0.5)) return false;
    return true;
  });

  /* ---- blocked-nodes table filters (search + blocking-reasons dropdown) ---- */
  const ndReasonList = useMemo(
    () => [...new Set(blockedNodes.flatMap((n) => n.reasonChips || []))].sort(),
    [blockedNodes],
  );
  const fbn = blockedNodes.filter((n) => {
    if (ndQ && !n.node.toLowerCase().includes(ndQ.toLowerCase())) return false;
    if (ndReason && !(n.reasonChips || []).includes(ndReason)) return false;
    return true;
  });

  /* Explore automation — the workloads view of this page CAN filter by node
   * (w.nodes), so route there with a node filter chip instead of faking a
   * cross-page deep link that the rightsizing table cannot honor. */
  const exploreAutomation = (n: PpBlockedNode) => {
    setTab('wl');
    setNodeF(n.node);
    window.setTimeout(
      () => document.getElementById('ppWlRows')?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
      60,
    );
  };

  const automateWl = async (key: string, enabled: boolean) => {
    if (RO) {
      toast('Cluster is in READ-ONLY mode.');
      return;
    }
    await postJson('/api/placement-automate', { key, enabled }).catch(() => {});
    void load();
  };
  const automateAll = async (category?: string, enabled?: boolean) => {
    if (RO) {
      toast('Cluster is in READ-ONLY mode.');
      return;
    }
    const body = category ? { category, enabled: enabled !== false } : { enabled: true };
    if (!category && !(await confirm('Automate bin-packing for ALL un-evictable workloads (current + future)?'))) return;
    await postJson('/api/placement-automate-all', body).catch(() => {});
    void load();
  };
  const optimizeCat = async (category: string) => {
    if (RO) {
      toast('Cluster is in READ-ONLY mode.');
      return;
    }
    const catOf: Record<string, string> = {
      pdb: 'unevictable',
      annotation: 'unevictable',
      localstorage: 'localstorage',
      'kube-system': 'kube-system',
    };
    const ws = allWl.filter((w) => (w.reasons || []).some((r) => catOf[r] === category) && w.rolloutEligible);
    if (!ws.length) {
      toast('No rollout-eligible workloads in this category.', 'warn');
      return;
    }
    if (
      !(await confirm(
        `Bin-pack ${ws.length} ${category} workload(s) now? They get a preferred affinity toward the packing node (rolling update).`,
      ))
    )
      return;
    const r = await postJson<{ count?: number }>('/api/placement-bulk', {
      action: 'rollout',
      keys: ws.map((w) => w.key),
    }).catch(() => ({}) as { count?: number });
    toast(`Optimize: bin-packed ${r.count || 0} workload(s).`);
    void load();
  };
  const bulk = async (action: 'automate' | 'rollout') => {
    if (RO) {
      toast('Cluster is in READ-ONLY mode.');
      return;
    }
    const keys = [...selected];
    if (!keys.length) {
      toast('Select one or more workloads first.', 'warn');
      return;
    }
    if (action === 'rollout' && !(await confirm(`Rollout (bin-pack) ${keys.length} workload(s)? Ownerless & un-ready are skipped.`)))
      return;
    const r = await postJson<{ count?: number }>('/api/placement-bulk', { action, keys }).catch(() => ({}) as { count?: number });
    setActionsOpen(false);
    toast(`${action}: applied to ${r.count || 0} workload(s).`);
    void load();
  };

  const openWorkload = (w: PpWorkload) => {
    const sp = new URLSearchParams(search);
    sp.set('selectedWorkloadOverviewId', workloadOverviewId(cluster, { namespace: w.namespace, kind: w.kind, name: w.name }));
    navigate({ pathname: '/rightSizing/workloads', search: '?' + sp.toString() });
  };

  const maxPods = Math.max(1, ...blockedNodes.map((n) => n.pods || 0));
  const bnSorted = blockedNodes.slice().sort((a, b) => (b.pods || 0) - (a.pods || 0));
  const freed = blockedNodes.filter((n) => n.freeable);

  return (
    <main style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* header */}
      <section style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ height: 32, width: 32, borderRadius: 8, background: '#eef2ff', display: 'grid', placeItems: 'center' }}>
            <svg style={{ width: 18, height: 18, color: '#6366f1' }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
              <rect x="3" y="3" width="8" height="8" rx="1.5" />
              <rect x="13" y="13" width="8" height="8" rx="1.5" />
              <path d="M11 7h6M7 11v6" />
            </svg>
          </div>
          <div>
            <h1 style={{ fontSize: 17, fontWeight: 700, color: '#1e2536', margin: 0 }}>Pod Placement</h1>
            <p style={{ fontSize: 12, color: '#64748b', margin: 0 }}>
              Un-evictable pods that block node scale-down — bin-pack them to free nodes.
            </p>
          </div>
        </div>
      </section>

      {/* top summary */}
      <div style={{ display: 'inline-flex', gap: 2, background: '#f1f2f7', borderRadius: 8, padding: 2, width: 'max-content' }}>
        {(['live', '1d'] as const).map((m) => (
          <span key={m} className={'tabline' + (kpiMode === m ? ' active' : '')} onClick={() => setKpiMode(m)}>
            {m === 'live' ? 'Live' : '1 day'}
          </span>
        ))}
      </div>
      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: 16 }}>
        <div style={{ ...cardStyle, padding: 16, display: 'grid', gridTemplateColumns: '1fr 1fr' }}>
          <div style={{ textAlign: 'center', padding: '0 8px', borderRight: '1px solid #eef0f6' }}>
            <div style={{ fontSize: 12, color: '#64748b' }}>
              Monthly cost <span style={{ color: '#cbd5e1' }}>{kpiMode === 'live' ? '(live)' : '(24h avg)'}</span>
            </div>
            <div className="num" style={{ marginTop: 8, fontSize: 28, lineHeight: 1, fontWeight: 700, color: '#4f46e5' }}>
              {kpiMode === '1d'
                ? (avg24.cost != null ? usd(avg24.cost) : '—')
                : (t.monthlyCost != null ? usd(t.monthlyCost) : '—')}
            </div>
          </div>
          <div style={{ textAlign: 'center', padding: '0 8px' }}>
            <div style={{ fontSize: 12, color: '#64748b' }}>Wasted spend</div>
            <div className="num" style={{ marginTop: 8, fontSize: 28, lineHeight: 1, fontWeight: 700, color: '#f43f5e' }}>
              {kpiMode === '1d'
                ? (avg24.waste != null ? Math.round(avg24.waste) + '%' : '—')
                : (t.wastePct != null ? Math.round(t.wastePct) + '%' : '—')}
            </div>
          </div>
        </div>
        <div style={{ ...cardStyle, padding: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: '#94a3b8', marginBottom: 4 }}>
            Blocked nodes by reason
          </div>
          <div>
            {REASON_LABELS.map(([k, lab]) => (
              <div key={k} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12, padding: '2px 0' }}>
                <span style={{ color: '#64748b' }}>{lab}</span>
                <span className="num" style={{ fontWeight: 700, color: (br[k] || 0) > 0 ? '#f43f5e' : '#94a3b8' }}>{br[k] || 0}</span>
              </div>
            ))}
          </div>
        </div>
        <div style={{ ...cardStyle, padding: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
          <AutoDonut auto={auto} total={tot} legendRows itemLabel="un-evictable workloads" />
          <div style={{ flex: 1, textAlign: 'right' }}>
            <div style={{ fontSize: 13, color: '#64748b' }}>Un-evictable workloads</div>
            <div className="num" style={{ fontSize: 20, fontWeight: 700, color: '#1e2536' }}>{tot}</div>
            <GoodButton disabled={RO || tot === 0} onClick={() => void automateAll()} style={{ marginTop: 6 }}>
              <svg style={{ width: 12, height: 12 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path d="M5 3l14 9-14 9z" />
              </svg>
              Automate All
            </GoodButton>
          </div>
        </div>
      </section>

      {/* resource graphs */}
      <section style={{ ...cardStyle, padding: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#1e2536' }}>
            Resource graphs{' '}
            <span style={{ fontSize: 11, fontWeight: 400, color: '#94a3b8' }}>
              (CPU &amp; memory allocatable vs requested · nodes current vs optimized)
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ display: 'inline-flex', borderRadius: 8, border: '1px solid #e9eaf0', overflow: 'hidden', fontSize: 11, fontWeight: 600 }}>
              {(['7d', '30d'] as const).map((r) => (
                <button
                  key={r}
                  className={'seg' + (resRange === r ? ' active' : '')}
                  style={{ border: 'none', background: resRange === r ? undefined : 'transparent', padding: '4px 10px', fontFamily: 'inherit', fontSize: 11, fontWeight: 600, cursor: 'pointer', borderRadius: 0 }}
                  onClick={() => setResRange(r)}
                >
                  {r === '7d' ? '7 Days' : '30 Days'}
                </button>
              ))}
            </div>
            <IllusButton onClick={() => setIllusOpen(true)}>Unevictable Illustration</IllusButton>
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: 16 }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#64748b', marginBottom: 4, textAlign: 'center' }}>CPU over time</div>
            <div style={{ height: 144 }}>
              <AllocReqWasteChart values={resVals} resource="cpu" />
            </div>
          </div>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#64748b', marginBottom: 4, textAlign: 'center' }}>Memory over time</div>
            <div style={{ height: 144 }}>
              <AllocReqWasteChart values={resVals} resource="memory" />
            </div>
          </div>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#64748b', marginBottom: 4, textAlign: 'center' }}>Nodes (current vs optimized)</div>
            <div style={{ height: 144 }}>
              <NodesBarChart current={t.nodes || 0} optimized={t.optimizedNodes || 0} />
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 16, marginTop: 8, fontSize: 10, color: '#94a3b8' }}>
          {(
            [
              ['#f6a45c', 'Allocatable'],
              ['#6366f1', 'Requested'],
              ['#22c55e', 'Optimized nodes'],
            ] as const
          ).map(([c, l]) => (
            <span key={l} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <span style={{ display: 'inline-block', width: 12, height: 6, borderRadius: 3, background: c }} />
              {l}
            </span>
          ))}
        </div>
      </section>

      {/* category action cards */}
      <section style={{ ...cardStyle, padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '12px 20px', borderBottom: '1px solid #eef0f6', fontSize: 14, fontWeight: 700, color: '#1e2536' }}>
          Automate un-evictable workloads
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: 12, padding: 16 }}>
          {cats.length ? (
            cats.map((c) => (
              <div key={c.key} style={{ borderRadius: 8, border: '1px solid #eef0f5', padding: 12 }}>
                <div style={{ fontWeight: 600, color: '#1e2536', fontSize: 13 }}>{c.label}</div>
                <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 8, minHeight: 28 }}>{c.desc}</div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span style={{ fontSize: 11, color: '#64748b' }}>
                    savings <span className="num" style={{ color: '#16a34a', fontWeight: 600 }}>{usd(c.savings)}</span>
                  </span>
                  <span className="num" style={{ fontSize: 11, color: '#94a3b8' }}>
                    {c.automated || 0}/{c.pods || 0} pods automated
                  </span>
                </div>
                <div style={{ height: 6, borderRadius: 999, background: '#eef0f6', overflow: 'hidden', marginBottom: 8 }}>
                  <div
                    style={{
                      height: '100%',
                      background: '#22c55e',
                      width: (c.pods ? Math.round(((c.automated || 0) / c.pods) * 100) : 0) + '%',
                    }}
                  />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 11, color: '#334155' }}>Automate Upon Pod Creation</span>
                  <Toggle
                    checked={(c.automated || 0) > 0}
                    disabled={RO}
                    title={RO ? 'Read-only' : undefined}
                    onChange={(on) => void automateAll(c.key, on)}
                  />
                </div>
                {c.canOptimize && (
                  <button
                    disabled={RO}
                    onClick={() => void optimizeCat(c.key)}
                    style={{
                      marginTop: 8,
                      width: '100%',
                      fontSize: 12,
                      fontWeight: 600,
                      borderRadius: 8,
                      padding: '6px 0',
                      fontFamily: 'inherit',
                      cursor: RO ? 'not-allowed' : 'pointer',
                      border: RO ? 'none' : '1px solid #c7d2fe',
                      background: RO ? '#f1f5f9' : 'transparent',
                      color: RO ? '#94a3b8' : '#4f46e5',
                    }}
                  >
                    Optimize Now
                  </button>
                )}
                <button
                  onClick={() => document.getElementById('ppWlRows')?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
                  style={{
                    marginTop: 6,
                    width: '100%',
                    fontSize: 11,
                    fontWeight: 600,
                    color: '#6366f1',
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  Explore workloads →
                </button>
              </div>
            ))
          ) : (
            <div style={{ gridColumn: 'span 3', padding: '24px 20px', textAlign: 'center', color: '#94a3b8' }}>
              No un-evictable categories.
            </div>
          )}
        </div>
      </section>

      {/* troubleshoot */}
      <section style={{ ...cardStyle, padding: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#1e2536' }}>Unevictable pods troubleshoot</div>
            <div style={{ fontSize: 12, color: '#64748b' }}>
              Un-evictable pods per node, and how wasted spend / blocked nodes trend over time.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 2, background: '#f1f2f7', borderRadius: 8, padding: 2 }}>
            {(['7d', '30d'] as const).map((r) => (
              <span key={r} className={'seg' + (trRange === r ? ' active' : '')} onClick={() => setTrRange(r)}>
                {r === '7d' ? '7 Days' : '30 Days'}
              </span>
            ))}
          </div>
        </div>
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#64748b', marginBottom: 4 }}>Unevictable pods by node</div>
          {hasNodeCategoryData(bnSorted) ? (
            <UnevictableByNodeChart nodes={bnSorted} />
          ) : (
          <div>
            {bnSorted.length ? (
              bnSorted.map((n) => (
                <div key={n.node} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0' }}>
                  <div
                    title={n.node}
                    style={{ width: 192, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, color: '#334155' }}
                  >
                    {n.node}
                  </div>
                  <div style={{ flex: 1, height: 8, borderRadius: 999, background: '#eef0f6', overflow: 'hidden' }}>
                    <div
                      style={{
                        height: '100%',
                        background: n.freeable ? '#22c55e' : '#fbbf24',
                        width: Math.round(((n.pods || 0) / maxPods) * 100) + '%',
                      }}
                    />
                  </div>
                  <span className="num" style={{ fontSize: 11, color: '#64748b', width: 64, textAlign: 'right' }}>{n.pods || 0} pods</span>
                </div>
              ))
            ) : (
              <div style={{ color: '#94a3b8', fontSize: 14, padding: '8px 0' }}>No blocked nodes — nothing to bin-pack.</div>
            )}
          </div>
          )}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: 16, marginTop: 12 }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#64748b', marginBottom: 4 }}>Wasted spend ($/mo)</div>
            <div style={{ height: 160 }}>
              <TrendChart values={trVals} dataKey="wastedSpend" stroke="#f59e0b" fill="rgba(245,158,11,.12)" fmt={dollarAxis} />
            </div>
          </div>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#64748b', marginBottom: 4 }}>Unevictable pods</div>
            <div style={{ height: 160 }}>
              <TrendChart values={trVals} dataKey="numberOfUnevictablePods" stroke="#8b5cf6" fill="rgba(139,92,246,.12)" fmt={intAxis} />
            </div>
          </div>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#64748b', marginBottom: 4 }}>Blocked nodes</div>
            <div style={{ height: 160 }}>
              <TrendChart values={trVals} dataKey="blockedNodes" stroke="#f43f5e" fill="rgba(244,63,94,.12)" fmt={intAxis} />
            </div>
          </div>
        </div>
      </section>

      {/* workloads / blocked nodes tabs */}
      <section style={{ ...cardStyle, padding: 0 }}>
        <div
          style={{
            padding: '12px 20px',
            borderBottom: '1px solid #eef0f6',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ display: 'flex', gap: 4 }}>
            {(
              [
                ['wl', 'Workloads'],
                ['nd', 'Blocked nodes'],
              ] as const
            ).map(([k, lab]) => (
              <button
                key={k}
                onClick={() => setTab(k)}
                style={{
                  padding: '6px 12px',
                  fontSize: 13,
                  fontWeight: 600,
                  background: 'none',
                  border: 'none',
                  borderBottom: tab === k ? '2px solid #6366f1' : '2px solid transparent',
                  color: tab === k ? '#4f46e5' : '#94a3b8',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                {lab}
              </button>
            ))}
          </div>
          <div style={{ position: 'relative' }}>
            <IndigoButton
              onClick={(e) => {
                e.stopPropagation();
                setActionsOpen((v) => !v);
              }}
            >
              Un-evictable Actions
            </IndigoButton>
            <Dropdown open={actionsOpen} onClose={() => setActionsOpen(false)} style={{ right: 0, width: 192, padding: '4px 0' }}>
              <div style={{ padding: '4px 12px', fontSize: 10, textTransform: 'uppercase', letterSpacing: '.04em', color: '#94a3b8', fontWeight: 700 }}>
                {selected.size} selected
              </div>
              {(
                [
                  ['automate', 'Automate'],
                  ['rollout', 'Rollout (bin-pack now)'],
                ] as const
              ).map(([a, lab]) => (
                <button
                  key={a}
                  onClick={() => void bulk(a)}
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    padding: '6px 12px',
                    fontSize: 13,
                    color: '#334155',
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = '#f8fafc')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  {lab}
                </button>
              ))}
              <div style={{ padding: '4px 12px 4px', fontSize: 10, color: '#94a3b8' }}>ownerless &amp; un-ready are skipped</div>
            </Dropdown>
          </div>
        </div>
        {tab === 'wl' && (
          <div
            style={{
              padding: '8px 20px',
              borderBottom: '1px solid #eef0f6',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flexWrap: 'wrap',
              fontSize: 12,
            }}
          >
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search…"
              style={{ ...filtSel, cursor: 'text', width: 160 }}
            />
            <select value={nsF} onChange={(e) => setNsF(e.target.value)} style={filtSel}>
              <option value="">namespaces</option>
              {nsList.map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
            <select value={reasonF} onChange={(e) => setReasonF(e.target.value)} style={filtSel}>
              <option value="">reasons</option>
              {reasonList.map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
            <FilterChipSelect
              label="labels"
              value={labelF}
              options={labelList.map((l) => [l, trunc(l)] as [string, string])}
              onChange={setLabelF}
            />
            <FilterChipSelect
              label="annotations"
              value={annF}
              options={annList.map((a) => [a, trunc(a)] as [string, string])}
              onChange={setAnnF}
            />
            <FilterChipSelect
              label="blocked node"
              value={nodeF}
              options={nodeList.map((n) => [n, n] as [string, string])}
              onChange={setNodeF}
            />
            {(['automated', 'unautomated', 'savings'] as const).map((f) => (
              <span
                key={f}
                className={'chip' + (chips.has(f) ? ' on' : '')}
                onClick={() =>
                  setChips((prev) => {
                    const s = new Set(prev);
                    if (s.has(f)) s.delete(f);
                    else s.add(f);
                    return s;
                  })
                }
              >
                {f === 'unautomated' ? 'un-automated' : f}
              </span>
            ))}
          </div>
        )}
        {tab === 'nd' && (
          <div
            style={{
              padding: '8px 20px',
              borderBottom: '1px solid #eef0f6',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flexWrap: 'wrap',
              fontSize: 12,
            }}
          >
            <input
              value={ndQ}
              onChange={(e) => setNdQ(e.target.value)}
              placeholder="Search…"
              style={{ ...filtSel, cursor: 'text', width: 160 }}
            />
            <FilterChipSelect
              label="blocking reasons"
              value={ndReason}
              options={ndReasonList.map((r) => [r, r] as [string, string])}
              onChange={setNdReason}
            />
          </div>
        )}
        {tab === 'wl' ? (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ ...thStyle, paddingLeft: 16, paddingRight: 4 }}>
                    <input
                      type="checkbox"
                      checked={allWl.length > 0 && selected.size === allWl.length}
                      onChange={(e) => setSelected(e.target.checked ? new Set(allWl.map((w) => w.key)) : new Set())}
                    />
                  </th>
                  <th style={{ ...thStyle, padding: '10px 8px' }}>Workload</th>
                  <th style={thStyle}>Available Savings</th>
                  <th style={thStyle}>Un-evictable Reason</th>
                  <th style={thStyle}>Replicas</th>
                  <th style={{ ...thStyle, textAlign: 'center' }}>Automated</th>
                </tr>
              </thead>
              <tbody id="ppWlRows">
                {fw.map((w) => (
                  <tr
                    key={w.key}
                    style={{ borderBottom: '1px solid #f1f2f7' }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(248,250,252,.5)')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                  >
                    <td style={{ paddingLeft: 16, paddingRight: 4 }}>
                      <input
                        type="checkbox"
                        checked={selected.has(w.key)}
                        onChange={(e) =>
                          setSelected((prev) => {
                            const s = new Set(prev);
                            if (e.target.checked) s.add(w.key);
                            else s.delete(w.key);
                            return s;
                          })
                        }
                      />
                    </td>
                    <td
                      style={{ padding: '12px 8px', cursor: 'pointer' }}
                      title="Open workload overview"
                      onClick={() => openWorkload(w)}
                    >
                      <div style={{ fontWeight: 600, color: '#1e2536', display: 'flex', alignItems: 'center', gap: 4 }}>
                        {w.optimized ? (
                          <span style={{ color: '#10b981' }} title="optimized">
                            ✓
                          </span>
                        ) : (
                          <span style={{ color: '#cbd5e1' }} title="rollout required">
                            ⓘ
                          </span>
                        )}{' '}
                        {w.name}
                      </div>
                      <div style={{ fontSize: 11, color: '#94a3b8' }}>
                        {w.namespace} · {w.kind}
                      </div>
                    </td>
                    <td
                      className="num"
                      style={{ padding: '0 12px', color: (w.savings || 0) > 0.5 ? '#16a34a' : '#cbd5e1', fontWeight: (w.savings || 0) > 0.5 ? 600 : 400 }}
                    >
                      {(w.savings || 0) > 0.5 ? usd(w.savings) : '$0'}
                    </td>
                    <td style={{ padding: '0 12px' }}>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                        {(w.reasonChips || []).map((r) => (
                          <ReasonPill key={r} reason={r} />
                        ))}
                      </div>
                    </td>
                    <td className="num" style={{ padding: '0 12px', color: '#334155' }}>{w.replicas}</td>
                    <td style={{ padding: '0 12px', textAlign: 'center' }}>
                      <Toggle
                        checked={!!w.automated}
                        disabled={RO}
                        title={RO ? 'Read-only' : undefined}
                        onChange={(on) => void automateWl(w.key, on)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {fw.length === 0 && (
              <div style={{ padding: '40px 20px', textAlign: 'center', fontSize: 14, color: '#94a3b8' }}>
                No un-evictable workloads blocking scale-down. 🎉
              </div>
            )}
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ ...thStyle, padding: '10px 20px' }}>Node</th>
                  <th style={thStyle}>Available Savings</th>
                  <th style={thStyle}>Blocking reasons</th>
                  <th style={thStyle}>Blocking pods</th>
                  <th style={{ ...thStyle, textAlign: 'center' }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {fbn.length ? (
                  fbn.map((n) => (
                    <tr
                      key={n.node}
                      style={{ borderBottom: '1px solid #f1f2f7', cursor: 'pointer' }}
                      onClick={() => setOpenNode(n.node)}
                      onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(248,250,252,.5)')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                    >
                      <td style={{ padding: '10px 20px', fontWeight: 500, color: '#334155' }}>
                        {n.node}
                        {n.freeable ? (
                          <span className="pill" style={{ background: '#f0fdf4', color: '#16a34a', marginLeft: 4 }} title="bin-packing can free this node">
                            freeable
                          </span>
                        ) : n.pinned ? (
                          <span className="pill" style={{ background: '#fffbeb', color: '#d97706', marginLeft: 4 }} title="local-storage / ownerless pod pins this node">
                            pinned
                          </span>
                        ) : null}
                      </td>
                      <td
                        className="num"
                        style={{ padding: '0 12px', color: (n.savings || 0) > 0.5 ? '#16a34a' : '#cbd5e1', fontWeight: (n.savings || 0) > 0.5 ? 600 : 400 }}
                      >
                        {(n.savings || 0) > 0.5 ? usd(n.savings) : '$0'}
                      </td>
                      <td style={{ padding: '0 12px' }}>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                          {(n.reasonChips || []).map((r) => (
                            <ReasonPill key={r} reason={r} />
                          ))}
                        </div>
                      </td>
                      <td className="num" style={{ padding: '0 12px', color: '#64748b' }}>{n.pods}</td>
                      <td style={{ padding: '8px 12px', textAlign: 'center' }} onClick={(e) => e.stopPropagation()}>
                        <button
                          onClick={() => exploreAutomation(n)}
                          title="Show the workloads whose pods block this node"
                          style={{
                            fontSize: 12,
                            fontWeight: 600,
                            color: '#4f46e5',
                            border: '1px solid #c7d2fe',
                            background: 'transparent',
                            borderRadius: 8,
                            padding: '4px 12px',
                            cursor: 'pointer',
                            whiteSpace: 'nowrap',
                            fontFamily: 'inherit',
                          }}
                          onMouseEnter={(e) => (e.currentTarget.style.background = '#eef2ff')}
                          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                        >
                          Explore automation
                        </button>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={5} style={{ padding: '24px 20px', textAlign: 'center', color: '#94a3b8' }}>
                      {blockedNodes.length ? 'No blocked nodes match your filters.' : 'No blocked nodes.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <footer style={{ textAlign: 'center', fontSize: 12, color: '#94a3b8', paddingTop: 8, paddingBottom: 24 }}>
        CoolScaler · Smart Pod Placement · bin-packs un-evictable pods via <code>coolscaler.sh/node-packing</code> label + preferred node
        affinity (respects taints/affinities)
      </footer>

      {/* Unevictable Illustration modal */}
      <IllusModal
        open={illusOpen}
        onClose={() => setIllusOpen(false)}
        description="Compare your nodes with the optimized placement after bin-packing un-evictable pods. Pinned nodes (local-storage / ownerless pods) can't be emptied and stay put."
        beforeTitle={<>{blockedNodes.length} blocked nodes</>}
        afterTitle={
          <>
            {Math.max(0, blockedNodes.length - freed.length)} blocked · {t.optimizedNodes || 0} nodes · {t.freedNodes || 0} freed
          </>
        }
        before={
          blockedNodes.length ? (
            blockedNodes.map((n) => <IllusBox key={n.node} variant={n.freeable ? 'freeable' : 'blocked'} label={n.pods} title={n.node} />)
          ) : (
            <div style={{ fontSize: 11, color: '#94a3b8' }}>No blocked nodes 🎉</div>
          )
        }
        after={
          blockedNodes.length ? (
            blockedNodes.map((n) => (
              <IllusBox key={n.node} variant={n.freeable ? 'freed' : 'blocked'} label={n.freeable ? '—' : n.pods} title={n.node} />
            ))
          ) : (
            <div style={{ fontSize: 11, color: '#94a3b8' }}>Nothing to consolidate</div>
          )
        }
        savings={usd(t.savings || 0)}
        automateDisabled={RO || tot === 0}
        onAutomate={() => {
          setIllusOpen(false);
          void automateAll();
        }}
      />

      <NodeDrawer name={openNode} onClose={() => setOpenNode(null)} />
    </main>
  );
}
