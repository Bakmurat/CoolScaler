// Network Report — a deliberate scope-cut), so cost columns are honest $0 and
// the report leads with throughput. Nothing is fabricated.
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { getJson } from '../../api/client';
import { useClusterData } from '../../providers/ClusterDataProvider';

interface NsRow {
  namespace: string;
  ingressBps?: number;
  egressBps?: number;
  crossAzMonthlyCost?: number | null;
}
interface WlRow {
  namespace: string;
  workloadType?: string;
  workloadName?: string;
  ingressBps?: number;
  egressBps?: number;
}
interface NetworkCost {
  totals?: { ingressBps?: number; egressBps?: number; crossAzMonthlyCost?: number | null; topologyAvailable?: boolean };
  namespaces?: NsRow[];
  workloads?: WlRow[];
  window?: string;
}

const fmtBps = (bps: number): string => {
  if (!bps || bps <= 0) return '0 B/s';
  const u = ['B/s', 'KiB/s', 'MiB/s', 'GiB/s'];
  let i = 0;
  let v = bps;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (v < 10 ? v.toFixed(2) : v.toFixed(1)) + ' ' + u[i];
};
const fmtBytes = (b: number): string => {
  if (!b || b <= 0) return '0 B';
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  let v = b;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (v < 10 ? v.toFixed(2) : v.toFixed(1)) + ' ' + u[i];
};
const SECS_PER_MONTH = 2592000;
const WINDOWS = [
  { key: '5m', label: 'Live (5m)' },
  { key: '1h', label: 'Last hour' },
  { key: '24h', label: 'Last 24 hours' },
  { key: '7d', label: 'Last 7 days' },
];

function csvEscape(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function downloadCsv(name: string, header: string[], rows: string[][]) {
  const lines = [header, ...rows].map((r) => r.map(csvEscape).join(',')).join('\n');
  const blob = new Blob([lines], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

const th: CSSProperties = { textAlign: 'left', fontSize: 13, fontWeight: 700, color: '#1e2536', padding: '13px 18px', background: '#f6f7fb', borderBottom: '1px solid #eef0f6' };
const thR: CSSProperties = { ...th, textAlign: 'right' };
const td: CSSProperties = { fontSize: 13, color: '#334155', padding: '14px 18px', borderBottom: '1px solid #f2f3f8' };
const tdR: CSSProperties = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };

const selStyle: CSSProperties = {
  border: '1px solid #dfe2ec', borderRadius: 999, background: '#fff', color: '#475569',
  fontSize: 13, fontFamily: 'inherit', padding: '7px 12px', cursor: 'pointer', outline: 'none',
};

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ flex: 1, padding: '4px 8px', textAlign: 'center' }}>
      <div style={{ fontSize: 13, color: '#64748b', marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 30, fontWeight: 700, color: '#4338ca' }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function TabBtn({ active, children, onClick }: { active: boolean; children: React.ReactNode; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{
      border: 'none', background: 'transparent', fontFamily: 'inherit', fontSize: 14, padding: '10px 18px', cursor: 'pointer',
      color: active ? '#1e2536' : '#64748b', fontWeight: active ? 700 : 500,
      borderBottom: active ? '2px solid #4338ca' : '2px solid transparent',
    }}>{children}</button>
  );
}

