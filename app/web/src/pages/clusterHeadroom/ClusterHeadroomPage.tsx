// Cluster Headroom (v2)
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { getJson, postJson } from '../../api/client';
import { memFmt } from '../../lib/format';
import { useFeedback } from '../../providers/FeedbackProvider';
import { Dropdown } from '../rightsizing/ui';
import type { NodesResponse } from '../nodeManagement/types';
import HeadroomDrawer, { type HeadroomDrawerMode } from './HeadroomDrawer';
import type {
  HeadroomConfig,
  HeadroomGraphPoint,
  HeadroomGraphResponse,
  HeadroomOverview,
} from './types';

const coresAxis = (v: number) => (v >= 1 ? (+v).toFixed(1) : Math.round(v * 1000) + 'm');
const bytesAxis = (v: number) => {
  const g = v / 2 ** 30;
  return g >= 1 ? g.toFixed(0) + 'Gi' : Math.round(v / 2 ** 20) + 'Mi';
};
const plainAxis = (v: number) => String(v);

const thStyle: CSSProperties = {
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

function Seg({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <span className={'seg' + (on ? ' active' : '')} onClick={onClick}>
      {children}
    </span>
  );
}

const HEAD_LEGEND: [string, string][] = [
  ['#9aa3c0', 'Usage'],
  ['#f59e0b', 'Total request'],
  ['#6366f1', 'Headroom'],
  ['#f6a45c', 'Allocatable'],
];

function HeadLegend() {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', columnGap: 14, rowGap: 4, fontSize: 11, color: '#64748b', marginBottom: 8 }}>
      {HEAD_LEGEND.map(([c, t]) => (
        <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ height: 8, width: 12, borderRadius: 2, background: c, display: 'inline-block' }} />
          {t}
        </span>
      ))}
    </div>
  );
}

const tooltipProps = {
  labelStyle: { fontSize: 11 },
  itemStyle: { fontSize: 11, padding: 0 },
  contentStyle: { borderRadius: 8, border: '1px solid #e9eaf0', fontSize: 11 },
} as const;

const NAMES: Record<string, string> = {
  usage: 'Usage',
  request: 'Total request',
  headroom: 'Headroom',
  allocatable: 'Allocatable',
};

/** One resource chart (CPU / Memory / GPU) — usage/request lines, headroom band. */
function HeadroomChart({
  title,
  points,
  fmt,
  range,
}: {
  title: string;
  points: HeadroomGraphPoint[];
  fmt: (v: number) => string;
  range: '7d' | '30d';
}) {
  const labelFmt = (ts: number) => {
    const d = new Date(ts * 1000);
    return range === '30d'
      ? d.toLocaleDateString([], { month: 'short', day: 'numeric' })
      : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit' });
  };
  const data = (points || []).map((p) => ({
    label: labelFmt(p.ts),
    usage: p.usage,
    request: p.request,
    headroom: p.headroom,
    allocatable: p.allocatable,
  }));
  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 700, color: '#1e2536', marginBottom: 4 }}>{title}</div>
      <div style={{ height: 200 }}>
        {data.length ? (
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="#f0f1f6" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 9, fill: '#aab' }} tickLine={false} axisLine={false} minTickGap={60} />
              <YAxis tick={{ fontSize: 9, fill: '#aab' }} tickFormatter={fmt} tickLine={false} axisLine={false} width={44} />
              <Tooltip
                {...tooltipProps}
                formatter={(v: unknown, name: unknown) =>
                  [typeof v === 'number' ? fmt(v) : '—', NAMES[String(name)] || String(name)] as [string, string]
                }
              />
              <Area type="monotone" dataKey="headroom" stroke="#6366f1" strokeWidth={1.4} fill="rgba(99,102,241,.12)" dot={false} isAnimationActive={false} />
              <Area type="monotone" dataKey="usage" stroke="#9aa3c0" strokeWidth={1.6} fill="rgba(154,163,192,.16)" dot={false} isAnimationActive={false} />
              <Line type="monotone" dataKey="request" stroke="#f59e0b" strokeWidth={1.6} dot={false} isAnimationActive={false} />
              <Line type="monotone" dataKey="allocatable" stroke="#f6a45c" strokeWidth={1.6} dot={false} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        ) : (
          <div style={{ height: '100%', display: 'grid', placeItems: 'center', fontSize: 12, color: '#cbd5e1' }}>
            No history yet
          </div>
        )}
      </div>
    </div>
  );
}

