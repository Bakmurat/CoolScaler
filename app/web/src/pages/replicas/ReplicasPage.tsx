// Replicas Optimization page
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Bar, BarChart, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { DataGrid, type GridColDef, type GridRowSelectionModel } from '@mui/x-data-grid';
import ClickAwayListener from '@mui/material/ClickAwayListener';
import { getJson, postJson } from '../../api/client';
import { useFeedback } from '../../providers/FeedbackProvider';
import { usePrompt } from '../../components/PromptModal';
import { useClusterData } from '../../providers/ClusterDataProvider';
import { usd, cpuFmt, memFmt } from '../../lib/format';
import { Dropdown, MenuItem, Toggle } from '../rightsizing/ui';
import { workloadOverviewId } from '../rightsizing/lib';
import '../rightsizing/rightsizing.css';
import AllocReqChart, { useAllocReqSeries } from './AllocReqChart';
import { ReplicasOverTimeChart, ResourceOverTimeChart } from './RoTimeCharts';
import { AutoDonut as SharedAutoDonut } from '../podPlacement/shared';

// The backend emits over-time graphs COLUMN-oriented ({ts:[],optimized:[],...});
// the chart components take row arrays — normalize either shape.
function colsToRows<T extends { ts: number }>(g: unknown): T[] {
  if (!g) return [];
  if (Array.isArray(g)) return g as T[];
  const obj = g as Record<string, (number | null)[]>;
  const ts = obj.ts;
  if (!Array.isArray(ts)) return [];
  const keys = Object.keys(obj).filter((k) => k !== 'ts');
  return ts.map((t, i) => {
    const row: Record<string, number | null> = { ts: t as number };
    for (const k of keys) row[k] = obj[k]?.[i] ?? null;
    return row as unknown as T;
  });
}
import DownscaleTab from './DownscaleTab';
import HpaPolicyDrawer, { type HpaDrawerMode } from './HpaPolicyDrawer';
import type { ReplicasResponse, RoPolicy, RoWorkload, RoReplicasPoint, RoResourcePoint } from './types';

/** key=value matcher against an (optional) metadata map. Workloads without
 *  the map at all pass — the live backend does not ship labels yet. */
function kvMatch(q: string, obj?: Record<string, string>): boolean {
  q = (q || '').trim();
  if (!q) return true;
  if (!obj) return true; // graceful fallback: metadata not provided by backend
  const i = q.indexOf('=');
  const k = i < 0 ? q : q.slice(0, i);
  const v = i < 0 ? null : q.slice(i + 1);
  return k in obj && (v == null || v === '' || obj[k] === v);
}

/** Optional table columns (Columns menu). */
const RO_COLS: [string, string][] = [
  ['savings', 'Savings Available'],
  ['replicas', 'Replicas'],
  ['min', 'Min Replicas'],
  ['threshold', 'CPU Threshold'],
  ['p99', 'P99 Latency'],
  ['trend', 'Replica Trend'],
  ['policy', 'Policy'],
  ['automated', 'Automated'],
];

function csvEscape(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

const chipStyle = (on: boolean): React.CSSProperties => ({
  fontSize: 12,
  fontWeight: 500,
  borderRadius: 999,
  padding: '4px 12px',
  border: on ? '1px solid #6366f1' : '1px solid #e3e5ee',
  background: on ? '#6366f1' : '#fff',
  color: on ? '#fff' : '#64748b',
  cursor: 'pointer',
  fontFamily: 'inherit',
});
const filtSelStyle: React.CSSProperties = {
  fontSize: 12,
  borderRadius: 999,
  padding: '4px 10px',
  border: '1px solid #e3e5ee',
  color: '#64748b',
  background: '#fff',
  cursor: 'pointer',
  fontFamily: 'inherit',
  outline: 'none',
  maxWidth: 150,
};
const th: React.CSSProperties = {
  textAlign: 'left',
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: '.04em',
  color: '#94a3b8',
  fontWeight: 600,
  padding: '10px 12px',
  borderBottom: '1px solid #eef0f6',
  whiteSpace: 'nowrap',
};
const td: React.CSSProperties = { padding: '12px', fontSize: 12, color: '#64748b' };

const avgArr = (a?: number[]) => (!a || !a.length ? 0 : Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 10) / 10);

function Arrow({ a, b }: { a?: number | null; b?: number | null }) {
  if (a == null || b == null) return <span style={{ color: '#cbd5e1' }}>—</span>;
  const color = b < a ? '#059669' : b > a ? '#f43f5e' : '#94a3b8';
  const ar = b < a ? '↓' : b > a ? '↑' : '→';
  return (
    <span className="num">
      <span style={{ color: '#94a3b8' }}>{a}</span> <span style={{ color, fontWeight: 700 }}>{ar}</span>{' '}
      <span style={{ color, fontWeight: 600 }}>{b}</span>
    </span>
  );
}

function Spark({ arr }: { arr?: number[] }) {
  if (!arr || !arr.length) return null;
  const mx = Math.max(...arr, 1);
  return (
    <span style={{ display: 'inline-flex', alignItems: 'flex-end', gap: 1, height: 16, verticalAlign: 'middle' }}>
      {arr.slice(-20).map((v, i) => (
        <span
          key={i}
          style={{ display: 'inline-block', width: 2, background: '#a5b4fc', height: Math.max(2, Math.round((v / mx) * 16)) }}
        />
      ))}
    </span>
  );
}


type RoTab = 'wl' | 'downscale' | 'agg';

