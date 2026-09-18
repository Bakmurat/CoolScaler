
/** parse Kubernetes CPU quantity → cores (parseCpu port). */
export function parseCpu(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  if (s === '') return null;
  if (s.endsWith('m')) return parseFloat(s) / 1000;
  if (s.endsWith('n')) return parseFloat(s) / 1e9;
  if (s.endsWith('u')) return parseFloat(s) / 1e6;
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

/** parse Kubernetes memory quantity → bytes (parseMem port). */
export function parseMem(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  const m = String(v)
    .trim()
    .match(/^([0-9.]+)\s*([A-Za-z]*)$/);
  if (!m) return null;
  const mult: Record<string, number> = {
    '': 1,
    k: 1e3,
    K: 1e3,
    M: 1e6,
    G: 1e9,
    T: 1e12,
    P: 1e15,
    Ki: 1024,
    Mi: 1024 ** 2,
    Gi: 1024 ** 3,
    Ti: 1024 ** 4,
    Pi: 1024 ** 5,
  };
  return parseFloat(m[1]) * (mult[m[2]] || 1);
}

/** relTime port — "5m ago". */
export function relTime(iso?: string | null): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (isNaN(t)) return '';
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 0) return 'just now';
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

/** tlAge port — event age in minutes → "5m ago". */
export function tlAge(m?: number | null): string {
  if (m == null) return '';
  return m < 60 ? m + 'm ago' : m < 1440 ? Math.round(m / 60) + 'h ago' : Math.round(m / 1440) + 'd ago';
}

// Colored policy pills (policyPillCls port) — known policies get fixed colors,
// anything else hashes to a stable color from the palette. Returns [bg, fg].
const POLICY_PILL: Record<string, [string, string]> = {
  default: ['#f1f5f9', '#64748b'],
  production: ['#eef2ff', '#6366f1'],
  'high-availability': ['#f5f3ff', '#7c3aed'],
  cost: ['#ecfdf5', '#059669'],
  batch: ['#fffbeb', '#b45309'],
  system: ['#f0f9ff', '#0284c7'],
};
const POLICY_PALETTE: [string, string][] = [
  ['#eef2ff', '#6366f1'],
  ['#f5f3ff', '#7c3aed'],
  ['#f0f9ff', '#0284c7'],
  ['#ecfdf5', '#059669'],
  ['#fffbeb', '#b45309'],
  ['#fff1f2', '#e11d48'],
  ['#f0fdfa', '#0d9488'],
  ['#fdf4ff', '#c026d3'],
];
export function policyPillColors(p: string): [string, string] {
  if (POLICY_PILL[p]) return POLICY_PILL[p];
  let h = 0;
  for (let i = 0; i < p.length; i++) h = (h * 31 + p.charCodeAt(i)) >>> 0;
  return POLICY_PALETTE[h % POLICY_PALETTE.length];
}

/*
 * production is the dominant/fallback policy.
*/
export const DEFAULT_POLICY_NAMES = [
  'production',
  'high-availability',
  'cost',
  'batch',
  'system',
  'daemonset-workloads',
  'daemonset-demand-aware',
  'weekly-optimization',
  'java',
  'spark',
  'flink',
  'high-replica',
  'prometheus',
  'airflow',
];

/** selectedWorkloadOverviewId type segment → Kind (KIND_BY_LOWER port). */
export const KIND_BY_LOWER: Record<string, string> = {
  deployment: 'Deployment',
  statefulset: 'StatefulSet',
  daemonset: 'DaemonSet',
  replicaset: 'ReplicaSet',
  cronjob: 'CronJob',
  job: 'Job',
  pod: 'Pod',
  node: 'Node',
  rollout: 'Rollout',
  family: 'Family',
};

export interface DrawerTarget {
  namespace: string;
  kind: string;
  name: string;
}

