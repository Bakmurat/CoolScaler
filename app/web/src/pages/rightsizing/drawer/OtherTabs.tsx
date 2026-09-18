// Remaining drawer tabs: Pods / Events / Network / APIs / YAMLs / Spot / Java /
// GPU / Replicas
import { useEffect, useMemo, useState } from 'react';
import { getJson, postJson } from '../../../api/client';
import { useFeedback } from '../../../providers/FeedbackProvider';
import { usd, cpuFmt, memFmt } from '../../../lib/format';
import { relTime, tlAge, yamlDump, type DrawerTarget } from '../lib';
import { Toggle } from '../ui';
import type {
  ApisResponse,
  NetworkResponse,
  RecommendationDetail,
  ReplicasOpt,
  SchedulingOpt,
  WorkloadYamlResponse,
} from '../types';

const pad20: React.CSSProperties = { padding: '16px 20px' };
const emptyMsg: React.CSSProperties = { padding: '32px 20px', textAlign: 'center', fontSize: 14, color: '#94a3b8' };

// ===================== Pods =====================
export function PodsTab({ data }: { data: RecommendationDetail }) {
  const [q, setQ] = useState('');
  const pi = data.podInfo || [];
  if (!pi.length) return <div style={emptyMsg}>No running pods.</div>;
  const rows = pi.filter((p) => !q || (p.name || '').toLowerCase().includes(q.toLowerCase()));
  const u = (v: number | null | undefined, f: (x?: number | null) => string) =>
    v == null ? (
      <span title="metrics-server has no sample for this pod yet" style={{ color: '#cbd5e1' }}>???</span>
    ) : (
      f(v)
    );
  const qosPill = (qos?: string) =>
    qos ? (
      <span
        className="pill"
        style={
          qos === 'Guaranteed'
            ? { background: '#ecfdf5', color: '#059669' }
            : qos === 'Burstable'
              ? { background: '#f0f9ff', color: '#0284c7' }
              : { background: '#f1f5f9', color: '#64748b' }
        }
      >
        {qos}
      </span>
    ) : (
      <span style={{ color: '#cbd5e1' }}>—</span>
    );
  return (
    <div style={{ ...pad20, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search pods…"
          style={{ background: '#f4f5f8', border: '1px solid #e9eaf0', borderRadius: 8, padding: '6px 12px', fontSize: 12, width: 224, outline: 'none', fontFamily: 'inherit' }}
        />
        <span style={{ fontSize: 11, color: '#94a3b8' }}>{rows.length} pods</span>
      </div>
      <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ color: '#94a3b8', fontSize: 10, textTransform: 'uppercase' }}>
            <th style={{ textAlign: 'left', paddingBottom: 8 }}>Pod</th>
            <th style={{ textAlign: 'left' }}>Node</th>
            <th style={{ textAlign: 'left' }}>QoS</th>
            <th style={{ textAlign: 'left' }}>Phase</th>
            <th style={{ textAlign: 'right' }}>CPU req</th>
            <th style={{ textAlign: 'right' }}>Mem req</th>
            <th style={{ textAlign: 'right' }}>CPU use</th>
            <th style={{ textAlign: 'right' }}>Mem use</th>
            <th style={{ textAlign: 'center' }}>Restarts</th>
            <th style={{ textAlign: 'center' }}>Age</th>
            <th style={{ textAlign: 'center' }}>Ready</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.name} style={{ borderTop: '1px solid #f1f2f7' }}>
              <td style={{ padding: '6px 0', fontWeight: 500, color: '#475569', maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {p.name}
                {!!p.oom && <span className="pill" style={{ background: '#fff1f2', color: '#e11d48', marginLeft: 4 }}>OOM</span>}
                {p.crashloop && <span className="pill" style={{ background: '#fff1f2', color: '#e11d48', marginLeft: 4 }}>CrashLoop</span>}
              </td>
              <td style={{ color: '#94a3b8', maxWidth: 110, overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.node || '—'}</td>
              <td>{qosPill(p.qos)}</td>
              <td style={{ color: p.phase === 'Running' ? '#64748b' : '#d97706', fontWeight: p.phase === 'Running' ? 400 : 500 }}>{p.phase || '—'}</td>
              <td className="num" style={{ textAlign: 'right', color: '#64748b' }}>{cpuFmt(p.reqCpu || 0)}</td>
              <td className="num" style={{ textAlign: 'right', color: '#64748b' }}>{memFmt(p.reqMem || 0)}</td>
              <td className="num" style={{ textAlign: 'right', color: '#475569' }}>{u(p.useCpu, cpuFmt)}</td>
              <td className="num" style={{ textAlign: 'right', color: '#475569' }}>{u(p.useMem, memFmt)}</td>
              <td style={{ textAlign: 'center', color: p.restarts > 5 ? '#f43f5e' : '#64748b', fontWeight: p.restarts > 5 ? 600 : 400 }}>{p.restarts}</td>
              <td style={{ textAlign: 'center', color: '#94a3b8', fontSize: 11 }}>{p.startTime ? relTime(p.startTime) : '—'}</td>
              <td style={{ textAlign: 'center' }}>{p.ready ? <span style={{ color: '#10b981' }}>✓</span> : <span style={{ color: '#f59e0b' }}>…</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ===================== Events (chronological log + type filter) =====================
function tlColor(t: string): string {
  return (
    ({
      Automated: '#34d399',
      'Burst reaction': '#a78bfa',
      'Auto-healing': '#6ee7b7',
      'Boot-time optimization': '#84cc16',
      'In-place optimization': '#22d3ee',
      'Out-of-Memory': '#ef4444',
      CrashLoopBackOff: '#dc2626',
      'Frequent restarts': '#dc2626',
      'CPU throttling': '#b45309',
      'Liveness probe failures': '#f59e0b',
      'Under-provisioned': '#f59e0b',
      'Disk eviction': '#e11d48',
    }) as Record<string, string>
  )[t] || '#94a3b8';
}

/** GET /api/workload-events — native k8s events (new backend). */
interface K8sEvent {
  type?: string;
  reason?: string;
  message?: string;
  object?: string;
  count?: number;
  firstSeen?: string;
  lastSeen?: string;
  source?: string;
}

export function EventsTab({ data, target }: { data: RecommendationDetail; target: DrawerTarget }) {
  const [events, setEvents] = useState<K8sEvent[] | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'legacy'>('loading');
  const [typeFilter, setTypeFilter] = useState<string | null>(null);

  useEffect(() => {
    let dead = false;
    const enc = encodeURIComponent;
    getJson<{ events?: K8sEvent[] }>(
      `/api/workload-events?namespace=${enc(target.namespace)}&kind=${enc(target.kind)}&name=${enc(target.name)}`,
    )
      .then((r) => {
        if (dead) return;
        if (r && Array.isArray(r.events)) {
          setEvents(r.events);
          setState('ok');
        } else setState('legacy');
      })
      .catch(() => !dead && setState('legacy')); // endpoint not deployed yet → platform-events fallback
    return () => {
      dead = true;
    };
  }, [target]);

  if (state === 'loading') return <div style={emptyMsg}>Loading events…</div>;
  if (state === 'legacy') return <LegacyEventsView data={data} />;

  const ev = (events || [])
    .slice()
    .sort((a, b) => new Date(b.lastSeen || 0).getTime() - new Date(a.lastSeen || 0).getTime());
  const counts: Record<string, number> = {};
  ev.forEach((e) => {
    const t = e.type || 'Normal';
    counts[t] = (counts[t] || 0) + 1;
  });
  const list = typeFilter ? ev.filter((e) => (e.type || 'Normal') === typeFilter) : ev;
  const chipStyle = (on: boolean): React.CSSProperties => ({
    background: on ? '#eef2ff' : '#f1f5f9',
    color: on ? '#4f46e5' : '#64748b',
    border: 'none',
    cursor: 'pointer',
    fontFamily: 'inherit',
  });
  const typeDot = (t?: string) => (
    <span
      style={{
        display: 'inline-block',
        height: 6,
        width: 6,
        borderRadius: '50%',
        marginRight: 4,
        background: t === 'Warning' ? '#f59e0b' : '#34d399',
      }}
    />
  );
  const when = (iso?: string) => (iso ? relTime(iso) : '—');
  const evTh: React.CSSProperties = { textAlign: 'left', paddingBottom: 8, whiteSpace: 'nowrap' };
  return (
    <div style={{ ...pad20, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        <button className="pill" style={chipStyle(typeFilter === null)} onClick={() => setTypeFilter(null)}>
          All ({ev.length})
        </button>
        {['Normal', 'Warning'].map((t) => (
          <button key={t} className="pill" style={chipStyle(typeFilter === t)} onClick={() => setTypeFilter(t)}>
            {typeDot(t)}
            {t} ({counts[t] || 0})
          </button>
        ))}
      </div>
      {!list.length ? (
        <div style={emptyMsg}>No events for this workload.</div>
      ) : (
        <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ color: '#94a3b8', fontSize: 10, textTransform: 'uppercase' }}>
              <th style={evTh}>Type</th>
              <th style={evTh}>Reason</th>
              <th style={evTh}>Object</th>
              <th style={evTh}>Message</th>
              <th style={{ ...evTh, textAlign: 'right' }}>Count</th>
              <th style={{ ...evTh, textAlign: 'right' }}>First seen</th>
              <th style={{ ...evTh, textAlign: 'right' }}>Last seen</th>
            </tr>
          </thead>
          <tbody>
            {list.map((e, i) => (
              <tr key={i} style={{ borderTop: '1px solid #f1f2f7' }}>
                <td style={{ padding: '6px 0', fontWeight: 600, color: e.type === 'Warning' ? '#d97706' : '#475569', whiteSpace: 'nowrap' }}>
                  {typeDot(e.type)}
                  {e.type || 'Normal'}
                </td>
                <td style={{ color: '#475569', fontWeight: 500, whiteSpace: 'nowrap', paddingRight: 8 }}>{e.reason || '—'}</td>
                <td style={{ color: '#64748b', maxWidth: 170, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', paddingRight: 8 }} title={e.object}>
                  {e.object || '—'}
                </td>
                <td style={{ color: '#64748b', paddingRight: 8 }} title={e.source ? 'source: ' + e.source : undefined}>
                  {e.message || ''}
                </td>
                <td className="num" style={{ textAlign: 'right', color: '#475569' }}>{e.count ?? 1}</td>
                <td style={{ textAlign: 'right', color: '#94a3b8', whiteSpace: 'nowrap' }} title={e.firstSeen}>{when(e.firstSeen)}</td>
                <td style={{ textAlign: 'right', color: '#94a3b8', whiteSpace: 'nowrap' }} title={e.lastSeen}>{when(e.lastSeen)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** Fallback until /api/workload-events is deployed — platform-events timeline. */
function LegacyEventsView({ data }: { data: RecommendationDetail }) {
  const [filter, setFilter] = useState<string | null>(null);
  const ev = useMemo(() => (data.events || []).slice().sort((a, b) => (a.ageMin || 0) - (b.ageMin || 0)), [data]);
  if (!ev.length)
    return <div style={emptyMsg}>No platform events for this workload in the selected window.</div>;
  const types = [...new Set(ev.map((e) => e.type))];
  const list = filter ? ev.filter((e) => e.type === filter) : ev;
  const chipStyle = (on: boolean): React.CSSProperties => ({
    background: on ? '#eef2ff' : '#f1f5f9',
    color: on ? '#4f46e5' : '#64748b',
    border: 'none',
    cursor: 'pointer',
    fontFamily: 'inherit',
  });
  return (
    <div style={{ ...pad20, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        <button className="pill" style={chipStyle(filter === null)} onClick={() => setFilter(null)}>
          All ({ev.length})
        </button>
        {types.map((t) => (
          <button key={t} className="pill" style={chipStyle(filter === t)} onClick={() => setFilter(t)}>
            <span style={{ display: 'inline-block', height: 6, width: 6, borderRadius: '50%', marginRight: 4, background: tlColor(t) }} />
            {t}
          </button>
        ))}
      </div>
      <div style={{ position: 'relative', paddingLeft: 16, borderLeft: '2px solid #eef0f5', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {list.length ? (
          list.map((e, i) => {
            const lvl = ({ critical: '#e11d48', warn: '#d97706', info: '#475569' } as Record<string, string>)[e.level || 'info'] || '#475569';
            return (
              <div key={i} style={{ position: 'relative' }}>
                <span style={{ position: 'absolute', left: -21, top: 4, height: 10, width: 10, borderRadius: '50%', boxShadow: '0 0 0 2px #fff', background: tlColor(e.type) }} />
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: lvl }}>{e.type}</span>
                  <span className="num" style={{ fontSize: 11, color: '#94a3b8' }}>{tlAge(e.ageMin)}</span>
                </div>
                <div style={{ fontSize: 12, color: '#64748b' }}>{e.message || ''}</div>
              </div>
            );
          })
        ) : (
          <div style={{ fontSize: 14, color: '#94a3b8', padding: '16px 0' }}>No events of this type.</div>
        )}
      </div>
    </div>
  );
}

// ===================== Network =====================
export function NetworkTab({ target }: { target: DrawerTarget }) {
  const [d, setD] = useState<NetworkResponse | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let dead = false;
    const enc = encodeURIComponent;
    getJson<NetworkResponse>(`/api/network/${enc(target.namespace)}/${enc(target.kind)}/${enc(target.name)}`)
      .then((r) => !dead && setD(r))
      .catch(() => !dead && setFailed(true));
    return () => {
      dead = true;
    };
  }, [target]);
  if (failed) return <div style={emptyMsg}>Network data unavailable.</div>;
  if (!d) return <div style={emptyMsg}>Loading network traffic…</div>;
  if (d.found === false) return <div style={emptyMsg}>No network data.</div>;
  const T = d.totals || {};
  const Bps = (v?: number) => {
    v = v || 0;
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (v >= 1024 && i < 3) {
      v /= 1024;
      i++;
    }
    return Math.round(v * 10) / 10 + ' ' + u[i] + '/s';
  };
  const s = d.series || [];
  const W = 560,
    H = 70,
    p = 4;
  const maxv = Math.max(1, ...s.map((x) => Math.max(x.in || 0, x.out || 0)));
  const x = (i: number) => p + (i * (W - 2 * p)) / Math.max(1, s.length - 1);
  const y = (v: number) => H - p - (v / maxv) * (H - 2 * p);
  const path = (k: 'in' | 'out') => s.map((pt, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(pt[k] || 0).toFixed(1)}`).join(' ');
  const statCard = (label: string, value: React.ReactNode, sub: string, color: string) => (
    <div className="card" style={{ padding: 12 }}>
      <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '.04em', color: '#94a3b8', fontWeight: 700 }}>{label}</div>
      <div className="num" style={{ fontSize: 16, fontWeight: 700, color, marginTop: 4 }}>{value}</div>
      <div style={{ fontSize: 9, color: '#94a3b8' }}>{sub}</div>
    </div>
  );
  return (
    <div style={pad20}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 12 }}>
        {statCard('Ingress', Bps(T.ingressBps), 'cAdvisor rx bytes', '#2563eb')}
        {statCard('Egress', Bps(T.egressBps), 'cAdvisor tx bytes', '#7c3aed')}
        {statCard('Cross-AZ / mo', '–', 'no flow-attribution source', '#94a3b8')}
      </div>
      {s.length > 1 && (
        <div className="card" style={{ padding: 12, marginBottom: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#64748b', marginBottom: 4 }}>Throughput (last hour) — real cAdvisor</div>
          <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 80 }}>
            <path d={path('in')} fill="none" stroke="#3b82f6" strokeWidth={1.6} />
            <path d={path('out')} fill="none" stroke="#8b5cf6" strokeWidth={1.6} />
          </svg>
          <div style={{ display: 'flex', gap: 12, fontSize: 10, color: '#94a3b8' }}>
            <span><span style={{ display: 'inline-block', width: 8, height: 2, background: '#3b82f6', verticalAlign: 'middle' }} /> ingress</span>
            <span><span style={{ display: 'inline-block', width: 8, height: 2, background: '#8b5cf6', verticalAlign: 'middle' }} /> egress</span>
          </div>
        </div>
      )}
      <div className="card" style={{ padding: 16, textAlign: 'center' }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#64748b' }}>
          Per-peer topology, direction &amp; cross-AZ cost
        </div>
        <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>
          No data available. Inter-pod flow data requires an eBPF network agent, which CoolScaler does not run. Only pod-total
          ingress/egress (above) is real.
        </div>
      </div>
    </div>
  );
}

// ===================== APIs =====================
export function ApisTab({ target }: { target: DrawerTarget }) {
  const [d, setD] = useState<ApisResponse | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let dead = false;
    const enc = encodeURIComponent;
    getJson<ApisResponse>(`/api/apis/${enc(target.namespace)}/${enc(target.kind)}/${enc(target.name)}`)
      .then((r) => !dead && setD(r))
      .catch(() => !dead && setFailed(true));
    return () => {
      dead = true;
    };
  }, [target]);
  if (failed) return <div style={emptyMsg}>API data unavailable.</div>;
  if (!d) return <div style={emptyMsg}>Loading API observability…</div>;
  if (d.found === false) return <div style={emptyMsg}>No API data.</div>;
  if (!d.available)
    return (
      <div style={pad20}>
        <div className="card" style={{ padding: 24, textAlign: 'center' }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#64748b' }}>L7 / HTTP API metrics</div>
          <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 8, maxWidth: 460, margin: '8px auto 0' }}>
            Per-endpoint request rate, error rate and latency come from app-exposed <code>http_requests_total</code> /{' '}
            <code>http_latency_ms_bucket</code> (Prometheus client metrics via a ServiceMonitor). CoolScaler's bundled Prometheus scrapes only
            cAdvisor, kube-state-metrics and node-exporter, so no real L7 data is available — nothing is fabricated here.
          </div>
        </div>
      </div>
    );
  const T = d.totals || {};
  return (
    <div style={pad20}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 12 }}>
        <div className="card" style={{ padding: 12 }}>
          <div style={{ fontSize: 10, textTransform: 'uppercase', color: '#94a3b8', fontWeight: 700 }}>Total RPS</div>
          <div className="num" style={{ fontSize: 16, fontWeight: 700, color: '#1e2536', marginTop: 4 }}>{T.rps || 0}</div>
        </div>
        <div className="card" style={{ padding: 12 }}>
          <div style={{ fontSize: 10, textTransform: 'uppercase', color: '#94a3b8', fontWeight: 700 }}>Error rate</div>
          <div className="num" style={{ fontSize: 16, fontWeight: 700, color: (T.errorRate || 0) > 1 ? '#e11d48' : '#059669', marginTop: 4 }}>
            {T.errorRate || 0}%
          </div>
        </div>
        <div className="card" style={{ padding: 12 }}>
          <div style={{ fontSize: 10, textTransform: 'uppercase', color: '#94a3b8', fontWeight: 700 }}>Latency p99</div>
          <div className="num" style={{ fontSize: 16, fontWeight: 700, color: '#1e2536', marginTop: 4 }}>{T.p99 || 0}ms</div>
        </div>
      </div>
      <div style={{ fontSize: 10, color: '#94a3b8' }}>Application HTTP metrics (http_requests_total / http_latency_ms_bucket).</div>
    </div>
  );
}

// ===================== YAMLs =====================
export function YamlTab({ data, target }: { data: RecommendationDetail; target: DrawerTarget }) {
  const [sub, setSub] = useState<'workload' | 'hpa' | 'scaledObject' | 'pdb' | 'limitRange' | 'resourceQuota' | 'rec'>('workload');
  const [y, setY] = useState<Record<string, string>>({ workload: '# loading…', hpa: '', pdb: '', scaledObject: '', limitRange: '', resourceQuota: '', rec: '' });
  useEffect(() => {
    let dead = false;
    const rec = yamlDump({
      apiVersion: data.apiVersion || 'analysis.coolscaler.sh/v1alpha1',
      kind: 'Recommendation',
      metadata: { name: data.crName, namespace: target.namespace },
      spec: data.spec || {},
      status: data.status || {},
    });
    const enc = encodeURIComponent;
    getJson<WorkloadYamlResponse>(`/api/workload-yaml/${enc(target.namespace)}/${enc(target.kind)}/${enc(target.name)}`)
      .then((j) => {
        if (dead) return;
        setY({
          workload: j.workload ? yamlDump(j.workload) : '# ??? — workload object not found',
          hpa: j.hpa ? yamlDump(j.hpa) : '',
          pdb: j.pdb ? yamlDump(j.pdb) : '',
          scaledObject: j.scaledObject ? yamlDump(j.scaledObject) : '',
          limitRange: j.limitRange ? yamlDump(j.limitRange) : '',
          resourceQuota: j.resourceQuota ? yamlDump(j.resourceQuota) : '',
          rec,
        });
      })
      .catch(() => !dead && setY((p) => ({ ...p, workload: '# ??? — failed to load workload YAML', rec })));
    return () => {
      dead = true;
    };
  }, [data, target]);
  const tabs: [typeof sub, string][] = [
    ['workload', 'Workload YAML'],
    ['hpa', 'HPA YAML'],
    ['scaledObject', 'ScaledObject YAML'],
    ['pdb', 'PDB YAML'],
    ['limitRange', 'Limit Range YAML'],
    ['resourceQuota', 'Resource Quota YAML'],
    ['rec', 'Recommendation'],
  ];
  return (
    <div style={pad20}>
      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid #e9eaf0', marginBottom: 12, flexWrap: 'wrap' }}>
        {tabs.map(([k, l]) => (
          <button
            key={k}
            onClick={() => setSub(k)}
            style={{
              padding: '6px 12px',
              fontSize: 12,
              fontWeight: 600,
              border: 'none',
              background: 'transparent',
              borderBottom: sub === k ? '2px solid #6366f1' : '2px solid transparent',
              color: sub === k ? '#4f46e5' : '#94a3b8',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {l}
          </button>
        ))}
      </div>
      <pre
        className="num"
        style={{
          fontSize: 11,
          background: '#1e2233',
          color: '#e2e8f0',
          borderRadius: 8,
          padding: 12,
          overflowX: 'auto',
          whiteSpace: 'pre-wrap',
          maxHeight: '62vh',
          margin: 0,
        }}
      >
        {y[sub] || ''}
      </pre>
    </div>
  );
}

// ===================== Spot =====================
export function SpotTab({ data }: { data: RecommendationDetail }) {
  const elig = data.spotEligible;
  const badge =
    elig === true ? (
      <span className="pill" style={{ background: '#ecfdf5', color: '#059669', border: '1px solid #a7f3d0' }}>Spot-eligible</span>
    ) : elig === false ? (
      <span className="pill" style={{ background: '#fffbeb', color: '#d97706', border: '1px solid #fde68a' }}>Not spot-eligible</span>
    ) : (
      <span className="pill" style={{ background: '#f1f5f9', color: '#64748b' }}>???</span>
    );
  return (
    <div style={{ ...pad20, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="card" style={{ padding: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: '#1e2536' }}>
            Spot readiness <span className="pill" style={{ background: '#eef2ff', color: '#818cf8' }}>Beta</span>
          </span>
          {badge}
        </div>
        {elig === false && (
          <div style={{ fontSize: 12, color: '#64748b', marginTop: 8 }}>
            Blocked from eviction (PDB / unevictable annotation / single-replica), so it can't be safely moved to a spot node. See the Pod
            Placement page for the exact blocker.
          </div>
        )}
        <div style={{ fontSize: 12, color: '#64748b', marginTop: 12 }}>
          Target spot %, fallback-to-on-demand and min-on-demand replicas are configured per <b>SpotPolicy</b>. Realized spot/on-demand
          placement is shown cluster-wide on the Pod Placement page.
        </div>
        <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 8 }}>
          Per-workload spot savings $ ??? — requires a cloud spot-price feed CoolScaler isn't wired to.
        </div>
      </div>
    </div>
  );
}

// ===================== Java =====================
export function JavaTab({ data }: { data: RecommendationDetail }) {
  const j = data.javaJvm;
  const mib = (b?: number | null) => (b || b === 0 ? ((b as number) / 1048576).toFixed((b as number) < 104857600 ? 1 : 0) + ' MiB' : '???');
  if (j && j.realUsage) {
    const card = (lbl: string, val: string, sub?: string) => (
      <div style={{ borderRadius: 8, border: '1px solid #eceef4', background: '#fff', padding: '10px 12px' }}>
        <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '.04em', color: '#94a3b8' }}>{lbl}</div>
        <div className="num" style={{ fontSize: 15, fontWeight: 700, color: '#1e2536' }}>{val}</div>
        {sub && <div style={{ fontSize: 10, color: '#94a3b8' }}>{sub}</div>}
      </div>
    );
    return (
      <div style={{ ...pad20, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: '#1e2536' }}>Real JVM memory (live)</span>
          <span className="pill" style={{ background: '#ecfdf5', color: '#059669', border: '1px solid #a7f3d0' }}>JMX observability active</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
          {card('Heap used (p90)', mib(j.heapUsedP90), 'live working set')}
          {card('Heap used (max)', mib(j.heapUsedMax))}
          {card('Non-heap used', mib(j.nonHeapUsed), 'metaspace/threads/code')}
          {card('Heap committed', mib(j.heapCommitted))}
          {card('Current -Xmx', mib(j.jvmXmx), 'JVM-reported')}
          {card('Recommended -Xmx', mib(j.recommendedXmx), 'from real heap +10%')}
          {card('GC time', j.gcSecondsRate != null ? j.gcSecondsRate.toFixed(4) + ' s/s' : '???')}
          {card('Mem rec', mib(j.memRec), 'real heap + non-heap + headroom')}
        </div>
        <div className="card" style={{ padding: 12 }}>
          <div style={{ fontSize: 12, color: '#475569' }}>
            Memory request <b className="num">{mib(j.memRequest)}</b> → recommendation{' '}
            <b className="num" style={{ color: '#059669' }}>{mib(j.memRec)}</b> — computed from the <b>JVM working set</b> (heap p90 +
            non-heap), not container RSS. Optimized <code>-Xmx</code> <b className="num">{mib(j.recommendedXmx)}</b>. Status: <b>{j.status}</b>.
          </div>
          <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 8 }}>
            Source: injected <code>jmx_prometheus_javaagent</code> on :9404, scraped by the bundled Prometheus (
            <code>java_lang_Memory_*</code>). The <code>java</code> policy floors memory at the JVM ceiling so right-sizing never OOM-kills.
          </div>
        </div>
      </div>
    );
  }
  const inj = j && j.observability;
  return (
    <div style={{ ...pad20, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="card" style={{ padding: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: '#1e2536' }}>Java workload detected</span>
          <span className="pill" style={{ background: '#fff7ed', color: '#ea580c', border: '1px solid #fed7aa' }}>JVM-aware</span>
        </div>
        <div style={{ fontSize: 12, color: '#64748b' }}>
          Memory recommendations for this workload are <b>floored at the JVM ceiling</b> (Xmx + non-heap reserve) so right-sizing never
          triggers an OOM-kill — the <code>java</code> policy behaviour.
        </div>
        <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 12 }}>
          Live JVM heap/GC metrics <b>???</b> —{' '}
          {inj
            ? 'the JMX agent is injected; waiting for the first scrape (rollout the pod if it predates injection).'
            : 'JMX observability is not enabled for this workload.'}{' '}
          Enable/manage it on the Java page.
        </div>
      </div>
    </div>
  );
}

// ===================== GPU =====================
export function GpuTab({ data }: { data: RecommendationDetail }) {
  const g = data.gpuReq || 0;
  if (!g)
    return (
      <div style={emptyMsg}>
        No GPU resources requested by this workload.
        <div style={{ fontSize: 11, marginTop: 4 }}>
          (no <span className="num">nvidia.com/gpu</span> in any container)
        </div>
      </div>
    );
  return (
    <div style={{ ...pad20, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="card" style={{ padding: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: '#1e2536' }}>GPU request</span>
          <span className="num" style={{ fontWeight: 700, color: '#1e2536' }}>{g} GPU</span>
        </div>
        <div style={{ fontSize: 12, color: '#64748b' }}>
          GPU compute/memory rightsizing is governed by <b>GpuPolicy</b> / <b>GpuMemoryPolicy</b>.
        </div>
        <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 8 }}>
          GPU utilization &amp; VRAM usage <b>???</b> — require DCGM/MPS metrics (no GPU nodes / no DCGM exporter on this cluster).
        </div>
      </div>
    </div>
  );
}

// ===================== Replicas =====================
export function ReplicasTab({
  r,
  target,
  ro,
  onReload,
}: {
  r: ReplicasOpt;
  target: DrawerTarget;
  ro: boolean;
  onReload: () => void;
}) {
  const { toast, confirm } = useFeedback();
  const arrow = (a?: number | null, b?: number | null) => {
    if (a == null || b == null) return <span style={{ color: '#cbd5e1' }}>—</span>;
    const color = b < a ? '#16a34a' : b > a ? '#e11d48' : '#94a3b8';
    const ar = b < a ? '↓' : b > a ? '↑' : '→';
    return (
      <>
        <span style={{ color: '#94a3b8' }}>{a}</span> <span style={{ color, fontWeight: 700 }}>{ar}</span>{' '}
        <span style={{ color, fontWeight: 700 }}>{b}</span>
      </>
    );
  };
  const mc = r.monthlyCost || 0;
  const oc = r.optimizedCost != null ? r.optimizedCost : mc;
  const mx = Math.max(mc, oc, 0.01);
  const tr = r.trend || [];
  const W = 300,
    H = 64,
    p = 4;
  const maxv = Math.max(r.maxReplicas || 0, r.origMin || 0, ...tr, 1);
  const x = (i: number) => p + (i * (W - 2 * p)) / Math.max(1, tr.length - 1);
  const y = (v: number) => H - p - (v / maxv) * (H - 2 * p);
  const line = tr.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const canOpt = !ro && (r.recMin || 0) < (r.origMin || 0);
  return (
    <div style={{ ...pad20, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="card" style={{ padding: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 11, color: '#94a3b8' }}>Policy</span>
            {(r.policies || []).length ? (
              <select
                className="pill"
                defaultValue={r.policyName}
                onChange={async (e) => {
                  await postJson('/api/replicas-attach-policy', { namespace: target.namespace, kind: target.kind, name: target.name, policy: e.target.value }).catch(() => {});
                  toast('Replicas policy → ' + e.target.value);
                  onReload();
                }}
                style={{ background: '#eef2ff', color: '#4f46e5', fontWeight: 600, border: 'none', outline: 'none', cursor: 'pointer', fontFamily: 'inherit' }}
              >
                {(r.policies || []).map((pn) => (
                  <option key={pn}>{pn}</option>
                ))}
              </select>
            ) : (
              <span className="pill" style={{ background: '#eef2ff', color: '#4f46e5' }}>{r.policyName}</span>
            )}
          </div>
          {r.predictable ? (
            <span className="pill" style={{ background: '#eef2ff', color: '#4f46e5' }}>predictable</span>
          ) : (
            <span className="pill" style={{ background: '#f1f5f9', color: '#94a3b8' }}>static</span>
          )}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 8, rowGap: 4, alignItems: 'center', fontSize: 11, marginBottom: 8 }}>
          <span style={{ color: '#94a3b8', width: 64 }}>Current</span>
          <div style={{ height: 12, borderRadius: 4, background: '#e0e7ff' }}>
            <div style={{ height: 12, borderRadius: 4, background: '#818cf8', width: Math.round((mc / mx) * 100) + '%' }} />
          </div>
          <span style={{ color: '#94a3b8', width: 64 }}>Optimized</span>
          <div style={{ height: 12, borderRadius: 4, background: '#f0fdf4' }}>
            <div style={{ height: 12, borderRadius: 4, background: '#22c55e', width: Math.round((oc / mx) * 100) + '%' }} />
          </div>
          <span />
          <div style={{ fontSize: 10, color: '#94a3b8' }}>
            Current {usd(mc)} → Optimized <span style={{ color: '#16a34a', fontWeight: 600 }}>{usd(oc)}</span> /mo
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div style={{ borderRadius: 8, border: '1px solid #eef0f5', padding: 10 }}>
            <div style={{ fontSize: 10, textTransform: 'uppercase', color: '#94a3b8', fontWeight: 700 }}>Min replicas</div>
            <div className="num" style={{ fontSize: 15, fontWeight: 700, marginTop: 4 }}>{arrow(r.origMin, r.recMin)}</div>
          </div>
          <div style={{ borderRadius: 8, border: '1px solid #eef0f5', padding: 10 }}>
            <div style={{ fontSize: 10, textTransform: 'uppercase', color: '#94a3b8', fontWeight: 700 }}>CPU threshold</div>
            <div className="num" style={{ fontSize: 15, fontWeight: 700, marginTop: 4 }}>
              {r.curThreshold != null ? <>{arrow(r.curThreshold, r.recThreshold)}%</> : <span style={{ color: '#cbd5e1' }}>— ({r.triggerType} metric)</span>}
            </div>
          </div>
        </div>
        <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 8 }}>
          max replicas {r.maxReplicas ?? '∞'} · trigger {r.triggerType} · keeps scale triggers intact
        </div>
        {(r.savings || 0) > 0.5 && (
          <div style={{ fontSize: 12, color: '#16a34a', fontWeight: 600, marginTop: 4 }}>
            Monthly savings {usd(r.savings)} from lowering always-on replicas
          </div>
        )}
        {tr.length >= 2 && (
          <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid #f1f2f7' }}>
            <div style={{ fontSize: 10, textTransform: 'uppercase', color: '#94a3b8', fontWeight: 700, marginBottom: 4 }}>
              Replicas by CPU vs optimized
            </div>
            <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 64 }}>
              <line x1={p} y1={y(r.origMin || 0)} x2={W - p} y2={y(r.origMin || 0)} stroke="#c7d2fe" strokeWidth={1.5} />
              <line x1={p} y1={y(r.recMin || 0)} x2={W - p} y2={y(r.recMin || 0)} stroke="#22c55e" strokeWidth={1.5} strokeDasharray="4 3" />
              <path d={line} fill="none" stroke="#6366f1" strokeWidth={1.6} />
            </svg>
            <div style={{ display: 'flex', gap: 12, fontSize: 10, color: '#94a3b8', marginTop: 2 }}>
              <span><span style={{ display: 'inline-block', width: 8, height: 2, background: '#6366f1', verticalAlign: 'middle' }} /> replicas by CPU</span>
              <span><span style={{ display: 'inline-block', width: 8, height: 2, background: '#c7d2fe', verticalAlign: 'middle' }} /> current min {r.origMin}</span>
              <span><span style={{ display: 'inline-block', width: 8, height: 2, background: '#22c55e', verticalAlign: 'middle' }} /> optimized min {r.recMin}</span>
            </div>
          </div>
        )}
      </div>
      <div className="card" style={{ padding: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 12, color: '#475569' }}>
          Automate replicas optimization
          <div style={{ fontSize: 11, color: '#94a3b8' }}>
            manages HPA <code>.spec.minReplicas</code> {r.triggerType === 'KEDA' ? '(KEDA minReplicaCount)' : ''}
          </div>
        </div>
        <Toggle
          checked={!!r.automated}
          disabled={ro}
          title={ro ? 'Read-only' : ''}
          onChange={async (on) => {
            await postJson('/api/replicas-automate', { key: `${target.namespace}/${target.kind}/${target.name}`, enabled: on }).catch(() => {});
            onReload();
          }}
        />
      </div>
      <button
        disabled={!canOpt}
        onClick={async () => {
          if (ro) {
            toast('Cluster is in READ-ONLY mode.');
            return;
          }
          if (!(await confirm(`Optimize minReplicas / CPU threshold for ${target.namespace}/${target.name}?\n\nThe scale triggers stay intact.`)))
            return;
          try {
            const j = await postJson<{ ok?: boolean; message?: string }>('/api/replicas-apply', {
              namespace: target.namespace,
              kind: target.kind,
              name: target.name,
            });
            toast(j.ok === false ? 'Replicas optimize failed:\n' + (j.message || '') : 'Replicas optimize ✓\n' + (j.message || ''));
          } catch {
            toast('Request failed.');
          }
          onReload();
        }}
        style={{
          width: '100%',
          fontSize: 13,
          fontWeight: 600,
          borderRadius: 8,
          padding: '8px 0',
          border: 'none',
          fontFamily: 'inherit',
          cursor: canOpt ? 'pointer' : 'not-allowed',
          background: canOpt ? '#22c55e' : '#f1f5f9',
          color: canOpt ? '#fff' : '#94a3b8',
        }}
      >
        Optimize replicas now
      </button>
    </div>
  );
}

// SchedulingTab — the Workload-overview Pod Scheduling view (docs): Nodes over
// time + Self anti-affinity replicas over time (original vs optimized) + a
// timeline, plus the policy pill + Automated toggle. Data from
// RecommendationDetail.schedulingOpt (Deployments with self anti-affinity).
export function SchedulingTab({
  s,
  target,
  ro,
  onReload,
}: {
  s: SchedulingOpt;
  target: DrawerTarget;
  ro: boolean;
  onReload: () => void;
}) {
  const { toast } = useFeedback();
  // two-line SVG chart (current vs optimized), matching the ReplicasTab sparkline idiom
  const chart = (title: string, cur: number[], opt: number[], curLabel: string, optLabel: string) => {
    const W = 340,
      H = 120,
      p = 8;
    const all = [...cur, ...opt, 1];
    const maxv = Math.max(...all);
    const n = Math.max(cur.length, opt.length, 2);
    const x = (i: number) => p + (i * (W - 2 * p)) / Math.max(1, n - 1);
    const y = (v: number) => H - p - (v / maxv) * (H - 2 * p);
    const path = (arr: number[]) => arr.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    return (
      <div className="card" style={{ padding: 12, flex: 1, minWidth: 260 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: '#334155', textAlign: 'center', marginBottom: 6 }}>{title}</div>
        <svg width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ display: 'block' }}>
          <path d={path(cur)} fill="none" stroke="#818cf8" strokeWidth={2} />
          <path d={path(opt)} fill="none" stroke="#22c55e" strokeWidth={2} strokeDasharray="4 3" />
        </svg>
        <div style={{ display: 'flex', gap: 14, justifyContent: 'center', marginTop: 6, fontSize: 11, color: '#64748b' }}>
          <span><span style={{ display: 'inline-block', width: 8, height: 2, background: '#818cf8', verticalAlign: 'middle' }} /> {curLabel}</span>
          <span><span style={{ display: 'inline-block', width: 8, height: 2, background: '#22c55e', verticalAlign: 'middle' }} /> {optLabel}</span>
        </div>
      </div>
    );
  };
  const arrow = (a?: number, b?: number) => {
    if (a == null || b == null) return <span style={{ color: '#cbd5e1' }}>—</span>;
    const color = (b as number) < (a as number) ? '#16a34a' : '#94a3b8';
    return (
      <>
        <span style={{ color: '#94a3b8' }}>{a}</span> <span style={{ color, fontWeight: 700 }}>→</span>{' '}
        <span style={{ color, fontWeight: 700 }}>{b}</span>
      </>
    );
  };
  return (
    <div style={{ ...pad20, display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* header: policy pill + spread/zones + savings + Automated toggle */}
      <div className="card" style={{ padding: 12, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 11, color: '#94a3b8' }}>Policy</span>
          <span className="pill" style={{ background: '#eef2ff', color: '#4f46e5', fontWeight: 600 }}>🪄 {s.policyName || '—'}</span>
        </div>
        <div style={{ fontSize: 12, color: '#475569' }}>
          Min nodes spread <b className="num">{s.minimumNodesSpread ?? '—'}</b>
          {s.zones ? <span className="pill" style={{ marginLeft: 8, background: '#ecfeff', color: '#0891b2' }}>zone-spread</span> : null}
        </div>
        <div style={{ fontSize: 12, color: '#475569' }}>
          Self anti-affinity replicas: {arrow(s.selfBefore, s.selfAfter)}
        </div>
        <div style={{ fontSize: 12, color: '#475569' }}>
          Available savings <b className="num" style={{ color: '#16a34a' }}>{usd(s.savings || 0)}/mo</b>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          {(s.concerns || []).map((c) => (
            <span key={c} className="pill" style={{ background: '#f1f5f9', color: '#475569' }}>{c}</span>
          ))}
          <Toggle
            checked={!!s.automated}
            disabled={ro}
            onChange={async (v) => {
              await postJson('/api/scheduling-automate', { key: `${target.namespace} ${target.kind} ${target.name}`, enabled: v }).catch(() => {});
              toast(v ? 'Pod Scheduling automated — self anti-affinity will be relaxed' : 'Pod Scheduling un-automated');
              onReload();
            }}
          />
          <span style={{ fontSize: 12, color: '#475569' }}>Automated</span>
        </div>
      </div>
      {/* the two over-time charts (docs: Nodes over time + Self anti-affinity replicas over time) */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {chart('Nodes over time', s.nodesTrend || [], s.nodesOptTrend || [], 'Nodes', 'Optimized nodes')}
        {chart('Self anti-affinity replicas over time', s.selfTrend || [], s.selfOptTrend || [], 'Self anti-affinity replicas', 'Optimized')}
      </div>
      {/* timeline (docs: scheduling events — automated / optimization eviction / auto-healing) */}
      <div className="card" style={{ padding: 12 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: '#334155', marginBottom: 6 }}>Timeline</div>
        {(s.timeline || []).length === 0 ? (
          <div style={{ fontSize: 12, color: '#94a3b8' }}>No scheduling events yet — automated actions, optimization evictions, and auto-healing reactions will appear here once optimization runs.</div>
        ) : (
          <div style={{ fontSize: 12, color: '#475569' }}>{(s.timeline || []).length} event(s)</div>
        )}
      </div>
    </div>
  );
}
