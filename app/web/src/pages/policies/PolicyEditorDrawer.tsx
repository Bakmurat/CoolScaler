import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Formik, getIn, useFormikContext, type FormikProps } from 'formik';
import * as Yup from 'yup';
import { getJson, postJson } from '../../api/client';
import { useFeedback } from '../../providers/FeedbackProvider';
import { usePrompt } from '../../components/PromptModal';
import SlideOver, { DrawerHeader, HeaderBtn } from '../../components/SlideOver';
import { yamlDump } from '../rightsizing/lib';
import {
  DAYS_SCHED_OPTS,
  EPH_PERCENTILE_NUMS,
  EPH_WINDOW_OPTS,
  HEADROOM_NUMS,
  HISTORY_DATAPOINTS_OPTS,
  LIMIT_STRATEGY_OPTS,
  PERCENTILE_NUMS,
  POLICY_NAME_RE,
  TIMERANGE_OPTS,
  UPDATE_MODE_OPTS,
  WINDOW_OPTS,
  newPolicyTemplate,
  pctOpts,
  scheduleCRObject,
  suggestDupName,
  type PolicyDetail,
  type ScheduleRule,
} from './model';
import {
  DaysPicker,
  EditorReadOnlyCtx,
  G2,
  HRule,
  PNum,
  PSection,
  PSelect,
  PToggle,
  SubHead,
  selStyle,
  useEditorRO,
} from './fields';
import RulesEditor, { useAttrCatalogs, type RulesEditorHandle } from './RulesEditor';

type Tab = 'policy' | 'rules' | 'yaml';
type Sub = 'general' | 'eph' | 'limit' | 'automation' | 'scheduling' | 'java';

const validationSchema = Yup.object({
  name: Yup.string()
    .required('Enter a valid lowercase policy name')
    .matches(POLICY_NAME_RE, 'Enter a valid lowercase policy name'),
});

export default function PolicyEditorDrawer({
  open,
  name,
  create,
  createType,
  policyNames,
  onClose,
  onDuplicated,
}: {
  open: boolean;
  name: string | null;
  create?: boolean;
  createType?: string;
  policyNames: string[];
  onClose: () => void;
  onDuplicated: (newName: string) => void;
}) {
  const { toast } = useFeedback();
  const prompt = usePrompt();
  const [detail, setDetail] = useState<PolicyDetail | null>(null);
  const [tab, setTab] = useState<Tab>('policy');
  const [sub, setSub] = useState<Sub>('general');
  const rulesRef = useRef<RulesEditorHandle | null>(null);

  useEffect(() => {
    if (!open) {
      setDetail(null);
      return;
    }
    let dead = false;
    (async () => {
      try {
        const d = create
          ? newPolicyTemplate(name || '', createType || 'Optimize', policyNames)
          : await getJson<PolicyDetail & { error?: string }>(
              '/api/policy?name=' + encodeURIComponent(name || ''),
            );
        if (dead) return;
        if (!d || (d as { error?: string }).error) {
          toast('Could not load policy', 'error');
          onClose();
          return;
        }
        // defensive: fill per-kind strategy defaults the backend may omit
        const det = d as PolicyDetail;
        det.automation = det.automation || {};
        const ubm = ((det.automation as Record<string, unknown>).updateByTypeMode ||= {}) as Record<string, unknown>;
        const UBM_DEFAULTS: Record<string, string> = {
          deployment: 'Ongoing',
          statefulSet: 'OnCreate',
          daemonSet: 'OnCreate',
          rollout: 'Ongoing',
          custom: 'OnCreate',
        };
        for (const k of Object.keys(UBM_DEFAULTS)) if (ubm[k] == null) ubm[k] = UBM_DEFAULTS[k];
        setDetail(det);
        setTab('policy');
        setSub(d.type === 'Schedule' ? 'scheduling' : 'general');
      } catch {
        toast('Could not load policy', 'error');
        onClose();
      }
    })();
    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, name, create, createType]);

  const readOnly = !!detail?.builtin;

  const duplicate = useCallback(
    async (source: string) => {
      const nn = await prompt('Duplicate policy', 'New policy name', suggestDupName(source, policyNames));
      if (!nn) return;
      try {
        const r = await postJson<{ ok?: boolean; message?: string }>('/api/policy/duplicate', {
          source,
          name: nn,
        });
        if (r?.ok) {
          toast('Policy duplicated');
          onDuplicated(nn);
        } else toast(r?.message || 'Duplicate failed', 'error');
      } catch (e) {
        toast('Duplicate failed: ' + e, 'error');
      }
    },
    [prompt, policyNames, toast, onDuplicated],
  );

  const save = useCallback(
    async (values: PolicyDetail) => {
      if (readOnly) return duplicate(values.name);
      try {
        let r: { ok?: boolean; message?: string };
        if (values.type === 'Schedule') {
          r = await postJson('/api/schedule-policy/save', {
            name: values.name,
            schedule: values.schedule,
            description: values.description,
          });
        } else {
          r = await postJson('/api/policy/save', { ...values, isNew: !!values.isNew });
        }
        if (rulesRef.current?.dirty) await rulesRef.current.save();
        if (r?.ok) {
          toast('Policy saved');
          onClose();
        } else toast(r?.message || 'Save failed', 'error');
      } catch (e) {
        toast('Save failed: ' + e, 'error');
      }
    },
    [readOnly, duplicate, toast, onClose],
  );

  if (!open) return null;

  return (
    <SlideOver open={open} onClose={onClose} maxWidth={880}>
      {!detail ? (
        <div style={{ padding: 24, color: '#94a3b8', fontSize: 13 }}>Loading…</div>
      ) : (
        <Formik<PolicyDetail>
          initialValues={detail}
          enableReinitialize
          validationSchema={validationSchema}
          validateOnMount
          onSubmit={save}
        >
          {(fp) => (
            <EditorReadOnlyCtx.Provider value={readOnly}>
              <EditorShell
                fp={fp}
                tab={tab}
                setTab={setTab}
                sub={sub}
                setSub={setSub}
                readOnly={readOnly}
                policyNames={policyNames}
                onClose={onClose}
                onDuplicate={() => void duplicate(detail.name)}
                onSave={() => {
                  if (!fp.values.name || !POLICY_NAME_RE.test(fp.values.name)) {
                    toast('Enter a valid lowercase policy name', 'warn');
                    return;
                  }
                  void fp.submitForm();
                }}
                rulesRef={rulesRef}
              />
            </EditorReadOnlyCtx.Provider>
          )}
        </Formik>
      )}
    </SlideOver>
  );
}

