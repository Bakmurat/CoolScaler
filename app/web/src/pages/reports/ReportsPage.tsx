// Reports
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { getJson, postJson } from '../../api/client';
import { useClusterData } from '../../providers/ClusterDataProvider';

interface GraphRow {
  timestamp?: string;
  allocatableCpu?: number | null;
  cpuRequests?: number | null;
  cpuRequestsOrigin?: number | null;
  memoryRequests?: number | null;
  memoryRequestsOrigin?: number | null;
  rightSizedPods?: number | null;
  unevictablePods?: number | null;
  binPackedPods?: number | null;
  totalPods?: number | null;
}
interface Aggregate {
  name: string;
  value: number;
  scope?: string;
}
interface NsRow {
  namespace: string;
}

const AGGREGATORS = ['Total Cost', 'Savings Overtime', 'Total Waste', 'CPU Request', 'Memory Request', 'GPU Request'];
const RANGES: { key: '7d' | '30d'; label: string; ms: number }[] = [
  { key: '7d', label: 'Last 7 days', ms: 7 * 864e5 },
  { key: '30d', label: 'Last 30 days', ms: 30 * 864e5 },
];

const card: CSSProperties = { background: '#fff', border: '1px solid #e9eaf0', borderRadius: 16, boxShadow: '0 1px 2px rgba(16,24,40,.06)', padding: 20 };
const title: CSSProperties = { fontSize: 14, fontWeight: 700, color: '#1e2536' };
const chip = (on: boolean): CSSProperties => ({
  fontSize: 12.5, fontWeight: 600, borderRadius: 999, padding: '6px 14px', cursor: 'pointer', fontFamily: 'inherit',
  border: on ? '1px solid #c7d2fe' : '1px solid #e3e5ee',
  background: on ? '#eef2ff' : '#fff', color: on ? '#4f46e5' : '#64748b',
});

const fmtVal = (name: string, v: number): string => {
  if (/Cost|Waste|Savings/.test(name)) return '$' + v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (name === 'Memory Request') return v >= 2 ** 30 ? (v / 2 ** 30).toFixed(2) + ' GiB' : (v / 2 ** 20).toFixed(0) + ' MiB';
  if (name === 'CPU Request') return v.toFixed(2) + ' cores';
  return String(v);
};
const tsLabel = (iso?: string): string => {
  const d = new Date(iso || '');
  return Number.isNaN(+d) ? '' : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit' });
};
const gibAxis = (v: number) => (v >= 2 ** 30 ? (v / 2 ** 30).toFixed(0) + 'Gi' : (v / 2 ** 20).toFixed(0) + 'Mi');

