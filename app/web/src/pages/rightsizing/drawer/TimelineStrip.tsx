// Two-row event Timeline strip ("CoolScaler Event" / "General Event") with the
// fixed legend-chip catalog — renderDrawerTimeline() port.
import type { WlEvent } from '../types';

const TL_LEGEND: [string, string, string][] = [
  ['Automated', '#10b981', ''],
  ['Burst reaction', '#a78bfa', 'ⓘ'],
  ['Auto-healing reaction', '#6ee7b7', ''],
  ['Boot-time optimization', '#0d9488', ''],
  ['In-place optimization', '#84cc16', ''],
  ['Optimization eviction', '#3b82f6', 'ⓘ'],
  ['CPU throttling', '#a16207', 'ⓘ'],
  ['CPU stressed nodes', '#6366f1', 'ⓘ'],
  ['Out-of-Memory limit', '#facc15', 'ⓘ'],
  ['Out-of-Memory node', '#be123c', 'ⓘ'],
  ['Out-of-Memory Java', '#f97316', 'ⓘ'],
  ['Image changed', '#d8b4fe', ''],
  ['Pod disruption', '#1e3a8a', ''],
];
const TL_LEGEND_TIPS: Record<string, string> = {
  'Burst reaction': 'Usage spiked above the recommendation; the request was temporarily raised',
  'Optimization eviction': 'Pod evicted to apply an optimization',
  'CPU throttling': 'CFS throttling detected on the workload',
  'CPU stressed nodes': 'Node-level CPU stress affecting this workload',
  'Out-of-Memory limit': 'Container OOMKilled at its memory limit',
  'Out-of-Memory node': 'Pod evicted under node memory pressure',
  'Out-of-Memory Java': 'JVM OutOfMemoryError detected inside the container',
};
const TL_TYPE_MAP: Record<string, [string, 'cs' | 'general']> = {
  Automated: ['Automated', 'cs'],
  'Burst reaction': ['Burst reaction', 'cs'],
  'Auto-healing': ['Auto-healing reaction', 'cs'],
  'Boot-time optimization': ['Boot-time optimization', 'cs'],
  'In-place optimization': ['In-place optimization', 'cs'],
  'Optimization eviction': ['Optimization eviction', 'cs'],
  'CPU throttling': ['CPU throttling', 'general'],
  'CPU pressure (PSI)': ['CPU stressed nodes', 'general'],
  'Out-of-Memory': ['Out-of-Memory limit', 'general'],
  'Out-of-Memory Java': ['Out-of-Memory Java', 'general'],
  'JVM Out-of-Memory': ['Out-of-Memory Java', 'general'],
  'Node memory pressure': ['Out-of-Memory node', 'general'],
  'Memory pressure (PSI)': ['Out-of-Memory node', 'general'],
  'Image changed': ['Image changed', 'general'],
  'Disk eviction': ['Pod disruption', 'general'],
  CrashLoopBackOff: ['Pod disruption', 'general'],
  'Frequent restarts': ['Pod disruption', 'general'],
};

const COLOR = Object.fromEntries(TL_LEGEND.map((l) => [l[0], l[1]]));

function Row({ label, list }: { label: string; list: { label: string; msg: string }[] }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 4px' }}>
      <span style={{ width: 96, textAlign: 'right', fontSize: 10, color: '#64748b', flexShrink: 0 }}>{label}</span>
      <div style={{ position: 'relative', flex: 1, height: 24 }}>
        <div style={{ position: 'absolute', left: 0, right: 0, top: '50%', transform: 'translateY(-50%)', height: 1, background: '#e2e8f0' }} />
        {list.map((e, i) => {
          const left = list.length === 1 ? 50 : 8 + i * (84 / Math.max(1, list.length - 1));
          return (
            <div
              key={i}
              title={`${e.label} — ${e.msg}`}
              style={{
                position: 'absolute',
                left: left + '%',
                top: '50%',
                transform: 'translate(-50%,-50%)',
                height: 10,
                width: 10,
                borderRadius: '50%',
                background: COLOR[e.label] || '#94a3b8',
                boxShadow: '0 0 0 2px #fff, 0 1px 2px rgba(0,0,0,.2)',
                cursor: 'help',
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

export default function TimelineStrip({ events }: { events: WlEvent[] }) {
  const rows: Record<'cs' | 'general', { label: string; msg: string }[]> = { cs: [], general: [] };
  (events || []).forEach((e) => {
    const m = TL_TYPE_MAP[e.type];
    if (!m) return;
    rows[m[1]].push({ label: m[0], msg: e.message || '' });
  });
  return (
    <div>
      <Row label="CoolScaler Event" list={rows.cs} />
      <Row label="General Event" list={rows.general} />
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          columnGap: 12,
          rowGap: 4,
          justifyContent: 'center',
          fontSize: 10,
          color: '#64748b',
          marginTop: 8,
          border: '1px solid #e9eaf0',
          borderRadius: 999,
          padding: '4px 12px',
          width: 'max-content',
          maxWidth: '100%',
          margin: '8px auto 0',
        }}
      >
        {TL_LEGEND.map(([t, c, info]) => (
          <span key={t} title={TL_LEGEND_TIPS[t]} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}>
            <span style={{ height: 8, width: 8, borderRadius: '50%', background: c }} />
            {t}
            {info && <span style={{ color: '#cbd5e1' }}> {info}</span>}
          </span>
        ))}
      </div>
    </div>
  );
}