// Trick to keep JSX above readable (Formik children must be a fn).
function EditorShell(props: {
  fp: FormikProps<PolicyDetail>;
  tab: Tab;
  setTab: (t: Tab) => void;
  sub: Sub;
  setSub: (s: Sub) => void;
  readOnly: boolean;
  policyNames: string[];
  onClose: () => void;
  onDuplicate: () => void;
  onSave: () => void;
  rulesRef: React.MutableRefObject<RulesEditorHandle | null>;
}) {
  const { fp, tab, setTab, sub, setSub, readOnly, policyNames, onClose, onDuplicate, onSave, rulesRef } =
    props;
  const p = fp.values;

  const tabBtn = (id: Tab, lbl: string) => (
    <button
      key={id}
      onClick={() => setTab(id)}
      style={{
        padding: '10px 16px',
        fontSize: 13,
        fontWeight: 600,
        fontFamily: 'inherit',
        cursor: 'pointer',
        background: 'transparent',
        border: 'none',
        borderBottom: tab === id ? '2px solid #6366f1' : '2px solid transparent',
        color: tab === id ? '#4f46e5' : '#64748b',
      }}
    >
      {lbl}
    </button>
  );

  const navItem = (id: Sub, lbl: string, child?: boolean) => (
    <button
      key={id}
      onClick={() => setSub(id)}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        padding: '6px 12px',
        paddingLeft: child ? 28 : 12,
        borderRadius: 8,
        fontSize: 13,
        border: 'none',
        cursor: 'pointer',
        fontFamily: 'inherit',
        background: sub === id ? '#eef2ff' : 'transparent',
        color: sub === id ? '#4f46e5' : '#475569',
        fontWeight: sub === id ? 600 : 400,
      }}
    >
      {lbl}
    </button>
  );

  return (
    <>
      <DrawerHeader
        left={
          <>
            {p.name || 'new policy'}
            {readOnly ? (
              <span className="pill" style={{ background: 'rgba(255,255,255,.2)', color: '#fff', marginLeft: 8 }}>
                🔒 Built in policy
              </span>
            ) : p.isNew ? (
              <span className="pill" style={{ background: 'rgba(255,255,255,.2)', color: '#fff', marginLeft: 8 }}>
                new {p.type === 'Schedule' ? 'schedule' : 'policy'}
              </span>
            ) : null}
          </>
        }
        right={
          <>
            <HeaderBtn outline onClick={onClose}>
              Cancel
            </HeaderBtn>
            {readOnly ? (
              <HeaderBtn onClick={onDuplicate}>Duplicate to edit</HeaderBtn>
            ) : (
              <HeaderBtn onClick={onSave}>Save</HeaderBtn>
            )}
          </>
        }
      />
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '0 12px',
          borderBottom: '1px solid #e9eaf0',
          background: '#eef0f4',
          flexShrink: 0,
        }}
      >
        {tabBtn('policy', 'Policy')}
        {readOnly ? (
          <button
            disabled
            title="Built-in policies cannot include rules"
            style={{
              padding: '10px 16px',
              fontSize: 13,
              fontWeight: 600,
              fontFamily: 'inherit',
              cursor: 'not-allowed',
              background: 'transparent',
              border: 'none',
              borderBottom: '2px solid transparent',
              color: '#c3c9d8',
            }}
          >
            Rules
          </button>
        ) : (
          tabBtn('rules', 'Rules')
        )}
        {tabBtn('yaml', 'YAML')}
      </div>

      {tab === 'yaml' ? (
        <YamlTab />
      ) : tab === 'rules' ? (
        <div style={{ flex: 1, overflow: 'auto', padding: 24, minHeight: 0 }}>
          <RulesEditor ref={rulesRef} policyNames={policyNames} scopePolicy={p.name} />
        </div>
      ) : (
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', minHeight: 0 }}>
          <div
            style={{
              width: 224,
              flexShrink: 0,
              borderRight: '1px solid #eef0f6',
              padding: 12,
              overflow: 'auto',
              background: '#fafbfd',
            }}
          >
            <div
              style={{
                fontSize: 11,
                textTransform: 'uppercase',
                letterSpacing: '.05em',
                color: '#94a3b8',
                fontWeight: 700,
                padding: '4px 12px',
              }}
            >
              Request
            </div>
            {navItem('general', 'General', true)}
            {navItem('eph', 'Ephemeral Storage', true)}
            <div style={{ paddingTop: 4 }}>
              {navItem('limit', 'Limit')}
              {navItem('automation', 'Automation')}
              {navItem('scheduling', 'Scheduling')}
              {p.java ? navItem('java', 'Java') : null}
            </div>
          </div>
          <div
            style={{
              flex: 1,
              overflow: 'auto',
              padding: 24,
              display: 'flex',
              flexDirection: 'column',
              gap: 16,
            }}
          >
            {sub === 'eph' ? (
              <EphSection />
            ) : sub === 'limit' ? (
              <LimitSection />
            ) : sub === 'automation' ? (
              <AutomationSection />
            ) : sub === 'scheduling' ? (
              <SchedulingSection policyNames={policyNames} />
            ) : sub === 'java' ? (
              <JavaSection />
            ) : (
              <GeneralSection />
            )}
          </div>
        </div>
      )}
    </>
  );
}

