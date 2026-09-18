// Troubleshooting
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { getJson, postJson } from '../../api/client';
import { useClusterData } from '../../providers/ClusterDataProvider';
import { useFeedback } from '../../providers/FeedbackProvider';
import { usePrompt } from '../../components/PromptModal';
import { Dropdown, MenuItem } from '../rightsizing/ui';
import '../rightsizing/rightsizing.css';
import {
  BUILTIN_DASHBOARDS,
  CHART_CATALOG,
  CHART_CATEGORIES,
  PERFORMANCE_CHARTS,
  chartDef,
  normalizeChartData,
  pctAxis,
  rangeByKey,
  TIME_RANGES,
  type ChartDef,
  type DashChartData,
  type DashPoint,
} from './dashLib';
import { CountLines, EmptyAxis, EventScatter, MultiLine } from './DashCharts';

// ---- local response types (legacy fallback endpoints) ----
interface GraphPoint {
  timestamp: string;
  values: Record<string, number | null | undefined>;
}
interface GraphResponse {
  values?: GraphPoint[];
}
interface NodeRow {
  name: string;
  cpuAllocatable?: number;
  memoryAllocatable?: number;
  cpuUsage?: number;
  memoryUsage?: number;
}
interface NodesResponse {
  nodes?: NodeRow[];
}
interface AuditRow {
  timestamp?: string;
  actionType?: string;
  target?: string;
  newValue?: string;
}
interface AuditsResponse {
  audits?: AuditRow[];
}
interface DashboardItem {
  name: string;
  builtin?: boolean;
  charts?: string[];
  aggregation?: string;
}
interface DashboardsResponse {
  dashboards?: DashboardItem[];
}
interface DashChartResp {
  id?: string;
  series?: unknown;
}
interface DashDataResponse {
  // backend returns an ARRAY of chart objects ({id, title, unit, kind, series});
  // tolerate an id-keyed object too.
  charts?: DashChartResp[] | Record<string, unknown>;
}
interface LabelsCatalog {
  namespaces?: string[];
  types?: string[];
}

const coresAxis = (v: number) => (v >= 1 ? (+v).toFixed(1) : Math.round(v * 1000) + 'm');
const bytesAxis = (v: number) => {
  const g = v / 2 ** 30;
  return g >= 1 ? g.toFixed(0) + 'Gi' : Math.round(v / 2 ** 20) + 'Mi';
};

/** GraphPoint[] (analytics-graph shape) → one DashChartData series per key. */
function graphSeries(values: GraphPoint[], keys: [string, string][], from: number, to: number): DashChartData {
  return {
    series: keys.map(([k, name]) => ({
      name,
      points: values
        .map((p): DashPoint => ({ t: Date.parse(p.timestamp), v: p.values?.[k] ?? null }))
        .filter((p) => !Number.isNaN(p.t) && p.t >= from && p.t <= to)
        .sort((a, b) => a.t - b.t),
    })),
  };
}

/** Bucket audit events per hour → event series for the scatter charts. */
function auditSeries(audits: AuditRow[], from: number, to: number, match?: RegExp): DashChartData {
  const buckets: Record<number, number> = {};
  for (const a of audits) {
    if (match && !match.test(a.actionType || '')) continue;
    const t = Date.parse(a.timestamp || '');
    if (Number.isNaN(t) || t < from || t > to) continue;
    const b = Math.floor(t / 3600e3) * 3600e3;
    buckets[b] = (buckets[b] || 0) + 1;
  }
  return {
    series: [
      {
        name: 'events',
        points: Object.entries(buckets)
          .map(([t, v]) => ({ t: +t, v }))
          .sort((a, b) => a.t - b.t),
      },
    ],
  };
}

const hasData = (d?: DashChartData | null): d is DashChartData =>
  !!d && d.series.some((s) => s.points.some((p) => p.v != null));

// ---- small UI bits ----
function Caret() {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} style={{ flexShrink: 0 }}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

const selBox: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  border: '1px solid #dfe2ec',
  borderRadius: 8,
  background: '#fff',
  padding: '8px 12px',
  fontSize: 14,
  color: '#1e2536',
  cursor: 'pointer',
  userSelect: 'none',
  minWidth: 150,
};

const grpLabel: CSSProperties = { fontSize: 14, fontWeight: 700, color: '#1e2536', marginBottom: 8 };

function HeaderGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div style={grpLabel}>{label}</div>
      {children}
    </div>
  );
}

function InfoDot({ text }: { text: string }) {
  return (
    <span
      title={text}
      style={{
        display: 'inline-grid',
        placeItems: 'center',
        width: 13,
        height: 13,
        borderRadius: '50%',
        border: '1px solid #b6bdcc',
        color: '#94a3b8',
        fontSize: 9,
        fontWeight: 700,
        marginLeft: 5,
        verticalAlign: 'middle',
        cursor: 'help',
      }}
    >
      i
    </span>
  );
}

/** Chip w/ dropdown option list (ChipSelect pattern from rightsizing). */
function ChipPick({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: 'relative', opacity: disabled ? 0.5 : 1 }}>
      <span className={'chip' + (value ? ' on' : '')} onClick={() => !disabled && setOpen((o) => !o)}>
        {value ? `${label}: ${value}` : label}{' '}
        {value ? (
          <span
            onClick={(e) => {
              e.stopPropagation();
              onChange('');
              setOpen(false);
            }}
            style={{ marginLeft: 4, fontWeight: 700, cursor: 'pointer' }}
          >
            &times;
          </span>
        ) : (
          <Caret />
        )}
      </span>
      <Dropdown open={open} onClose={() => setOpen(false)} style={{ left: 0, minWidth: 190, maxHeight: 280, overflowY: 'auto', padding: 6 }}>
        <MenuItem
          label={<span style={{ color: '#94a3b8' }}>all</span>}
          onClick={() => {
            onChange('');
            setOpen(false);
          }}
        />
        {options.map((o) => (
          <MenuItem
            key={o}
            label={o === value ? <b>{o}</b> : o}
            onClick={() => {
              onChange(o);
              setOpen(false);
            }}
          />
        ))}
      </Dropdown>
    </div>
  );
}

/** Chip that opens a key=value free-text input (labels / annotations). */
function ChipText({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: 'relative' }}>
      <span className={'chip' + (value ? ' on' : '')} onClick={() => setOpen((o) => !o)}>
        {value ? `${label}: ${value}` : label}{' '}
        {value ? (
          <span
            onClick={(e) => {
              e.stopPropagation();
              onChange('');
              setOpen(false);
            }}
            style={{ marginLeft: 4, fontWeight: 700, cursor: 'pointer' }}
          >
            &times;
          </span>
        ) : (
          <Caret />
        )}
      </span>
      <Dropdown open={open} onClose={() => setOpen(false)} style={{ left: 0, width: 230, padding: 10 }}>
        <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>
          {label} <span style={{ color: '#cbd5e1' }}>key=value</span>
        </div>
        <input
          className="chip"
          autoFocus
          style={{ width: '100%', cursor: 'text', boxSizing: 'border-box' }}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && setOpen(false)}
        />
      </Dropdown>
    </div>
  );
}

/** Sorted node-utilization bar row (legacy fallback for the node charts). */
function BarRow({ name, pct }: { name: string; pct: number }) {
  const color = pct >= 80 ? '#f43f5e' : pct >= 50 ? '#fbbf24' : '#22c55e';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
      <div title={name} style={{ width: 176, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, color: '#475569' }}>
        {name}
      </div>
      <div style={{ flex: 1, height: 8, borderRadius: 999, background: '#eef0f6', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: Math.min(100, pct) + '%', background: color }} />
      </div>
      <span className="num" style={{ fontSize: 11, width: 40, textAlign: 'right', color: pct >= 80 ? '#f43f5e' : '#64748b', fontWeight: pct >= 80 ? 600 : 400 }}>
        {Math.round(pct)}%
      </span>
    </div>
  );
}

function SwatchLegend({ items }: { items: [string, string][] }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', columnGap: 16, rowGap: 4, flexWrap: 'wrap', fontSize: 11, color: '#64748b', marginTop: 6 }}>
      {items.map(([c, t]) => (
        <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ height: 8, width: 14, borderRadius: 4, background: c }} />
          {t}
        </span>
      ))}
    </div>
  );
}

const btn = (enabled: boolean): CSSProperties => ({
  border: '1px solid #e3e5ee',
  borderRadius: 8,
  background: '#fff',
  color: enabled ? '#475569' : '#c3c9d6',
  fontSize: 14,
  fontWeight: 600,
  fontFamily: 'inherit',
  padding: '8px 18px',
  cursor: enabled ? 'pointer' : 'default',
});

