// Replicas ▸ Downscale surface
import { useCallback, useEffect, useMemo, useState } from 'react';
import { getJson, postJson } from '../../api/client';
import { useFeedback } from '../../providers/FeedbackProvider';
import { useClusterData } from '../../providers/ClusterDataProvider';
import { usd, cpuFmt, memFmt } from '../../lib/format';
import { Dropdown, Toggle } from '../rightsizing/ui';
import AllocReqChart, { useAllocReqSeries } from './AllocReqChart';
import DsScheduleDrawer, { type DsDrawerMode } from './DsScheduleDrawer';
import type { DownscaleResponse, DsSchedule } from './types';

const DOW = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

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
const td: React.CSSProperties = { padding: '12px', fontSize: 13, color: '#64748b' };
const chipStyle = (on: boolean): React.CSSProperties => ({
  fontSize: 12,
  fontWeight: 500,
  borderRadius: 999,
  padding: '4px 12px',
  border: on ? '1px solid #6366f1' : '1px solid #e3e5ee',
  background: on ? '#6366f1' : '#fff',
  color: on ? '#fff' : '#64748b',
  cursor: 'pointer',
  fontFamily: 'inherit',
});
const filtSelStyle: React.CSSProperties = {
  fontSize: 12,
  borderRadius: 999,
  padding: '4px 10px',
  border: '1px solid #e3e5ee',
  color: '#64748b',
  background: '#fff',
  cursor: 'pointer',
  fontFamily: 'inherit',
  outline: 'none',
};

const WEEK_MIN = 7 * 24 * 60;

/**
 * Shift the UTC-stored 7×24 window grid for display. Windows are stored in
 * UTC; when "Show in UTC" is unchecked we shift each displayed hour cell by
 * the local timezone offset (display cell (d,h) shows the UTC hour that
 * occurs at local time d/h).
 */
function displayGrid(grid: DsSchedule['windows'], utc: boolean): boolean[][] {
  const offsetMin = utc ? 0 : -new Date().getTimezoneOffset(); // local = UTC + offset
  return Array.from({ length: 7 }, (_, d) =>
    Array.from({ length: 24 }, (_, h) => {
      const utcTotal = (((d * 24 + h) * 60 - offsetMin) % WEEK_MIN + WEEK_MIN) % WEEK_MIN;
      const ud = Math.floor(utcTotal / 1440);
      const uh = Math.floor((utcTotal % 1440) / 60);
      return !!(grid?.[ud] as (boolean | number)[] | undefined)?.[uh];
    }),
  );
}

/** Current day (Mon=0) + fractional hour in the displayed timezone. */
function nowMarker(utc: boolean): { day: number; hour: number } {
  const n = new Date();
  const jsDay = utc ? n.getUTCDay() : n.getDay(); // 0=Sun
  return {
    day: (jsDay + 6) % 7, // Mon=0
    hour: (utc ? n.getUTCHours() : n.getHours()) + (utc ? n.getUTCMinutes() : n.getMinutes()) / 60,
  };
}

/** Contiguous on-runs of a 24h day column → [startHour, length] blocks. */
function dayRuns(col: boolean[]): [number, number][] {
  const runs: [number, number][] = [];
  let start = -1;
  for (let h = 0; h <= 24; h++) {
    const on = h < 24 && col[h];
    if (on && start < 0) start = h;
    if (!on && start >= 0) {
      runs.push([start, h - start]);
      start = -1;
    }
  }
  return runs;
}

