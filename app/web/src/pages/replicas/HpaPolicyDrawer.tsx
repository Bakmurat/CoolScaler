// HPA / Replicas policy editor drawer
import { useEffect, useState, type ReactNode } from 'react';
import { getJson, postJson } from '../../api/client';
import { useFeedback } from '../../providers/FeedbackProvider';
import { usePrompt } from '../../components/PromptModal';
import SlideOver from '../../components/SlideOver';
import { POLICY_NAME_RE } from '../policies/model';
import type { HpaPolicyDetail } from './types';

const COVERAGE_OPTS: [string, string][] = [
  ['12h', '12 hours'],
  ['24h', '1 day'],
  ['48h', '2 days'],
  ['96h', '4 days'],
  ['168h', '7 days'],
  ['336h', '14 days'],
];
const PCT_OPTS = [50, 60, 70, 75, 80, 85, 90, 95, 98, 100];
const WIN_OPTS: [string, string][] = [
  ['96h', '4 days'],
  ['168h', '7 days'],
  ['336h', '14 days'],
];
const LOOK_OPTS = ['15m', '20m', '30m', '1h'];
const STRAT_OPTS: [string, string][] = [
  ['historyAll', 'Set history based for all workloads'],
  ['historyPredictable', 'Set history based for predictable workloads'],
  ['historyStatic', 'Set history based for static workloads'],
  ['setAll', 'Set min replicas for all workloads'],
  ['keepAll', 'Keep min replicas for all workloads'],
];
export const SCHED_DAY_PRESETS: [string, string][] = [
  ['all', 'Every day'],
  ['weekdays', 'Monday–Friday'],
  ['weekends', 'Weekends'],
  ['1', 'Monday'],
  ['2', 'Tuesday'],
  ['3', 'Wednesday'],
  ['4', 'Thursday'],
  ['5', 'Friday'],
  ['6', 'Saturday'],
  ['0', 'Sunday'],
];
export function schedDaysToPreset(d?: number[]): string {
  const s = (d || []).slice().sort((a, b) => a - b).join(',');
  if (s === '0,1,2,3,4,5,6') return 'all';
  if (s === '1,2,3,4,5') return 'weekdays';
  if (s === '0,6') return 'weekends';
  if ((d || []).length === 1) return String(d![0]);
  return 'all';
}
export function schedPresetToDays(p: string): number[] {
  if (p === 'all') return [0, 1, 2, 3, 4, 5, 6];
  if (p === 'weekdays') return [1, 2, 3, 4, 5];
  if (p === 'weekends') return [0, 6];
  return [Number(p)];
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  border: '1px solid #e2e8f0',
  borderRadius: 8,
  padding: '8px 12px',
  fontSize: 13,
  background: '#fff',
  outline: 'none',
  fontFamily: 'inherit',
  boxSizing: 'border-box',
};
const labelStyle: React.CSSProperties = { display: 'block', fontSize: 12, color: '#64748b', marginBottom: 4 };

function Sec({ title, desc, children }: { title: string; desc?: string; children?: ReactNode }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: '#1e2536' }}>{title}</div>
      {desc ? <div style={{ fontSize: 12, color: '#64748b', marginBottom: 12 }}>{desc}</div> : <div style={{ marginBottom: 12 }} />}
      {children}
    </div>
  );
}

export type HpaDrawerMode =
  | { kind: 'edit'; name: string }
  | { kind: 'new' }
  | { kind: 'newSchedule'; policyNames: string[] };

