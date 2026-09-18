// Workload overview drawer
import { useCallback, useEffect, useMemo, useState } from 'react';
import ClickAwayListener from '@mui/material/ClickAwayListener';
import { getJson, postJson } from '../../../api/client';
import { useFeedback } from '../../../providers/FeedbackProvider';
import { useClusterData } from '../../../providers/ClusterDataProvider';
import { normalizePeriod, type DrawerTarget } from '../lib';
import { usePolicyNames, MenuItem } from '../ui';
import RightsizingTab from './RightsizingTab';
import TroubleshootTab from './TroubleshootTab';
import { ApisTab, EventsTab, GpuTab, JavaTab, NetworkTab, PodsTab, ReplicasTab, SchedulingTab, SpotTab, YamlTab } from './OtherTabs';
import type { RecommendationDetail } from '../types';

function KvChipDark({ label, obj }: { label: string; obj?: Record<string, string> }) {
  const entries = Object.entries(obj || {});
  const tip = entries.length ? entries.map(([k, v]) => `${k}: ${v}`).join('\n') : 'No ' + label.toLowerCase();
  return (
    <span
      className="pill"
      title={tip}
      style={{ background: 'rgba(255,255,255,.1)', color: '#e2e8f0', border: '1px solid rgba(255,255,255,.2)', cursor: 'help' }}
    >
      {label}
      <span style={{ opacity: 0.7 }}>ⓘ</span>
    </span>
  );
}

