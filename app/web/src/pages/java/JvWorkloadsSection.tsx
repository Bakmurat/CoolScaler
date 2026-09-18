// Java workloads table — the JVM-specific columns (-Xmx, Java-aware rec, …)
// stay available via Columns but default OFF.
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { postJson } from '../../api/client';
import { useFeedback } from '../../providers/FeedbackProvider';
import { usd, coresFmt, mibFmt, memFmt } from '../../lib/format';
import { policyPillColors } from '../rightsizing/lib';
import { Dropdown, MenuItem, PolicyIcon, Toggle, usePolicyNames } from '../rightsizing/ui';
import type { JavaActionResponse, JavaWorkload } from './types';

// ---------- shared bits ----------

export function Pill({ bg, color, border, title, children }: { bg: string; color: string; border?: string; title?: string; children: ReactNode }) {
  return (
    <span className="pill" title={title} style={{ background: bg, color, border: border ? '1px solid ' + border : undefined }}>
      {children}
    </span>
  );
}

export function StatusPill({ w }: { w: JavaWorkload }) {
  if (w.injectionFatal)
    return (
      <Pill bg="#fff1f2" color="#e11d48" border="#fecdd3" title={w.injectionGap || ''}>
        injection gap
      </Pill>
    );
  if (w.status === 'oom-risk')
    return (
      <Pill bg="#fff1f2" color="#e11d48" border="#ffe4e6">
        OOM risk
      </Pill>
    );
  if (w.status === 'over-provisioned')
    return (
      <Pill bg="#fffbeb" color="#d97706" border="#fde68a">
        over-provisioned
      </Pill>
    );
  if (w.status === 'ok')
    return (
      <Pill bg="#f0fdf4" color="#16a34a" border="#dcfce7">
        ok
      </Pill>
    );
  return <span>{w.status}</span>;
}

// ---------- accessors (feature-detect NEW backend fields, honest fallbacks) ----------

const jkey = (w: JavaWorkload) => w.namespace + '/' + w.kind + '/' + w.name;
const sav = (w: JavaWorkload) => w.savingsAvailable ?? w.savings ?? 0;
const cpuReq = (w: JavaWorkload) => w.cpuRequest ?? null; // NEW field — no fallback
const memReq = (w: JavaWorkload) => w.memoryRequest ?? w.memRequest ?? null;
const running = (w: JavaWorkload) => w.replicasRunning ?? w.replicas ?? 0;
const desired = (w: JavaWorkload) => w.replicasDesired ?? w.replicas ?? 0;
const isAuto = (w: JavaWorkload) => (w.automated != null ? w.automated : !!w.javaAuto);

type ObsState = 'real usage' | 'injected' | 'pending restart' | 'disabled';
function obsState(w: JavaWorkload, obsEnabled: boolean): ObsState {
  if (w.realUsage) return 'real usage';
  if (w.observability) return 'injected';
  return obsEnabled ? 'pending restart' : 'disabled';
}

function ObsPill({ w, obsEnabled }: { w: JavaWorkload; obsEnabled: boolean }) {
  const s = obsState(w, obsEnabled);
  if (s === 'real usage')
    return (
      <Pill bg="#f0fdf4" color="#16a34a" border="#dcfce7">
        JMX active · real heap
      </Pill>
    );
  if (s === 'injected')
    return (
      <Pill bg="#ecfdf5" color="#059669" border="#d1fae5">
        JMX injected
      </Pill>
    );
  if (s === 'pending restart')
    return (
      <Pill bg="#fffbeb" color="#d97706" border="#fde68a">
        pending restart
      </Pill>
    );
  return (
    <Pill bg="#f1f5f9" color="#94a3b8">
      disabled
    </Pill>
  );
}

// ---------- filters ----------

type ChipName = 'automated' | 'unautomated' | 'savings' | 'spark' | 'oom' | 'overprov' | 'xmx' | 'gap' | 'hpa';
const MORE_CHIPS: ChipName[] = ['oom', 'overprov', 'xmx', 'gap', 'hpa'];
const CHIP_LABEL: Record<ChipName, string> = {
  automated: 'automated',
  unautomated: 'unautomated',
  savings: 'savings',
  spark: 'spark executors',
  oom: 'OOM risk',
  overprov: 'over provisioned',
  xmx: 'with -Xmx',
  gap: 'injection gap',
  hpa: 'has HPA',
};

interface ExtraFilters {
  ns: string;
  obs: string;
  label: string;
}
const EMPTY_EXTRA: ExtraFilters = { ns: '', obs: '', label: '' };

function kvMatch(q: string, obj?: Record<string, string>): boolean {
  q = (q || '').trim();
  if (!q) return true;
  const i = q.indexOf('=');
  const k = i < 0 ? q : q.slice(0, i);
  const v = i < 0 ? null : q.slice(i + 1);
  const o = obj || {};
  return k in o && (v == null || v === '' || o[k] === v);
}