/** KPI cell — big number + unit, dividers between cells (no outer borders). */
function Kpi({ label, value, sub }: { label: string; value: ReactNode; sub?: string }) {
  return (
    <div style={{ padding: 24, textAlign: 'center' }}>
      <div style={{ fontSize: 13, fontWeight: 500, color: '#64748b' }}>{label}</div>
      <div className="num" style={{ marginTop: 6, fontSize: 34, lineHeight: 1, fontWeight: 800, letterSpacing: '-.02em', color: '#1e2536' }}>
        {value}
        {sub && <span style={{ fontSize: 16, fontWeight: 600, color: '#94a3b8', marginLeft: 4 }}>{sub}</span>}
      </div>
    </div>
  );
}

const ALL_COLS: [string, string][] = [
  ['cpu', 'CPU'],
  ['memory', 'Memory'],
  ['gpu', 'GPU'],
  ['lifecycle', 'Lifecycle'],
  ['nodePools', 'Node Pools'],
  ['schedule', 'Schedule'],
];

const resLabel = (r: { type: string; value: number }) =>
  !r || !r.value ? '—' : r.type === 'dynamic' ? r.value + '%' : String(r.value);

const lifecycleLabel = (l: string) => (l === 'spot' ? 'Spot' : l === 'onDemand' ? 'On-demand' : 'Both');

const scheduleLabel = (c: HeadroomConfig) =>
  !c.schedule || c.schedule.length === 0 ? 'Always' : c.schedule.length + ' period' + (c.schedule.length > 1 ? 's' : '');

