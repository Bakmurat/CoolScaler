import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';

// NEVER window.alert/confirm — they freeze the page and break Chrome
// automation.

export type ToastType = 'ok' | 'warn' | 'error';

interface ToastItem {
  id: number;
  msg: string;
  type: ToastType;
  leaving: boolean;
}

interface ConfirmState {
  msg: string;
  resolve: (v: boolean) => void;
}

interface FeedbackApi {
  toast: (msg: string, type?: ToastType) => void;
  confirm: (msg: string) => Promise<boolean>;
}

const FeedbackContext = createContext<FeedbackApi>({
  toast: () => {},
  confirm: async () => false,
});

export const useFeedback = () => useContext(FeedbackContext);

const TOAST_STYLES: Record<ToastType, { border: string; bg: string; color: string }> = {
  error: { border: '#fecdd3', bg: '#fff1f2', color: '#be123c' },
  warn: { border: '#fde68a', bg: '#fffbeb', color: '#b45309' },
  ok: { border: '#a7f3d0', bg: '#ffffff', color: '#334155' },
};

let nextId = 1;

export default function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const timers = useRef<number[]>([]);

  useEffect(
    () => () => {
      timers.current.forEach((t) => window.clearTimeout(t));
    },
    [],
  );

  const toast = useCallback((msg: string, type?: ToastType) => {
    let t = type;
    if (t == null) {
      const low = (msg || '').toLowerCase();
      t = /(could not|fail|error|read-only)/.test(low)
        ? 'error'
        : /select|first/.test(low)
          ? 'warn'
          : 'ok';
    }
    const id = nextId++;
    setToasts((prev) => [...prev, { id, msg, type: t!, leaving: false }]);
    timers.current.push(
      window.setTimeout(() => {
        setToasts((prev) => prev.map((x) => (x.id === id ? { ...x, leaving: true } : x)));
        timers.current.push(
          window.setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== id)), 350),
        );
      }, 4500),
    );
  }, []);

  const confirm = useCallback(
    (msg: string) =>
      new Promise<boolean>((resolve) => {
        setConfirmState({ msg, resolve });
      }),
    [],
  );

  const settleConfirm = (v: boolean) => {
    confirmState?.resolve(v);
    setConfirmState(null);
  };

  return (
    <FeedbackContext.Provider value={{ toast, confirm }}>
      {children}

      <Box
        sx={{
          position: 'fixed',
          bottom: 16,
          right: 16,
          zIndex: 1400,
          display: 'flex',
          flexDirection: 'column',
          gap: 1,
          maxWidth: 448,
        }}
      >
        {toasts.map((t) => {
          const s = TOAST_STYLES[t.type];
          return (
            <Box
              key={t.id}
              sx={{
                borderRadius: '8px',
                border: `1px solid ${s.border}`,
                background: s.bg,
                color: s.color,
                boxShadow: '0 10px 15px -3px rgba(0,0,0,.1),0 4px 6px -4px rgba(0,0,0,.1)',
                px: '16px',
                py: '10px',
                fontSize: 13,
                whiteSpace: 'pre-line',
                transition: 'all .3s',
                opacity: t.leaving ? 0 : 1,
                transform: t.leaving ? 'translateY(4px)' : 'none',
              }}
            >
              {t.msg}
            </Box>
          );
        })}
      </Box>

      {/* promise-based confirm modal (replaces native confirm) */}
      {confirmState && (
        <Box
          onClick={(e) => {
            if (e.target === e.currentTarget) settleConfirm(false);
          }}
          sx={{
            position: 'fixed',
            inset: 0,
            zIndex: 1500,
            display: 'grid',
            placeItems: 'center',
            background: 'rgba(26,32,54,.35)',
            backdropFilter: 'blur(1px)',
          }}
        >
          <Box
            sx={{
              background: '#fff',
              borderRadius: '12px',
              boxShadow: '0 25px 50px -12px rgba(0,0,0,.25)',
              border: '1px solid #e9eaf0',
              p: '20px',
              maxWidth: 448,
              mx: 2,
            }}
          >
            <Box sx={{ fontSize: 14, color: '#334155', whiteSpace: 'pre-line', mb: 2 }}>
              {confirmState.msg}
            </Box>
            <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1 }}>
              <Button
                onClick={() => settleConfirm(false)}
                sx={{
                  px: '12px',
                  py: '6px',
                  fontSize: 13,
                  fontWeight: 600,
                  borderRadius: '8px',
                  border: '1px solid #e3e5ee',
                  color: '#475569',
                  '&:hover': { background: '#f8fafc' },
                }}
              >
                Cancel
              </Button>
              <Button
                onClick={() => settleConfirm(true)}
                sx={{
                  px: '12px',
                  py: '6px',
                  fontSize: 13,
                  fontWeight: 600,
                  borderRadius: '8px',
                  background: '#6366f1',
                  color: '#fff',
                  '&:hover': { background: '#4f46e5' },
                }}
              >
                Confirm
              </Button>
            </Box>
          </Box>
        </Box>
      )}
    </FeedbackContext.Provider>
  );
}