// ---- Policy ▸ Request ▸ General ----
function GeneralSection() {
  return (
    <>
      <PSection title="History Based Recommendations" />
      <SubHead title="History window" sub="Define the time window for the suggested optimization." />
      <G2>
        <PSelect label="CPU" name="request.window.cpu" opts={WINDOW_OPTS} />
        <PSelect label="Memory" name="request.window.memory" opts={WINDOW_OPTS} />
      </G2>
      <HRule />
      <SubHead title="Request headroom" sub="Define requests headroom for container resources." />
      <G2>
        <PSelect label="CPU %" name="request.headroom.cpu" opts={pctOpts(HEADROOM_NUMS)} kind="num" />
        <PSelect label="Memory (%)" name="request.headroom.memory" opts={pctOpts(HEADROOM_NUMS)} kind="num" />
      </G2>
      <HRule />
      <SubHead
        title="Histogram request percentile"
        sub="Define how close CoolScaler's recommendations should be to the measured usage."
      />
      <G2>
        <PSelect label="CPU Request (%)" name="request.percentile.cpu" opts={pctOpts(PERCENTILE_NUMS)} kind="num" />
        <PSelect
          label="Memory Request (%)"
          name="request.percentile.memory"
          opts={pctOpts(PERCENTILE_NUMS)}
          kind="num"
        />
      </G2>
      <HRule />
      <PSection title="Active Reactions" />
      <div>
        <PToggle
          label="Burst reaction"
          name="request.burstReaction"
          desc="CoolScaler analyzes historical data and acts immediately upon rapid bursts that require an update in resources when needed."
        />
        <PToggle
          label="Auto-healing reaction"
          name="request.autoHealing"
          desc="CoolScaler will automatically heal and recover pods suffering from CPU stress, out-of-memory issues, and pods with liveness probe errors due to lack of resources."
        />
        <PToggle
          label="Boot-time optimization"
          name="request.bootTime"
          desc="CoolScaler will automatically detect workload boot-time patterns and optimize resource allocation during startup to prevent performance degradation."
        />
      </div>
      <HRule />
      <SubHead
        title="Minimum resource requests boundaries"
        sub="Determine the minimum CPU and memory requests. Applied to each container, including sidecars."
      />
      <G2>
        <PNum label="Min CPU" name="request.minAllowed.cpu" ph="0.01" />
        <PNum label="Min memory (GiB)" name="request.minAllowed.memory" ph="0.02" />
      </G2>
      <HRule />
      <SubHead
        title="Maximum resource requests boundaries"
        sub="Determine the maximum CPU and memory requests. Applied to each container, including sidecars."
      />
      <G2>
        <PNum label="Max CPU" name="request.maxAllowed.cpu" ph="0" />
        <PNum label="Max memory (GiB)" name="request.maxAllowed.memory" ph="0" />
      </G2>
      <PToggle
        label="Set maximum resource requests according to max node size"
        name="request.setMaxAllowedAsNodeSize"
      />
      <HRule />
      <SubHead
        title="Keep original requests"
        sub="Disable CoolScaler from changing the original resource requests."
      />
      <div>
        <PToggle label="Keep original CPU request" name="request.keepRequest.cpu" />
        <PToggle label="Keep original memory request" name="request.keepRequest.memory" />
      </div>
      <HRule />
      <SubHead
        title="Integer CPU"
        sub="Enforce CPU recommendations to be integer values by rounding up after calculating based on workload demand and trends."
      />
      <PToggle label="Enable CPU Integer" name="request.integerCPU" />
      <HRule />
      <SubHead
        title="Memory replicas percentile"
        sub="Recommend memory requests based on a user-defined usage percentile aggregated from all replicas."
      />
      <G2>
        <PNum label="replicas (%)" name="request.memReplicasPercentile" kind="num" ph="—" />
        <div />
      </G2>
    </>
  );
}

