// Small shared building blocks for the Rightsizing page + drawer.
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import ClickAwayListener from '@mui/material/ClickAwayListener';
import { getJson } from '../../api/client';
import { DEFAULT_POLICY_NAMES, kindColor, policyPillColors } from './lib';
import type { PoliciesResponse } from './types';
import type { WorkloadRow } from './types';

/** Downscaler schedule policies (every-day-nights / weekend / …) are NOT
 * rightsize policies — exclude them from every rightsize-policy dropdown. */
export function isDownscalerScheduleName(name: string): boolean {
  return /night|weekend/i.test(name || '');
}

export function usePolicyNames(): string[] {
  const [names, setNames] = useState<string[]>(DEFAULT_POLICY_NAMES);
  useEffect(() => {
    let dead = false;
    getJson<PoliciesResponse>('/api/policies')
      .then((d) => {
        const n = (d.policies || []).map((p) => p.name).filter(Boolean);
        if (!dead && n.length) setNames(n);
      })
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, []);
  return names.filter((n) => !isDownscalerScheduleName(n));
}

/** reference-style slider toggle (.tog port). */
export function Toggle({
  checked,
  disabled,
  onChange,
  title,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (on: boolean) => void;
  title?: string;
}) {
  return (
    <label className="tog" title={title} onClick={(e) => e.stopPropagation()}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="sl" />
    </label>
  );
}

/** Policy-pill lasso icon (POLICY_ICON port). */
export function PolicyIcon() {
  return (
    <svg
      style={{ width: 12, height: 12, marginRight: 2, display: 'inline-block' }}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
    >
      <circle cx="8" cy="15" r="4" />
      <path d="M10.85 12.15L19 4M18 5l2 2M15 8l2 2" />
    </svg>
  );
}

/** Colored policy pill wrapper. */
export function PolicyPill({ policy, children }: { policy: string; children: ReactNode }) {
  const [bg, fg] = policyPillColors(policy);
  return (
    <span className="pill" style={{ background: bg, color: fg, fontWeight: 500 }}>
      <PolicyIcon />
      {children}
    </span>
  );
}

/** Kind icon (kindIcon port). */
export function KindIcon({ kind }: { kind: string }) {
  const c = kindColor(kind);
  return (
    <span
      style={{
        display: 'inline-grid',
        placeItems: 'center',
        height: 20,
        width: 20,
        borderRadius: 6,
        background: c + '1a',
        color: c,
        flexShrink: 0,
      }}
    >
      <svg style={{ width: 12, height: 12 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
        <rect x="4" y="4" width="16" height="16" rx="3" />
      </svg>
    </span>
  );
}

/** healthDot port — red OOM/crashloop, amber throttled/under-prov, green healthy. */
export function HealthDot({ w }: { w: WorkloadRow }) {
  const h = w.health || 'healthy';
  const m =
    (
      {
        critical: ['#f43f5e', 'OOM / CrashLoop — auto-healing would raise resources'],
        throttled: ['#f59e0b', 'CPU throttling / liveness pressure'],
        underprovisioned: ['#fbbf24', 'Under-provisioned — recommendation raises requests'],
        healthy: ['#34d399', 'Healthy'],
      } as Record<string, [string, string]>
    )[h] || (['#cbd5e1', ''] as [string, string]);
  return (
    <span
      title={m[1]}
      style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: m[0],
        marginRight: 6,
        flexShrink: 0,
      }}
    />
  );
}

/** Green ✓ dot for automated rows. */
export function AutomatedDot() {
  return (
    <span
      title="Automated — continuously right-sized"
      style={{
        display: 'inline-grid',
        placeItems: 'center',
        width: 14,
        height: 14,
        borderRadius: '50%',
        background: '#22c55e',
        color: '#fff',
        marginRight: 6,
        flexShrink: 0,
      }}
    >
      <svg style={{ width: 10, height: 10 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3.4}>
        <path d="M5 13l4 4L19 7" />
      </svg>
    </span>
  );
}

/**
 * reqCell port — "cur ⇒ rec" with colored arrow + absolute-delta badge.
 * automated rows pass (orig, cur) instead (reqCellWl behaviour is in the caller).
 */
export function ReqCell({
  cur,
  rec,
  fmt,
}: {
  cur?: number | null;
  rec?: number | null;
  fmt: (v?: number | null) => string;
}) {
  if (cur == null || rec == null) return <span style={{ color: '#94a3b8' }}>—</span>;
  const reduce = rec < cur * 0.97;
  const increase = rec > cur * 1.03;
  const color = reduce ? '#16a34a' : increase ? '#e11d48' : '#94a3b8';
  const arrow = reduce ? '↓' : increase ? '↑' : '→';
  const delta = Math.abs(cur - rec);
  return (
    <div>
      <span style={{ color: '#94a3b8' }}>{fmt(cur)}</span>
      <span style={{ color, fontWeight: 600, margin: '0 4px' }}>{arrow}</span>
      <span style={{ color, fontWeight: 600 }}>{fmt(rec)}</span>
      {(reduce || increase) && (
        <div
          style={{
            fontSize: 10,
            color: reduce ? '#16a34a' : '#f43f5e',
            fontWeight: 600,
            marginTop: 2,
          }}
        >
          {arrow} {fmt(delta)}
        </div>
      )}
    </div>
  );
}

/** Anchored dropdown panel: renders children absolutely under/over the trigger. */
export function Dropdown({
  open,
  onClose,
  children,
  style,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  style?: CSSProperties;
}) {
  if (!open) return null;
  return (
    <ClickAwayListener onClickAway={onClose}>
      <div
        style={{
          position: 'absolute',
          top: '100%',
          marginTop: 4,
          background: '#fff',
          borderRadius: 12,
          boxShadow: '0 20px 25px -5px rgba(0,0,0,.1),0 8px 10px -6px rgba(0,0,0,.1)',
          border: '1px solid #e9eaf0',
          zIndex: 40,
          textAlign: 'left',
          ...style,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </ClickAwayListener>
  );
}

export function MenuItem({
  label,
  onClick,
  enabled = true,
  title,
}: {
  label: ReactNode;
  onClick?: () => void;
  enabled?: boolean;
  title?: string;
}) {
  return (
    <button
      disabled={!enabled}
      title={title}
      onClick={enabled ? onClick : undefined}
      style={{
        width: '100%',
        textAlign: 'left',
        padding: '6px 12px',
        fontSize: 13,
        border: 'none',
        background: 'transparent',
        fontFamily: 'inherit',
        borderRadius: 8,
        color: enabled ? '#334155' : '#cbd5e1',
        cursor: enabled ? 'pointer' : 'not-allowed',
      }}
      onMouseEnter={(e) => enabled && (e.currentTarget.style.background = '#f8fafc')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      {label}
    </button>
  );
}
