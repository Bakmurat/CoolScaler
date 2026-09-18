// Events
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { getJson } from '../../api/client';
import { useClusterData } from '../../providers/ClusterDataProvider';
import { Dropdown, MenuItem } from '../rightsizing/ui';
import '../rightsizing/rightsizing.css';

interface AuditRow {
  timestamp?: string;
  actionType?: string;
  target?: string;
  oldValue?: string;
  newValue?: string;
  user?: string;
  kind?: string;
  operation?: string;
  message?: string;
  namespace?: string;
  workloadType?: string;
  workloadName?: string;
}
interface AuditsResponse {
  audits?: AuditRow[];
  total?: number;
}

const RANGES: { key: string; label: string; ms: number }[] = [
  { key: '3d', label: '3d', ms: 3 * 86400e3 },
  { key: '7d', label: '7d', ms: 7 * 86400e3 },
  { key: '14d', label: '14d', ms: 14 * 86400e3 },
  { key: '30d', label: '30d', ms: 30 * 86400e3 },
];
const PAGE_SIZES = [5, 10, 25, 50, 100];

const humanize = (s?: string): string =>
  (s || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim();

const fmtTime = (iso?: string): string => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(+d)) return iso;
  return d.toLocaleString([], { month: 'short', day: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};

interface NormRow {
  raw: AuditRow;
  isSystem: boolean;
  ts: number;
  startTime: string;
  operation: string;
  user: string;
  message: string;
  namespace: string;
  workloadType: string;
}

function normalize(r: AuditRow): NormRow {
  const isSystem = !!r.kind;
  const operation = r.operation || humanize(r.actionType);
  const message = r.message || (r.target || '') + (r.newValue ? ` (${r.newValue})` : '');
  const t = r.timestamp ? Date.parse(r.timestamp) : NaN;
  return {
    raw: r,
    isSystem,
    ts: Number.isNaN(t) ? 0 : t,
    startTime: fmtTime(r.timestamp),
    operation,
    user: r.user || '',
    message,
    namespace: r.namespace || '',
    workloadType: r.workloadType || '',
  };
}

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

// ---- small UI bits ----
function Caret() {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} style={{ flexShrink: 0 }}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}
function ChipPick({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: 'relative' }}>
      <span className={'chip' + (value ? ' on' : '')} onClick={() => setOpen((o) => !o)}>
        {value ? `${label}: ${value}` : label}{' '}
        {value ? (
          <span onClick={(e) => { e.stopPropagation(); onChange(''); setOpen(false); }} style={{ marginLeft: 4, fontWeight: 700, cursor: 'pointer' }}>&times;</span>
        ) : (
          <Caret />
        )}
      </span>
      <Dropdown open={open} onClose={() => setOpen(false)} style={{ left: 0, minWidth: 190, maxHeight: 300, overflowY: 'auto', padding: 6 }}>
        <MenuItem label={<span style={{ color: '#94a3b8' }}>all</span>} onClick={() => { onChange(''); setOpen(false); }} />
        {options.map((o) => (
          <MenuItem key={o} label={o === value ? <b>{o}</b> : o} onClick={() => { onChange(o); setOpen(false); }} />
        ))}
      </Dropdown>
    </div>
  );
}

const th: CSSProperties = { textAlign: 'left', fontSize: 13, fontWeight: 700, color: '#1e2536', padding: '14px 18px', background: '#f6f7fb', borderBottom: '1px solid #eef0f6' };
const td: CSSProperties = { fontSize: 13, color: '#334155', padding: '16px 18px', borderBottom: '1px solid #f2f3f8', verticalAlign: 'top' };

function TabBtn({ active, children, onClick }: { active: boolean; children: ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        border: 'none', background: active ? '#fff' : '#f1f2f7', borderBottom: active ? '2px solid #4338ca' : '2px solid transparent',
        color: active ? '#1e2536' : '#64748b', fontWeight: active ? 700 : 500, fontFamily: 'inherit', fontSize: 15,
        padding: '12px 22px', cursor: 'pointer', borderTopLeftRadius: 8, borderTopRightRadius: 8,
      }}
    >
      {children}
    </button>
  );
}

const searchInput: CSSProperties = {
  background: '#fff', border: '1px solid #dfe2ec', borderRadius: 999, padding: '7px 14px 7px 34px', fontSize: 13, width: 210, outline: 'none', fontFamily: 'inherit',
};

