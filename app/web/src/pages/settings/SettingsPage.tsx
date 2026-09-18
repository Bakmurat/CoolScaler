// Settings — nothing hardcoded.
import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { fetchJson, getJson, postJson, putJson } from '../../api/client';
import { useFeedback } from '../../providers/FeedbackProvider';
import { Dropdown, MenuItem, Toggle } from '../rightsizing/ui';
import '../rightsizing/rightsizing.css';

// ---- local response types ----
interface HealthComponent {
  component: string;
  ready: number;
  total: number;
  healthy: boolean;
}
interface HealthResponse {
  healthy?: boolean;
  components?: HealthComponent[];
}
interface WorkloadAutomationCfg {
  excludeLabels?: string[];
  includeLabels?: string[];
  excludeAnnotations?: string[];
  includeAnnotations?: string[];
}
interface NamespaceLabelsCfg {
  includeLabels?: string[];
  excludeLabels?: string[];
}
interface AutomationConfigResponse {
  automateAllNamespaces?: boolean;
  excludedNamespaces?: string[];
  excludedWorkloadTypes?: string[];
  binPackKubeSystem?: boolean;
  binPackOwnerless?: boolean;
  binPackUnevictable?: boolean;
  automate?: { rightsize?: boolean; replicas?: boolean } & Record<string, boolean | undefined>;
  workloadAutomation?: WorkloadAutomationCfg;
  namespaceLabels?: NamespaceLabelsCfg;
  [k: string]: unknown;
}
interface ResourcePricing {
  cpu?: number | null;
  memory?: number | null;
  gpu?: number | null;
}
interface CostConfigResponse {
  costConfig?: {
    includeUnallocatedCost?: boolean;
    customResourcesPricing?: Record<string, ResourcePricing>;
  };
}
interface SaveResponse {
  ok?: boolean;
  error?: string;
  message?: string;
}
/** GET /api/java/config (new backend endpoint; falls back to /api/java totals). */
interface JavaConfigResponse {
  observability?: boolean;
  optimize?: boolean;
  autoAssignPolicy?: boolean;
}
interface JavaTotalsLite {
  totals?: { observabilityEnabled?: boolean; optimizeEnabled?: boolean };
}
interface JavaConfigPostResponse {
  ok?: boolean;
  message?: string;
  rolledOut?: number;
  observability?: boolean;
  optimize?: boolean;
  autoAssignPolicy?: boolean;
}
/** GET /api/custom-rules-attributes: key → [values]. */
interface AttrsResponse {
  labels?: Record<string, string[]>;
  annotations?: Record<string, string[]>;
  envs?: Record<string, string[]>;
}
interface GroupByOptionsResponse {
  namespaces?: string[];
}
interface VersionResponse {
  currentVersion?: string;
  namespace?: string;
}

// ---- shared styles (existing Settings visual language) ----
const card: CSSProperties = {
  background: '#fff',
  border: '1px solid #e9eaf0',
  borderRadius: 16,
  boxShadow: '0 1px 2px rgba(16,24,40,.06)',
  padding: 20,
};
const cardTitle: CSSProperties = { fontSize: 14, fontWeight: 700, color: '#1e2536' };
const subText: CSSProperties = { fontSize: 12, color: '#64748b' };
const pill = (bg: string, text: string, border?: string): CSSProperties => ({
  fontSize: 11,
  fontWeight: 600,
  padding: '2px 9px',
  borderRadius: 9999,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  whiteSpace: 'nowrap',
  background: bg,
  color: text,
  border: border ? `1px solid ${border}` : undefined,
});
const costInput: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  background: '#f4f5f8',
  border: '1px solid #e9eaf0',
  borderRadius: 8,
  padding: '4px 8px',
  fontSize: 12,
  outline: 'none',
  cursor: 'text',
  fontFamily: '"JetBrains Mono", ui-monospace, monospace',
};
const btn = (variant: 'indigo' | 'indigo-outline' | 'rose-outline'): CSSProperties => ({
  fontSize: 12,
  fontWeight: 600,
  borderRadius: 8,
  padding: '6px 14px',
  cursor: 'pointer',
  fontFamily: 'inherit',
  ...(variant === 'indigo'
    ? { background: '#6366f1', color: '#fff', border: '1px solid #6366f1' }
    : variant === 'indigo-outline'
      ? { background: '#fff', color: '#4f46e5', border: '1px solid #c7d2fe' }
      : { background: '#fff', color: '#e11d48', border: '1px solid #fecdd3' }),
});

// six pricing fields: [key, label]
const PRICE_FIELDS: Array<{ tier: 'manual' | 'manual-spot'; res: keyof ResourcePricing; label: string }> = [
  { tier: 'manual', res: 'cpu', label: 'On-demand CPU ($/core·h)' },
  { tier: 'manual', res: 'memory', label: 'On-demand memory ($/GB·h)' },
  { tier: 'manual', res: 'gpu', label: 'On-demand GPU ($/GPU·h)' },
  { tier: 'manual-spot', res: 'cpu', label: 'Spot CPU ($/core·h)' },
  { tier: 'manual-spot', res: 'memory', label: 'Spot memory ($/GB·h)' },
  { tier: 'manual-spot', res: 'gpu', label: 'Spot GPU ($/GPU·h)' },
];

const WORKLOAD_TYPES = ['Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob'];

const strArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/** Flatten an attribute catalog map (key → [values]) into "key=value" options. */
function kvOptions(m?: Record<string, string[]>): string[] {
  const out: string[] = [];
  for (const k of Object.keys(m || {}).sort()) {
    const vals = (m as Record<string, string[]>)[k] || [];
    for (const v of vals) {
      out.push(k + '=' + v);
      if (out.length >= 500) return out;
    }
  }
  return out;
}