// ---- Policy ▸ Request ▸ Ephemeral Storage ----
function EphSection() {
  const { values } = useFormikContext<PolicyDetail>();
  const on = !!getIn(values, 'request.eph.enabled');
  return (
    <>
      <PSection title="Ephemeral storage optimization" />
      <PToggle
        label="Enable ephemeral storage optimization"
        name="request.eph.enabled"
        desc="Enable optimization for ephemeral storage resources."
      />
      {on && (
        <>
          <HRule />
          <SubHead title="History window" />
          <G2>
            <PSelect label="Ephemeral storage" name="request.window.ephemeral-storage" opts={EPH_WINDOW_OPTS} />
            <div />
          </G2>
          <HRule />
          <SubHead title="Request headroom" />
          <G2>
            <PSelect
              label="Ephemeral storage (%)"
              name="request.headroom.ephemeral-storage"
              opts={pctOpts(HEADROOM_NUMS)}
              kind="num"
            />
            <div />
          </G2>
          <HRule />
          <SubHead title="Histogram request percentile" />
          <G2>
            <PSelect
              label="Ephemeral storage request (%)"
              name="request.percentile.ephemeral-storage"
              opts={pctOpts(EPH_PERCENTILE_NUMS)}
              kind="num"
            />
            <div />
          </G2>
          <HRule />
          <div>
            <PToggle
              label="Enable ephemeral storage auto-healing"
              name="request.eph.autoHealing"
              desc="Enable automatic healing for ephemeral storage out-of-capacity issues."
            />
            <PToggle
              label="Allow ephemeral storage reduction"
              name="request.eph.allowReduction"
              desc="When enabled, allows CoolScaler to reduce ephemeral storage requests below the original configured value."
            />
          </div>
          <HRule />
          <SubHead title="Boundaries" />
          <G2>
            <PNum label="Min ephemeral storage (GiB)" name="request.minAllowed.ephemeral-storage" ph="0" />
            <PNum label="Max ephemeral storage (GiB)" name="request.maxAllowed.ephemeral-storage" ph="0" />
          </G2>
        </>
      )}
    </>
  );
}

