// Custom Workloads page
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  Area,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useNavigate } from 'react-router-dom';
import { getJson, postJson } from '../../api/client';
import { useFeedback } from '../../providers/FeedbackProvider';
import { usePrompt } from '../../components/PromptModal';
import { useGlobalSearchString } from '../../hooks/useUrlState';
import { cpuFmt, memFmt, coresFmt, mibFmt } from '../../lib/format';
import { timeFmt } from '../rightsizing/lib';
import { Toggle, usePolicyNames } from '../rightsizing/ui';
import '../rightsizing/rightsizing.css';
import { selStyle } from '../policies/fields';
import CogDrawer, { gpuFmt } from './CogDrawer';
import type {
  CogSimResponse,
  CustomWorkloadRow,
  CustomWorkloadsResponse,
  CwOvertimePoint,
  UnrecognizedPod,
} from './types';

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
const td: React.CSSProperties = { padding: '10px 12px', fontSize: 12, color: '#64748b' };

// ---- over-time charts (Unrecognized / Total / Waste w/ breakdown tooltip) ----
interface CwPt {
  label: string;
  unrec: number | null;
  total: number | null;
  waste: number | null;
  breakdown: Record<string, { cpu?: number; mem?: number; gpu?: number }>;
}

function CwChart({
  data,
  res,
  fmt,
}: {
  data: CwPt[];
  res: 'cpu' | 'mem' | 'gpu';
  fmt: (v?: number | null) => string;
}) {
  return (
    <div style={{ height: 150 }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <XAxis dataKey="label" tick={{ fontSize: 9, fill: '#aab' }} tickLine={false} axisLine={false} minTickGap={60} />
          <YAxis tick={{ fontSize: 9, fill: '#aab' }} tickFormatter={(v: number) => fmt(v)} tickLine={false} axisLine={false} width={52} />
          <Tooltip
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              const p = payload[0].payload as CwPt;
              const bd = Object.entries(p.breakdown || {})
                .filter(([, v]) => (v[res] || 0) > 0)
                .sort((a, b) => (b[1][res] || 0) - (a[1][res] || 0));
              return (
                <div style={{ background: '#fff', border: '1px solid #e9eaf0', borderRadius: 8, padding: '8px 10px', fontSize: 11 }}>
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>{String(label)}</div>
                  <div style={{ color: '#f59e0b' }}>Unrecognized request: {fmt(p.unrec)}</div>
                  <div style={{ color: '#94a3b8' }}>Total request: {fmt(p.total)}</div>
                  {bd.length > 0 && (
                    <>
                      <div style={{ color: '#94a3b8', marginTop: 4 }}>— breakdown by owner type —</div>
                      {bd.map(([k, v]) => (
                        <div key={k} style={{ color: '#475569' }}>
                          {k}: {fmt(v[res])}
                        </div>
                      ))}
                    </>
                  )}
                </div>
              );
            }}
          />
          <Area type="monotone" dataKey="waste" stroke="none" fill="rgba(239,68,68,.18)" dot={false} isAnimationActive={false} />
          <Area type="monotone" dataKey="unrec" stroke="#f59e0b" strokeWidth={1.6} fill="rgba(245,158,11,.14)" dot={false} isAnimationActive={false} />
          <Line type="monotone" dataKey="total" stroke="#cbd0e0" strokeWidth={1.2} dot={false} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function Modal({ title, sub, onClose, children }: { title: string; sub: string; onClose: () => void; children: ReactNode }) {
  return (
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1250,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: 24,
        background: 'rgba(0,0,0,.3)',
      }}
    >
      <div
        style={{
          background: '#fff',
          borderRadius: 12,
          boxShadow: '0 25px 50px -12px rgba(0,0,0,.25)',
          width: '100%',
          maxWidth: 896,
          maxHeight: '85vh',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          marginTop: 24,
        }}
      >
        <div style={{ padding: '12px 20px', background: '#3a3f4b', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontWeight: 700 }}>{title}</div>
          <button
            onClick={onClose}
            style={{ height: 32, width: 32, display: 'grid', placeItems: 'center', borderRadius: 8, border: 'none', background: 'transparent', color: '#fff', cursor: 'pointer', fontSize: 15 }}
          >
            ✕
          </button>
        </div>
        <div style={{ padding: '12px 20px', borderBottom: '1px solid #eef0f5', fontSize: 13, fontWeight: 600, color: '#1e2536' }}>{sub}</div>
        <div style={{ overflowY: 'auto', padding: 16 }}>{children}</div>
      </div>
    </div>
  );
}

