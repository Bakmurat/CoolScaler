// Downscale schedule policy editor drawer (General / Schedule)
import { useEffect, useState } from 'react';
import { postJson } from '../../api/client';
import { useFeedback } from '../../providers/FeedbackProvider';
import SlideOver from '../../components/SlideOver';
import { POLICY_NAME_RE } from '../policies/model';
import type { DsSchedule } from './types';

const DAY_PRESETS: [string, string][] = [
  ['all', 'Every day'],
  ['weekdays', 'Weekdays (Mon–Fri)'],
  ['weekends', 'Weekends (Sat–Sun)'],
  ['1', 'Monday'],
  ['2', 'Tuesday'],
  ['3', 'Wednesday'],
  ['4', 'Thursday'],
  ['5', 'Friday'],
  ['6', 'Saturday'],
  ['0', 'Sunday'],
];
function daysArr(preset: string): number[] {
  if (preset === 'all') return [0, 1, 2, 3, 4, 5, 6];
  if (preset === 'weekdays') return [1, 2, 3, 4, 5];
  if (preset === 'weekends') return [0, 6];
  return [Number(preset)];
}

interface DspState {
  name: string;
  isNew: boolean;
  minReplicas: number;
  replicas: number;
  sleep: boolean;
  hpaEnabled: boolean;
  nonHpaEnabled: boolean;
  schedule: { days: string; beginTime: string; endTime: string }[];
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

export type DsDrawerMode = { kind: 'new' } | { kind: 'edit'; schedule: DsSchedule } | null;

export default function DsScheduleDrawer({
  mode,
  onClose,
  onSaved,
}: {
  mode: DsDrawerMode;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useFeedback();
  const [tab, setTab] = useState<'general' | 'schedule'>('general');
  const [st, setSt] = useState<DspState | null>(null);

  useEffect(() => {
    if (!mode) {
      setSt(null);
      return;
    }
    setTab('general');
    if (mode.kind === 'new') {
      setSt({
        name: '',
        isNew: true,
        minReplicas: 1,
        replicas: 1,
        sleep: false,
        hpaEnabled: true,
        nonHpaEnabled: true,
        schedule: [{ days: 'all', beginTime: '21:00', endTime: '05:00' }],
      });
    } else {
      const s = mode.schedule;
      setSt({
        name: s.name,
        isNew: false,
        minReplicas: s.hpaMinReplicas || 1,
        replicas: s.targetReplicas || 1,
        sleep: !!s.sleep,
        hpaEnabled: s.hpaEnabled !== false,
        nonHpaEnabled: true,
        schedule:
          s.periods && s.periods.length
            ? s.periods.map((p) => ({ days: String(p.days), beginTime: p.beginTime, endTime: p.endTime }))
            : [{ days: 'all', beginTime: '21:00', endTime: '05:00' }],
      });
    }
  }, [mode]);

  if (!mode || !st) return null;

  const upd = (patch: Partial<DspState>) => setSt((prev) => (prev ? { ...prev, ...patch } : prev));

  const save = async () => {
    if (!st.name || !POLICY_NAME_RE.test(st.name)) {
      toast('Enter a valid lowercase schedule name', 'warn');
      return;
    }
    const schedule = st.schedule.map((p) => ({ days: daysArr(p.days), beginTime: p.beginTime, endTime: p.endTime }));
    const r = await postJson<{ ok?: boolean; message?: string }>('/api/downscale-policy/save', {
      name: st.name,
      isNew: st.isNew,
      minReplicas: st.minReplicas,
      replicas: st.replicas,
      sleep: st.sleep,
      hpaEnabled: st.hpaEnabled,
      nonHpaEnabled: st.nonHpaEnabled,
      schedule,
    }).catch(() => ({}) as { ok?: boolean; message?: string });
    if (r?.ok) {
      toast('Schedule policy "' + st.name + '" saved.');
      onClose();
      onSaved();
    } else toast('Save failed: ' + (r?.message || 'error'), 'error');
  };

  const tog = (checked: boolean, onChange: (v: boolean) => void) => (
    <label className="tog">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="sl" />
    </label>
  );

  return (
    <SlideOver open={!!mode} onClose={onClose} maxWidth={720} panelStyle={{ background: '#f7f8fc' }}>
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
          <span style={{ fontSize: 12, color: '#cbd5e1' }}>Schedule policy</span>
          <span style={{ color: '#64748b' }}>→</span>
          <span style={{ fontWeight: 700, fontSize: 14 }}>
            {st.isNew ? 'Create schedule policy' : 'Edit schedule policy: ' + st.name}
          </span>
        </div>
        <button
          onClick={onClose}
          style={{ color: '#cbd5e1', background: 'none', border: 'none', fontSize: 20, lineHeight: 1, cursor: 'pointer' }}
        >
          ×
        </button>
      </div>
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <div style={{ width: 176, flexShrink: 0, borderRight: '1px solid #e6e8f0', background: '#fff', padding: 12 }}>
          {(['general', 'schedule'] as const).map((id) => (
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
              {id === 'general' ? 'General' : 'Schedule'}
            </button>
          ))}
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
          {tab === 'general' ? (
            <>
              {st.isNew && (
                <div style={{ marginBottom: 24 }}>
                  <label style={labelStyle}>Schedule Name</label>
                  <input
                    value={st.name}
                    onChange={(e) => upd({ name: e.target.value })}
                    placeholder="e.g. weekend-scale-down"
                    style={inputStyle}
                  />
                </div>
              )}
              <div style={{ marginBottom: 24 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: '#1e2536' }}>Scale down HPA workloads</div>
                <div style={{ fontSize: 12, color: '#64748b', marginBottom: 12 }}>
                  Set the target minimum replicas for HPA workloads.
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  {tog(st.hpaEnabled, (v) => upd({ hpaEnabled: v }))}
                  <span style={{ fontSize: 13, color: '#475569' }}>Apply on HPA workloads</span>
                </div>
                {st.hpaEnabled && (
                  <>
                    <label style={labelStyle}>Target minimum replicas</label>
                    <input
                      type="number"
                      min={1}
                      value={st.minReplicas}
                      onChange={(e) => upd({ minReplicas: Number(e.target.value) })}
                      style={inputStyle}
                    />
                  </>
                )}
              </div>
              <div style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: '#1e2536' }}>Scale down non-HPA workloads</div>
                <div style={{ fontSize: 12, color: '#64748b', marginBottom: 12 }}>
                  Set the target number of replicas for non-HPA workloads.
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  {tog(st.nonHpaEnabled, (v) => upd({ nonHpaEnabled: v }))}
                  <span style={{ fontSize: 13, color: '#475569' }}>Apply on non-HPA workloads</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                  {tog(st.sleep, (v) => upd({ sleep: v }))}
                  <span style={{ fontSize: 13, color: '#475569' }}>Sleep (scale to 0)</span>
                </div>
                {st.nonHpaEnabled && !st.sleep && (
                  <>
                    <label style={labelStyle}>Target replicas</label>
                    <input
                      type="number"
                      min={0}
                      value={st.replicas}
                      onChange={(e) => upd({ replicas: Number(e.target.value) })}
                      style={inputStyle}
                    />
                  </>
                )}
              </div>
            </>
          ) : (
            <>
              <div style={{ fontSize: 14, fontWeight: 700, color: '#1e2536', marginBottom: 4 }}>Schedule</div>
              <div style={{ fontSize: 12, color: '#64748b', marginBottom: 12 }}>
                Time windows (UTC) when scale-down is active. A window may span midnight (e.g. 21:00 → 05:00).
              </div>
              {st.schedule.map((p, i) => (
                <div key={i} style={{ borderRadius: 8, border: '1px solid #eef0f5', padding: 12, marginBottom: 8, background: '#fff' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, alignItems: 'end' }}>
                    <div>
                      <label style={labelStyle}>Days</label>
                      <select
                        value={p.days}
                        onChange={(e) => {
                          const schedule = st.schedule.slice();
                          schedule[i] = { ...p, days: e.target.value };
                          upd({ schedule });
                        }}
                        style={inputStyle}
                      >
                        {DAY_PRESETS.map(([v, l]) => (
                          <option key={v} value={v}>
                            {l}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label style={labelStyle}>From (UTC)</label>
                      <input
                        type="time"
                        value={p.beginTime}
                        onChange={(e) => {
                          const schedule = st.schedule.slice();
                          schedule[i] = { ...p, beginTime: e.target.value };
                          upd({ schedule });
                        }}
                        style={inputStyle}
                      />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4 }}>
                      <div style={{ flex: 1 }}>
                        <label style={labelStyle}>To (UTC)</label>
                        <input
                          type="time"
                          value={p.endTime}
                          onChange={(e) => {
                            const schedule = st.schedule.slice();
                            schedule[i] = { ...p, endTime: e.target.value };
                            upd({ schedule });
                          }}
                          style={inputStyle}
                        />
                      </div>
                      {st.schedule.length > 1 && (
                        <button
                          onClick={() => upd({ schedule: st.schedule.filter((_, j) => j !== i) })}
                          style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#94a3b8', paddingBottom: 8 }}
                        >
                          🗑
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
              <button
                onClick={() => upd({ schedule: [...st.schedule, { days: 'all', beginTime: '21:00', endTime: '05:00' }] })}
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
                ＋ Add schedule period
              </button>
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
          justifyContent: 'flex-end',
          gap: 8,
          flexShrink: 0,
        }}
      >
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
            background: '#22c55e',
            color: '#fff',
            fontWeight: 600,
            border: 'none',
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          {st.isNew ? 'Create' : 'Save Changes'}
        </button>
      </div>
    </SlideOver>
  );
}