export default function ReplicasPage() {
  const { toast, confirm } = useFeedback();
  const prompt = usePrompt();
  const { ro: RO } = useClusterData();
  const location = useLocation();
  const [data, setData] = useState<ReplicasResponse>({ workloads: [], totals: {} });
  const [policies, setPolicies] = useState<RoPolicy[]>([]);
  const [tab, setTab] = useState<RoTab>(location.pathname.includes('downscale') ? 'downscale' : 'wl');
  const [filter, setFilter] = useState('');
  const [filt, setFilt] = useState({
    automated: false,
    unautomated: false,
    savings: false,
    predictable: false,
    static: false,
    namespace: '',
    policy: '',
    label: '',
    anno: '',
    trigger: '',
    kind: '',
  });
  const [selected, setSelected] = useState<GridRowSelectionModel>([]);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [labelsOpen, setLabelsOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [colsOpen, setColsOpen] = useState(false);
  const [cols, setCols] = useState<Set<string>>(new Set(RO_COLS.map((c) => c[0])));
  const [kebab, setKebab] = useState<{ key: string; x: number; y: number } | null>(null);
  const [kpiWin, setKpiWin] = useState<'live' | '30d'>('live');
  const [range, setRange] = useState<'7d' | '30d'>('7d');
  const [addMetrics, setAddMetrics] = useState(false);
  const series = useAllocReqSeries(range);
  const [drawerMode, setDrawerMode] = useState<HpaDrawerMode | null>(null);
  const navigate = useNavigate();
  const { overview } = useClusterData();

  const load = useCallback(async () => {
    try {
      const [d, p] = await Promise.all([
        getJson<ReplicasResponse>('/api/replicas'),
        getJson<{ policies?: RoPolicy[] }>('/api/replicas-policies'),
      ]);
      setData(d);
      setPolicies(p.policies || []);
    } catch {
      /* keep last */
    }
  }, []);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => {
      if (!drawerMode) void load();
    }, 30000);
    return () => window.clearInterval(t);
  }, [load, drawerMode]);

  const t = data.totals || {};
  const workloads = useMemo(() => data.workloads || [], [data]);
  const nsList = useMemo(() => [...new Set(workloads.map((w) => w.namespace))].sort(), [workloads]);
  const auto = t.automated || 0;
  const tot = t.total || 0;

  const toggleFilt = (k: 'automated' | 'unautomated' | 'savings' | 'predictable' | 'static') =>
    setFilt((prev) => {
      const next = { ...prev, [k]: !prev[k] };
      if (k === 'automated' && next.automated) next.unautomated = false;
      if (k === 'unautomated' && next.unautomated) next.automated = false;
      if (k === 'predictable' && next.predictable) next.static = false;
      if (k === 'static' && next.static) next.predictable = false;
      return next;
    });

  const f = filter.toLowerCase();
  const rows = workloads.filter((w) => {
    if (f && !(w.name + w.namespace).toLowerCase().includes(f)) return false;
    if (filt.automated && !w.automated) return false;
    if (filt.unautomated && w.automated) return false;
    if (filt.savings && !((w.savings || 0) > 0.5)) return false;
    if (filt.predictable && !w.predictable) return false;
    if (filt.static && w.predictable) return false;
    if (filt.namespace && w.namespace !== filt.namespace) return false;
    if (filt.policy && w.policyName !== filt.policy) return false;
    if (filt.trigger && (w.triggerType || '') !== filt.trigger) return false;
    if (filt.kind && w.kind !== filt.kind) return false;
    if (!kvMatch(filt.label, w.labels)) return false;
    if (!kvMatch(filt.anno, w.annotations)) return false;
    return true;
  });

  const moreCnt =
    (filt.predictable ? 1 : 0) + (filt.static ? 1 : 0) + (filt.trigger ? 1 : 0) + (filt.kind ? 1 : 0) + (filt.anno.trim() ? 1 : 0);

  // Export — CSV of the visible (filtered) rows
  const exportCsv = () => {
    const head = ['workload', 'namespace', 'kind', 'trigger', 'savings_monthly', 'replicas', 'min_current', 'min_optimized', 'cpu_threshold_current', 'cpu_threshold_optimized', 'policy', 'automated'];
    const lines = [head.join(',')].concat(
      rows.map((w) =>
        [w.name, w.namespace, w.kind, w.triggerType || '', w.savings ?? 0, w.replicas ?? '', w.origMin ?? '', w.recMin ?? '', w.curThreshold ?? '', w.recThreshold ?? '', w.policyName || '', w.automated ? 'true' : 'false']
          .map(csvEscape)
          .join(','),
      ),
    );
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'replicas-workloads.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const rowRollout = async (w: RoWorkload) => {
    if (RO) {
      toast('Cluster is in READ-ONLY mode.');
      return;
    }
    if (!(await confirm(`Rollout-restart ${w.name}?`))) return;
    try {
      await postJson('/api/rollout', { namespace: w.namespace, kind: w.kind, name: w.name });
      toast('Rollout triggered on ' + w.name, 'ok');
    } catch {
      toast('Rollout failed');
    }
  };

  const pctDrop = (o?: number, c?: number) => (o && c != null && c < o ? '↓' + Math.round(((o - c) / o) * 100) + '%' : '');

  // replicas bar chart: top 12 filtered rows, current vs optimized min
  const roPts = useMemo(() => colsToRows<RoReplicasPoint>(data.replicasOverTime), [data.replicasOverTime]);
  const cpuPts = useMemo(() => colsToRows<RoResourcePoint>(data.cpuOverTime), [data.cpuOverTime]);
  const memPts = useMemo(() => colsToRows<RoResourcePoint>(data.memOverTime), [data.memOverTime]);

  const barData = rows.slice(0, 12).map((w) => ({
    name: w.name.length > 16 ? w.name.slice(0, 15) + '…' : w.name,
    cur: w.origMin ?? 0,
    opt: w.recMin ?? 0,
  }));

  const bulk = async (action: string, policy?: string) => {
    if (RO) {
      toast('Cluster is in READ-ONLY mode.');
      return;
    }
    const keys = selected.map(String);
    if (!keys.length) {
      toast('Select one or more workloads first.');
      return;
    }
    if (action === 'optimize' && !(await confirm(`Optimize minReplicas/threshold for ${keys.length} workload(s)?`))) return;
    const r = await postJson<{ count?: number; messages?: string[] }>('/api/replicas-bulk', { action, keys, policy }).catch(
      () => ({}) as { count?: number; messages?: string[] },
    );
    setActionsOpen(false);
    if (r.count != null)
      toast(`${action}: applied to ${r.count} workload(s).` + (r.messages?.length ? '\n\n' + r.messages.join('\n') : ''));
    void load();
  };

  const attach = async (key: string, policy: string) => {
    const [ns, kind, name] = key.split('/');
    await postJson('/api/replicas-attach-policy', { namespace: ns, kind, name, policy }).catch(() => {});
    void load();
  };

  const automate = async (key: string, enabled: boolean) => {
    if (RO) {
      toast('Cluster is in READ-ONLY mode. Set readOnly:false to automate replicas optimization.');
      void load();
      return;
    }
    await postJson('/api/replicas-automate', { key, enabled }).catch(() => {});
    setData((prev) => ({
      ...prev,
      workloads: (prev.workloads || []).map((w) => (w.key === key ? { ...w, automated: enabled } : w)),
    }));
  };

  const automateAll = async () => {
    if (RO) {
      toast('Cluster is in READ-ONLY mode. Set readOnly:false to automate replicas optimization.');
      return;
    }
    if (!(await confirm('Automate min-replicas optimization for all HPA/KEDA workloads (current + future)?'))) return;
    await postJson('/api/replicas-automate-all', { enabled: true }).catch(() => {});
    void load();
  };

  const enableThreshold = async () => {
    if (!workloads.length) {
      toast('No HPA/KEDA workloads to enable threshold optimization on.');
      return;
    }
    if (
      !(await confirm(
        'Enable latency-aware CPU Threshold Optimization (beta) for all HPA/KEDA workloads?\n\nEach workload moves to the -with-threshold-optimization variant of its current policy.',
      ))
    )
      return;
    const base = ['production', 'cost', 'high-availability', 'performance', 'predictive'];
    await Promise.all(
      workloads.map((w) => {
        let p = w.policyName || 'production';
        if (!p.endsWith('-with-threshold-optimization')) {
          const root = base.find((b) => p === b) || 'production';
          p = root + '-with-threshold-optimization';
        }
        const [ns, kind, name] = w.key.split('/');
        return postJson('/api/replicas-attach-policy', { namespace: ns, kind, name, policy: p }).catch(() => {});
      }),
    );
    void load();
  };

  const hpaPolDuplicate = async (src: string) => {
    const name = await prompt('Duplicate "' + src + '" as:', 'New policy name', src + '-copy');
    if (!name) return;
    const r = await postJson<{ ok?: boolean; message?: string }>('/api/hpa-policy/duplicate', { source: src, name }).catch(
      () => ({}) as { ok?: boolean; message?: string },
    );
    if (r?.ok) {
      toast('Duplicated to "' + name + '".');
      void load();
      setDrawerMode({ kind: 'edit', name });
    } else toast('Duplicate failed: ' + (r?.message || 'error'), 'error');
  };

  // The workload-overview drawer host lives on /rightSizing/workloads (same
  // pattern as Pod Placement / Overview deep links) — navigate there with the
  // selectedWorkloadOverviewId param so the drawer actually opens.
  const openDrawerFor = (w: RoWorkload) => {
    const cluster = overview?.clusterName || 'example-cluster';
    const sp = new URLSearchParams(location.search);
    sp.set('selectedWorkloadOverviewId', workloadOverviewId(cluster, { namespace: w.namespace, kind: w.kind, name: w.name }));
    navigate({ pathname: '/rightSizing/workloads', search: '?' + sp.toString() });
  };

  // Aggregation by namespace
  const agg = useMemo(() => {
    const m: Record<string, { cost: number; save: number; min: number; n: number; auto: number }> = {};
    workloads.forEach((w) => {
      const a = (m[w.namespace] = m[w.namespace] || { cost: 0, save: 0, min: 0, n: 0, auto: 0 });
      a.cost += w.monthlyCost || 0;
      a.save += w.savings || 0;
      a.min += w.recMin || 0;
      a.n++;
      if (w.automated) a.auto++;
    });
    return m;
  }, [workloads]);

  const gridCols: GridColDef<RoWorkload>[] = [
    {
      field: 'name',
      headerName: 'Workload',
      flex: 1.4,
      minWidth: 220,
      sortable: false,
      renderCell: (params) => {
        const w = params.row;
        return (
          <div style={{ cursor: 'pointer' }} onClick={() => openDrawerFor(w)}>
            <div style={{ fontWeight: 600, color: '#1e2536', fontSize: 12 }}>
              {w.name}{' '}
              {w.predictable ? (
                <span className="pill" style={{ background: '#eef2ff', color: '#4f46e5' }}>
                  predictable
                </span>
              ) : (
                <span className="pill" style={{ background: '#f1f5f9', color: '#94a3b8' }}>
                  static
                </span>
              )}
            </div>
            <div style={{ fontSize: 11, color: '#94a3b8' }}>
              {w.namespace} · {w.triggerType}
              {w.kedaName ? ' (' + w.kedaName + ')' : ''}
            </div>
          </div>
        );
      },
    },
    {
      field: 'savings',
      headerName: 'Savings /mo',
      width: 110,
      sortable: false,
      renderCell: (params) =>
        (params.row.savings || 0) > 0.5 ? (
          <span className="num" style={{ fontWeight: 600, color: '#059669' }}>
            {usd(params.row.savings)}
          </span>
        ) : (
          <span style={{ color: '#cbd5e1' }}>$0</span>
        ),
    },
    {
      field: 'replicas',
      headerName: 'Replicas',
      width: 90,
      sortable: false,
      renderCell: (params) => (
        <span className="num" style={{ color: '#475569' }}>
          {params.row.replicas} / {params.row.maxReplicas ?? '∞'}
        </span>
      ),
    },
    {
      field: 'min',
      headerName: 'Min Replicas',
      width: 110,
      sortable: false,
      renderCell: (params) => <Arrow a={params.row.origMin} b={params.row.recMin} />,
    },
    {
      field: 'threshold',
      headerName: 'CPU Threshold',
      width: 130,
      sortable: false,
      renderCell: (params) => {
        const w = params.row;
        return w.curThreshold != null ? (
          <span>
            <Arrow a={w.curThreshold} b={w.recThreshold} />%
          </span>
        ) : (
          <span style={{ color: '#cbd5e1' }}>— ({w.triggerType})</span>
        );
      },
    },
    {
      field: 'p99',
      headerName: 'P99 Latency (weekly)',
      width: 130,
      sortable: false,
      renderCell: () => (
        <span style={{ color: '#cbd5e1' }} title="No API observability — enable to collect latency">
          —
        </span>
      ),
    },
    {
      field: 'trend',
      headerName: 'Replica Trend',
      width: 120,
      sortable: false,
      renderCell: (params) => (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <Spark arr={params.row.trend} />
          <span style={{ fontSize: 10, color: '#94a3b8', marginTop: 2 }}>{avgArr(params.row.trend)} avg replicas</span>
        </div>
      ),
    },
    {
      field: 'policy',
      headerName: 'Policy',
      width: 160,
      sortable: false,
      renderCell: (params) => (
        <select
          disabled={RO}
          value={params.row.policyName || ''}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => void attach(params.row.key, e.target.value)}
          className="pill"
          style={{
            background: '#eef2ff',
            color: '#4f46e5',
            fontWeight: 600,
            border: 'none',
            outline: 'none',
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          {policies.map((p) => (
            <option key={p.name}>{p.name}</option>
          ))}
        </select>
      ),
    },
    {
      field: 'automated',
      headerName: 'Automated',
      width: 100,
      sortable: false,
      align: 'center',
      headerAlign: 'center',
      renderCell: (params) => (
        <Toggle
          checked={!!params.row.automated}
          disabled={RO}
          title={RO ? 'Read-only' : undefined}
          onChange={(on) => void automate(params.row.key, on)}
        />
      ),
    },
    {
      field: 'kebab',
      headerName: '',
      width: 44,
      sortable: false,
      align: 'center',
      renderCell: (params) => (
        <button
          title="Workload actions"
          onClick={(e) => {
            e.stopPropagation();
            const r = e.currentTarget.getBoundingClientRect();
            setKebab({ key: params.row.key, x: r.right, y: r.bottom + 4 });
          }}
          style={{
            height: 28,
            width: 28,
            borderRadius: 8,
            display: 'grid',
            placeItems: 'center',
            color: '#94a3b8',
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            fontSize: 16,
            fontFamily: 'inherit',
          }}
        >
          ⋮
        </button>
      ),
    },
  ];

  const colVisibility = useMemo(() => {
    const m: Record<string, boolean> = {};
    RO_COLS.forEach(([k]) => (m[k] = cols.has(k)));
    return m;
  }, [cols]);

  const kebabW = kebab ? workloads.find((w) => w.key === kebab.key) : null;

  return (
    <main style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* header */}
      <section>
        <h1 style={{ fontSize: 17, fontWeight: 700, color: '#1e2536', margin: 0 }}>Replicas Optimization</h1>
        <p style={{ fontSize: 12, color: '#64748b', margin: 0 }}>
          The horizontal dimension — optimize HPA/KEDA <b>minReplicas</b> and CPU thresholds from historical replica
          patterns, scaling ahead for predictable workloads. Triggers stay intact.
        </p>
      </section>

      {/* Threshold beta banner */}
      <section
        className="card"
        style={{
          padding: 16,
          border: '1px solid #ede9fe',
          background: 'linear-gradient(90deg,#f5f3ff,rgba(238,242,255,.4))',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <svg style={{ width: 24, height: 24, color: '#8b5cf6', flexShrink: 0 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
            <path d="M3 12a9 9 0 1 0 9-9" />
            <path d="M12 7v5l3 2" />
          </svg>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#1e2536' }}>
              Enable Threshold Optimization{' '}
              <span className="pill" style={{ background: '#ede9fe', color: '#7c3aed' }}>
                Beta
              </span>
            </div>
            <div style={{ fontSize: 12, color: '#64748b' }}>
              Optimize HPA CPU scaling thresholds from historical latency to better handle spikes{' '}
              <b>while ensuring application performance</b>.
            </div>
          </div>
        </div>
        <button
          disabled={RO}
          onClick={() => void enableThreshold()}
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: '#fff',
            background: '#8b5cf6',
            borderRadius: 8,
            padding: '8px 16px',
            border: 'none',
            cursor: RO ? 'not-allowed' : 'pointer',
            opacity: RO ? 0.5 : 1,
            fontFamily: 'inherit',
          }}
        >
          Enable Threshold Optimization
        </button>
      </section>

      {/* Live | 30 days boxed tabs — same tabline style as rightsizing */}
      <div style={{ display: 'inline-flex', gap: 2, width: 'max-content', marginBottom: -16 }}>
        <span className={'tabline' + (kpiWin === 'live' ? ' active' : '')} onClick={() => setKpiWin('live')}>
          Live
        </span>
        <span className={'tabline' + (kpiWin === '30d' ? ' active' : '')} onClick={() => setKpiWin('30d')}>
          30 days
        </span>
      </div>

      {/* KPI cards */}
      <section style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div className="card" style={{ padding: 16, display: 'grid', gridTemplateColumns: '1fr 1fr', borderTopLeftRadius: 0 }}>
          <div style={{ textAlign: 'center', padding: '0 8px', borderRight: '1px solid #eef0f6' }}>
            <div style={{ fontSize: 12, color: '#64748b' }}>
              Monthly cost <span style={{ color: '#cbd5e1' }}>({kpiWin === 'live' ? 'live' : '30 days'})</span>
            </div>
            <div className="num" style={{ marginTop: 4, fontSize: 30, lineHeight: 1, fontWeight: 700, color: '#4f46e5' }}>
              {usd(t.monthlyCost || 0)}
            </div>
            <div
              style={{
                marginTop: 12,
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: 8,
                fontSize: 11,
                borderTop: '1px solid #f1f2f7',
                paddingTop: 8,
                textAlign: 'left',
              }}
            >
              <div>
                <div style={{ color: '#94a3b8' }}>
                  CPU request <span style={{ color: '#059669', fontWeight: 600 }}>{pctDrop(t.origCpu, t.curCpu)}</span>
                </div>
                <div className="num" style={{ marginTop: 2 }}>
                  <span style={{ color: '#64748b' }}>{cpuFmt(t.origCpu)}</span> <span style={{ color: '#cbd5e1' }}>→</span>{' '}
                  <span style={{ color: '#059669', fontWeight: 600 }}>{cpuFmt(t.curCpu)}</span>
                </div>
              </div>
              <div>
                <div style={{ color: '#94a3b8' }}>
                  Memory request <span style={{ color: '#059669', fontWeight: 600 }}>{pctDrop(t.origMem, t.curMem)}</span>
                </div>
                <div className="num" style={{ marginTop: 2 }}>
                  <span style={{ color: '#64748b' }}>{memFmt(t.origMem)}</span> <span style={{ color: '#cbd5e1' }}>→</span>{' '}
                  <span style={{ color: '#059669', fontWeight: 600 }}>{memFmt(t.curMem)}</span>
                </div>
              </div>
            </div>
          </div>
          <div style={{ textAlign: 'center', padding: '0 8px' }}>
            <div style={{ fontSize: 12, color: '#64748b' }}>Wasted spend</div>
            <div className="num" style={{ marginTop: 8, fontSize: 30, lineHeight: 1, fontWeight: 700, color: '#f43f5e' }}>
              {Math.round(t.wastedPct || 0)}%
            </div>
          </div>
        </div>
        <div className="card" style={{ padding: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13 }}>
              <span style={{ color: '#64748b' }}>Unoptimized min replicas</span>
              <span className="num" style={{ fontWeight: 700, color: '#f43f5e' }}>{t.unoptimizedMinReplicas ?? '—'}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, borderTop: '1px solid #f1f2f7', paddingTop: 8 }}>
              <span style={{ color: '#64748b' }}>Unoptimized CPU thresholds</span>
              <span className="num" style={{ fontWeight: 700, color: '#f43f5e' }}>{t.unoptimizedThresholds ?? '—'}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, borderTop: '1px solid #f1f2f7', paddingTop: 8 }}>
              <span style={{ color: '#64748b' }}>Predictable workloads</span>
              <span className="num" style={{ fontWeight: 700, color: '#1e2536' }}>{t.predictable ?? '—'}</span>
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
            <SharedAutoDonut auto={auto} total={tot} legendRows itemLabel="replicas workloads" />
            <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 4 }}>
              {auto} / {tot} workloads
            </div>
            <button
              disabled={RO || tot === 0}
              onClick={() => void automateAll()}
              style={{
                marginTop: 6,
                fontSize: 11,
                fontWeight: 600,
                color: '#fff',
                background: '#22c55e',
                borderRadius: 8,
                padding: '4px 12px',
                border: 'none',
                cursor: RO || tot === 0 ? 'not-allowed' : 'pointer',
                opacity: RO || tot === 0 ? 0.5 : 1,
                fontFamily: 'inherit',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <svg style={{ width: 12, height: 12 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path d="M5 3l14 9-14 9z" />
              </svg>
              Automate All
            </button>
          </div>
        </div>
      </section>

      {/* Resource graphs */}
      <section className="card" style={{ padding: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#1e2536' }}>
            Resource graphs <span style={{ fontSize: 11, fontWeight: 400, color: '#94a3b8' }}>(HPA/KEDA workloads over time)</span>
          </div>
          <div style={{ display: 'inline-flex', alignItems: 'center', background: '#f1f2f7', borderRadius: 8, padding: 2 }}>
            {(['7d', '30d'] as const).map((r) => (
              <span key={r} className={'seg' + (range === r ? ' active' : '')} onClick={() => setRange(r)}>
                {r === '7d' ? '7 Days' : '30 Days'}
              </span>
            ))}
          </div>
        </div>
        <label
          style={{ fontSize: 11, color: '#475569', display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', userSelect: 'none', marginBottom: 8 }}
          title="Show the Total request and Allocatable series"
        >
          <input type="checkbox" checked={addMetrics} onChange={(e) => setAddMetrics(e.target.checked)} />
          Additional metrics
        </label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 16 }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#64748b', marginBottom: 4, textAlign: 'center' }}>
              Replicas over time
              {!roPts.length && <span style={{ fontSize: 10, color: '#94a3b8' }}> (current vs optimized min)</span>}
            </div>
            {roPts.length ? (
              <ReplicasOverTimeChart points={roPts} range={range} />
            ) : (
              <div style={{ height: 160 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={barData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                    <XAxis dataKey="name" tick={{ fontSize: 9, fill: '#aab' }} angle={-40} textAnchor="end" height={36} tickLine={false} axisLine={false} interval={0} />
                    <YAxis tick={{ fontSize: 9, fill: '#aab' }} allowDecimals={false} tickLine={false} axisLine={false} width={24} />
                    <Tooltip contentStyle={{ borderRadius: 8, border: '1px solid #e9eaf0', fontSize: 11 }} />
                    <Legend verticalAlign="bottom" wrapperStyle={{ fontSize: 10, paddingTop: 2 }} iconSize={10} />
                    <Bar dataKey="cur" name="Current minReplicas" fill="#c7d2fe" isAnimationActive={false} />
                    <Bar dataKey="opt" name="Optimized minReplicas" fill="#22c55e" isAnimationActive={false} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#64748b', marginBottom: 4, textAlign: 'center' }}>
              CPU over time
              {!cpuPts.length && <span style={{ fontSize: 10, color: '#94a3b8' }}> (allocatable vs requested)</span>}
            </div>
            {cpuPts.length ? (
              <ResourceOverTimeChart points={cpuPts} resource="cpu" range={range} additionalMetrics={addMetrics} />
            ) : (
              <AllocReqChart values={series} resource="cpu" />
            )}
          </div>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#64748b', marginBottom: 4, textAlign: 'center' }}>
              Memory over time
              {!memPts.length && <span style={{ fontSize: 10, color: '#94a3b8' }}> (allocatable vs requested)</span>}
            </div>
            {memPts.length ? (
              <ResourceOverTimeChart points={memPts} resource="memory" range={range} additionalMetrics={addMetrics} />
            ) : (
              <AllocReqChart values={series} resource="memory" />
            )}
          </div>
        </div>
        <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 8, textAlign: 'center' }}>
          Latency / RPS / scaling-events series require L7 API observability (eBPF network monitor) — not available on
          this cluster, so they are not shown rather than fabricated.
        </div>
      </section>

      {/* Workloads | Downscale | Aggregation */}
      <section className="card" style={{ padding: 0, overflow: 'visible' }}>
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
                ['downscale', 'Downscale'],
                ['agg', 'Aggregation'],
              ] as [RoTab, string][]
            ).map(([id, lbl]) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                style={{
                  padding: '6px 12px',
                  fontSize: 13,
                  fontWeight: 600,
                  border: 'none',
                  background: 'none',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  borderBottom: tab === id ? '2px solid #6366f1' : '2px solid transparent',
                  color: tab === id ? '#4f46e5' : '#94a3b8',
                }}
              >
                {lbl}
              </button>
            ))}
          </div>
          {tab === 'wl' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Search…"
                style={{
                  background: '#f4f5f8',
                  border: '1px solid #e9eaf0',
                  borderRadius: 8,
                  padding: '6px 12px',
                  fontSize: 14,
                  width: 160,
                  outline: 'none',
                  fontFamily: 'inherit',
                }}
              />
              <button style={chipStyle(filt.automated)} onClick={() => toggleFilt('automated')}>
                automated
              </button>
              <button style={chipStyle(filt.unautomated)} onClick={() => toggleFilt('unautomated')}>
                unautomated
              </button>
              <button style={chipStyle(filt.savings)} onClick={() => toggleFilt('savings')}>
                savings
              </button>
              <select value={filt.namespace} onChange={(e) => setFilt({ ...filt, namespace: e.target.value })} style={filtSelStyle}>
                <option value="">namespaces</option>
                {nsList.map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </select>
              <select value={filt.policy} onChange={(e) => setFilt({ ...filt, policy: e.target.value })} style={filtSelStyle}>
                <option value="">policies</option>
                {policies.map((p) => (
                  <option key={p.name}>{p.name}</option>
                ))}
              </select>
              {/* labels chip */}
              <div style={{ position: 'relative' }}>
                <button style={chipStyle(!!filt.label.trim())} onClick={() => setLabelsOpen((v) => !v)}>
                  {filt.label.trim() ? 'labels: ' + filt.label.trim() : 'labels'} ▾
                </button>
                <Dropdown open={labelsOpen} onClose={() => setLabelsOpen(false)} style={{ left: 0, width: 220, padding: 10 }}>
                  <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>
                    labels <span style={{ color: '#cbd5e1' }}>key=value</span>
                  </div>
                  <input
                    className="chip"
                    style={{ width: '100%', cursor: 'text' }}
                    placeholder="app=web"
                    value={filt.label}
                    onChange={(e) => setFilt({ ...filt, label: e.target.value })}
                  />
                </Dropdown>
              </div>
              {/* + More filters */}
              <div style={{ position: 'relative' }}>
                <button style={chipStyle(false)} onClick={() => setMoreOpen((v) => !v)}>
                  + More filters{' '}
                  {moreCnt > 0 && (
                    <span style={{ marginLeft: 2, padding: '0 4px', borderRadius: 999, background: '#e0e7ff', color: '#4f46e5', fontSize: 10 }}>
                      {moreCnt}
                    </span>
                  )}{' '}
                  ▾
                </button>
                <Dropdown open={moreOpen} onClose={() => setMoreOpen(false)} style={{ left: 0, width: 380, padding: 12 }}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    <span className={'chip' + (filt.predictable ? ' on' : '')} onClick={() => toggleFilt('predictable')}>
                      predictable
                    </span>
                    <span className={'chip' + (filt.static ? ' on' : '')} onClick={() => toggleFilt('static')}>
                      static
                    </span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 10 }}>
                    <label style={{ fontSize: 11, color: '#64748b', display: 'block' }}>
                      trigger type
                      <select
                        className="chip"
                        style={{ width: '100%', marginTop: 2 }}
                        value={filt.trigger}
                        onChange={(e) => setFilt({ ...filt, trigger: e.target.value })}
                      >
                        <option value="">any</option>
                        {[...new Set(workloads.map((w) => w.triggerType).filter(Boolean) as string[])].sort().map((n) => (
                          <option key={n}>{n}</option>
                        ))}
                      </select>
                    </label>
                    <label style={{ fontSize: 11, color: '#64748b', display: 'block' }}>
                      type
                      <select
                        className="chip"
                        style={{ width: '100%', marginTop: 2 }}
                        value={filt.kind}
                        onChange={(e) => setFilt({ ...filt, kind: e.target.value })}
                      >
                        <option value="">any</option>
                        {[...new Set(workloads.map((w) => w.kind))].sort().map((n) => (
                          <option key={n}>{n}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div style={{ marginTop: 10 }}>
                    <label style={{ fontSize: 11, color: '#64748b', display: 'block' }}>
                      annotations <span style={{ color: '#cbd5e1' }}>key=value</span>
                      <input
                        className="chip"
                        style={{ width: '100%', marginTop: 2, cursor: 'text' }}
                        placeholder="team=payments"
                        value={filt.anno}
                        onChange={(e) => setFilt({ ...filt, anno: e.target.value })}
                      />
                    </label>
                  </div>
                </Dropdown>
              </div>
              {/* Columns */}
              <div style={{ position: 'relative' }}>
                <button
                  onClick={() => setColsOpen((v) => !v)}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 13,
                    fontWeight: 600,
                    color: '#3d4254',
                    background: '#fff',
                    border: '1px solid #e3e5ee',
                    borderRadius: 8,
                    padding: '6px 12px',
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  <svg style={{ width: 15, height: 15 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
                    <path d="M1.5 12S5.5 5 12 5s10.5 7 10.5 7-4 7-10.5 7S1.5 12 1.5 12z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                  Columns
                </button>
                <Dropdown open={colsOpen} onClose={() => setColsOpen(false)} style={{ right: 0, width: 208, padding: 6 }}>
                  {RO_COLS.map(([k, l]) => (
                    <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderRadius: 8, cursor: 'pointer', fontSize: 13 }}>
                      <input
                        type="checkbox"
                        checked={cols.has(k)}
                        onChange={(e) => {
                          setCols((prev) => {
                            const n = new Set(prev);
                            if (e.target.checked) n.add(k);
                            else n.delete(k);
                            return n;
                          });
                        }}
                      />
                      {l}
                    </label>
                  ))}
                </Dropdown>
              </div>
              <div style={{ position: 'relative' }}>
                <button
                  onClick={() => setActionsOpen((v) => !v)}
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: '#fff',
                    background: '#6366f1',
                    borderRadius: 8,
                    padding: '6px 12px',
                    border: 'none',
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  Replicas Actions
                </button>
                <Dropdown open={actionsOpen} onClose={() => setActionsOpen(false)} style={{ right: 0, width: 210, padding: '4px 0' }}>
                  <div style={{ padding: '4px 12px', fontSize: 10, textTransform: 'uppercase', letterSpacing: '.05em', color: '#94a3b8', fontWeight: 700 }}>
                    {selected.length} selected
                  </div>
                  {(
                    [
                      ['automate', 'Automate'],
                      ['unautomate', 'Un-automate'],
                      ['optimize', 'Optimize now'],
                      ['restore', 'Restore auto-detected policy'],
                    ] as [string, string][]
                  ).map(([a, l]) => (
                    <button
                      key={a}
                      onClick={() => void bulk(a)}
                      style={{
                        display: 'block',
                        width: '100%',
                        textAlign: 'left',
                        padding: '6px 12px',
                        fontSize: 13,
                        border: 'none',
                        background: 'none',
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                        color: '#334155',
                      }}
                    >
                      {l}
                    </button>
                  ))}
                  <div style={{ borderTop: '1px solid #f1f2f7', margin: '4px 0' }} />
                  <div style={{ padding: '4px 12px', fontSize: 10, textTransform: 'uppercase', letterSpacing: '.05em', color: '#94a3b8', fontWeight: 700 }}>
                    Attach policy
                  </div>
                  <select
                    defaultValue=""
                    onChange={(e) => {
                      if (e.target.value) void bulk('attach', e.target.value);
                    }}
                    style={{ margin: '0 12px 4px', fontSize: 12, border: '1px solid #e9eaf0', borderRadius: 4, padding: '4px 8px', width: 'calc(100% - 24px)' }}
                  >
                    <option value="">choose…</option>
                    {policies.map((p) => (
                      <option key={p.name}>{p.name}</option>
                    ))}
                  </select>
                </Dropdown>
              </div>
            </div>
          )}
        </div>

        {tab === 'wl' && (
          <div>
            <DataGrid
              rows={rows}
              columns={gridCols}
              getRowId={(r) => r.key}
              columnVisibilityModel={colVisibility}
              checkboxSelection
              rowSelectionModel={selected}
              onRowSelectionModelChange={(m) => setSelected(m)}
              getRowHeight={() => 'auto'}
              autoHeight
              hideFooter
              disableColumnMenu
              disableRowSelectionOnClick
              localeText={{ noRowsLabel: 'No HPA or KEDA workloads found in this cluster.' }}
              sx={{
                border: 'none',
                fontFamily: 'inherit',
                fontSize: 12,
                '& .MuiDataGrid-columnHeaders': {
                  background: 'transparent',
                  borderBottom: '1px solid #eef0f6',
                  color: '#94a3b8',
                  textTransform: 'uppercase',
                  letterSpacing: '.04em',
                  fontSize: 11,
                  minHeight: '38px !important',
                  maxHeight: '38px !important',
                },
                '& .MuiDataGrid-columnHeaderTitle': { fontWeight: 600 },
                '& .MuiDataGrid-columnSeparator': { display: 'none' },
                '& .MuiDataGrid-row': {
                  borderBottom: '1px solid #f1f2f7',
                  '&:hover': { background: 'rgba(248,250,252,.5)' },
                },
                '& .MuiDataGrid-cell': { border: 'none', display: 'flex', alignItems: 'center', padding: '10px 12px' },
                '& .MuiDataGrid-cell:focus, & .MuiDataGrid-columnHeader:focus': { outline: 'none' },
                '& .MuiDataGrid-cell:focus-within': { outline: 'none' },
              }}
            />
            {/* Export — CSV of visible rows */}
            <div style={{ padding: '10px 16px', borderTop: '1px solid #eef0f5' }}>
              <button
                onClick={exportCsv}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 12,
                  fontWeight: 600,
                  color: '#475569',
                  background: '#fff',
                  border: '1px solid #e3e5ee',
                  borderRadius: 999,
                  padding: '4px 12px',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                Export
                <svg style={{ width: 13, height: 13 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path d="M12 3v12M7 10l5 5 5-5M4 21h16" />
                </svg>
              </button>
            </div>
          </div>
        )}

        {tab === 'agg' && (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ ...th, paddingLeft: 20 }}>Namespace</th>
                  <th style={th}>
                    Total Cost <span style={{ color: '#cbd5e1' }}>/mo</span>
                  </th>
                  <th style={th}>
                    Savings <span style={{ color: '#cbd5e1' }}>/mo</span>
                  </th>
                  <th style={th}>Min Replicas (sum)</th>
                  <th style={th}>Automation %</th>
                </tr>
              </thead>
              <tbody>
                {Object.keys(agg).length === 0 && (
                  <tr>
                    <td colSpan={5} style={{ ...td, textAlign: 'center', padding: 24, color: '#94a3b8' }}>
                      No HPA/KEDA workloads.
                    </td>
                  </tr>
                )}
                {Object.keys(agg)
                  .sort((x, y) => agg[y].save - agg[x].save)
                  .map((ns) => {
                    const a = agg[ns];
                    const pct = a.n ? Math.round((a.auto / a.n) * 100) : 0;
                    return (
                      <tr key={ns} style={{ borderBottom: '1px solid #f1f2f7' }}>
                        <td style={{ ...td, paddingLeft: 20, fontWeight: 500 }}>namespace:{ns}</td>
                        <td style={td} className="num">{usd(a.cost)}</td>
                        <td style={td} className="num">
                          {a.save > 0.5 ? <span style={{ color: '#059669', fontWeight: 600 }}>{usd(a.save)}</span> : <span style={{ color: '#cbd5e1' }}>$0</span>}
                        </td>
                        <td style={td} className="num">{a.min}</td>
                        <td style={td}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <div style={{ width: 64, height: 6, borderRadius: 4, background: '#f1f5f9', overflow: 'hidden' }}>
                              <div style={{ height: '100%', width: pct + '%', background: '#34d399' }} />
                            </div>
                            <span style={{ fontSize: 11, color: '#64748b' }}>
                              {a.auto} of {a.n}
                            </span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {tab === 'downscale' && <DownscaleTab />}

      {/* Replicas Policies Management */}
      <section className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div
          style={{
            padding: '12px 20px',
            borderBottom: '1px solid #eef0f6',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 700, color: '#1e2536' }}>Replicas Policies Management</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              onClick={() => setDrawerMode({ kind: 'newSchedule', policyNames: policies.filter((p) => !p.schedule).map((p) => p.name) })}
              style={{
                fontSize: 13,
                fontWeight: 600,
                borderRadius: 8,
                padding: '6px 12px',
                border: '1px solid #e2e8f0',
                color: '#475569',
                background: '#fff',
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              New schedule policy
            </button>
            <button
              onClick={() => setDrawerMode({ kind: 'new' })}
              style={{
                fontSize: 13,
                fontWeight: 600,
                borderRadius: 8,
                padding: '6px 12px',
                border: '1px solid #c7d2fe',
                color: '#4f46e5',
                background: '#fff',
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              Create new policy
            </button>
          </div>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ ...th, paddingLeft: 20 }}>Policy</th>
                <th style={th}>Used by</th>
                <th style={th}>Min-replicas strategy</th>
                <th style={th}>Predict</th>
                <th style={th}>Static / Predictable %ile</th>
                <th style={th}>Threshold</th>
                <th style={{ ...th, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {policies.map((p) => {
                const pct = p.total ? Math.round((p.usedBy / p.total) * 100) : 0;
                return (
                  <tr
                    key={p.name}
                    onClick={() => setDrawerMode({ kind: 'edit', name: p.name })}
                    style={{ borderBottom: '1px solid #f1f2f7', cursor: 'pointer' }}
                  >
                    <td style={{ ...td, paddingLeft: 20 }}>
                      <div style={{ fontWeight: 600, color: '#1e2536', display: 'flex', alignItems: 'center', gap: 6 }}>
                        {p.name}
                        {p.builtin ? (
                          <span className="pill" style={{ background: '#f1f5f9', color: '#94a3b8' }}>
                            built-in
                          </span>
                        ) : p.schedule ? (
                          <span className="pill" style={{ background: '#f5f3ff', color: '#7c3aed' }}>
                            schedule
                          </span>
                        ) : (
                          <span className="pill" style={{ background: '#ecfdf5', color: '#059669' }}>
                            custom
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: 11, color: '#94a3b8', maxWidth: 320 }}>{p.description || ''}</div>
                    </td>
                    <td style={td}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ width: 64, height: 6, borderRadius: 4, background: '#f1f5f9', overflow: 'hidden' }}>
                          <div style={{ height: '100%', width: pct + '%', background: '#34d399' }} />
                        </div>
                        <span style={{ fontSize: 11, color: '#64748b' }}>
                          {p.usedBy} of {p.total}
                        </span>
                      </div>
                    </td>
                    <td style={td}>{p.minStrategy}</td>
                    <td style={td}>
                      {p.prediction ? (
                        <span className="pill" style={{ background: '#eef2ff', color: '#4f46e5' }}>
                          {p.lookAhead}
                        </span>
                      ) : (
                        <span style={{ color: '#cbd5e1' }}>off</span>
                      )}
                    </td>
                    <td style={td} className="num">
                      p{p.staticPct} / p{p.predictablePct}
                    </td>
                    <td style={td}>
                      {p.threshold ? (
                        <span className="pill" style={{ background: '#f5f3ff', color: '#7c3aed' }}>
                          ±{p.maxBoundary}%
                        </span>
                      ) : (
                        <span style={{ color: '#cbd5e1' }}>off</span>
                      )}
                    </td>
                    <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setDrawerMode({ kind: 'edit', name: p.name });
                        }}
                        style={{
                          fontSize: 12,
                          fontWeight: 600,
                          color: p.builtin ? '#64748b' : '#6366f1',
                          border: 'none',
                          background: 'none',
                          cursor: 'pointer',
                          fontFamily: 'inherit',
                        }}
                      >
                        {p.builtin ? 'View' : 'Edit'}
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          void hpaPolDuplicate(p.name);
                        }}
                        style={{
                          fontSize: 12,
                          fontWeight: 600,
                          color: p.builtin ? '#6366f1' : '#64748b',
                          border: 'none',
                          background: 'none',
                          cursor: 'pointer',
                          fontFamily: 'inherit',
                          marginLeft: 12,
                        }}
                      >
                        Duplicate
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <footer style={{ textAlign: 'center', fontSize: 12, color: '#94a3b8', paddingTop: 8, paddingBottom: 24 }}>
        CoolScaler · Replicas Optimization · manages HPA <code>.spec.minReplicas</code> + CPU threshold (KEDA{' '}
        <code>minReplicaCount</code>) · keeps scale triggers intact
      </footer>

      {/* per-row kebab menu — fixed-position, like the rightsizing table */}
      {kebab && kebabW && (
        <ClickAwayListener onClickAway={() => setKebab(null)}>
          <div
            style={{
              position: 'fixed',
              top: Math.min(window.innerHeight - 120, kebab.y),
              left: Math.max(8, kebab.x - 240),
              width: 240,
              background: '#fff',
              borderRadius: 12,
              boxShadow: '0 20px 25px -5px rgba(0,0,0,.1),0 8px 10px -6px rgba(0,0,0,.1)',
              border: '1px solid #e9eaf0',
              padding: '6px 0',
              zIndex: 90,
              fontSize: 13,
            }}
          >
            <MenuItem
              label="Explore workload"
              onClick={() => {
                setKebab(null);
                openDrawerFor(kebabW);
              }}
            />
            <MenuItem
              label="Rollout workload"
              enabled={!RO}
              title={RO ? 'Read-only mode' : ''}
              onClick={() => {
                setKebab(null);
                void rowRollout(kebabW);
              }}
            />
          </div>
        </ClickAwayListener>
      )}

      <HpaPolicyDrawer
        mode={drawerMode}
        onClose={() => setDrawerMode(null)}
        onSaved={() => void load()}
        onReopen={(name) => setDrawerMode({ kind: 'edit', name })}
      />
    </main>
  );
}