function passChips(w: JavaWorkload, chips: Set<ChipName>, ex: ExtraFilters): boolean {
  if (chips.has('automated') && !isAuto(w)) return false;
  if (chips.has('unautomated') && isAuto(w)) return false;
  if (chips.has('savings') && !(sav(w) > 0)) return false;
  if (chips.has('spark') && !(w.image + ' ' + w.name).toLowerCase().includes('spark')) return false;
  if (chips.has('oom') && w.status !== 'oom-risk') return false;
  if (chips.has('overprov') && w.status !== 'over-provisioned') return false;
  if (chips.has('xmx') && !(w.xmx > 0)) return false;
  if (chips.has('gap') && !w.injectionFatal) return false;
  if (chips.has('hpa') && !w.hpaManaged) return false;
  if (ex.ns && w.namespace !== ex.ns) return false;
  if (ex.obs === 'excluded' && !w.obsExcluded) return false;
  if (ex.obs === 'enabled' && w.obsExcluded) return false;
  if (!kvMatch(ex.label, w.labels)) return false;
  return true;
}

// ---------- sorting / columns ----------

type SortKey = 'name' | 'savings' | 'cpu' | 'memUsage' | 'mem' | 'replicas' | 'policy' | 'automated';
const SORT_VAL: Record<SortKey, (w: JavaWorkload) => number | string> = {
  name: (w) => (w.namespace + '/' + w.name).toLowerCase(),
  savings: (w) => sav(w),
  cpu: (w) => cpuReq(w) ?? -1,
  memUsage: (w) => w.memUsage || 0,
  mem: (w) => memReq(w) ?? -1,
  replicas: (w) => desired(w),
  policy: (w) => (w.policyName || '').toLowerCase(),
  automated: (w) => (isAuto(w) ? 1 : 0),
};

// JVM-specific ones default OFF (Columns picker).
const ALL_COLS: [string, string, boolean][] = [
  ['savings', 'Savings Available', true],
  ['cpu', 'CPU Request', true],
  ['memUsage', 'Memory Usage', true],
  ['mem', 'Memory Request', true],
  ['replicas', 'Replicas', true],
  ['policy', 'Policy', true],
  ['automated', 'Automated', true],
  ['xmx', '-Xmx', false],
  ['jvmRec', 'Java-aware rec', false],
  ['recXmx', 'Rec -Xmx', false],
  ['obs', 'Observability', false],
  ['status', 'Status', false],
];

const thStyle: CSSProperties = {
  fontWeight: 600,
  padding: '10px 8px',
  cursor: 'pointer',
  userSelect: 'none',
  whiteSpace: 'nowrap',
};
const subTh: CSSProperties = { fontSize: 9, fontWeight: 400, color: '#cbd5e1', textTransform: 'none' };
const AUTO_DETECT = '__auto_detect__';

// ---------- component ----------

