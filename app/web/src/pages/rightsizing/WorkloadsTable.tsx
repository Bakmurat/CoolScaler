// Workloads table section
import {
  forwardRef,
  useMemo,
  useState,
  type CSSProperties,
  type Dispatch,
  type SetStateAction,
} from 'react';
import ClickAwayListener from '@mui/material/ClickAwayListener';
import { postJson } from '../../api/client';
import { usd, coresFmt, mibFmt } from '../../lib/format';
import { useClusterData } from '../../providers/ClusterDataProvider';
import { useFeedback } from '../../providers/FeedbackProvider';
import type { WorkloadRow } from './types';
import {
  AutomatedDot,
  Dropdown,
  HealthDot,
  MenuItem,
  PolicyIcon,
  ReqCell,
  Toggle,
  usePolicyNames,
} from './ui';
import { policyPillColors } from './lib';

export type ChipName =
  | 'automated'
  | 'unautomated'
  | 'savings'
  | 'under'
  | 'hpa'
  | 'capping'
  | 'agentic'
  | 'excluded'
  | 'inits'
  | 'unevictable'
  | 'schedblockers'
  | 'over'
  | 'daemonsets'
  | 'tolerations'
  | 'nodeselectors'
  | 'warnings'
  | 'java';

const MORE_CHIPS: ChipName[] = [
  'over', 'hpa', 'capping', 'excluded', 'inits', 'unevictable', 'schedblockers',
  'daemonsets', 'tolerations', 'nodeselectors', 'warnings', 'java',
];
const CHIP_LABEL: Record<ChipName, string> = {
  automated: 'automated',
  unautomated: 'unautomated',
  savings: 'savings',
  under: 'under provisioned',
  hpa: 'has HPA',
  capping: 'capping',
  agentic: 'agentic workloads',
  excluded: 'automation excluded',
  inits: 'init containers',
  unevictable: 'unevictable',
  schedblockers: 'scheduling blockers',
  over: 'over provisioned',
  daemonsets: 'daemonsets',
  tolerations: 'tolerations',
  nodeselectors: 'node selectors',
  warnings: 'warnings',
  java: 'java workloads',
};

export interface ExtraFilters {
  ns: string;
  pol: string;
  type: string;
  prio: string;
  rollout: string;
  wasted: string;
  label: string;
  anno: string;
}
export const EMPTY_EXTRA: ExtraFilters = { ns: '', pol: '', type: '', prio: '', rollout: '', wasted: '', label: '', anno: '' };

function policyOf(w: WorkloadRow): string {
  return w.policyName || w.policySuggested || 'production';
}
function isUnderProv(w: WorkloadRow): boolean {
  return (
    (w.recCpu != null && w.reqCpu != null && w.recCpu > w.reqCpu * 1.03) ||
    (w.recMem != null && w.reqMem != null && w.recMem > w.reqMem * 1.03)
  );
}
function isCapped(w: WorkloadRow): boolean {
  return (w.containers || []).some((c) => {
    const cp = c.capStatuses || {};
    return !!(cp.cpu && cp.cpu.isCapped) || !!(cp.memory && cp.memory.isCapped);
  });
}
function kvMatch(q: string, obj?: Record<string, string>): boolean {
  q = (q || '').trim();
  if (!q) return true;
  const i = q.indexOf('=');
  const k = i < 0 ? q : q.slice(0, i);
  const v = i < 0 ? null : q.slice(i + 1);
  const o = obj || {};
  return k in o && (v == null || v === '' || o[k] === v);
}

export function passChips(w: WorkloadRow, chips: Set<ChipName>, ex: ExtraFilters): boolean {
  if (chips.has('automated') && !w.automated) return false;
  if (chips.has('unautomated') && w.automated) return false;
  if (chips.has('savings') && !(w.savings > 0.5)) return false;
  if (chips.has('under') && !isUnderProv(w)) return false;
  if (chips.has('hpa') && !w.hpaManaged) return false;
  if (chips.has('capping') && !isCapped(w)) return false;
  if (chips.has('agentic') && !w.agentic) return false;
  if (chips.has('excluded') && !w.excluded) return false;
  if (chips.has('inits') && !(w.initOptimization || []).length) return false;
  if (chips.has('unevictable') && !(w.unevictableReasons || []).length) return false;
  if (chips.has('schedblockers') && !((w.nodeSelectorKeys || []).length || (w.tolerationKeys || []).length)) return false;
  if (chips.has('over') && !(w.savings > 0.5)) return false;
  if (chips.has('daemonsets') && w.kind !== 'DaemonSet') return false;
  if (chips.has('tolerations') && !(w.tolerationKeys || []).length) return false;
  if (chips.has('nodeselectors') && !(w.nodeSelectorKeys || []).length) return false;
  if (chips.has('warnings') && !(w.workloadErrors || []).length) return false;
  if (chips.has('java') && !w.java) return false;
  if (ex.ns && w.namespace !== ex.ns) return false;
  if (ex.pol && (w.policyName || w.policySuggested) !== ex.pol) return false;
  if (ex.type && w.kind !== ex.type) return false;
  if (ex.prio && (w.priorityClass || '') !== ex.prio) return false;
  if (ex.rollout && (w.rolloutStrategy || '') !== ex.rollout) return false;
  if (ex.wasted === 'cpu' && !(w.recCpu != null && (w.reqCpu || 0) > w.recCpu * 1.03)) return false;
  if (ex.wasted === 'memory' && !(w.recMem != null && (w.reqMem || 0) > w.recMem * 1.03)) return false;
  if (!kvMatch(ex.label, w.labels)) return false;
  if (!kvMatch(ex.anno, w.annotations)) return false;
  return true;
}

type SortKey = 'name' | 'savings' | 'active' | 'reqCpu' | 'reqMem' | 'replicas' | 'policy' | 'automated';
const SORT_VAL: Record<SortKey, (w: WorkloadRow) => number | string> = {
  name: (w) => (w.name || '').toLowerCase(),
  savings: (w) => w.savings || 0,
  active: (w) => w.activeSavings || 0,
  reqCpu: (w) => w.reqCpu || 0,
  reqMem: (w) => w.reqMem || 0,
  replicas: (w) => w.replicas || 0,
  policy: (w) => (w.policyName || w.policySuggested || '').toLowerCase(),
  automated: (w) => (w.automated ? 1 : 0),
};