function MultiChipSelect({
  label,
  values,
  options,
  onChange,
  freeTextHint,
}: {
  label: ReactNode;
  values: string[];
  options: string[];
  onChange: (next: string[]) => void;
  /** placeholder for the free-text entry; omit to disable free text */
  freeTextHint?: string;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const add = (v: string) => {
    const t = v.trim();
    if (t && !values.includes(t)) onChange([...values, t]);
  };
  const remove = (v: string) => onChange(values.filter((x) => x !== v));
  const filtered = options.filter(
    (o) => !values.includes(o) && (!text.trim() || o.toLowerCase().includes(text.trim().toLowerCase())),
  );
  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 600, color: '#475569', marginBottom: 4 }}>{label}</div>
      <div style={{ position: 'relative' }}>
        <div
          onClick={() => setOpen((o) => !o)}
          style={{
            minHeight: 34,
            display: 'flex',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 6,
            padding: '5px 10px',
            borderRadius: 9,
            border: '1px solid #e3e5ee',
            background: '#fff',
            cursor: 'pointer',
          }}
        >
          <span style={{ fontSize: 11, color: values.length ? '#4f46e5' : '#94a3b8', fontWeight: 600 }}>
            Selected ({values.length})
          </span>
          {values.map((v) => (
            <span
              key={v}
              className="pill"
              style={{ background: '#eef2ff', color: '#4f46e5', border: '1px solid #e0e7ff' }}
              onClick={(e) => e.stopPropagation()}
            >
              <span className="num">{v}</span>
              <span
                title="Remove"
                onClick={() => remove(v)}
                style={{ cursor: 'pointer', fontWeight: 700, marginLeft: 2 }}
              >
                ✕
              </span>
            </span>
          ))}
          <span style={{ marginLeft: 'auto', color: '#94a3b8', fontSize: 11 }}>▾</span>
        </div>
        <Dropdown
          open={open}
          onClose={() => setOpen(false)}
          style={{ left: 0, right: 0, maxHeight: 280, overflowY: 'auto', padding: 8 }}
        >
          {freeTextHint != null && (
            <input
              className="chip"
              style={{ width: '100%', boxSizing: 'border-box', cursor: 'text', marginBottom: 6 }}
              placeholder={freeTextHint}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && text.trim()) {
                  add(text);
                  setText('');
                }
              }}
              onClick={(e) => e.stopPropagation()}
            />
          )}
          {filtered.slice(0, 200).map((o) => (
            <MenuItem
              key={o}
              label={<span className="num" style={{ fontSize: 12 }}>{o}</span>}
              onClick={() => add(o)}
            />
          ))}
          {!filtered.length && (
            <div style={{ fontSize: 11, color: '#94a3b8', padding: '6px 10px' }}>
              {options.length ? 'no more options' : freeTextHint != null ? 'type a value and press Enter' : 'no options'}
            </div>
          )}
        </Dropdown>
      </div>
    </div>
  );
}

// ---------- section wrapper with per-section Save ----------

function SettingsSection({
  title,
  titleExtra,
  note,
  onSave,
  children,
}: {
  title: ReactNode;
  titleExtra?: ReactNode;
  note?: ReactNode;
  onSave?: () => void;
  children: ReactNode;
}) {
  return (
    <section style={card}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
        <div style={{ ...cardTitle, display: 'flex', alignItems: 'center', gap: 8 }}>
          {title}
          {titleExtra}
        </div>
        {onSave && (
          <button onClick={onSave} style={btn('indigo')}>
            Save
          </button>
        )}
      </div>
      {note && <p style={{ ...subText, margin: '0 0 12px' }}>{note}</p>}
      {children}
    </section>
  );
}

// =========================================================================

type TabKey = 'cloud' | 'integrations' | 'ingress' | 'cost' | 'metrics' | 'general' | 'support';
const TABS: [TabKey, string][] = [
  ['cloud', 'Cloud integration'],
  ['integrations', 'Agents Integrations'],
  ['ingress', 'Ingress'],
  ['cost', 'Cost'],
  ['metrics', 'Metrics'],
  ['general', 'General'],
  ['support', 'Support'],
];

interface SlackConfResponse {
  config?: { token?: string; defaultChannel?: { id?: string; name?: string }; disabled?: boolean };
  availableAlertTypes?: string[];
}
interface IngressListResponse {
  ingresses?: { name: string; host?: string; className?: string | null; managed?: boolean }[];
  istioHost?: string;
}

interface MetricConf { name: string; promQuery: string; Labels?: string[] }
interface MetricsConfResponse { metricsConf?: MetricConf[] }

