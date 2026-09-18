// Pod Scheduling (Beta) page
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { getJson, postJson } from '../../api/client';
import { useFeedback } from '../../providers/FeedbackProvider';
import { useClusterData } from '../../providers/ClusterDataProvider';
import { usd } from '../../lib/format';
import { Dropdown, Toggle } from '../rightsizing/ui';
import '../rightsizing/rightsizing.css';
import { useGraph } from '../podPlacement/PodPlacementPage';
import {
  AllocReqWasteChart,
  AutoDonut,
  GoodButton,
  IllusBox,
  IllusButton,
  IllusModal,
  IndigoButton,
  NodesBarChart,
  cardStyle,
  thStyle,
} from '../podPlacement/shared';

/* ---------- local response types (GET /api/scheduling, /api/scheduling-policies) ---------- */
interface ScTotals {
  monthlyCost?: number;
  blockedNodes?: number;
  savings?: number;
  wastePct?: number;
  workloads?: number;
  automated?: number;
  nodes?: number;
  optimizedNodes?: number;
  readOnly?: boolean;
}
interface ScWorkload {
  key: string;
  namespace: string;
  kind: string;
  name: string;
  replicas?: number;
  selfBefore?: number;
  selfAfter?: number;
  savings?: number;
  policyName?: string;
  automated?: boolean;
  required?: boolean;
  topologyKey?: string;
  concerns?: string[];
  eligible?: boolean;
}
interface SchedulingResponse {
  workloads?: ScWorkload[];
  totals?: ScTotals;
}
interface ScPolicy {
  name: string;
  description?: string;
  usedBy?: number;
  total?: number;
  minimumNodesSpread?: number;
  zones?: boolean;
  builtIn?: boolean;
}

const inputStyle: CSSProperties = {
  width: '100%',
  border: '1px solid #e2e8f0',
  borderRadius: 8,
  padding: '8px 12px',
  fontSize: 13,
  outline: 'none',
  fontFamily: 'inherit',
  boxSizing: 'border-box',
};

/* filter-row control style — matches the Pod Placement filter row (filtSel). */
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

function SelfArrow({ a, b }: { a?: number; b?: number }) {
  const av = a || 0;
  const bv = b || 0;
  const good = bv < av;
  const color = good ? '#16a34a' : '#94a3b8';
  return (
    <span className="num">
      <span style={{ color: '#94a3b8' }}>{av}</span>{' '}
      <span style={{ color, fontWeight: 700 }}>{good ? '↓' : '→'}</span>{' '}
      <span style={{ color, fontWeight: 700 }}>{bv}</span>
    </span>
  );
}