const ALL_COLS: [string, string][] = [
  ['savings', 'Savings Available'],
  ['active', 'Active Savings'],
  ['cost', 'Total Cost'],
  ['cpu', 'CPU Request'],
  ['mem', 'Memory Request'],
  ['origCpu', 'Original CPU Request'],
  ['origMem', 'Original Memory Request'],
  ['eph', 'Ephemeral Storage Request'],
  ['initCpu', 'Init Container CPU Overhead'],
  ['initMem', 'Init Container Memory Overhead'],
  ['wltype', 'Workload Type'],
  ['unevictableCol', 'Unevictable'],
  ['replicas', 'Replicas'],
  ['policy', 'Policy'],
  ['automated', 'Automated'],
];
// the rest live in the Columns menu.
const DEFAULT_COLS = ['savings', 'cpu', 'mem', 'replicas', 'policy', 'automated'];

interface Props {
  chips: Set<ChipName>;
  setChips: Dispatch<SetStateAction<Set<ChipName>>>;
  onOpenDrawer: (w: WorkloadRow) => void;
  /** ?types=<cog name> deep link (Custom Workloads → Explore workloads). */
  typesFilter?: string | null;
  onClearTypes?: () => void;
}

/** ?types= matcher — workload belongs to the named custom-workload group. */
function matchesTypes(w: WorkloadRow, t: string): boolean {
  const extra = w as Record<string, unknown>;
  const cands = [
    w.kind,
    w.smartPolicyWorkloadType,
    w.detectedTag,
    extra.cog,
    extra.cogName,
    extra.customType,
    extra.customWorkloadType,
  ];
  const tl = t.toLowerCase();
  return cands.some((c) => typeof c === 'string' && c.toLowerCase() === tl);
}

const thStyle: CSSProperties = {
  fontWeight: 600,
  padding: '10px 0',
  cursor: 'pointer',
  userSelect: 'none',
  whiteSpace: 'nowrap',
};
const subTh: CSSProperties = { fontSize: 9, fontWeight: 400, color: '#cbd5e1', textTransform: 'none' };