// ---- Policy ▸ Limit ----
function LimitSection() {
  const { values } = useFormikContext<PolicyDetail>();
  const row = (res: string, lbl: string) => {
    const s = (getIn(values, `limit.${res}.strategy`) as string) || 'keepLimit';
    return (
      <div key={res} style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: '#1e2536', marginBottom: 4 }}>{lbl}</div>
        <div style={{ maxWidth: 384 }}>
          <PSelect label="" name={`limit.${res}.strategy`} opts={LIMIT_STRATEGY_OPTS} />
        </div>
        {s === 'setLimit' && (
          <div style={{ marginTop: 8, maxWidth: 384 }}>
            <PNum label="Limit value" name={`limit.${res}.setLimit`} ph="e.g. 500m / 1Gi" />
          </div>
        )}
        {s === 'ratio' && (
          <div style={{ marginTop: 8, maxWidth: 384 }}>
            <PNum label="Limit : request ratio" name={`limit.${res}.limitToRequestRatio`} kind="num" ph="2" />
          </div>
        )}
        {(s === 'ratio' || s === 'keepLimitRequestRatio') && (
          <>
            <div
              style={{
                marginTop: 12,
                borderRadius: 8,
                border: '1px solid #eef0f5',
                background: 'rgba(248,250,252,.6)',
                padding: 12,
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '.05em',
                  color: '#94a3b8',
                  marginBottom: 8,
                }}
              >
                Dynamic limit caps{' '}
                <span style={{ color: '#cbd5e1', textTransform: 'none', fontWeight: 400 }}>
                  (optional bounds)
                </span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8 }}>
                <PNum label="Minimum limit" name={`limit.${res}.minLimit`} ph="e.g. 256Mi" />
                <PNum label="Maximum limit" name={`limit.${res}.maxLimit`} ph="e.g. 2Gi" />
                <PNum label="Max increase factor" name={`limit.${res}.maxIncreaseFactor`} kind="num" ph="3" />
              </div>
              <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 6 }}>
                When both a maximum limit and an increase factor are set, the smaller resulting value wins. The
                limit never drops below the original.
              </div>
            </div>
          </>
        )}
      </div>
    );
  };
  return (
    <>
      <PSection title="Limit strategy" sub="Define the strategy for defining limits." />
      <div style={{ paddingTop: 12 }}>
        {row('cpu', 'CPU')}
        {row('memory', 'Memory')}
        {row('ephemeral-storage', 'Ephemeral storage')}
      </div>
    </>
  );
}

// ---- Policy ▸ Automation ----
function AutomationSection() {
  const { values } = useFormikContext<PolicyDetail>();
  const ro = useEditorRO();
  const arpAllDay = !!getIn(values, 'automation.allowedRolloutPeriod.allDay');
  const strat = (lbl: string, k: string) => (
    <div
      key={k}
      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '6px 0' }}
    >
      <div style={{ fontSize: 13, color: '#475569' }}>{lbl}</div>
      <div style={{ width: 192 }}>
        <PSelect label="" name={`automation.updateByTypeMode.${k}`} opts={UPDATE_MODE_OPTS} />
      </div>
    </div>
  );
  void ro;
  return (
    <>
      <PSection title="Automation optimization strategy" sub="Define your optimization strategy per workload type." />
      <div style={{ paddingTop: 8 }}>
        {strat('Deployment:', 'deployment')}
        {strat('StatefulSet:', 'statefulSet')}
        {strat('DaemonSet:', 'daemonSet')}
        {strat('Argo Rollout:', 'rollout')}
        {strat('Custom Workload:', 'custom')}
      </div>
      <HRule />
      <SubHead
        title="In-place optimization strategy"
        sub="Optimize your workloads with no disruption to ensure high availability at all times."
      />
      <div>
        <PToggle label="Enable for ongoing automation strategy" name="automation.inPlace.ongoing" />
        <PToggle label="Enable for upon pod creation automation strategy" name="automation.inPlace.onCreate" />
      </div>
      <HRule />
      <SubHead
        title="Zero downtime rollout strategy"
        sub="Optimize workloads by first creating new optimized pods to ensure high availability with no-downtime, while respecting workload's availability."
      />
      <div>
        <PToggle label="Workloads with a single replica" name="automation.zeroDowntime.singleReplica" />
        <PToggle
          label="Deployments with multiple replicas and a rollout strategy that restrict pod scale down"
          name="automation.zeroDowntime.multiReplicaRestrictedScaleDown"
        />
      </div>
      <HRule />
      <SubHead
        title="Ensure high availability"
        sub="CoolScaler optimization will consider workload's availability & PDBs."
      />
      <div>
        <PToggle label="Ensure minimum of 1 replica" name="automation.ensureHA.ensureAtLeastOne" />
        <PToggle label="Respect unevictable pods by annotation" name="automation.ensureHA.respectUnevictable" />
      </div>
      <HRule />
      <SubHead
        title="Readiness period buffer"
        sub="Define a time buffer for pods to become ready, in addition to the existing workload readiness probe."
      />
      <G2>
        <PNum label="Buffer period" name="automation.readinessBufferSeconds" kind="num" suffix="sec" />
        <div />
      </G2>
      <HRule />
      <div>
        <PToggle
          label="Update HPA resource based triggers"
          name="automation.updateHPATriggers"
          desc="Align HPA scaling triggers with resource requests to ensure workloads scale effectively with optimized rightsizing."
        />
        <PToggle
          label="Actively enforce optimization according to context"
          name="automation.activeEnforcement"
          desc="Optimizations are applied with respect to node resource stress, noisy neighbors, and application requirements."
        />
        <PToggle
          label="Init containers optimization"
          name="automation.optimizeInitContainers"
          desc="Calculate and apply resource recommendations for init containers."
        />
        <PToggle
          label="Optimization upon automation"
          name="automation.optimizeUponAutomation"
          desc="Allow CoolScaler to rollout, during both automation and un-automation processes."
        />
      </div>
      <HRule />
      <SubHead title="Allowed rollout period" />
      <div style={{ fontSize: 12, color: '#64748b' }}>
        Define when CoolScaler is permitted to optimize workloads.{' '}
        <span className="pill" style={{ background: '#f1f5f9', color: '#64748b' }}>
          UTC
        </span>
      </div>
      <div style={{ marginTop: 8 }}>
        <DaysPicker name="automation.allowedRolloutPeriod.days" />
      </div>
      <G2>
        <PSelect label="Time range" name="automation.allowedRolloutPeriod.allDay" opts={TIMERANGE_OPTS} kind="bool" />
        {arpAllDay ? <div /> : <PNum label="From" name="automation.allowedRolloutPeriod.beginTime" ph="00:00" />}
      </G2>
      {!arpAllDay && (
        <G2>
          <PNum label="To" name="automation.allowedRolloutPeriod.endTime" ph="00:00" />
          <div />
        </G2>
      )}
      <HRule />
      <SubHead
        title="Required Window Coverage"
        sub="Define the percentage of data points in history window that is required for applying changes."
      />
      <G2>
        <PNum label="Window coverage (%)" name="automation.requiredWindowCoveragePercentage" kind="num" />
        <div />
      </G2>
    </>
  );
}

