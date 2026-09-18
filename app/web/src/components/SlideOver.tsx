import { useEffect, useState, type ReactNode } from 'react';

/* Right slide-over drawer chrome: dim backdrop + panel translating in from the right. */
export default function SlideOver({
  open,
  onClose,
  maxWidth,
  children,
  panelStyle,
}: {
  open: boolean;
  onClose: () => void;
  maxWidth: number;
  children: ReactNode;
  panelStyle?: React.CSSProperties;
}) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (open) {
      const t = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(t);
    }
    setShown(false);
  }, [open]);
  if (!open) return null;
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1300 }}>
      <div
        onClick={onClose}
        style={{
          position: 'absolute',
          inset: 0,
          background: 'rgba(26,32,54,.3)',
          backdropFilter: 'blur(1px)',
          opacity: shown ? 1 : 0,
          transition: 'opacity .3s',
        }}
      />
      <aside
        role="dialog"
        aria-modal="true"
        style={{
          position: 'absolute',
          right: 0,
          top: 0,
          height: '100%',
          width: '100%',
          maxWidth,
          background: '#fff',
          boxShadow: '0 25px 50px -12px rgba(0,0,0,.25)',
          transform: shown ? 'translateX(0)' : 'translateX(100%)',
          transition: 'transform .3s ease-out',
          display: 'flex',
          flexDirection: 'column',
          ...panelStyle,
        }}
      >
        {children}
      </aside>
    </div>
  );
}

export function DrawerHeader({
  dark,
  left,
  right,
}: {
  dark?: boolean;
  left: ReactNode;
  right: ReactNode;
}) {
  return (
    <div
      style={{
        background: dark ? '#1e2230' : '#4b4f5e',
        color: '#fff',
        padding: '12px 20px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexShrink: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', fontSize: 15, fontWeight: 600, minWidth: 0 }}>
        {left}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>{right}</div>
    </div>
  );
}

/** White-on-dark pill button used in drawer headers ("Save" / "Duplicate to edit"). */
export function HeaderBtn({
  onClick,
  children,
  outline,
}: {
  onClick: () => void;
  children: ReactNode;
  outline?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '6px 16px',
        fontSize: 13,
        fontWeight: 600,
        borderRadius: 8,
        fontFamily: 'inherit',
        cursor: 'pointer',
        ...(outline
          ? { border: '1px solid rgba(255,255,255,.3)', color: '#fff', background: 'transparent' }
          : { border: 'none', background: '#fff', color: '#1e2536' }),
      }}
    >
      {children}
    </button>
  );
}
