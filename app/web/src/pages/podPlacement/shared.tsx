// Shared building blocks for the Pod Placement + Pod Scheduling pages.
import { useState, type CSSProperties, type ReactNode } from 'react';
import {
  Area,
  Bar,
  BarChart,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { timeFmt } from '../rightsizing/lib';
import { Dropdown, MenuItem } from '../rightsizing/ui';
import type { AnalyticsGraphResponse } from '../rightsizing/types';

export type GraphValues = NonNullable<AnalyticsGraphResponse['values']>;

export const cpuAxis = (v: number) => (v >= 1 ? String(Math.round(v * 10) / 10) : Math.round(v * 1000) + 'm');
export const memAxis = (v: number) => {
  const g = v / 2 ** 30;
  return g >= 1 ? Math.round(g * 10) / 10 + 'Gi' : Math.round(v / 2 ** 20) + 'Mi';
};
export const intAxis = (v: number) => String(Math.round(v));
export const dollarAxis = (v: number) => '$' + (v >= 1000 ? (v / 1000).toFixed(1) + 'k' : Math.round(v));

export function AutoDonut({
  auto,
  total,
  size = 72,
  label,
  legendRows,
  itemLabel = 'workloads',
}: {
  auto: number;
  total: number;
  size?: number;
  label?: boolean;
  legendRows?: boolean;
  itemLabel?: string;
}) {
  const pct = total ? auto / total : 0;
  const r = size / 2 - 6;
  const c = 2 * Math.PI * r;
  if (legendRows) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <AutoDonut auto={auto} total={total} size={Math.max(size, 88)} label />
        <div>
          <div className="num" style={{ fontSize: 20, fontWeight: 700, color: '#1e2536', lineHeight: 1.1 }}>{total}</div>
          <div style={{ fontSize: 12, color: '#64748b', marginBottom: 6 }}>{itemLabel}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#334155' }}>
            <span style={{ width: 8, height: 8, borderRadius: 99, background: '#22c55e', display: 'inline-block' }} />
            automated <b className="num">{auto}</b>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#64748b' }}>
            <span style={{ width: 8, height: 8, borderRadius: 99, background: '#dfe3ef', display: 'inline-block' }} />
            un-automated <b className="num">{Math.max(0, total - auto)}</b>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div style={{ position: 'relative', height: size, width: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#e7e9f0" strokeWidth={8} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="#22c55e"
          strokeWidth={8}
          strokeDasharray={`${c * pct} ${c * (1 - pct)}`}
          strokeDashoffset={c / 4}
        />
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', textAlign: 'center' }}>
        <div>
          <div className="num" style={{ fontSize: label ? 13 : 12, fontWeight: 700, color: '#16a34a', lineHeight: 1 }}>
            {total ? Math.round(pct * 100) : 0}%
          </div>
          {label && <div style={{ fontSize: 8, color: '#94a3b8' }}>automated</div>}
        </div>
      </div>
    </div>
  );
}

export function NodesBarChart({ current, optimized }: { current: number; optimized: number }) {
  const data = [{ name: 'Nodes', current, optimized }];
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
        <XAxis
          type="number"
          allowDecimals={false}
          tick={{ fontSize: 9, fill: '#aab' }}
          tickLine={false}
          axisLine={false}
          domain={[0, 'dataMax']}
        />
        <YAxis type="category" dataKey="name" tick={{ fontSize: 10, fill: '#aab' }} tickLine={false} axisLine={false} width={42} />
        <Tooltip
          formatter={(v: unknown, name: unknown) =>
            [String(v), name === 'current' ? 'Current nodes' : 'Optimized nodes'] as [string, string]
          }
          contentStyle={{ borderRadius: 8, border: '1px solid #e9eaf0', fontSize: 11 }}
          itemStyle={{ fontSize: 11, padding: 0 }}
          labelStyle={{ fontSize: 11 }}
        />
        <Legend
          wrapperStyle={{ fontSize: 10 }}
          iconSize={10}
          formatter={(v: string) => (
            <span style={{ color: '#475569' }}>{v === 'current' ? 'Current nodes' : 'Optimized nodes'}</span>
          )}
        />
        <Bar dataKey="current" fill="#c7d2fe" isAnimationActive={false} barSize={16} />
        <Bar dataKey="optimized" fill="#22c55e" isAnimationActive={false} barSize={16} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function TrendChart({
  values,
  dataKey,
  stroke,
  fill,
  fmt,
}: {
  values: GraphValues;
  dataKey: string;
  stroke: string;
  fill: string;
  fmt: (v: number) => string;
}) {
  const data = (values || []).map((p) => ({
    label: timeFmt(p.timestamp),
    v: p.values?.[dataKey] ?? null,
  }));
  return (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
        <XAxis dataKey="label" tick={{ fontSize: 9, fill: '#aab' }} tickLine={false} axisLine={false} minTickGap={60} />
        <YAxis tick={{ fontSize: 9, fill: '#aab' }} tickFormatter={fmt} tickLine={false} axisLine={false} width={44} />
        <Tooltip
          formatter={(v: unknown) => [typeof v === 'number' ? fmt(v) : '—', ''] as [string, string]}
          separator=""
          contentStyle={{ borderRadius: 8, border: '1px solid #e9eaf0', fontSize: 11 }}
          itemStyle={{ fontSize: 11, padding: 0 }}
          labelStyle={{ fontSize: 11 }}
        />
        <Area type="monotone" dataKey="v" stroke={stroke} strokeWidth={1.6} fill={fill} dot={false} isAnimationActive={false} connectNulls />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

export function AllocReqWasteChart({
  values,
  resource,
}: {
  values: GraphValues;
  resource: 'cpu' | 'memory';
}) {
  const fmt = resource === 'cpu' ? cpuAxis : memAxis;
  const data = (values || []).map((p) => {
    const a = p.values?.[resource + 'Allocatable'];
    const r = p.values?.[resource + 'Requests'];
    return {
      label: timeFmt(p.timestamp),
      alloc: a ?? null,
      req: r ?? null,
      waste: a != null && r != null ? Math.max(0, a - r) : null,
    };
  });
  const NAMES: Record<string, string> = { alloc: 'Allocatable', req: 'Requested', waste: 'Waste (alloc − request)' };
  return (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
        <XAxis dataKey="label" tick={{ fontSize: 9, fill: '#aab' }} tickLine={false} axisLine={false} minTickGap={60} />
        <YAxis tick={{ fontSize: 9, fill: '#aab' }} tickFormatter={fmt} tickLine={false} axisLine={false} width={44} />
        <Tooltip
          formatter={(v: unknown, name: unknown) =>
            [typeof v === 'number' ? fmt(v) : '—', NAMES[String(name)] || String(name)] as [string, string]
          }
          contentStyle={{ borderRadius: 8, border: '1px solid #e9eaf0', fontSize: 11 }}
          itemStyle={{ fontSize: 11, padding: 0 }}
          labelStyle={{ fontSize: 11 }}
        />
        <Area type="monotone" dataKey="waste" stroke="transparent" fill="rgba(244,63,94,.12)" dot={false} isAnimationActive={false} connectNulls />
        <Line type="monotone" dataKey="alloc" stroke="#f6a45c" strokeWidth={1.6} dot={false} isAnimationActive={false} connectNulls />
        <Line type="monotone" dataKey="req" stroke="#6366f1" strokeWidth={1.6} dot={false} isAnimationActive={false} connectNulls />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

/* ---------- illustration modal chrome (ppIllusModal / scIllusModal shell) ---------- */
export function IllusModal({
  open,
  onClose,
  description,
  beforeTitle,
  afterTitle,
  before,
  after,
  savings,
  automateDisabled,
  onAutomate,
}: {
  open: boolean;
  onClose: () => void;
  description: string;
  beforeTitle: ReactNode;
  afterTitle: ReactNode;
  before: ReactNode;
  after: ReactNode;
  savings: ReactNode;
  automateDisabled: boolean;
  onAutomate: () => void;
}) {
  if (!open) return null;
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        background: 'rgba(0,0,0,.4)',
        display: 'grid',
        placeItems: 'center',
        padding: 16,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div style={{ background: '#fff', borderRadius: 12, boxShadow: '0 25px 50px -12px rgba(0,0,0,.25)', width: '100%', maxWidth: 768, overflow: 'hidden' }}>
        <div style={{ background: '#1e2230', color: '#fff', padding: '12px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>Blocked Nodes Optimization</div>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', color: '#cbd5e1', fontSize: 20, lineHeight: 1, cursor: 'pointer', fontFamily: 'inherit' }}
          >
            ×
          </button>
        </div>
        <div style={{ padding: 20 }}>
          <p style={{ fontSize: 12, color: '#64748b', margin: '0 0 16px' }}>{description}</p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: 16, alignItems: 'center' }}>
            <div style={{ borderRadius: 12, border: '1px solid #fecdd3', background: 'rgba(255,241,242,.4)', padding: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#f43f5e', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 8 }}>
                {beforeTitle}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>{before}</div>
            </div>
            <div style={{ color: '#cbd5e1', fontSize: 24, textAlign: 'center' }}>⇒</div>
            <div style={{ borderRadius: 12, border: '1px solid #a7f3d0', background: 'rgba(236,253,245,.4)', padding: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#059669', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 8 }}>
                {afterTitle}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>{after}</div>
            </div>
          </div>
          <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ fontSize: 12, color: '#64748b' }}>
              Savings available <span className="num" style={{ color: '#16a34a', fontWeight: 700 }}>{savings}</span>/mo
            </div>
            <button
              disabled={automateDisabled}
              onClick={onAutomate}
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: '#fff',
                background: '#22c55e',
                border: 'none',
                borderRadius: 8,
                padding: '6px 16px',
                cursor: automateDisabled ? 'not-allowed' : 'pointer',
                opacity: automateDisabled ? 0.5 : 1,
                fontFamily: 'inherit',
              }}
            >
              Automate All
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** node box used inside the illustration modals */
export function IllusBox({
  variant,
  label,
  title,
}: {
  variant: 'freed' | 'blocked' | 'freeable' | 'ok';
  label: ReactNode;
  title?: string;
}) {
  const cls: Record<string, CSSProperties> = {
    freed: { border: '2px dashed #cbd5e1', background: '#f8fafc', color: '#cbd5e1' },
    blocked: { border: '2px solid #fcd34d', background: '#fffbeb', color: '#d97706' },
    freeable: { border: '2px solid #6ee7b7', background: '#ecfdf5', color: '#059669' },
    ok: { border: '2px solid #a5b4fc', background: '#eef2ff', color: '#4f46e5' },
  };
  return (
    <div
      title={title}
      style={{
        height: 48,
        width: 48,
        borderRadius: 8,
        display: 'grid',
        placeItems: 'center',
        fontSize: 9,
        fontWeight: 700,
        ...cls[variant],
      }}
    >
      {label}
    </div>
  );
}

/* ---------- misc small styles ---------- */
export const cardStyle: CSSProperties = {
  background: '#fff',
  border: '1px solid #e9eaf0',
  borderRadius: 16,
  boxShadow: '0 1px 2px rgba(16,24,40,.05), 0 1px 3px rgba(16,24,40,.04)',
};

export const thStyle: CSSProperties = {
  textAlign: 'left',
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: '.04em',
  color: '#94a3b8',
  fontWeight: 600,
  padding: '10px 12px',
  borderBottom: '1px solid #eef0f6',
  whiteSpace: 'nowrap',
};

export function GoodButton({
  children,
  disabled,
  onClick,
  style,
}: {
  children: ReactNode;
  disabled?: boolean;
  onClick: () => void;
  style?: CSSProperties;
}) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      style={{
        fontSize: 12,
        fontWeight: 600,
        color: '#fff',
        background: '#22c55e',
        border: 'none',
        borderRadius: 8,
        padding: '6px 12px',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        fontFamily: 'inherit',
        ...style,
      }}
      onMouseEnter={(e) => !disabled && (e.currentTarget.style.background = '#16a34a')}
      onMouseLeave={(e) => (e.currentTarget.style.background = '#22c55e')}
    >
      {children}
    </button>
  );
}

/** indigo primary action button */
export function IndigoButton({
  children,
  onClick,
  style,
}: {
  children: ReactNode;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  style?: CSSProperties;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        fontSize: 13,
        fontWeight: 600,
        color: '#fff',
        background: '#6366f1',
        border: 'none',
        borderRadius: 8,
        padding: '6px 12px',
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontFamily: 'inherit',
        ...style,
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = '#4f46e5')}
      onMouseLeave={(e) => (e.currentTarget.style.background = '#6366f1')}
    >
      {children}
    </button>
  );
}

/** outline indigo button (Unevictable / Optimization Illustration) */
export function IllusButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        fontSize: 12,
        fontWeight: 600,
        color: '#4f46e5',
        border: '1px solid #c7d2fe',
        background: 'transparent',
        borderRadius: 8,
        padding: '4px 12px',
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontFamily: 'inherit',
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = '#eef2ff')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      <svg style={{ width: 14, height: 14 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <rect x="14" y="14" width="7" height="7" rx="1" />
      </svg>
      {children}
    </button>
  );
}

/* Pill-styled filter dropdown. */
export function FilterChipSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  /** [value, displayLabel] pairs; '' = all. */
  options: [string, string][];
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const cur = options.find(([v]) => v !== '' && v === value);
  return (
    <div style={{ position: 'relative' }}>
      <span className={'chip' + (cur ? ' on' : '')} onClick={() => setOpen((o) => !o)}>
        {cur ? `${label}: ${cur[1]}` : label}{' '}
        {cur ? (
          <span
            onClick={(e) => {
              e.stopPropagation();
              onChange('');
              setOpen(false);
            }}
            style={{ marginLeft: 4, fontWeight: 700, cursor: 'pointer' }}
          >
            ✕
          </span>
        ) : (
          <span style={{ marginLeft: 2 }}>▾</span>
        )}
      </span>
      <Dropdown open={open} onClose={() => setOpen(false)} style={{ left: 0, minWidth: 176, maxHeight: 280, overflowY: 'auto', padding: 6 }}>
        <MenuItem
          label={<span style={{ color: '#94a3b8' }}>all</span>}
          onClick={() => {
            onChange('');
            setOpen(false);
          }}
        />
        {options
          .filter(([v]) => v !== '')
          .map(([v, l]) => (
            <MenuItem
              key={v}
              label={v === value ? <b>{l}</b> : l}
              onClick={() => {
                onChange(v);
                setOpen(false);
              }}
            />
          ))}
      </Dropdown>
    </div>
  );
}

/** reason pill (PP_REASON_PILL port) */
const REASON_PILL: Record<string, [string, string]> = {
  PDB: ['#f5f3ff', '#7c3aed'],
  annotation: ['#f5f3ff', '#7c3aed'],
  'local storage': ['#f0f9ff', '#0284c7'],
  'kube-system': ['#f1f5f9', '#64748b'],
  'un-ready': ['#fff1f2', '#e11d48'],
  ownerless: ['#fdf2f8', '#db2777'],
};
export function ReasonPill({ reason }: { reason: string }) {
  const [bg, fg] = REASON_PILL[reason] || ['#f1f5f9', '#64748b'];
  return (
    <span className="pill" style={{ background: bg, color: fg }}>
      {reason}
    </span>
  );
}