function ReportChart({
  rows, series, yFmt,
}: {
  rows: GraphRow[];
  series: [keyof GraphRow, string, string][];
  yFmt?: (v: number) => string;
}) {
  const data = rows.map((r) => ({ ...r, label: tsLabel(r.timestamp) }));
  return (
    <div style={{ height: 190 }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <XAxis dataKey="label" tick={{ fontSize: 9, fill: '#aab' }} tickLine={false} axisLine={false} minTickGap={60} />
          <YAxis tick={{ fontSize: 9, fill: '#aab' }} tickFormatter={yFmt} tickLine={false} axisLine={false} width={46} />
          <Tooltip
            contentStyle={{ borderRadius: 8, border: '1px solid #e9eaf0', fontSize: 11 }}
            labelStyle={{ fontSize: 11 }}
            itemStyle={{ fontSize: 11, padding: 0 }}
            formatter={(v: unknown, name: unknown) => [yFmt && typeof v === 'number' ? yFmt(v) : String(v), String(name)] as [string, string]}
          />
          {series.map(([k, label, color]) => (
            <Line key={String(k)} type="monotone" dataKey={k} name={label} stroke={color} strokeWidth={1.5} dot={false} isAnimationActive={false} connectNulls />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function Legend({ items }: { items: [string, string][] }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', marginTop: 6, fontSize: 11, color: '#64748b' }}>
      {items.map(([c, l]) => (
        <span key={l} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 10, height: 3, background: c, borderRadius: 2, display: 'inline-block' }} />
          {l}
        </span>
      ))}
    </div>
  );
}

export default function ReportsPage() {
  const { overview } = useClusterData();
  const [range, setRange] = useState<'7d' | '30d'>('7d');
  const [aggSel, setAggSel] = useState<Set<string>>(new Set(['Total Cost', 'Total Waste', 'CPU Request', 'Memory Request']));
  const [nsOptions, setNsOptions] = useState<string[]>([]);
  const [nsSel, setNsSel] = useState<Set<string>>(new Set());
  const [labelFilter, setLabelFilter] = useState('');
  const [aggregates, setAggregates] = useState<Aggregate[] | null>(null);
  const [graph, setGraph] = useState<GraphRow[]>([]);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    getJson<{ namespaces?: NsRow[] }>('/api/namespaces')
      .then((d) => setNsOptions((d.namespaces || []).map((n) => n.namespace).sort()))
      .catch(() => {});
  }, []);

  useEffect(() => {
    let dead = false;
    getJson<{ values?: GraphRow[] }>('/api/reports/graph?range=' + range)
      .then((d) => !dead && setGraph(d.values || []))
      .catch(() => {});
    return () => { dead = true; };
  }, [range]);

  const runReport = useCallback(async () => {
    setRunning(true);
    try {
      const now = Date.now();
      const r = await postJson<{ data?: { aggregates?: Aggregate[] } }>('/api/reports/new', {
        from: now - RANGES.find((x) => x.key === range)!.ms,
        to: now,
        aggregators: [...aggSel],
        namespaceFilters: [...nsSel],
        labelsFilters: labelFilter.trim() ? labelFilter.split(',').map((x) => x.trim()).filter(Boolean) : [],
      });
      setAggregates(r.data?.aggregates || []);
    } catch {
      setAggregates([]);
    } finally {
      setRunning(false);
    }
  }, [aggSel, nsSel, labelFilter, range]);

  const filtered = nsSel.size > 0 || !!labelFilter.trim();
  const toggle = <T,>(set: Set<T>, v: T, put: (n: Set<T>) => void) => {
    const n = new Set(set);
    if (n.has(v)) n.delete(v);
    else n.add(v);
    put(n);
  };

  const podSeries = useMemo(() => graph, [graph]);

  return (
    <main style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <section style={card}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
          <div>
            <div style={{ fontSize: 22, fontWeight: 700, color: '#1e2536' }}>Reports</div>
            <div style={{ fontSize: 13, color: '#64748b', marginTop: 4 }}>
              Build custom reports from the cluster's recorded history — pick aggregators, filter by namespaces and labels.
            </div>
          </div>
          <div style={{ display: 'inline-flex', gap: 2, background: '#f1f2f7', borderRadius: 8, padding: 2 }}>
            {RANGES.map((r) => (
              <span key={r.key} className={'tabline' + (range === r.key ? ' active' : '')} onClick={() => setRange(r.key)}>
                {r.label}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* builder */}
      <section style={card}>
        <div style={{ ...title, marginBottom: 10 }}>Aggregators</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
          {AGGREGATORS.map((a) => (
            <button key={a} style={chip(aggSel.has(a))} onClick={() => toggle(aggSel, a, setAggSel)}>{a}</button>
          ))}
        </div>
        <div style={{ ...title, marginBottom: 10 }}>Filters</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
          {nsOptions.map((ns) => (
            <button key={ns} style={chip(nsSel.has(ns))} onClick={() => toggle(nsSel, ns, setNsSel)}>{ns}</button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <label style={{ fontSize: 12.5, color: '#475569', display: 'flex', flexDirection: 'column', gap: 4, minWidth: 280 }}>
            Label filters (comma-separated key=value)
            <input
              value={labelFilter}
              onChange={(e) => setLabelFilter(e.target.value)}
              placeholder="app=web, team=platform"
              style={{ border: '1px solid #dfe2ec', borderRadius: 8, padding: '8px 12px', fontSize: 13, outline: 'none', fontFamily: 'inherit' }}
            />
          </label>
          <button
            onClick={() => void runReport()}
            disabled={running || aggSel.size === 0}
            style={{ fontSize: 13, fontWeight: 600, borderRadius: 8, padding: '9px 18px', cursor: 'pointer', fontFamily: 'inherit', background: '#6366f1', color: '#fff', border: '1px solid #6366f1', opacity: running || aggSel.size === 0 ? 0.6 : 1 }}
          >
            {running ? 'Running…' : 'Run report'}
          </button>
          {filtered && (
            <span style={{ fontSize: 11.5, color: '#94a3b8' }}>
              Filtered reports use live workload data (history is cluster-scope).
            </span>
          )}
        </div>

        {aggregates !== null && (
          <table style={{ width: '100%', maxWidth: 640, borderCollapse: 'collapse', fontSize: 13, marginTop: 18 }}>
            <thead>
              <tr>
                {['Aggregator', 'Value', 'Scope'].map((h) => (
                  <th key={h} style={{ textAlign: 'left', fontSize: 12, fontWeight: 700, color: '#1e2536', padding: '9px 14px', background: '#f6f7fb', borderBottom: '1px solid #eef0f6' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {aggregates.map((a) => (
                <tr key={a.name}>
                  <td style={{ padding: '10px 14px', borderBottom: '1px solid #f2f3f8', fontWeight: 500 }}>{a.name}</td>
                  <td className="num" style={{ padding: '10px 14px', borderBottom: '1px solid #f2f3f8', color: '#4338ca', fontWeight: 700 }}>{fmtVal(a.name, a.value)}</td>
                  <td style={{ padding: '10px 14px', borderBottom: '1px solid #f2f3f8', color: '#94a3b8', fontSize: 12 }}>{a.scope === 'live-filtered' ? 'live (filtered)' : 'cluster average'}</td>
                </tr>
              ))}
              {!aggregates.length && (
                <tr><td colSpan={3} style={{ padding: '22px 0', textAlign: 'center', color: '#94a3b8' }}>No aggregates returned.</td></tr>
              )}
            </tbody>
          </table>
        )}
      </section>

      {/* history graphs */}
      <section style={card}>
        <div style={{ ...title, marginBottom: 12 }}>Cluster history <span style={{ fontSize: 11, fontWeight: 400, color: '#94a3b8' }}>· recorded snapshot series</span></div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#64748b', marginBottom: 4 }}>CPU (cores)</div>
            <ReportChart
              rows={graph}
              series={[['allocatableCpu', 'Allocatable', '#f6a45c'], ['cpuRequests', 'Requests', '#f59e0b'], ['cpuRequestsOrigin', 'Original requests', '#ef4444']]}
              yFmt={(v) => v.toFixed(0)}
            />
            <Legend items={[['#f6a45c', 'Allocatable'], ['#f59e0b', 'Requests'], ['#ef4444', 'Original requests']]} />
          </div>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#64748b', marginBottom: 4 }}>Memory</div>
            <ReportChart
              rows={graph}
              series={[['memoryRequests', 'Requests', '#f59e0b'], ['memoryRequestsOrigin', 'Original requests', '#ef4444']]}
              yFmt={gibAxis}
            />
            <Legend items={[['#f59e0b', 'Requests'], ['#ef4444', 'Original requests']]} />
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#64748b', marginBottom: 4 }}>Pods</div>
            <ReportChart
              rows={podSeries}
              series={[['totalPods', 'Total pods', '#6366f1'], ['rightSizedPods', 'Right-sized pods', '#22c55e'], ['unevictablePods', 'Unevictable pods', '#f59e0b'], ['binPackedPods', 'Bin-packed pods', '#0d9488']]}
              yFmt={(v) => v.toFixed(0)}
            />
            <Legend items={[['#6366f1', 'Total pods'], ['#22c55e', 'Right-sized pods'], ['#f59e0b', 'Unevictable pods'], ['#0d9488', 'Bin-packed pods']]} />
          </div>
        </div>
      </section>

      <footer style={{ textAlign: 'center', fontSize: 12, color: '#94a3b8', paddingTop: 4 }}>
        CoolScaler - Reports - {overview?.clusterName || ''}
      </footer>
    </main>
  );
}
