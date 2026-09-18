
export interface Opt {
  label: string;
  value: string | number | boolean;
}

export const WINDOW_OPTS: Opt[] = [
  { label: 'Last 12 hours', value: '12h' },
  { label: 'Last 1 day', value: '24h' },
  { label: 'Last 2 days', value: '48h' },
  { label: 'Last 4 days', value: '96h' },
  { label: 'Last 7 days', value: '168h' },
];
export const EPH_WINDOW_OPTS: Opt[] = [
  { label: 'Last 1 day', value: '24h' },
  { label: 'Last 2 days', value: '48h' },
  { label: 'Last 4 days', value: '96h' },
];
export const HEADROOM_NUMS = [0, 5, 10, 15, 20, 25, 30, 40, 50];
export const PERCENTILE_NUMS = [80, 85, 90, 93, 95, 98, 99];
export const EPH_PERCENTILE_NUMS = [80, 85, 90, 93, 95];
export const UPDATE_MODE_OPTS: Opt[] = [
  { label: 'Ongoing', value: 'Ongoing' },
  { label: 'Upon pod creation', value: 'OnCreate' },
];
export const LIMIT_STRATEGY_OPTS: Opt[] = [
  { label: 'Keep the existing limit', value: 'keepLimit' },
  { label: 'Remove the limit', value: 'noLimit' },
  { label: 'Limit equals the request', value: 'equalsToRequest' },
  { label: 'Fixed limit value', value: 'setLimit' },
  { label: 'Keep the current limit-to-request ratio', value: 'keepLimitRequestRatio' },
  { label: 'Set a limit-to-request ratio', value: 'ratio' },
];
export const HISTORY_DATAPOINTS_OPTS: Opt[] = [
  { label: 'Current selected time periods', value: 'current' },
  { label: 'All data points', value: 'all' },
];
export const TIMERANGE_OPTS: Opt[] = [
  { label: 'All day', value: true },
  { label: 'Custom', value: false },
];
export const DAYS_OPTS: Opt[] = [
  { label: 'Sun', value: 0 },
  { label: 'Mon', value: 1 },
  { label: 'Tue', value: 2 },
  { label: 'Wed', value: 3 },
  { label: 'Thu', value: 4 },
  { label: 'Fri', value: 5 },
  { label: 'Sat', value: 6 },
];
export const DAYS_SCHED_OPTS: Opt[] = [{ label: 'Every day', value: 'all' }, ...DAYS_OPTS];
export const IDENTIFIER_TYPE_OPTS: Opt[] = [
  { label: 'Environment keys', value: 'envKeys' },
  { label: 'Environment key and values', value: 'envKV' },
  { label: 'Label keys', value: 'labelKeys' },
  { label: 'Label key and values', value: 'labelKV' },
  { label: 'Annotation keys', value: 'annotationKeys' },
  { label: 'Annotation key and values', value: 'annotationKV' },
];
export const pctOpts = (arr: number[]): Opt[] => arr.map((n) => ({ label: n + '%', value: n }));

export const POLICY_NAME_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

/** Row shape from GET /api/policies. */
export interface PolicyRow {
  name: string;
  description?: string;
  builtin?: boolean;
  schedule?: boolean;
  usedBy: number;
  total: number;
  cpuPercentile?: number;
  memPercentile?: number;
  cpuHeadroom?: number;
  memHeadroom?: number;
  window?: string;
  strategy?: string;
  inPlace?: boolean;
  autoHealing?: boolean;
  burstReaction?: boolean;
  bootTime?: boolean;
  initOpt?: boolean;
  ephOpt?: boolean;
  ephPercentile?: number;
  ephWindow?: string;
}

export interface SchedulePeriod {
  days: 'all' | number[];
  allDay: boolean;
  beginTime: string;
  endTime: string;
}
export interface ScheduleRule {
  policyName: string;
  historyWindowDataPoints?: string;
  sleep?: boolean;
  periods: SchedulePeriod[];
}

/** Working detail object of the editor (GET /api/policy?name= shape). */
export interface PolicyDetail {
  name: string;
  builtin?: boolean;
  isNew?: boolean;
  type: string; // Optimize | Schedule
  description?: string;
  java?: Record<string, unknown> | null;
  request: Record<string, unknown>;
  limit: Record<string, unknown>;
  automation: Record<string, unknown>;
  schedule?: { defaultPolicy: string; rules: ScheduleRule[] };
  [key: string]: unknown;
}

