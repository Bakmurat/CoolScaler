// Sizing
import { useMemo, useState } from 'react';
import { useClusterStore } from '../../store/clusterStore';
import { useFeedback } from '../../providers/FeedbackProvider';
import { usd, cpuFmt, memFmt } from '../../lib/format';
import '../rightsizing/rightsizing.css';
import type { SizingContainer, SizingWorkload } from './types';

/** copyQosYaml() port — build the QoS snippet text. */
function buildQosYaml(w: SizingWorkload, cls: 'guaranteed' | 'burstable'): string {
  const yamlCpu = (c: number) => (c >= 1 ? String(Math.round(c * 1000) / 1000) : Math.round(c * 1000) + 'm');
  const yamlMem = (b: number) => Math.max(1, Math.round(b / 2 ** 20)) + 'Mi';
  const conts = (w.containers || [])
    .map((c) => {
      const q = (c.qos || {})[cls];
      if (!q) return '';
      return (
        `# container: ${c.name}\n` +
        `requests: { cpu: ${yamlCpu(q.cpuReq)}, memory: ${yamlMem(q.memReq)} }\n` +
        `limits:   { cpu: ${yamlCpu(q.cpuLim)}, memory: ${yamlMem(q.memLim)} }`
      );
    })
    .filter(Boolean)
    .join('\n');
  return `# CoolScaler ${cls} QoS recommendation for ${w.kind} ${w.namespace}/${w.name}\n${conts}`;
}

/** szContRow() port — one container row (excluded sidecars are not right-sized). */
function ContRow({ c }: { c: SizingContainer }) {
  if (c.excluded) {
    return (
      <tr style={{ fontSize: 11, borderTop: '1px solid #f4f5f9' }}>
        <td style={{ padding: '6px 0 6px 12px', color: '#64748b' }}>
          {c.name}{' '}
          <span className="pill" style={{ background: '#f1f5f9', color: '#94a3b8', fontSize: 9 }}>
            sidecar · excluded
          </span>
        </td>
        <td style={{ color: '#94a3b8' }} colSpan={3}>
          not right-sized
        </td>
      </tr>
    );
  }
  const g = (c.qos || {}).guaranteed;
  const b = (c.qos || {}).burstable;
  return (
    <tr style={{ fontSize: 11, borderTop: '1px solid #f4f5f9' }}>
      <td style={{ padding: '6px 0 6px 12px', fontWeight: 500, color: '#475569' }}>{c.name}</td>
      <td style={{ color: '#64748b' }}>
        cur <span className="num">{cpuFmt(c.reqCpu)}</span> / <span className="num">{memFmt(c.reqMem)}</span>
      </td>
      <td style={{ color: '#047857' }}>
        G{' '}
        <span className="num" style={{ fontWeight: 600 }}>
          {cpuFmt(g?.cpuReq)}·{memFmt(g?.memReq)}
        </span>
      </td>
      <td style={{ color: '#b45309' }}>
        B{' '}
        <span className="num" style={{ fontWeight: 600 }}>
          {cpuFmt(b?.cpuReq)}→{cpuFmt(b?.cpuLim)} · {memFmt(b?.memReq)}→{memFmt(b?.memLim)}
        </span>
      </td>
    </tr>
  );
}

const yamlBtn = (color: string, border: string): React.CSSProperties => ({
  fontSize: 10,
  fontWeight: 600,
  color,
  border: `1px solid ${border}`,
  borderRadius: 4,
  padding: '2px 8px',
  background: '#fff',
  cursor: 'pointer',
  fontFamily: 'inherit',
});

