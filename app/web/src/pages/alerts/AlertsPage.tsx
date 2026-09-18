// Troubleshooting (Alerts & Audit)
import { useCallback, useEffect, useRef, useState } from 'react';
import { getJson, postJson } from '../../api/client';
import '../rightsizing/rightsizing.css';

interface Alert {
  type: string;
  severity: 'critical' | 'warning' | 'info' | string;
  message: string;
  workload?: string;
  value?: number | null;
  since?: string;
}
interface AlertsResponse {
  alerts?: Alert[];
  counts?: { critical?: number; warning?: number; info?: number };
}
interface AlertRule {
  severity: string;
  threshold: number;
  enabled: boolean;
  desc?: string;
}
interface AlertSettingsResponse {
  rules?: Record<string, AlertRule>;
}
interface AutomationConfigResponse {
  automate?: Record<string, boolean>;
}
interface HeadroomResponse {
  enabled?: boolean;
  cpuClusterProportion?: number;
  memoryClusterProportion?: number;
}
interface AuditRecord {
  timestamp?: string;
  actionType?: string;
  target?: string;
  oldValue?: string;
  newValue?: string;
  user?: string;
}
interface AuditsResponse {
  audits?: AuditRecord[];
}

const ALERT_SEV: Record<string, { bg: string; text: string; border: string; dot: string }> = {
  critical: { bg: '#fff1f2', text: '#e11d48', border: '#fecdd3', dot: '#f43f5e' },
  warning: { bg: '#fffbeb', text: '#d97706', border: '#fde68a', dot: '#f59e0b' },
  info: { bg: '#f0f9ff', text: '#0284c7', border: '#bae6fd', dot: '#0ea5e9' },
};