// ---- the page ----
export default function TroubleshootPage() {
  const { overview, workloads } = useClusterData();
  const { toast, confirm } = useFeedback();
  const prompt = usePrompt();
  const [params, setParams] = useSearchParams();

  // pickers state (URL-seeded)
  const [dashName, setDashName] = useState<string>(() => {
    const raw = params.get('dashboard') || params.get('selectedDashboard') || 'Performance';
    return raw;
  });
  const [selCharts, setSelCharts] = useState<string[]>(() => {
    const c = (params.get('charts') || '').split(',').filter((id) => chartDef(id));
    return c.length ? c : PERFORMANCE_CHARTS;
  });
  const [rangeKey, setRangeKey] = useState<string>(() => {
    const r = params.get('range') || '3d';
    return TIME_RANGES.some((t) => t.key === r) ? r : '3d';
  });
  const [openMenu, setOpenMenu] = useState<'' | 'dash' | 'charts' | 'agg' | 'range'>('');

  // filters
  const [fSearch, setFSearch] = useState('');
  const [fNs, setFNs] = useState('');
  const [fType, setFType] = useState('');
  const [fWl, setFWl] = useState('');
  const [fLabel, setFLabel] = useState('');
  const [fAnno, setFAnno] = useState('');
  const [fAuto, setFAuto] = useState(false);
  const [fUnauto, setFUnauto] = useState(false);

  // data
  const [backend, setBackend] = useState<boolean | null>(null); // null = probing
  const [serverDashboards, setServerDashboards] = useState<DashboardItem[] | null>(null);
  const [chartData, setChartData] = useState<Record<string, DashChartData>>({});
  const [graph, setGraph] = useState<GraphPoint[]>([]);
  const [nodes, setNodes] = useState<NodeRow[]>([]);
  const [audits, setAudits] = useState<AuditRow[]>([]);
  const [catalog, setCatalog] = useState<LabelsCatalog>({});
  const [tick, setTick] = useState(0);

  const range = rangeByKey(rangeKey);
  const now = useMemo(() => Date.now(), [rangeKey, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const from = now - range.ms;
  const to = now;

  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 60000);
    return () => window.clearInterval(id);
  }, []);

  // keep URL shareable (charts / range / dashboard)
  useEffect(() => {
    const p = new URLSearchParams(params);
    p.set('charts', selCharts.join(','));
    p.set('range', rangeKey);
    p.set('dashboard', dashName);
    setParams(p, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selCharts, rangeKey, dashName]);

  // feature-detect the dashboards API
  useEffect(() => {
    let dead = false;
    getJson<DashboardsResponse | DashboardItem[]>('/api/dashboards')
      .then((d) => {
        if (dead) return;
        const list = (Array.isArray(d) ? d : d.dashboards || []).filter((x) => x && x.name);
        setServerDashboards(list);
        setBackend(true);
      })
      .catch(() => !dead && setBackend(false));
    return () => {
      dead = true;
    };
  }, []);

  // filter-chip option catalogs
  useEffect(() => {
    let dead = false;
    getJson<LabelsCatalog>('/api/labels')
      .then((d) => !dead && setCatalog(d))
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, []);

  // backend-mode data
  useEffect(() => {
    if (backend !== true) return;
    let dead = false;
    const q = new URLSearchParams({
      charts: selCharts.join(','),
      from: String(from),
      to: String(to),
      aggregation: 'workloads',
    });
    if (fSearch) q.set('search', fSearch);
    if (fNs) q.set('namespaces', fNs);
    if (fType) q.set('types', fType);
    if (fWl) q.set('workloads', fWl);
    if (fLabel) q.set('labels', fLabel);
    if (fAnno) q.set('annotations', fAnno);
    if (fAuto) q.set('automated', 'true');
    if (fUnauto) q.set('unautomated', 'true');
    getJson<DashDataResponse>('/api/dashboards/data?' + q.toString())
      .then((d) => {
        if (dead) return;
        const out: Record<string, DashChartData> = {};
        // backend shape: charts is an array of {id, series,...}. Key by each
        // chart's own id (NOT the array index).
        const list: DashChartResp[] = Array.isArray(d.charts)
          ? d.charts
          : Object.entries(d.charts || {}).map(([id, v]) => ({ ...(v as object), id }));
        for (const c of list) {
          if (!c || typeof c.id !== 'string') continue;
          const n = normalizeChartData(c);
          if (n) out[c.id] = n;
        }
        setChartData(out);
      })
      .catch(() => !dead && setBackend(false)); // endpoint went away → fallback
    return () => {
      dead = true;
    };
  }, [backend, selCharts, from, to, fSearch, fNs, fType, fWl, fLabel, fAnno, fAuto, fUnauto]);

  // fallback-mode data
  useEffect(() => {
    if (backend !== false) return;
    let dead = false;
    const types = [
      'workloadsOOM',
      'workloadsThrottling',
      'workloadsUnderProvisioned',
      'numberOfAutomatedPods',
      'totalNumberOfPods',
      'cpuUsageTotal',
      'cpuRequests',
      'memoryUsageTotal',
      'memoryRequests',
    ];
    const url =
      '/api/analytics/graph?range=' + range.fallbackRange + '&groupBy=' + range.groupBy + types.map((t) => '&types=' + t).join('');
    getJson<GraphResponse>(url)
      .then((g) => !dead && setGraph(g.values || []))
      .catch(() => {});
    getJson<NodesResponse>('/api/nodes')
      .then((j) => !dead && setNodes(j.nodes || []))
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [backend, range.fallbackRange, range.groupBy, tick]);

  // audits — used by the event charts (fallback) and the feed below the grid
  useEffect(() => {
    let dead = false;
    getJson<AuditsResponse>('/api/audits')
      .then((j) => !dead && setAudits(j.audits || []))
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [tick]);

  // dashboards list (builtin + custom). The backend is the source of truth
  // (all built-ins + persisted customs); fall back to the local built-in set
  // only when /api/dashboards is unreachable.
  const dashboards: DashboardItem[] = useMemo(() => {
    if (backend === true && serverDashboards) return serverDashboards;
    return BUILTIN_DASHBOARDS.map((d) => ({ name: d.name, builtin: true, charts: d.charts, aggregation: 'workloads' }));
  }, [backend, serverDashboards]);
  const activeDash = dashboards.find((d) => d.name === dashName) || dashboards[0];

  // Deep-link seeding: when the URL pins a dashboard but NOT an explicit chart
  // set, adopt that dashboard's charts once the registry resolves. Captured at
  // mount so the URL-sync effect (which writes charts= immediately) can't race.
  const hadChartsParam = useRef(!!params.get('charts'));
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || backend === null) return; // wait until registry resolves
    seeded.current = true;
    if (hadChartsParam.current) return; // user pinned charts explicitly
    const d = dashboards.find((x) => x.name === dashName);
    const valid = (d?.charts || []).filter((id) => chartDef(id));
    if (valid.length) setSelCharts(valid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, serverDashboards]);

  const deleteDashboard = async (d: DashboardItem) => {
    if (!(await confirm(`Delete custom dashboard "${d.name}"?`))) return;
    try {
      await postJson('/api/dashboards/delete', { name: d.name });
      toast('Dashboard deleted.', 'ok');
      if (dashName === d.name) setDashName('Performance');
      // re-pull the registry
      getJson<{ dashboards?: DashboardItem[] }>('/api/dashboards')
        .then((r) => r.dashboards && setServerDashboards(r.dashboards))
        .catch(() => {});
    } catch (e) {
      toast('Delete failed: ' + e, 'error');
    }
  };

  const pickDashboard = (d: DashboardItem) => {
    setDashName(d.name);
    setSelCharts((d.charts && d.charts.filter((id) => chartDef(id)).length ? d.charts.filter((id) => chartDef(id)) : PERFORMANCE_CHARTS));
    setOpenMenu('');
  };

  const filtersDirty = !!(fSearch || fNs || fType || fWl || fLabel || fAnno || fAuto || fUnauto);
  const chartsDirty = selCharts.join(',') !== (activeDash.charts || PERFORMANCE_CHARTS).join(',');
  const dirty = filtersDirty || chartsDirty;

  const clearAll = () => {
    setFSearch('');
    setFNs('');
    setFType('');
    setFWl('');
    setFLabel('');
    setFAnno('');
    setFAuto(false);
    setFUnauto(false);
    setSelCharts(activeDash.charts || PERFORMANCE_CHARTS);
  };

  const save = async () => {
    if (backend !== true) return;
    let name = activeDash.builtin ? null : activeDash.name;
    if (!name) {
      name = await prompt('Save dashboard', 'The built-in Performance dashboard is locked — save a copy as:', 'My dashboard');
      if (!name) return;
      if (name === 'Performance') {
        toast('That name is reserved for the built-in dashboard.', 'warn');
        return;
      }
    }
    try {
      await postJson('/api/dashboards/save', { name, charts: selCharts, aggregation: 'workloads' });
      setServerDashboards((prev) => {
        const base = prev || [];
        const rest = base.filter((d) => d.name !== name);
        return [...rest, { name: name as string, builtin: false, charts: [...selCharts], aggregation: 'workloads' }];
      });
      setDashName(name);
      toast('Dashboard "' + name + '" saved.');
    } catch {
      toast('Saving the dashboard failed.', 'error');
    }
  };

  const copyLink = () => {
    const url = window.location.origin + window.location.pathname + '?' + params.toString();
    navigator.clipboard
      .writeText(url)
      .then(() => toast('Dashboard link copied.'))
      .catch(() => toast('Could not access the clipboard.', 'warn'));
  };

  // filter options
  const nsOptions = catalog.namespaces || [];
  const typeOptions = catalog.types || [];
  const wlOptions = useMemo(
    () => [...new Set(workloads.map((w) => w.name))].sort().slice(0, 300),
    [workloads],
  );

  // fallback node bars
  const nodeBars = useMemo(
    () =>
      nodes.map((n) => ({
        name: n.name,
        cpu: n.cpuAllocatable ? ((n.cpuUsage || 0) / n.cpuAllocatable) * 100 : 0,
        mem: n.memoryAllocatable ? ((n.memoryUsage || 0) / n.memoryAllocatable) * 100 : 0,
      })),
    [nodes],
  );

  // ---- per-chart body ----
  const yFmtFor = (u?: string) =>
    u === 'pct' ? pctAxis : u === 'cores' ? coresAxis : u === 'bytes' ? bytesAxis : u === 'usd' ? (v: number) => '$' + Math.round(v) : (v: number) => String(Math.round(v));

  const renderBody = (def: ChartDef): ReactNode => {
    const live = chartData[def.id];
    if (backend === true && hasData(live)) {
      if (def.kind === 'events')
        return <EventScatter data={live} from={from} to={to} color={def.id === 'workload-disruptions' ? '#4338ca' : '#6366f1'} />;
      // every non-event chart renders as a (multi-)line with unit-aware axes.
      return <MultiLine data={live} from={from} to={to} yFmt={yFmtFor(def.unit)} yMax={def.unit === 'pct' ? 100 : undefined} />;
    }
    // fallback
    switch (def.id) {
      case 'node-cpu-utilization':
      case 'node-memory-utilization': {
        const k = def.id === 'node-cpu-utilization' ? 'cpu' : 'mem';
        if (!nodeBars.length) return <EmptyAxis from={from} to={to} note="no node data" />;
        return (
          <div style={{ height: 220, overflowY: 'auto', paddingTop: 6 }}>
            {[...nodeBars].sort((a, b) => (k === 'cpu' ? b.cpu - a.cpu : b.mem - a.mem)).map((n) => (
              <BarRow key={n.name} name={n.name} pct={k === 'cpu' ? n.cpu : n.mem} />
            ))}
            <div style={{ fontSize: 10, color: '#b6bdcc', paddingTop: 4 }}>current snapshot — per-node history needs the newer backend</div>
          </div>
        );
      }
      case 'automation-events': {
        const d = auditSeries(audits, from, to);
        return hasData(d) && d.series[0].points.length ? (
          <EventScatter data={d} from={from} to={to} color="#6366f1" />
        ) : (
          <EmptyAxis from={from} to={to} note="no automation events in this window" />
        );
      }
      case 'workload-disruptions': {
        const d = auditSeries(audits, from, to, /rollout|evict|restart/i);
        return d.series[0].points.length ? (
          <EventScatter data={d} from={from} to={to} color="#4338ca" />
        ) : (
          <EmptyAxis from={from} to={to} note="no disruptions in this window" />
        );
      }
      case 'oom-events': {
        const d = graphSeries(graph, [['workloadsOOM', 'OOM workloads']], from, to);
        return hasData(d) ? <CountLines data={d} from={from} to={to} colors={['#f43f5e']} /> : <EmptyAxis from={from} to={to} note="no data yet" />;
      }
      case 'downtime-events':
        return <EmptyAxis from={from} to={to} note="no downtime events recorded in this window" />;
      case 'cpu-throttling': {
        const d = graphSeries(graph, [['workloadsThrottling', 'Throttled workloads']], from, to);
        return hasData(d) ? <CountLines data={d} from={from} to={to} colors={['#f59e0b']} /> : <EmptyAxis from={from} to={to} note="no data yet" />;
      }
      case 'cpu-underprovisioned-stressed':
      case 'memory-underprovisioned-stressed': {
        const d = graphSeries(graph, [['workloadsUnderProvisioned', 'Under-provisioned workloads (cluster-wide)']], from, to);
        return hasData(d) ? <CountLines data={d} from={from} to={to} colors={['#6366f1']} /> : <EmptyAxis from={from} to={to} note="no data yet" />;
      }
      case 'cluster-cpu': {
        const d = graphSeries(
          graph,
          [
            ['cpuUsageTotal', 'Total usage'],
            ['cpuRequests', 'Total request'],
          ],
          from,
          to,
        );
        return hasData(d) ? <MultiLine data={d} from={from} to={to} yFmt={coresAxis} /> : <EmptyAxis from={from} to={to} note="no data yet" />;
      }
      case 'cluster-memory': {
        const d = graphSeries(
          graph,
          [
            ['memoryUsageTotal', 'Total usage'],
            ['memoryRequests', 'Total request'],
          ],
          from,
          to,
        );
        return hasData(d) ? <MultiLine data={d} from={from} to={to} yFmt={bytesAxis} /> : <EmptyAxis from={from} to={to} note="no data yet" />;
      }
      default:
        return <EmptyAxis from={from} to={to} note="no data" />;
    }
  };

  const winAudits = audits.filter((a) => {
    const t = Date.parse(a.timestamp || '');
    return !Number.isNaN(t) && t >= from && t <= to;
  });

  return (
    <main style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* ---- header card: pickers + actions + time range + filters ---- */}
      <section className="card" style={{ padding: '16px 20px', overflow: 'visible' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 20, flexWrap: 'wrap' }}>
          {/* Dashboards */}
          <HeaderGroup label="Dashboards">
            <div style={{ position: 'relative' }}>
              <div style={{ ...selBox, minWidth: 250 }} onClick={() => setOpenMenu(openMenu === 'dash' ? '' : 'dash')}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  {activeDash.name}
                  {activeDash.builtin && (
                    <span style={{ background: '#4338ca', color: '#fff', borderRadius: 999, fontSize: 11, fontWeight: 600, padding: '2px 10px' }}>
                      Built in
                    </span>
                  )}
                </span>
                <Caret />
              </div>
              <Dropdown open={openMenu === 'dash'} onClose={() => setOpenMenu('')} style={{ left: 0, minWidth: 250, padding: 6 }}>
                {dashboards.map((d) => (
                  <MenuItem
                    key={d.name}
                    label={
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                        {d.name === activeDash.name ? <b>{d.name}</b> : d.name}
                        {d.builtin ? (
                          <span style={{ background: '#eef2ff', color: '#4338ca', borderRadius: 999, fontSize: 10, fontWeight: 700, padding: '1px 8px' }}>
                            Built in
                          </span>
                        ) : (
                          <span
                            title="Delete dashboard"
                            onClick={(ev) => { ev.stopPropagation(); void deleteDashboard(d); }}
                            style={{ color: '#e11d48', fontSize: 12, cursor: 'pointer', padding: '0 4px' }}
                          >
                            ✕
                          </span>
                        )}
                      </span>
                    }
                    onClick={() => pickDashboard(d)}
                  />
                ))}
                {backend === false && (
                  <div style={{ padding: '6px 12px', fontSize: 10, color: '#94a3b8', maxWidth: 230 }}>
                    Custom dashboards need the newer backend.
                  </div>
                )}
              </Dropdown>
            </div>
          </HeaderGroup>

          {/* Charts */}
          <HeaderGroup label="Charts">
            <div style={{ position: 'relative' }}>
              <div style={{ ...selBox, minWidth: 180 }} onClick={() => setOpenMenu(openMenu === 'charts' ? '' : 'charts')}>
                Selected ({selCharts.length})
                <Caret />
              </div>
              <Dropdown open={openMenu === 'charts'} onClose={() => setOpenMenu('')} style={{ left: 0, width: 400, padding: 8, maxHeight: 440, overflowY: 'auto' }}>
                {CHART_CATEGORIES.map((cat) => {
                  const items = CHART_CATALOG.filter((c) => c.category === cat);
                  if (!items.length) return null;
                  return (
                    <div key={cat}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.4, padding: '9px 8px 3px' }}>
                        {cat}
                      </div>
                      {items.map((c) => (
                        <label
                          key={c.id}
                          style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', borderRadius: 8, cursor: 'pointer', fontSize: 13, color: '#334155' }}
                        >
                          <input
                            type="checkbox"
                            checked={selCharts.includes(c.id)}
                            onChange={(e) =>
                              setSelCharts((prev) =>
                                e.target.checked ? [...CHART_CATALOG.map((x) => x.id).filter((id) => prev.includes(id) || id === c.id)] : prev.filter((id) => id !== c.id),
                              )
                            }
                          />
                          {c.title}
                        </label>
                      ))}
                    </div>
                  );
                })}
              </Dropdown>
            </div>
          </HeaderGroup>

          <div style={{ alignSelf: 'stretch', width: 1, background: '#eef0f6' }} />

          {/* Aggregations */}
          <HeaderGroup label="Aggregations">
            <div style={{ position: 'relative' }}>
              <div style={{ ...selBox, minWidth: 160 }} onClick={() => setOpenMenu(openMenu === 'agg' ? '' : 'agg')}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="#64748b" strokeWidth={1.8}>
                    <circle cx="12" cy="12" r="2.5" />
                    <circle cx="4.5" cy="6" r="2" />
                    <circle cx="19.5" cy="6" r="2" />
                    <circle cx="4.5" cy="18" r="2" />
                    <circle cx="19.5" cy="18" r="2" />
                    <path d="M6.3 7.2l3.9 3.1M17.7 7.2l-3.9 3.1M6.3 16.8l3.9-3.1M17.7 16.8l-3.9-3.1" />
                  </svg>
                  Workloads
                </span>
                <Caret />
              </div>
              <Dropdown open={openMenu === 'agg'} onClose={() => setOpenMenu('')} style={{ left: 0, minWidth: 160, padding: 6 }}>
                <MenuItem label={<b>Workloads</b>} onClick={() => setOpenMenu('')} />
              </Dropdown>
            </div>
          </HeaderGroup>

          {/* actions */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 30 }}>
            <button style={btn(dirty)} disabled={!dirty} onClick={clearAll}>
              Clear
            </button>
            <button
              style={btn(backend === true && chartsDirty)}
              disabled={!(backend === true && chartsDirty)}
              title={backend === false ? 'Custom dashboards need the newer backend' : activeDash.builtin ? 'Performance is built-in — Save creates a copy' : undefined}
              onClick={save}
            >
              Save
            </button>
            <button style={{ ...btn(true), padding: '8px 10px' }} title="Copy dashboard link" onClick={copyLink}>
              <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} style={{ display: 'block' }}>
                <rect x="9" y="9" width="11" height="11" rx="2" />
                <path d="M5 15V5a2 2 0 012-2h10" />
              </svg>
            </button>
          </div>

          <div style={{ flex: 1 }} />

          {/* time range */}
          <div style={{ position: 'relative', marginTop: 26 }}>
            <div style={{ ...selBox, minWidth: 150 }} onClick={() => setOpenMenu(openMenu === 'range' ? '' : 'range')}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="#64748b" strokeWidth={1.8}>
                  <rect x="3" y="5" width="18" height="16" rx="2" />
                  <path d="M8 3v4M16 3v4M3 10h18" />
                </svg>
                {range.label}
              </span>
              <Caret />
            </div>
            <Dropdown open={openMenu === 'range'} onClose={() => setOpenMenu('')} style={{ right: 0, left: 'auto', minWidth: 170, padding: 6 }}>
              {TIME_RANGES.map((r) => (
                <MenuItem
                  key={r.key}
                  label={r.key === rangeKey ? <b>{r.label}</b> : r.label}
                  onClick={() => {
                    setRangeKey(r.key);
                    setOpenMenu('');
                  }}
                />
              ))}
            </Dropdown>
          </div>
        </div>

        {/* filters row */}
        <div style={{ marginTop: 14 }}>
          <div style={grpLabel}>Filters</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <div style={{ position: 'relative' }}>
              <svg style={{ width: 14, height: 14, color: '#94a3b8', position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)' }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <circle cx="11" cy="11" r="7" />
                <path d="M21 21l-4-4" />
              </svg>
              <input
                value={fSearch}
                onChange={(e) => setFSearch(e.target.value)}
                placeholder="search..."
                style={{ background: '#fff', border: '1px solid #dfe2ec', borderRadius: 999, padding: '6px 12px 6px 32px', fontSize: 13, width: 190, outline: 'none', fontFamily: 'inherit' }}
              />
            </div>
            <ChipPick label="namespaces" value={fNs} options={nsOptions} onChange={setFNs} />
            <ChipText label="labels" value={fLabel} placeholder="app=web" onChange={setFLabel} />
            <ChipText label="annotations" value={fAnno} placeholder="team=payments" onChange={setFAnno} />
            <ChipPick label="types" value={fType} options={typeOptions} onChange={setFType} />
            <ChipPick label="workloads" value={fWl} options={wlOptions} onChange={setFWl} />
            <span className={'chip' + (fAuto ? ' on' : '')} onClick={() => setFAuto((v) => !v)}>
              automated
            </span>
            <span className={'chip' + (fUnauto ? ' on' : '')} onClick={() => setFUnauto((v) => !v)}>
              un-automated
            </span>
          </div>
          {backend === false && (
            <div style={{ marginTop: 10, fontSize: 11, color: '#94a3b8' }}>
              Showing the built-in Performance layout from live cluster data — custom dashboards, per-node history and filter-scoped charts need the newer backend (/api/dashboards).
            </div>
          )}
        </div>
      </section>

      {/* ---- charts grid ---- */}
      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(560px, 1fr))', gap: 16 }}>
        {selCharts.map((id) => {
          const def = chartDef(id);
          if (!def) return null;
          return (
            <div key={id} className="card" style={{ padding: '14px 16px 10px' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'center', gap: 4, marginBottom: 4 }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: '#1e2536', textAlign: 'center' }}>
                  {def.title}
                  {def.sorted && <span style={{ fontSize: 10, fontWeight: 400, color: '#94a3b8', marginLeft: 4 }}>(sorted)</span>}
                  {def.info && <InfoDot text={def.info} />}
                </span>
              </div>
              {renderBody(def)}
              {def.legend && <SwatchLegend items={def.legend} />}
            </div>
          );
        })}
        {!selCharts.length && (
          <div className="card" style={{ padding: 40, textAlign: 'center', color: '#94a3b8', gridColumn: '1 / -1' }}>
            No charts selected — pick charts from the "Charts" menu above.
          </div>
        )}
      </section>

      {/* CoolScaler extra: automation audit feed */}
      <section className="card" style={{ padding: 20 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#1e2536', marginBottom: 8 }}>Recent automation events</div>
        <div style={{ fontSize: 12 }}>
          {winAudits.length ? (
            winAudits.slice(0, 15).map((a, i) => (
              <div
                key={i}
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '4px 0', borderBottom: i < Math.min(winAudits.length, 15) - 1 ? '1px solid #f6f7fb' : 'none' }}
              >
                <div style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  <span style={{ fontWeight: 500, color: '#1e2536' }}>{a.actionType || ''}</span>
                  <span style={{ color: '#64748b' }}> - {a.target || ''}</span>
                  {a.newValue ? <span style={{ color: '#94a3b8' }}> ({a.newValue})</span> : null}
                </div>
                <span className="num" style={{ fontSize: 10, color: '#94a3b8', flexShrink: 0 }}>
                  {(a.timestamp || '').replace('T', ' ').replace('Z', '')}
                </span>
              </div>
            ))
          ) : (
            <div style={{ color: '#94a3b8', padding: '8px 0' }}>No recorded actions in this window.</div>
          )}
        </div>
      </section>

      <footer style={{ textAlign: 'center', fontSize: 12, color: '#94a3b8', paddingTop: 8, paddingBottom: 24 }}>
        CoolScaler - Analytics dashboards - {overview?.clusterName || ''}
      </footer>
    </main>
  );
}
