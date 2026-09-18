import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

// Exposed as a hook via provider so any page can `const prompt = usePrompt(); const
// name = await prompt('Title','Label','def')`.

type PromptFn = (title: string, label: string, def?: string) => Promise<string | null>;

const PromptContext = createContext<PromptFn>(async () => null);
export const usePrompt = () => useContext(PromptContext);

interface PState {
  title: string;
  label: string;
  value: string;
  resolve: (v: string | null) => void;
}

const SEL: React.CSSProperties = {
  background: '#fff',
  border: '1px solid #dfe2ec',
  borderRadius: 8,
  padding: '6px 10px',
  fontSize: 13,
  width: '100%',
  outline: 'none',
  fontFamily: 'inherit',
  boxSizing: 'border-box',
};

export default function PromptProvider({ children }: { children: ReactNode }) {
  const [st, setSt] = useState<PState | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const prompt = useCallback<PromptFn>(
    (title, label, def) =>
      new Promise<string | null>((resolve) => {
        setSt({ title, label, value: def || '', resolve });
        setTimeout(() => {
          inputRef.current?.focus();
          inputRef.current?.select();
        }, 0);
      }),
    [],
  );

  const done = (ok: boolean) => {
    if (!st) return;
    st.resolve(ok ? st.value.trim() : null);
    setSt(null);
  };

  return (
    <PromptContext.Provider value={prompt}>
      {children}
      {st && (
        <div
          onClick={(e) => {
            if (e.target === e.currentTarget) done(false);
          }}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1600,
            display: 'grid',
            placeItems: 'center',
            background: 'rgba(26,32,54,.35)',
            backdropFilter: 'blur(1px)',
          }}
        >
          <div
            style={{
              background: '#fff',
              borderRadius: 12,
              boxShadow: '0 25px 50px -12px rgba(0,0,0,.25)',
              border: '1px solid #e9eaf0',
              padding: 20,
              width: 420,
              margin: '0 16px',
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 700, color: '#1e2536', marginBottom: 8 }}>{st.title}</div>
            <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>{st.label}</div>
            <input
              ref={inputRef}
              value={st.value}
              onChange={(e) => setSt({ ...st, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') done(true);
                if (e.key === 'Escape') done(false);
              }}
              style={{ ...SEL, marginBottom: 16 }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                onClick={() => done(false)}
                style={{
                  padding: '6px 12px',
                  fontSize: 13,
                  fontWeight: 600,
                  borderRadius: 8,
                  border: '1px solid #e3e5ee',
                  color: '#475569',
                  background: '#fff',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => done(true)}
                style={{
                  padding: '6px 12px',
                  fontSize: 13,
                  fontWeight: 600,
                  borderRadius: 8,
                  border: 'none',
                  background: '#6366f1',
                  color: '#fff',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}
    </PromptContext.Provider>
  );
}