const card: React.CSSProperties = {
  background: '#fff',
  border: '1px solid #e9eaf0',
  borderRadius: 16,
  boxShadow: '0 1px 2px rgba(16,24,40,.06)',
  padding: 20,
};
const cardTitle: React.CSSProperties = { fontSize: 14, fontWeight: 700, color: '#1e2536' };
const pillStyle = (bg: string, text: string, border?: string): React.CSSProperties => ({
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
const numInput: React.CSSProperties = {
  width: 80,
  background: '#f4f5f8',
  border: '1px solid #e9eaf0',
  borderRadius: 8,
  padding: '4px 8px',
  fontSize: 13,
  outline: 'none',
  fontFamily: '"JetBrains Mono", ui-monospace, monospace',
};
const saveBtn: React.CSSProperties = {
  marginTop: 16,
  fontSize: 13,
  fontWeight: 600,
  color: '#fff',
  background: '#22c55e',
  border: 'none',
  borderRadius: 8,
  padding: '6px 16px',
  cursor: 'pointer',
  fontFamily: 'inherit',
};
const th: React.CSSProperties = { textAlign: 'left', padding: '8px 0', fontWeight: 600 };

export default function AlertsPage() {
  const [alertsData, setAlertsData] = useState<AlertsResponse | null>(null);
  const [alertsErr, setAlertsErr] = useState(false);
  const [rules, setRules] = useState<Record<string, AlertRule>>({});
  const [automate, setAutomate] = useState<Record<string, boolean>>({});
  const [hrEnabled, setHrEnabled] = useState(false);
  const [hrCpu, setHrCpu] = useState<string>('');
  const [hrMem, setHrMem] = useState<string>('');
  const [audits, setAudits] = useState<AuditRecord[]>([]);
  const [alertTable, setAlertTable] = useState<{ name: string; slackFrequency?: number; alertSettings?: { enabled?: boolean; severity?: string; parameters?: { interval?: string; window?: string; threshold?: string } } }[]>([]);
  const [acSaved, setAcSaved] = useState('');
  const [hrSaved, setHrSaved] = useState('');
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);

  useEffect(() => {
    getJson<{ alerts?: typeof alertTable }>('/api/alerts/settings')
      .then((d) => setAlertTable(d.alerts || []))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadAlerts = useCallback(() => {
    getJson<AlertsResponse>('/api/alerts')
      .then((d) => {
        setAlertsData(d);
        setAlertsErr(false);
      })
      .catch(() => setAlertsErr(true));
  }, []);
  const loadRules = useCallback(() => {
    getJson<AlertSettingsResponse>('/api/alert-settings')
      .then((s) => setRules(s.rules || {}))
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadAlerts();
    loadRules();
    getJson<AutomationConfigResponse>('/api/automation-config')
      .then((ac) => setAutomate(ac.automate || {}))
      .catch(() => {});
    getJson<HeadroomResponse>('/api/headroom')
      .then((h) => {
        setHrEnabled(!!h.enabled);
        setHrCpu(h.cpuClusterProportion != null ? String(h.cpuClusterProportion) : '');
        setHrMem(h.memoryClusterProportion != null ? String(h.memoryClusterProportion) : '');
      })
      .catch(() => {});
    getJson<AuditsResponse>('/api/audits')
      .then((a) => setAudits(a.audits || []))
      .catch(() => {});
  }, [loadAlerts, loadRules]);

  const toggleAlertRule = async (type: string, enabled: boolean) => {
    try {
      await postJson('/api/alert-settings', { rules: { [type]: { enabled } } });
      loadRules();
      loadAlerts();
    } catch {
    }
  };

  const saveAutomationConfig = async () => {
    try {
      await postJson('/api/automation-config', { automate });
      setAcSaved('✓ saved');
      timers.current.push(window.setTimeout(() => setAcSaved(''), 2500));
    } catch {
    }
  };

  const saveHeadroom = async () => {
    try {
      await postJson('/api/headroom', {
        enabled: hrEnabled,
        cpuClusterProportion: +hrCpu,
        memoryClusterProportion: +hrMem,
      });
      setHrSaved('✓ saved');
      timers.current.push(window.setTimeout(() => setHrSaved(''), 2500));
    } catch {
    }
  };

  const c = alertsData?.counts || {};
  const alerts = alertsData?.alerts || [];

  return (
    <main style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* header + summary pills */}
      <section style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 700, color: '#1e2536', margin: 0 }}>Troubleshooting</h1>
          <p style={{ fontSize: 14, color: '#64748b', margin: '2px 0 0' }}>
            Live alerts, alert settings, and the automation audit trail.
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 600 }}>
          <span style={pillStyle(ALERT_SEV.critical.bg, ALERT_SEV.critical.text, ALERT_SEV.critical.border)}>
            {c.critical || 0} critical
          </span>
          <span style={pillStyle(ALERT_SEV.warning.bg, ALERT_SEV.warning.text, ALERT_SEV.warning.border)}>
            {c.warning || 0} warning
          </span>
          <span style={pillStyle(ALERT_SEV.info.bg, ALERT_SEV.info.text, ALERT_SEV.info.border)}>
            {c.info || 0} info
          </span>
        </div>
      </section>

      {/* firing alerts + alert settings */}
      <section style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 16 }}>
        <div style={card}>
          <div style={{ ...cardTitle, marginBottom: 12 }}>Firing alerts</div>
          <div style={{ fontSize: 13, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {alertsErr ? (
              <div style={{ color: '#94a3b8' }}>alerts unavailable</div>
            ) : alertsData == null ? (
              <div style={{ color: '#94a3b8' }}>Loading…</div>
            ) : alerts.length === 0 ? (
              <div style={{ color: '#16a34a' }}>No alerts firing.</div>
            ) : (
              alerts.map((a, i) => {
                const s = ALERT_SEV[a.severity] || ALERT_SEV.info;
                return (
                  <div
                    key={i}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 8,
                      padding: '6px 0',
                      borderBottom: i === alerts.length - 1 ? 'none' : '1px solid #f4f5f9',
                    }}
                  >
                    <span style={{ marginTop: 4, height: 8, width: 8, borderRadius: 9999, flexShrink: 0, background: s.dot }} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <span style={{ fontWeight: 600, color: s.text }}>{a.type}</span>
                      <span style={{ color: '#64748b' }}> — {a.message}</span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        <div style={card}>
          <div style={{ ...cardTitle, marginBottom: 12 }}>Alert settings</div>
          <div style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {Object.keys(rules).map((k, i, arr) => {
              const x = rules[k];
              const sevColor =
                x.severity === 'critical' ? '#e11d48' : x.severity === 'warning' ? '#d97706' : '#0284c7';
              return (
                <div
                  key={k}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                    padding: '4px 0',
                    borderBottom: i === arr.length - 1 ? 'none' : '1px solid #f6f7fb',
                  }}
                >
                  <div>
                    <span style={{ fontWeight: 600, color: '#334155' }}>{k}</span>{' '}
                    <span style={{ color: sevColor, fontSize: 10, textTransform: 'uppercase', fontWeight: 700 }}>
                      {x.severity}
                    </span>
                    <div style={{ fontSize: 11, color: '#94a3b8' }}>{x.desc || ''}</div>
                  </div>
                  <span
                    onClick={() => toggleAlertRule(k, !x.enabled)}
                    style={{
                      ...pillStyle(x.enabled ? '#f0fdf4' : '#f1f5f9', x.enabled ? '#16a34a' : '#94a3b8'),
                      cursor: 'pointer',
                    }}
                  >
                    {x.enabled ? 'on' : 'off'} · ≥{x.threshold}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* automation settings + cluster headroom */}
      <section style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div style={card}>
          <div style={{ ...cardTitle, marginBottom: 4 }}>Automation settings</div>
          <div style={{ fontSize: 12, color: '#64748b', marginBottom: 12 }}>
            Cluster-wide per-product automation switches.
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              columnGap: 16,
              rowGap: 8,
              fontSize: 13,
              color: '#334155',
            }}
          >
            {Object.keys(automate).map((k) => (
              <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={!!automate[k]}
                  onChange={(e) => setAutomate((prev) => ({ ...prev, [k]: e.target.checked }))}
                  style={{ borderRadius: 4, accentColor: '#6366f1' }}
                />{' '}
                {k}
              </label>
            ))}
          </div>
          <button onClick={saveAutomationConfig} style={saveBtn}>
            Save automation settings
          </button>
          <span style={{ marginLeft: 8, fontSize: 12, color: '#16a34a' }}>{acSaved}</span>
        </div>

        <div style={card}>
          <div style={{ ...cardTitle, marginBottom: 4 }}>Cluster headroom</div>
          <div style={{ fontSize: 12, color: '#64748b', marginBottom: 12 }}>
            Reserved scale-up buffer (% of allocatable).
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, fontSize: 13, color: '#334155' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={hrEnabled}
                onChange={(e) => setHrEnabled(e.target.checked)}
                style={{ borderRadius: 4, accentColor: '#6366f1' }}
              />{' '}
              Enabled
            </label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ width: 96, color: '#64748b' }}>CPU buffer %</span>
              <input type="number" min={0} max={50} value={hrCpu} onChange={(e) => setHrCpu(e.target.value)} style={numInput} className="num" />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ width: 96, color: '#64748b' }}>Memory buffer %</span>
              <input type="number" min={0} max={50} value={hrMem} onChange={(e) => setHrMem(e.target.value)} style={numInput} className="num" />
            </div>
          </div>
          <button onClick={saveHeadroom} style={saveBtn}>
            Save headroom
          </button>
          <span style={{ marginLeft: 8, fontSize: 12, color: '#16a34a' }}>{hrSaved}</span>
        </div>
      </section>

      {/* automation audit trail */}
      <section style={card}>
        <div style={{ ...cardTitle, marginBottom: 12 }}>Automation audit trail</div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
            <thead>
              <tr
                style={{
                  color: '#94a3b8',
                  fontSize: 11,
                  textTransform: 'uppercase',
                  letterSpacing: '.025em',
                  borderBottom: '1px solid #eef0f5',
                }}
              >
                <th style={th}>Time</th>
                <th style={th}>Action</th>
                <th style={th}>Target</th>
                <th style={th}>Change</th>
                <th style={th}>By</th>
              </tr>
            </thead>
            <tbody>
              {audits.length === 0 ? (
                <tr>
                  <td colSpan={5} style={{ padding: '12px 0', color: '#94a3b8' }}>
                    No audit records yet.
                  </td>
                </tr>
              ) : (
                audits.slice(0, 50).map((r, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid #f6f7fb' }}>
                    <td className="num" style={{ padding: '6px 0', color: '#94a3b8', whiteSpace: 'nowrap' }}>
                      {(r.timestamp || '').replace('T', ' ').replace('Z', '')}
                    </td>
                    <td style={{ fontWeight: 600, color: '#334155', paddingRight: 12 }}>{r.actionType}</td>
                    <td
                      style={{
                        color: '#64748b',
                        maxWidth: 260,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        paddingRight: 12,
                      }}
                    >
                      {r.target}
                    </td>
                    <td style={{ color: '#64748b', paddingRight: 12 }}>{r.newValue || ''}</td>
                    <td style={{ color: '#94a3b8' }}>{r.user || ''}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Alert settings */}
      <section className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '16px 20px 8px', fontSize: 15, fontWeight: 700, color: '#1e2536' }}>
          Alert settings <span style={{ fontSize: 12, fontWeight: 400, color: '#94a3b8' }}>· predefined alert rules</span>
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr>
              {['Name', 'Window', 'Threshold', 'Alert Interval', 'Severity'].map((h) => (
                <th key={h} style={{ textAlign: 'left', fontSize: 12.5, fontWeight: 700, color: '#1e2536', padding: '10px 18px', background: '#f6f7fb', borderBottom: '1px solid #eef0f6' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {alertTable.map((a) => {
              const p = a.alertSettings?.parameters || {};
              const sev = a.alertSettings?.severity || '';
              const sevColor = sev === 'High' ? '#dc2626' : sev === 'Medium' ? '#d97706' : '#64748b';
              const fmtDur = (d?: string) => (d || '').replace('m', ' min').replace('1h', '1 hour').replace('1d', '1 day');
              return (
                <tr key={a.name}>
                  <td style={{ padding: '11px 18px', borderBottom: '1px solid #f2f3f8', fontWeight: 500, color: '#1e2536' }}>{a.name}</td>
                  <td style={{ padding: '11px 18px', borderBottom: '1px solid #f2f3f8', color: '#475569' }}>{fmtDur(p.window)}</td>
                  <td style={{ padding: '11px 18px', borderBottom: '1px solid #f2f3f8', color: '#475569' }}>{p.threshold}{/^\d+$/.test(p.threshold || '') && Number(p.threshold) <= 100 && a.name !== 'Out Of Memory' && a.name !== 'Pod Failed Create Event' ? '%' : ''}</td>
                  <td style={{ padding: '11px 18px', borderBottom: '1px solid #f2f3f8', color: '#475569' }}>every {fmtDur(p.interval)}</td>
                  <td style={{ padding: '11px 18px', borderBottom: '1px solid #f2f3f8' }}><span style={{ color: sevColor, fontWeight: 600 }}>{sev}</span></td>
                </tr>
              );
            })}
            {!alertTable.length && (
              <tr><td colSpan={5} style={{ textAlign: 'center', color: '#94a3b8', padding: '28px 0' }}>No alert settings.</td></tr>
            )}
          </tbody>
        </table>
      </section>
    </main>
  );
}