export default function ClusterHeadroomPage() {
  const { toast, confirm } = useFeedback();
  const [overview, setOverview] = useState<HeadroomOverview | null>(null);
  const [graph, setGraph] = useState<HeadroomGraphResponse | null>(null);
  const [configs, setConfigs] = useState<HeadroomConfig[]>([]);
  const [range, setRange] = useState<'7d' | '30d'>('7d');
  const [q, setQ] = useState('');
  const [colsOpen, setColsOpen] = useState(false);
  const [cols, setCols] = useState<Set<string>>(new Set(ALL_COLS.map(([k]) => k)));
  const [drawer, setDrawer] = useState<HeadroomDrawerMode | null>(null);
  const [poolOptions, setPoolOptions] = useState<string[]>([]);
  const [tick, setTick] = useState(0);

  const reload = () => setTick((n) => n + 1);

  useEffect(() => {
    let dead = false;
    getJson<HeadroomOverview>('/api/headroom/overview').then((d) => !dead && setOverview(d)).catch(() => {});
    getJson<{ configurations: HeadroomConfig[] }>('/api/headroom/configurations')
      .then((d) => !dead && setConfigs(d.configurations || []))
      .catch(() => {});
    getJson<NodesResponse>('/api/nodes')
      .then((d) => {
        if (dead) return;
        const set = new Set<string>();
        (d.nodes || []).forEach((n) => {
          if (n.instanceType) set.add(n.instanceType);
          else if (n.nodeGroup) set.add(n.nodeGroup);
        });
        setPoolOptions(Array.from(set).sort());
      })
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [tick]);

  useEffect(() => {
    let dead = false;
    getJson<HeadroomGraphResponse>('/api/headroom/graph?range=' + range)
      .then((d) => !dead && setGraph(d))
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [range, tick]);

  const rows = useMemo(
    () => configs.filter((c) => !q.trim() || c.name.toLowerCase().includes(q.trim().toLowerCase())),
    [configs, q],
  );

  const persist = async (next: HeadroomConfig[]): Promise<boolean> => {
    const r = await postJson<{ ok?: boolean; error?: string }>('/api/headroom/configurations', {
      configurations: next,
    }).catch(() => ({}) as { ok?: boolean; error?: string });
    if (r?.ok) {
      toast('Headroom configurations saved.');
      setConfigs(next);
      reload();
      return true;
    }
    toast('Save failed: ' + (r?.error || 'error'), 'error');
    return false;
  };

  const del = async (idx: number) => {
    const c = configs[idx];
    if (!(await confirm('Delete headroom configuration "' + c.name + '"?'))) return;
    await persist(configs.filter((_, i) => i !== idx));
  };

  const dataCol = (k: string): CSSProperties => (cols.has(k) ? {} : { display: 'none' });

  return (
    <main style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16, background: '#f3f4f9' }}>
      {/* Header */}
      <section style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ height: 32, width: 32, borderRadius: 8, background: '#eef2ff', display: 'grid', placeItems: 'center' }}>
          <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="1.8">
            <path d="M3 12h4l3 8 4-16 3 8h4" />
          </svg>
        </div>
        <div>
          <h1 style={{ fontSize: 17, fontWeight: 700, color: '#1e2536', margin: 0 }}>Cluster Headroom</h1>
          <p style={{ fontSize: 12, color: '#64748b', margin: 0 }}>
            Reserve cluster capacity in advance so scale-ups schedule instantly.
          </p>
        </div>
      </section>

      {/* KPI row — 4 equal cells with dividers */}
      <section className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)' }}>
          <Kpi label="CPU headroom" value={overview ? (overview.cpuHeadroom > 0 ? coresAxis(overview.cpuHeadroom) : '0') : '—'} />
          <div style={{ borderLeft: '1px solid #eef0f6' }}>
            <Kpi label="Memory headroom" value={overview ? (overview.memoryHeadroom > 0 ? memFmt(overview.memoryHeadroom) : '0 B') : '—'} />
          </div>
          <div style={{ borderLeft: '1px solid #eef0f6' }}>
            <Kpi label="GPU headroom" value={overview ? overview.gpuHeadroom : '—'} />
          </div>
          <div style={{ borderLeft: '1px solid #eef0f6' }}>
            <Kpi label="Node pools with headroom" value={overview ? Math.round(overview.nodePoolsWithHeadroomPct) : '—'} sub="%" />
          </div>
        </div>
      </section>

      {/* Charts */}
      <section className="card" style={{ padding: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#1e2536' }}>Headroom over time</div>
          <div style={{ display: 'flex', gap: 2, background: '#f1f2f7', borderRadius: 8, padding: 2 }}>
            <Seg on={range === '7d'} onClick={() => setRange('7d')}>
              7 Days
            </Seg>
            <Seg on={range === '30d'} onClick={() => setRange('30d')}>
              30 Days
            </Seg>
          </div>
        </div>
        <HeadLegend />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
          <HeadroomChart title="CPU" points={graph?.cpu || []} fmt={coresAxis} range={range} />
          <HeadroomChart title="Memory" points={graph?.memory || []} fmt={bytesAxis} range={range} />
          <HeadroomChart title="GPU" points={graph?.gpu || []} fmt={plainAxis} range={range} />
        </div>
      </section>

      {/* Configurations */}
      <section className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '10px 20px 12px', borderBottom: '1px solid #eef0f6', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="search…"
            style={{
              background: '#f4f5f8',
              border: '1px solid #e9eaf0',
              borderRadius: 999,
              padding: '6px 12px',
              fontSize: 13,
              outline: 'none',
              width: 200,
              fontFamily: 'inherit',
              color: '#1e2536',
            }}
          />
          <div style={{ flex: 1 }} />
          <div style={{ position: 'relative' }}>
            <button
              onClick={() => setColsOpen((o) => !o)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 13,
                fontWeight: 600,
                color: '#334155',
                background: '#fff',
                border: '1px solid #dfe2ec',
                borderRadius: 8,
                padding: '6px 12px',
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              Columns
            </button>
            <Dropdown open={colsOpen} onClose={() => setColsOpen(false)} style={{ right: 0, width: 180, padding: 6 }}>
              {ALL_COLS.map(([k, l]) => (
                <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderRadius: 8, cursor: 'pointer', fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={cols.has(k)}
                    onChange={(e) =>
                      setCols((prev) => {
                        const n = new Set(prev);
                        if (e.target.checked) n.add(k);
                        else n.delete(k);
                        return n;
                      })
                    }
                  />
                  {l}
                </label>
              ))}
            </Dropdown>
          </div>
          <button
            onClick={() => setDrawer({ kind: 'new' })}
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: '#fff',
              background: '#6366f1',
              border: 'none',
              borderRadius: 8,
              padding: '6px 14px',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Create configuration
          </button>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ ...thStyle, paddingLeft: 20 }}>Name</th>
                <th style={{ ...thStyle, ...dataCol('cpu') }}>CPU</th>
                <th style={{ ...thStyle, ...dataCol('memory') }}>Memory</th>
                <th style={{ ...thStyle, ...dataCol('gpu') }}>GPU</th>
                <th style={{ ...thStyle, ...dataCol('lifecycle') }}>Lifecycle</th>
                <th style={{ ...thStyle, ...dataCol('nodePools') }}>Node Pools</th>
                <th style={{ ...thStyle, ...dataCol('schedule') }}>Schedule</th>
                <th style={{ ...thStyle, textAlign: 'right', paddingRight: 20 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.length ? (
                rows.map((c) => {
                  const idx = configs.indexOf(c);
                  return (
                    <tr key={c.name} style={{ borderBottom: '1px solid #f3f4f9' }}>
                      <td style={{ padding: '12px 12px 12px 20px', fontWeight: 500, color: '#1e2536' }}>{c.name}</td>
                      <td className="num" style={{ padding: 12, color: '#475569', ...dataCol('cpu') }}>{resLabel(c.cpu)}</td>
                      <td className="num" style={{ padding: 12, color: '#475569', ...dataCol('memory') }}>{resLabel(c.memory)}</td>
                      <td className="num" style={{ padding: 12, color: '#475569', ...dataCol('gpu') }}>{resLabel(c.gpu)}</td>
                      <td style={{ padding: 12, color: '#64748b', ...dataCol('lifecycle') }}>{lifecycleLabel(c.lifecycle)}</td>
                      <td style={{ padding: 12, color: c.nodePools?.length ? '#64748b' : '#cbd5e1', ...dataCol('nodePools') }}>
                        {c.nodePools?.length ? c.nodePools.join(', ') : '—'}
                      </td>
                      <td style={{ padding: 12, color: '#64748b', ...dataCol('schedule') }}>{scheduleLabel(c)}</td>
                      <td style={{ padding: 12, textAlign: 'right', paddingRight: 20, whiteSpace: 'nowrap' }}>
                        <button
                          onClick={() => setDrawer({ kind: 'edit', index: idx })}
                          style={{ fontSize: 12, fontWeight: 600, color: '#4f46e5', border: 'none', background: 'none', cursor: 'pointer', fontFamily: 'inherit', marginRight: 12 }}
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => void del(idx)}
                          style={{ fontSize: 12, fontWeight: 600, color: '#f43f5e', border: 'none', background: 'none', cursor: 'pointer', fontFamily: 'inherit' }}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={8} style={{ padding: '48px 20px', textAlign: 'center', color: '#94a3b8' }}>
                    No rows
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <footer style={{ textAlign: 'center', fontSize: 12, color: '#94a3b8', paddingTop: 8, paddingBottom: 24 }}>
        CoolScaler · Cluster Headroom · reserved capacity via over-provisioning pause pods
      </footer>

      <HeadroomDrawer
        mode={drawer}
        configs={configs}
        nodePoolOptions={poolOptions}
        onClose={() => setDrawer(null)}
        onSave={persist}
      />
    </main>
  );
}
