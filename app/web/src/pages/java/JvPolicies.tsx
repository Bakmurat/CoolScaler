// Java Policies Management
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { getJson } from '../../api/client';
import { useFeedback } from '../../providers/FeedbackProvider';
import SlideOver, { DrawerHeader } from '../../components/SlideOver';
import { Toggle } from '../rightsizing/ui';
import '../rightsizing/rightsizing.css';
import type { JavaPolicy } from './types';

// Static fallback
const FALLBACK_POLICIES: JavaPolicy[] = [
  {
    name: 'java-memory-aware',
    builtin: true,
    description:
      'Sizes Java workloads from measured JVM heap and non-heap usage and can tune the heap ceiling in a second step.',
    usedBy: 'All Java workloads',
    recommendation: { realUsageCalculation: true },
    automation: { memoryOptimization: true, gcOptimization: true, oomAutoHealing: true },
  },
];

type PaneKey = 'Recommendation' | 'Automation';

export default function JvPolicies() {
  const { toast } = useFeedback();
  const [policies, setPolicies] = useState<JavaPolicy[]>(FALLBACK_POLICIES);
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<JavaPolicy | null>(null);

  useEffect(() => {
    getJson<{ policies?: JavaPolicy[] }>('/api/java/policies')
      .then((d) => {
        if (d.policies && d.policies.length) setPolicies(d.policies);
      })
      .catch(() => {
        /* endpoint not shipped yet */
      });
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? policies.filter((p) => p.name.toLowerCase().includes(q)) : policies;
  }, [policies, search]);

  return (
    <>
      <section className="card" style={{ padding: 20 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: '#1e2536' }}>Java Policies Management</div>
        <p style={{ fontSize: 12, color: '#64748b', margin: '2px 0 14px' }}>
          Policies for Java workloads: how JVM memory is measured and how the heap ceiling is tuned.
        </p>

        {/* search */}
        <div style={{ position: 'relative', width: 260, marginBottom: 14 }}>
          <svg
            style={{ width: 16, height: 16, color: '#94a3b8', position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)' }}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
          >
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4-4" />
          </svg>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search…"
            style={{
              width: '100%',
              boxSizing: 'border-box',
              background: '#fff',
              border: '1px solid #dfe2ec',
              borderRadius: 999,
              padding: '6px 12px 6px 36px',
              fontSize: 13,
              outline: 'none',
              fontFamily: 'inherit',
            }}
          />
        </div>

        {/* table */}
        <table style={{ width: '100%', fontSize: 14, borderCollapse: 'collapse' }}>
          <thead
            style={{
              color: '#94a3b8',
              fontSize: 11,
              textTransform: 'uppercase',
              letterSpacing: '.04em',
              background: '#fafbfd',
              borderTop: '1px solid #eef0f5',
              borderBottom: '1px solid #eef0f5',
            }}
          >
            <tr>
              <th style={{ fontWeight: 600, padding: '10px 12px', textAlign: 'left' }}>Policy Name</th>
              <th style={{ fontWeight: 600, padding: '10px 12px', textAlign: 'right' }}>Used by Workloads</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((p) => (
              <tr
                key={p.name}
                className="wlrow"
                title="Open policy"
                onClick={() => setOpen(p)}
                style={{
                  borderBottom: '1px solid #f1f2f7',
                  cursor: 'pointer',
                  background: p.builtin !== false ? 'rgba(209,250,229,.4)' : undefined,
                }}
              >
                <td style={{ padding: '12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 15 }}>☕</span>
                    <span style={{ fontWeight: 600, color: '#1e2536', fontSize: 13 }}>{p.name}</span>
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: '#94a3b8',
                      marginLeft: 23,
                      maxWidth: 560,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                    title={p.description}
                  >
                    {p.description}
                  </div>
                </td>
                <td style={{ padding: '12px', textAlign: 'right', fontSize: 13, color: '#475569' }}>
                  {p.usedBy || 'All Java workloads'}
                  {p.usedByCount != null && (
                    <span className="num" style={{ color: '#94a3b8', marginLeft: 6, fontSize: 11 }}>
                      ({p.usedByCount})
                    </span>
                  )}
                </td>
              </tr>
            ))}
            {!filtered.length && (
              <tr>
                <td colSpan={2} style={{ padding: '32px 0', textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>
                  No policies match your search.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <JvPolicyDrawer policy={open} onClose={() => setOpen(null)} onLocked={() => toast('Built-in policy is locked.')} />
    </>
  );
}

// ---------- drawer ----------

function JvPolicyDrawer({
  policy,
  onClose,
  onLocked,
}: {
  policy: JavaPolicy | null;
  onClose: () => void;
  onLocked: () => void;
}) {
  const [pane, setPane] = useState<PaneKey>('Recommendation');
  useEffect(() => {
    if (policy) setPane('Recommendation');
  }, [policy]);
  if (!policy) return null;

  const rec = policy.recommendation || {};
  const auto = policy.automation || {};
  const realUsage = rec.realUsageCalculation ?? true;
  const memOpt = auto.memoryOptimization ?? true;
  const gcOpt = auto.gcOptimization ?? true;
  const oomHeal = auto.oomAutoHealing ?? true;

  const navEntry = (key: PaneKey, icon: string): ReactNode => {
    const active = pane === key;
    return (
      <div
        key={key}
        onClick={() => setPane(key)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '9px 12px',
          fontSize: 13,
          fontWeight: 600,
          cursor: 'pointer',
          color: active ? '#4f46e5' : '#64748b',
          borderBottom: active ? '2px solid #6366f1' : '2px solid transparent',
          width: 'max-content',
        }}
      >
        <span style={{ fontSize: 14 }}>{icon}</span>
        {key}
      </div>
    );
  };

  return (
    <SlideOver open onClose={onClose} maxWidth={Math.max(720, Math.round(window.innerWidth * 0.6))}>
      <DrawerHeader
        dark
        left={
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <span style={{ fontSize: 15 }}>🔒</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{policy.name}</span>
            <span
              className="pill"
              style={{ background: 'rgba(255,255,255,.14)', color: '#cbd5e1', border: '1px solid rgba(255,255,255,.2)' }}
            >
              Built in policy
            </span>
          </span>
        }
        right={
          <button
            onClick={onClose}
            title="Close"
            style={{ background: 'transparent', border: 'none', color: '#fff', fontSize: 16, cursor: 'pointer', fontFamily: 'inherit' }}
          >
            ✕
          </button>
        }
      />

      {/* single folder tab: Policy */}
      <div style={{ display: 'flex', gap: 2, padding: '10px 20px 0', borderBottom: '1px solid #e9eaf0', flexShrink: 0 }}>
        <span className="tabline active">Policy</span>
      </div>

      {/* body: left nav + pane */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <nav style={{ width: 176, flexShrink: 0, borderRight: '1px solid #eef0f5', padding: '16px 12px', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {navEntry('Recommendation', '⚙')}
          {navEntry('Automation', '◎')}
        </nav>

        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
          {pane === 'Recommendation' ? (
            <LockedToggleBlock
              title="Measure memory from the JVM"
              description="Use heap and non-heap usage reported by the JVM instead of container memory."
              switchLabel="Use JVM-reported usage"
              checked={realUsage}
              onLocked={onLocked}
            />
          ) : (
            <>
              <LockedToggleBlock
                title="Tune memory from JVM usage"
                description="Adjust the memory request and the heap ceiling from measured JVM usage."
                switchLabel="Enable memory optimization"
                checked={memOpt}
                onLocked={onLocked}
              />
              <div style={{ borderTop: '1px solid #eef0f5', margin: '18px 0' }} />
              <LockedToggleBlock
                title="Optimize JVM garbage collector"
                description="Select and adjust the optimal GC configuration."
                switchLabel="Enable GC optimization"
                checked={gcOpt}
                onLocked={onLocked}
              />
              <div style={{ borderTop: '1px solid #eef0f5', margin: '18px 0' }} />
              <LockedToggleBlock
                title="Enable JVM out-of-memory auto-healing"
                description="Detect JVM Out-of-Memory and enhance recommendations."
                switchLabel="Enable Out-of-Memory auto-healing"
                checked={oomHeal}
                onLocked={onLocked}
              />
            </>
          )}
        </div>
      </div>

      {/* footer: lock icon + Cancel only */}
      <div
        style={{
          flexShrink: 0,
          borderTop: '1px solid #eef0f5',
          padding: '12px 20px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: 8,
        }}
      >
        <button
          onClick={onLocked}
          title="Built-in policy — locked"
          style={{
            height: 32,
            width: 32,
            display: 'grid',
            placeItems: 'center',
            borderRadius: 8,
            border: '1px solid #e3e5ee',
            background: '#fff',
            color: '#94a3b8',
            cursor: 'pointer',
            fontFamily: 'inherit',
            fontSize: 14,
          }}
        >
          🔒
        </button>
        <button onClick={onClose} style={cancelBtn}>
          Cancel
        </button>
      </div>
    </SlideOver>
  );
}

/*
 * Toggle row for the built-in policy — checked from the payload, but locked; clicking surfaces a
 * "locked" toast instead.
*/
function LockedToggleBlock({
  title,
  description,
  switchLabel,
  checked,
  onLocked,
}: {
  title: string;
  description: string;
  switchLabel: string;
  checked: boolean;
  onLocked: () => void;
}) {
  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 700, color: '#1e2536' }}>{title}</div>
      <p style={{ fontSize: 12, color: '#64748b', margin: '2px 0 10px' }}>{description}</p>
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 10, fontSize: 12, fontWeight: 600, color: '#475569' }}>
        <Toggle checked={checked} onChange={() => onLocked()} title="Built-in policy — locked" />
        {switchLabel}
      </label>
    </div>
  );
}

const cancelBtn: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  borderRadius: 8,
  padding: '7px 18px',
  cursor: 'pointer',
  fontFamily: 'inherit',
  background: '#fff',
  color: '#475569',
  border: '1px solid #dfe2ec',
};