export default function HpaPolicyDrawer({
  mode,
  onClose,
  onSaved,
  onReopen,
}: {
  mode: HpaDrawerMode | null;
  onClose: () => void;
  onSaved: () => void;
  onReopen: (name: string) => void;
}) {
  const { toast, confirm } = useFeedback();
  const prompt = usePrompt();
  const [p, setP] = useState<HpaPolicyDetail | null>(null);
  const [tab, setTab] = useState<'general' | 'predictable' | 'static' | 'threshold'>('general');

  useEffect(() => {
    if (!mode) {
      setP(null);
      return;
    }
    setTab('general');
    if (mode.kind === 'new') {
      setP({
        name: '',
        builtin: false,
        isNew: true,
        description: 'Custom HPA policy.',
        strategy: 'historyAll',
        minBoundary: 1,
        minHeadroom: 0,
        capByOrigin: true,
        setMin: 1,
        setMaxEnabled: false,
        setMax: 0,
        requiredHistory: '24h',
        prediction: true,
        lookAhead: '20m',
        predHistoryWindow: '14d',
        predMinEnabled: true,
        predWindow: '168h',
        predPct: 80,
        staticMinEnabled: true,
        staticWindow: '168h',
        staticPct: 80,
        threshold: { enabled: false, requiredHistory: 4, historyWindow: '168h', maxBoundary: 50 },
      });
      return;
    }
    if (mode.kind === 'newSchedule') {
      const names = mode.policyNames;
      setP({
        name: '',
        builtin: false,
        isNew: true,
        type: 'Schedule',
        description: 'Policy schedule.',
        defaultPolicy: names.includes('production') ? 'production' : names[0] || 'production',
        rules: [
          {
            policyName: names.includes('high-availability') ? 'high-availability' : names[0] || 'production',
            days: [0, 1, 2, 3, 4, 5, 6],
            beginTime: '10:00',
            endTime: '10:59',
          },
        ],
        policyNames: names,
      });
      return;
    }
    let dead = false;
    getJson<HpaPolicyDetail>('/api/hpa-policy?name=' + encodeURIComponent(mode.name))
      .then((d) => {
        if (dead) return;
        if (!d || d.error) {
          toast('Policy not found', 'error');
          onClose();
          return;
        }
        if (!d.threshold) d.threshold = { enabled: false, requiredHistory: 4, historyWindow: '168h', maxBoundary: 50 };
        setP(d);
      })
      .catch(() => {
        toast('Could not load policy', 'error');
        onClose();
      });
    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  if (!mode) return null;

  const ro = !!p?.builtin;
  const upd = (patch: Partial<HpaPolicyDetail>) => setP((prev) => (prev ? { ...prev, ...patch } : prev));

  const duplicate = async (src: string) => {
    const name = await prompt('Duplicate "' + src + '" as:', 'New policy name', src + '-copy');
    if (!name) return;
    const r = await postJson<{ ok?: boolean; message?: string }>('/api/hpa-policy/duplicate', { source: src, name }).catch(
      () => ({}) as { ok?: boolean; message?: string },
    );
    if (r?.ok) {
      toast('Duplicated to "' + name + '".');
      onSaved();
      onReopen(name);
    } else toast('Duplicate failed: ' + (r?.message || 'error'), 'error');
  };

  const save = async () => {
    if (!p) return;
    if (p.builtin) return duplicate(p.name);
    if (!p.name || !POLICY_NAME_RE.test(p.name)) {
      toast('Enter a valid lowercase policy name', 'warn');
      return;
    }
    if (p.type === 'Schedule') {
      const r = await postJson<{ ok?: boolean; message?: string }>('/api/hpa-policy/save', {
        name: p.name,
        isNew: !!p.isNew,
        type: 'Schedule',
        defaultPolicy: p.defaultPolicy,
        rules: p.rules,
        description: p.description,
      }).catch(() => ({}) as { ok?: boolean; message?: string });
      if (r?.ok) {
        toast('Policy schedule "' + p.name + '" saved.');
        onClose();
        onSaved();
      } else toast('Save failed: ' + (r?.message || 'error'), 'error');
      return;
    }
    const r = await postJson<{ ok?: boolean; message?: string }>('/api/hpa-policy/save', { ...p, isNew: !!p.isNew }).catch(
      () => ({}) as { ok?: boolean; message?: string },
    );
    if (r?.ok) {
      toast('Replicas policy "' + p.name + '" saved.');
      onClose();
      onSaved();
    } else toast('Save failed: ' + (r?.message || 'error'), 'error');
  };

  const del = async () => {
    if (!p || p.builtin) return;
    if (!(await confirm('Delete replicas policy "' + p.name + '"?\n\nWorkloads using it revert to the "production" policy.')))
      return;
    const r = await postJson<{ ok?: boolean; message?: string }>('/api/hpa-policy/delete', { name: p.name }).catch(
      () => ({}) as { ok?: boolean; message?: string },
    );
    if (r?.ok) {
      toast('Policy deleted.');
      onClose();
      onSaved();
    } else toast('Delete failed: ' + (r?.message || 'error'), 'error');
  };

  const sel = (value: unknown, onChange: (v: string) => void, opts: ([string, string] | string | number)[]) => (
    <select disabled={ro} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} style={inputStyle}>
      {opts.map((o) => {
        const v = Array.isArray(o) ? o[0] : String(o);
        const l = Array.isArray(o) ? o[1] : String(o);
        return (
          <option key={v} value={v}>
            {l}
          </option>
        );
      })}
    </select>
  );
  const num = (value: number | undefined, onChange: (v: number) => void, min = 0) => (
    <input
      disabled={ro}
      type="number"
      min={min}
      value={value ?? 0}
      onChange={(e) => onChange(Number(e.target.value))}
      style={inputStyle}
    />
  );
  const tog = (checked: boolean | undefined, onChange: (v: boolean) => void) => (
    <label className="tog" style={{ opacity: ro ? 0.5 : 1 }}>
      <input type="checkbox" checked={!!checked} disabled={ro} onChange={(e) => onChange(e.target.checked)} />
      <span className="sl" />
    </label>
  );

  const isSchedule = p?.type === 'Schedule';
  const tabs: [typeof tab, ReactNode][] = [
    ['general', 'General'],
    ['predictable', 'Predictable workloads'],
    ['static', 'Static workloads'],
    [
      'threshold',
      <>
        Threshold{' '}
        <span className="pill" style={{ background: '#ede9fe', color: '#7c3aed' }}>
          Beta
        </span>
      </>,
    ],
  ];

  return (
    <SlideOver open={!!mode} onClose={onClose} maxWidth={820} panelStyle={{ background: '#f7f8fc' }}>
      <div
        style={{
          background: '#1e2230',
          color: '#fff',
          padding: '12px 20px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span style={{ fontSize: 12, color: '#cbd5e1' }}>Replicas policy</span>
          <span style={{ color: '#64748b' }}>→</span>
          <span style={{ fontWeight: 700, fontSize: 14, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {mode.kind === 'newSchedule' ? 'Create policy schedule' : p?.name || (p?.isNew ? 'new policy' : '')}
          </span>
          {ro && (
            <span className="pill" style={{ background: '#475569', color: '#e2e8f0', marginLeft: 4 }}>
              built-in · read-only
            </span>
          )}
        </div>
        <button
          onClick={onClose}
          style={{ color: '#cbd5e1', background: 'none', border: 'none', fontSize: 20, lineHeight: 1, cursor: 'pointer' }}
        >
          ×
        </button>
      </div>

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {!isSchedule && (
          <div style={{ width: 192, flexShrink: 0, borderRight: '1px solid #e6e8f0', background: '#fff', padding: 12 }}>
            {tabs.map(([id, lbl]) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  padding: '8px 12px',
                  borderRadius: 8,
                  fontSize: 13,
                  fontWeight: 600,
                  border: 'none',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  marginBottom: 4,
                  background: tab === id ? '#eef2ff' : 'transparent',
                  color: tab === id ? '#4f46e5' : '#64748b',
                }}
              >
                {lbl}
              </button>
            ))}
          </div>
        )}
        <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
          {!p ? (
            <div style={{ fontSize: 13, color: '#94a3b8' }}>Loading…</div>
          ) : isSchedule ? (
            <>
              {p.isNew && (
                <Sec title="Policy schedule name" desc="Lowercase DNS-1123 name.">
                  <input
                    value={p.name || ''}
                    onChange={(e) => upd({ name: e.target.value })}
                    placeholder="e.g. production-with-rush-hours"
                    style={inputStyle}
                  />
                </Sec>
              )}
              <Sec title="Default policy" desc="Applied to attached workloads during times not covered by any override rule.">
                <select value={p.defaultPolicy} onChange={(e) => upd({ defaultPolicy: e.target.value })} style={inputStyle}>
                  {(p.policyNames || []).map((n) => (
                    <option key={n}>{n}</option>
                  ))}
                </select>
              </Sec>
              <Sec
                title="Override rules"
                desc="Evaluated top-to-bottom; the first day+time match wins. Times are UTC; ranges may span midnight."
              >
                {(p.rules || []).map((r, i) => {
                  const preset = schedDaysToPreset(r.days);
                  const setRule = (patch: Partial<typeof r>) => {
                    const rules = (p.rules || []).slice();
                    rules[i] = { ...r, ...patch };
                    upd({ rules });
                  };
                  return (
                    <div key={i} style={{ borderRadius: 8, border: '1px solid #eef0f5', padding: 12, marginBottom: 8, background: '#fff' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                        <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: '#94a3b8' }}>
                          Override rule {i + 1}
                        </span>
                        <button
                          onClick={() => upd({ rules: (p.rules || []).filter((_, j) => j !== i) })}
                          style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#94a3b8' }}
                          title="Remove rule"
                        >
                          🗑
                        </button>
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                        <div>
                          <label style={labelStyle}>Policy</label>
                          <select value={r.policyName} onChange={(e) => setRule({ policyName: e.target.value })} style={inputStyle}>
                            {(p.policyNames || []).map((n) => (
                              <option key={n}>{n}</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label style={labelStyle}>Days</label>
                          <select value={preset} onChange={(e) => setRule({ days: schedPresetToDays(e.target.value) })} style={inputStyle}>
                            {SCHED_DAY_PRESETS.map(([v, l]) => (
                              <option key={v} value={v}>
                                {l}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                        <div>
                          <label style={labelStyle}>From (UTC)</label>
                          <input type="time" value={r.beginTime} onChange={(e) => setRule({ beginTime: e.target.value })} style={inputStyle} />
                        </div>
                        <div>
                          <label style={labelStyle}>To (UTC)</label>
                          <input type="time" value={r.endTime} onChange={(e) => setRule({ endTime: e.target.value })} style={inputStyle} />
                        </div>
                      </div>
                    </div>
                  );
                })}
                <button
                  onClick={() =>
                    upd({
                      rules: [
                        ...(p.rules || []),
                        {
                          policyName: (p.policyNames || [])[0] || 'production',
                          days: [0, 1, 2, 3, 4, 5, 6],
                          beginTime: '10:00',
                          endTime: '10:59',
                        },
                      ],
                    })
                  }
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: '#4f46e5',
                    border: 'none',
                    background: 'none',
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    padding: 0,
                  }}
                >
                  ＋ Add override rule
                </button>
              </Sec>
            </>
          ) : tab === 'general' ? (
            <>
              {p.isNew && (
                <Sec title="Policy name" desc="Lowercase DNS-1123 name for the new policy.">
                  <input
                    value={p.name || ''}
                    onChange={(e) => upd({ name: e.target.value })}
                    placeholder="e.g. my-hpa-policy"
                    style={inputStyle}
                  />
                </Sec>
              )}
              <Sec title="Min replicas" desc="Override the minimum replicas recommendation for the attached workloads.">
                <label style={labelStyle}>Min replicas strategy</label>
                {sel(p.strategy, (v) => upd({ strategy: v }), STRAT_OPTS)}
                {p.strategy === 'setAll' && (
                  <>
                    <label style={{ ...labelStyle, marginTop: 12 }}>Set min replicas</label>
                    {num(p.setMin, (v) => upd({ setMin: v }), 1)}
                  </>
                )}
                <label style={{ ...labelStyle, marginTop: 12 }}>Min replicas boundary</label>
                {num(p.minBoundary, (v) => upd({ minBoundary: v }), 1)}
                <label style={{ ...labelStyle, marginTop: 12 }}>Min replicas headroom (%)</label>
                {sel(p.minHeadroom, (v) => upd({ minHeadroom: Number(v) }), [0, 10, 15, 20, 25, 50])}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 16 }}>
                  {tog(p.capByOrigin ?? true, (v) => upd({ capByOrigin: v }))}
                  <span style={{ fontSize: 13, color: '#475569' }}>Cap minimum replicas recommendation at the original value.</span>
                </div>
              </Sec>
              <Sec title="Max replicas" desc="Set the maximum replicas for this workload.">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  {tog(p.setMaxEnabled, (v) => upd({ setMaxEnabled: v }))}
                  <span style={{ fontSize: 13, color: '#475569' }}>Set max replicas value</span>
                </div>
                {p.setMaxEnabled && num(p.setMax, (v) => upd({ setMax: v }), 1)}
              </Sec>
              <Sec
                title="Required history for optimization"
                desc="Replicas optimization will be applied after gathering the minimum required historical data."
              >
                {sel(p.requiredHistory, (v) => upd({ requiredHistory: v }), COVERAGE_OPTS)}
              </Sec>
            </>
          ) : tab === 'predictable' ? (
            <>
              <Sec title="History window" desc="Set the history window to identify if the workload is predictable.">
                <div style={{ opacity: 0.6 }}>
                  {sel(p.predHistoryWindow, (v) => upd({ predHistoryWindow: v }), [
                    ['14d', '14d'],
                    ['7d', '7d'],
                    ['30d', '30d'],
                  ])}
                </div>
              </Sec>
              <Sec title="Prediction" desc="Increase replicas ahead of the predicted peak for predictable workloads.">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                  {tog(p.prediction, (v) => upd({ prediction: v }))}
                  <span style={{ fontSize: 13, color: '#475569' }}>Enable prediction</span>
                </div>
                <label style={labelStyle}>Look ahead duration</label>
                {sel(p.lookAhead, (v) => upd({ lookAhead: v }), LOOK_OPTS)}
              </Sec>
              <Sec
                title="Min replicas"
                desc="Define the history window and percentile for the suggested min replicas optimization (predictable workloads)."
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                  {tog(p.predMinEnabled, (v) => upd({ predMinEnabled: v }))}
                  <span style={{ fontSize: 13, color: '#475569' }}>Enable min replicas optimization</span>
                </div>
                {p.predMinEnabled && (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <div>
                      <label style={labelStyle}>History window</label>
                      {sel(p.predWindow, (v) => upd({ predWindow: v }), WIN_OPTS)}
                    </div>
                    <div>
                      <label style={labelStyle}>Percentile</label>
                      {sel(p.predPct, (v) => upd({ predPct: Number(v) }), PCT_OPTS.map((x) => [String(x), x + '%'] as [string, string]))}
                    </div>
                  </div>
                )}
              </Sec>
            </>
          ) : tab === 'static' ? (
            <Sec
              title="Min replicas"
              desc="Define the history window and percentile for the suggested min replicas optimization (static workloads). The maximum percentile follows the highest replica count the HPA reached in the window."
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                {tog(p.staticMinEnabled, (v) => upd({ staticMinEnabled: v }))}
                <span style={{ fontSize: 13, color: '#475569' }}>Enable min replicas optimization</span>
              </div>
              {p.staticMinEnabled && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div>
                    <label style={labelStyle}>History window</label>
                    {sel(p.staticWindow, (v) => upd({ staticWindow: v }), WIN_OPTS)}
                  </div>
                  <div>
                    <label style={labelStyle}>Percentile</label>
                    {sel(p.staticPct, (v) => upd({ staticPct: Number(v) }), PCT_OPTS.map((x) => [String(x), x + '%'] as [string, string]))}
                  </div>
                </div>
              )}
            </Sec>
          ) : (
            <>
              <Sec
                title="Latency-Aware Threshold Optimization"
                desc="Optimize HPA CPU utilization thresholds based on historical patterns to reduce over-scaling and improve efficiency."
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {tog(p.threshold?.enabled, (v) => upd({ threshold: { ...p.threshold!, enabled: v } }))}
                  <span style={{ fontSize: 13, color: '#475569' }}>Enable threshold optimization</span>
                </div>
              </Sec>
              {p.threshold?.enabled && (
                <>
                  <Sec title="History and window" desc="Set the required data coverage and observation window for threshold analysis.">
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                      <div>
                        <label style={labelStyle}>Required history (hours)</label>
                        {num(p.threshold.requiredHistory, (v) => upd({ threshold: { ...p.threshold!, requiredHistory: v } }), 1)}
                      </div>
                      <div>
                        <label style={labelStyle}>History window</label>
                        {sel(p.threshold.historyWindow, (v) => upd({ threshold: { ...p.threshold!, historyWindow: v } }), [
                          ['168h', '7 days'],
                          ['336h', '14 days'],
                        ])}
                      </div>
                    </div>
                  </Sec>
                  <Sec
                    title="Threshold boundaries"
                    desc="Define the maximum adjustment boundary for threshold optimization relative to the original value."
                  >
                    <label style={labelStyle}>Max boundary (%)</label>
                    {num(p.threshold.maxBoundary, (v) => upd({ threshold: { ...p.threshold!, maxBoundary: v } }), 0)}
                  </Sec>
                </>
              )}
            </>
          )}
        </div>
      </div>

      <div
        style={{
          borderTop: '1px solid #e6e8f0',
          background: '#fff',
          padding: '12px 20px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexShrink: 0,
        }}
      >
        {p && !p.builtin && !p.isNew ? (
          <button
            onClick={() => void del()}
            style={{ fontSize: 13, color: '#f43f5e', fontWeight: 600, border: 'none', background: 'none', cursor: 'pointer', fontFamily: 'inherit' }}
          >
            Delete policy
          </button>
        ) : (
          <span />
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            onClick={onClose}
            style={{
              fontSize: 13,
              padding: '6px 16px',
              borderRadius: 8,
              border: '1px solid #e2e8f0',
              color: '#475569',
              background: '#fff',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Cancel
          </button>
          <button
            onClick={() => void save()}
            style={{
              fontSize: 13,
              padding: '6px 16px',
              borderRadius: 8,
              background: '#6366f1',
              color: '#fff',
              fontWeight: 600,
              border: 'none',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {p?.builtin ? 'Duplicate to edit' : p?.type === 'Schedule' && p?.isNew ? 'Create schedule' : p?.isNew ? 'Create policy' : 'Save'}
          </button>
        </div>
      </div>
    </SlideOver>
  );
}