export default function WorkloadDrawer({
  target,
  initialTab,
  initialPeriod,
  onClose,
}: {
  target: DrawerTarget;
  initialTab?: string | null;
  initialPeriod?: string | null;
  onClose: () => void;
}) {
  const { toast, confirm } = useFeedback();
  const { ro: clusterRo, refresh } = useClusterData();
  const policyNames = usePolicyNames();
  const [data, setData] = useState<RecommendationDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const [entered, setEntered] = useState(false);
  const [tab, setTab] = useState('Rightsizing');
  const [period, setPeriod] = useState(normalizePeriod(initialPeriod ?? null) || '1d');
  const [menuOpen, setMenuOpen] = useState(false);
  const [policy, setPolicy] = useState<string | null>(null);

  const key = `${target.namespace}/${target.kind}/${target.name}`;

  const load = useCallback(() => {
    const enc = encodeURIComponent;
    getJson<RecommendationDetail>(`/api/recommendation/${enc(target.namespace)}/${enc(target.kind)}/${enc(target.name)}`)
      .then((d) => {
        setData(d);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, [target]);

  useEffect(() => {
    setData(null);
    setPolicy(null);
    load();
  }, [load]);

  // slide-in animation + body scroll lock + Escape-to-close
  useEffect(() => {
    const t = requestAnimationFrame(() => setEntered(true));
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      cancelAnimationFrame(t);
      document.body.style.overflow = '';
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const hasReplicas = !!(data?.hpaManaged && data?.replicasOpt);
  const hasJava = !!data?.java;
  const hasScheduling = !!data?.schedulingOpt?.has;

  // honor policyTuningSelectedTab once data (and thus the tab set) is known
  useEffect(() => {
    if (!data || !initialTab) return;
    const all = ['Rightsizing', 'Troubleshoot', 'Pods', 'APIs', 'Network', 'Events', 'YAML', 'Spot', 'GPU']
      .concat(hasReplicas ? ['Replicas'] : [])
      .concat(hasJava ? ['Java'] : []);
    const want = initialTab === 'Timeline' ? 'Events' : initialTab === 'YAMLs' ? 'YAML' : initialTab;
    if (all.includes(want)) setTab(want);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const readOnly = data?.readOnly != null ? !!data.readOnly : clusterRo;
  const can = !readOnly && !!data?.sizable;
  const inplaceOk = can && !!data?.inPlace?.capable;

  const drawerPost = async (url: string, body: unknown, label: string) => {
    try {
      const j = await postJson<{ ok?: boolean; message?: string }>(url, body);
      toast(j.ok === false ? label + ' failed:\n' + (j.message || '') : label + ' ✓\n' + (j.message || ''));
    } catch {
      toast('Request failed.');
    }
    setTimeout(() => {
      load();
      refresh();
    }, 400);
  };

  const drawerApply = async () => {
    if (readOnly) {
      toast('Cluster is in READ-ONLY mode.\nSet readOnly: false in Helm values to apply recommendations.');
      return;
    }
    const hpaNote = data?.hpaManaged
      ? '\n\nIts HPA/KEDA utilization triggers will be converted to absolute targetAverageValue to preserve horizontal scaling.'
      : '';
    if (!(await confirm(`Apply recommendation to ${target.kind} ${target.namespace}/${target.name}?${hpaNote}`))) return;
    drawerPost('/api/apply', { namespace: target.namespace, kind: target.kind, name: target.name }, 'Apply');
  };
  const drawerResize = async () => {
    if (readOnly) {
      toast('Cluster is in READ-ONLY mode.');
      return;
    }
    if (
      !(await confirm(
        `Resize ${target.kind} ${target.namespace}/${target.name} IN PLACE? Running pods are patched via the pods/resize subresource — no restart.`,
      ))
    )
      return;
    drawerPost('/api/resize', { namespace: target.namespace, kind: target.kind, name: target.name }, 'In-place resize');
  };
  const drawerRollout = async () => {
    if (readOnly) {
      toast('Cluster is in READ-ONLY mode.');
      return;
    }
    if (!(await confirm(`Rollout-restart ${target.kind} ${target.namespace}/${target.name}?`))) return;
    drawerPost('/api/rollout', { namespace: target.namespace, kind: target.kind, name: target.name }, 'Rollout');
  };
  const drawerExclude = () =>
    drawerPost('/api/exclude', { key, excluded: !data?.excluded }, data?.excluded ? 'Re-include' : 'Exclude from automation');
  const drawerRestore = async () => {
    if (readOnly) {
      toast('Cluster is in READ-ONLY mode — cannot rewrite the workload annotation.');
      return;
    }
    if (!(await confirm(`Restore the auto-detected (suggested) policy for ${target.namespace}/${target.name}?`))) return;
    drawerPost('/api/restore-policy', { namespace: target.namespace, kind: target.kind, name: target.name }, 'Restore policy');
  };
  const drawerAttach = (p: string) => {
    if (readOnly) {
      toast('Cluster is in READ-ONLY mode — cannot write the policy annotation.');
      return;
    }
    drawerPost('/api/attach-policy', { namespace: target.namespace, kind: target.kind, name: target.name, policy: p }, 'Attach policy ' + p);
  };
  const drawerCopy = () => {
    if (!data?.crName) return;
    const cmd = `kubectl -n ${target.namespace} get recommendation ${data.crName} -o yaml`;
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(cmd).then(() => toast('Copied:\n' + cmd, 'ok'), () => toast(cmd));
    else toast(cmd);
  };
  const drawerAutomate = async () => {
    if (readOnly) return;
    const next = !data?.automated;
    try {
      await postJson('/api/automate', { key, enabled: next });
      toast(`${target.name} automation ${next ? 'enabled' : 'disabled'}.`, 'ok');
    } catch {
      toast('Failed to update automation.');
    }
    load();
    refresh();
  };
  const drawerSavePolicy = () => {
    const p = policy || data?.policyName;
    if (!p) {
      toast('No policy selected.');
      return;
    }
    drawerAttach(p);
  };

  // tab strip
  const beta = (
    <span className="pill" style={{ background: '#fff', color: '#6366f1', border: '1px solid #a5b4fc', marginLeft: 4 }}>Beta</span>
  );
  const fullTabs: [string, React.ReactNode][] = [
    ['Rightsizing', 'Rightsizing'],
    ...(hasReplicas ? ([['Replicas', 'Replicas']] as [string, React.ReactNode][]) : []),
    ['Troubleshoot', 'Troubleshoot'],
    ['Pods', 'Pods'],
    ['APIs', <span key="a">APIs {beta}</span>],
    ['Network', 'Network'],
    ...(hasJava ? ([['Java', 'Java']] as [string, React.ReactNode][]) : []),
    ...(hasScheduling ? ([['Scheduling', 'Scheduling']] as [string, React.ReactNode][]) : []),
    ['Events', 'Events'],
    ['YAML', 'YAMLs'],
  ];
  const stubTabs: [string, boolean, string][] = [
    ...(hasReplicas ? [] : ([['Replicas', false, 'Not HPA/KEDA-managed']] as [string, boolean, string][])),
    ...(hasJava ? [] : ([['Java', false, 'No Java runtime detected']] as [string, boolean, string][])),
    ['Spot', true, ''],
    ...(hasScheduling ? [] : ([['Scheduling', false, 'No self anti-affinity to relax (Deployments only)']] as [string, boolean, string][])),
    ['GPU', true, ''],
    ['vLLM', false, 'vLLM optimization is not implemented'],
  ];

  // no kind-duplicate / health / datasource chips here.
  const language = (data && data.found !== false && (data.language as string | undefined)) || '';
  const meta = data && data.found !== false && !!(language || data.detectedTag) && (
    <div style={{ padding: '8px 20px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, background: '#fff', borderBottom: '1px solid #e9eaf0', fontSize: 12 }}>
      <span style={{ color: '#475569', fontWeight: 600 }}>Detected workload:</span>
      {language && (
        <span className="pill" style={{ background: '#06b6d4', color: '#fff', fontWeight: 600 }}>{language}</span>
      )}
      {data.detectedTag && (
        <span className="pill" title="A policy rule auto-attached this policy" style={{ background: '#fff7ed', color: '#ea580c', border: '1px solid #fed7aa' }}>
          rule: {data.detectedTag}
        </span>
      )}
    </div>
  );

  const tabBtn = (t: string, label: React.ReactNode, first: boolean) => {
    const on = tab === t;
    return (
      <button
        key={t}
        onClick={() => setTab(t)}
        style={{
          padding: '10px 14px',
          fontSize: 13,
          fontWeight: 600,
          whiteSpace: 'nowrap',
          borderRadius: '8px 8px 0 0',
          border: '1px solid #e9eaf0',
          borderBottom: on ? '2px solid #6366f1' : '2px solid transparent',
          marginBottom: -1,
          marginLeft: first ? 0 : 2,
          background: '#fff',
          color: on ? '#4f46e5' : '#64748b',
          cursor: 'pointer',
          fontFamily: 'inherit',
        }}
      >
        {label}
      </button>
    );
  };

  const body = useMemo(() => {
    if (failed)
      return (
        <div style={{ padding: 24, textAlign: 'center', fontSize: 14, color: '#f43f5e' }}>
          Couldn't load the Recommendation for this workload. Check the connection and try again.
        </div>
      );
    if (!data)
      return (
        <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {[0, 1, 2].map((i) => (
            <div key={i} className="card" style={{ padding: 16 }}>
              <div style={{ height: 12, width: '33%', background: '#f1f5f9', borderRadius: 4, marginBottom: 12 }} />
              <div style={{ height: 12, width: '66%', background: '#f1f5f9', borderRadius: 4 }} />
            </div>
          ))}
        </div>
      );
    if (data.found === false)
      return (
        <div style={{ padding: 32, textAlign: 'center' }}>
          <div style={{ height: 48, width: 48, borderRadius: '50%', background: '#f1f5f9', display: 'grid', placeItems: 'center', margin: '0 auto 12px' }}>
            <svg style={{ width: 24, height: 24, color: '#94a3b8' }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
              <circle cx="12" cy="12" r="9" />
              <path d="M12 8v5M12 16h.01" />
            </svg>
          </div>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#1e2536' }}>No Recommendation CR yet</div>
          <div style={{ fontSize: 12, color: '#64748b', marginTop: 4, maxWidth: 280, margin: '4px auto 0' }}>
            This workload isn't being right-sized.
          </div>
        </div>
      );
    switch (tab) {
      case 'Rightsizing':
        return (
          <RightsizingTab
            data={data}
            target={target}
            policyNames={policyNames}
            period={period}
            setPeriod={setPeriod}
            ro={readOnly}
            policy={policy || data.policyName || '—'}
            setPolicy={setPolicy}
            onOpenPolicy={() => toast('Policy editor is on the Policies page (not ported in this wave).')}
            onAttachPolicy={drawerAttach}
          />
        );
      case 'Replicas':
        return data.replicasOpt ? <ReplicasTab r={data.replicasOpt} target={target} ro={readOnly} onReload={load} /> : null;
      case 'Scheduling':
        return data.schedulingOpt ? <SchedulingTab s={data.schedulingOpt} target={target} ro={readOnly} onReload={load} /> : null;
      case 'Troubleshoot':
        return <TroubleshootTab data={data} target={target} onCopyKubectl={drawerCopy} />;
      case 'Pods':
        return <PodsTab data={data} />;
      case 'APIs':
        return <ApisTab target={target} />;
      case 'Network':
        return <NetworkTab target={target} />;
      case 'Java':
        return <JavaTab data={data} />;
      case 'Events':
        return <EventsTab data={data} target={target} />;
      case 'YAML':
        return <YamlTab data={data} target={target} />;
      case 'Spot':
        return <SpotTab data={data} />;
      case 'GPU':
        return <GpuTab data={data} />;
      default:
        return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, failed, tab, period, policy, policyNames, readOnly, target]);

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1300 }}>
      <div
        onClick={onClose}
        style={{
          position: 'absolute',
          inset: 0,
          background: 'rgba(26,32,54,.3)',
          backdropFilter: 'blur(1px)',
          opacity: entered ? 1 : 0,
          transition: 'opacity .3s',
        }}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Workload detail"
        style={{
          position: 'absolute',
          right: 0,
          top: 0,
          height: '100%',
          width: '100%',
          maxWidth: 1280,
          background: '#f7f8fc',
          boxShadow: '0 25px 50px -12px rgba(0,0,0,.25)',
          transform: entered ? 'none' : 'translateX(100%)',
          transition: 'transform .3s ease-out',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* dark header */}
        <div style={{ flexShrink: 0, background: '#1e2230', color: '#fff', padding: '14px 20px', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}>
            <span style={{ fontSize: 13, color: '#cbd5e1', flexShrink: 0 }}>Workload overview</span>
            <svg style={{ width: 16, height: 16, color: '#64748b', flexShrink: 0 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
            <span title={data?.crName || ''} style={{ fontWeight: 700, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {target.kind}: {target.namespace}/{target.name}
            </span>
            {data && data.found !== false && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 8, flexShrink: 0 }}>
                <KvChipDark label="Annotations" obj={data.annotations} />
                <KvChipDark label="Labels" obj={data.labels} />
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{ height: 32, width: 32, flexShrink: 0, display: 'grid', placeItems: 'center', borderRadius: 8, color: '#cbd5e1', background: 'transparent', border: 'none', cursor: 'pointer' }}
          >
            <svg style={{ width: 16, height: 16 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        {/* body */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {meta}
          {data && data.found !== false && (
            <div style={{ padding: '0 20px', display: 'flex', alignItems: 'flex-end', gap: 4, borderBottom: '1px solid #e9eaf0', background: '#fff', position: 'sticky', top: 0, zIndex: 10, overflowX: 'auto' }}>
              {fullTabs.map(([t, l], i) => tabBtn(t, l, i === 0))}
              {stubTabs.map(([t, enabled, tip]) =>
                enabled ? (
                  <button
                    key={t}
                    onClick={() => setTab(t)}
                    style={{
                      padding: '6px 8px',
                      marginBottom: 4,
                      marginLeft: 2,
                      fontSize: 11,
                      fontWeight: 500,
                      color: tab === t ? '#4f46e5' : '#94a3b8',
                      border: '1px solid #e9eaf0',
                      borderRadius: 6,
                      whiteSpace: 'nowrap',
                      background: '#fff',
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                    }}
                  >
                    {t}
                  </button>
                ) : (
                  <button
                    key={t}
                    disabled
                    title={tip}
                    style={{
                      padding: '6px 8px',
                      marginBottom: 4,
                      marginLeft: 2,
                      fontSize: 11,
                      fontWeight: 500,
                      color: '#cbd5e1',
                      border: '1px solid #eef0f5',
                      borderRadius: 6,
                      whiteSpace: 'nowrap',
                      background: '#fff',
                      cursor: 'not-allowed',
                      fontFamily: 'inherit',
                    }}
                  >
                    {t}
                  </button>
                ),
              )}
            </div>
          )}
          {body}
        </div>

        {/* footer */}
        {data && data.found !== false && (
          <div style={{ flexShrink: 0, background: '#fff', borderTop: '1px solid #e9eaf0', padding: '12px 20px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ position: 'relative' }}>
              <button
                onClick={() => setMenuOpen((o) => !o)}
                style={{ fontSize: 14, fontWeight: 600, borderRadius: 8, padding: '8px 12px', border: '1px solid #e3e5ee', color: '#475569', background: '#fff', cursor: 'pointer', fontFamily: 'inherit' }}
              >
                ⋯ Actions
              </button>
              {menuOpen && (
                <ClickAwayListener onClickAway={() => setMenuOpen(false)}>
                  <div style={{ position: 'absolute', bottom: '100%', marginBottom: 4, left: 0, width: 208, background: '#fff', borderRadius: 8, boxShadow: '0 10px 15px -3px rgba(0,0,0,.1)', border: '1px solid #e9eaf0', padding: '4px 0', zIndex: 20, fontSize: 13 }}>
                    <MenuItem
                      label={'Apply recommendation' + (data.hpaManaged ? ' + HPA' : '')}
                      enabled={can}
                      title={readOnly ? 'Read-only mode' : data.sizable ? '' : 'No recommendation'}
                      onClick={() => {
                        setMenuOpen(false);
                        drawerApply();
                      }}
                    />
                    <MenuItem label="Resize in-place (no restart)" enabled={inplaceOk} title={inplaceOk ? '' : 'In-place not available'} onClick={() => { setMenuOpen(false); drawerResize(); }} />
                    <MenuItem label="Rollout restart" enabled={can} onClick={() => { setMenuOpen(false); drawerRollout(); }} />
                    <MenuItem
                      label={data.excluded ? 'Re-include in automation' : 'Exclude from automation'}
                      enabled
                      onClick={() => {
                        setMenuOpen(false);
                        drawerExclude();
                      }}
                    />
                    <MenuItem label="Restore suggested policy" enabled={!readOnly} onClick={() => { setMenuOpen(false); drawerRestore(); }} />
                    <MenuItem label="Copy kubectl" enabled={!!data.crName} onClick={() => { setMenuOpen(false); drawerCopy(); }} />
                  </div>
                </ClickAwayListener>
              )}
            </div>
            <div style={{ flex: 1 }} />
            <button
              disabled={!can}
              title={readOnly ? 'Read-only mode' : 'Save the selected policy to this workload'}
              onClick={drawerSavePolicy}
              style={{
                fontSize: 14,
                fontWeight: 600,
                borderRadius: 8,
                padding: '8px 16px',
                fontFamily: 'inherit',
                background: '#fff',
                border: can ? '1px solid #a5b4fc' : '1px solid #f1f5f9',
                color: can ? '#4f46e5' : '#cbd5e1',
                cursor: can ? 'pointer' : 'not-allowed',
              }}
            >
              Save rightsize policy
            </button>
            <button
              disabled={readOnly}
              title={readOnly ? 'Read-only mode' : 'Toggle continuous rightsizing automation for this workload'}
              onClick={drawerAutomate}
              style={{
                fontSize: 14,
                fontWeight: 600,
                borderRadius: 8,
                padding: '8px 16px',
                fontFamily: 'inherit',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 10,
                border: 'none',
                background: readOnly ? '#f1f5f9' : '#6366f1',
                color: readOnly ? '#cbd5e1' : '#fff',
                cursor: readOnly ? 'not-allowed' : 'pointer',
              }}
            >
              Automate rightsizing
              <span
                style={{
                  display: 'inline-flex',
                  height: 16,
                  width: 32,
                  borderRadius: 999,
                  transition: 'background .2s',
                  background: data.automated ? '#6ee7b7' : 'rgba(255,255,255,.3)',
                  position: 'relative',
                }}
              >
                <span
                  style={{
                    position: 'absolute',
                    top: 2,
                    ...(data.automated ? { right: 2 } : { left: 2 }),
                    height: 12,
                    width: 12,
                    borderRadius: '50%',
                    background: '#fff',
                    boxShadow: '0 1px 2px rgba(0,0,0,.2)',
                  }}
                />
              </span>
            </button>
          </div>
        )}
      </aside>
    </div>
  );
}