const WorkloadsTable = forwardRef<HTMLDivElement, Props>(function WorkloadsTable(
  { chips, setChips, onOpenDrawer, typesFilter, onClearTypes },
  ref,
) {
  const { workloads, ro, refresh } = useClusterData();
  const rows0 = workloads as WorkloadRow[];
  const { toast, confirm } = useFeedback();
  const policyNames = usePolicyNames();

  const [tab, setTab] = useState<'workloads' | 'agg'>('workloads');
  const [search, setSearch] = useState('');
  const [ex, setEx] = useState<ExtraFilters>(EMPTY_EXTRA);
  const [moreOpen, setMoreOpen] = useState(false);
  const [colsOpen, setColsOpen] = useState(false);
  const [actOpen, setActOpen] = useState(false);
  const [actAcc, setActAcc] = useState({ wl: true, ns: false, cl: false });
  // Active Savings hidden by default
  const [cols, setCols] = useState<Set<string>>(new Set(DEFAULT_COLS));
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'savings', dir: -1 });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [kebab, setKebab] = useState<{ key: string; x: number; y: number } | null>(null);
  const [actPol, setActPol] = useState('production');
  const [actNsPol, setActNsPol] = useState('production');
  const [actClPol, setActClPol] = useState('production');

  const filtered = useMemo(() => {
    const f = search.toLowerCase();
    const rows = rows0.filter(
      (w) =>
        passChips(w, chips, ex) &&
        (!typesFilter || matchesTypes(w, typesFilter)) &&
        (!f || (w.name + w.namespace + w.kind).toLowerCase().includes(f)),
    );
    const sv = SORT_VAL[sort.key];
    rows.sort((a, b) => {
      const x = sv(a);
      const y = sv(b);
      return x < y ? -sort.dir : x > y ? sort.dir : 0;
    });
    return rows;
  }, [rows0, chips, ex, search, sort, typesFilter]);

  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const curPage = Math.min(Math.max(1, page), pages);
  const start = (curPage - 1) * pageSize;
  const pageRows = filtered.slice(start, start + pageSize);

  const nsOptions = useMemo(() => [...new Set(rows0.map((w) => w.namespace))].sort(), [rows0]);
  const polOptions = useMemo(
    () => [...new Set(rows0.map((w) => w.policyName || w.policySuggested).filter(Boolean) as string[])].sort(),
    [rows0],
  );
  const typeOptions = useMemo(() => [...new Set(rows0.map((w) => w.kind))].sort(), [rows0]);
  const prioOptions = useMemo(
    () => [...new Set(rows0.map((w) => w.priorityClass).filter(Boolean) as string[])].sort(),
    [rows0],
  );
  const rolloutOptions = useMemo(
    () => [...new Set(rows0.map((w) => w.rolloutStrategy).filter(Boolean) as string[])].sort(),
    [rows0],
  );

  const moreCnt =
    MORE_CHIPS.filter((c) => chips.has(c)).length +
    (['prio', 'rollout', 'wasted', 'label', 'anno'] as const).filter((k) => (ex[k] || '').trim()).length;

  const toggleChip = (c: ChipName) => {
    setChips((prev) => {
      const n = new Set(prev);
      if (n.has(c)) n.delete(c);
      else n.add(c);
      return n;
    });
    setPage(1);
  };

  const sortBy = (key: SortKey) => {
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === 1 ? -1 : 1 }
        : { key, dir: key === 'name' || key === 'policy' ? 1 : -1 },
    );
    setPage(1);
  };
  const arrow = (key: SortKey) =>
    sort.key !== key ? <span style={{ color: '#e2e8f0' }}>↕</span> : sort.dir < 0 ? <>↓</> : <>↑</>;

  const setExF = (patch: Partial<ExtraFilters>) => {
    setEx((p) => ({ ...p, ...patch }));
    setPage(1);
  };

  // ----- row actions -----
  const toggleAuto = async (w: WorkloadRow, enabled: boolean) => {
    if (ro) {
      toast('Cluster is in READ-ONLY mode.\nSet readOnly: false in Helm values to enable automation.');
      return;
    }
    try {
      await postJson('/api/automate', { key: w.key, enabled });
      w.automated = enabled;
      refresh();
    } catch {
      toast('Failed to update automation.');
    }
  };
  const applyWl = async (w: WorkloadRow) => {
    if (ro) {
      toast('Cluster is in READ-ONLY mode.\nSet readOnly: false in Helm values to apply recommendations.');
      return;
    }
    const hpaNote = w.hpaManaged
      ? '\n\nIts HPA/KEDA utilization triggers will be converted to absolute targetAverageValue to preserve horizontal scaling.'
      : '';
    if (!(await confirm(`Apply recommendation to ${w.kind} ${w.namespace}/${w.name}?${hpaNote}`))) return;
    try {
      const j = await postJson<{ ok?: boolean; message?: string }>('/api/apply', {
        namespace: w.namespace,
        kind: w.kind,
        name: w.name,
      });
      toast(j.ok ? 'Applied ✓\n' + (j.message || '') : 'Could not apply:\n' + (j.message || 'unknown error'));
    } catch {
      toast('Request failed.');
    }
    refresh();
  };
  const rowRollout = async (w: WorkloadRow) => {
    if (!(await confirm(`Rollout-restart ${w.name}?`))) return;
    try {
      await postJson('/api/rollout', { namespace: w.namespace, kind: w.kind, name: w.name });
      toast('Rollout triggered on ' + w.name, 'ok');
    } catch {
      toast('Rollout failed');
    }
  };
  const rowRestore = async (w: WorkloadRow) => {
    try {
      await postJson('/api/restore-policy', { namespace: w.namespace, kind: w.kind, name: w.name });
      toast('Restored suggested policy on ' + w.name, 'ok');
      refresh();
    } catch {
      toast('Restore failed');
    }
  };
  const rowExclude = async (w: WorkloadRow, on: boolean) => {
    try {
      await postJson('/api/exclude', { key: w.key, excluded: on });
      toast(w.name + (on ? ' excluded from' : ' re-included in') + ' automation', 'ok');
      refresh();
    } catch {
      toast('Failed');
    }
  };
  const attachPolicy = async (w: WorkloadRow, pol: string) => {
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
        refresh();
      } else toast('Could not attach policy: ' + (j.message || ''));
    } catch {
      toast('Request failed.');
    }
  };

  // ----- bulk actions (bulkAct port) -----
  const bulkAct = async (action: string, nsArg?: string) => {
    setActOpen(false);
    if (ro) {
      toast('Cluster is in READ-ONLY mode.\nSet readOnly: false in Helm values to take actions.');
      return;
    }
    const keys = [...selected];
    const sel = rows0.filter((w) => selected.has(w.key));
    const needSel = () => {
      if (!keys.length) {
        toast('Select one or more workloads first.');
        return false;
      }
      return true;
    };
    const post = (url: string, body: unknown) => postJson(url, body).catch(() => ({ ok: false }));
    try {
      if (action === 'automate-selected' || action === 'unautomate-selected') {
        if (!needSel()) return;
        const en = action === 'automate-selected';
        if (!(await confirm(`${en ? 'Automate' : 'Un-automate'} ${keys.length} selected workload(s)?`))) return;
        await post('/api/automate-bulk', { scope: 'selected', keys, enabled: en });
        toast(`${keys.length} workload(s) ${en ? 'automated' : 'un-automated'}.`, 'ok');
      } else if (action === 'exclude-selected') {
        if (!needSel()) return;
        if (!(await confirm(`Exclude ${keys.length} workload(s) from automation?`))) return;
        await Promise.all(keys.map((k) => post('/api/exclude', { key: k, excluded: true })));
        toast(`${keys.length} workload(s) excluded from automation.`, 'ok');
      } else if (action === 'attach-selected') {
        if (!needSel()) return;
        if (!(await confirm(`Attach policy "${actPol}" to ${keys.length} workload(s)?`))) return;
        await Promise.all(
          sel.map((w) => post('/api/attach-policy', { namespace: w.namespace, kind: w.kind, name: w.name, policy: actPol })),
        );
        toast(`Policy "${actPol}" attached to ${keys.length} workload(s).`, 'ok');
      } else if (action === 'restore-selected') {
        if (!needSel()) return;
        if (!(await confirm(`Restore suggested policy on ${keys.length} workload(s)?`))) return;
        await Promise.all(sel.map((w) => post('/api/restore-policy', { namespace: w.namespace, kind: w.kind, name: w.name })));
        toast(`Restored suggested policy on ${keys.length} workload(s).`, 'ok');
      } else if (action === 'rollout-selected') {
        if (!needSel()) return;
        if (!(await confirm(`Rollout-restart ${keys.length} workload(s)?`))) return;
        await Promise.all(sel.map((w) => post('/api/rollout', { namespace: w.namespace, kind: w.kind, name: w.name })));
        toast(`Rollout triggered on ${keys.length} workload(s).`, 'ok');
      } else if (action === 'automate-namespace' || action === 'unautomate-namespace') {
        if (!nsArg) {
          toast('Pick a namespace first (namespaces filter or single-namespace selection).');
          return;
        }
        const en = action === 'automate-namespace';
        if (!(await confirm(`${en ? 'Automate' : 'Un-automate'} ALL workloads in namespace "${nsArg}" (current + future)?`)))
          return;
        await post('/api/automate-bulk', { scope: 'namespace', namespace: nsArg, enabled: en });
        toast(`Namespace "${nsArg}" ${en ? 'automated' : 'un-automated'}.`, 'ok');
      } else if (action === 'automate-cluster' || action === 'unautomate-cluster') {
        const en = action === 'automate-cluster';
        if (!(await confirm(`${en ? 'Automate' : 'Un-automate'} the ENTIRE cluster (all current + future workloads)?`)))
          return;
        await post('/api/automate-bulk', { scope: 'cluster', enabled: en });
        toast(`Cluster ${en ? 'automated' : 'un-automated'} successfully.`, 'ok');
      } else if (action === 'attach-namespace' || action === 'attach-cluster') {
        const isNs = action === 'attach-namespace';
        if (isNs && !nsArg) {
          toast('Pick a namespace first.');
          return;
        }
        const pol = isNs ? actNsPol : actClPol;
        const tgt = rows0.filter((w) => w.sizable && (isNs ? w.namespace === nsArg : true));
        if (!tgt.length) {
          toast('No workloads to attach.');
          return;
        }
        if (
          !(await confirm(
            `Attach policy "${pol}" to ${tgt.length} workload(s) ${isNs ? `in namespace "${nsArg}"` : 'across the cluster'}?`,
          ))
        )
          return;
        await Promise.all(
          tgt.map((w) => post('/api/attach-policy', { namespace: w.namespace, kind: w.kind, name: w.name, policy: pol })),
        );
        toast(`Policy "${pol}" attached to ${tgt.length} workload(s).`, 'ok');
      } else if (action === 'restore-namespace' || action === 'restore-cluster') {
        const isNs = action === 'restore-namespace';
        if (isNs && !nsArg) {
          toast('Pick a namespace first.');
          return;
        }
        const tgt = rows0.filter((w) => w.sizable && (isNs ? w.namespace === nsArg : true));
        if (!tgt.length) {
          toast('No workloads to restore.');
          return;
        }
        if (
          !(await confirm(
            `Restore the suggested (auto-detected) policy on ${tgt.length} workload(s) ${isNs ? `in namespace "${nsArg}"` : 'across the cluster'}?`,
          ))
        )
          return;
        await Promise.all(tgt.map((w) => post('/api/restore-policy', { namespace: w.namespace, kind: w.kind, name: w.name })));
        toast(`Restored suggested policy on ${tgt.length} workload(s).`, 'ok');
      }
    } catch {
      toast('Action failed.');
    }
    setSelected(new Set());
    refresh();
  };

  const bulkApply = async () => {
    if (ro) {
      toast('Cluster is in READ-ONLY mode.\nSet readOnly: false in Helm values to rightsize workloads.');
      return;
    }
    const targets = rows0.filter((w) => w.sizable && w.savings > 0.5);
    if (!targets.length) {
      toast('No eligible workloads with available savings to rightsize.');
      return;
    }
    if (
      !(await confirm(
        `Right-size ${targets.length} workload(s) IN PLACE (no restart)?\n\nRunning pods are resized via the pods/resize subresource — no rollout, no reschedule. The controller template is untouched, so GitOps/operators won't revert it. HPA/KEDA triggers are converted first.`,
      ))
    )
      return;
    const res = await Promise.all(
      targets.map((w) =>
        postJson<{ ok?: boolean }>('/api/resize', { namespace: w.namespace, kind: w.kind, name: w.name }).catch(() => ({
          ok: false,
        })),
      ),
    );
    toast(`Rightsize actions complete: ${res.filter((r) => r.ok).length}/${targets.length} resized in place.`);
    refresh();
  };

  const selNs = [...new Set([...selected].map((k) => rows0.find((x) => x.key === k)?.namespace).filter(Boolean))] as string[];
  const actNs = ex.ns || (selNs.length === 1 ? selNs[0] : '');

  const dataCol = (k: string): CSSProperties => (cols.has(k) ? {} : { display: 'none' });

  // ----- aggregation rows -----
  const aggRows = useMemo(() => {
    const by: Record<string, { n: number; sav: number; act: number; cpu: number; mem: number; rep: number; auto: number; cost: number }> = {};
    filtered.forEach((w) => {
      const g = (by[w.namespace] = by[w.namespace] || { n: 0, sav: 0, act: 0, cpu: 0, mem: 0, rep: 0, auto: 0, cost: 0 });
      g.n++;
      g.sav += Math.max(w.savings || 0, 0);
      g.act += w.activeSavings || 0;
      g.cost += w.monthlyCost || 0;
      g.cpu += (w.reqCpu || 0) * (w.replicas || 0);
      g.mem += (w.reqMem || 0) * (w.replicas || 0);
      g.rep += w.replicas || 0;
      if (w.automated) g.auto++;
    });
    return Object.entries(by).sort((a, b) => b[1].sav - a[1].sav);
  }, [filtered]);

  const kebabW = kebab ? rows0.find((x) => x.key === kebab.key) : null;

  return (
    <section ref={ref} className="card" style={{ overflow: 'visible', position: 'relative' }}>
      {/* tabs */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '12px 16px 0', borderBottom: '1px solid #eef0f5' }}>
        <span className={'tab' + (tab === 'workloads' ? ' active' : '')} onClick={() => setTab('workloads')}>Workloads</span>
        <span className={'tab' + (tab === 'agg' ? ' active' : '')} onClick={() => setTab('agg')}>Aggregation</span>
      </div>

      {/* filters + Columns + Rightsize Actions */}
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
            style={{ background: '#fff', border: '1px solid #dfe2ec', borderRadius: 999, padding: '6px 12px 6px 36px', fontSize: 14, width: 200, outline: 'none', fontFamily: 'inherit' }}
          />
        </div>
        {(['automated', 'unautomated', 'savings', 'under'] as ChipName[]).map((c) => (
          <span key={c} className={'chip' + (chips.has(c) ? ' on' : '')} onClick={() => toggleChip(c)}>
            {CHIP_LABEL[c]}
          </span>
        ))}
        <ChipSelect label="namespaces" value={ex.ns} options={nsOptions} onChange={(v) => setExF({ ns: v })} />
        <ChipSelect label="policies" value={ex.pol} options={polOptions} onChange={(v) => setExF({ pol: v })} />
        <ChipSelect label="types" value={ex.type} options={typeOptions} onChange={(v) => setExF({ type: v })} />
        <span className={'chip' + (chips.has('agentic') ? ' on' : '')} onClick={() => toggleChip('agentic')}>
          {CHIP_LABEL.agentic}
        </span>
        {typesFilter && (
          <span className="chip on" title="Custom-workload group filter (from Custom Workloads → Explore)">
            types: {typesFilter}
            <span
              onClick={(e) => {
                e.stopPropagation();
                onClearTypes?.();
              }}
              style={{ marginLeft: 6, cursor: 'pointer', fontWeight: 700 }}
            >
              ✕
            </span>
          </span>
        )}
        <div style={{ position: 'relative' }}>
          <span className="chip" onClick={() => setMoreOpen((o) => !o)}>
            + More filters{' '}
            {moreCnt > 0 && (
              <span style={{ marginLeft: 2, padding: '0 4px', borderRadius: 999, background: '#e0e7ff', color: '#4f46e5', fontSize: 10 }}>{moreCnt}</span>
            )}{' '}
            ▾
          </span>
          <Dropdown open={moreOpen} onClose={() => setMoreOpen(false)} style={{ left: 0, width: 430, padding: 12 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {MORE_CHIPS.map((c) => (
                <span key={c} className={'chip' + (chips.has(c) ? ' on' : '')} onClick={() => toggleChip(c)}>
                  {CHIP_LABEL[c]}
                </span>
              ))}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 10 }}>
              <label style={lblStyle}>
                priority class
                <select className="chip" style={{ width: '100%', marginTop: 2 }} value={ex.prio} onChange={(e) => setExF({ prio: e.target.value })}>
                  <option value="">any</option>
                  {prioOptions.map((n) => (
                    <option key={n}>{n}</option>
                  ))}
                </select>
              </label>
              <label style={lblStyle}>
                rollout strategy
                <select className="chip" style={{ width: '100%', marginTop: 2 }} value={ex.rollout} onChange={(e) => setExF({ rollout: e.target.value })}>
                  <option value="">any</option>
                  {rolloutOptions.map((n) => (
                    <option key={n}>{n}</option>
                  ))}
                </select>
              </label>
              <label style={lblStyle}>
                wasted resources
                <select className="chip" style={{ width: '100%', marginTop: 2 }} value={ex.wasted} onChange={(e) => setExF({ wasted: e.target.value })}>
                  <option value="">any</option>
                  <option value="cpu">CPU</option>
                  <option value="memory">Memory</option>
                </select>
              </label>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 10 }}>
              <label style={lblStyle}>
                labels <span style={{ color: '#cbd5e1' }}>key=value</span>
                <input className="chip" style={{ width: '100%', marginTop: 2, cursor: 'text' }} placeholder="app=web" value={ex.label} onChange={(e) => setExF({ label: e.target.value })} />
              </label>
              <label style={lblStyle}>
                annotations <span style={{ color: '#cbd5e1' }}>key=value</span>
                <input className="chip" style={{ width: '100%', marginTop: 2, cursor: 'text' }} placeholder="team=payments" value={ex.anno} onChange={(e) => setExF({ anno: e.target.value })} />
              </label>
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
          <button onClick={() => setActOpen((o) => !o)} style={{ ...toolBtn('#fff', '#6366f1', 'none'), padding: '6px 14px' }}>
            Rightsize Actions
            {selected.size > 0 && (
              <span style={{ marginLeft: 2, padding: '0 6px', borderRadius: 999, background: 'rgba(255,255,255,.25)', fontSize: 11, lineHeight: 1.6 }}>
                {selected.size}
              </span>
            )}
          </button>
          <Dropdown open={actOpen} onClose={() => setActOpen(false)} style={{ right: 0, width: 320, padding: 6, maxHeight: 440, overflowY: 'auto', fontSize: 13 }}>
            {/* Workload actions */}
            <AccordionHeader
              label={`Workload actions${selected.size ? ` · ${selected.size} selected` : ''}`}
              open={actAcc.wl}
              onToggle={() => setActAcc((a) => ({ ...a, wl: !a.wl }))}
            />
            {actAcc.wl && (
              <>
                <MenuItem label="🪄 Automate" enabled={selected.size > 0 && !ro} onClick={() => bulkAct('automate-selected')} />
                <MenuItem label="⊘ Un-Automate" enabled={selected.size > 0 && !ro} onClick={() => bulkAct('unautomate-selected')} />
                <MenuItem label="⚡ Apply recommendation" enabled={selected.size > 0 && !ro} onClick={bulkApply} />
                <PolicyAttachRow
                  value={actPol}
                  onChange={setActPol}
                  enabled={selected.size > 0 && !ro}
                  policyNames={policyNames}
                  onApply={() => bulkAct('attach-selected')}
                />
                <MenuItem label="↺ Restore suggested policy" enabled={selected.size > 0 && !ro} onClick={() => bulkAct('restore-selected')} />
                <MenuItem label="⟳ Rollout" enabled={selected.size > 0 && !ro} onClick={() => bulkAct('rollout-selected')} />
                <MenuItem label="🔒 Exclude from automation" enabled={selected.size > 0 && !ro} onClick={() => bulkAct('exclude-selected')} />
              </>
            )}
            <div style={{ borderTop: '1px solid #f1f2f7', margin: '4px 0' }} />
            <AccordionHeader
              label={`Namespace actions${actNs ? ` · ${actNs}` : ''}`}
              open={actAcc.ns}
              onToggle={() => setActAcc((a) => ({ ...a, ns: !a.ns }))}
            />
            {actAcc.ns && (
              <>
                <MenuItem label="🪄 Automate namespace" enabled={!!actNs && !ro} onClick={() => bulkAct('automate-namespace', actNs)} />
                <MenuItem label="⊘ Un-Automate namespace" enabled={!!actNs && !ro} onClick={() => bulkAct('unautomate-namespace', actNs)} />
                <PolicyAttachRow
                  value={actNsPol}
                  onChange={setActNsPol}
                  enabled={!!actNs && !ro}
                  policyNames={policyNames}
                  onApply={() => bulkAct('attach-namespace', actNs)}
                />
                <MenuItem label="↺ Restore suggested policy (ns)" enabled={!!actNs && !ro} onClick={() => bulkAct('restore-namespace', actNs)} />
                {!actNs && (
                  <div style={{ padding: '0 10px 4px', fontSize: 10, color: '#94a3b8' }}>
                    Pick a namespace via the namespaces filter, or select rows from one namespace.
                  </div>
                )}
              </>
            )}
            <div style={{ borderTop: '1px solid #f1f2f7', margin: '4px 0' }} />
            <AccordionHeader label="Cluster actions" open={actAcc.cl} onToggle={() => setActAcc((a) => ({ ...a, cl: !a.cl }))} />
            {actAcc.cl && (
              <>
                <div style={{ padding: '0 10px 4px', fontSize: 10, color: '#94a3b8' }}>Applies to all current and future workloads.</div>
                <MenuItem label="🪄 Automate cluster" enabled={!ro} onClick={() => bulkAct('automate-cluster')} />
                <MenuItem label="⊘ Un-Automate cluster" enabled={!ro} onClick={() => bulkAct('unautomate-cluster')} />
                <PolicyAttachRow
                  value={actClPol}
                  onChange={setActClPol}
                  enabled={!ro}
                  policyNames={policyNames}
                  onApply={() => bulkAct('attach-cluster')}
                />
                <MenuItem label="↺ Restore suggested policy (cluster)" enabled={!ro} onClick={() => bulkAct('restore-cluster')} />
              </>
            )}
            {ro && <div style={{ padding: '6px 10px', fontSize: 11, color: '#d97706' }}>Read-only mode — actions disabled.</div>}
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
                  checked={filtered.length > 0 && filtered.every((w) => selected.has(w.key))}
                  onChange={(e) => {
                    setSelected((prev) => {
                      const n = new Set(prev);
                      filtered.forEach((w) => (e.target.checked ? n.add(w.key) : n.delete(w.key)));
                      return n;
                    });
                  }}
                />
              </th>
              <th style={{ ...thStyle, textAlign: 'left' }} onClick={() => sortBy('name')}>
                Workload <span className="num">{arrow('name')}</span>
              </th>
              <th style={{ ...thStyle, textAlign: 'right', ...dataCol('savings') }} onClick={() => sortBy('savings')}>
                Savings Available <span className="num">{arrow('savings')}</span>
                <div style={subTh}>(monthly)</div>
              </th>
              <th style={{ ...thStyle, textAlign: 'right', ...dataCol('active') }} onClick={() => sortBy('active')}>
                Active Savings <span className="num">{arrow('active')}</span>
                <div style={subTh}>(monthly)</div>
              </th>
              <th style={{ ...thStyle, textAlign: 'left', paddingLeft: 24, ...dataCol('cpu') }} onClick={() => sortBy('reqCpu')}>
                CPU Request <span className="num">{arrow('reqCpu')}</span>
                <div style={subTh}>(per replica)</div>
              </th>
              <th style={{ ...thStyle, textAlign: 'left', ...dataCol('mem') }} onClick={() => sortBy('reqMem')}>
                Memory Request <span className="num">{arrow('reqMem')}</span>
                <div style={subTh}>(per replica)</div>
              </th>
              <th style={{ ...thStyle, textAlign: 'right', ...dataCol('cost') }}>Total Cost<div style={subTh}>(monthly)</div></th>
              <th style={{ ...thStyle, textAlign: 'left', ...dataCol('origCpu') }}>Original CPU Request</th>
              <th style={{ ...thStyle, textAlign: 'left', ...dataCol('origMem') }}>Original Memory Request</th>
              <th style={{ ...thStyle, textAlign: 'left', ...dataCol('eph') }}>Ephemeral Storage Request</th>
              <th style={{ ...thStyle, textAlign: 'left', ...dataCol('initCpu') }}>Init Container CPU Overhead</th>
              <th style={{ ...thStyle, textAlign: 'left', ...dataCol('initMem') }}>Init Container Memory Overhead</th>
              <th style={{ ...thStyle, textAlign: 'left', ...dataCol('wltype') }}>Workload Type</th>
              <th style={{ ...thStyle, textAlign: 'center', ...dataCol('unevictableCol') }}>Unevictable</th>
              <th style={{ ...thStyle, textAlign: 'center', ...dataCol('replicas') }} onClick={() => sortBy('replicas')}>
                Replicas <span className="num">{arrow('replicas')}</span>
                <div style={subTh}>(running/desired)</div>
              </th>
              <th style={{ ...thStyle, textAlign: 'left', ...dataCol('policy') }} onClick={() => sortBy('policy')}>
                Policy <span className="num">{arrow('policy')}</span>
              </th>
              <th style={{ ...thStyle, textAlign: 'center', ...dataCol('automated') }} onClick={() => sortBy('automated')}>
                Automated <span className="num">{arrow('automated')}</span>
              </th>
              <th style={{ width: 32, paddingRight: 12 }} />
            </tr>
          </thead>
          <tbody>
            {tab === 'agg'
              ? aggRows.map(([nsName, g]) => (
                  <tr key={nsName} className="wlrow" style={{ borderBottom: '1px solid #f1f2f7' }}>
                    <td style={{ paddingLeft: 16, padding: '12px 0 12px 16px' }} />
                    <td style={{ padding: '12px 0' }}>
                      <div style={{ fontWeight: 600, color: '#1e2536' }}>{nsName}</div>
                      <div style={{ fontSize: 11, color: '#94a3b8' }}>
                        {g.n} workload{g.n === 1 ? '' : 's'} · {g.auto} automated
                      </div>
                    </td>
                    <td style={{ textAlign: 'right', paddingRight: 8, ...dataCol('savings') }}>
                      {g.sav > 0.5 ? <span style={{ fontWeight: 600, color: '#16a34a' }}>{usd(g.sav)}</span> : <span style={{ color: '#cbd5e1' }}>$0</span>}
                    </td>
                    <td style={{ textAlign: 'right', paddingRight: 8, ...dataCol('active') }}>
                      {g.act > 0.5 ? <span style={{ fontWeight: 600, color: '#16a34a' }}>{usd(g.act)}</span> : <span style={{ color: '#cbd5e1' }}>$0</span>}
                    </td>
                    <td className="num" style={{ paddingLeft: 24, color: '#475569', ...dataCol('cpu') }}>{coresFmt(g.cpu)}</td>
                    <td className="num" style={{ color: '#475569', ...dataCol('mem') }}>{mibFmt(g.mem)}</td>
                    <td className="num" style={{ textAlign: 'right', paddingRight: 8, color: '#475569', ...dataCol('cost') }}>{usd(g.cost)}</td>
                    {['origCpu', 'origMem', 'eph', 'initCpu', 'initMem', 'wltype', 'unevictableCol'].map((k) => (
                      <td key={k} style={{ color: '#cbd5e1', fontSize: 11, ...dataCol(k) }}>–</td>
                    ))}
                    <td className="num" style={{ textAlign: 'center', color: '#475569', ...dataCol('replicas') }}>{g.rep}</td>
                    <td style={{ color: '#cbd5e1', fontSize: 11, ...dataCol('policy') }}>–</td>
                    <td className="num" style={{ textAlign: 'center', color: '#475569', ...dataCol('automated') }}>
                      {g.n ? Math.round((g.auto / g.n) * 100) : 0}%
                    </td>
                    <td style={{ paddingRight: 12 }} />
                  </tr>
                ))
              : pageRows.map((w) => (
                  <WlRow
                    key={w.key}
                    w={w}
                    ro={ro}
                    selected={selected.has(w.key)}
                    cols={cols}
                    policyNames={policyNames}
                    onSelect={(on) =>
                      setSelected((prev) => {
                        const n = new Set(prev);
                        if (on) n.add(w.key);
                        else n.delete(w.key);
                        return n;
                      })
                    }
                    onOpenDrawer={() => onOpenDrawer(w)}
                    onToggleAuto={(on) => toggleAuto(w, on)}
                    onAttachPolicy={(p) => attachPolicy(w, p)}
                    onRestore={() => rowRestore(w)}
                    onKebab={(x, y) => setKebab({ key: w.key, x, y })}
                  />
                ))}
          </tbody>
        </table>
      </div>
      {((tab === 'agg' && !aggRows.length) || (tab === 'workloads' && !filtered.length)) && (
        <div style={{ textAlign: 'center', color: '#94a3b8', fontSize: 14, padding: '40px 0' }}>No workloads match your filters.</div>
      )}

      {/* pagination footer */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', fontSize: 12, color: '#94a3b8', borderTop: '1px solid #eef0f5' }}>
        <span>
          {tab === 'agg'
            ? aggRows.length + ' namespace' + (aggRows.length === 1 ? '' : 's')
            : filtered.length + ' workload' + (filtered.length === 1 ? '' : 's')}
        </span>
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
              {[25, 50, 100, 200].map((n) => (
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

      {kebab && kebabW && (
        <ClickAwayListener onClickAway={() => setKebab(null)}>
          <div
            style={{
              position: 'fixed',
              top: Math.min(window.innerHeight - 220, kebab.y),
              left: Math.max(8, kebab.x - 240),
              width: 240,
              background: '#fff',
              borderRadius: 12,
              boxShadow: '0 20px 25px -5px rgba(0,0,0,.1),0 8px 10px -6px rgba(0,0,0,.1)',
              border: '1px solid #e9eaf0',
              padding: '6px 0',
              zIndex: 90,
              fontSize: 13,
            }}
          >
            <MenuItem
              label="Apply recommendation"
              enabled={!ro && !!kebabW.sizable}
              title={ro ? 'Read-only mode' : kebabW.sizable ? '' : 'No recommendation'}
              onClick={() => {
                setKebab(null);
                applyWl(kebabW);
              }}
            />
            <MenuItem label="Revert recommendation" enabled={false} title="Not available — CoolScaler keeps no per-apply revert history" />
            <MenuItem label="Rollout workload" enabled={!ro} onClick={() => { setKebab(null); rowRollout(kebabW); }} />
            <MenuItem label="Restore to suggested policy" enabled={!ro} onClick={() => { setKebab(null); rowRestore(kebabW); }} />
            <MenuItem
              label={kebabW.excluded ? 'Re-include in automation' : 'Exclude from automation'}
              enabled={!ro}
              onClick={() => {
                setKebab(null);
                rowExclude(kebabW, !kebabW.excluded);
              }}
            />
          </div>
        </ClickAwayListener>
      )}
    </section>
  );
});
export default WorkloadsTable;

function AccordionHeader({ label, open, onToggle }: { label: string; open: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      style={{
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '8px 10px 6px',
        fontSize: 11,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '.04em',
        color: '#64748b',
        background: 'transparent',
        border: 'none',
        cursor: 'pointer',
        fontFamily: 'inherit',
      }}
    >
      <span>{label}</span>
      <svg style={{ width: 14, height: 14, transition: 'transform .15s', transform: open ? 'rotate(180deg)' : 'none' }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
        <path d="M6 9l6 6 6-6" />
      </svg>
    </button>
  );
}

function PolicyAttachRow({
  value,
  onChange,
  enabled,
  policyNames,
  onApply,
}: {
  value: string;
  onChange: (v: string) => void;
  enabled: boolean;
  policyNames: string[];
  onApply: () => void;
}) {
  return (
    <div style={{ padding: '4px 10px', display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ color: '#475569', fontSize: 13 }}>Attach policy</span>
      <select
        disabled={!enabled}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        style={{ background: '#f4f5f8', border: '1px solid #e9eaf0', borderRadius: 8, padding: '4px 6px', fontSize: 12, flex: 1, outline: 'none' }}
      >
        {policyNames.map((p) => (
          <option key={p}>{p}</option>
        ))}
      </select>
      <button
        disabled={!enabled}
        onClick={onApply}
        style={{
          fontSize: 11,
          fontWeight: 600,
          borderRadius: 4,
          padding: '4px 8px',
          border: 'none',
          fontFamily: 'inherit',
          cursor: enabled ? 'pointer' : 'not-allowed',
          background: enabled ? '#6366f1' : '#f1f5f9',
          color: enabled ? '#fff' : '#cbd5e1',
        }}
      >
        Apply
      </button>
    </div>
  );
}

// one workload row
function WlRow({
  w,
  ro,
  selected,
  cols,
  policyNames,
  onSelect,
  onOpenDrawer,
  onToggleAuto,
  onAttachPolicy,
  onRestore,
  onKebab,
}: {
  w: WorkloadRow;
  ro: boolean;
  selected: boolean;
  cols: Set<string>;
  policyNames: string[];
  onSelect: (on: boolean) => void;
  onOpenDrawer: () => void;
  onToggleAuto: (on: boolean) => void;
  onAttachPolicy: (p: string) => void;
  onRestore: () => void;
  onKebab: (x: number, y: number) => void;
}) {
  const dataCol = (k: string): CSSProperties => (cols.has(k) ? {} : { display: 'none' });
  const pol = policyOf(w);
  const [pillBg, pillFg] = policyPillColors(pol);
  const running = (w.podInfo || []).filter((p) => p.ready).length;
  const desired = w.replicas || 0;

  // reqCellWl port — automated + applied rows show Original ⇒ Current.
  // CPU always in cores, memory in MiB/GiB.
  const reqCellFor = (res: 'cpu' | 'mem') => {
    const fmt = res === 'cpu' ? coresFmt : mibFmt;
    const cur = res === 'cpu' ? w.reqCpu : w.reqMem;
    const rec = res === 'cpu' ? w.recCpu : w.recMem;
    const orig = res === 'cpu' ? w.origCpu : w.origMem;
    if (w.automated && orig != null && cur != null && Math.abs(orig - cur) > (res === 'cpu' ? 0.0005 : 2 ** 20))
      return <ReqCell cur={orig} rec={cur} fmt={fmt} />;
    return <ReqCell cur={cur} rec={rec} fmt={fmt} />;
  };

  const pillMini = (text: string, bg: string, fg: string, title?: string) => (
    <span className="pill" title={title} style={{ background: bg, color: fg, marginLeft: 4 }}>
      {text}
    </span>
  );

  return (
    <tr
      className="wlrow"
      title="View Recommendation detail"
      style={{ borderBottom: '1px solid #f1f2f7', background: w.automated ? 'rgba(209,250,229,.4)' : undefined }}
      onClick={onOpenDrawer}
    >
      <td style={{ padding: '12px 0 12px 16px' }} onClick={(e) => e.stopPropagation()}>
        <input type="checkbox" checked={selected} onChange={(e) => onSelect(e.target.checked)} />
      </td>
      <td style={{ padding: '12px 0', cursor: 'pointer' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          {w.automated ? <AutomatedDot /> : <HealthDot w={w} />}
          <span
            title={`${w.kind} · ${w.namespace}/${w.name}`}
            style={{ color: '#94a3b8', display: 'inline-flex', flexShrink: 0, cursor: 'help' }}
          >
            <svg style={{ width: 13, height: 13 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <circle cx="12" cy="12" r="9" />
              <path d="M12 11v5M12 8h.01" />
            </svg>
          </span>
          <span style={{ fontWeight: 600, color: '#1e2536', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {w.namespace}/{w.name}
          </span>
          {w.hpaManaged && pillMini('HPA', '#ede9fe', '#7c3aed')}
          {w.smartPolicyWorkloadType && pillMini(w.smartPolicyWorkloadType, '#f0f9ff', '#0284c7', 'Smart policy — detected workload type')}
          {w.isPrivileged && pillMini('priv', '#fff1f2', '#e11d48', 'Privileged container')}
          {w.isSleeping && pillMini('💤', '#f1f5f9', '#64748b', 'Scaled to zero (sleeping)')}
          {w.excluded && (
            <span title="Excluded from automation" style={{ marginLeft: 4, color: '#94a3b8' }}>🔒</span>
          )}
          {w.detectedTag && pillMini(w.detectedTag, '#eef2ff', '#6366f1', 'Policy Rule auto-attached this policy')}
        </div>
      </td>
      <td style={{ textAlign: 'right', paddingRight: 8, ...dataCol('savings') }}>
        {w.savings > 0.5 ? (
          <span style={{ fontWeight: 600, color: '#16a34a' }}>{usd(w.savings)}</span>
        ) : w.savings < -0.5 ? (
          <span style={{ fontWeight: 600, color: '#f43f5e' }}>-{usd(-w.savings)}</span>
        ) : (
          <span style={{ color: '#cbd5e1' }}>$0</span>
        )}
      </td>
      <td style={{ textAlign: 'right', paddingRight: 8, ...dataCol('active') }}>
        {(w.activeSavings || 0) > 0.5 ? (
          <span style={{ fontWeight: 600, color: '#16a34a' }}>{usd(w.activeSavings)}</span>
        ) : (
          <span style={{ color: '#cbd5e1' }}>$0</span>
        )}
      </td>
      <td style={{ paddingLeft: 24, ...dataCol('cpu') }}>{reqCellFor('cpu')}</td>
      <td style={dataCol('mem')}>{reqCellFor('mem')}</td>
      <td className="num" style={{ textAlign: 'right', paddingRight: 8, color: '#475569', ...dataCol('cost') }}>{usd(w.monthlyCost)}</td>
      <td className="num" style={{ color: '#64748b', ...dataCol('origCpu') }}>{w.origCpu ? coresFmt(w.origCpu) : coresFmt(w.reqCpu)}</td>
      <td className="num" style={{ color: '#64748b', ...dataCol('origMem') }}>{mibFmt(w.origMem || w.reqMem)}</td>
      <td className="num" style={{ color: '#64748b', ...dataCol('eph') }}>{w.reqEph ? mibFmt(w.reqEph) : '–'}</td>
      <td className="num" style={{ color: '#64748b', ...dataCol('initCpu') }}>{w.initOverCpu ? coresFmt(w.initOverCpu) : '–'}</td>
      <td className="num" style={{ color: '#64748b', ...dataCol('initMem') }}>{w.initOverMem ? mibFmt(w.initOverMem) : '–'}</td>
      <td style={{ color: '#64748b', fontSize: 12, ...dataCol('wltype') }}>{w.kind}</td>
      <td style={{ textAlign: 'center', ...dataCol('unevictableCol') }}>{(w.unevictableReasons || []).length ? <span className="pill" style={{ background: '#fef2f2', color: '#dc2626' }}>Yes</span> : <span style={{ color: '#cbd5e1' }}>–</span>}</td>
      <td style={{ textAlign: 'center', ...dataCol('replicas') }}>
        {(w.podInfo || []).length ? (
          <span
            title={`${running} running / ${desired} desired`}
            style={{ color: running < desired ? '#d97706' : '#475569', fontWeight: running < desired ? 600 : 400 }}
          >
            {running} / {desired}
          </span>
        ) : (
          <span style={{ color: '#475569' }}>{desired}</span>
        )}
        {w.hpaManaged && (
          <span title="HPA-managed — replicas scale horizontally" style={{ marginLeft: 4, color: '#a78bfa' }}>⇅</span>
        )}
      </td>
      <td style={dataCol('policy')}>
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
            </select>
          </span>
          {!w.policyName && w.policySuggested && (
            <span className="pill" title="Auto-detected policy" style={{ background: '#eef2ff', color: '#818cf8', fontSize: 10 }}>auto</span>
          )}
          {w.policyActive && (
            <span className="pill" title="Schedule policy — active sub-policy right now (UTC)" style={{ background: '#fef3c7', color: '#b45309', marginLeft: 4 }}>
              ⏱ {w.policyActive}
            </span>
          )}
        </div>
      </td>
      <td style={dataCol('automated')}>
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 4 }} onClick={(e) => e.stopPropagation()}>
          <Toggle
            checked={!!w.automated}
            disabled={ro}
            onChange={onToggleAuto}
            title={ro ? 'Read-only — enable automation in Helm values' : w.excluded ? 'Excluded from automation — re-include first (kebab menu)' : ''}
          />
          {w.excluded && (
            <span title="Excluded from automation" style={{ color: '#94a3b8', fontSize: 12 }}>🔒</span>
          )}
        </div>
      </td>
      <td style={{ paddingRight: 12, textAlign: 'center' }} onClick={(e) => e.stopPropagation()}>
        <button
          title="Workload actions"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            onKebab(r.right, r.bottom + 4);
          }}
          style={{ height: 28, width: 28, borderRadius: 8, display: 'grid', placeItems: 'center', color: '#94a3b8', border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 16 }}
        >
          ⋮
        </button>
      </td>
    </tr>
  );
}

/** Sentinel option value — "Auto detect" restores the suggested policy. */
const AUTO_DETECT = '__auto_detect__';

/* Pill-styled filter dropdown. */
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

const lblStyle: CSSProperties = { fontSize: 11, color: '#64748b', display: 'block' };