// ---- Policy ▸ Java ----
function JavaSection() {
  return (
    <>
      <PSection title="Recommendation" sub="Measure memory from the JVM." />
      <PToggle
        label="Use JVM-reported usage"
        name="java.realUsage"
        desc="Size memory from the JVM working set (live heap p90 + non-heap) collected by the injected JMX agent, instead of container RSS."
      />
      <HRule />
      <PSection title="Automation" sub="Tune the JVM from measured memory." />
      <div>
        <PToggle
          label="Enable memory optimization"
          name="java.memoryOptimization"
          desc="Adjust the memory request and the heap ceiling (-Xmx) from measured usage."
        />
        <PToggle
          label="Enable GC optimization"
          name="java.gcOptimization"
          desc="Select and adjust the optimal garbage-collector configuration."
        />
        <PToggle
          label="Enable JVM out-of-memory auto-healing"
          name="java.oomAutoHealing"
          desc="Detect JVM Out-of-Memory events and enhance recommendations (step up memory)."
        />
      </div>
    </>
  );
}

// Policy ▸ Scheduling ---- Bin-pack toggle for every policy; the schedule
// editor (Default policy + Override policies) ONLY for Schedule-type
// policies.
function SchedulingSection({ policyNames }: { policyNames: string[] }) {
  const { values } = useFormikContext<PolicyDetail>();
  const isSched = values.type === 'Schedule';
  return (
    <>
      <PToggle
        label="Bin-pack unevictable pods"
        name="automation.binPackUnevictable"
        desc="Automatically bin-pack unevictable pods to allow nodes to be more consolidated, further reducing costs."
      />
      {isSched && (
        <>
          <HRule />
          <ScheduleEditorSection policyNames={policyNames} />
        </>
      )}
    </>
  );
}

