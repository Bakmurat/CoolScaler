// Per-node drawer
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import SlideOver, { DrawerHeader } from '../../components/SlideOver';
import { getJson } from '../../api/client';
import { useGlobalSearchString } from '../../hooks/useUrlState';
import { usd, cpuFmt, memFmt } from '../../lib/format';
import { yamlDump } from '../rightsizing/lib';
import type { NodeDetail } from './types';

const TABS = ['Overview', 'Pods', 'Events', 'YAML'] as const;
type Tab = (typeof TABS)[number];

const cardStyle: CSSProperties = {
  background: '#fff',
  border: '1px solid #e9eaf0',
  borderRadius: 16,
  padding: 16,
};

function Pill({ bg, color, children }: { bg: string; color: string; children: ReactNode }) {
  return (
    <span
      className="pill"
      style={{ background: bg, color, fontSize: 11, fontWeight: 600, padding: '2px 9px', borderRadius: 9999, display: 'inline-flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap' }}
    >
      {children}
    </span>
  );
}

function NdBar({ label, pct, color, sub }: { label: string; pct: number; color: string; sub?: string }) {
  const w = Math.max(0, Math.min(100, pct || 0));
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 2 }}>
        <span style={{ color: '#64748b' }}>{label}</span>
        <span className="num" style={{ fontWeight: 600, color: '#475569' }}>
          {Math.round(pct || 0)}%{sub ? ' · ' + sub : ''}
        </span>
      </div>
      <div style={{ height: 8, borderRadius: 9999, background: '#eef0f6', overflow: 'hidden' }}>
        <div style={{ height: '100%', background: color, width: w + '%' }} />
      </div>
    </div>
  );
}

function Fact({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: '#94a3b8' }}>{k}</div>
      <div style={{ fontSize: 13, fontWeight: 600, color: '#1e2536' }}>{v}</div>
    </div>
  );
}

function OverviewTab({ d, onClose }: { d: NodeDetail; onClose: () => void }) {
  const navigate = useNavigate();
  const search = useGlobalSearchString();
  const a = d.allocatable || {};
  const rq = d.request || {};
  const us = d.usage || {};
  const cpuReqP = a.cpu ? ((rq.cpu || 0) / a.cpu) * 100 : 0;
  const cpuUseP = a.cpu ? ((us.cpu || 0) / a.cpu) * 100 : 0;
  const memReqP = a.mem ? ((rq.mem || 0) / a.mem) * 100 : 0;
  const memUseP = a.mem ? ((us.mem || 0) / a.mem) * 100 : 0;
  const blockers = (d.pods || []).filter((p) => (p.blockers || []).length);
  const taints = d.taints || [];
  return (
    <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ ...cardStyle, display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16 }}>
        <Fact k="Monthly cost" v={usd(d.cost)} />
        <Fact
          k="Lifecycle"
          v={d.isSpot ? <Pill bg="#f5f3ff" color="#7c3aed">Spot</Pill> : <Pill bg="#f1f5f9" color="#64748b">On-Demand</Pill>}
        />
        <Fact
          k="Status"
          v={
            <span style={{ display: 'inline-flex', gap: 4 }}>
              {d.ready ? <Pill bg="#ecfdf5" color="#059669">Ready</Pill> : <Pill bg="#fff1f2" color="#e11d48">NotReady</Pill>}
              {d.schedulable ? (
                <Pill bg="#ecfdf5" color="#059669">Schedulable</Pill>
              ) : (
                <Pill bg="#fffbeb" color="#d97706">tainted</Pill>
              )}
            </span>
          }
        />
        <Fact k="Instance type" v={d.instanceType || '—'} />
        <Fact k="Pods" v={d.podCount ?? '—'} />
        <Fact k="Kubelet" v={d.kubeletVersion || '—'} />
        <Fact k="OS" v={d.os || '—'} />
        <Fact k="Created" v={d.creationTimestamp ? new Date(d.creationTimestamp).toLocaleDateString() : '—'} />
      </div>

      <div style={{ ...cardStyle, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: '#1e2536' }}>Capacity (allocatable vs request vs usage)</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#64748b' }}>CPU · {cpuFmt(a.cpu)} allocatable</div>
            <NdBar label="Requested" pct={cpuReqP} color="#fbbf24" sub={cpuFmt(rq.cpu)} />
            <NdBar label="Used" pct={cpuUseP} color="#6366f1" sub={cpuFmt(us.cpu)} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#64748b' }}>Memory · {memFmt(a.mem)} allocatable</div>
            <NdBar label="Requested" pct={memReqP} color="#fbbf24" sub={memFmt(rq.mem)} />
            <NdBar label="Used" pct={memUseP} color="#6366f1" sub={memFmt(us.mem)} />
          </div>
        </div>
      </div>

      <div style={cardStyle}>
        <div style={{ fontSize: 13, fontWeight: 700, color: '#1e2536', marginBottom: 4 }}>Scale-down blockers</div>
        {blockers.length ? (
          <>
            <div style={{ fontSize: 12, color: '#64748b', marginBottom: 8 }}>
              {blockers.length} pod(s) on this node block scale-down. Bin-pack them on the{' '}
              <button
                onClick={() => {
                  onClose();
                  navigate('/pod-placement' + search);
                }}
                style={{ color: '#4f46e5', fontWeight: 600, background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12 }}
              >
                Pod Placement
              </button>{' '}
              page.
            </div>
            {blockers.slice(0, 12).map((p) => (
              <div
                key={p.namespace + '/' + p.name}
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid #f3f4f9', padding: '6px 0', fontSize: 12 }}
              >
                <span style={{ color: '#475569', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {p.namespace}/{p.name}
                </span>
                <span style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                  {(p.blockers || []).map((b) => (
                    <Pill key={b} bg="#f5f3ff" color="#7c3aed">
                      {b}
                    </Pill>
                  ))}
                </span>
              </div>
            ))}
          </>
        ) : (
          <div style={{ fontSize: 12, color: '#059669' }}>No scale-down blockers — this node can be consolidated freely.</div>
        )}
      </div>

      <div style={cardStyle}>
        <div style={{ fontSize: 13, fontWeight: 700, color: '#1e2536', marginBottom: 8 }}>Taints</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {taints.length ? (
            taints.map((t, i) => (
              <Pill key={i} bg="#f1f5f9" color="#64748b">
                {t.key}
                {t.value ? '=' + t.value : ''}:{t.effect}
              </Pill>
            ))
          ) : (
            <span style={{ color: '#94a3b8', fontSize: 12 }}>none</span>
          )}
        </div>
      </div>
    </div>
  );
}