export default function EventsPage() {
  const { overview } = useClusterData();
  const [tab, setTab] = useState<'user' | 'system'>('user');
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [rangeKey, setRangeKey] = useState('3d');
  const [tick, setTick] = useState(0);

  // filters
  const [search, setSearch] = useState('');
  const [fUser, setFUser] = useState('');
  const [fOp, setFOp] = useState('');
  const [fNs, setFNs] = useState('');
  const [fType, setFType] = useState('');
  const [fLabel, setFLabel] = useState('');
  const [fAnn, setFAnn] = useState('');
  const [wlMeta, setWlMeta] = useState<Record<string, { labels?: Record<string, string>; annotations?: Record<string, string> }>>({});
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(15);

  // workload labels/annotations for the label/annotation filter chips.
  useEffect(() => {
    let dead = false;
    getJson<{ workloads?: { namespace: string; name: string; labels?: Record<string, string>; annotations?: Record<string, string> }[] }>('/api/workloads')
      .then((d) => {
        if (dead) return;
        const m: Record<string, { labels?: Record<string, string>; annotations?: Record<string, string> }> = {};
        for (const w of d.workloads || []) m[w.namespace + '|' + w.name] = { labels: w.labels, annotations: w.annotations };
        setWlMeta(m);
      })
      .catch(() => {});
    return () => { dead = true; };
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 30000);
    return () => window.clearInterval(id);
  }, []);
  useEffect(() => {
    let dead = false;
    getJson<AuditsResponse>('/api/audits')
      .then((d) => !dead && setRows(d.audits || []))
      .catch(() => {});
    return () => { dead = true; };
  }, [tick]);

  // reset page when tab/filters change
  useEffect(() => setPage(0), [tab, rangeKey, search, fUser, fOp, fNs, fType, fLabel, fAnn, pageSize]);

  const range = RANGES.find((r) => r.key === rangeKey) || RANGES[0];
  const norm = useMemo(() => rows.map(normalize), [rows]);
  const cutoff = useMemo(() => Date.now() - range.ms, [range, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  const tabRows = useMemo(
    () => norm.filter((r) => (tab === 'system' ? r.isSystem : !r.isSystem) && r.ts >= cutoff),
    [norm, tab, cutoff],
  );

  const userOptions = useMemo(() => [...new Set(norm.filter((r) => !r.isSystem && r.user).map((r) => r.user))].sort(), [norm]);
  const opOptions = useMemo(() => [...new Set(tabRows.map((r) => r.operation).filter(Boolean))].sort(), [tabRows]);
  const nsOptions = useMemo(() => [...new Set(norm.filter((r) => r.isSystem && r.namespace).map((r) => r.namespace))].sort(), [norm]);
  const typeOptions = useMemo(() => [...new Set(norm.filter((r) => r.isSystem && r.workloadType).map((r) => r.workloadType))].sort(), [norm]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    // "key=value" matcher against the event's workload metadata.
    const kvMatch = (filter: string, attrs?: Record<string, string>) => {
      if (!filter.trim()) return true;
      if (!attrs) return false;
      const [k, ...rest] = filter.split('=');
      const v = rest.join('=');
      if (!(k in attrs)) return false;
      return v === '' || attrs[k] === v;
    };
    return tabRows.filter((r) => {
      if (fOp && r.operation !== fOp) return false;
      if (tab === 'user') {
        if (fUser && r.user !== fUser) return false;
      } else {
        if (fNs && r.namespace !== fNs) return false;
        if (fType && r.workloadType !== fType) return false;
        if (fLabel.trim() || fAnn.trim()) {
          const meta = wlMeta[r.namespace + '|' + (r.raw.workloadName || '')];
          if (!kvMatch(fLabel, meta?.labels)) return false;
          if (!kvMatch(fAnn, meta?.annotations)) return false;
        }
      }
      if (q) {
        const hay = (r.operation + ' ' + r.message + ' ' + r.user + ' ' + r.startTime + ' ' + r.namespace).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [tabRows, fOp, fUser, fNs, fType, fLabel, fAnn, wlMeta, search, tab]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const pageRows = filtered.slice(page * pageSize, page * pageSize + pageSize);

  const exportCsv = () => {
    if (tab === 'user') {
      downloadCsv(
        'Events.csv',
        ['Start Time', 'Operation', 'User', 'Message'],
        filtered.map((r) => [r.startTime, r.operation, r.user, r.message]),
      );
    } else {
      downloadCsv(
        'SystemEvents.csv',
        ['Start Time', 'Operation', 'Message'],
        filtered.map((r) => [r.startTime, r.operation, r.message]),
      );
    }
  };

  return (
    <main style={{ padding: 20 }}>
      {/* tabs */}
      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid #eef0f6', marginBottom: 4 }}>
        <TabBtn active={tab === 'user'} onClick={() => setTab('user')}>User Events</TabBtn>
        <TabBtn active={tab === 'system'} onClick={() => setTab('system')}>CoolScaler Events</TabBtn>
      </div>

      <section className="card" style={{ padding: 24, overflow: 'visible' }}>
        <div style={{ fontSize: 22, fontWeight: 700, color: '#1e2536' }}>{tab === 'user' ? 'User Events' : 'CoolScaler Events'}</div>
        <div style={{ fontSize: 13, color: '#64748b', marginTop: 4, marginBottom: 18, maxWidth: 640 }}>
          {tab === 'user'
            ? 'Track user actions like policy changes and automation updates. Search for specific messages and filter by date.'
            : 'Track CoolScaler ongoing operations such as pod eviction and optimization. Search for specific messages and filter by date and workload parameters.'}
        </div>

        {/* filter row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
          <div style={{ position: 'relative' }}>
            <svg style={{ width: 14, height: 14, color: '#94a3b8', position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)' }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <circle cx="11" cy="11" r="7" />
              <path d="M21 21l-4-4" />
            </svg>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="search..." style={searchInput} />
          </div>
          {tab === 'user' ? (
            <>
              <ChipPick label="users" value={fUser} options={userOptions} onChange={setFUser} />
              <ChipPick label="operations" value={fOp} options={opOptions} onChange={setFOp} />
            </>
          ) : (
            <>
              <ChipPick label="namespaces" value={fNs} options={nsOptions} onChange={setFNs} />
              <ChipPick label="types" value={fType} options={typeOptions} onChange={setFType} />
              <ChipPick label="operations" value={fOp} options={opOptions} onChange={setFOp} />
              <input value={fLabel} onChange={(e) => setFLabel(e.target.value)} placeholder="label key=value" title="Filter by workload label (key or key=value)" style={{ ...searchInput, width: 140, padding: '7px 12px' }} />
              <input value={fAnn} onChange={(e) => setFAnn(e.target.value)} placeholder="annotation key=value" title="Filter by workload annotation (key or key=value)" style={{ ...searchInput, width: 160, padding: '7px 12px' }} />
            </>
          )}
          <div style={{ flex: 1 }} />
          <div style={{ display: 'inline-flex', border: '1px solid #e3e5ee', borderRadius: 8, overflow: 'hidden' }}>
            {RANGES.map((r) => (
              <button
                key={r.key}
                onClick={() => setRangeKey(r.key)}
                style={{
                  border: 'none', background: r.key === rangeKey ? '#eef2ff' : '#fff', color: r.key === rangeKey ? '#4338ca' : '#64748b',
                  fontWeight: r.key === rangeKey ? 700 : 500, fontFamily: 'inherit', fontSize: 13, padding: '7px 16px', cursor: 'pointer',
                }}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        {/* table */}
        <div style={{ border: '1px solid #eef0f6', borderRadius: 10, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ ...th, width: 190 }}>Start Time</th>
                <th style={{ ...th, width: tab === 'user' ? 260 : 300 }}>Operation</th>
                {tab === 'user' && <th style={{ ...th, width: 200 }}>User</th>}
                <th style={th}>Message</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((r, i) => (
                <tr key={i}>
                  <td style={{ ...td, whiteSpace: 'nowrap', color: '#475569' }}>{r.startTime}</td>
                  <td style={{ ...td, fontWeight: 500 }}>{r.operation}</td>
                  {tab === 'user' && <td style={td}>{r.user || <span style={{ color: '#cbd5e1' }}>—</span>}</td>}
                  <td style={td}>{r.message}</td>
                </tr>
              ))}
              {!pageRows.length && (
                <tr>
                  <td style={{ ...td, textAlign: 'center', color: '#94a3b8', padding: '48px 0' }} colSpan={tab === 'user' ? 4 : 3}>
                    No rows
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* footer: export + pagination */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 14, flexWrap: 'wrap', gap: 12 }}>
          <button
            onClick={exportCsv}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: '1px solid #e3e5ee', borderRadius: 999, background: '#fff', color: '#475569', fontSize: 13, fontWeight: 600, fontFamily: 'inherit', padding: '7px 16px', cursor: 'pointer' }}
          >
            Export
            <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M12 3v12M7 10l5 5 5-5M5 21h14" /></svg>
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, fontSize: 13, color: '#64748b' }}>
            <span>Rows per page:</span>
            <select value={pageSize} onChange={(e) => setPageSize(+e.target.value)} style={{ border: '1px solid #e3e5ee', borderRadius: 6, padding: '3px 6px', fontFamily: 'inherit', fontSize: 13 }}>
              {PAGE_SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <span>
              {filtered.length ? page * pageSize + 1 : 0}–{Math.min(filtered.length, (page + 1) * pageSize)} of {filtered.length}
            </span>
            <div style={{ display: 'flex', gap: 4 }}>
              <button disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))} style={pgBtn(page === 0)}>‹</button>
              <button disabled={page >= pageCount - 1} onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))} style={pgBtn(page >= pageCount - 1)}>›</button>
            </div>
          </div>
        </div>
      </section>

      <footer style={{ textAlign: 'center', fontSize: 12, color: '#94a3b8', paddingTop: 16 }}>
        CoolScaler - Events - {overview?.clusterName || ''}
      </footer>
    </main>
  );
}

const pgBtn = (disabled: boolean): CSSProperties => ({
  border: '1px solid #e3e5ee', borderRadius: 6, background: '#fff', color: disabled ? '#cbd5e1' : '#475569',
  width: 28, height: 28, cursor: disabled ? 'default' : 'pointer', fontSize: 16, lineHeight: 1,
});
