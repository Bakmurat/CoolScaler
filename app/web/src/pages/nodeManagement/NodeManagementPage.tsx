// Node Management
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { getJson } from '../../api/client';
import { usd, cpuFmt, memFmt } from '../../lib/format';
import '../rightsizing/rightsizing.css';
import { Dropdown } from '../rightsizing/ui';
import { FilterChipSelect } from '../podPlacement/shared';
import { NdBlockedChart, NdCostChart, NdResChart, ResLegend, useNodesGraph } from './charts';
import NodeDrawer from './NodeDrawer';
import type { NdNode, NodeOptResponse, NodesResponse, VolumesResponse } from './types';

const pctColor = (p: number) => (p >= 80 ? '#f43f5e' : p >= 50 ? '#fbbf24' : '#22c55e');

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
const selStyle: CSSProperties = {
  background: '#f4f5f8',
  border: '1px solid #e9eaf0',
  borderRadius: 8,
  padding: '6px 8px',
  fontSize: 12,
  outline: 'none',
  cursor: 'pointer',
  fontFamily: 'inherit',
  color: '#1e2536',
};

function MiniBar({ pct, color, label }: { pct: number; color: string; label: string }) {
  const w = Math.max(0, Math.min(100, pct));
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ flex: 1, height: 6, borderRadius: 9999, background: '#eef0f6', overflow: 'hidden' }}>
        <div style={{ height: '100%', background: color, width: w + '%' }} />
      </div>
      <span className="num" style={{ fontSize: 11, color: '#64748b', width: 80, textAlign: 'right', flexShrink: 0 }}>
        {label}
      </span>
    </div>
  );
}

/** Top-tile gauge row: label + % value + thin bar. */
function Gauge({ label, pct, color }: { label: string; pct?: number; color: string }) {
  const w = Math.max(0, Math.min(100, pct || 0));
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 12, fontWeight: 500, color: '#64748b' }}>
          {label} <span style={{ color: '#cbd5e1' }}>(avg.)</span>
        </span>
        <span className="num" style={{ fontSize: 18, fontWeight: 700, color: '#1e2536' }}>
          {Math.round(pct || 0)}%
        </span>
      </div>
      <div style={{ height: 6, borderRadius: 9999, background: '#eef0f6', marginTop: 6, overflow: 'hidden' }}>
        <div style={{ height: '100%', background: color, width: w + '%' }} />
      </div>
    </div>
  );
}

function Seg({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <span className={'seg' + (on ? ' active' : '')} onClick={onClick}>
      {children}
    </span>
  );
}

const WarnIcon = ({ color = '#f59e0b', size = 14, style }: { color?: string; size?: number; style?: CSSProperties }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" style={style}>
    <path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
  </svg>
);

const gib = (v: number) => {
  const g = v / 2 ** 30;
  return g >= 1 ? g.toFixed(g >= 10 ? 0 : 1) + ' Gi' : Math.round(v / 2 ** 20) + ' Mi';
};

/** key=value matcher for the Labels filter (same semantics as rightsizing). */
function kvMatch(q: string, obj?: Record<string, string>): boolean {
  q = (q || '').trim();
  if (!q) return true;
  const i = q.indexOf('=');
  const k = i < 0 ? q : q.slice(0, i);
  const v = i < 0 ? null : q.slice(i + 1);
  const o = obj || {};
  return k in o && (v == null || v === '' || o[k] === v);
}

/** Nodes-table column catalog for the Columns menu (Name is always shown). */
const NODE_COLS: [string, string][] = [
  ['group', 'Node Group'],
  ['cost', 'Monthly Cost'],
  ['discount', 'Discount Type'],
  ['type', 'Type'],
  ['lifecycle', 'Lifecycle'],
  ['cpuReq', 'CPU Request'],
  ['cpuUse', 'CPU Usage'],
  ['memReq', 'Memory Request'],
  ['memUse', 'Memory Usage'],
  ['pods', 'Pods'],
];