const thStyle: CSSProperties = {
  textAlign: 'left',
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: '.04em',
  color: '#94a3b8',
  fontWeight: 600,
  padding: '10px 12px',
  borderBottom: '1px solid #eef0f6',
};

function PodsTab({ d }: { d: NodeDetail }) {
  const pods = d.pods || [];
  return (
    <div style={{ padding: 20 }}>
      <div style={{ ...cardStyle, padding: 0, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ ...thStyle, paddingLeft: 16 }}>Pod ({pods.length})</th>
              <th style={thStyle}>CPU req</th>
              <th style={thStyle}>CPU use</th>
              <th style={thStyle}>Mem req</th>
              <th style={thStyle}>Mem use</th>
              <th style={thStyle}>Blockers</th>
            </tr>
          </thead>
          <tbody>
            {pods.length ? (
              pods.map((p) => (
                <tr key={p.namespace + '/' + p.name} style={{ borderBottom: '1px solid #f3f4f9' }}>
                  <td style={{ padding: '8px 16px' }}>
                    <div style={{ fontWeight: 500, color: '#1e2536', fontSize: 12 }}>{p.name}</div>
                    <div style={{ fontSize: 11, color: '#94a3b8' }}>
                      {p.namespace} · {p.workloadKind || '—'}
                    </div>
                  </td>
                  <td className="num" style={{ padding: '8px 12px', color: '#475569', fontSize: 12 }}>{cpuFmt(p.cpuReq)}</td>
                  <td className="num" style={{ padding: '8px 12px', color: '#4f46e5', fontSize: 12 }}>{cpuFmt(p.cpuUse)}</td>
                  <td className="num" style={{ padding: '8px 12px', color: '#475569', fontSize: 12 }}>{memFmt(p.memReq)}</td>
                  <td className="num" style={{ padding: '8px 12px', color: '#4f46e5', fontSize: 12 }}>{memFmt(p.memUse)}</td>
                  <td style={{ padding: '8px 12px' }}>
                    {(p.blockers || []).length ? (
                      <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
                        {(p.blockers || []).map((b) => (
                          <Pill key={b} bg="#f5f3ff" color="#7c3aed">
                            {b}
                          </Pill>
                        ))}
                      </span>
                    ) : (
                      <span style={{ color: '#cbd5e1' }}>—</span>
                    )}
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={6} style={{ padding: '24px 16px', textAlign: 'center', color: '#94a3b8' }}>
                  no pods
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function EventsTab({ d }: { d: NodeDetail }) {
  const ev = d.events || [];
  if (!ev.length)
    return <div style={{ padding: 32, textAlign: 'center', color: '#94a3b8', fontSize: 14 }}>No node events found ✓</div>;
  return (
    <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 8 }}>
      {ev.map((e, i) => (
        <div key={i} style={{ ...cardStyle, padding: 12, display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          {e.type === 'Warning' ? (
            <Pill bg="#fffbeb" color="#d97706">Warning</Pill>
          ) : (
            <Pill bg="#f1f5f9" color="#64748b">{e.type || 'Normal'}</Pill>
          )}
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#1e2536' }}>
              {e.reason || ''}{' '}
              {(e.count || 0) > 1 && <span style={{ fontSize: 11, color: '#94a3b8' }}>×{e.count}</span>}
            </div>
            <div style={{ fontSize: 12, color: '#64748b' }}>{e.message || ''}</div>
            <div style={{ fontSize: 11, color: '#94a3b8' }}>
              {e.lastTimestamp ? new Date(e.lastTimestamp).toLocaleString() : ''}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function YamlTab({ d }: { d: NodeDetail }) {
  const y = d.node ? yamlDump(d.node) : '# ??? node object not available';
  return (
    <div style={{ padding: 20 }}>
      <pre
        style={{
          background: '#1e2230',
          color: '#d6d9e6',
          fontSize: 11,
          lineHeight: 1.625,
          borderRadius: 8,
          padding: 16,
          overflowX: 'auto',
          whiteSpace: 'pre',
          margin: 0,
          fontFamily: '"JetBrains Mono", ui-monospace, monospace',
        }}
      >
        {y}
      </pre>
    </div>
  );
}

export default function NodeDrawer({ name, onClose }: { name: string | null; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('Overview');
  const [detail, setDetail] = useState<NodeDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setTab('Overview');
    setDetail(null);
    setErr(null);
    if (!name) return;
    let dead = false;
    getJson<NodeDetail>('/api/node?name=' + encodeURIComponent(name))
      .then((d) => {
        if (dead) return;
        if (!d || !d.found) setErr('node not found');
        else setDetail(d);
      })
      .catch(() => {
        if (!dead) setErr('failed to load node');
      });
    return () => {
      dead = true;
    };
  }, [name]);

  if (!name) return null;

  return (
    <SlideOver open={!!name} onClose={onClose} maxWidth={1000} panelStyle={{ background: '#f7f8fc' }}>
      <DrawerHeader
        dark
        left={
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <span style={{ fontSize: 12, color: '#cbd5e1', fontWeight: 400 }}>Node overview</span>
            <span style={{ color: '#64748b' }}>→</span>
            <span style={{ fontWeight: 700, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
          </span>
        }
        right={
          <button
            onClick={onClose}
            aria-label="Close"
            style={{ color: '#cbd5e1', background: 'none', border: 'none', fontSize: 20, lineHeight: 1, cursor: 'pointer' }}
          >
            ×
          </button>
        }
      />
      <div style={{ display: 'flex', gap: 4, padding: '8px 20px 0', borderBottom: '1px solid #e6e8f0', background: '#fff', flexShrink: 0 }}>
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: '8px 12px',
              fontSize: 13,
              fontWeight: 600,
              background: 'none',
              cursor: 'pointer',
              fontFamily: 'inherit',
              border: 'none',
              borderBottom: tab === t ? '2px solid #6366f1' : '2px solid transparent',
              color: tab === t ? '#4f46e5' : '#94a3b8',
            }}
          >
            {t}
          </button>
        ))}
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {err ? (
          <div style={{ padding: 32, textAlign: 'center', color: err === 'node not found' ? '#94a3b8' : '#fb7185' }}>{err}</div>
        ) : !detail ? (
          <div style={{ padding: 32, textAlign: 'center', color: '#94a3b8', fontSize: 14 }}>loading…</div>
        ) : tab === 'Overview' ? (
          <OverviewTab d={detail} onClose={onClose} />
        ) : tab === 'Pods' ? (
          <PodsTab d={detail} />
        ) : tab === 'Events' ? (
          <EventsTab d={detail} />
        ) : (
          <YamlTab d={detail} />
        )}
      </div>
    </SlideOver>
  );
}