export default function CustomWorkloadsPage() {
  const { toast, confirm } = useFeedback();
  const prompt = usePrompt();
  const navigate = useNavigate();
  const search = useGlobalSearchString();
  const policyNames = usePolicyNames();
  const [data, setData] = useState<CustomWorkloadsResponse>({ customWorkloads: [], unrecognized: [] });
  const [range, setRange] = useState<'7d' | '30d'>('7d');
  const [points, setPoints] = useState<CwOvertimePoint[]>([]);
  const [filter, setFilter] = useState('');
  const [affectedOnly, setAffectedOnly] = useState(false);
  const [colsOpen, setColsOpen] = useState(false);
  const [cwCols, setCwCols] = useState<Set<string>>(new Set(['cpu', 'mem', 'gpu', 'gpumem', 'workloads', 'policy', 'enabled']));
  const [cwPage, setCwPage] = useState(1);
  const [drawer, setDrawer] = useState<{ open: boolean; existing: CustomWorkloadRow | null }>({ open: false, existing: null });
  const [simView, setSimView] = useState<CogSimResponse | null>(null);
  const [podsView, setPodsView] = useState<{ kind: string; pods: UnrecognizedPod[] } | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await getJson<CustomWorkloadsResponse>('/api/custom-workloads'));
    } catch {
      setData({ customWorkloads: [], unrecognized: [] });
    }
  }, []);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => {
      if (!drawer.open) void load();
    }, 30000);
    return () => window.clearInterval(t);
  }, [load, drawer.open]);

  useEffect(() => {
    let dead = false;
    getJson<{ values?: CwOvertimePoint[] }>('/api/custom-workloads/overtime?range=' + range)
      .then((g) => {
        if (!dead) setPoints(g.values || []);
      })
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [range]);

  const chartData = (prefix: 'cpu' | 'mem' | 'gpu'): CwPt[] =>
    points.map((p) => {
      const raw = p.values || {};
      return {
        label: timeFmt(p.timestamp),
        unrec: raw[prefix + 'Unrecognized'] ?? null,
        total: raw[prefix + 'Total'] ?? null,
        waste: raw[prefix + 'Waste'] ?? null,
        breakdown: p.breakdown || {},
      };
    });

  const duplicate = useCallback(
    async (name: string) => {
      const nn = await prompt('Duplicate custom workload', 'New name (no dashes)', name.toLowerCase().replace(/[^a-z0-9]/g, '') + 'copy');
      if (!nn) return;
      try {
        const r = await postJson<{ ok?: boolean; message?: string }>('/api/cog/duplicate', { source: name, name: nn });
        if (r.ok) {
          toast('Duplicated');
          await load();
          const d = await getJson<CustomWorkloadsResponse>('/api/custom-workloads');
          setData(d);
          const ex = (d.customWorkloads || []).find((c) => c.name === nn) || null;
          setDrawer({ open: true, existing: ex });
        } else toast(r.message || 'Failed', 'error');
      } catch {
        toast('Failed', 'error');
      }
    },
    [prompt, toast, load],
  );

  const del = useCallback(
    async (name: string) => {
      if (!(await confirm(`Delete custom workload "${name}"?`))) return;
      try {
        await postJson('/api/cog/delete', { name });
        toast('Deleted');
        void load();
      } catch {
        toast('Delete failed', 'error');
      }
    },
    [confirm, toast, load],
  );

  const f = filter.toLowerCase();
  const list = (data.customWorkloads || []).filter(
    (c) => (!f || c.name.toLowerCase().includes(f)) && (!affectedOnly || (c.workloads || 0) > 0),
  );
  const CW_PAGE = 15;
  const cwPages = Math.max(1, Math.ceil(list.length / CW_PAGE));
  const cwCur = Math.min(Math.max(1, cwPage), cwPages);
  const pageList = list.slice((cwCur - 1) * CW_PAGE, (cwCur - 1) * CW_PAGE + CW_PAGE);
  const cwCol = (k: string): React.CSSProperties => (cwCols.has(k) ? {} : { display: 'none' });
  const CW_ALL_COLS: [string, string][] = [
    ['cpu', 'CPU Request'],
    ['mem', 'Memory Request'],
    ['gpu', 'GPU Compute Request'],
    ['gpumem', 'GPU Memory Request'],
    ['workloads', 'Number of Workloads'],
    ['policy', 'Default Policy'],
    ['enabled', 'Enabled'],
  ];
  const exploreCog = (name: string) => {
    const sp = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
    sp.set('types', name);
    navigate('/rightSizing/workloads?' + sp.toString());
  };
  const unrec = data.unrecognized || [];

  const legend: [string, string, 'solid' | 'hatch'][] = [
    ['#f59e0b', 'Unrecognized request', 'solid'],
    ['#cbd0e0', 'Total request', 'solid'],
    ['#ef4444', 'Waste', 'hatch'],
  ];

  return (
    <main style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* header */}
      <section className="card" style={{ padding: 16, display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ fontSize: 24 }}>🖐️</div>
        <div style={{ flex: 1 }}>
          <h1 style={{ fontSize: 17, fontWeight: 700, color: '#1e2536', margin: 0 }}>Custom Workloads</h1>
          <p style={{ fontSize: 12, color: '#64748b', margin: 0 }}>
            Manage and configure your custom workloads to meet your specific needs, while identifying unrecognized
            resources and potential inefficiencies.
          </p>
        </div>
      </section>

      {/* over-time charts */}
      <section className="card" style={{ padding: 16 }}>
        <div style={{ display: 'flex', gap: 2, width: 'max-content', marginBottom: 8 }}>
          {(['7d', '30d'] as const).map((r) => (
            <span key={r} className={'tabline' + (range === r ? ' active' : '')} onClick={() => setRange(r)}>
              {r === '7d' ? '7 Days' : '30 Days'}
            </span>
          ))}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 20 }}>
          {(
            [
              ['CPU over time', 'cpu', cpuFmt],
              ['Memory over time', 'mem', memFmt],
              ['GPU Compute over time', 'gpu', gpuFmt],
            ] as const
          ).map(([title, res, fmt]) => (
            <div key={res}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#1e2536', textAlign: 'center' }}>{title}</div>
              <div style={{ fontSize: 11, color: '#94a3b8', textAlign: 'center', marginBottom: 4 }}>
                (<b style={{ color: '#6366f1', fontWeight: 600 }}>Hover</b> for breakdown)
              </div>
              <CwChart data={chartData(res)} res={res} fmt={fmt as (v?: number | null) => string} />
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', gap: '4px 16px', marginTop: 12, fontSize: 11, color: '#64748b' }}>
          {legend.map(([c, t, st]) => (
            <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span
                style={{
                  height: 8,
                  width: 12,
                  borderRadius: 2,
                  background: st === 'hatch' ? `repeating-linear-gradient(45deg,${c},${c} 2px,transparent 2px,transparent 4px)` : c,
                }}
              />
              {t}
            </span>
          ))}
        </div>
      </section>

      {/* Unrecognized Pods by Type */}
      <section className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '12px 20px', borderBottom: '1px solid #eef0f6' }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#1e2536' }}>Unrecognized Pods by Type</div>
          <div style={{ fontSize: 11, color: '#94a3b8' }}>
            Unrecognized types are resource types detected in the cluster that are not recognized by the system.
          </div>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ ...th, paddingLeft: 20 }}>Owner Kind</th>
                <th style={th}>CPU Request</th>
                <th style={th}>Memory Request</th>
                <th style={th}>GPU Compute Request</th>
                <th style={th}>Total Pods</th>
              </tr>
            </thead>
            <tbody>
              {unrec.length === 0 && (
                <tr>
                  <td colSpan={5} style={{ ...td, textAlign: 'center', padding: '24px 20px', color: '#94a3b8' }}>
                    No rows
                  </td>
                </tr>
              )}
              {unrec.map((r) => (
                <tr
                  key={r.ownerKind}
                  title="Explore pods of this owner type"
                  onClick={() => setPodsView({ kind: r.ownerKind, pods: (data.unrecognizedPods || {})[r.ownerKind] || [] })}
                  style={{ borderBottom: '1px solid #f1f2f7', cursor: 'pointer' }}
                >
                  <td style={{ ...td, paddingLeft: 20, fontWeight: 500, color: '#4f46e5' }}>{r.ownerKind}</td>
                  <td style={td} className="num">{cpuFmt(r.cpu)}</td>
                  <td style={td} className="num">{memFmt(r.mem)}</td>
                  <td style={td} className="num">{gpuFmt(r.gpu)}</td>
                  <td style={td} className="num">{r.pods}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Custom Workloads table */}
      <section className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '12px 20px', borderBottom: '1px solid #eef0f6', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#1e2536' }}>Custom Workloads</div>
            <div style={{ fontSize: 11, color: '#94a3b8', maxWidth: 640 }}>
              Custom workloads are workloads that are not part of the standard set of workloads provided by the
              system. User-created custom workloads take precedence over built-in ones.
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <input
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value);
                setCwPage(1);
              }}
              placeholder="Search…"
              style={{
                background: '#f4f5f8',
                border: '1px solid #e9eaf0',
                borderRadius: 8,
                padding: '6px 12px',
                fontSize: 14,
                width: 176,
                outline: 'none',
                fontFamily: 'inherit',
              }}
            />
            <span
              className={'chip' + (affectedOnly ? ' on' : '')}
              onClick={() => {
                setAffectedOnly((v) => !v);
                setCwPage(1);
              }}
            >
              has affected workloads
            </span>
            <div style={{ position: 'relative' }}>
              <button
                onClick={() => setColsOpen((v) => !v)}
                style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600, color: '#fff', background: '#3d4254', borderRadius: 8, padding: '6px 12px', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}
              >
                <svg style={{ width: 15, height: 15 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
                  <path d="M1.5 12S5.5 5 12 5s10.5 7 10.5 7-4 7-10.5 7S1.5 12 1.5 12z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
                Columns
              </button>
              {colsOpen && (
                <div
                  style={{ position: 'absolute', right: 0, top: '100%', marginTop: 4, width: 224, background: '#fff', borderRadius: 12, boxShadow: '0 20px 25px -5px rgba(0,0,0,.1),0 8px 10px -6px rgba(0,0,0,.1)', border: '1px solid #e9eaf0', padding: 6, zIndex: 40 }}
                  onMouseLeave={() => setColsOpen(false)}
                >
                  {CW_ALL_COLS.map(([k, l]) => (
                    <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderRadius: 8, cursor: 'pointer', fontSize: 13 }}>
                      <input
                        type="checkbox"
                        checked={cwCols.has(k)}
                        onChange={(e) => {
                          setCwCols((prev) => {
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
                </div>
              )}
            </div>
            <button
              onClick={() => setDrawer({ open: true, existing: null })}
              style={{
                fontSize: 12,
                fontWeight: 600,
                borderRadius: 8,
                padding: '6px 12px',
                border: '1px solid #d8dae6',
                color: '#1e2536',
                background: '#fff',
                cursor: 'pointer',
                fontFamily: 'inherit',
                whiteSpace: 'nowrap',
              }}
            >
              Create Custom Workload Rule
            </button>
          </div>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ ...th, paddingLeft: 20 }}>Name</th>
                <th style={{ ...th, ...cwCol('cpu') }}>CPU Request</th>
                <th style={{ ...th, ...cwCol('mem') }}>Memory Request</th>
                <th style={{ ...th, ...cwCol('gpu') }}>GPU Compute Request</th>
                <th style={{ ...th, ...cwCol('gpumem') }}>GPU Memory Request</th>
                <th style={{ ...th, ...cwCol('workloads') }}>Number of Workloads</th>
                <th style={{ ...th, ...cwCol('policy') }}>Default Policy</th>
                <th style={{ ...th, ...cwCol('enabled') }}>Enabled</th>
                <th style={{ ...th, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {pageList.length === 0 && (
                <tr>
                  <td colSpan={9} style={{ ...td, textAlign: 'center', padding: '24px 20px', color: '#94a3b8' }}>
                    No custom workloads.
                  </td>
                </tr>
              )}
              {pageList.map((c) => (
                <tr key={c.name} style={{ borderBottom: '1px solid #f1f2f7' }}>
                  <td style={{ ...td, paddingLeft: 20 }}>
                    <span
                      title={c.builtIn ? 'View (read-only)' : 'Edit'}
                      onClick={() => setDrawer({ open: true, existing: c })}
                      style={{ fontWeight: 600, color: '#1e2536', cursor: 'pointer' }}
                    >
                      {c.name}
                    </span>
                    {c.builtIn ? (
                      <span className="pill" style={{ background: '#f1f5f9', color: '#64748b', marginLeft: 4 }}>
                        ⚒ Built in
                      </span>
                    ) : (
                      <span className="pill" style={{ background: '#f5f3ff', color: '#7c3aed', marginLeft: 4 }}>
                        custom
                      </span>
                    )}
                    {c.name === 'DaemonSetNodeSize' && (
                      <span className="pill" style={{ background: '#fff', color: '#6366f1', border: '1px solid #a5b4fc', marginLeft: 4 }}>
                        New
                      </span>
                    )}
                    <div>
                      <button
                        title="Show this group's workloads in the Rightsizing table"
                        onClick={() => exploreCog(c.name)}
                        style={{ fontSize: 10, color: '#64748b', border: '1px solid #d8dae6', borderRadius: 6, padding: '2px 8px', background: '#fff', cursor: 'pointer', fontFamily: 'inherit', marginTop: 4, display: 'inline-flex', alignItems: 'center', gap: 4 }}
                      >
                        <svg style={{ width: 10, height: 10 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4}>
                          <circle cx="11" cy="11" r="7" />
                          <path d="M21 21l-4-4" />
                        </svg>
                        Explore workloads
                      </button>
                    </div>
                  </td>
                  <td style={{ ...td, ...cwCol('cpu') }} className="num">{coresFmt(c.cpu ?? 0)}</td>
                  <td style={{ ...td, ...cwCol('mem') }} className="num">{mibFmt(c.mem ?? 0)}</td>
                  <td style={{ ...td, ...cwCol('gpu') }} className="num">{gpuFmt(c.gpu)}</td>
                  <td style={{ ...td, ...cwCol('gpumem') }} className="num">{gpuFmt(c.gpuMem)}</td>
                  <td style={{ ...td, ...cwCol('workloads') }} className="num">{c.workloads}</td>
                  <td style={{ ...td, ...cwCol('policy') }}>
                    <select
                      value={c.defaultPolicy || 'Auto detected'}
                      onChange={(e) => {
                        void postJson('/api/cog/policy', { name: c.name, defaultPolicy: e.target.value })
                          .then(() => toast('Default policy updated'))
                          .catch(() => toast('Failed', 'error'));
                      }}
                      style={{ ...selStyle, width: 'auto' }}
                    >
                      <option>Auto detected</option>
                      {policyNames.map((p) => (
                        <option key={p}>{p}</option>
                      ))}
                    </select>
                  </td>
                  <td style={{ ...td, ...cwCol('enabled') }}>
                    <Toggle
                      checked={c.enabled !== false}
                      onChange={(on) => {
                        void postJson('/api/cog/toggle', { name: c.name, enabled: on })
                          .then(() => {
                            toast('Custom workload ' + (on ? 'enabled' : 'disabled'));
                            void load();
                          })
                          .catch(() => toast('Failed', 'error'));
                      }}
                    />
                  </td>
                  <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap', fontSize: 11 }}>
                    {c.builtIn ? (
                      <button
                        disabled
                        title="Built in — duplicate to edit"
                        style={{ color: '#cbd5e1', fontWeight: 600, border: 'none', background: 'none', cursor: 'not-allowed', fontFamily: 'inherit', fontSize: 11 }}
                      >
                        ✎ Edit
                      </button>
                    ) : (
                      <button
                        onClick={() => setDrawer({ open: true, existing: c })}
                        style={{ color: '#6366f1', fontWeight: 600, border: 'none', background: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 11 }}
                      >
                        ✎ Edit
                      </button>
                    )}
                    <button
                      onClick={() => void duplicate(c.name)}
                      style={{ color: '#6366f1', fontWeight: 600, border: 'none', background: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 11, marginLeft: 8 }}
                    >
                      ⧉ Duplicate
                    </button>
                    {c.builtIn ? (
                      <button
                        disabled
                        title="Built in — cannot delete"
                        style={{ color: '#cbd5e1', fontWeight: 600, border: 'none', background: 'none', cursor: 'not-allowed', fontFamily: 'inherit', fontSize: 11, marginLeft: 8 }}
                      >
                        Delete
                      </button>
                    ) : (
                      <button
                        onClick={() => void del(c.name)}
                        style={{ color: '#f43f5e', fontWeight: 600, border: 'none', background: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 11, marginLeft: 8 }}
                      >
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 12, padding: '10px 20px', fontSize: 12, color: '#94a3b8', borderTop: '1px solid #eef0f5' }}>
          <span>Rows per page: {CW_PAGE}</span>
          <span className="num">
            {list.length ? `${(cwCur - 1) * CW_PAGE + 1}–${Math.min(cwCur * CW_PAGE, list.length)} of ${list.length}` : '0–0 of 0'}
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <button
              disabled={cwCur <= 1}
              onClick={() => setCwPage((p) => p - 1)}
              style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid #e9eaf0', background: '#fff', cursor: 'pointer', fontFamily: 'inherit', color: '#64748b' }}
            >
              ‹
            </button>
            <button
              disabled={cwCur >= cwPages}
              onClick={() => setCwPage((p) => p + 1)}
              style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid #e9eaf0', background: '#fff', cursor: 'pointer', fontFamily: 'inherit', color: '#64748b' }}
            >
              ›
            </button>
          </div>
        </div>
      </section>

      <footer style={{ textAlign: 'center', fontSize: 12, color: '#94a3b8', paddingTop: 8, paddingBottom: 24 }}>
        CoolScaler · Custom Workloads · CustomOwnerGrouping concept (analysis.coolscaler.sh)
      </footer>

      {/* COG editor drawer */}
      <CogDrawer
        open={drawer.open}
        existing={drawer.existing}
        policyNames={policyNames}
        onClose={() => {
          setDrawer({ open: false, existing: null });
          void load();
        }}
        onDuplicate={(nm) => void duplicate(nm)}
        onViewSim={(s) => setSimView(s)}
      />

      {/* Simulation preview modal */}
      {simView && (
        <Modal
          title="Simulation preview"
          sub={`${simView.matchedWorkloads} workload(s) · ${simView.matchedPods} pod(s) matched`}
          onClose={() => setSimView(null)}
        >
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr>
                <th style={th}>Workload</th>
                <th style={{ ...th, textAlign: 'right' }}>Pods</th>
                <th style={{ ...th, textAlign: 'right' }}>CPU</th>
                <th style={{ ...th, textAlign: 'right' }}>Memory</th>
                <th style={{ ...th, textAlign: 'right' }}>GPU</th>
              </tr>
            </thead>
            <tbody>
              {(simView.groups || []).length === 0 && (
                <tr>
                  <td colSpan={5} style={{ ...td, textAlign: 'center', padding: 24, color: '#94a3b8' }}>
                    No matches.
                  </td>
                </tr>
              )}
              {(simView.groups || []).map((x) => (
                <tr key={x.name} style={{ borderTop: '1px solid #f1f2f7' }}>
                  <td style={{ ...td, fontWeight: 500, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {x.name}
                    <div style={{ fontSize: 10, color: '#94a3b8' }}>{(x.namespaces || []).join(', ')}</div>
                  </td>
                  <td style={{ ...td, textAlign: 'right' }} className="num">{x.pods}</td>
                  <td style={{ ...td, textAlign: 'right' }} className="num">{cpuFmt(x.cpu)}</td>
                  <td style={{ ...td, textAlign: 'right' }} className="num">{memFmt(x.mem)}</td>
                  <td style={{ ...td, textAlign: 'right' }} className="num">{gpuFmt(x.gpu || 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Modal>
      )}

      {/* Unrecognized pods explorer modal */}
      {podsView && (
        <Modal
          title={`Type → ${podsView.kind}`}
          sub={`Pods — ${podsView.pods.length} unrecognized pod(s); explore their labels/annotations/images to plan a custom workload`}
          onClose={() => setPodsView(null)}
        >
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr>
                <th style={th}>Pod Name</th>
                <th style={{ ...th, textAlign: 'right' }}>CPU</th>
                <th style={{ ...th, textAlign: 'right' }}>Memory</th>
                <th style={{ ...th, textAlign: 'center' }}>Labels</th>
                <th style={{ ...th, textAlign: 'center' }}>Annotations</th>
                <th style={th}>Images</th>
                <th style={th}>Owners</th>
              </tr>
            </thead>
            <tbody>
              {podsView.pods.length === 0 && (
                <tr>
                  <td colSpan={7} style={{ ...td, textAlign: 'center', padding: 24, color: '#94a3b8' }}>
                    No pods.
                  </td>
                </tr>
              )}
              {podsView.pods.map((p) => {
                const kv = (o?: Record<string, string>) => {
                  const e = Object.entries(o || {});
                  return e.length ? (
                    <span title={e.map(([k, v]) => k + ': ' + v).join('\n')} style={{ cursor: 'help', color: '#6366f1' }}>
                      {e.length} ⓘ
                    </span>
                  ) : (
                    <span style={{ color: '#cbd5e1' }}>—</span>
                  );
                };
                return (
                  <tr key={p.namespace + '/' + p.name} style={{ borderTop: '1px solid #f1f2f7' }}>
                    <td style={{ ...td, fontWeight: 500, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {p.name}
                      <div style={{ fontSize: 10, color: '#94a3b8' }}>{p.namespace}</div>
                    </td>
                    <td style={{ ...td, textAlign: 'right' }} className="num">{cpuFmt(p.cpu)}</td>
                    <td style={{ ...td, textAlign: 'right' }} className="num">{memFmt(p.mem)}</td>
                    <td style={{ ...td, textAlign: 'center' }}>{kv(p.labels)}</td>
                    <td style={{ ...td, textAlign: 'center' }}>{kv(p.annotations)}</td>
                    <td style={{ ...td, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }} title={(p.images || []).join('\n')}>
                      {(p.images || []).join(', ') || '—'}
                    </td>
                    <td style={td}>{p.owner || '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Modal>
      )}
    </main>
  );
}
