// Create/Edit Headroom Configuration drawer — feedback goes through
// useFeedback() toast.
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import SlideOver from '../../components/SlideOver';
import { useFeedback } from '../../providers/FeedbackProvider';
import { blankHeadroomConfig, type HeadroomConfig, type HeadroomResource } from './types';

const inputStyle: CSSProperties = {
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
const labelStyle: CSSProperties = { display: 'block', fontSize: 12, color: '#64748b', marginBottom: 4 };
const linkBtn: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: '#4f46e5',
  border: 'none',
  background: 'none',
  cursor: 'pointer',
  fontFamily: 'inherit',
  padding: 0,
};

function Sec({ title, desc, children }: { title: string; desc?: string; children?: ReactNode }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: '#1e2536' }}>{title}</div>
      {desc ? (
        <div style={{ fontSize: 12, color: '#64748b', marginBottom: 12 }}>{desc}</div>
      ) : (
        <div style={{ marginBottom: 12 }} />
      )}
      {children}
    </div>
  );
}

const DAYS: [number, string][] = [
  [1, 'Mon'],
  [2, 'Tue'],
  [3, 'Wed'],
  [4, 'Thu'],
  [5, 'Fri'],
  [6, 'Sat'],
  [0, 'Sun'],
];

/** Resource row: Static|Dynamic select + a number input (unit hint on the right). */
function ResourceRow({
  label,
  unit,
  value,
  onChange,
}: {
  label: string;
  unit: string;
  value: HeadroomResource;
  onChange: (r: HeadroomResource) => void;
}) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '110px 130px 1fr', gap: 8, alignItems: 'center', marginBottom: 8 }}>
      <span style={{ fontSize: 13, color: '#475569', fontWeight: 500 }}>{label}</span>
      <select
        value={value.type}
        onChange={(e) => onChange({ ...value, type: e.target.value as HeadroomResource['type'] })}
        style={inputStyle}
      >
        <option value="static">Static</option>
        <option value="dynamic">Dynamic</option>
      </select>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input
          type="number"
          min={0}
          value={value.value}
          onChange={(e) => onChange({ ...value, value: Number(e.target.value) })}
          style={{ ...inputStyle, width: 140 }}
        />
        <span style={{ fontSize: 12, color: '#94a3b8', whiteSpace: 'nowrap' }}>
          {value.type === 'dynamic' ? '% of allocatable' : unit}
        </span>
      </div>
    </div>
  );
}

export type HeadroomDrawerMode = { kind: 'new' } | { kind: 'edit'; index: number };