// ---- Schedule-type policy editor (Default policy + Override policies) ----
function ScheduleEditorSection({ policyNames }: { policyNames: string[] }) {
  const ro = useEditorRO();
  const { values, setFieldValue } = useFormikContext<PolicyDetail>();
  const sc = values.schedule || { defaultPolicy: policyNames[1] || 'production', rules: [] };
  const polOpts = policyNames.filter((n) => n !== 'default').map((n) => ({ label: n, value: n }));

  const setRules = (rules: ScheduleRule[]) => void setFieldValue('schedule.rules', rules);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <PSection
          title="Default policy"
          sub="This policy will be applied to all attached workloads during times that are not specified by the override policies."
        />
        <div style={{ marginTop: 12, maxWidth: 320 }}>
          <PSelect label="Policy name" name="schedule.defaultPolicy" opts={polOpts} />
        </div>
      </div>
      <HRule />
      <PSection
        title="Override policies"
        sub="Create and define override policies. Set your preferred policies schedule by days and time range."
      />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 4 }}>
        {(sc.rules || []).length === 0 && (
          <div style={{ fontSize: 12, color: '#94a3b8' }}>No override policies yet.</div>
        )}
        {(sc.rules || []).map((r, i) => (
          <div
            key={i}
            className="card"
            style={{ padding: 16, background: '#fafbfd', border: '1px solid #eef0f6' }}
          >
            {!ro && (
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: -4, marginRight: -4 }}>
                <button
                  title="Remove override"
                  onClick={() => setRules(sc.rules.filter((_, j) => j !== i))}
                  style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#cbd5e1', fontSize: 15 }}
                >
                  🗑
                </button>
              </div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <div>
                <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>Policy name</div>
                <select
                  disabled={ro}
                  value={r.policyName}
                  onChange={(e) => {
                    const rules = sc.rules.slice();
                    rules[i] = { ...r, policyName: e.target.value };
                    setRules(rules);
                  }}
                  style={selStyle}
                >
                  {polOpts.map((o) => (
                    <option key={String(o.value)}>{o.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>History window data points</div>
                <select
                  disabled={ro}
                  value={r.historyWindowDataPoints || 'current'}
                  onChange={(e) => {
                    const rules = sc.rules.slice();
                    rules[i] = { ...r, historyWindowDataPoints: e.target.value };
                    setRules(rules);
                  }}
                  style={selStyle}
                >
                  {HISTORY_DATAPOINTS_OPTS.map((o) => (
                    <option key={String(o.value)} value={String(o.value)}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <label
              style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#475569', marginTop: 12 }}
            >
              <input
                type="checkbox"
                checked={!!r.sleep}
                disabled={ro}
                onChange={(e) => {
                  const rules = sc.rules.slice();
                  rules[i] = { ...r, sleep: e.target.checked };
                  setRules(rules);
                }}
              />{' '}
              Sleep — scale down to zero replicas during the time window
            </label>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#1e2536' }}>Periods</div>
              <div style={{ fontSize: 11, color: '#94a3b8' }}>UTC time zone</div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
              {(r.periods || []).map((per, j) => {
                const daysVal =
                  per.days === 'all' || (Array.isArray(per.days) && per.days.length === 7)
                    ? 'all'
                    : Array.isArray(per.days) && per.days.length === 1
                      ? String(per.days[0])
                      : 'all';
                const setPeriod = (patch: Partial<typeof per>) => {
                  const rules = sc.rules.slice();
                  const periods = r.periods.slice();
                  periods[j] = { ...per, ...patch };
                  rules[i] = { ...r, periods };
                  setRules(rules);
                };
                return (
                  <div key={j} className="card" style={{ padding: 12, background: '#fff', border: '1px solid #eef0f6' }}>
                    {!ro && (
                      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: -4, marginRight: -4 }}>
                        <button
                          title="Remove period"
                          onClick={() => {
                            const rules = sc.rules.slice();
                            rules[i] = { ...r, periods: r.periods.filter((_, k) => k !== j) };
                            setRules(rules);
                          }}
                          style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#cbd5e1' }}
                        >
                          🗑
                        </button>
                      </div>
                    )}
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12 }}>
                      <div>
                        <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>Days</div>
                        <select
                          disabled={ro}
                          value={daysVal}
                          onChange={(e) =>
                            setPeriod({ days: e.target.value === 'all' ? 'all' : [Number(e.target.value)] })
                          }
                          style={selStyle}
                        >
                          {DAYS_SCHED_OPTS.map((o) => (
                            <option key={String(o.value)} value={String(o.value)}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>Time range</div>
                        <select
                          disabled={ro}
                          value={String(!!per.allDay)}
                          onChange={(e) => setPeriod({ allDay: e.target.value === 'true' })}
                          style={selStyle}
                        >
                          {TIMERANGE_OPTS.map((o) => (
                            <option key={String(o.value)} value={String(o.value)}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>From</div>
                        <input
                          disabled={ro || per.allDay}
                          value={per.allDay ? '00:00' : per.beginTime || '00:00'}
                          onChange={(e) => setPeriod({ beginTime: e.target.value })}
                          style={{ ...selStyle, cursor: 'text' }}
                        />
                      </div>
                      <div>
                        <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>To</div>
                        <input
                          disabled={ro || per.allDay}
                          value={per.allDay ? '23:59' : per.endTime || '23:59'}
                          onChange={(e) => setPeriod({ endTime: e.target.value })}
                          style={{ ...selStyle, cursor: 'text' }}
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            {!ro && (
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button
                  title="Add period"
                  onClick={() => {
                    const rules = sc.rules.slice();
                    rules[i] = {
                      ...r,
                      periods: [...r.periods, { days: 'all', allDay: true, beginTime: '00:00', endTime: '23:59' }],
                    };
                    setRules(rules);
                  }}
                  style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#6366f1', fontSize: 18 }}
                >
                  ⊕
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
      {!ro && (
        <button
          onClick={() =>
            setRules([
              ...(sc.rules || []),
              {
                policyName: policyNames[3] || 'cost',
                historyWindowDataPoints: 'current',
                sleep: false,
                periods: [{ days: 'all', allDay: true, beginTime: '00:00', endTime: '23:59' }],
              },
            ])
          }
          style={{
            alignSelf: 'flex-start',
            border: 'none',
            background: 'none',
            cursor: 'pointer',
            fontSize: 13,
            fontWeight: 600,
            color: '#4f46e5',
            fontFamily: 'inherit',
            padding: 0,
          }}
        >
          ＋ Add new override policy
        </button>
      )}
    </div>
  );
}

// YAML tab ---- Saved policies: the raw Policy CR from GET /api/policy-
// yaml?name=. Unsaved/new policies: the simulate-preview serializer.
function YamlTab() {
  const { values } = useFormikContext<PolicyDetail>();
  const [text, setText] = useState('');
  const [rawFailed, setRawFailed] = useState(false);
  const { toast } = useFeedback();
  const json = useMemo(() => JSON.stringify(values), [values]);
  const wantRaw = !values.isNew && !!values.name && !rawFailed;

  // raw CR for existing policies
  useEffect(() => {
    if (!wantRaw) return;
    let dead = false;
    (async () => {
      try {
        const r = await fetch('/api/policy-yaml?name=' + encodeURIComponent(values.name));
        if (!r.ok) throw new Error(String(r.status));
        const t = await r.text();
        let y = t;
        try {
          const j = JSON.parse(t) as { yaml?: string; error?: string };
          if (j.error) throw new Error(j.error);
          if (typeof j.yaml === 'string') y = j.yaml;
          else if (t.trim().startsWith('{')) throw new Error('no yaml field');
        } catch (e) {
          if (t.trim().startsWith('{')) throw e; // JSON without yaml → treat as failure
        }
        if (!y.trim()) throw new Error('empty');
        if (!dead) setText(y);
      } catch {
        if (!dead) setRawFailed(true); // backend endpoint pending → simulate preview
      }
    })();
    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantRaw, values.name]);

  // simulate-preview for new/unsaved policies (or when the raw endpoint is absent)
  useEffect(() => {
    if (wantRaw) return;
    const t = window.setTimeout(async () => {
      try {
        const v = JSON.parse(json) as PolicyDetail;
        if (v.type === 'Schedule') {
          setText(yamlDump(scheduleCRObject(v)));
          return;
        }
        const r = await postJson<{ spec?: Record<string, unknown> }>('/api/policy/simulate', v);
        const cr = {
          apiVersion: 'analysis.coolscaler.sh/v1alpha1',
          kind: 'Policy',
          metadata: { name: v.name || '<name>', namespace: 'coolscaler-system' },
          spec: r.spec || {},
        };
        setText(yamlDump(cr));
      } catch (e) {
        setText('# could not render YAML: ' + e);
      }
    }, 120);
    return () => window.clearTimeout(t);
  }, [json, wantRaw]);

  return (
    <div style={{ flex: 1, overflow: 'auto', background: '#1e2430', minHeight: 0 }}>
      <div style={{ padding: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <div style={{ fontSize: 12, color: '#cbd5e1', fontWeight: 600 }}>
            Policy's YAML — explore the full data
          </div>
          <button
            onClick={() => {
              void navigator.clipboard?.writeText(text);
              toast('YAML copied');
            }}
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: '#cbd5e1',
              border: '1px solid rgba(255,255,255,.2)',
              borderRadius: 4,
              padding: '4px 8px',
              background: 'transparent',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Copy
          </button>
        </div>
        <pre
          style={{
            fontSize: 11,
            lineHeight: 1.5,
            color: '#d7dbe6',
            whiteSpace: 'pre',
            overflow: 'auto',
            fontFamily: "'JetBrains Mono', ui-monospace, monospace",
            margin: 0,
          }}
        >
          {text}
        </pre>
      </div>
    </div>
  );
}

export { useAttrCatalogs };
