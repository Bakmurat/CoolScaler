// Billing — the backend emits nothing fabricated; empty months render empty.
import { useEffect, useMemo, useState } from 'react';
import { getJson } from '../../api/client';

interface ClusterRow {
  name: string;
  cpuAllocatable: number;
  monthlyUptime: number;
  automation: {
    rightsizing: number | null;
    podPlacement: number | null;
    replicasOptimization: number | null;
    gpuRightsizing: number | null;
    spotOptimization: number | null;
    nodeManagement: number | null;
  };
}
interface BillingResponse {
  totalCpuAllocatable: number;
  totalClusters: number;
  cpuOverTime: { t: number; v: number }[];
  clusters: ClusterRow[];
  monthlyAllocatable: { month: string; cpuAllocatable: number }[];
  error?: string;
}

const card: React.CSSProperties = {
  background: '#fff',
  border: '1px solid #e9ebf0',
  borderRadius: 12,
  padding: 20,
};

function monthLabel(mk: string): string {
  const [y, m] = mk.split('-').map(Number);
  const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${names[(m || 1) - 1]} ${y}`;
}

/** Simple line chart (single series). */
function LineChart({ pts, unit }: { pts: { t: number; v: number }[]; unit: string }) {
  const W = 1100,
    H = 260,
    p = 40;
  if (pts.length < 2) return <div style={{ color: '#94a3b8', fontSize: 13, padding: 40, textAlign: 'center' }}>Collecting history… (fills in as samples accrue every 30s)</div>;
  const xs = pts.map((d) => d.t);
  const maxv = Math.max(...pts.map((d) => d.v), 1);
  const x0 = Math.min(...xs),
    x1 = Math.max(...xs);
  const X = (t: number) => p + ((t - x0) / Math.max(1, x1 - x0)) * (W - 2 * p);
  const Y = (v: number) => H - p - (v / maxv) * (H - 2 * p);
  const line = pts.map((d, i) => `${i ? 'L' : 'M'}${X(d.t).toFixed(1)},${Y(d.v).toFixed(1)}`).join(' ');
  const tick = (t: number) => new Date(t * 1000).toLocaleDateString(undefined, { month: 'short', day: '2-digit' });
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 260 }}>
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line x1={p} y1={Y(maxv * f)} x2={W - p} y2={Y(maxv * f)} stroke="#eef0f5" />
          <text x={4} y={Y(maxv * f) + 4} fontSize={11} fill="#94a3b8">
            {Math.round(maxv * f)}
          </text>
        </g>
      ))}
      <path d={line} fill="none" stroke="#f59e0b" strokeWidth={2} />
      <text x={p} y={H - 10} fontSize={11} fill="#94a3b8">
        {tick(x0)}
      </text>
      <text x={W - p} y={H - 10} fontSize={11} fill="#94a3b8" textAnchor="end">
        {tick(x1)}
      </text>
      <text x={W / 2} y={H - 10} fontSize={11} fill="#94a3b8" textAnchor="middle">
        {unit}
      </text>
    </svg>
  );
}

/** Monthly allocatable bar chart (3/6/12 month window). */
function MonthlyBars({ data }: { data: { month: string; cpuAllocatable: number }[] }) {
  const [win, setWin] = useState<3 | 6 | 12>(12);
  // Build the trailing N months ending at the latest known month, filling gaps.
  const months = useMemo(() => {
    const map = new Map(data.map((d) => [d.month, d.cpuAllocatable]));
    const now = new Date();
    const out: { month: string; label: string; v: number }[] = [];
    for (let i = win - 1; i >= 0; i--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      const mk = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      out.push({ month: mk, label: monthLabel(mk), v: map.get(mk) ?? 0 });
    }
    return out;
  }, [data, win]);
  const maxv = Math.max(...months.map((m) => m.v), 1);
  return (
    <div style={card}>
      <div style={{ display: 'flex', gap: 4, marginBottom: 12 }}>
        {([3, 6, 12] as const).map((w) => (
          <button
            key={w}
            onClick={() => setWin(w)}
            style={{
              fontSize: 12,
              padding: '4px 12px',
              borderRadius: 6,
              border: '1px solid #e2e8f0',
              cursor: 'pointer',
              fontFamily: 'inherit',
              background: win === w ? '#eef2ff' : '#fff',
              color: win === w ? '#4f46e5' : '#64748b',
              fontWeight: win === w ? 600 : 400,
            }}
          >
            {w === 3 ? '3 Months' : w === 6 ? '6 Months' : '1 Year'}
          </button>
        ))}
      </div>
      <div style={{ textAlign: 'center', fontSize: 13, color: '#475569', marginBottom: 8 }}>
        CPU allocatable <span style={{ color: '#94a3b8' }}>(monthly)</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 240, padding: '0 8px' }}>
        {months.map((m, i) => (
          <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, height: '100%', justifyContent: 'flex-end' }}>
            <div title={`${m.label}: ${m.v}`} style={{ width: '80%', height: `${(m.v / maxv) * 100}%`, background: '#6366f1', borderRadius: '4px 4px 0 0', minHeight: m.v > 0 ? 2 : 0 }} />
            <div style={{ fontSize: 10, color: '#94a3b8', whiteSpace: 'nowrap', transform: 'rotate(-30deg)', transformOrigin: 'center' }}>
              {m.label.split(' ')[0].slice(0, 3)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const AUTO_ROWS: [keyof ClusterRow['automation'], string][] = [
  ['rightsizing', 'Rightsizing'],
  ['podPlacement', 'Pod Placement'],
  ['replicasOptimization', 'Replicas Optimization'],
  ['gpuRightsizing', 'GPU Rightsizing'],
  ['spotOptimization', 'Spot Optimization'],
  ['nodeManagement', 'Node Management'],
];

export default function BillingPage() {
  const [data, setData] = useState<BillingResponse | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let dead = false;
    getJson<BillingResponse>('/api/billing?range=30d')
      .then((d) => {
        if (dead) return;
        if (d.error) setErr(d.error);
        else setData(d);
      })
      .catch(() => setErr('Could not load billing data'));
    return () => {
      dead = true;
    };
  }, []);

  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const fmt = (d: Date) => d.toLocaleDateString(undefined, { month: 'short', day: '2-digit', year: 'numeric' });

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 1400, margin: '0 auto' }}>
      {/* Header */}
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 22 }}>🧾</span>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 700, color: '#1e2536', margin: 0 }}>Billing</h1>
            <div style={{ fontSize: 13, color: '#64748b', marginTop: 2 }}>Explore cluster billing estimation for current month</div>
          </div>
        </div>
        <div style={{ fontSize: 12, color: '#475569', marginTop: 10 }}>
          <span style={{ color: '#4f46e5', fontWeight: 600 }}>Start date:</span> {fmt(start)}{'  '}
          <span style={{ color: '#4f46e5', fontWeight: 600, marginLeft: 8 }}>End date:</span> {fmt(now)}
        </div>
        <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 6 }}>
          <b>Note:</b> The data shown is an <b>estimation only</b>. Final billing will be determined using CoolScaler metrics.
        </div>
      </div>

      {err && <div style={{ ...card, color: '#e11d48' }}>{err}</div>}

      {/* KPIs */}
      <div style={{ ...card, display: 'flex' }}>
        <div style={{ flex: 1, textAlign: 'center' }}>
          <div style={{ fontSize: 14, color: '#64748b' }}>
            Total CPU allocatable <span style={{ color: '#94a3b8' }}>(avg.)</span>
          </div>
          <div style={{ fontSize: 48, fontWeight: 300, color: '#1e2536' }}>{data ? data.totalCpuAllocatable : '—'}</div>
        </div>
        <div style={{ width: 1, background: '#e9ebf0' }} />
        <div style={{ flex: 1, textAlign: 'center' }}>
          <div style={{ fontSize: 14, color: '#64748b' }}>Total clusters</div>
          <div style={{ fontSize: 48, fontWeight: 300, color: '#1e2536' }}>{data ? data.totalClusters : '—'}</div>
        </div>
      </div>

      {/* CPU over time */}
      <div style={card}>
        <div style={{ textAlign: 'center', fontSize: 14, color: '#475569', marginBottom: 8 }}>CPU over time</div>
        <LineChart pts={data?.cpuOverTime || []} unit="Allocatable" />
      </div>

      {/* Clusters table */}
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, color: '#1e2536', marginTop: 0 }}>Clusters</h2>
          <span className="chip on" style={{ fontSize: 12 }}>clusters: {(data?.clusters || []).map((c) => c.name).join(', ') || '—'}</span>
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: '#f4f5f8', color: '#475569' }}>
              <th style={{ textAlign: 'left', padding: 12 }}>Cluster name</th>
              <th style={{ textAlign: 'center', padding: 12 }}>
                CPU allocatable <span style={{ color: '#94a3b8', fontWeight: 400 }}>(average)</span>
              </th>
              <th style={{ textAlign: 'center', padding: 12 }}>Monthly uptime</th>
              <th style={{ textAlign: 'left', padding: 12 }}>
                Automation <span style={{ color: '#94a3b8', fontWeight: 400 }}>(average)</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {(data?.clusters || []).map((c) => (
              <tr key={c.name} style={{ borderTop: '1px solid #eef0f5' }}>
                <td style={{ padding: 12, fontWeight: 600 }}>{c.name}</td>
                <td style={{ padding: 12, textAlign: 'center' }} className="num">
                  {c.cpuAllocatable.toLocaleString()}
                </td>
                <td style={{ padding: 12, textAlign: 'center' }} className="num">
                  {c.monthlyUptime}%
                </td>
                <td style={{ padding: 12 }}>
                  {AUTO_ROWS.map(([k, lbl]) => {
                    const v = c.automation[k];
                    return (
                      <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                        <span style={{ width: 150, color: '#475569' }}>{lbl}</span>
                        <div style={{ flex: 1, maxWidth: 220, height: 8, borderRadius: 4, background: '#eef0f5', overflow: 'hidden' }}>
                          <div style={{ width: (v ?? 0) + '%', height: 8, background: '#22c55e' }} />
                        </div>
                        <span style={{ width: 40, textAlign: 'right', color: v == null ? '#94a3b8' : '#16a34a', fontWeight: 600 }} className="num">
                          {v == null ? '—' : v + '%'}
                        </span>
                      </div>
                    );
                  })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 16, padding: '10px 4px 0', fontSize: 12, color: '#64748b' }}>
          <span>Rows per page: 15</span>
          <span className="num">1–{(data?.clusters || []).length || 0} of {(data?.clusters || []).length || 0}</span>
        </div>
      </div>

      {/* Historical monthly allocatable */}
      <MonthlyBars data={data?.monthlyAllocatable || []} />
    </div>
  );
}
