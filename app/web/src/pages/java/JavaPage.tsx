// JAVA RESOURCE MANAGEMENT — anything the backend hasn't collected stays
// '—'/unset.
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { getJson, postJson } from '../../api/client';
import { useFeedback } from '../../providers/FeedbackProvider';
import { useClusterStore } from '../../store/clusterStore';
import { useGlobalSearchString, useUrlState } from '../../hooks/useUrlState';
import { workloadOverviewId } from '../rightsizing/lib';
import '../rightsizing/rightsizing.css';
import { ChartLegend, JV_CPU_SERIES, JV_MEM_SERIES, JvCpuChart, JvMemChart, useJavaGraph } from './JvCharts';
import JvKpiSection from './JvKpiSection';
import JvPolicies from './JvPolicies';
import JvWorkloadsSection, { Pill } from './JvWorkloadsSection';
import type { JavaActionResponse, JavaResponse, JavaWorkload } from './types';

const btnStyle = (variant: 'indigo' | 'indigo-outline' | 'rose-outline'): CSSProperties => ({
  fontSize: 12,
  fontWeight: 600,
  borderRadius: 8,
  padding: '6px 12px',
  cursor: 'pointer',
  fontFamily: 'inherit',
  ...(variant === 'indigo'
    ? { background: '#4f46e5', color: '#fff', border: '1px solid #4f46e5' }
    : variant === 'indigo-outline'
      ? { background: '#fff', color: '#4f46e5', border: '1px solid #c7d2fe' }
      : { background: '#fff', color: '#e11d48', border: '1px solid #fecdd3' }),
});

function JavaIcon({ size = 18, color = '#f97316' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8}>
      <path d="M8 18c0 1.5 2 2 4 2s4-.5 4-2M8 14c0 1.2 1.8 2 4 2s4-.8 4-2M12 3c2 2-1 3 0 5M9 6c1.5 1.5-.5 2.5 0 4" />
    </svg>
  );
}

// ---------- page ----------