export default function SchedulingPage() {
  const { toast, confirm } = useFeedback();
  const { ro: RO } = useClusterData();

  const [data, setData] = useState<SchedulingResponse>({ workloads: [], totals: {} });
  const [wlTab, setWlTab] = useState<'workloads' | 'blocked'>('workloads');
  const [blockedNodes, setBlockedNodes] = useState<{ node: string; savings?: number; freeable?: boolean; pinned?: boolean; pods?: number; reasons?: string[] }[]>([]);
  const [policies, setPolicies] = useState<ScPolicy[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [actionsOpen, setActionsOpen] = useState(false);
  const [illusOpen, setIllusOpen] = useState(false);
  // resource-graph range + workloads filter state
  const [resRange, setResRange] = useState<'7d' | '30d'>('7d');
  const [q, setQ] = useState('');
  const [nsF, setNsF] = useState('');
  const [chips, setChips] = useState<Set<'automated' | 'unautomated' | 'savings'>>(new Set());
  const resTypes = useMemo(() => ['cpuAllocatable', 'cpuRequests', 'memoryAllocatable', 'memoryRequests'], []);
  const resVals = useGraph(resRange, resTypes);
  const [polModal, setPolModal] = useState<{ edit: string | null } | null>(null);
  const [polName, setPolName] = useState('');
  const [polSpread, setPolSpread] = useState('2');
  const [polZones, setPolZones] = useState(false);

  const load = useCallback(async () => {
    try {
      const [d, p] = await Promise.all([
        getJson<SchedulingResponse>('/api/scheduling'),
        getJson<{ policies?: ScPolicy[] }>('/api/scheduling-policies'),
      ]);
      setData(d);
      setPolicies(p.policies || []);
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
  const ws = data.workloads || [];
  const tot = t.workloads || 0;
  const auto = t.automated || 0;

  /* ---- workloads-table filters (client-side, like Pod Placement) ---- */
  const nsList = useMemo(() => [...new Set(ws.map((w) => w.namespace))].sort(), [ws]);
  const fw = ws.filter((w) => {
    if (q && !(w.namespace + '/' + w.name).toLowerCase().includes(q.toLowerCase())) return false;
    if (nsF && w.namespace !== nsF) return false;
    if (chips.has('automated') && !w.automated) return false;
    if (chips.has('unautomated') && w.automated) return false;
    if (chips.has('savings') && !((w.savings || 0) > 0)) return false;
    return true;
  });

  /* ---- actions ---- */
  const automate = async (key: string, enabled: boolean) => {
    if (RO) {
      toast('Cluster is in READ-ONLY mode.');
      return;
    }
    await postJson('/api/scheduling-automate', { key, enabled }).catch(() => {});
    getJson<{ blockedNodes?: typeof blockedNodes }>('/api/placement')
      .then((d) => setBlockedNodes(d.blockedNodes || []))
      .catch(() => {});
    void load();
  };
  const automateAll = async () => {
    if (RO) {
      toast('Cluster is in READ-ONLY mode.');
      return;
    }
    if (!(await confirm('Automate self anti-affinity relaxation for all eligible workloads?'))) return;
    await postJson('/api/scheduling-automate-all', { enabled: true }).catch(() => {});
    void load();
  };
  const attach = async (key: string, policy: string) => {
    const [ns, kind, name] = key.split('/');
    await postJson('/api/scheduling-attach-policy', { namespace: ns, kind, name, policy }).catch(() => {});
    void load();
  };
  const bulk = async (action: 'automate' | 'apply') => {
    if (RO) {
      toast('Cluster is in READ-ONLY mode.');
      return;
    }
    const keys = [...selected];
    if (!keys.length) {
      toast('Select one or more workloads first.', 'warn');
      return;
    }
    if (
      action === 'apply' &&
      !(await confirm(`Relax self anti-affinity on ${keys.length} workload(s)? Required → preferred + topology-spread (keeps min node spread).`))
    )
      return;
    const r = await postJson<{ count?: number }>('/api/scheduling-bulk', { action, keys }).catch(() => ({}) as { count?: number });
    setActionsOpen(false);
    toast(`${action}: applied to ${r.count || 0} workload(s).`);
    void load();
  };

  /* ---- policy editor (scNewPolicy / scEditPolicy / scPolSave / scPolDelete) ---- */
  const newPolicy = () => {
    if (RO) {
      toast('Cluster is in READ-ONLY mode.');
      return;
    }
    setPolName('');
    setPolSpread('2');
    setPolZones(false);
    setPolModal({ edit: null });
  };
  const editPolicy = (p: ScPolicy) => {
    if (RO) {
      toast('Cluster is in READ-ONLY mode.');
      return;
    }
    setPolName(p.name);
    setPolSpread(String(p.minimumNodesSpread ?? 2));
    setPolZones(!!p.zones);
    setPolModal({ edit: p.name });
  };
  const savePolicy = async () => {
    const name = (polModal?.edit || polName || '').trim();
    if (!name) {
      toast('Policy name required.');
      return;
    }
    const body = { name, minimumNodesSpread: Math.max(1, +polSpread || 2), zones: polZones };
    const r = await postJson<{ ok?: boolean; message?: string }>('/api/scheduling-policy/save', body).catch(() => ({ ok: false }) as {
      ok?: boolean;
      message?: string;
    });
    if (r && r.ok) {
      setPolModal(null);
      toast('Scheduling policy ' + name + ' saved');
      void load();
    } else toast((r && r.message) || 'Save failed');
  };
  const deletePolicy = async (name: string) => {
    if (!(await confirm('Delete scheduling policy “' + name + '”?'))) return;
    const r = await postJson<{ ok?: boolean; message?: string }>('/api/scheduling-policy/delete', { name }).catch(() => ({ ok: false }) as {
      ok?: boolean;
      message?: string;
    });
    if (r && r.ok) {
      toast('Deleted ' + name);
      void load();
    } else toast((r && r.message) || 'Delete failed');
  };

  /* ---- illustration numbers (scIllustration) ---- */
  const nodes = t.nodes || 0;
  const optimized = t.optimizedNodes || 0;
  const blocked = t.blockedNodes || 0;
  const freed = Math.max(0, nodes - optimized);
  const relaxed = ws.reduce((s, w) => s + Math.max(0, (w.selfBefore || 0) - (w.selfAfter || 0)), 0);

  return (
    <main style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* header */}
      <section>
        <h1 style={{ fontSize: 17, fontWeight: 700, color: '#1e2536', margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
          Pod Scheduling{' '}
          <span className="pill" style={{ background: '#ede9fe', color: '#7c3aed' }}>
            Beta
          </span>
        </h1>
        <p style={{ fontSize: 12, color: '#64748b', margin: '2px 0 0' }}>
          Workloads whose <b>self pod anti-affinity</b> pins replicas to separate nodes and blocks scale-down. CoolScaler relaxes it
          (required → preferred) while keeping a minimum node spread, so the autoscaler can consolidate.
        </p>
      </section>

      {/* KPI cards */}
      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0,1fr))', gap: 16 }}>
        <div style={{ ...cardStyle, padding: 16, textAlign: 'center' }}>
          <div style={{ fontSize: 12, color: '#64748b' }}>
            Monthly cost <span style={{ color: '#cbd5e1' }}>(live)</span>
          </div>
          <div className="num" style={{ marginTop: 8, fontSize: 26, fontWeight: 700, color: '#4f46e5' }}>
            {t.monthlyCost != null ? usd(t.monthlyCost) : '—'}
          </div>
        </div>
        <div style={{ ...cardStyle, padding: 16, textAlign: 'center' }}>
          <div style={{ fontSize: 12, color: '#64748b' }}>Wasted spend</div>
          <div className="num" style={{ marginTop: 8, fontSize: 26, fontWeight: 700, color: '#f43f5e' }}>
            {t.wastePct != null ? Math.round(t.wastePct) + '%' : '—'}
          </div>
        </div>
        <div style={{ ...cardStyle, padding: 16, textAlign: 'center' }}>
          <div style={{ fontSize: 12, color: '#64748b' }}>Blocked nodes</div>
          <div className="num" style={{ marginTop: 8, fontSize: 26, fontWeight: 700, color: blocked > 0 ? '#f59e0b' : '#16a34a' }}>
            {t.blockedNodes ?? '—'}
          </div>
        </div>
        <div style={{ ...cardStyle, padding: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <AutoDonut auto={auto} total={tot} legendRows itemLabel="relaxable workloads" />
          <div style={{ flex: 1, textAlign: 'right' }}>
            <div style={{ fontSize: 12, color: '#64748b' }}>Blocking workloads</div>
            <div className="num" style={{ fontSize: 18, fontWeight: 700, color: '#1e2536' }}>{tot}</div>
            <GoodButton disabled={RO || tot === 0} onClick={() => void automateAll()} style={{ marginTop: 4, fontSize: 11, padding: '4px 12px' }}>
              Automate All
            </GoodButton>
          </div>
        </div>
      </section>

      {/* resource graphs — CPU | Memory | Nodes over time */}
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
            <IllusButton onClick={() => setIllusOpen(true)}>Optimization Illustration</IllusButton>
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
              <NodesBarChart current={nodes} optimized={optimized} />
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

      {/* workloads */}
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
          <div style={{ display: 'flex', gap: 2 }}>
            {(['workloads', 'blocked'] as const).map((t) => (
              <button key={t} onClick={() => setWlTab(t)} style={{
                border: 'none', background: 'transparent', fontFamily: 'inherit', fontSize: 14, cursor: 'pointer', padding: '4px 12px',
                color: wlTab === t ? '#1e2536' : '#64748b', fontWeight: wlTab === t ? 700 : 500,
                borderBottom: wlTab === t ? '2px solid #4338ca' : '2px solid transparent',
              }}>{t === 'workloads' ? 'Workloads' : 'Blocked nodes'}</button>
            ))}
          </div>
          <div style={{ position: 'relative' }}>
            <IndigoButton
              onClick={(e) => {
                e.stopPropagation();
                setActionsOpen((v) => !v);
              }}
            >
              Pod Scheduling Actions
            </IndigoButton>
            <Dropdown open={actionsOpen} onClose={() => setActionsOpen(false)} style={{ right: 0, width: 176, padding: '4px 0' }}>
              <div style={{ padding: '4px 12px', fontSize: 10, textTransform: 'uppercase', letterSpacing: '.04em', color: '#94a3b8', fontWeight: 700 }}>
                {selected.size} selected
              </div>
              {(
                [
                  ['automate', 'Automate'],
                  ['apply', 'Relax now'],
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
            </Dropdown>
          </div>
        </div>
        {wlTab === 'blocked' ? (
          <table style={{ width: '100%', fontSize: 12.5, borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {['Node', 'Blocked pods', 'Reasons', 'Savings Available', 'Status'].map((h) => (
                  <th key={h} style={{ textAlign: 'left', fontSize: 12, fontWeight: 700, color: '#1e2536', padding: '10px 18px', background: '#f6f7fb', borderBottom: '1px solid #eef0f6' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {blockedNodes.map((n) => (
                <tr key={n.node}>
                  <td style={{ padding: '11px 18px', borderBottom: '1px solid #f2f3f8', fontWeight: 500, color: '#1e2536' }}>{n.node}</td>
                  <td className="num" style={{ padding: '11px 18px', borderBottom: '1px solid #f2f3f8', color: '#475569' }}>{n.pods ?? 0}</td>
                  <td style={{ padding: '11px 18px', borderBottom: '1px solid #f2f3f8' }}>
                    {(n.reasons || []).slice(0, 3).map((r) => (
                      <span key={r} className="pill" style={{ background: '#fffbeb', color: '#d97706', marginRight: 4, fontSize: 10.5 }}>{r}</span>
                    ))}
                    {(n.reasons || []).length > 3 && <span style={{ fontSize: 11, color: '#94a3b8' }}>+{(n.reasons || []).length - 3}</span>}
                  </td>
                  <td className="num" style={{ padding: '11px 18px', borderBottom: '1px solid #f2f3f8', color: '#16a34a', fontWeight: 600 }}>{usd(n.savings || 0)}</td>
                  <td style={{ padding: '11px 18px', borderBottom: '1px solid #f2f3f8' }}>
                    {n.pinned ? (
                      <span className="pill" style={{ background: '#fef2f2', color: '#dc2626' }}>Pinned</span>
                    ) : n.freeable ? (
                      <span className="pill" style={{ background: '#f0fdf4', color: '#16a34a' }}>Freeable</span>
                    ) : (
                      <span className="pill" style={{ background: '#f1f5f9', color: '#64748b' }}>Blocked</span>
                    )}
                  </td>
                </tr>
              ))}
              {!blockedNodes.length && (
                <tr><td colSpan={5} style={{ padding: '36px 0', textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>No blocked nodes 🎉</td></tr>
              )}
            </tbody>
          </table>
        ) : (
          <>
        {/* filter row (search + chips + namespaces) */}
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
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ ...thStyle, paddingLeft: 16, paddingRight: 4 }}>
                  <input
                    type="checkbox"
                    checked={fw.filter((w) => w.eligible).length > 0 && selected.size === fw.filter((w) => w.eligible).length}
                    onChange={(e) => setSelected(e.target.checked ? new Set(fw.filter((w) => w.eligible).map((w) => w.key)) : new Set())}
                  />
                </th>
                <th style={{ ...thStyle, padding: '10px 8px' }}>Workload</th>
                <th style={thStyle}>Available Savings</th>
                <th style={thStyle}>Self Anti-Affinity Replicas</th>
                <th style={thStyle}>Replicas</th>
                <th style={thStyle}>Policy</th>
                <th style={{ ...thStyle, textAlign: 'center' }}>Automated</th>
              </tr>
            </thead>
            <tbody>
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
                  <td style={{ padding: '12px 8px' }}>
                    <div style={{ fontWeight: 600, color: '#1e2536' }}>{w.name}</div>
                    <div style={{ fontSize: 11, color: '#94a3b8', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4 }}>
                      {w.namespace} · {w.kind}{' '}
                      {(w.concerns || ['Pod anti-affinity']).map((c) => (
                        <span key={c} className="pill" style={{ background: '#f1f5f9', color: '#64748b' }}>
                          {c}
                        </span>
                      ))}
                      {w.topologyKey && (
                        <span className="pill" style={{ background: '#eef2ff', color: '#6366f1' }} title="Topology key">
                          {w.topologyKey}
                        </span>
                      )}
                    </div>
                  </td>
                  <td
                    className="num"
                    style={{ padding: '0 12px', color: (w.savings || 0) > 0.5 ? '#16a34a' : '#cbd5e1', fontWeight: (w.savings || 0) > 0.5 ? 600 : 400 }}
                  >
                    {(w.savings || 0) > 0.5 ? usd(w.savings) : '$0'}
                  </td>
                  <td style={{ padding: '0 12px' }}>
                    <SelfArrow a={w.selfBefore} b={w.selfAfter} />
                  </td>
                  <td className="num" style={{ padding: '0 12px', color: '#334155' }}>
                    {w.replicas}/{w.replicas}
                  </td>
                  <td style={{ padding: '0 12px' }}>
                    <select
                      disabled={RO}
                      value={w.policyName || ''}
                      onChange={(e) => void attach(w.key, e.target.value)}
                      className="pill"
                      style={{ background: '#eef2ff', color: '#4f46e5', fontWeight: 600, border: 'none', outline: 'none', cursor: RO ? 'not-allowed' : 'pointer', fontFamily: 'inherit' }}
                    >
                      {policies.map((p) => (
                        <option key={p.name} value={p.name}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td style={{ padding: '0 12px', textAlign: 'center' }}>
                    <Toggle
                      checked={!!w.automated}
                      disabled={RO || !w.eligible}
                      title={RO || !w.eligible ? (w.eligible ? 'Read-only' : 'Deployments only') : undefined}
                      onChange={(on) => void automate(w.key, on)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {fw.length === 0 && (
            <div style={{ padding: '40px 20px', textAlign: 'center', fontSize: 14, color: '#94a3b8' }}>
              {ws.length ? 'No workloads match your filters.' : 'No workloads with self anti-affinity blocking scale-down.'}
            </div>
          )}
        </div>
          </>
        )}
      </section>

      {/* policies management */}
      <section style={{ ...cardStyle, padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '12px 20px', borderBottom: '1px solid #eef0f6', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#1e2536' }}>Pod Scheduling Policies Management</div>
          <IndigoButton onClick={newPolicy}>
            <svg style={{ width: 14, height: 14 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path d="M12 5v14M5 12h14" />
            </svg>
            New policy
          </IndigoButton>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ ...thStyle, padding: '10px 20px' }}>Policy</th>
                <th style={thStyle}>Used by</th>
                <th style={thStyle}>Min nodes spread</th>
                <th style={thStyle}>Zone spreading</th>
                <th style={{ ...thStyle, textAlign: 'right', paddingRight: 20 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {policies.map((p) => {
                const pct = p.total ? Math.round(((p.usedBy || 0) / p.total) * 100) : 0;
                return (
                  <tr key={p.name} style={{ borderBottom: '1px solid #f1f2f7' }}>
                    <td style={{ padding: '12px 20px' }}>
                      <div style={{ fontWeight: 600, color: '#1e2536' }}>{p.name}</div>
                      <div style={{ fontSize: 11, color: '#94a3b8' }}>{p.description || ''}</div>
                    </td>
                    <td style={{ padding: '0 12px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ width: 64, height: 6, borderRadius: 4, background: '#f1f5f9', overflow: 'hidden' }}>
                          <div style={{ height: '100%', background: '#34d399', width: pct + '%' }} />
                        </div>
                        <span style={{ fontSize: 11, color: '#64748b' }}>
                          {p.usedBy || 0} of {p.total || 0}
                        </span>
                      </div>
                    </td>
                    <td className="num" style={{ padding: '0 12px', color: '#334155' }}>{p.minimumNodesSpread}</td>
                    <td style={{ padding: '0 12px' }}>
                      {p.zones ? (
                        <span className="pill" style={{ background: '#eef2ff', color: '#4f46e5' }}>
                          enabled
                        </span>
                      ) : (
                        <span style={{ color: '#cbd5e1' }}>off</span>
                      )}
                    </td>
                    <td style={{ padding: '0 12px', paddingRight: 20, textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {p.builtIn === false ? (
                        <>
                          <button
                            onClick={() => editPolicy(p)}
                            style={{ fontSize: 12, fontWeight: 600, color: '#4f46e5', background: 'none', border: 'none', cursor: 'pointer', marginRight: 8, fontFamily: 'inherit' }}
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => void deletePolicy(p.name)}
                            style={{ fontSize: 12, fontWeight: 600, color: '#f43f5e', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}
                          >
                            Delete
                          </button>
                        </>
                      ) : (
                        <span style={{ fontSize: 11, color: '#cbd5e1' }}>built-in</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <footer style={{ textAlign: 'center', fontSize: 12, color: '#94a3b8', paddingTop: 8, paddingBottom: 24 }}>
        CoolScaler · Pod Scheduling (Beta) · relaxes required self anti-affinity → preferred + topology-spread (min nodes spread);
        Deployments only · PodSchedulingPolicy CRD
      </footer>

      {/* Optimization Illustration modal (scIllusModal) */}
      <IllusModal
        open={illusOpen}
        onClose={() => setIllusOpen(false)}
        description="Compare your nodes with the optimized placement after relaxing self anti-affinity (required → preferred + topology spread), keeping a minimum node spread."
        beforeTitle={<>{nodes} current nodes</>}
        afterTitle={
          <>
            {optimized} optimized nodes · {relaxed} pods relaxed
          </>
        }
        before={
          nodes ? (
            Array.from({ length: nodes }, (_, i) => <IllusBox key={i} variant={i < blocked ? 'blocked' : 'ok'} label="•" />)
          ) : (
            <div style={{ fontSize: 11, color: '#94a3b8' }}>No nodes</div>
          )
        }
        after={
          nodes ? (
            Array.from({ length: nodes }, (_, i) => (
              <IllusBox key={i} variant={i < freed ? 'freed' : 'ok'} label={i < freed ? '—' : '•'} />
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

      {/* Policy editor modal (scPolModal) */}
      {polModal && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 50,
            display: 'grid',
            placeItems: 'center',
            background: 'rgba(0,0,0,.4)',
            padding: 16,
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) setPolModal(null);
          }}
        >
          <div style={{ background: '#fff', borderRadius: 16, boxShadow: '0 25px 50px -12px rgba(0,0,0,.25)', width: '100%', maxWidth: 448, padding: 24 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#1e2536', marginBottom: 16 }}>
              {polModal.edit ? 'Edit ' + polModal.edit : 'New scheduling policy'}
            </div>
            <label style={{ display: 'block', fontSize: 12, color: '#64748b', marginBottom: 4 }}>Policy name</label>
            <input
              value={polName}
              disabled={!!polModal.edit}
              onChange={(e) => setPolName(e.target.value)}
              placeholder="e.g. spread-3"
              style={{ ...inputStyle, marginBottom: 12, background: polModal.edit ? '#f8fafc' : '#fff' }}
            />
            <label style={{ display: 'block', fontSize: 12, color: '#64748b', marginBottom: 4 }}>Minimum nodes spread</label>
            <input
              type="number"
              min={1}
              value={polSpread}
              onChange={(e) => setPolSpread(e.target.value)}
              className="num"
              style={{ ...inputStyle, marginBottom: 12 }}
            />
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#475569', marginBottom: 12, cursor: 'pointer' }}>
              <input type="checkbox" checked={polZones} onChange={(e) => setPolZones(e.target.checked)} /> Enhance availability across zones
            </label>
            {/* PodSchedulingPolicy YAML preview */}
            <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>PodSchedulingPolicy YAML</div>
            <pre
              style={{
                margin: '0 0 16px',
                padding: 10,
                background: '#0f172a',
                color: '#e2e8f0',
                borderRadius: 8,
                fontSize: 11,
                lineHeight: 1.5,
                overflowX: 'auto',
                fontFamily: '"JetBrains Mono", ui-monospace, monospace',
              }}
            >{`apiVersion: analysis.coolscaler.sh/v1alpha1
kind: PodSchedulingPolicy
metadata:
  name: ${polName || 'my-policy'}
  namespace: coolscaler-system
spec:
  selfAntiAffinityOptimization:
    enabled: true
    minimumNodesSpread: ${Math.max(1, +polSpread || 2)}
    enhanceAvailabilityOnDifferentZones: ${polZones}`}</pre>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                onClick={() => setPolModal(null)}
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  borderRadius: 8,
                  padding: '8px 12px',
                  border: '1px solid #e2e8f0',
                  color: '#475569',
                  background: '#fff',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => void savePolicy()}
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  borderRadius: 8,
                  padding: '8px 16px',
                  border: 'none',
                  background: '#4f46e5',
                  color: '#fff',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                Save policy
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