export default function SizingPage() {
  const workloads = useClusterStore((s) => s.workloads) as unknown as SizingWorkload[];
  const { toast } = useFeedback();
  const [nsSel, setNsSel] = useState('');
  const [q, setQ] = useState('');

  const namespaces = useMemo(
    () => Array.from(new Set((workloads || []).map((w) => w.namespace))).sort(),
    [workloads],
  );

  const { byNs, nss, total } = useMemo(() => {
    const ql = q.toLowerCase();
    const rows = (workloads || []).filter(
      (w) =>
        w.sizable &&
        (!nsSel || w.namespace === nsSel) &&
        (!ql || (w.namespace + '/' + w.name).toLowerCase().includes(ql)),
    );
    const groups: Record<string, SizingWorkload[]> = {};
    rows.forEach((w) => {
      (groups[w.namespace] = groups[w.namespace] || []).push(w);
    });
    return { byNs: groups, nss: Object.keys(groups).sort(), total: rows.length };
  }, [workloads, nsSel, q]);

  const copyYaml = (w: SizingWorkload, cls: 'guaranteed' | 'burstable') => {
    const text = buildQosYaml(w, cls);
    navigator.clipboard.writeText(text).then(
      () => toast('Copied ' + cls + ' YAML to clipboard:\n\n' + text),
      () => toast(text),
    );
  };

  return (
    <main style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* header */}
      <section
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div
            style={{ height: 32, width: 32, borderRadius: 8, background: '#eef2ff', display: 'grid', placeItems: 'center' }}
          >
            <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth={1.8}>
              <path d="M4 6h16M4 12h16M4 18h10M18 16l2 2-2 2" />
            </svg>
          </div>
          <div>
            <h1 style={{ fontSize: 17, fontWeight: 700, color: '#1e2536', margin: 0 }}>Recommendations by Namespace</h1>
            <p style={{ fontSize: 12, color: '#64748b', margin: 0 }}>
              Goldilocks-style — Guaranteed &amp; Burstable requests/limits per container, with copyable YAML.
            </p>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <select
            value={nsSel}
            onChange={(e) => setNsSel(e.target.value)}
            style={{
              background: '#fff',
              border: '1px solid #e3e5ee',
              borderRadius: 8,
              padding: '6px 12px',
              fontSize: 14,
              outline: 'none',
              fontFamily: 'inherit',
              color: '#1e2536',
            }}
          >
            <option value="">All namespaces</option>
            {namespaces.map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search workloads…"
            style={{
              background: '#f4f5f8',
              border: '1px solid #e9eaf0',
              borderRadius: 8,
              padding: '6px 12px',
              fontSize: 14,
              width: 208,
              outline: 'none',
              fontFamily: 'inherit',
            }}
          />
        </div>
      </section>

      {/* namespace groups */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {nss.length === 0 ? (
          <div className="card" style={{ padding: 24, textAlign: 'center', color: '#94a3b8', fontSize: 14 }}>
            No sizable workloads match. (G = Guaranteed req=lim·target; B = Burstable lower→upper)
          </div>
        ) : (
          nss.map((ns) => {
            const wls = [...byNs[ns]].sort((a, b) => b.savings - a.savings);
            const save = wls.reduce((s, w) => s + Math.max(w.savings, 0), 0);
            return (
              <section key={ns} className="card" style={{ overflow: 'hidden' }}>
                <div
                  style={{
                    padding: '10px 16px',
                    background: '#fafbff',
                    borderBottom: '1px solid #eef0f5',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                  }}
                >
                  <div style={{ fontWeight: 700, color: '#1e2536', fontSize: 14 }}>{ns}</div>
                  <div style={{ fontSize: 11, color: '#64748b' }}>
                    {wls.length} workloads ·{' '}
                    <span className="num" style={{ color: '#16a34a', fontWeight: 600 }}>
                      {usd(save)}/mo
                    </span>{' '}
                    potential
                  </div>
                </div>
                {wls.map((w) => (
                  <div key={w.key} style={{ borderTop: '1px solid #eef0f5' }}>
                    <div
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px' }}
                    >
                      <div style={{ fontSize: 12, fontWeight: 600, color: '#1e2536' }}>
                        {w.name}{' '}
                        <span style={{ fontSize: 10, color: '#94a3b8', fontWeight: 400 }}>
                          {w.kind} · {w.replicas}× · {usd(w.monthlyCost)}/mo
                        </span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        {w.savings > 0.5 && (
                          <span
                            className="pill"
                            style={{ background: '#f0fdf4', color: '#16a34a', border: '1px solid #dcfce7', fontSize: 10 }}
                          >
                            save {usd(w.savings)}/mo
                          </span>
                        )}
                        <button onClick={() => copyYaml(w, 'guaranteed')} style={yamlBtn('#059669', '#a7f3d0')}>
                          Guaranteed YAML
                        </button>
                        <button onClick={() => copyYaml(w, 'burstable')} style={yamlBtn('#d97706', '#fde68a')}>
                          Burstable YAML
                        </button>
                      </div>
                    </div>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <tbody>
                        {(w.containers || []).map((c) => (
                          <ContRow key={c.name} c={c} />
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
              </section>
            );
          })
        )}
      </div>

      <footer style={{ textAlign: 'center', fontSize: 12, color: '#94a3b8', paddingTop: 8, paddingBottom: 24 }}>
        CoolScaler · Sizing · {total} workloads across {nss.length} namespaces · recommendation-only (Goldilocks Mode: Off
        equivalent)
      </footer>
    </main>
  );
}