export default function JvWorkloadsSection({
  rows: rows0,
  obsEnabled,
  connError,
  ro,
  onReload,
  onOpenWorkload,
}: {
  rows: JavaWorkload[];
  obsEnabled: boolean;
  connError: boolean;
  ro: boolean;
  onReload: (ms: number) => void;
  onOpenWorkload: (w: JavaWorkload) => void;
}) {
  const { toast, confirm } = useFeedback();
  const policyNames = usePolicyNames();

  const [tab, setTab] = useState<'workloads' | 'agg'>('workloads');
  const [search, setSearch] = useState('');
  const [chips, setChips] = useState<Set<ChipName>>(new Set());
  const [ex, setEx] = useState<ExtraFilters>(EMPTY_EXTRA);
  const [moreOpen, setMoreOpen] = useState(false);
  const [labelOpen, setLabelOpen] = useState(false);
  const [colsOpen, setColsOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [cols, setCols] = useState<Set<string>>(new Set(ALL_COLS.filter((c) => c[2]).map((c) => c[0])));
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'savings', dir: -1 });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const filtered = useMemo(() => {
    const f = search.toLowerCase();
    const rows = rows0.filter(
      (w) =>
        passChips(w, chips, ex) &&
        (!f || (w.namespace + '/' + w.name + ' ' + w.container).toLowerCase().includes(f)),
    );
    const sv = SORT_VAL[sort.key];
    rows.sort((a, b) => {
      const x = sv(a);
      const y = sv(b);
      return x < y ? -sort.dir : x > y ? sort.dir : 0;
    });
    return rows;
  }, [rows0, chips, ex, search, sort]);

  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const curPage = Math.min(Math.max(1, page), pages);
  const start = (curPage - 1) * pageSize;
  const pageRows = filtered.slice(start, start + pageSize);

  const nsOptions = useMemo(() => [...new Set(rows0.map((w) => w.namespace))].sort(), [rows0]);

  useEffect(() => {
    setSelected((prev) => {
      const present = new Set(rows0.map(jkey));
      const next = new Set([...prev].filter((k) => present.has(k)));
      return next.size === prev.size ? prev : next;
    });
  }, [rows0]);

  const toggleChip = (c: ChipName) => {
    setChips((prev) => {
      const n = new Set(prev);
      if (n.has(c)) n.delete(c);
      else n.add(c);
      return n;
    });
    setPage(1);
  };
  const setExF = (patch: Partial<ExtraFilters>) => {
    setEx((p) => ({ ...p, ...patch }));
    setPage(1);
  };
  const moreCnt = MORE_CHIPS.filter((c) => chips.has(c)).length;

  const sortBy = (key: SortKey) => {
    setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: key === 'name' || key === 'policy' ? 1 : -1 }));
    setPage(1);
  };
  const arrow = (key: SortKey) => (sort.key !== key ? <span style={{ color: '#e2e8f0' }}>↕</span> : sort.dir < 0 ? <>↓</> : <>↑</>);
  const dataCol = (k: string): CSSProperties => (cols.has(k) ? {} : { display: 'none' });

  // ---------- row actions ----------

  // Automated toggle — same pattern as the rightsizing rows, java automation endpoint.
  const toggleAuto = async (w: JavaWorkload, on: boolean) => {
    if (ro) {
      toast('Cluster is in READ-ONLY mode.\nSet readOnly: false in Helm values to enable automation.');
      return;
    }
    try {
      const r = await postJson<JavaActionResponse>('/api/java/action', {
        scope: 'workload',
        action: on ? 'automate' : 'unautomate',
        targets: [{ namespace: w.namespace, kind: w.kind, name: w.name }],
      });
      if (r.ok === false) toast('Failed: ' + (r.message || ''));
      else {
        w.automated = on;
        w.javaAuto = on;
        toast(w.name + (on ? ' automated.' : ' un-automated.'), 'ok');
      }
    } catch {
      toast('Failed to update automation.');
    }
    onReload(600);
  };

  // Policy attach — SAME endpoint the rightsizing rows use (/api/attach-policy).
  const attachPolicy = async (w: JavaWorkload, pol: string) => {
    if (ro) {
      toast('Read-only mode — cannot attach policy.');
      return;
    }
    try {
      const j = await postJson<{ ok?: boolean; message?: string }>('/api/attach-policy', {
        namespace: w.namespace,
        kind: w.kind,
        name: w.name,
        policy: pol,
      });
      if (j.ok) {
        w.policyName = pol;
        toast(`Policy "${pol}" attached to ${w.name}.`, 'ok');
      } else toast('Could not attach policy: ' + (j.message || ''));
    } catch {
      toast('Request failed.');
    }
    onReload(600);
  };
  const restorePolicy = async (w: JavaWorkload) => {
    try {
      await postJson('/api/restore-policy', { namespace: w.namespace, kind: w.kind, name: w.name });
      toast('Restored suggested policy on ' + w.name, 'ok');
    } catch {
      toast('Restore failed');
    }
    onReload(600);
  };


  const nSel = selected.size;
  const nsSel = [...new Set([...selected].map((k) => k.split('/')[0]))];

  const jvAction = async (action: string) => {
    const targets = [...selected].map((k) => {
      const [ns, kind, name] = k.split('/');
      return { namespace: ns, kind, name };
    });
    if (!targets.length) {
      toast('Select workloads first.');
      return;
    }
    const verb =
      (
        {
          automate: 'automate',
          unautomate: 'un-automate',
          'exclude-observability': 'exclude from observability',
          'include-observability': 'include in observability',
          rollout: 'roll out',
        } as Record<string, string>
      )[action] || action;
    if (!(await confirm(`${verb[0].toUpperCase() + verb.slice(1)} ${targets.length} Java workload(s)? This rolls the affected workloads.`)))
      return;
    setActionsOpen(false);
    try {
      const r = await postJson<JavaActionResponse>('/api/java/action', { scope: 'workload', action, targets });
      toast(r.ok === false ? 'Failed: ' + (r.message || '') : `${verb} · ${r.count} workload(s).`, r.ok === false ? undefined : 'ok');
    } catch {
      toast('Request failed.');
    }
    onReload(700);
  };

  const jvNsAction = async (action: 'automate' | 'unautomate') => {
    const namespaces = nsSel;
    if (!namespaces.length) {
      toast('Select workloads first.');
      return;
    }
    if (
      !(await confirm(
        `${action === 'automate' ? 'Automate' : 'Un-automate'} Java optimization for namespace(s): ${namespaces.join(', ')}? (writes AutomatedNamespace.javaOptimize)`,
      ))
    )
      return;
    setActionsOpen(false);
    try {
      const r = await postJson<JavaActionResponse>('/api/java/action', { scope: 'namespace', action, namespaces });
      toast(
        r.ok === false ? 'Failed: ' + (r.message || '') : `Namespace java automation ${action === 'automate' ? 'on' : 'off'} · ${r.count} ns.`,
        r.ok === false ? undefined : 'ok',
      );
    } catch {
      toast('Request failed.');
    }
    onReload(600);
  };

  // ---------- Export CSV ----------

  const exportCsv = () => {
    const esc = (v: unknown) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const head = ['Workload', 'Container', 'Savings Available ($/mo)', 'CPU Request (cores)', 'Memory Usage (bytes)', 'Memory Request (bytes)', 'Replicas Running', 'Replicas Desired', 'Policy', 'Automated', '-Xmx (bytes)', 'Java-aware rec (bytes)', 'Rec -Xmx (bytes)', 'Observability', 'Status'];
    const lines = filtered.map((w) =>
      [
        w.namespace + '/' + w.name,
        w.container,
        Math.round(sav(w) * 100) / 100,
        cpuReq(w) ?? '',
        w.memUsage ?? '',
        memReq(w) ?? '',
        running(w),
        desired(w),
        w.policyName || '',
        isAuto(w),
        w.xmx || '',
        w.memRec ?? '',
        w.recommendedXmx || '',
        obsState(w, obsEnabled),
        w.status,
      ]
        .map(esc)
        .join(','),
    );
    const blob = new Blob([head.join(',') + '\n' + lines.join('\n') + '\n'], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'java-workloads.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  // ---------- aggregation rows (per-namespace rollup, rightsizing pattern) ----------

  const aggRows = useMemo(() => {
    const by: Record<string, { n: number; sav: number; cpu: number; use: number; mem: number; rep: number; auto: number }> = {};
    filtered.forEach((w) => {
      const g = (by[w.namespace] = by[w.namespace] || { n: 0, sav: 0, cpu: 0, use: 0, mem: 0, rep: 0, auto: 0 });
      g.n++;
      g.sav += Math.max(sav(w), 0);
      g.cpu += (cpuReq(w) || 0) * desired(w);
      g.use += (w.memUsage || 0) * desired(w);
      g.mem += (memReq(w) || 0) * desired(w);
      g.rep += desired(w);
      if (isAuto(w)) g.auto++;
    });
    return Object.entries(by).sort((a, b) => b[1].sav - a[1].sav);
  }, [filtered]);

  const sectionHdr: CSSProperties = { fontSize: 10, textTransform: 'uppercase', letterSpacing: '.04em', color: '#94a3b8', padding: '4px 12px 2px' };

  return (
    <section className="card" style={{ overflow: 'visible', position: 'relative' }}>
      {/* tabs */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '12px 16px 0', borderBottom: '1px solid #eef0f5' }}>
        <span className={'tab' + (tab === 'workloads' ? ' active' : '')} onClick={() => setTab('workloads')}>Workloads</span>
        <span className={'tab' + (tab === 'agg' ? ' active' : '')} onClick={() => setTab('agg')}>Aggregation</span>
      </div>

      {/* filters + Columns + Java Actions */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px 0', flexWrap: 'wrap' }}>
        <div style={{ position: 'relative' }}>
          <svg style={{ width: 16, height: 16, color: '#94a3b8', position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)' }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4-4" />
          </svg>
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="search…"
            style={{ background: '#fff', border: '1px solid #dfe2ec', borderRadius: 999, padding: '6px 12px 6px 36px', fontSize: 14, width: 180, outline: 'none', fontFamily: 'inherit' }}
          />
        </div>
        {(['automated', 'unautomated', 'savings'] as ChipName[]).map((c) => (
          <span key={c} className={'chip' + (chips.has(c) ? ' on' : '')} onClick={() => toggleChip(c)}>
            {CHIP_LABEL[c]}
          </span>
        ))}
        <ChipSelect label="namespaces" value={ex.ns} options={nsOptions} onChange={(v) => setExF({ ns: v })} />
        {/* labels — key=value chip (matches nothing until the backend ships labels) */}
        <div style={{ position: 'relative' }}>
          <span className={'chip' + (ex.label.trim() ? ' on' : '')} onClick={() => setLabelOpen((o) => !o)}>
            {ex.label.trim() ? 'labels: ' + ex.label : 'labels'}{' '}
            {ex.label.trim() ? (
              <span
                onClick={(e) => {
                  e.stopPropagation();
                  setExF({ label: '' });
                  setLabelOpen(false);
                }}
                style={{ marginLeft: 4, fontWeight: 700, cursor: 'pointer' }}
              >
                ✕
              </span>
            ) : (
              <span style={{ marginLeft: 2 }}>▾</span>
            )}
          </span>
          <Dropdown open={labelOpen} onClose={() => setLabelOpen(false)} style={{ left: 0, width: 220, padding: 10 }}>
            <label style={{ fontSize: 11, color: '#64748b', display: 'block' }}>
              labels <span style={{ color: '#cbd5e1' }}>key=value</span>
              <input
                className="chip"
                style={{ width: '100%', marginTop: 2, cursor: 'text' }}
                placeholder="app=web"
                value={ex.label}
                onChange={(e) => setExF({ label: e.target.value })}
              />
            </label>
          </Dropdown>
        </div>
        <span className={'chip' + (chips.has('spark') ? ' on' : '')} onClick={() => toggleChip('spark')}>
          {CHIP_LABEL.spark}
        </span>
        <ChipSelect
          label="java observability"
          value={ex.obs}
          options={['enabled', 'excluded']}
          onChange={(v) => setExF({ obs: v })}
        />
        <div style={{ position: 'relative' }}>
          <span className="chip" onClick={() => setMoreOpen((o) => !o)}>
            + More filters{' '}
            {moreCnt > 0 && (
              <span style={{ marginLeft: 2, padding: '0 4px', borderRadius: 999, background: '#e0e7ff', color: '#4f46e5', fontSize: 10 }}>{moreCnt}</span>
            )}{' '}
            ▾
          </span>
          <Dropdown open={moreOpen} onClose={() => setMoreOpen(false)} style={{ left: 0, width: 360, padding: 12 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {MORE_CHIPS.map((c) => (
                <span key={c} className={'chip' + (chips.has(c) ? ' on' : '')} onClick={() => toggleChip(c)}>
                  {CHIP_LABEL[c]}
                </span>
              ))}
            </div>
          </Dropdown>
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ position: 'relative' }}>
          <button onClick={() => setColsOpen((o) => !o)} style={toolBtn('#fff', '#3d4254', 'none')}>
            <svg style={{ width: 16, height: 16 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
              <path d="M1.5 12S5.5 5 12 5s10.5 7 10.5 7-4 7-10.5 7S1.5 12 1.5 12z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            Columns
          </button>
          <Dropdown open={colsOpen} onClose={() => setColsOpen(false)} style={{ right: 0, width: 208, padding: 6 }}>
            {ALL_COLS.map(([k, l]) => (
              <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderRadius: 8, cursor: 'pointer', fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={cols.has(k)}
                  onChange={(e) => {
                    setCols((prev) => {
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
          </Dropdown>
        </div>
        <div style={{ position: 'relative', marginBottom: 8 }}>
          <button onClick={() => setActionsOpen((o) => !o)} style={{ ...toolBtn('#fff', '#6366f1', 'none'), padding: '6px 14px' }}>
            Java Actions
            {nSel > 0 && (
              <span style={{ marginLeft: 2, padding: '0 6px', borderRadius: 999, background: 'rgba(255,255,255,.25)', fontSize: 11, lineHeight: 1.6 }}>{nSel}</span>
            )}
          </button>
          <Dropdown open={actionsOpen} onClose={() => setActionsOpen(false)} style={{ right: 0, width: 288, padding: 8, fontSize: 12 }}>
            <div style={sectionHdr}>Workload · {nSel} selected</div>
            <MenuItem label="Automate Java optimization" enabled={!!nSel} onClick={() => void jvAction('automate')} />
            <MenuItem label="Un-automate" enabled={!!nSel} onClick={() => void jvAction('unautomate')} />
            <MenuItem label="Exclude from observability" enabled={!!nSel} onClick={() => void jvAction('exclude-observability')} />
            <MenuItem label="Include in observability" enabled={!!nSel} onClick={() => void jvAction('include-observability')} />
            <MenuItem label="Rollout" enabled={!!nSel} onClick={() => void jvAction('rollout')} />
            <div style={{ borderTop: '1px solid #eef0f6', margin: '4px 0' }} />
            <div style={sectionHdr}>Namespace ({nsSel.length})</div>
            <MenuItem label="Automate namespace(s)" enabled={!!nsSel.length} onClick={() => void jvNsAction('automate')} />
            <MenuItem label="Un-automate namespace(s)" enabled={!!nsSel.length} onClick={() => void jvNsAction('unautomate')} />
          </Dropdown>
        </div>
      </div>

      <div style={{ height: 12 }} />

      {/* table */}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', fontSize: 14, borderCollapse: 'collapse' }}>
          <thead style={{ color: '#94a3b8', fontSize: 11, textTransform: 'uppercase', letterSpacing: '.04em', background: '#fafbfd', borderTop: '1px solid #eef0f5', borderBottom: '1px solid #eef0f5' }}>
            <tr>
              <th style={{ width: 36, padding: '10px 0 10px 16px' }}>
                <input
                  type="checkbox"
                  checked={filtered.length > 0 && filtered.every((w) => selected.has(jkey(w)))}
                  onChange={(e) => {
                    setSelected((prev) => {
                      const n = new Set(prev);
                      filtered.forEach((w) => (e.target.checked ? n.add(jkey(w)) : n.delete(jkey(w))));
                      return n;
                    });
                  }}
                />
              </th>
              <th style={{ ...thStyle, textAlign: 'left', paddingLeft: 0 }} onClick={() => sortBy('name')}>
                Workload <span className="num">{arrow('name')}</span>
              </th>
              <th style={{ ...thStyle, textAlign: 'right', ...dataCol('savings') }} onClick={() => sortBy('savings')}>
                Savings Available <span className="num">{arrow('savings')}</span>
                <div style={subTh}>(monthly)</div>
              </th>
              <th style={{ ...thStyle, textAlign: 'right', ...dataCol('cpu') }} onClick={() => sortBy('cpu')}>
                CPU Request <span className="num">{arrow('cpu')}</span>
                <div style={subTh}>(per replica)</div>
              </th>
              <th style={{ ...thStyle, textAlign: 'right', ...dataCol('memUsage') }} onClick={() => sortBy('memUsage')}>
                Memory Usage <span className="num">{arrow('memUsage')}</span>
                <div style={subTh}>(per replica)</div>
              </th>
              <th style={{ ...thStyle, textAlign: 'right', ...dataCol('mem') }} onClick={() => sortBy('mem')}>
                Memory Request <span className="num">{arrow('mem')}</span>
                <div style={subTh}>(per replica)</div>
              </th>
              <th style={{ ...thStyle, textAlign: 'center', ...dataCol('replicas') }} onClick={() => sortBy('replicas')}>
                Replicas <span className="num">{arrow('replicas')}</span>
                <div style={subTh}>(running/desired)</div>
              </th>
              <th style={{ ...thStyle, textAlign: 'left', ...dataCol('xmx'), cursor: 'default' }}>-Xmx</th>
              <th style={{ ...thStyle, textAlign: 'left', ...dataCol('jvmRec'), cursor: 'default' }}>Java-aware rec</th>
              <th style={{ ...thStyle, textAlign: 'left', ...dataCol('recXmx'), cursor: 'default' }}>Rec -Xmx</th>
              <th style={{ ...thStyle, textAlign: 'left', ...dataCol('obs'), cursor: 'default' }}>Observability</th>
              <th style={{ ...thStyle, textAlign: 'left', ...dataCol('status'), cursor: 'default' }}>Status</th>
              <th style={{ ...thStyle, textAlign: 'left', ...dataCol('policy') }} onClick={() => sortBy('policy')}>
                Policy <span className="num">{arrow('policy')}</span>
              </th>
              <th style={{ ...thStyle, textAlign: 'center', paddingRight: 16, ...dataCol('automated') }} onClick={() => sortBy('automated')}>
                Automated <span className="num">{arrow('automated')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {connError ? (
              <tr>
                <td colSpan={14} style={{ padding: '24px 20px', textAlign: 'center', color: '#94a3b8' }}>
                  connection error
                </td>
              </tr>
            ) : tab === 'agg' ? (
              aggRows.map(([nsName, g]) => (
                <tr key={nsName} className="wlrow" style={{ borderBottom: '1px solid #f1f2f7' }}>
                  <td style={{ padding: '12px 0 12px 16px' }} />
                  <td style={{ padding: '12px 0' }}>
                    <div style={{ fontWeight: 600, color: '#1e2536' }}>{nsName}</div>
                    <div style={{ fontSize: 11, color: '#94a3b8' }}>
                      {g.n} workload{g.n === 1 ? '' : 's'} · {g.auto} automated
                    </div>
                  </td>
                  <td style={{ textAlign: 'right', paddingRight: 8, ...dataCol('savings') }}>
                    {g.sav > 0.5 ? <span style={{ fontWeight: 600, color: '#16a34a' }}>{usd(g.sav)}</span> : <span style={{ color: '#cbd5e1' }}>$0</span>}
                  </td>
                  <td className="num" style={{ textAlign: 'right', paddingRight: 8, color: '#475569', ...dataCol('cpu') }}>
                    {g.cpu ? coresFmt(g.cpu) : '—'}
                  </td>
                  <td className="num" style={{ textAlign: 'right', paddingRight: 8, color: '#475569', ...dataCol('memUsage') }}>{mibFmt(g.use)}</td>
                  <td className="num" style={{ textAlign: 'right', paddingRight: 8, color: '#475569', ...dataCol('mem') }}>{mibFmt(g.mem)}</td>
                  <td className="num" style={{ textAlign: 'center', color: '#475569', ...dataCol('replicas') }}>{g.rep}</td>
                  <td style={dataCol('xmx')} />
                  <td style={dataCol('jvmRec')} />
                  <td style={dataCol('recXmx')} />
                  <td style={dataCol('obs')} />
                  <td style={dataCol('status')} />
                  <td style={{ color: '#cbd5e1', fontSize: 11, ...dataCol('policy') }}>–</td>
                  <td className="num" style={{ textAlign: 'center', color: '#475569', paddingRight: 16, ...dataCol('automated') }}>
                    {g.n ? Math.round((g.auto / g.n) * 100) : 0}%
                  </td>
                </tr>
              ))
            ) : (
              pageRows.map((w) => (
                <JvRow
                  key={jkey(w) + '/' + w.container}
                  w={w}
                  ro={ro}
                  obsEnabled={obsEnabled}
                  cols={cols}
                  policyNames={policyNames}
                  selected={selected.has(jkey(w))}
                  onSelect={(on) =>
                    setSelected((prev) => {
                      const n = new Set(prev);
                      if (on) n.add(jkey(w));
                      else n.delete(jkey(w));
                      return n;
                    })
                  }
                  onOpen={() => onOpenWorkload(w)}
                  onToggleAuto={(on) => void toggleAuto(w, on)}
                  onAttachPolicy={(p) => void attachPolicy(w, p)}
                  onRestore={() => void restorePolicy(w)}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
      {!connError && ((tab === 'agg' && !aggRows.length) || (tab === 'workloads' && !filtered.length)) && (
        <div style={{ textAlign: 'center', color: '#94a3b8', fontSize: 14, padding: '40px 0' }}>
          {rows0.length ? 'No workloads match your filters.' : 'no Java workloads detected (by image keyword / JAVA_OPTS / -Xmx)'}
        </div>
      )}

      {/* footer: Export + pagination */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', fontSize: 12, color: '#94a3b8', borderTop: '1px solid #eef0f5' }}>
        <button onClick={exportCsv} style={{ ...toolBtn('#475569', '#fff', '1px solid #dfe2ec'), fontSize: 12, borderRadius: 999, padding: '4px 12px' }}>
          Export
          <svg style={{ width: 12, height: 12 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M12 4v11m0 0l-4-4m4 4l4-4M4 20h16" />
          </svg>
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            Rows per page
            <select
              value={pageSize}
              onChange={(e) => {
                setPageSize(+e.target.value);
                setPage(1);
              }}
              style={{ background: '#f4f5f8', border: '1px solid #e9eaf0', borderRadius: 6, padding: '4px 6px', outline: 'none', cursor: 'pointer' }}
            >
              {[25, 50, 100].map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          </label>
          <span className="num">
            {tab === 'agg'
              ? aggRows.length
                ? `1–${aggRows.length} of ${aggRows.length}`
                : '0 of 0'
              : filtered.length
                ? `${start + 1}–${Math.min(start + pageSize, filtered.length)} of ${filtered.length}`
                : '0 of 0'}
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <button disabled={tab === 'agg' || curPage <= 1} onClick={() => setPage((p) => p - 1)} style={pgBtn}>‹</button>
            <button disabled={tab === 'agg' || curPage >= pages} onClick={() => setPage((p) => p + 1)} style={pgBtn}>›</button>
          </div>
        </div>
      </div>
    </section>
  );
}

// ---------- one workload row ----------

function JvRow({
  w,
  ro,
  obsEnabled,
  cols,
  policyNames,
  selected,
  onSelect,
  onOpen,
  onToggleAuto,
  onAttachPolicy,
  onRestore,
}: {
  w: JavaWorkload;
  ro: boolean;
  obsEnabled: boolean;
  cols: Set<string>;
  policyNames: string[];
  selected: boolean;
  onSelect: (on: boolean) => void;
  onOpen: () => void;
  onToggleAuto: (on: boolean) => void;
  onAttachPolicy: (p: string) => void;
  onRestore: () => void;
}) {
  const dataCol = (k: string): CSSProperties => (cols.has(k) ? {} : { display: 'none' });
  const td: CSSProperties = { padding: '12px 8px', fontSize: 12 };
  const pol = w.policyName || 'java';
  const [pillBg, pillFg] = policyPillColors(pol);
  const auto = isAuto(w);
  const run = running(w);
  const des = desired(w);
  const s = sav(w);
  const dotColor = w.injectionFatal || w.status === 'oom-risk' ? '#f43f5e' : w.status === 'over-provisioned' ? '#f59e0b' : '#34d399';

  return (
    <tr
      className="wlrow"
      title="Open workload"
      style={{ borderBottom: '1px solid #f1f2f7', background: auto ? 'rgba(209,250,229,.4)' : undefined, cursor: 'pointer' }}
      onClick={onOpen}
    >
      <td style={{ padding: '12px 0 12px 16px' }} onClick={(e) => e.stopPropagation()}>
        <input type="checkbox" checked={selected} onChange={(e) => onSelect(e.target.checked)} />
      </td>
      <td style={{ ...td, paddingLeft: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <span title={w.status} style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: dotColor, flexShrink: 0 }} />
          <span style={{ fontWeight: 600, color: '#1e2536', fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {w.namespace}/{w.name}
          </span>
          {w.hpaManaged && (
            <span className="pill" style={{ background: '#ede9fe', color: '#7c3aed', marginLeft: 2 }}>HPA</span>
          )}
        </div>
        <div style={{ fontSize: 10, color: '#94a3b8', marginLeft: 14 }}>
          {w.kind} · {w.container}
        </div>
      </td>
      <td style={{ ...td, textAlign: 'right', ...dataCol('savings') }}>
        {s > 0.5 ? <span style={{ fontWeight: 600, color: '#16a34a', fontSize: 13 }}>{usd(s)}</span> : <span style={{ color: '#cbd5e1', fontSize: 13 }}>$0</span>}
      </td>
      <td className="num" style={{ ...td, textAlign: 'right', color: '#475569', fontSize: 13, ...dataCol('cpu') }}>
        {cpuReq(w) != null ? coresFmt(cpuReq(w)) : <span style={{ color: '#cbd5e1' }}>—</span>}
      </td>
      <td className="num" style={{ ...td, textAlign: 'right', color: '#475569', fontSize: 13, ...dataCol('memUsage') }}>{mibFmt(w.memUsage)}</td>
      <td className="num" style={{ ...td, textAlign: 'right', color: '#475569', fontSize: 13, ...dataCol('mem') }}>{mibFmt(memReq(w))}</td>
      <td className="num" style={{ ...td, textAlign: 'center', ...dataCol('replicas') }}>
        <span
          title={`${run} running / ${des} desired`}
          style={{ color: run < des ? '#d97706' : '#475569', fontWeight: run < des ? 600 : 400, fontSize: 13 }}
        >
          {run} / {des}
        </span>
      </td>
      <td className="num" style={{ ...td, color: '#475569', ...dataCol('xmx') }}>
        {w.xmx ? memFmt(w.xmx) : <span style={{ color: '#cbd5e1' }}>unset</span>}
      </td>
      <td className="num" style={{ ...td, fontWeight: 600, color: '#16a34a', ...dataCol('jvmRec') }}>{memFmt(w.memRec)}</td>
      <td className="num" style={{ ...td, color: '#ea580c', ...dataCol('recXmx') }}>
        {w.recommendedXmx ? memFmt(w.recommendedXmx) : '—'}
      </td>
      <td style={{ ...td, ...dataCol('obs') }}>
        <ObsPill w={w} obsEnabled={obsEnabled} />
      </td>
      <td style={{ ...td, ...dataCol('status') }}>
        <StatusPill w={w} />
      </td>
      <td style={{ ...td, ...dataCol('policy') }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }} onClick={(e) => e.stopPropagation()}>
          <span className="pill" style={{ background: pillBg, color: pillFg, fontWeight: 500, display: 'inline-flex', alignItems: 'center', gap: 2 }}>
            <PolicyIcon />
            <select
              disabled={ro}
              title={ro ? 'Read-only mode' : 'Attach a policy to this workload'}
              value={pol}
              onChange={(e) => {
                if (e.target.value === AUTO_DETECT) onRestore();
                else onAttachPolicy(e.target.value);
              }}
              style={{ background: 'transparent', fontWeight: 500, border: 'none', outline: 'none', color: 'inherit', cursor: ro ? 'not-allowed' : 'pointer', fontFamily: 'inherit', fontSize: 11 }}
            >
              <option value={AUTO_DETECT}>Auto detect</option>
              {policyNames.map((p) => (
                <option key={p}>{p}</option>
              ))}
              {!policyNames.includes(pol) && <option key={pol}>{pol}</option>}
            </select>
          </span>
        </div>
      </td>
      <td style={{ ...td, textAlign: 'center', paddingRight: 16, ...dataCol('automated') }}>
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }} onClick={(e) => e.stopPropagation()}>
          <Toggle
            checked={auto}
            disabled={ro}
            onChange={onToggleAuto}
            title={ro ? 'Read-only — enable automation in Helm values' : 'Automate Java optimization for this workload'}
          />
        </div>
      </td>
    </tr>
  );
}

/** Pill-styled filter dropdown (rightsizing ChipSelect pattern — not exported there). */
function ChipSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
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
            ✕
          </span>
        ) : (
          <span style={{ marginLeft: 2 }}>▾</span>
        )}
      </span>
      <Dropdown open={open} onClose={() => setOpen(false)} style={{ left: 0, minWidth: 176, maxHeight: 280, overflowY: 'auto', padding: 6 }}>
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

function toolBtn(color: string, bg: string, border: string): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 14,
    fontWeight: 600,
    color,
    background: bg,
    border,
    borderRadius: 8,
    padding: '6px 12px',
    cursor: 'pointer',
    fontFamily: 'inherit',
  };
}

const pgBtn: CSSProperties = {
  padding: '4px 8px',
  borderRadius: 6,
  border: '1px solid #e9eaf0',
  background: '#fff',
  cursor: 'pointer',
  fontFamily: 'inherit',
  color: '#64748b',
};