/** Labels filter chip — free key=value input; honest about missing backend data. */
function LabelsChip({ value, onChange, hasData }: { value: string; onChange: (v: string) => void; hasData: boolean }) {
  const [open, setOpen] = useState(false);
  const on = !!value.trim();
  return (
    <div style={{ position: 'relative' }}>
      <span className={'chip' + (on ? ' on' : '')} onClick={() => setOpen((o) => !o)}>
        {on ? 'Labels: ' + value : 'Labels'}{' '}
        {on ? (
          <span
            onClick={(e) => {
              e.stopPropagation();
              onChange('');
              setOpen(false);
            }}
            style={{ marginLeft: 4, fontWeight: 700, cursor: 'pointer' }}
          >
            ✕
          </span>
        ) : (
          <span style={{ marginLeft: 2 }}>▾</span>
        )}
      </span>
      <Dropdown open={open} onClose={() => setOpen(false)} style={{ left: 0, width: 240, padding: 10 }}>
        <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>
          label <span style={{ color: '#cbd5e1' }}>key=value</span>
        </div>
        <input
          className="chip"
          style={{ width: '100%', cursor: 'text' }}
          placeholder="node-role.kubernetes.io/worker=true"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        {!hasData && (
          <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 6 }}>
            The backend does not report node labels yet — the filter activates once it does.
          </div>
        )}
      </Dropdown>
    </div>
  );
}

