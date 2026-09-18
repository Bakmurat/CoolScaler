// Formik-bound controls for the Policy editor drawer
import { createContext, useContext, type ReactNode } from 'react';
import { getIn, useFormikContext } from 'formik';
import { DAYS_OPTS, type Opt } from './model';

export const EditorReadOnlyCtx = createContext(false);
export const useEditorRO = () => useContext(EditorReadOnlyCtx);

export const selStyle: React.CSSProperties = {
  background: '#f4f5f8',
  border: '1px solid #e9eaf0',
  borderRadius: 8,
  padding: '4px 8px',
  fontSize: 12,
  outline: 'none',
  fontFamily: 'inherit',
  width: '100%',
  boxSizing: 'border-box',
  color: '#1e2536',
};

export function PSelect({
  label,
  name,
  opts,
  kind,
}: {
  label: string;
  name: string;
  opts: Opt[];
  kind?: 'str' | 'num' | 'bool';
}) {
  const ro = useEditorRO();
  const { values, setFieldValue } = useFormikContext<Record<string, unknown>>();
  const cur = getIn(values, name);
  return (
    <div>
      <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>{label}</div>
      <select
        disabled={ro}
        value={cur == null ? '' : String(cur)}
        onChange={(e) => {
          const v = e.target.value;
          void setFieldValue(name, kind === 'num' ? (v === '' ? null : Number(v)) : kind === 'bool' ? v === 'true' : v);
        }}
        style={{ ...selStyle, cursor: ro ? 'not-allowed' : 'pointer' }}
      >
        {opts.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function PNum({
  label,
  name,
  ph,
  suffix,
  kind,
}: {
  label: string;
  name: string;
  ph?: string;
  suffix?: string;
  kind?: 'str' | 'num';
}) {
  const ro = useEditorRO();
  const { values, setFieldValue } = useFormikContext<Record<string, unknown>>();
  const cur = getIn(values, name);
  return (
    <div>
      <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>
        {label}
        {suffix && <span style={{ fontSize: 11, color: '#94a3b8', marginLeft: 4 }}>{suffix}</span>}
      </div>
      <input
        disabled={ro}
        defaultValue={cur == null ? '' : String(cur)}
        placeholder={ph}
        onBlur={(e) => {
          const v = e.target.value;
          void setFieldValue(name, kind === 'num' ? (v === '' ? null : Number(v)) : v);
        }}
        style={{ ...selStyle, cursor: 'text' }}
      />
    </div>
  );
}

export function PToggle({ label, name, desc }: { label: string; name: string; desc?: string }) {
  const ro = useEditorRO();
  const { values, setFieldValue } = useFormikContext<Record<string, unknown>>();
  const on = !!getIn(values, name);
  return (
    <div style={{ padding: '10px 0', borderBottom: '1px solid #f4f5f8' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#1e2536' }}>{label}</div>
          {desc && (
            <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2, maxWidth: 560 }}>{desc}</div>
          )}
        </div>
        <label className="tog" style={{ marginTop: 2 }}>
          <input
            type="checkbox"
            checked={on}
            disabled={ro}
            onChange={(e) => void setFieldValue(name, e.target.checked)}
          />
          <span className="sl" />
        </label>
      </div>
    </div>
  );
}

export function PSection({ title, sub }: { title: string; sub?: string }) {
  return (
    <div style={{ paddingTop: 8 }}>
      <div style={{ fontSize: 15, fontWeight: 700, color: '#1e2536' }}>{title}</div>
      {sub && <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

export function SubHead({ title, sub }: { title: string; sub?: string }) {
  return (
    <>
      <div style={{ fontSize: 13, fontWeight: 700, color: '#1e2536', paddingTop: 4 }}>{title}</div>
      {sub && <div style={{ fontSize: 12, color: '#64748b' }}>{sub}</div>}
    </>
  );
}

export function G2({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 12 }}>
      {children}
    </div>
  );
}

export function HRule() {
  return <div style={{ borderTop: '1px solid #eef0f6', margin: '4px 0' }} />;
}

export function DaysPicker({ name }: { name: string }) {
  const ro = useEditorRO();
  const { values, setFieldValue } = useFormikContext<Record<string, unknown>>();
  const cur: number[] = (getIn(values, name) as number[]) || [];
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {DAYS_OPTS.map((d) => {
        const on = cur.indexOf(d.value as number) >= 0;
        return (
          <button
            key={d.label}
            disabled={ro}
            onClick={() => {
              const a = cur.slice();
              const i = a.indexOf(d.value as number);
              if (i >= 0) a.splice(i, 1);
              else a.push(d.value as number);
              a.sort((x, y) => x - y);
              void setFieldValue(name, a);
            }}
            style={{
              padding: '4px 10px',
              borderRadius: 8,
              fontSize: 12,
              fontWeight: 600,
              fontFamily: 'inherit',
              cursor: ro ? 'not-allowed' : 'pointer',
              border: on ? '1px solid #6366f1' : '1px solid #e3e5ee',
              background: on ? '#6366f1' : '#fff',
              color: on ? '#fff' : '#64748b',
            }}
          >
            {d.label}
          </button>
        );
      })}
    </div>
  );
}