export function newPolicyTemplate(name: string, type: string, policyNames: string[]): PolicyDetail {
  return {
    name: name || '',
    builtin: false,
    isNew: true,
    type: type || 'Optimize',
    request: {
      window: { cpu: '24h', memory: '24h', 'ephemeral-storage': '48h' },
      headroom: { cpu: 10, memory: 5, 'ephemeral-storage': 5 },
      percentile: { cpu: 93, memory: 93, 'ephemeral-storage': 90 },
      minAllowed: { cpu: '10m', memory: '20Mi', 'ephemeral-storage': '' },
      maxAllowed: { cpu: '', memory: '', 'ephemeral-storage': '' },
      keepRequest: { cpu: false, memory: false },
      integerCPU: false,
      memReplicasPercentile: null,
      setMaxAllowedAsNodeSize: false,
      burstReaction: true,
      autoHealing: true,
      bootTime: true,
      eph: { enabled: true, allowReduction: false, autoHealing: true },
    },
    limit: {
      cpu: { strategy: 'keepLimit' },
      memory: { strategy: 'keepLimit' },
      'ephemeral-storage': { strategy: 'keepLimit' },
    },
    automation: {
      updateByTypeMode: {
        deployment: 'Ongoing',
        statefulSet: 'OnCreate',
        daemonSet: 'OnCreate',
        rollout: 'Ongoing',
        custom: 'OnCreate',
        job: 'OnCreate',
        family: 'OnCreate',
        deploymentConfig: 'Ongoing',
      },
      inPlace: { ongoing: true, onCreate: false },
      zeroDowntime: { singleReplica: true, multiReplicaRestrictedScaleDown: false },
      ensureHA: { ensureAtLeastOne: true, respectUnevictable: true },
      readinessBufferSeconds: 5,
      updateHPATriggers: true,
      activeEnforcement: false,
      optimizeInitContainers: false,
      optimizeUponAutomation: false,
      binPackUnevictable: true,
      nodeCappingAuto: true,
      requiredWindowCoveragePercentage: 2,
      allowedRolloutPeriod: {
        timezone: 'UTC',
        days: [],
        allDay: true,
        beginTime: '00:00',
        endTime: '00:00',
      },
    },
    schedule: { defaultPolicy: policyNames[1] || 'production', rules: [] },
  };
}

/** Schedule-type Policy → CR object for the YAML tab (scheduleCRObject port). */
export function scheduleCRObject(p: PolicyDetail): Record<string, unknown> {
  const sc = p.schedule || { defaultPolicy: '', rules: [] };
  return {
    apiVersion: 'analysis.coolscaler.sh/v1alpha1',
    kind: 'Policy',
    metadata: { name: p.name || '<name>', namespace: 'coolscaler-system' },
    spec: {
      type: 'Schedule',
      policySchedule: {
        schedulePolicyConfig: {
          defaultPolicy: sc.defaultPolicy,
          rules: (sc.rules || []).map((r) => ({
            policyName: r.policyName,
            sleep: !!r.sleep,
            historyWindowDataPoints: r.historyWindowDataPoints,
            periods: (r.periods || []).map((per) => ({
              weeklyConfig: {
                days: per.days === 'all' ? [0, 1, 2, 3, 4, 5, 6] : per.days,
                beginTime: per.allDay ? '00:00' : per.beginTime,
                endTime: per.allDay ? '23:59' : per.endTime,
              },
            })),
          })),
        },
      },
    },
  };
}

export function suggestDupName(src: string, names: string[]): string {
  const set = new Set(names);
  const b = (src || 'policy') + '-copy';
  if (!set.has(b)) return b;
  let i = 2;
  while (set.has(b + '-' + i)) i++;
  return b + '-' + i;
}

// ---- Detection rules (policy-rules) editor model ----
export interface RuleIdent {
  type: string;
  key: string;
  value: string;
}
export interface RuleBlock {
  policyName: string;
  tag: string;
  rules: RuleIdent[][];
}

const REVERSE_IDENT: Record<string, string> = {
  'Label keys': 'labelKeys',
  'Label key & values': 'labelKV',
  'Annotation keys': 'annotationKeys',
  'Annotation key & values': 'annotationKV',
  'Environment keys': 'envKeys',
};
export function reverseIdentLabel(lbl: string): string {
  return REVERSE_IDENT[lbl] || lbl;
}

/** GET /api/custom-rules-attributes. */
export interface AttrCatalogs {
  labels?: Record<string, string[]>;
  annotations?: Record<string, string[]>;
  envs?: Record<string, string[]>;
}
/** GET /api/cog/group-by-options. */
export interface CogOptions {
  owners?: string[];
  labelsKeys?: string[];
  annotationsKey?: string[];
  images?: string[];
  envsKeys?: string[];
}