/** Parse "cluster/ns/type/name" (URL-decoded) → drawer target. */
export function parseWorkloadOverviewId(sel: string | null): DrawerTarget | null {
  if (!sel) return null;
  const parts = sel.split('/');
  if (parts.length < 4) return null;
  const [, ns, typ, ...rest] = parts;
  const kind =
    KIND_BY_LOWER[(typ || '').toLowerCase()] ||
    (typ ? typ.charAt(0).toUpperCase() + typ.slice(1) : '');
  return { namespace: ns, kind, name: rest.join('/') };
}

export function workloadOverviewId(cluster: string, t: DrawerTarget): string {
  return `${cluster}/${t.namespace}/${(t.kind || '').toLowerCase()}/${t.name}`;
}

/** Kind icon accent color (kindIcon port). */
export function kindColor(kind: string): string {
  return (
    ({ Deployment: '#6366f1', StatefulSet: '#8b5cf6', DaemonSet: '#f59e0b' } as Record<string, string>)[
      kind
    ] || '#94a3b8'
  );
}

/** tsLabel port — chart x label. */
export function tsLabel(t: number, period: string): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return period === '1h' || period === '1d'
    ? p(d.getHours()) + ':' + p(d.getMinutes())
    : d.getMonth() + 1 + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/** TIME_FMT port — analytics graph timestamp label. */
export function timeFmt(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** tbFmt port — troubleshoot chart tick/tooltip by unit. */
import { cpuFmt, memFmt } from '../../lib/format';
export function tbFmt(unit: string, v: number | null | undefined): string {
  if (v == null) return '—';
  if (unit === 'cores') return cpuFmt(v);
  if (unit === 'bytes') return memFmt(v);
  if (unit === 'ratio') return Math.round(v * 1000) / 10 + '%';
  if (unit === 'bool') return v >= 0.5 ? 'On' : 'Off';
  if (unit === 'rps') return Math.round(v * 100) / 100 + '/s';
  if (unit === 'ms') return Math.round(v) + 'ms';
  return String(Math.round(v * 10) / 10);
}

/** yamlDump port — plain-object → YAML text (for the YAMLs tab). */
export function yamlDump(o: unknown, ind = 0): string {
  const sp = '  '.repeat(ind);
  if (Array.isArray(o)) {
    if (!o.length) return ' []\n';
    let out = '\n';
    o.forEach((it) => {
      if (it && typeof it === 'object') {
        const inner = yamlDump(it, ind + 1).replace(/^\s*\n/, '');
        out += sp + '- ' + inner.replace(/^\s+/, '');
      } else out += sp + '- ' + yamlScalar(it) + '\n';
    });
    return out;
  }
  if (o && typeof o === 'object') {
    const rec = o as Record<string, unknown>;
    const ks = Object.keys(rec);
    if (!ks.length) return ' {}\n';
    let out = ind ? '\n' : '';
    ks.forEach((k) => {
      const v = rec[k];
      if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length)
        out += sp + k + ':' + yamlDump(v, ind + 1);
      else if (Array.isArray(v) && v.length) out += sp + k + ':' + yamlDump(v, ind + 1);
      else if (v && typeof v === 'object' && !Array.isArray(v)) out += sp + k + ': {}\n';
      else if (Array.isArray(v)) out += sp + k + ': []\n';
      else out += sp + k + ': ' + yamlScalar(v) + '\n';
    });
    return out;
  }
  return ' ' + yamlScalar(o) + '\n';
}
function yamlScalar(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  const s = String(v);
  return /[:#{}[\]]|^\s|\s$/.test(s) ? JSON.stringify(s) : s;
}

export function normalizePeriod(p: string | null): string | null {
  if (!p) return null;
  const map: Record<string, string> = {
    '1h': '1h',
    '1d': '1d',
    '7d': '7d',
    '2w': '2w',
    '30d': '30d',
    '1': '1h',
    '24': '1d',
    '168': '7d',
    '336': '2w',
    '720': '30d',
  };
  return map[p] || null;
}