export default function HeadroomDrawer({
  mode,
  configs,
  nodePoolOptions,
  onClose,
  onSave,
}: {
  mode: HeadroomDrawerMode | null;
  configs: HeadroomConfig[];
  nodePoolOptions: string[];
  onClose: () => void;
  /** Persists the full list; returns true on success so the drawer can close. */
  onSave: (next: HeadroomConfig[]) => Promise<boolean>;
}) {
  const { toast } = useFeedback();
  const [tab, setTab] = useState<'general' | 'schedule'>('general');
  const [c, setC] = useState<HeadroomConfig | null>(null);
  const [advOpen, setAdvOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const isNew = mode?.kind === 'new';

  useEffect(() => {
    if (!mode) {
      setC(null);
      return;
    }
    setTab('general');
    setAdvOpen(false);
    if (mode.kind === 'edit') {
      setC(JSON.parse(JSON.stringify(configs[mode.index])) as HeadroomConfig);
    } else {
      setC(blankHeadroomConfig());
    }
  }, [mode, configs]);

  if (!mode || !c) return null;

  const upd = (patch: Partial<HeadroomConfig>) => setC((prev) => (prev ? { ...prev, ...patch } : prev));

  const nodeSelRows = Object.entries(c.nodeSelector);

  const save = async () => {
    const name = c.name.trim();
    if (!name) {
      toast('Enter a configuration name', 'warn');
      return;
    }
    const dup = configs.some((x, i) => x.name === name && !(mode.kind === 'edit' && i === mode.index));
    if (dup) {
      toast('A configuration named "' + name + '" already exists', 'warn');
      return;
    }
    const normalized: HeadroomConfig = { ...c, name };
    const next = configs.slice();
    if (mode.kind === 'edit') next[mode.index] = normalized;
    else next.push(normalized);
    setSaving(true);
    const ok = await onSave(next);
    setSaving(false);
    if (ok) onClose();
  };

  const periods = c.schedule || [];

  return (
    <SlideOver open onClose={onClose} maxWidth={820} panelStyle={{ background: '#f7f8fc' }}>
      {/* dark header */}
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
        <div style={{ fontWeight: 700, fontSize: 14, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {isNew ? 'Create Headroom Configuration' : 'Edit Headroom Configuration: ' + (c.name || '')}
        </div>
        <button
          onClick={onClose}
          style={{ color: '#cbd5e1', background: 'none', border: 'none', fontSize: 20, lineHeight: 1, cursor: 'pointer' }}
        >
          ×
        </button>
      </div>

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {/* left nav tabs */}
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
              <Sec title="Configuration name" desc="Lowercase DNS-1123 name for the reserved-capacity configuration.">
                <input
                  value={c.name}
                  onChange={(e) => upd({ name: e.target.value })}
                  placeholder="e.g. spot-buffer"
                  style={inputStyle}
                  disabled={!isNew}
                />
              </Sec>

              <Sec
                title="Resource Configuration"
                desc="Reserve a fixed amount (Static) or a percentage of cluster allocatable (Dynamic) per resource."
              >
                <ResourceRow label="CPU" unit="cores" value={c.cpu} onChange={(cpu) => upd({ cpu })} />
                <ResourceRow label="Memory" unit="GiB" value={c.memory} onChange={(memory) => upd({ memory })} />
                <ResourceRow label="GPU" unit="units" value={c.gpu} onChange={(gpu) => upd({ gpu })} />
              </Sec>

              <Sec title="Lifecycle" desc="Restrict the reserved capacity to a node lifecycle.">
                <select
                  value={c.lifecycle}
                  onChange={(e) => upd({ lifecycle: e.target.value as HeadroomConfig['lifecycle'] })}
                  style={inputStyle}
                >
                  <option value="">Both</option>
                  <option value="onDemand">On-demand</option>
                  <option value="spot">Spot</option>
                </select>
              </Sec>

              <Sec title="Node Pools" desc="Limit the reservation to specific node pools.">
                {nodePoolOptions.length ? (
                  <select
                    multiple
                    value={c.nodePools}
                    onChange={(e) => upd({ nodePools: Array.from(e.target.selectedOptions).map((o) => o.value) })}
                    style={{ ...inputStyle, height: 96 }}
                  >
                    {nodePoolOptions.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                ) : (
                  <>
                    <select disabled style={{ ...inputStyle, background: '#f1f5f9', color: '#94a3b8' }}>
                      <option>No node pools available</option>
                    </select>
                    <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 6 }}>
                      Node-pool selection requires cloud integration — none detected on this cluster.
                    </div>
                  </>
                )}
              </Sec>

              {/* Advanced Settings */}
              <div style={{ marginBottom: 8 }}>
                <button onClick={() => setAdvOpen((o) => !o)} style={{ ...linkBtn, fontSize: 13 }}>
                  {advOpen ? '▾' : '▸'} Advanced Settings
                </button>
              </div>
              {advOpen && (
                <div style={{ borderRadius: 8, border: '1px solid #eef0f5', padding: 16, background: '#fff' }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#1e2536', marginBottom: 8 }}>Tolerations</div>
                  {c.tolerations.map((t, i) => {
                    const setTol = (patch: Partial<typeof t>) => {
                      const tolerations = c.tolerations.slice();
                      tolerations[i] = { ...t, ...patch };
                      upd({ tolerations });
                    };
                    return (
                      <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr auto', gap: 6, marginBottom: 6 }}>
                        <input placeholder="key" value={t.key} onChange={(e) => setTol({ key: e.target.value })} style={inputStyle} />
                        <select value={t.operator} onChange={(e) => setTol({ operator: e.target.value })} style={inputStyle}>
                          <option value="Equal">Equal</option>
                          <option value="Exists">Exists</option>
                        </select>
                        <input placeholder="value" value={t.value} onChange={(e) => setTol({ value: e.target.value })} style={inputStyle} />
                        <select value={t.effect} onChange={(e) => setTol({ effect: e.target.value })} style={inputStyle}>
                          <option value="">(any)</option>
                          <option value="NoSchedule">NoSchedule</option>
                          <option value="PreferNoSchedule">PreferNoSchedule</option>
                          <option value="NoExecute">NoExecute</option>
                        </select>
                        <button
                          onClick={() => upd({ tolerations: c.tolerations.filter((_, j) => j !== i) })}
                          style={{ ...linkBtn, color: '#94a3b8' }}
                          title="Remove toleration"
                        >
                          ✕
                        </button>
                      </div>
                    );
                  })}
                  <button
                    onClick={() => upd({ tolerations: [...c.tolerations, { key: '', operator: 'Equal', value: '', effect: '' }] })}
                    style={{ ...linkBtn, marginBottom: 16 }}
                  >
                    ＋ Add toleration
                  </button>

                  <div style={{ fontSize: 13, fontWeight: 700, color: '#1e2536', marginBottom: 8 }}>Node Selector</div>
                  {nodeSelRows.map(([k, v], i) => {
                    const setRow = (nk: string, nv: string) => {
                      const entries = nodeSelRows.slice();
                      entries[i] = [nk, nv];
                      upd({ nodeSelector: Object.fromEntries(entries.filter(([kk]) => kk !== '')) });
                    };
                    return (
                      <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 6, marginBottom: 6 }}>
                        <input placeholder="key" value={k} onChange={(e) => setRow(e.target.value, v)} style={inputStyle} />
                        <input placeholder="value" value={v} onChange={(e) => setRow(k, e.target.value)} style={inputStyle} />
                        <button
                          onClick={() => upd({ nodeSelector: Object.fromEntries(nodeSelRows.filter((_, j) => j !== i)) })}
                          style={{ ...linkBtn, color: '#94a3b8' }}
                          title="Remove selector"
                        >
                          ✕
                        </button>
                      </div>
                    );
                  })}
                  <button
                    onClick={() => upd({ nodeSelector: { ...c.nodeSelector, '': '' } })}
                    style={linkBtn}
                  >
                    ＋ Add node selector
                  </button>
                </div>
              )}
            </>
          ) : (
            /* Schedule tab */
            <>
              <Sec
                title="Schedule"
                desc="Reserve capacity only during the listed periods. With no periods the reservation is always active."
              >
                <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 12 }}>All times are UTC.</div>
                {periods.map((p, i) => {
                  const allDay = p.startTime === '00:00' && p.endTime === '23:59';
                  const setPeriod = (patch: Partial<typeof p>) => {
                    const next = periods.slice();
                    next[i] = { ...p, ...patch };
                    upd({ schedule: next });
                  };
                  const toggleDay = (d: number) => {
                    const has = p.days.includes(d);
                    setPeriod({ days: has ? p.days.filter((x) => x !== d) : [...p.days, d].sort((a, b) => a - b) });
                  };
                  return (
                    <div key={i} style={{ borderRadius: 8, border: '1px solid #eef0f5', padding: 12, marginBottom: 8, background: '#fff' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                        <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: '#94a3b8' }}>
                          Schedule period {i + 1}
                        </span>
                        <button
                          onClick={() => upd({ schedule: periods.filter((_, j) => j !== i) })}
                          style={{ ...linkBtn, color: '#94a3b8' }}
                          title="Remove period"
                        >
                          ✕
                        </button>
                      </div>
                      <label style={labelStyle}>Days</label>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
                        {DAYS.map(([d, lbl]) => {
                          const on = p.days.includes(d);
                          return (
                            <button
                              key={d}
                              onClick={() => toggleDay(d)}
                              style={{
                                fontSize: 12,
                                fontWeight: 600,
                                padding: '4px 10px',
                                borderRadius: 999,
                                cursor: 'pointer',
                                fontFamily: 'inherit',
                                border: '1px solid ' + (on ? '#6366f1' : '#e2e8f0'),
                                background: on ? '#eef2ff' : '#fff',
                                color: on ? '#4f46e5' : '#64748b',
                              }}
                            >
                              {lbl}
                            </button>
                          );
                        })}
                      </div>
                      <label style={labelStyle}>Time range</label>
                      <select
                        value={allDay ? 'all' : 'custom'}
                        onChange={(e) =>
                          setPeriod(
                            e.target.value === 'all'
                              ? { startTime: '00:00', endTime: '23:59' }
                              : { startTime: '09:00', endTime: '17:00' },
                          )
                        }
                        style={{ ...inputStyle, marginBottom: 8 }}
                      >
                        <option value="all">All day</option>
                        <option value="custom">Custom</option>
                      </select>
                      {!allDay && (
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                          <div>
                            <label style={labelStyle}>From (UTC)</label>
                            <input type="time" value={p.startTime} onChange={(e) => setPeriod({ startTime: e.target.value })} style={inputStyle} />
                          </div>
                          <div>
                            <label style={labelStyle}>To (UTC)</label>
                            <input type="time" value={p.endTime} onChange={(e) => setPeriod({ endTime: e.target.value })} style={inputStyle} />
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
                <button
                  onClick={() =>
                    upd({ schedule: [...periods, { startTime: '00:00', endTime: '23:59', days: [1, 2, 3, 4, 5] }] })
                  }
                  style={linkBtn}
                >
                  ＋ Add schedule period
                </button>
              </Sec>
            </>
          )}
        </div>
      </div>

      {/* footer */}
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
          disabled={saving}
          style={{
            fontSize: 13,
            padding: '6px 16px',
            borderRadius: 8,
            background: '#16a34a',
            color: '#fff',
            fontWeight: 600,
            border: 'none',
            cursor: saving ? 'default' : 'pointer',
            opacity: saving ? 0.6 : 1,
            fontFamily: 'inherit',
          }}
        >
          Save Changes
        </button>
      </div>
    </SlideOver>
  );
}