function Heatmap({ grid, utc }: { grid: DsSchedule['windows']; utc: boolean }) {
  const g = displayGrid(grid, utc);
  const cur = nowMarker(utc);
  const H = 64;
  return (
    <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
      {/* hour axis */}
      <div style={{ position: 'relative', width: 26, height: H + 14, flexShrink: 0, marginTop: 10 }}>
        {[0, 12, 24].map((h) => (
          <div
            key={h}
            className="num"
            style={{
              position: 'absolute',
              top: (h / 24) * H - 4,
              right: 0,
              fontSize: 7.5,
              color: '#94a3b8',
              lineHeight: 1,
            }}
          >
            {String(h).padStart(2, '0')}:00
          </div>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 5, flex: 1 }}>
        {Array.from({ length: 7 }, (_, d) => {
          const today = d === cur.day;
          return (
            <div key={d}>
              <div
                style={{
                  fontSize: 7,
                  fontWeight: 700,
                  letterSpacing: '.06em',
                  textAlign: 'center',
                  height: 10,
                  color: '#1e2536',
                  visibility: today ? 'visible' : 'hidden',
                }}
              >
                TODAY
              </div>
              <div
                style={{
                  position: 'relative',
                  height: H,
                  background: '#fff',
                  border: today ? '1.5px solid #1e2536' : '1px solid #e3e5ee',
                  borderRadius: 3,
                  overflow: 'hidden',
                }}
              >
                {/* faint midday guide */}
                <div style={{ position: 'absolute', top: '50%', left: 0, right: 0, borderTop: '1px dashed #e7e9f0' }} />
                {dayRuns(g[d]).map(([start, len], i) => (
                  <div
                    key={i}
                    style={{
                      position: 'absolute',
                      left: 0,
                      right: 0,
                      top: (start / 24) * 100 + '%',
                      height: (len / 24) * 100 + '%',
                      background: '#818cf8',
                    }}
                  />
                ))}
                {today && (
                  <div
                    style={{
                      position: 'absolute',
                      left: 0,
                      right: 0,
                      top: (cur.hour / 24) * 100 + '%',
                      borderTop: '2px solid #1e2536',
                    }}
                  />
                )}
              </div>
              <div
                style={{
                  fontSize: 9,
                  textAlign: 'center',
                  marginTop: 2,
                  color: today ? '#1e2536' : '#94a3b8',
                  fontWeight: today ? 700 : 400,
                }}
              >
                {DOW[d]}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ScheduleCard({
  s,
  showUtc,
  onEdit,
  onDelete,
}: {
  s: DsSchedule;
  showUtc: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const active = s.activeNow;
  return (
    <div
      style={{
        borderRadius: 12,
        border: active ? '1px solid #c7d2fe' : '1px solid #eef0f5',
        background: active ? 'rgba(238,242,255,.4)' : '#fff',
        padding: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontWeight: 600, color: '#1e2536', fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
          {s.name}
          {active && (
            <span className="pill" style={{ background: '#ecfdf5', color: '#059669', fontSize: 10 }}>
              ACTIVE NOW
            </span>
          )}
        </div>
        {!s.builtIn && (
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <button title="Edit" onClick={onEdit} style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#94a3b8' }}>
              <svg style={{ width: 14, height: 14 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
              </svg>
            </button>
            <button
              title="Delete"
              onClick={onDelete}
              style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#94a3b8', marginLeft: 4 }}
            >
              <svg style={{ width: 14, height: 14 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />
              </svg>
            </button>
          </div>
        )}
      </div>
      <a style={{ fontSize: 11, color: '#6366f1', fontWeight: 500 }}>{s.attachedWorkloads} attached workloads</a>
      <div style={{ marginTop: 6, fontSize: 11, color: '#64748b' }}>
        <div>
          ⇕ Set HPA workloads to min <b>{s.hpaMinReplicas}</b> replica
        </div>
        <div>
          — Scale non-HPA workloads down to <b>{s.targetReplicas}</b> replica
        </div>
      </div>
      <Heatmap grid={s.windows} utc={showUtc} />
    </div>
  );
}

export default function DownscaleTab() {
  const { toast } = useFeedback();
  const { confirm } = useFeedback();
  const { ro: RO } = useClusterData();
  const [data, setData] = useState<DownscaleResponse | null>(null);
  const DS_COLS: [string, string][] = [
    ['cpu', 'CPU Request'], ['mem', 'Memory Request'], ['gpu', 'GPU Request'], ['replicas', 'Replicas'],
  ];
  const [dsCols, setDsCols] = useState<Set<string>>(new Set(DS_COLS.map((c) => c[0])));
  const [dsColsOpen, setDsColsOpen] = useState(false);
  const colStyle = (k: string) => (dsCols.has(k) ? {} : { display: 'none' as const });
  const [range, setRange] = useState<'7d' | '30d'>('7d');
  const series = useAllocReqSeries(range);
  const [pane, setPane] = useState<'wl' | 'agg'>('wl');
  const [filter, setFilter] = useState('');
  const [filt, setFilt] = useState({ automated: false, unautomated: false, savings: false, downscaled: false, namespace: '', schedule: '' });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [actionsOpen, setActionsOpen] = useState(false);
  const [nsScope, setNsScope] = useState('');
  const [drawer, setDrawer] = useState<DsDrawerMode>(null);
  const [showUtc, setShowUtc] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await getJson<DownscaleResponse>('/api/downscale'));
    } catch {
      /* keep last */
    }
  }, []);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), 30000);
    return () => window.clearInterval(t);
  }, [load]);

  const t = data?.totals || {};
  // The live backend currently returns duplicate schedule cards — dedupe by
  // name defensively (keep first) until the backend fix lands.
  const schedules = useMemo(() => {
    const seen = new Set<string>();
    return (data?.schedules || []).filter((s) => {
      if (seen.has(s.name)) return false;
      seen.add(s.name);
      return true;
    });
  }, [data]);
  const schedNames = schedules.map((s) => s.name);
  const workloads = useMemo(() => data?.workloads || [], [data]);
  const nsList = useMemo(() => [...new Set(workloads.map((w) => w.namespace))].sort(), [workloads]);

  const toggleFilt = (k: 'automated' | 'unautomated' | 'savings' | 'downscaled') =>
    setFilt((prev) => {
      const next = { ...prev, [k]: !prev[k] };
      if (k === 'automated' && next.automated) next.unautomated = false;
      if (k === 'unautomated' && next.unautomated) next.automated = false;
      return next;
    });

  const q = filter.toLowerCase();
  const rows = workloads.filter((w) => {
    if (q && !(w.namespace + '/' + w.name).toLowerCase().includes(q)) return false;
    if (filt.automated && !w.automated) return false;
    if (filt.unautomated && w.automated) return false;
    if (filt.savings && !((w.savings || 0) > 0.5)) return false;
    if (filt.downscaled && !w.currentlyDownscaled) return false;
    if (filt.namespace && w.namespace !== filt.namespace) return false;
    if (filt.schedule && w.schedule !== filt.schedule) return false;
    return true;
  });

  const dsArrow = (a: number, b: number, fmt: (v?: number | null) => string) =>
    a === b ? (
      <span style={{ color: '#64748b' }}>{fmt(a)}</span>
    ) : (
      <span>
        <span style={{ color: '#64748b' }}>{fmt(a)}</span> <span style={{ color: '#16a34a' }}>→</span>{' '}
        <span style={{ color: '#16a34a', fontWeight: 600 }}>{fmt(b)}</span>
      </span>
    );

  const bulk = async (action: string, sched?: string) => {
    if (RO) {
      toast('Cluster is in READ-ONLY mode.');
      return;
    }
    const keys = [...selected];
    if (!keys.length) {
      toast('Select one or more workloads first.');
      return;
    }
    await postJson('/api/downscale-bulk', { action, keys, schedule: sched }).catch(() => {});
    setActionsOpen(false);
    toast(`${action}: applied to ${keys.length} workload(s).`);
    void load();
  };

  const automateNs = async (on: boolean) => {
    if (!nsScope) {
      toast('Choose a namespace first.');
      return;
    }
    if (RO) {
      toast('Cluster is in READ-ONLY mode.');
      return;
    }
    await postJson('/api/downscale-automate-ns', { namespace: nsScope, enabled: on }).catch(() => {});
    toast('Namespace ' + nsScope + (on ? ' automated' : ' un-automated') + ' for downscale');
    void load();
  };

  const agg = useMemo(() => {
    const m: Record<string, { save: number; cpu: number; mem: number; n: number; auto: number }> = {};
    workloads.forEach((w) => {
      const a = (m[w.namespace] = m[w.namespace] || { save: 0, cpu: 0, mem: 0, n: 0, auto: 0 });
      a.save += w.savings || 0;
      a.cpu += (w.reqCpu || 0) * w.replicas;
      a.mem += (w.reqMem || 0) * w.replicas;
      a.n++;
      if (w.automated) a.auto++;
    });
    return m;
  }, [workloads]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Top tiles */}
      <section className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)' }}>
          <div style={{ padding: 24, textAlign: 'center', borderRight: '1px solid #eef0f6' }}>
            <div style={{ fontSize: 13, fontWeight: 500, color: '#64748b' }}>
              Monthly cost <span style={{ color: '#cbd5e1' }}>(live)</span>
            </div>
            <div className="num" style={{ marginTop: 4, fontSize: 30, lineHeight: 1, fontWeight: 800, letterSpacing: '-.02em', color: '#4f46e5' }}>
              {usd(t.monthlyCost || 0)}
            </div>
            <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 4, fontSize: 10, borderTop: '1px solid #f1f2f7', paddingTop: 8 }}>
              <div>
                <div style={{ color: '#94a3b8' }}>CPU req</div>
                <div className="num" style={{ color: '#059669', fontWeight: 600 }}>{cpuFmt(t.cpuSaved || 0)}</div>
              </div>
              <div>
                <div style={{ color: '#94a3b8' }}>Mem req</div>
                <div className="num" style={{ color: '#059669', fontWeight: 600 }}>{memFmt(t.memSaved || 0)}</div>
              </div>
              <div>
                <div style={{ color: '#94a3b8' }}>GPU req</div>
                <div className="num" style={{ color: '#059669', fontWeight: 600 }}>{Math.round(t.gpuSaved || 0)}</div>
              </div>
            </div>
            <div style={{ fontSize: 9, color: '#94a3b8', marginTop: 4 }}>Resource savings (monthly average)</div>
          </div>
          <div style={{ padding: 24, textAlign: 'center', borderRight: '1px solid #eef0f6' }}>
            <div style={{ fontSize: 13, fontWeight: 500, color: '#64748b' }}>Wasted spend</div>
            <div className="num" style={{ marginTop: 4, fontSize: 30, lineHeight: 1, fontWeight: 700, color: '#f43f5e' }}>
              {Math.round(t.wastedPct || 0)}%
            </div>
            <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>savings if more workloads automated</div>
          </div>
          <div style={{ padding: 24, textAlign: 'center', borderRight: '1px solid #eef0f6' }}>
            <div
              style={{ fontSize: 13, fontWeight: 500, color: '#64748b' }}
              title="Automated workloads whose schedule window is active right now — projected from the schedule, not measured replica state"
            >
              Active scaled down workloads
            </div>
            <div className="num" style={{ marginTop: 4, fontSize: 30, lineHeight: 1, fontWeight: 700, color: '#1e2536' }}>
              {t.activeScaledDown || 0}
            </div>
            <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 2 }}>schedule-projected</div>
          </div>
          <div style={{ padding: 24, textAlign: 'center', borderRight: '1px solid #eef0f6' }}>
            <div style={{ fontSize: 13, fontWeight: 500, color: '#64748b' }}>Downscaler workloads</div>
            <div className="num" style={{ marginTop: 4, fontSize: 30, lineHeight: 1, fontWeight: 700, color: '#1e2536' }}>
              {t.downscalerWorkloads || 0}
            </div>
          </div>
          <div style={{ padding: 24, textAlign: 'center' }}>
            <div style={{ fontSize: 13, fontWeight: 500, color: '#64748b' }}>Automated</div>
            <div
              className="num"
              style={{
                marginTop: 4,
                fontSize: 30,
                lineHeight: 1,
                fontWeight: 700,
                color: (t.automated || 0) > 0 ? '#059669' : '#94a3b8',
              }}
            >
              {Math.round(((t.automated || 0) / Math.max(t.downscalerWorkloads || 1, 1)) * 100)}%
            </div>
            <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>
              {t.readOnly ? 'read-only — schedules defined, not enforced' : (t.automated || 0) + ' automated · schedule-projected (detection)'}
            </div>
          </div>
        </div>
      </section>

      {/* CPU / Memory over time */}
      <section className="card" style={{ padding: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#1e2536' }}>
            Resource graphs <span style={{ fontSize: 11, fontWeight: 400, color: '#94a3b8' }}>(cluster requests over time)</span>
          </div>
          <div style={{ display: 'inline-flex', alignItems: 'center', background: '#f1f2f7', borderRadius: 8, padding: 2 }}>
            {(['7d', '30d'] as const).map((r) => (
              <span key={r} className={'seg' + (range === r ? ' active' : '')} onClick={() => setRange(r)}>
                {r === '7d' ? '7 Days' : '30 Days'}
              </span>
            ))}
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#64748b', marginBottom: 4, textAlign: 'center' }}>
              CPU over time <span style={{ fontSize: 10, color: '#94a3b8' }}>(allocatable vs requested)</span>
            </div>
            <AllocReqChart values={series} resource="cpu" height={176} />
          </div>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#64748b', marginBottom: 4, textAlign: 'center' }}>
              Memory over time <span style={{ fontSize: 10, color: '#94a3b8' }}>(allocatable vs requested)</span>
            </div>
            <AllocReqChart values={series} resource="memory" height={176} />
          </div>
        </div>
      </section>

      {/* Schedule policies */}
      <section className="card" style={{ padding: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#1e2536' }}>Schedule policies</div>
            <div style={{ fontSize: 12, color: '#64748b' }}>{schedules.length} schedule policies configured</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <label
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: '#475569',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                cursor: 'pointer',
                userSelect: 'none',
              }}
              title="Schedule windows are stored in UTC — toggle to view them without the local timezone shift"
            >
              <input type="checkbox" checked={showUtc} onChange={(e) => setShowUtc(e.target.checked)} />
              <svg style={{ width: 13, height: 13, color: '#64748b' }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v5l3 2" />
              </svg>
              Show in UTC
            </label>
            <button
              onClick={() => {
                if (RO) {
                  toast('Cluster is in READ-ONLY mode.');
                  return;
                }
                setDrawer({ kind: 'new' });
              }}
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: '#fff',
                background: '#6366f1',
                borderRadius: 8,
                padding: '6px 12px',
                border: 'none',
                cursor: 'pointer',
                fontFamily: 'inherit',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <svg style={{ width: 14, height: 14 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path d="M12 5v14M5 12h14" />
              </svg>
              New Schedule Policy
            </button>
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 16 }}>
          {schedules.map((s) => (
            <ScheduleCard
              key={s.name}
              s={s}
              showUtc={showUtc}
              onEdit={() => {
                if (RO) {
                  toast('Cluster is in READ-ONLY mode.');
                  return;
                }
                setDrawer({ kind: 'edit', schedule: s });
              }}
              onDelete={() => {
                void (async () => {
                  if (RO) {
                    toast('Cluster is in READ-ONLY mode.');
                    return;
                  }
                  if (!(await confirm('Delete schedule policy "' + s.name + '"?\n\nWorkloads using it revert to the nights schedule.')))
                    return;
                  const r = await postJson<{ ok?: boolean }>('/api/downscale-policy/delete', { name: s.name }).catch(
                    () => ({}) as { ok?: boolean },
                  );
                  if (r?.ok) {
                    toast('Schedule deleted.');
                    void load();
                  } else toast('Delete failed', 'error');
                })();
              }}
            />
          ))}
        </div>
        {/* legend */}
        <div
          style={{
            marginTop: 14,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 18,
            fontSize: 11,
            color: '#475569',
          }}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ height: 10, width: 14, borderRadius: 3, background: '#818cf8' }} />
            Scale down
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ height: 10, width: 14, borderRadius: 3, background: '#eef0f6', border: '1px solid #e3e5ee' }} />
            No scale down
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ height: 2, width: 16, background: '#1e2536' }} />
            <b style={{ fontWeight: 600 }}>Current time</b>
          </span>
        </div>
      </section>

      {/* Downscaler workloads */}
      <section className="card" style={{ padding: 0, overflow: 'hidden' }}>
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
          <div style={{ display: 'flex', gap: 4 }}>
            {(['wl', 'agg'] as const).map((id) => (
              <button
                key={id}
                onClick={() => setPane(id)}
                style={{
                  padding: '6px 12px',
                  fontSize: 13,
                  fontWeight: 600,
                  border: 'none',
                  background: 'none',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  borderBottom: pane === id ? '2px solid #6366f1' : '2px solid transparent',
                  color: pane === id ? '#4f46e5' : '#94a3b8',
                }}
              >
                {id === 'wl' ? 'Workloads' : 'Aggregation'}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Search workloads…"
              style={{
                background: '#f4f5f8',
                border: '1px solid #e9eaf0',
                borderRadius: 8,
                padding: '6px 12px',
                fontSize: 14,
                width: 160,
                outline: 'none',
                fontFamily: 'inherit',
              }}
            />
            <div style={{ position: 'relative' }}>
              <button
                onClick={() => setDsColsOpen((v) => !v)}
                style={{ border: '1px solid #e3e5ee', borderRadius: 8, background: '#334155', color: '#fff', fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit', padding: '6px 14px', cursor: 'pointer' }}
              >
                Columns
              </button>
              {dsColsOpen && (
                <div style={{ position: 'absolute', top: '110%', left: 0, zIndex: 30, background: '#fff', border: '1px solid #e3e5ee', borderRadius: 10, boxShadow: '0 8px 24px rgba(15,23,42,.12)', padding: 10, minWidth: 180 }} onClick={(e) => e.stopPropagation()}>
                  {DS_COLS.map(([k, lab]) => (
                    <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: '#334155', padding: '4px 2px', cursor: 'pointer' }}>
                      <input type="checkbox" checked={dsCols.has(k)} onChange={() => setDsCols((prev) => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n; })} />
                      {lab}
                    </label>
                  ))}
                </div>
              )}
            </div>
            <button style={chipStyle(filt.automated)} onClick={() => toggleFilt('automated')}>
              automated
            </button>
            <button style={chipStyle(filt.unautomated)} onClick={() => toggleFilt('unautomated')}>
              unautomated
            </button>
            <button style={chipStyle(filt.savings)} onClick={() => toggleFilt('savings')}>
              savings
            </button>
            <button
              style={chipStyle(filt.downscaled)}
              onClick={() => toggleFilt('downscaled')}
              title="Automated + schedule window active now (projected)"
            >
              currently downscaled
            </button>
            <select value={filt.schedule} onChange={(e) => setFilt({ ...filt, schedule: e.target.value })} style={filtSelStyle}>
              <option value="">schedule policies</option>
              {schedNames.map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
            <select value={filt.namespace} onChange={(e) => setFilt({ ...filt, namespace: e.target.value })} style={filtSelStyle}>
              <option value="">namespaces</option>
              {nsList.map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
            <div style={{ position: 'relative' }}>
              <button
                onClick={() => setActionsOpen((v) => !v)}
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: '#fff',
                  background: '#6366f1',
                  borderRadius: 8,
                  padding: '6px 12px',
                  border: 'none',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                Downscaler Actions
              </button>
              <Dropdown open={actionsOpen} onClose={() => setActionsOpen(false)} style={{ right: 0, width: 210, padding: '4px 0' }}>
                <div style={{ padding: '4px 12px', fontSize: 10, textTransform: 'uppercase', letterSpacing: '.05em', color: '#94a3b8', fontWeight: 700 }}>
                  {selected.size} selected
                </div>
                <button onClick={() => void bulk('automate')} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 12px', fontSize: 13, border: 'none', background: 'none', cursor: 'pointer', fontFamily: 'inherit', color: '#334155' }}>
                  Enable automation
                </button>
                <button onClick={() => void bulk('unautomate')} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 12px', fontSize: 13, border: 'none', background: 'none', cursor: 'pointer', fontFamily: 'inherit', color: '#334155' }}>
                  Disable automation
                </button>
                <div style={{ borderTop: '1px solid #f1f2f7', margin: '4px 0' }} />
                <div style={{ padding: '4px 12px', fontSize: 10, textTransform: 'uppercase', letterSpacing: '.05em', color: '#94a3b8', fontWeight: 700 }}>
                  Attach schedule
                </div>
                <select
                  defaultValue=""
                  onChange={(e) => {
                    if (e.target.value) void bulk('attach', e.target.value);
                  }}
                  style={{ margin: '0 12px 4px', fontSize: 12, border: '1px solid #e9eaf0', borderRadius: 4, padding: '4px 8px', width: 'calc(100% - 24px)' }}
                >
                  <option value="">choose…</option>
                  {schedNames.map((n) => (
                    <option key={n}>{n}</option>
                  ))}
                </select>
                <div style={{ borderTop: '1px solid #f1f2f7', margin: '4px 0' }} />
                <div style={{ padding: '4px 12px', fontSize: 10, textTransform: 'uppercase', letterSpacing: '.05em', color: '#94a3b8', fontWeight: 700 }}>
                  Namespace scope
                </div>
                <select
                  value={nsScope}
                  onChange={(e) => setNsScope(e.target.value)}
                  style={{ margin: '0 12px 4px', fontSize: 12, border: '1px solid #e9eaf0', borderRadius: 4, padding: '4px 8px', width: 'calc(100% - 24px)' }}
                >
                  <option value="">choose namespace…</option>
                  {nsList.map((n) => (
                    <option key={n}>{n}</option>
                  ))}
                </select>
                <button onClick={() => void automateNs(true)} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 12px', fontSize: 13, border: 'none', background: 'none', cursor: 'pointer', fontFamily: 'inherit', color: '#334155' }}>
                  Automate namespace
                </button>
                <button onClick={() => void automateNs(false)} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 12px', fontSize: 13, border: 'none', background: 'none', cursor: 'pointer', fontFamily: 'inherit', color: '#334155' }}>
                  Un-automate namespace
                </button>
              </Dropdown>
            </div>
          </div>
        </div>

        {pane === 'wl' ? (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ ...th, paddingLeft: 16, paddingRight: 4 }}>
                    <input
                      type="checkbox"
                      checked={selected.size > 0 && selected.size === workloads.length}
                      onChange={(e) => setSelected(e.target.checked ? new Set(workloads.map((w) => w.key)) : new Set())}
                    />
                  </th>
                  <th style={th}>Workload</th>
                  <th style={th}>
                    Savings Available <span style={{ color: '#cbd5e1' }}>/mo</span>
                  </th>
                  <th style={{ ...th, ...colStyle('cpu') }}>CPU Request</th>
                  <th style={{ ...th, ...colStyle('mem') }}>Memory Request</th>
                  <th style={{ ...th, ...colStyle('gpu') }}>GPU Request</th>
                  <th style={{ ...th, ...colStyle('replicas') }}>Replicas</th>
                  <th style={th}>Schedule Policy</th>
                  <th style={{ ...th, textAlign: 'center' }}>Automated</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={9} style={{ ...td, textAlign: 'center', padding: 24, color: '#94a3b8' }}>
                      no workloads
                    </td>
                  </tr>
                )}
                {rows.slice(0, 300).map((w) => {
                  const optMul = w.downscalable !== false ? w.target : w.replicas;
                  const curCpu = (w.reqCpu || 0) * w.replicas;
                  const optCpu = (w.reqCpu || 0) * optMul;
                  const curMem = (w.reqMem || 0) * w.replicas;
                  const optMem = (w.reqMem || 0) * optMul;
                  return (
                    <tr key={w.key} style={{ borderBottom: '1px solid #f3f4f9' }}>
                      <td style={{ paddingLeft: 16, paddingRight: 4 }}>
                        <input
                          type="checkbox"
                          checked={selected.has(w.key)}
                          onChange={(e) => {
                            const n = new Set(selected);
                            if (e.target.checked) n.add(w.key);
                            else n.delete(w.key);
                            setSelected(n);
                          }}
                        />
                      </td>
                      <td style={{ ...td, fontWeight: 500, color: '#1e2536' }}>
                        {w.namespace}/{w.name} <span style={{ fontSize: 10, color: '#94a3b8' }}>{w.kind}</span>
                        {w.hpaManaged && (
                          <span className="pill" style={{ background: '#f5f3ff', color: '#7c3aed', marginLeft: 4 }}>
                            HPA
                          </span>
                        )}
                        {w.currentlyDownscaled && (
                          <span className="pill" style={{ background: '#eef2ff', color: '#4f46e5', marginLeft: 4 }}>
                            downscaled now
                          </span>
                        )}
                      </td>
                      <td style={td} className="num">
                        {(w.savings || 0) > 0.5 ? (
                          <span style={{ color: '#059669', fontWeight: 600 }}>{usd(w.savings)}</span>
                        ) : (
                          <span style={{ color: '#cbd5e1' }}>$0</span>
                        )}
                      </td>
                      <td style={{ ...td, ...colStyle('cpu') }} className="num">{dsArrow(curCpu, optCpu, cpuFmt)}</td>
                      <td style={{ ...td, ...colStyle('mem') }} className="num">{dsArrow(curMem, optMem, memFmt)}</td>
                      <td style={{ ...td, color: '#94a3b8', ...colStyle('gpu') }} className="num">
                        {w.reqGpu ? Math.round(w.reqGpu * w.replicas) : '0'}
                      </td>
                      <td style={{ ...td, ...colStyle('replicas') }} className="num">
                        {w.replicas} / {optMul}
                      </td>
                      <td style={td}>
                        <select
                          disabled={RO}
                          value={w.schedule || ''}
                          onChange={(e) => {
                            const [ns, kind, name] = w.key.split('/');
                            void postJson('/api/downscale-attach', { namespace: ns, kind, name, schedule: e.target.value })
                              .catch(() => {})
                              .then(() => void load());
                          }}
                          style={{
                            background: '#f5f3ff',
                            color: '#6d28d9',
                            border: '1px solid #ede9fe',
                            borderRadius: 8,
                            padding: '4px 8px',
                            fontSize: 12,
                            fontWeight: 500,
                            outline: 'none',
                            cursor: 'pointer',
                            fontFamily: 'inherit',
                          }}
                        >
                          {schedNames.map((n) => (
                            <option key={n}>{n}</option>
                          ))}
                        </select>
                      </td>
                      <td style={{ ...td, textAlign: 'center' }}>
                        <Toggle
                          checked={!!w.automated}
                          disabled={RO}
                          title={RO ? 'Read-only' : undefined}
                          onChange={(on) => {
                            if (RO) {
                              toast('Cluster is in READ-ONLY mode.');
                              return;
                            }
                            const [ns, kind, name] = w.key.split('/');
                            void postJson('/api/downscale-automate', { namespace: ns, kind, name, enabled: on })
                              .catch(() => {})
                              .then(() => void load());
                          }}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ ...th, paddingLeft: 20 }}>Namespace</th>
                  <th style={th}>
                    Savings Available <span style={{ color: '#cbd5e1' }}>/mo</span>
                  </th>
                  <th style={th}>CPU Request</th>
                  <th style={th}>Memory Request</th>
                  <th style={th}>Workloads</th>
                  <th style={th}>Automation %</th>
                </tr>
              </thead>
              <tbody>
                {Object.keys(agg).length === 0 && (
                  <tr>
                    <td colSpan={6} style={{ ...td, textAlign: 'center', padding: 24, color: '#94a3b8' }}>
                      no workloads
                    </td>
                  </tr>
                )}
                {Object.keys(agg)
                  .sort((x, y) => agg[y].save - agg[x].save)
                  .map((ns) => {
                    const a = agg[ns];
                    const pct = a.n ? Math.round((a.auto / a.n) * 100) : 0;
                    return (
                      <tr key={ns} style={{ borderBottom: '1px solid #f1f2f7' }}>
                        <td style={{ ...td, paddingLeft: 20, fontWeight: 500 }}>namespace:{ns}</td>
                        <td style={td} className="num">
                          {a.save > 0.5 ? <span style={{ color: '#059669', fontWeight: 600 }}>{usd(a.save)}</span> : <span style={{ color: '#cbd5e1' }}>$0</span>}
                        </td>
                        <td style={td} className="num">{cpuFmt(a.cpu)}</td>
                        <td style={td} className="num">{memFmt(a.mem)}</td>
                        <td style={td} className="num">{a.n}</td>
                        <td style={td}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <div style={{ width: 64, height: 6, borderRadius: 4, background: '#f1f5f9', overflow: 'hidden' }}>
                              <div style={{ height: '100%', width: pct + '%', background: '#34d399' }} />
                            </div>
                            <span style={{ fontSize: 11, color: '#64748b' }}>
                              {a.auto} of {a.n}
                            </span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <DsScheduleDrawer mode={drawer} onClose={() => setDrawer(null)} onSaved={() => void load()} />
    </div>
  );
}