export default function SettingsPage() {
  const { toast, confirm } = useFeedback();
  const [tab, setTab] = useState<TabKey>('general');

  // ---- health ----
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthErr, setHealthErr] = useState(false);

  // ---- automation config (raw object + edited fields) ----
  const [autoRaw, setAutoRaw] = useState<AutomationConfigResponse | null>(null);
  const [autoErr, setAutoErr] = useState(false);
  const [exTypes, setExTypes] = useState<string[]>([]);
  const [waExLabels, setWaExLabels] = useState<string[]>([]);
  const [waInLabels, setWaInLabels] = useState<string[]>([]);
  const [waExAnns, setWaExAnns] = useState<string[]>([]);
  const [waInAnns, setWaInAnns] = useState<string[]>([]);
  const [exNamespaces, setExNamespaces] = useState<string[]>([]);
  const [nsInLabels, setNsInLabels] = useState<string[]>([]);
  const [nsExLabels, setNsExLabels] = useState<string[]>([]);

  // ---- attribute catalogs ----
  const [attrs, setAttrs] = useState<AttrsResponse | null>(null);
  const [nsOptions, setNsOptions] = useState<string[]>([]);

  // ---- java config ----
  const [javaCfg, setJavaCfg] = useState<JavaConfigResponse | null>(null);

  // ---- cost settings ----
  const [cost, setCost] = useState<Record<string, string> | null>(null);
  const [costUnalloc, setCostUnalloc] = useState(false);
  const [costErr, setCostErr] = useState(false);

  // ---- version (Support tab) ----
  const [version, setVersion] = useState<string | null>(null);

  // ---- Slack integration (Agents Integrations tab) ----
  const [slackConf, setSlackConf] = useState<SlackConfResponse | null>(null);
  const [slackToken, setSlackToken] = useState('');
  const [slackChannel, setSlackChannel] = useState('');
  const [slackBusy, setSlackBusy] = useState(false);
  const loadSlack = useCallback(() => {
    getJson<SlackConfResponse>('/api/slack/conf').then(setSlackConf).catch(() => {});
  }, []);
  const slackConnect = async () => {
    if (!slackToken.trim()) { toast('Slack token is missing.', 'error'); return; }
    setSlackBusy(true);
    try {
      const tv = await getJson<{ valid?: boolean; error?: string }>('/api/slack/verify/token?token=' + encodeURIComponent(slackToken.trim()));
      if (!tv.valid) { toast('Slack token is invalid: ' + (tv.error || ''), 'error'); return; }
      let ch: { id?: string; name?: string } = {};
      if (slackChannel.trim()) {
        const cv = await getJson<{ valid?: boolean; id?: string; name?: string; error?: string }>(
          '/api/slack/verify/channel?token=' + encodeURIComponent(slackToken.trim()) + '&channel=' + encodeURIComponent(slackChannel.trim()));
        if (!cv.valid) { toast('Default channel is invalid: ' + (cv.error || ''), 'error'); return; }
        ch = { id: cv.id, name: cv.name };
      }
      await postJson('/api/alerts/slack/multicluster/settings', { multiCluster: false, token: slackToken.trim(), ...(ch.id ? { defaultChannel: ch } : {}) });
      toast('Slack connected.', 'ok');
      setSlackToken('');
      loadSlack();
    } catch (e) { toast('Slack connect failed: ' + e, 'error'); } finally { setSlackBusy(false); }
  };
  const slackDisconnect = async () => {
    if (!(await confirm('Disconnect Slack (clears token and channel)?'))) return;
    await postJson('/api/alerts/slack/multicluster/settings', { multiCluster: false, token: '', defaultChannel: { id: '', name: '' } });
    toast('Slack disconnected.', 'ok');
    loadSlack();
  };
  const slackTest = async () => {
    setSlackBusy(true);
    try {
      const r = await postJson<{ ok?: boolean; error?: string }>('/api/alerts/slack/test', { multiCluster: false, direct: true });
      if (r.ok) toast('Test alert sent to Slack.', 'ok');
      else toast('Test alert failed: ' + (r.error || ''), 'error');
    } finally { setSlackBusy(false); }
  };

  // ---- Ingress tab ----
  const [ingressData, setIngressData] = useState<IngressListResponse | null>(null);
  const [ingHost, setIngHost] = useState('');
  const [ingClass, setIngClass] = useState('');
  const loadIngress = useCallback(() => {
    getJson<IngressListResponse>('/api/settings/ingresses').then(setIngressData).catch(() => {});
  }, []);
  const ingressCreate = async () => {
    if (!ingHost.trim()) { toast('Host is required.', 'error'); return; }
    const r = await postJson<{ ok?: boolean; error?: string }>('/api/settings/ingresses', { host: ingHost.trim(), className: ingClass.trim() || undefined });
    if (r.ok) { toast('Ingress created.', 'ok'); setIngHost(''); loadIngress(); }
    else toast('Failed: ' + (r.error || ''), 'error');
  };
  const ingressDelete = async () => {
    if (!(await confirm('Delete the CoolScaler-managed Ingress?'))) return;
    const r = await fetchJson<{ ok?: boolean; error?: string }>('/api/settings/ingresses', { method: 'DELETE' });
    if (r.ok) { toast('Ingress deleted.', 'ok'); loadIngress(); }
    else toast('Failed: ' + (r.error || ''), 'error');
  };

  // custom metrics
  const [metricsConf, setMetricsConf] = useState<MetricConf[]>([]);
  const [mcEdit, setMcEdit] = useState<{ name: string; promQuery: string; labels: string } | null>(null);
  const [mcOrigName, setMcOrigName] = useState('');
  const loadMetricsConf = useCallback(() => {
    getJson<MetricsConfResponse>('/api/metricsConf/')
      .then((d) => setMetricsConf(d.metricsConf || []))
      .catch(() => {});
  }, []);
  const saveMetricConf = async () => {
    if (!mcEdit || !mcEdit.name.trim() || !mcEdit.promQuery.trim()) {
      toast('Metric name and Prometheus query are required.', 'error');
      return;
    }
    try {
      if (mcOrigName && mcOrigName !== mcEdit.name.trim()) {
        await putJson<MetricsConfResponse>('/api/metricsConf/remove', { metricName: mcOrigName });
      }
      const r = await putJson<MetricsConfResponse>('/api/metricsConf/update', {
        metricConf: {
          name: mcEdit.name.trim(),
          promQuery: mcEdit.promQuery.trim(),
          Labels: mcEdit.labels.split(',').map((x) => x.trim()).filter(Boolean),
        },
      });
      setMetricsConf(r.metricsConf || []);
      setMcEdit(null);
      setMcOrigName('');
      toast('Metric saved.', 'ok');
    } catch (e) {
      toast('Save failed: ' + e, 'error');
    }
  };
  const removeMetricConf = async (name: string) => {
    if (!(await confirm(`Delete custom metric "${name}"?`))) return;
    try {
      const r = await putJson<MetricsConfResponse>('/api/metricsConf/remove', { metricName: name });
      setMetricsConf(r.metricsConf || []);
      toast('Metric deleted.', 'ok');
    } catch (e) {
      toast('Delete failed: ' + e, 'error');
    }
  };

  const loadAutomation = useCallback(() => {
    getJson<AutomationConfigResponse>('/api/automation-config')
      .then((a) => {
        setAutoRaw(a);
        setAutoErr(false);
        setExTypes(strArr(a.excludedWorkloadTypes));
        setExNamespaces(strArr(a.excludedNamespaces));
        const wa = a.workloadAutomation || {};
        setWaExLabels(strArr(wa.excludeLabels));
        setWaInLabels(strArr(wa.includeLabels));
        setWaExAnns(strArr(wa.excludeAnnotations));
        setWaInAnns(strArr(wa.includeAnnotations));
        const nl = a.namespaceLabels || {};
        setNsInLabels(strArr(nl.includeLabels));
        setNsExLabels(strArr(nl.excludeLabels));
      })
      .catch(() => setAutoErr(true));
  }, []);

  const loadJava = useCallback(() => {
    getJson<JavaConfigResponse>('/api/java/config')
      .then((j) => setJavaCfg(j))
      .catch(() => {
        // GET /api/java/config not shipped yet — fall back to /api/java totals.
        getJson<JavaTotalsLite>('/api/java')
          .then((d) =>
            setJavaCfg({
              observability: !!d.totals?.observabilityEnabled,
              optimize: !!d.totals?.optimizeEnabled,
            }),
          )
          .catch(() => setJavaCfg(null));
      });
  }, []);

  const loadCost = useCallback(() => {
    getJson<CostConfigResponse>('/api/cost/config')
      .then((d) => {
        const crp = d.costConfig?.customResourcesPricing || {};
        const vals: Record<string, string> = {};
        for (const f of PRICE_FIELDS) {
          const v = (crp[f.tier] || {})[f.res];
          vals[`${f.tier}.${f.res}`] = v == null ? '' : String(v);
        }
        setCost(vals);
        setCostUnalloc(!!d.costConfig?.includeUnallocatedCost);
        setCostErr(false);
      })
      .catch(() => setCostErr(true));
  }, []);

  useEffect(() => {
    getJson<HealthResponse>('/api/health')
      .then((h) => {
        setHealth(h);
        setHealthErr(false);
      })
      .catch(() => setHealthErr(true));
    getJson<AttrsResponse>('/api/custom-rules-attributes')
      .then(setAttrs)
      .catch(() => {});
    getJson<GroupByOptionsResponse>('/api/cog/group-by-options')
      .then((d) => setNsOptions(strArr(d.namespaces)))
      .catch(() => {});
    getJson<VersionResponse>('/api/version')
      .then((v) => setVersion(v.currentVersion || null))
      .catch(() => {});
    loadAutomation();
    loadJava();
    loadCost();
    loadMetricsConf();
    loadSlack();
    loadIngress();
  }, [loadAutomation, loadJava, loadCost, loadMetricsConf, loadSlack, loadIngress]);

  const labelOptions = useMemo(() => kvOptions(attrs?.labels), [attrs]);
  const annOptions = useMemo(() => kvOptions(attrs?.annotations), [attrs]);

  // ---------- saves ----------

  const saveAutomation = async () => {
    const body: AutomationConfigResponse = {
      ...(autoRaw || {}),
      excludedWorkloadTypes: exTypes,
      excludedNamespaces: exNamespaces,
      workloadAutomation: {
        excludeLabels: waExLabels,
        includeLabels: waInLabels,
        excludeAnnotations: waExAnns,
        includeAnnotations: waInAnns,
      },
      namespaceLabels: { includeLabels: nsInLabels, excludeLabels: nsExLabels },
    };
    try {
      await postJson<SaveResponse>('/api/automation-config', body);
      toast('Automation settings saved.', 'ok');
      loadAutomation();
    } catch (e) {
      toast('Save failed: ' + e, 'error');
    }
  };

  // POST /api/java/config — sends both the current handler keys
  // (observability/optimize/rollout, bool) and the new-contract string keys
  // (javaObservability/javaOptimize/rolloutNow) so it works on either backend.
  const javaObsAction = async (enable: boolean, rolloutNow: boolean) => {
    if (enable && rolloutNow) {
      if (!(await confirm('Enable Java observability now and roll out ALL Java workloads so existing pods start collecting real usage?')))
        return;
    }
    try {
      const r = await postJson<JavaConfigPostResponse>('/api/java/config', {
        observability: enable,
        javaObservability: enable ? 'true' : 'false',
        ...(rolloutNow ? { rollout: true, rolloutNow: true } : {}),
      });
      if (r.ok === false) toast('Failed: ' + (r.message || ''), 'error');
      else
        toast(
          'Java observability ' +
            (enable ? 'enabled' : 'disabled') +
            (r.rolledOut ? ' · rolled out ' + r.rolledOut + ' workload(s)' : '') +
            '.',
          'ok',
        );
    } catch {
      toast('Request failed.', 'error');
    }
    window.setTimeout(loadJava, 700);
  };

  const autoAssignToggle = async (on: boolean) => {
    try {
      const r = await postJson<JavaConfigPostResponse>('/api/java/config', {
        autoAssignPolicy: on ? 'true' : 'false',
      });
      if (r.ok === false) toast('Failed: ' + (r.message || ''), 'error');
      else {
        setJavaCfg((p) => ({ ...(p || {}), autoAssignPolicy: on }));
        toast('Auto-assign java policy ' + (on ? 'enabled' : 'disabled') + '.', 'ok');
      }
    } catch {
      toast('Request failed.', 'error');
    }
    window.setTimeout(loadJava, 700);
  };

  const costSettingsSave = async () => {
    const num = (k: string) => {
      const v = cost?.[k];
      return v === '' || v == null ? null : Number(v);
    };
    const body = {
      costConfig: {
        includeUnallocatedCost: costUnalloc,
        customResourcesPricing: {
          manual: { cpu: num('manual.cpu'), memory: num('manual.memory'), gpu: num('manual.gpu') },
          'manual-spot': {
            cpu: num('manual-spot.cpu'),
            memory: num('manual-spot.memory'),
            gpu: num('manual-spot.gpu'),
          },
        },
      },
    };
    try {
      const r = await postJson<SaveResponse>('/api/cost/config', body);
      if (r && r.ok) {
        toast('Cost settings saved — pricing applied live');
        loadCost();
      } else toast('Save failed' + (r && r.error ? ': ' + r.error : ''), 'error');
    } catch (e) {
      toast('Save failed: ' + e, 'error');
    }
  };

  const obs = !!javaCfg?.observability;

  return (
    <main style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* header */}
      <section style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div
          style={{ height: 32, width: 32, borderRadius: 8, background: '#eef2ff', display: 'grid', placeItems: 'center' }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="1.8">
            <circle cx="12" cy="12" r="3" />
            <path d="M4 12h3M17 12h3M12 4v3M12 17v3" />
          </svg>
        </div>
        <div>
          <h1 style={{ fontSize: 17, fontWeight: 700, color: '#1e2536', margin: 0 }}>Settings</h1>
          <p style={{ ...subText, margin: 0 }}>Cluster configuration, cost model, Java optimization &amp; component health.</p>
        </div>
      </section>

      {/* folder-tab strip */}
      <div style={{ display: 'flex', gap: 2, borderBottom: '1px solid #e9eaf0' }}>
        {TABS.map(([k, label]) => (
          <span key={k} className={'tabline' + (tab === k ? ' active' : '')} onClick={() => setTab(k)}>
            {label}
          </span>
        ))}
      </div>

      {/* ================= GENERAL ================= */}
      {tab === 'general' && (
        <>
          <h2 style={{ fontSize: 14, fontWeight: 700, color: '#1e2536', margin: '4px 0 0' }}>Current cluster</h2>

          {/* 1 · Java Optimization */}
          <SettingsSection
            title={
              <>
                <span style={{ fontSize: 15 }}>☕</span> Java Optimization
              </>
            }
            titleExtra={<span style={pill('#eef2ff', '#4f46e5', '#e0e7ff')}>Beta</span>}
            note="Size Java workloads from measured JVM memory instead of container memory."
          >
            {/* Enable Java Observability */}
            <div style={{ border: '1px solid #eef0f6', borderRadius: 12, padding: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#1e2536', marginBottom: 6 }}>
                Enable Java Observability
              </div>
              <ul style={{ margin: '0 0 12px', paddingLeft: 18, fontSize: 12, color: '#64748b', display: 'flex', flexDirection: 'column', gap: 3 }}>
                <li>Collects JVM heap and non-heap usage through an injected JMX exporter</li>
                <li>Adds an init container to each Java workload</li>
                <li>Rollout your Java workloads after enabling to start collection</li>
              </ul>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '10px 14px',
                  borderRadius: 10,
                  fontSize: 13,
                  fontWeight: 600,
                  marginBottom: 12,
                  ...(obs
                    ? { background: '#f0fdf4', color: '#16a34a', border: '1px solid #dcfce7' }
                    : { background: '#f8fafc', color: '#64748b', border: '1px solid #eef0f6' }),
                }}
              >
                <span style={{ fontSize: 15 }}>{obs ? '✓' : '⊗'}</span>
                Java Observability {javaCfg == null ? '—' : obs ? 'Enabled' : 'Disabled'}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                {obs ? (
                  <button style={btn('rose-outline')} onClick={() => void javaObsAction(false, false)}>
                    Disable
                  </button>
                ) : (
                  <>
                    <button style={btn('indigo')} onClick={() => void javaObsAction(true, false)}>
                      Enable Upon Pod Creation
                    </button>
                    <button style={btn('indigo')} onClick={() => void javaObsAction(true, true)}>
                      Enable Now
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* Java Optimization Policy */}
            <div style={{ border: '1px solid #eef0f6', borderRadius: 12, padding: 16, marginTop: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#1e2536', marginBottom: 4 }}>
                Java Optimization Policy
              </div>
              <p style={{ ...subText, margin: '0 0 10px' }}>
                Automatically detect Java workloads and apply the java-memory-aware policy. This policy uses actual
                Java memory usage to improve optimization.
              </p>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 10, fontSize: 12, color: '#475569', fontWeight: 600 }}>
                <Toggle
                  checked={!!javaCfg?.autoAssignPolicy}
                  onChange={(on) => void autoAssignToggle(on)}
                  title="Assign the java-memory-aware policy to detected Java workloads"
                />
                Assign java-memory-aware policy to Java workloads.
              </label>
            </div>
          </SettingsSection>

          {/* 2 · Workload operations */}
          <SettingsSection
            title="Workload operations"
            note={
              <span style={{ color: '#d97706' }}>
                Changing excluded/included workload settings disables automation and triggers a rollout for affected
                workloads
              </span>
            }
            onSave={() => void saveAutomation()}
          >
            {autoErr ? (
              <div style={{ ...subText, color: '#94a3b8' }}>automation config unavailable</div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                <MultiChipSelect
                  label="Excluded workload types from automation"
                  values={exTypes}
                  options={WORKLOAD_TYPES}
                  onChange={setExTypes}
                />
                <div />
                <MultiChipSelect
                  label="Excluded workload labels"
                  values={waExLabels}
                  options={labelOptions}
                  onChange={setWaExLabels}
                  freeTextHint="type key=value and press Enter (value may be regex)"
                />
                <MultiChipSelect
                  label="Automated workload labels"
                  values={waInLabels}
                  options={labelOptions}
                  onChange={setWaInLabels}
                  freeTextHint="type key=value and press Enter (value may be regex)"
                />
                <MultiChipSelect
                  label="Excluded workload annotations"
                  values={waExAnns}
                  options={annOptions}
                  onChange={setWaExAnns}
                  freeTextHint="type key=value and press Enter (value may be regex)"
                />
                <MultiChipSelect
                  label="Automated workload annotations"
                  values={waInAnns}
                  options={annOptions}
                  onChange={setWaInAnns}
                  freeTextHint="type key=value and press Enter (value may be regex)"
                />
              </div>
            )}
          </SettingsSection>

          {/* 3 · Namespace operations */}
          <SettingsSection title="Namespace operations" onSave={() => void saveAutomation()}>
            {autoErr ? (
              <div style={{ ...subText, color: '#94a3b8' }}>automation config unavailable</div>
            ) : (
              <MultiChipSelect
                label={
                  <>
                    Ignored Namespaces{' '}
                    <span style={{ fontWeight: 400, color: '#94a3b8' }}>
                      — Ignore these namespaces in all CoolScaler operations. They will not be visible to users.
                    </span>
                  </>
                }
                values={exNamespaces}
                options={nsOptions}
                onChange={setExNamespaces}
                freeTextHint="type a namespace (regex ok, e.g. openshift.*) and press Enter"
              />
            )}
          </SettingsSection>

          {/* 4 · Custom Namespace Labels */}
          <SettingsSection title="Custom Namespace Labels" onSave={() => void saveAutomation()}>
            {autoErr ? (
              <div style={{ ...subText, color: '#94a3b8' }}>automation config unavailable</div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                <MultiChipSelect
                  label="Select labels to automate"
                  values={nsInLabels}
                  options={labelOptions}
                  onChange={setNsInLabels}
                  freeTextHint="type key=value and press Enter"
                />
                <MultiChipSelect
                  label="Select labels to exclude from automation"
                  values={nsExLabels}
                  options={labelOptions}
                  onChange={setNsExLabels}
                  freeTextHint="type key=value and press Enter"
                />
              </div>
            )}
          </SettingsSection>

          {/* 5 · Component health */}
          <section style={card}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <div style={cardTitle}>Component health</div>
              {health == null ? (
                <span style={pill('#f1f5f9', '#94a3b8')}>—</span>
              ) : health.healthy ? (
                <span style={pill('#f0fdf4', '#16a34a', '#dcfce7')}>All healthy</span>
              ) : (
                <span style={pill('#fff1f2', '#e11d48', '#fecdd3')}>Degraded</span>
              )}
            </div>
            {healthErr ? (
              <div style={{ color: '#94a3b8', fontSize: 14 }}>health unavailable</div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
                {(health?.components || []).map((cmp) => (
                  <div key={cmp.component} style={{ borderRadius: 12, border: '1px solid #eef0f6', padding: 12 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span
                        style={{
                          height: 10,
                          width: 10,
                          borderRadius: 9999,
                          flexShrink: 0,
                          background: cmp.healthy ? '#22c55e' : '#f43f5e',
                        }}
                      />
                      <span
                        style={{
                          fontSize: 12,
                          fontWeight: 600,
                          color: '#1e2536',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {cmp.component}
                      </span>
                    </div>
                    <div className="num" style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>
                      {cmp.ready}/{cmp.total} ready
                    </div>
                  </div>
                ))}
                {health != null && (health.components || []).length === 0 && (
                  <div style={{ color: '#94a3b8', fontSize: 14, gridColumn: 'span 4' }}>no components</div>
                )}
              </div>
            )}
          </section>
        </>
      )}

      {/* ================= AGENTS INTEGRATIONS (Slack) ================= */}
      {tab === 'integrations' && (
        <section style={card}>
          <div style={cardTitle}>Agents Integrations</div>
          <p style={{ ...subText, margin: '4px 0 16px' }}>Connect CoolScaler to the tools your team already uses.</p>
          <div style={{ border: '1px solid #e3e5ee', borderRadius: 12, padding: 18, maxWidth: 640 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: '#1e2536' }}>Slack</div>
              {slackConf?.config?.token ? (
                <span style={pill('#f0fdf4', '#16a34a', '#bbf7d0')}>Connected · {slackConf.config.defaultChannel?.name ? '#' + slackConf.config.defaultChannel.name : 'no default channel'}</span>
              ) : (
                <span style={pill('#f1f5f9', '#64748b')}>Not connected</span>
              )}
            </div>
            <p style={{ ...subText, margin: '0 0 12px' }}>
              Route CoolScaler alerts to a Slack channel. The token and channel are verified against the Slack API; alerts deliver on the configured interval.
            </p>
            {slackConf?.config?.token ? (
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => void slackTest()} disabled={slackBusy} style={btn('indigo')}>Send Test Alert</button>
                <button onClick={() => void slackDisconnect()} style={btn('rose-outline')}>Disconnect</button>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <label style={{ fontSize: 12.5, color: '#475569', display: 'flex', flexDirection: 'column', gap: 4 }}>
                  Bot token (xoxb-…)
                  <input value={slackToken} onChange={(e) => setSlackToken(e.target.value)} type="password" placeholder="xoxb-..." style={{ border: '1px solid #dfe2ec', borderRadius: 8, padding: '8px 12px', fontSize: 13, fontFamily: 'ui-monospace, monospace', outline: 'none' }} />
                </label>
                <label style={{ fontSize: 12.5, color: '#475569', display: 'flex', flexDirection: 'column', gap: 4 }}>
                  Default channel
                  <input value={slackChannel} onChange={(e) => setSlackChannel(e.target.value)} placeholder="#alerts" style={{ border: '1px solid #dfe2ec', borderRadius: 8, padding: '8px 12px', fontSize: 13, outline: 'none', fontFamily: 'inherit' }} />
                </label>
                <div>
                  <button onClick={() => void slackConnect()} disabled={slackBusy} style={btn('indigo')}>{slackBusy ? 'Verifying…' : 'Verify & Connect'}</button>
                </div>
              </div>
            )}
            <div style={{ ...subText, marginTop: 12 }}>
              Alert types delivered: {(slackConf?.availableAlertTypes || []).slice(0, 7).join(', ')}{(slackConf?.availableAlertTypes || []).length > 7 ? ` +${(slackConf?.availableAlertTypes || []).length - 7} more` : ''}
            </div>
          </div>
        </section>
      )}

      {/* ================= INGRESS ================= */}
      {tab === 'ingress' && (
        <section style={card}>
          <div style={cardTitle}>Ingress</div>
          <p style={{ ...subText, margin: '4px 0 16px' }}>Expose the CoolScaler dashboard through a Kubernetes Ingress.</p>
          {ingressData?.istioHost && (
            <div style={{ fontSize: 12.5, color: '#475569', background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 10, padding: '10px 14px', marginBottom: 14, maxWidth: 640 }}>
              This install is currently exposed via Istio at <b>https://{ingressData.istioHost}</b>.
            </div>
          )}
          <table style={{ width: '100%', maxWidth: 720, borderCollapse: 'collapse', fontSize: 13, marginBottom: 16 }}>
            <thead>
              <tr>
                {['Name', 'Host', 'Class', ''].map((h) => (
                  <th key={h} style={{ textAlign: 'left', fontSize: 12, fontWeight: 700, color: '#1e2536', padding: '8px 12px', background: '#f6f7fb', borderBottom: '1px solid #eef0f6' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(ingressData?.ingresses || []).map((i) => (
                <tr key={i.name}>
                  <td style={{ padding: '9px 12px', borderBottom: '1px solid #f2f3f8', fontWeight: 500 }}>{i.name}</td>
                  <td style={{ padding: '9px 12px', borderBottom: '1px solid #f2f3f8', color: '#475569' }}>{i.host || '—'}</td>
                  <td style={{ padding: '9px 12px', borderBottom: '1px solid #f2f3f8', color: '#64748b' }}>{i.className || 'default'}</td>
                  <td style={{ padding: '9px 12px', borderBottom: '1px solid #f2f3f8', textAlign: 'right' }}>
                    {i.managed && <button onClick={() => void ingressDelete()} style={btn('rose-outline')}>Delete</button>}
                  </td>
                </tr>
              ))}
              {!(ingressData?.ingresses || []).length && (
                <tr><td colSpan={4} style={{ padding: '20px 0', textAlign: 'center', color: '#94a3b8', fontSize: 12.5 }}>No Ingress resources in the namespace.</td></tr>
              )}
            </tbody>
          </table>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', maxWidth: 720 }}>
            <label style={{ flex: 2, fontSize: 12.5, color: '#475569', display: 'flex', flexDirection: 'column', gap: 4 }}>
              Host
              <input value={ingHost} onChange={(e) => setIngHost(e.target.value)} placeholder="coolscaler.example.com" style={{ border: '1px solid #dfe2ec', borderRadius: 8, padding: '8px 12px', fontSize: 13, outline: 'none', fontFamily: 'inherit' }} />
            </label>
            <label style={{ flex: 1, fontSize: 12.5, color: '#475569', display: 'flex', flexDirection: 'column', gap: 4 }}>
              Ingress class (optional)
              <input value={ingClass} onChange={(e) => setIngClass(e.target.value)} placeholder="nginx" style={{ border: '1px solid #dfe2ec', borderRadius: 8, padding: '8px 12px', fontSize: 13, outline: 'none', fontFamily: 'inherit' }} />
            </label>
            <button onClick={() => void ingressCreate()} style={{ ...btn('indigo'), height: 34 }}>Create Ingress</button>
          </div>
        </section>
      )}

      {/* ================= METRICS (custom metricsConf) ================= */}
      {tab === 'metrics' && (
        <section style={card}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
            <div style={cardTitle}>Custom metrics</div>
            {!mcEdit && (
              <button onClick={() => { setMcEdit({ name: '', promQuery: '', labels: '' }); setMcOrigName(''); }} style={btn('indigo')}>
                Add metric
              </button>
            )}
          </div>
          <p style={{ fontSize: 12.5, color: '#64748b', margin: '0 0 14px', maxWidth: 720 }}>
            Metrics and Workloads are being adjusted together if they have the same label value for the
            supplied Selector Keys. The label value is taken from deployment selector or deployment labels
            if the first not exists. Queries use a literal <code>&lt;&lt;SELECTOR&gt;&gt;</code> placeholder.
          </p>
          {mcEdit && (
            <div style={{ border: '1px solid #e3e5ee', borderRadius: 10, padding: 16, marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <label style={{ fontSize: 12.5, color: '#475569', display: 'flex', flexDirection: 'column', gap: 4 }}>
                Metric Name
                <input value={mcEdit.name} onChange={(e) => setMcEdit({ ...mcEdit, name: e.target.value })} style={{ border: '1px solid #dfe2ec', borderRadius: 8, padding: '8px 12px', fontSize: 13, fontFamily: 'inherit', outline: 'none' }} />
              </label>
              <label style={{ fontSize: 12.5, color: '#475569', display: 'flex', flexDirection: 'column', gap: 4 }}>
                Prometheus Query Template
                <input value={mcEdit.promQuery} onChange={(e) => setMcEdit({ ...mcEdit, promQuery: e.target.value })} placeholder="Example: sum(rate(http_requests_total{<<SELECTOR>>}[1m]))" style={{ border: '1px solid #dfe2ec', borderRadius: 8, padding: '8px 12px', fontSize: 13, fontFamily: 'ui-monospace, monospace', outline: 'none' }} />
              </label>
              <label style={{ fontSize: 12.5, color: '#475569', display: 'flex', flexDirection: 'column', gap: 4 }}>
                Selector Keys (comma-separated)
                <input value={mcEdit.labels} onChange={(e) => setMcEdit({ ...mcEdit, labels: e.target.value })} placeholder="job, app" style={{ border: '1px solid #dfe2ec', borderRadius: 8, padding: '8px 12px', fontSize: 13, fontFamily: 'inherit', outline: 'none' }} />
              </label>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={saveMetricConf} style={btn('indigo')}>Save metric</button>
                <button onClick={() => { setMcEdit(null); setMcOrigName(''); }} style={btn('indigo-outline')}>Cancel</button>
              </div>
            </div>
          )}
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {['Metric Name', 'Prometheus Query', 'Selector Keys', ''].map((h) => (
                  <th key={h} style={{ textAlign: 'left', fontSize: 12.5, fontWeight: 700, color: '#1e2536', padding: '10px 12px', background: '#f6f7fb', borderBottom: '1px solid #eef0f6' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {metricsConf.map((m) => (
                <tr key={m.name}>
                  <td style={{ fontSize: 13, fontWeight: 600, color: '#334155', padding: '11px 12px', borderBottom: '1px solid #f2f3f8' }}>{m.name}</td>
                  <td style={{ fontSize: 12, color: '#475569', padding: '11px 12px', borderBottom: '1px solid #f2f3f8', fontFamily: 'ui-monospace, monospace', maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={m.promQuery}>{m.promQuery}</td>
                  <td style={{ fontSize: 12.5, color: '#64748b', padding: '11px 12px', borderBottom: '1px solid #f2f3f8' }}>{(m.Labels || []).join(', ')}</td>
                  <td style={{ padding: '11px 12px', borderBottom: '1px solid #f2f3f8', textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button onClick={() => { setMcEdit({ name: m.name, promQuery: m.promQuery, labels: (m.Labels || []).join(', ') }); setMcOrigName(m.name); }} style={{ ...btn('indigo-outline'), marginRight: 6 }}>Edit</button>
                    <button onClick={() => removeMetricConf(m.name)} style={btn('rose-outline')}>Delete</button>
                  </td>
                </tr>
              ))}
              {!metricsConf.length && (
                <tr><td colSpan={4} style={{ textAlign: 'center', color: '#94a3b8', fontSize: 13, padding: '30px 0' }}>No custom metrics defined.</td></tr>
              )}
            </tbody>
          </table>
        </section>
      )}

      {/* ================= COST ================= */}
      {tab === 'cost' && (
        <section style={card}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
            <div style={cardTitle}>Cost settings</div>
            <button onClick={costSettingsSave} style={btn('indigo')}>
              Save
            </button>
          </div>
          <p style={{ ...subText, margin: '0 0 12px' }}>
            Hourly per-resource pricing used by the cost model (CPU per core·h, memory per GB·h, GPU per GPU·h). Saved
            to the{' '}
            <code style={{ fontFamily: '"JetBrains Mono", ui-monospace, monospace' }}>coolscaler-cost-config</code>{' '}
            ConfigMap and applied live.
          </p>
          {costErr ? (
            <div style={{ fontSize: 12, color: '#94a3b8' }}>cost config unavailable</div>
          ) : cost == null ? (
            <div style={{ fontSize: 12, color: '#94a3b8' }}>loading…</div>
          ) : (
            <div style={{ fontSize: 12 }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 12 }}>
                {PRICE_FIELDS.map((f) => {
                  const key = `${f.tier}.${f.res}`;
                  return (
                    <div key={key}>
                      <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>{f.label}</div>
                      <input
                        type="number"
                        step="any"
                        min={0}
                        value={cost[key]}
                        onChange={(e) => setCost((prev) => ({ ...(prev || {}), [key]: e.target.value }))}
                        style={costInput}
                        className="num"
                      />
                    </div>
                  );
                })}
              </div>
              <label
                style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 12, color: '#475569' }}
              >
                <input
                  type="checkbox"
                  checked={costUnalloc}
                  onChange={(e) => setCostUnalloc(e.target.checked)}
                  style={{ borderRadius: 4, accentColor: '#6366f1' }}
                />
                Include unallocated cost
              </label>
            </div>
          )}
        </section>
      )}

      {/* ================= CLOUD INTEGRATION ================= */}
      {tab === 'cloud' && (
        <section style={{ ...card, textAlign: 'center', padding: '48px 20px' }}>
          <div style={{ fontSize: 28, marginBottom: 8 }}>☁️</div>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#1e2536' }}>
            No cloud billing integration configured for this cluster
          </div>
          <p style={{ ...subText, margin: '6px auto 0', maxWidth: 480 }}>
            CoolScaler prices resources from the manual pricing configured under the <b>Cost</b> tab — no cloud
            provider billing account is connected.
          </p>
        </section>
      )}

      {/* ================= SUPPORT ================= */}
      {tab === 'support' && (
        <section style={card}>
          <div style={{ ...cardTitle, marginBottom: 8 }}>Support</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12, color: '#475569' }}>
            <div>
              Running version:{' '}
              <span className="num" style={{ fontWeight: 700, color: '#1e2536' }}>
                {version ?? '—'}
              </span>
            </div>
            <div>
              Documentation lives in the CoolScaler repository under{' '}
              <code style={{ fontFamily: '"JetBrains Mono", ui-monospace, monospace' }}>docs/</code>; start with{' '}
              <code style={{ fontFamily: '"JetBrains Mono", ui-monospace, monospace' }}>README.md</code>.
            </div>
            <div style={{ color: '#94a3b8' }}>
              For live diagnostics use the Troubleshooting page or the Component health grid under General.
            </div>
          </div>
        </section>
      )}

      <footer style={{ textAlign: 'center', fontSize: 12, color: '#94a3b8', paddingTop: 8, paddingBottom: 24 }}>
        CoolScaler · Settings · live component health &amp; automation configuration
      </footer>
    </main>
  );
}