export default function JavaPage() {
  const { toast, confirm } = useFeedback();
  const navigate = useNavigate();
  const gs = useGlobalSearchString();
  const overview = useClusterStore((s) => s.overview);
  // Workloads | Policies sub-view, persisted in the javaTab URL query param.
  const [javaTab, setJavaTab] = useUrlState('javaTab');
  const view: 'workloads' | 'policies' = javaTab === 'policies' ? 'policies' : 'workloads';

  const [data, setData] = useState<JavaResponse | null>(null);
  const [connError, setConnError] = useState(false);
  const [range, setRange] = useState<'7d' | '30d'>('7d');
  const [tick, setTick] = useState(0);
  const [hiddenMem, setHiddenMem] = useState<Set<string>>(new Set());
  const [hiddenCpu, setHiddenCpu] = useState<Set<string>>(new Set());
  const reloadTimer = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await getJson<JavaResponse>('/api/java');
      setData(d);
      setConnError(false);
    } catch {
      setConnError(true);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => {
      void load();
      setTick((n) => n + 1);
    }, 30000);
    return () => {
      window.clearInterval(t);
      if (reloadTimer.current) window.clearTimeout(reloadTimer.current);
    };
  }, [load]);

  const reloadSoon = useCallback(
    (ms: number) => {
      if (reloadTimer.current) window.clearTimeout(reloadTimer.current);
      reloadTimer.current = window.setTimeout(() => void load(), ms);
    },
    [load],
  );

  const series = useJavaGraph(range, tick);
  const chartsEmpty = !series.some((p) => p.values && (p.values.memUsage != null || p.values.jvmHeapUsed != null));

  const t = data?.totals || {};
  const obs = !!t.observabilityEnabled;
  const opt = !!t.optimizeEnabled;
  const helmLock = !!t.enabled; // forced on via Helm (can't disable from UI)
  const ro = !!t.readOnly;
  const realCount = t.realObservability || 0;

  // Cross-page wiring: workload name → rightsizing drawer deep link.
  const openWorkload = (w: JavaWorkload) => {
    const cluster = overview?.clusterName || data?.clusterName || 'example-cluster';
    const sp = new URLSearchParams(gs);
    sp.set('selectedWorkloadOverviewId', workloadOverviewId(cluster, { namespace: w.namespace, kind: w.kind, name: w.name }));
    navigate('/rightSizing/workloads?' + sp.toString());
  };


  const javaObsAction = async (enable: boolean, rollout: boolean) => {
    if (enable && rollout) {
      if (!(await confirm('Enable Java observability now and roll out ALL Java workloads so existing pods get the JMX agent injected?'))) return;
    }
    try {
      const r = await postJson<JavaActionResponse>('/api/java/config', { observability: enable, rollout: !!rollout });
      toast(
        r.ok === false
          ? 'Failed: ' + (r.message || '')
          : 'Java observability ' +
              (enable ? 'enabled' : 'disabled') +
              (r.rolledOut ? ' · rolled out ' + r.rolledOut + ' workload(s)' : '') +
              '.',
        r.ok === false ? undefined : 'ok',
      );
    } catch {
      toast('Request failed.');
    }
    reloadSoon(700);
  };

  const javaOptToggle = async (on: boolean) => {
    if (on) {
      if (
        !(await confirm(
          'Enable Java optimization automation? New/rolled Java pods get an optimized -Xmx injected (the JVM uses less heap). OOM auto-healing steps memory back up if needed.',
        ))
      )
        return;
    }
    try {
      await postJson('/api/java/config', { optimize: on });
      toast('Java optimization ' + (on ? 'enabled' : 'disabled') + '.', 'ok');
    } catch {
      toast('Request failed.');
    }
    reloadSoon(500);
  };

  const toggleHidden = (set: Set<string>, k: string) => {
    const n = new Set(set);
    if (n.has(k)) n.delete(k);
    else n.add(k);
    return n;
  };

  return (
    <main style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16, background: '#f3f4f9' }}>
      {/* Header */}
      <section style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ height: 32, width: 32, borderRadius: 8, background: '#fff7ed', display: 'grid', placeItems: 'center' }}>
            <JavaIcon />
          </div>
          <div>
            <h1 style={{ fontSize: 17, fontWeight: 700, color: '#1e2536', margin: 0 }}>Java Resource Management</h1>
            <p style={{ fontSize: 12, color: '#64748b', margin: 0 }}>
              JVM-aware memory rightsizing — recommendations are floored at the JVM ceiling (-Xmx + non-heap) to prevent OOM-kills.
            </p>
          </div>
        </div>
      </section>

      {/* Workloads | Policies folder tabs */}
      <div style={{ display: 'flex', gap: 2, borderBottom: '1px solid #e9eaf0' }}>
        <span className={'tabline' + (view === 'workloads' ? ' active' : '')} onClick={() => setJavaTab(null)}>
          Workloads
        </span>
        <span className={'tabline' + (view === 'policies' ? ' active' : '')} onClick={() => setJavaTab('policies')}>
          Policies
        </span>
      </div>

      {view === 'policies' ? (
        <JvPolicies />
      ) : (
      <>
      {/* Enable banner */}
      <section className="card" style={{ padding: 16, borderColor: '#e0e7ff', background: 'rgba(238,242,255,.4)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ flexShrink: 0, display: 'inline-flex' }}>
              <JavaIcon size={20} color="#6366f1" />
            </span>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 700, color: '#1e2536' }}>
                Java Optimization{' '}
                <Pill bg="#eef2ff" color="#4f46e5" border="#e0e7ff">
                  Beta
                </Pill>{' '}
                {obs ? (
                  <Pill bg="#f0fdf4" color="#16a34a" border="#dcfce7">
                    Java Observability Enabled
                  </Pill>
                ) : (
                  <Pill bg="#f1f5f9" color="#64748b">
                    Java Observability Disabled
                  </Pill>
                )}
              </div>
              <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>
                Injects a JMX agent into Java pods to collect <b>real JVM heap/GC</b> — {realCount} workload(s) reporting real usage.
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {obs ? (
              helmLock ? (
                <span style={{ fontSize: 11, color: '#94a3b8' }}>enabled via Helm (java.enabled=true)</span>
              ) : (
                <button style={btnStyle('rose-outline')} onClick={() => void javaObsAction(false, false)}>
                  Disable observability
                </button>
              )
            ) : (
              <>
                <button style={btnStyle('indigo-outline')} onClick={() => void javaObsAction(true, false)}>
                  Enable Upon Pod Creation
                </button>
                <button style={btnStyle('indigo')} onClick={() => void javaObsAction(true, true)}>
                  Enable Now
                </button>
              </>
            )}
          </div>
        </div>
        <div
          style={{
            marginTop: 12,
            paddingTop: 12,
            borderTop: '1px solid rgba(224,231,255,.7)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          <div style={{ fontSize: 12, color: '#475569' }}>
            <b style={{ color: '#1e2536' }}>Java optimization automation</b> — deliver an optimized <code>-Xmx</code> (from real heap) into
            Java pods on rollout, so the JVM uses less memory and rightsizing reclaims it.
          </div>
          <button
            onClick={() => void javaOptToggle(!opt)}
            style={{
              flexShrink: 0,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 12,
              fontWeight: 600,
              color: '#475569',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            <span
              style={{
                position: 'relative',
                display: 'inline-block',
                width: 36,
                height: 20,
                borderRadius: 999,
                transition: '.18s',
                background: opt ? '#22c55e' : '#cbd5e1',
              }}
            >
              <span
                style={{
                  position: 'absolute',
                  top: 2,
                  left: opt ? 18 : 2,
                  width: 16,
                  height: 16,
                  background: '#fff',
                  borderRadius: '50%',
                  transition: 'all .18s',
                }}
              />
            </span>
            {opt ? 'Automated' : 'Off'}
          </button>
        </div>
      </section>

      {/* KPI strip (rightsizing KPI pattern, java-scoped) */}
      <JvKpiSection data={data} ro={ro} onReload={reloadSoon} />

      {/* Java fleet resources over time */}
      <section className="card" style={{ padding: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#1e2536' }}>Java fleet resources over time</div>
            <div style={{ fontSize: 12, color: '#64748b' }}>
              Container request vs usage for Java pods, with <b>real JVM heap</b> (used / committed) and non-heap overlaid. Waste = request −
              optimized.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 2, background: '#f1f2f7', borderRadius: 8, padding: 2 }}>
            <span className={'seg' + (range === '7d' ? ' active' : '')} onClick={() => setRange('7d')}>
              7 Days
            </span>
            <span className={'seg' + (range === '30d' ? ' active' : '')} onClick={() => setRange('30d')}>
              30 Days
            </span>
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#64748b', marginBottom: 4 }}>Memory over time</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', columnGap: 12, rowGap: 4, fontSize: 11, color: '#64748b', marginBottom: 4 }}>
              <ChartLegend items={JV_MEM_SERIES} hidden={hiddenMem} onToggle={(k) => setHiddenMem((s) => toggleHidden(s, k))} />
            </div>
            <JvMemChart series={series} hidden={hiddenMem} />
          </div>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#64748b', marginBottom: 4 }}>CPU over time</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', columnGap: 12, rowGap: 4, fontSize: 11, color: '#64748b', marginBottom: 4 }}>
              <ChartLegend items={JV_CPU_SERIES} hidden={hiddenCpu} onToggle={(k) => setHiddenCpu((s) => toggleHidden(s, k))} />
            </div>
            <JvCpuChart series={series} hidden={hiddenCpu} />
          </div>
        </div>
        {chartsEmpty && (
          <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 8 }}>
            No Java pods are reporting JVM metrics yet — charts fill in once the JMX agent is scraped. The Optimized-memory + Waste series
            fill in once the backend ships the optimized series.
          </div>
        )}
      </section>

      {/* Workloads | Aggregation table */}
      <JvWorkloadsSection
        rows={data?.workloads || []}
        obsEnabled={obs}
        connError={connError}
        ro={ro}
        onReload={reloadSoon}
        onOpenWorkload={openWorkload}
      />
      </>
      )}

      <footer style={{ textAlign: 'center', fontSize: 12, color: '#94a3b8', paddingTop: 8, paddingBottom: 24 }}>
        CoolScaler · Java Resource Management · detects JVM workloads + parses -Xmx from env/args (no JMX)
      </footer>
    </main>
  );
}