export default function NetworkReportPage() {
  const { overview } = useClusterData();
  const [data, setData] = useState<NetworkCost | null>(null);
  const [tab, setTab] = useState<'agg' | 'wl'>('agg');
  const [win, setWin] = useState('5m');
  const [wlSearch, setWlSearch] = useState('');
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 30000);
    return () => window.clearInterval(id);
  }, []);
  useEffect(() => {
    let dead = false;
    const timers: number[] = [];
    const load = (attempt: number) => {
      getJson<NetworkCost>(`/api/network/cost?window=${win}&top=10`)
        .then((d) => {
          if (dead) return;
          setData(d);
          // Intermittent empty Prometheus instant-query: retry a couple of
          // times instead of rendering "no traffic" as final.
          const empty = !(d.namespaces || []).some((r) => (r.ingressBps || 0) + (r.egressBps || 0) > 0);
          if (empty && attempt < 2) timers.push(window.setTimeout(() => load(attempt + 1), 3000));
        })
        .catch(() => {
          if (!dead && attempt < 2) timers.push(window.setTimeout(() => load(attempt + 1), 3000));
        });
    };
    load(0);
    return () => { dead = true; timers.forEach(clearTimeout); };
  }, [tick, win]);

  const rows = useMemo(() => (data?.namespaces || []).filter((r) => (r.ingressBps || 0) + (r.egressBps || 0) > 0), [data]);
  const wlRows = useMemo(
    () => (data?.workloads || [])
      .filter((r) => (r.ingressBps || 0) + (r.egressBps || 0) > 0)
      .filter((r) => !wlSearch || (r.namespace + '/' + (r.workloadName || '')).toLowerCase().includes(wlSearch.toLowerCase()))
      .slice(0, 50),
    [data, wlSearch],
  );
  const totIn = data?.totals?.ingressBps || 0;
  const totOut = data?.totals?.egressBps || 0;
  const cluster = overview?.clusterName || 'example-cluster';
  const top10 = rows.slice(0, 10);
  const maxNs = Math.max(1, ...top10.map((r) => (r.ingressBps || 0) + (r.egressBps || 0)));

  const exportCsv = () => {
    if (tab === 'agg') {
      downloadCsv('NetworkReport.csv',
        ['Namespace', 'Cluster', 'Total Cost', 'Cross-AZ Cost', 'Ingress (B/s)', 'Egress (B/s)', 'Est. monthly bytes'],
        rows.map((r) => [r.namespace, cluster, '0', '0', String(Math.round(r.ingressBps || 0)), String(Math.round(r.egressBps || 0)), String(Math.round(((r.ingressBps || 0) + (r.egressBps || 0)) * SECS_PER_MONTH))]));
    } else {
      downloadCsv('NetworkReportWorkloads.csv',
        ['Namespace', 'Workload', 'Type', 'Cluster', 'Total Cost', 'Ingress (B/s)', 'Egress (B/s)', 'Est. monthly bytes'],
        wlRows.map((r) => [r.namespace, r.workloadName || '', r.workloadType || '', cluster, '0', String(Math.round(r.ingressBps || 0)), String(Math.round(r.egressBps || 0)), String(Math.round(((r.ingressBps || 0) + (r.egressBps || 0)) * SECS_PER_MONTH))]));
    }
  };

  return (
    <main style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <section className="card" style={{ padding: '18px 22px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 700, color: '#1e2536' }}>Network Report</div>
          <div style={{ fontSize: 13, color: '#64748b', marginTop: 4 }}>Explore your network traffic by namespaces, workloads and clusters.</div>
        </div>
        <select value={win} onChange={(e) => setWin(e.target.value)} style={selStyle} title="Averaging window">
          {WINDOWS.map((w) => <option key={w.key} value={w.key}>{w.label}</option>)}
        </select>
      </section>

      {/* KPIs */}
      <section className="card" style={{ padding: '22px 24px', display: 'flex', alignItems: 'stretch', gap: 0 }}>
        <Kpi label="Total network cost" value="$0" sub="egress not priced (no cloud AZ metadata)" />
        <div style={{ width: 1, background: '#eef0f6' }} />
        <Kpi label="Cross-AZ cost" value="$0" sub="requires cloud availability-zone data" />
        <div style={{ width: 1, background: '#eef0f6' }} />
        <Kpi label="Total traffic (In + Out)" value={fmtBps(totIn + totOut)} sub={`≈ ${fmtBytes((totIn + totOut) * SECS_PER_MONTH)}/mo`} />
      </section>

      {/* traffic by namespace bar chart */}
      <section className="card" style={{ padding: '16px 22px' }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: '#1e2536', marginBottom: 12 }}>
          Traffic by namespace <span style={{ fontSize: 12, fontWeight: 400, color: '#94a3b8' }}>· top 10 · real byte-rates</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          {top10.map((r) => {
            const tot = (r.ingressBps || 0) + (r.egressBps || 0);
            const inW = ((r.ingressBps || 0) / maxNs) * 100;
            const outW = ((r.egressBps || 0) / maxNs) * 100;
            return (
              <div key={r.namespace} style={{ display: 'grid', gridTemplateColumns: '170px 1fr 90px', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 12, color: '#475569', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.namespace}</span>
                <div style={{ display: 'flex', height: 14, borderRadius: 4, overflow: 'hidden', background: '#f1f3f9' }}>
                  <div style={{ width: `${inW}%`, background: '#6366f1' }} title={`Ingress ${fmtBps(r.ingressBps || 0)}`} />
                  <div style={{ width: `${outW}%`, background: '#a5b4fc' }} title={`Egress ${fmtBps(r.egressBps || 0)}`} />
                </div>
                <span style={{ fontSize: 12, color: '#64748b', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtBps(tot)}</span>
              </div>
            );
          })}
          {!top10.length && <div style={{ textAlign: 'center', color: '#94a3b8', fontSize: 13, padding: '20px 0' }}>No network traffic recorded.</div>}
        </div>
        <div style={{ display: 'flex', gap: 16, marginTop: 10, fontSize: 11, color: '#64748b' }}>
          <span><span style={{ display: 'inline-block', width: 10, height: 10, background: '#6366f1', borderRadius: 2, marginRight: 5 }} />Ingress</span>
          <span><span style={{ display: 'inline-block', width: 10, height: 10, background: '#a5b4fc', borderRadius: 2, marginRight: 5 }} />Egress</span>
        </div>
      </section>

      {/* tabs + tables */}
      <section className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', borderBottom: '1px solid #eef0f6', padding: '0 12px', gap: 4 }}>
          <TabBtn active={tab === 'agg'} onClick={() => setTab('agg')}>Aggregations</TabBtn>
          <TabBtn active={tab === 'wl'} onClick={() => setTab('wl')}>Workloads</TabBtn>
          <div style={{ flex: 1 }} />
          {tab === 'wl' && (
            <input value={wlSearch} onChange={(e) => setWlSearch(e.target.value)} placeholder="search workloads..." style={{ background: '#fff', border: '1px solid #dfe2ec', borderRadius: 999, padding: '6px 14px', fontSize: 12, width: 200, outline: 'none', fontFamily: 'inherit', margin: '6px 8px' }} />
          )}
        </div>
        {tab === 'agg' ? (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={th}>Namespace</th>
                <th style={th}>Cluster</th>
                <th style={thR}>Total Cost</th>
                <th style={thR}>Cross-AZ Cost</th>
                <th style={thR}>Ingress</th>
                <th style={thR}>Egress</th>
                <th style={thR}>Est. monthly</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const inB = r.ingressBps || 0;
                const outB = r.egressBps || 0;
                return (
                  <tr key={r.namespace}>
                    <td style={{ ...td, fontWeight: 500 }}>{r.namespace}</td>
                    <td style={{ ...td, color: '#64748b' }}>{cluster}</td>
                    <td style={tdR}>$0</td>
                    <td style={tdR}>$0</td>
                    <td style={tdR}>{fmtBps(inB)}</td>
                    <td style={tdR}>{fmtBps(outB)}</td>
                    <td style={{ ...tdR, color: '#475569' }}>{fmtBytes((inB + outB) * SECS_PER_MONTH)}</td>
                  </tr>
                );
              })}
              {!rows.length && (
                <tr><td style={{ ...td, textAlign: 'center', color: '#94a3b8', padding: '40px 0' }} colSpan={7}>No network traffic recorded.</td></tr>
              )}
            </tbody>
          </table>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={th}>Workload</th>
                <th style={th}>Type</th>
                <th style={th}>Namespace</th>
                <th style={thR}>Total Cost</th>
                <th style={thR}>Ingress</th>
                <th style={thR}>Egress</th>
                <th style={thR}>Est. monthly</th>
              </tr>
            </thead>
            <tbody>
              {wlRows.map((r) => {
                const inB = r.ingressBps || 0;
                const outB = r.egressBps || 0;
                return (
                  <tr key={r.namespace + '|' + (r.workloadType || '') + '|' + (r.workloadName || '')}>
                    <td style={{ ...td, fontWeight: 500 }}>{r.workloadName}</td>
                    <td style={{ ...td, color: '#64748b' }}>{r.workloadType}</td>
                    <td style={{ ...td, color: '#64748b' }}>{r.namespace}</td>
                    <td style={tdR}>$0</td>
                    <td style={tdR}>{fmtBps(inB)}</td>
                    <td style={tdR}>{fmtBps(outB)}</td>
                    <td style={{ ...tdR, color: '#475569' }}>{fmtBytes((inB + outB) * SECS_PER_MONTH)}</td>
                  </tr>
                );
              })}
              {!wlRows.length && (
                <tr><td style={{ ...td, textAlign: 'center', color: '#94a3b8', padding: '40px 0' }} colSpan={7}>No workload traffic recorded.</td></tr>
              )}
            </tbody>
          </table>
        )}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 20px', borderTop: '1px solid #f2f3f8' }}>
          <button onClick={exportCsv} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: '1px solid #e3e5ee', borderRadius: 999, background: '#fff', color: '#475569', fontSize: 13, fontWeight: 600, fontFamily: 'inherit', padding: '7px 16px', cursor: 'pointer' }}>
            Export
            <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M12 3v12M7 10l5 5 5-5M5 21h14" /></svg>
          </button>
          <span style={{ fontSize: 12, color: '#94a3b8' }}>
            Ingress/egress are real cAdvisor byte-rates over the selected window. Per-workload cost & cross-AZ breakdown require an eBPF flow agent + cloud AZ pricing (not run on this cluster).
          </span>
        </div>
      </section>

      <footer style={{ textAlign: 'center', fontSize: 12, color: '#94a3b8', paddingTop: 4 }}>
        CoolScaler - Network Report - {cluster}
      </footer>
    </main>
  );
}
