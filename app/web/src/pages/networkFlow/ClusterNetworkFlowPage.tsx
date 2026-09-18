// Cluster Network Flow
import { useEffect, useMemo, useState } from 'react';
import { getJson } from '../../api/client';
import { useClusterData } from '../../providers/ClusterDataProvider';

interface FlowNode {
  id: string;
  label: string;
  nodeType?: string;
  workloadType?: string;
  namespace?: string;
  boundary?: string;
  ingressBps?: number;
  egressBps?: number;
}
interface FlowEdge {
  sourceId: string;
  targetId: string;
  egressBps?: number;
  ingressBps?: number;
}
interface NetworkCost {
  map?: { nodes?: FlowNode[]; edges?: FlowEdge[] };
  workloads?: unknown[];
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

const EXT_ID = '__external__';
const WINDOWS = [
  { key: '5m', label: 'Live (5m)' },
  { key: '1h', label: 'Last hour' },
  { key: '24h', label: 'Last 24 hours' },
  { key: '7d', label: 'Last 7 days' },
];
const COUNTS = [5, 10, 15, 20];
const WIN_SECS: Record<string, number> = { '5m': 300, '1h': 3600, '24h': 86400, '7d': 604800 };
const fmtBytes = (b: number): string => {
  if (!b || b <= 0) return '0 B';
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  let v = b;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (v < 10 ? v.toFixed(2) : v.toFixed(1)) + ' ' + u[i];
};

const KIND_COLORS: Record<string, string> = {
  Deployment: '#4f46e5', DaemonSet: '#0d9488', StatefulSet: '#b45309', Namespace: '#64748b',
};

const selStyle: React.CSSProperties = {
  border: '1px solid #dfe2ec', borderRadius: 999, background: '#fff', color: '#475569',
  fontSize: 13, fontFamily: 'inherit', padding: '7px 12px', cursor: 'pointer', outline: 'none',
};

export default function ClusterNetworkFlowPage() {
  const { overview } = useClusterData();
  const [data, setData] = useState<NetworkCost | null>(null);
  const [search, setSearch] = useState('');
  const [win, setWin] = useState('5m');
  const [count, setCount] = useState(10);
  const [zoom, setZoom] = useState(1);
  const [hover, setHover] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 30000);
    return () => window.clearInterval(id);
  }, []);
  useEffect(() => {
    let dead = false;
    getJson<NetworkCost>(`/api/network/cost?window=${win}&top=${count}`)
      .then((d) => !dead && setData(d))
      .catch(() => {});
    return () => { dead = true; };
  }, [tick, win, count]);

  const wlNodes = useMemo(
    () =>
      (data?.map?.nodes || [])
        .filter((n) => n.id !== EXT_ID)
        .filter((n) => !search || n.label.toLowerCase().includes(search.toLowerCase())),
    [data, search],
  );
  const edges = data?.map?.edges || [];
  const edgeFor = (id: string) => edges.find((e) => e.sourceId === id);

  // layout
  const rowH = 66;
  const svgH = Math.max(380, wlNodes.length * rowH + 90);
  const svgW = 980;
  const wlX = 90;
  const extX = 740;
  const extY = svgH / 2;
  const maxBps = Math.max(1, ...wlNodes.map((n) => (n.ingressBps || 0) + (n.egressBps || 0)));
  const strokeW = (bps: number) => 1 + 5 * Math.min(1, Math.log10(1 + bps) / Math.log10(1 + maxBps));

  return (
    <main style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* filter bar */}
      <section className="card" style={{ padding: '14px 20px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ position: 'relative' }}>
          <svg style={{ width: 14, height: 14, color: '#94a3b8', position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)' }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" />
          </svg>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="search workloads..." style={{ background: '#fff', border: '1px solid #dfe2ec', borderRadius: 999, padding: '7px 14px 7px 34px', fontSize: 13, width: 240, outline: 'none', fontFamily: 'inherit' }} />
        </div>
        <select value={count} onChange={(e) => setCount(Number(e.target.value))} style={selStyle} title="Workloads shown">
          {COUNTS.map((c) => <option key={c} value={c}>Top {c} workloads</option>)}
        </select>
        <div style={{ flex: 1 }} />
        <select value={win} onChange={(e) => setWin(e.target.value)} style={selStyle} title="Averaging window">
          {WINDOWS.map((w) => <option key={w.key} value={w.key}>{w.label}</option>)}
        </select>
      </section>

      <section className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 20px', borderBottom: '1px solid #f2f3f8' }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#1e2536' }}>Cluster network visualization</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ fontSize: 13, color: '#64748b' }}>
              Showing <b>{wlNodes.length}</b> of <b>{data?.workloads?.length ?? wlNodes.length}</b> workloads with <b>{wlNodes.length}</b> connections
            </div>
            {/* zoom controls */}
            <div style={{ display: 'flex', gap: 4 }}>
              <button onClick={() => setZoom((z) => Math.min(2, +(z + 0.2).toFixed(2)))} style={{ ...selStyle, padding: '4px 11px', fontWeight: 700 }} title="Zoom in">+</button>
              <button onClick={() => setZoom((z) => Math.max(0.4, +(z - 0.2).toFixed(2)))} style={{ ...selStyle, padding: '4px 11px', fontWeight: 700 }} title="Zoom out">−</button>
              <button onClick={() => setZoom(1)} style={{ ...selStyle, padding: '4px 11px' }} title="Reset view">Reset</button>
            </div>
          </div>
        </div>
        <div style={{ overflow: 'auto', background: 'radial-gradient(#eef1f8 1px, transparent 1px)', backgroundSize: '18px 18px', padding: 16, maxHeight: 720 }}>
          <svg width={svgW * zoom} height={svgH * zoom} viewBox={`0 0 ${svgW} ${svgH}`} style={{ display: 'block' }}>
            {/* Cluster boundary */}
            <rect x={40} y={30} width={870} height={svgH - 60} rx={14} fill="rgba(79,70,229,0.03)" stroke="#c7ccf5" strokeDasharray="2 0" />
            <text x={898} y={50} textAnchor="end" fontSize={12} fill="#8b93c9" fontWeight={600}>Cluster</text>
            <defs>
              <marker id="arrow" viewBox="0 0 8 8" refX={7} refY={4} markerWidth={7} markerHeight={7} orient="auto-start-reverse">
                <path d="M0,0 L8,4 L0,8 z" fill="#9db8ff" />
              </marker>
            </defs>

            {/* edges */}
            {wlNodes.map((n, i) => {
              const y = 66 + i * rowH + 20;
              const e = edgeFor(n.id);
              const out = e?.egressBps || 0;
              const inn = e?.ingressBps || 0;
              const midX = (wlX + 210 + extX - 60) / 2;
              const hot = hover === n.id;
              return (
                <g key={'e' + n.id} onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover(null)}>
                  <path d={`M ${wlX + 212} ${y} C ${midX} ${y}, ${midX} ${extY}, ${extX - 62} ${extY}`} fill="none" stroke={hot ? '#4f46e5' : '#9db8ff'} strokeWidth={strokeW(out + inn) + (hot ? 1 : 0)} opacity={hot ? 0.95 : 0.6} markerEnd="url(#arrow)" />
                  <text x={midX} y={(y + extY) / 2 - 5} textAnchor="middle" fontSize={10} fill={hot ? '#3730a3' : '#64748b'} fontWeight={hot ? 700 : 400}>
                    ↑{fmtBps(out)} ↓{fmtBps(inn)} · {fmtBytes((out + inn) * (WIN_SECS[win] || 300))}
                  </text>
                </g>
              );
            })}

            {/* workload nodes */}
            {wlNodes.map((n, i) => {
              const y = 66 + i * rowH;
              const kind = n.workloadType || 'Namespace';
              const kc = KIND_COLORS[kind] || '#7c3aed';
              const hot = hover === n.id;
              const name = n.label.length > 30 ? n.label.slice(0, 29) + '…' : n.label;
              return (
                <g key={n.id} onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover(null)} style={{ cursor: 'default' }}>
                  <rect x={wlX} y={y} width={212} height={40} rx={9} fill={hot ? '#e0e7ff' : '#eef2ff'} stroke={hot ? '#818cf8' : '#c7ccf5'} />
                  <circle cx={wlX + 16} cy={y + 20} r={5} fill={kc} />
                  <text x={wlX + 30} y={y + 17} fontSize={10.5} fontWeight={600} fill="#3730a3">{name}</text>
                  <text x={wlX + 30} y={y + 31} fontSize={9} fill="#64748b">{kind} · ↑{fmtBps(n.egressBps || 0)} ↓{fmtBps(n.ingressBps || 0)}</text>
                </g>
              );
            })}

            {/* external hub */}
            {wlNodes.length > 0 && (
              <g>
                <rect x={extX - 62} y={extY - 26} width={124} height={52} rx={11} fill="#f1f5f9" stroke="#cbd5e1" />
                <text x={extX} y={extY - 2} textAnchor="middle" fontSize={12} fontWeight={700} fill="#475569">other</text>
                <text x={extX} y={extY + 14} textAnchor="middle" fontSize={11} fill="#64748b">traffic</text>
              </g>
            )}
            {!wlNodes.length && (
              <text x={svgW / 2} y={svgH / 2} textAnchor="middle" fontSize={13} fill="#94a3b8">No network traffic recorded.</text>
            )}
          </svg>
        </div>
        <div style={{ padding: '12px 20px', borderTop: '1px solid #f2f3f8', fontSize: 12, color: '#94a3b8' }}>
          Nodes are the top workloads by real cAdvisor byte-rate over the selected window (↑ egress / ↓ ingress). Workload-to-workload edges and cross-AZ/VPC-service attribution require an eBPF flow agent (not run on this cluster) — all traffic is shown against a single external hub.
        </div>
      </section>

      <footer style={{ textAlign: 'center', fontSize: 12, color: '#94a3b8', paddingTop: 4 }}>
        CoolScaler - Cluster Network Flow - {overview?.clusterName || ''}
      </footer>
    </main>
  );
}