export default function NodeManagementPage() {
  const [data, setData] = useState<NodesResponse | null>(null);
  const [connErr, setConnErr] = useState(false);
  const [updated, setUpdated] = useState('—');
  const [tick, setTick] = useState(0);
  const [costRange, setCostRange] = useState<'6h' | '24h' | '7d'>('24h');
  const [resRange, setResRange] = useState<'7d' | '30d'>('7d');
  const [nodeOpt, setNodeOpt] = useState<NodeOptResponse | null>(null);
  const [vols, setVols] = useState<VolumesResponse | null>(null);
  const [q, setQ] = useState('');
  const [life, setLife] = useState('');
  const [blk, setBlk] = useState('');
  const [labelF, setLabelF] = useState('');
  const [colsOpen, setColsOpen] = useState(false);
  const [cols, setCols] = useState<Set<string>>(new Set(NODE_COLS.map(([k]) => k)));
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [drawerName, setDrawerName] = useState<string | null>(null);

  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let dead = false;
    getJson<NodesResponse>('/api/nodes')
      .then((d) => {
        if (dead) return;
        setData(d);
        setConnErr(false);
        setUpdated('updated ' + new Date().toLocaleTimeString());
      })
      .catch(() => {
        if (!dead) setConnErr(true);
      });
    getJson<NodeOptResponse>('/api/node-optimization')
      .then((d) => {
        if (!dead) setNodeOpt(d);
      })
      .catch(() => {});
    getJson<VolumesResponse>('/api/volumes')
      .then((d) => {
        if (!dead) setVols(d);
      })
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [tick]);

  const resValues = useNodesGraph(resRange, tick);

  const t = data?.totals || {};
  const blocked = t.blockedNodes || 0;

  // Labels are a feature-detected backend field; when no node reports them the
  // filter stays inert (the chip explains why) instead of silently hiding rows.
  const anyLabels = (data?.nodes || []).some((n) => n.labels && Object.keys(n.labels).length > 0);

  const rows = (data?.nodes || []).filter((n) => {
    if (q && !(n.name.toLowerCase().includes(q.toLowerCase()) || (n.instanceType || '').toLowerCase().includes(q.toLowerCase())))
      return false;
    if (life === 'spot' && !n.isSpot) return false;
    if (life === 'ondemand' && n.isSpot) return false;
    if (blk === 'blocked' && !((n.blockers || 0) > 0)) return false;
    if (blk === 'free' && (n.blockers || 0) > 0) return false;
    if (labelF.trim() && anyLabels && !kvMatch(labelF, n.labels)) return false;
    return true;
  });

  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const curPage = Math.min(Math.max(1, page), pages);
  const start = (curPage - 1) * pageSize;
  const pageRows = rows.slice(start, start + pageSize);
  const dataCol = (k: string): CSSProperties => (cols.has(k) ? {} : { display: 'none' });

  const pcts = useMemo(
    () => (n: NdNode) => ({
      cpuReq: n.cpuAllocatable ? ((n.cpuRequest || 0) / n.cpuAllocatable) * 100 : 0,
      cpuUse: n.cpuAllocatable ? ((n.cpuUsage || 0) / n.cpuAllocatable) * 100 : 0,
      memReq: n.memoryAllocatable ? ((n.memoryRequest || 0) / n.memoryAllocatable) * 100 : 0,
      memUse: n.memoryAllocatable ? ((n.memoryUsage || 0) / n.memoryAllocatable) * 100 : 0,
    }),
    [],
  );

  const exportCsv = () => {
    const esc = (s: unknown) => {
      const t = String(s ?? '');
      return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
    };
    const head = [
      'Name', 'Node Group', 'Monthly Cost', 'Discount Type', 'Type', 'Lifecycle',
      'CPU Request %', 'CPU Usage %', 'Memory Request %', 'Memory Usage %', 'Running Pods', 'Max Pods',
    ];
    const lines = rows.map((n) => {
      const p = pcts(n);
      return [
        n.name, n.nodeGroup || '', (n.cost || 0).toFixed(2), n.discountType || '', n.instanceType || '',
        n.isSpot ? 'Spot' : 'On-Demand',
        p.cpuReq.toFixed(1), p.cpuUse.toFixed(1), p.memReq.toFixed(1), p.memUse.toFixed(1),
        n.runningPods ?? '', n.maxPods ?? '',
      ].map(esc).join(',');
    });
    const blob = new Blob([head.join(',') + '\n' + lines.join('\n') + '\n'], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'coolscaler-nodes.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const c = nodeOpt?.consolidation || {};
  const cand = c.candidates || [];
  const types = nodeOpt?.instanceTypes || [];
  const volumes = vols?.volumes || [];
  const vt = vols?.totals || {};

  return (
    <main style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16, background: '#f3f4f9' }}>
      {/* Header */}
      <section style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ height: 32, width: 32, borderRadius: 8, background: '#eef2ff', display: 'grid', placeItems: 'center' }}>
            <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="1.8">
              <rect x="3" y="4" width="18" height="6" rx="1.5" />
              <rect x="3" y="14" width="18" height="6" rx="1.5" />
              <path d="M7 7h.01M7 17h.01" />
            </svg>
          </div>
          <div>
            <h1 style={{ fontSize: 17, fontWeight: 700, color: '#1e2536', margin: 0 }}>Node Management</h1>
            <p style={{ fontSize: 12, color: '#64748b', margin: 0 }}>Per-node capacity, utilization, cost &amp; scale-down blockers.</p>
          </div>
        </div>
        <span style={{ fontSize: 11, color: '#94a3b8' }}>{updated}</span>
      </section>

      {/* Top tiles: monthly cost + request/usage gauges */}
      <section className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)' }}>
          <div style={{ padding: 24, display: 'grid', placeItems: 'center' }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 13, fontWeight: 500, color: '#64748b' }}>
                Monthly cost <span style={{ color: '#cbd5e1' }}>(live)</span>
              </div>
              <div className="num" style={{ marginTop: 4, fontSize: 40, lineHeight: 1, fontWeight: 800, letterSpacing: '-.02em', color: '#4f46e5' }}>
                {data ? usd(t.monthlyCost) : '—'}
              </div>
              <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 6 }}>
                <span className="num">{t.nodes || 0}</span> nodes · <span className="num">{t.spotNodes || 0}</span> spot
              </div>
            </div>
          </div>
          <div style={{ padding: 24, display: 'grid', gridTemplateRows: '1fr 1fr', gap: 16, borderLeft: '1px solid #eef0f6' }}>
            <Gauge label="CPU request" pct={t.cpuRequestPct} color="#fbbf24" />
            <Gauge label="CPU usage" pct={t.cpuUsagePct} color="#6366f1" />
          </div>
          <div style={{ padding: 24, display: 'grid', gridTemplateRows: '1fr 1fr', gap: 16, borderLeft: '1px solid #eef0f6' }}>
            <Gauge label="Memory request" pct={t.memoryRequestPct} color="#fbbf24" />
            <Gauge label="Memory usage" pct={t.memoryUsagePct} color="#6366f1" />
          </div>
        </div>
      </section>

      {/* Blocked-nodes banner */}
      {blocked > 0 && (
        <section
          className="card"
          style={{ padding: 16, display: 'flex', alignItems: 'center', gap: 12, borderColor: '#fde68a', background: 'rgba(255,251,235,.6)' }}
        >
          <WarnIcon size={20} />
          <div style={{ fontSize: 13, color: '#b45309' }}>
            <span className="num" style={{ fontWeight: 700 }}>{blocked}</span> node(s) blocked from scale-down by un-evictable
            pods — bin-packing them would free capacity.
          </div>
        </section>
      )}

      {/* Resources over time */}
      <section className="card" style={{ padding: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#1e2536' }}>Resources over time</div>
            <div style={{ fontSize: 12, color: '#64748b' }}>
              Node allocatable vs total request vs usage — the gap is reclaimable capacity.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 2, background: '#f1f2f7', borderRadius: 8, padding: 2 }}>
            <Seg on={resRange === '7d'} onClick={() => setResRange('7d')}>
              7 Days
            </Seg>
            <Seg on={resRange === '30d'} onClick={() => setResRange('30d')}>
              30 Days
            </Seg>
          </div>
        </div>
        <ResLegend />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#64748b', marginBottom: 4 }}>CPU over time</div>
            <NdResChart values={resValues} resource="cpu" />
          </div>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#64748b', marginBottom: 4 }}>Memory over time</div>
            <NdResChart values={resValues} resource="memory" />
          </div>
        </div>
      </section>

      {/* Blocked nodes by actions */}
      <section className="card" style={{ padding: 20 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#1e2536', marginBottom: 4 }}>Blocked nodes by actions</div>
        <div style={{ fontSize: 12, color: '#64748b', marginBottom: 8 }}>
          Nodes prevented from scaling down, grouped by the action that would unblock them.
        </div>
        <NdBlockedChart tick={tick} />
      </section>

      {/* Cluster node cost over time */}
      <section className="card" style={{ padding: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#1e2536' }}>Cluster node cost over time</div>
          <div style={{ display: 'flex', gap: 2, background: '#f1f2f7', borderRadius: 8, padding: 2 }}>
            {(['6h', '24h', '7d'] as const).map((r) => (
              <Seg key={r} on={costRange === r} onClick={() => setCostRange(r)}>
                {r}
              </Seg>
            ))}
          </div>
        </div>
        <NdCostChart range={costRange} tick={tick} />
      </section>

      {/* Node Optimization: consolidation candidates + instance-type pool */}
      <section className="card" style={{ padding: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#1e2536' }}>Node Optimization</div>
            <div style={{ fontSize: 12, color: '#64748b' }}>
              Under-utilized, unblocked nodes that can be consolidated, and the instance-type pool.
            </div>
          </div>
          <span className="pill" style={{ background: '#f0fdf4', color: '#16a34a', border: '1px solid #dcfce7' }}>
            {'$' + Math.round(c.potentialMonthlySavings || 0) + '/mo potential savings'}
          </span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 24, marginBottom: 12 }}>
              <div>
                <div style={{ fontSize: 11, color: '#94a3b8', fontWeight: 500 }}>Current nodes</div>
                <div className="num" style={{ fontSize: 22, fontWeight: 700, color: '#1e2536' }}>{c.currentNodes || 0}</div>
              </div>
              <div style={{ color: '#cbd5e1', fontSize: 20 }}>→</div>
              <div>
                <div style={{ fontSize: 11, color: '#94a3b8', fontWeight: 500 }}>After consolidation</div>
                <div className="num" style={{ fontSize: 22, fontWeight: 700, color: '#16a34a' }}>{c.optimizedNodes || 0}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: '#94a3b8', fontWeight: 500 }}>Consolidatable</div>
                <div className="num" style={{ fontSize: 22, fontWeight: 700, color: '#4f46e5' }}>{c.candidateCount || 0}</div>
              </div>
            </div>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#64748b', marginBottom: 4 }}>Consolidation candidates</div>
            <div style={{ fontSize: 12, maxHeight: 224, overflow: 'auto' }}>
              {cand.length ? (
                cand.map((x) => (
                  <div
                    key={x.node}
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '4px 0', borderBottom: '1px solid #f6f7fb' }}
                  >
                    <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      <span style={{ color: '#475569' }}>{x.node}</span>{' '}
                      <span style={{ color: '#94a3b8' }}>
                        · {x.instanceType || '?'} · {x.runningPods}p · {x.cpuRequestPct}% cpu
                      </span>
                    </div>
                    <span className="num" style={{ fontWeight: 600, color: '#16a34a', flexShrink: 0 }}>${x.monthlyCost.toFixed(2)}</span>
                  </div>
                ))
              ) : (
                <div style={{ color: '#94a3b8' }}>No consolidation candidates — nodes are well-utilized.</div>
              )}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#64748b', marginBottom: 8 }}>Instance-type pool</div>
            <div style={{ fontSize: 12 }}>
              {types.length ? (
                types.map((ty) => (
                  <div
                    key={ty.instanceType}
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '4px 0', borderBottom: '1px solid #f6f7fb' }}
                  >
                    <div>
                      <span style={{ fontWeight: 600, color: '#334155' }}>{ty.instanceType}</span>{' '}
                      <span style={{ color: '#94a3b8' }}>· {ty.nodes} node{ty.nodes > 1 ? 's' : ''}</span>
                    </div>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span className="num" style={{ color: '#64748b' }}>${ty.monthlyCost.toFixed(0)}/mo</span>
                      <span
                        className="pill"
                        style={
                          ty.status === 'blocked'
                            ? { background: '#fff1f2', color: '#e11d48' }
                            : ty.status === 'not-allowed'
                              ? { background: '#f1f5f9', color: '#94a3b8' }
                              : { background: '#f0fdf4', color: '#16a34a' }
                        }
                      >
                        {ty.status}
                      </span>
                    </span>
                  </div>
                ))
              ) : (
                <div style={{ color: '#94a3b8' }}>No instance types observed.</div>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* Nodes table */}
      <section className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '12px 20px 0', fontSize: 14, fontWeight: 700, color: '#1e2536' }}>Nodes</div>
        <div style={{ padding: '10px 20px 12px', borderBottom: '1px solid #eef0f6', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <input
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
            placeholder="search…"
            style={{ ...selStyle, cursor: 'text', width: 192, padding: '6px 12px', fontSize: 13, borderRadius: 999 }}
          />
          <FilterChipSelect
            label="Scale Down Blockers"
            value={blk}
            options={[
              ['blocked', 'Blocked'],
              ['free', 'Not blocked'],
            ]}
            onChange={(v) => {
              setBlk(v);
              setPage(1);
            }}
          />
          <FilterChipSelect
            label="Life Cycle"
            value={life}
            options={[
              ['ondemand', 'On-Demand'],
              ['spot', 'Spot'],
            ]}
            onChange={(v) => {
              setLife(v);
              setPage(1);
            }}
          />
          <LabelsChip
            value={labelF}
            onChange={(v) => {
              setLabelF(v);
              setPage(1);
            }}
            hasData={anyLabels}
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
                color: '#fff',
                background: '#3d4254',
                border: 'none',
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
            <Dropdown open={colsOpen} onClose={() => setColsOpen(false)} style={{ right: 0, width: 200, padding: 6 }}>
              {NODE_COLS.map(([k, l]) => (
                <label
                  key={k}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderRadius: 8, cursor: 'pointer', fontSize: 13 }}
                >
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
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ ...thStyle, paddingLeft: 20 }}>Name</th>
                <th style={{ ...thStyle, ...dataCol('group') }}>Node Group</th>
                <th style={{ ...thStyle, ...dataCol('cost') }}>Monthly Cost</th>
                <th style={{ ...thStyle, ...dataCol('discount') }}>Discount Type</th>
                <th style={{ ...thStyle, ...dataCol('type') }}>Type</th>
                <th style={{ ...thStyle, ...dataCol('lifecycle') }}>Lifecycle</th>
                <th style={{ ...thStyle, width: 160, ...dataCol('cpuReq') }}>CPU Request</th>
                <th style={{ ...thStyle, width: 160, ...dataCol('cpuUse') }}>CPU Usage</th>
                <th style={{ ...thStyle, width: 160, ...dataCol('memReq') }}>Memory Request</th>
                <th style={{ ...thStyle, width: 160, ...dataCol('memUse') }}>Memory Usage</th>
                <th style={{ ...thStyle, ...dataCol('pods') }}>Pods</th>
              </tr>
            </thead>
            <tbody>
              {connErr ? (
                <tr>
                  <td colSpan={11} style={{ padding: '24px 20px', textAlign: 'center', color: '#94a3b8' }}>connection error</td>
                </tr>
              ) : pageRows.length ? (
                pageRows.map((n) => {
                  const p = pcts(n);
                  return (
                    <tr
                      key={n.name}
                      onClick={() => setDrawerName(n.name)}
                      style={{ borderBottom: '1px solid #f3f4f9', cursor: 'pointer' }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = '#fafbff')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = '')}
                    >
                      <td
                        style={{ padding: '12px 12px 12px 20px', fontWeight: 500, color: '#1e2536' }}
                        title={n.blockers ? n.blockers + ' un-evictable pod(s) block scale-down' : ''}
                      >
                        {(n.blockers || 0) > 0 && <WarnIcon style={{ verticalAlign: -2, marginRight: 4 }} />}
                        {n.name}
                      </td>
                      <td style={{ padding: 12, color: n.nodeGroup ? '#475569' : '#cbd5e1', ...dataCol('group') }}>
                        {n.nodeGroup || '—'}
                      </td>
                      <td className="num" style={{ padding: 12, color: '#475569', ...dataCol('cost') }}>{usd(n.cost)}</td>
                      <td style={{ padding: 12, color: n.discountType ? '#475569' : '#cbd5e1', ...dataCol('discount') }}>
                        {n.discountType || '—'}
                      </td>
                      <td style={{ padding: 12, color: n.instanceType ? '#64748b' : '#cbd5e1', ...dataCol('type') }}>
                        {n.instanceType || '—'}
                      </td>
                      <td style={{ padding: 12, ...dataCol('lifecycle') }}>
                        {n.isSpot ? (
                          <span className="pill" style={{ background: '#f5f3ff', color: '#7c3aed', border: '1px solid #ede9fe' }}>Spot</span>
                        ) : (
                          <span className="pill" style={{ background: '#2d3352', color: '#fff', border: '1px solid #2d3352' }}>On Demand</span>
                        )}
                      </td>
                      <td style={{ padding: 12, ...dataCol('cpuReq') }}>
                        <MiniBar pct={p.cpuReq} color={pctColor(p.cpuReq)} label={Math.round(p.cpuReq) + '% · ' + cpuFmt(n.cpuAllocatable)} />
                      </td>
                      <td style={{ padding: 12, ...dataCol('cpuUse') }}>
                        <MiniBar pct={p.cpuUse} color="#6366f1" label={Math.round(p.cpuUse) + '%'} />
                      </td>
                      <td style={{ padding: 12, ...dataCol('memReq') }}>
                        <MiniBar pct={p.memReq} color={pctColor(p.memReq)} label={Math.round(p.memReq) + '% · ' + memFmt(n.memoryAllocatable)} />
                      </td>
                      <td style={{ padding: 12, ...dataCol('memUse') }}>
                        <MiniBar pct={p.memUse} color="#6366f1" label={Math.round(p.memUse) + '%'} />
                      </td>
                      <td className="num" style={{ padding: 12, color: '#64748b', ...dataCol('pods') }}>
                        {n.runningPods}/{n.maxPods}
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={11} style={{ padding: '24px 20px', textAlign: 'center', color: '#94a3b8' }}>no nodes match</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {/* footer: Export + rows-per-page pagination */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '10px 20px',
            fontSize: 12,
            color: '#94a3b8',
            borderTop: '1px solid #eef0f6',
          }}
        >
          <button
            onClick={exportCsv}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 12,
              fontWeight: 600,
              color: '#334155',
              background: '#fff',
              border: '1px solid #dfe2ec',
              borderRadius: 999,
              padding: '4px 12px',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
            title="Download the filtered nodes as CSV"
          >
            Export
            <svg style={{ width: 13, height: 13 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path d="M12 3v12m0 0l-4-4m4 4l4-4M4 21h16" />
            </svg>
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              Rows per page:
              <select
                value={pageSize}
                onChange={(e) => {
                  setPageSize(+e.target.value);
                  setPage(1);
                }}
                style={{ background: '#f4f5f8', border: '1px solid #e9eaf0', borderRadius: 6, padding: '4px 6px', outline: 'none', cursor: 'pointer' }}
              >
                {[10, 25, 50, 100].map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </select>
            </label>
            <span className="num">
              {rows.length ? `${start + 1}–${Math.min(start + pageSize, rows.length)} of ${rows.length}` : '0 of 0'}
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <button
                disabled={curPage <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid #e9eaf0', background: '#fff', cursor: 'pointer', fontFamily: 'inherit', color: '#64748b' }}
              >
                ‹
              </button>
              <button
                disabled={curPage >= pages}
                onClick={() => setPage((p) => Math.min(pages, p + 1))}
                style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid #e9eaf0', background: '#fff', cursor: 'pointer', fontFamily: 'inherit', color: '#64748b' }}
              >
                ›
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Persistent Volumes */}
      <section className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '12px 20px', borderBottom: '1px solid #eef0f6', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#1e2536' }}>Persistent Volumes</div>
            <div style={{ fontSize: 11, color: '#94a3b8' }}>
              PVC utilization from kubelet volume stats · PVCs support expansion, not in-place shrink — low usage is informational
            </div>
          </div>
          <div style={{ fontSize: 12, color: '#64748b' }}>
            {volumes.length > 0 && (
              <>
                {vt.count} PVCs · <span style={{ fontWeight: 600, color: '#1e2536' }}>{gib(vt.usedBytes || 0)}</span> used of{' '}
                {gib(vt.capacityBytes || 0)} · <span style={{ fontWeight: 600, color: '#d97706' }}>{vt.overProvisionedPct || 0}%</span>{' '}
                over-provisioned
              </>
            )}
          </div>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ ...thStyle, paddingLeft: 20 }}>PVC</th>
                <th style={thStyle}>Namespace</th>
                <th style={thStyle}>Used</th>
                <th style={thStyle}>Capacity</th>
                <th style={thStyle}>Utilization</th>
                <th style={thStyle}>Over-provisioned</th>
              </tr>
            </thead>
            <tbody>
              {volumes.map((v) => {
                const u = Math.max(0, Math.min(100, v.utilizationPct || 0));
                const bar = u < 40 ? '#fbbf24' : u < 80 ? '#4ade80' : '#818cf8';
                return (
                  <tr key={v.namespace + '/' + v.pvc} style={{ borderBottom: '1px solid #f1f2f7' }}>
                    <td style={{ padding: '10px 12px 10px 20px', fontWeight: 600, color: '#1e2536', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {v.pvc}
                    </td>
                    <td style={{ padding: '10px 12px', color: '#64748b' }}>{v.namespace}</td>
                    <td className="num" style={{ padding: '10px 12px', color: '#475569' }}>{gib(v.usedBytes || 0)}</td>
                    <td className="num" style={{ padding: '10px 12px', color: '#475569' }}>{gib(v.capacityBytes || 0)}</td>
                    <td style={{ padding: '10px 12px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ width: 80, height: 6, borderRadius: 4, background: '#f1f5f9', overflow: 'hidden' }}>
                          <div style={{ height: '100%', background: bar, width: u + '%' }} />
                        </div>
                        <span className="num" style={{ fontSize: 11, color: '#64748b' }}>{u.toFixed(0)}%</span>
                      </div>
                    </td>
                    <td
                      className="num"
                      style={{ padding: '10px 12px', ...((v.overProvisionedBytes || 0) > 0 ? { color: '#d97706', fontWeight: 600 } : { color: '#cbd5e1' }) }}
                    >
                      {gib(v.overProvisionedBytes || 0)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!volumes.length && (
            <div style={{ padding: '32px 20px', textAlign: 'center', fontSize: 14, color: '#94a3b8' }}>
              No PersistentVolumeClaims reporting kubelet volume stats.
            </div>
          )}
        </div>
      </section>

      <footer style={{ textAlign: 'center', fontSize: 12, color: '#94a3b8', paddingTop: 8, paddingBottom: 24 }}>
        CoolScaler · Node Management · live from the Kubernetes &amp; metrics APIs · refreshes every 30s
      </footer>

      <NodeDrawer name={drawerName} onClose={() => setDrawerName(null)} />
    </main>
  );
}
