import { useEffect, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import InputBase from '@mui/material/InputBase';
import { cardSx } from './shared';
import { getJson } from '../../api/client';
import type { AlertItem, AlertsResponse } from '../../api/types';

// Full "Reliability Risks" view (View all)

const SEV_PILL: Record<string, { bg: string; color: string }> = {
  critical: { bg: '#fff1f2', color: '#e11d48' },
  warning: { bg: '#fffbeb', color: '#d97706' },
  info: { bg: '#f0f9ff', color: '#0284c7' },
};

export default function ReliabilityView() {
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [q, setQ] = useState('');
  const [sev, setSev] = useState('');

  useEffect(() => {
    let cancelled = false;
    getJson<AlertsResponse>('/api/alerts')
      .then((d) => !cancelled && setAlerts(d.alerts ?? []))
      .catch(() => !cancelled && setAlerts([]));
    return () => {
      cancelled = true;
    };
  }, []);

  const rows = useMemo(() => {
    const f = q.toLowerCase();
    return alerts.filter(
      (a) =>
        (!sev || a.severity === sev) &&
        (!f ||
          ((a.type || '') + (a.message || '') + (a.workload || '')).toLowerCase().includes(f)),
    );
  }, [alerts, q, sev]);

  const inputSx = {
    background: '#f4f5f8',
    border: '1px solid #e9eaf0',
    borderRadius: '8px',
    px: '12px',
    py: '2px',
    fontSize: 14,
    '&.Mui-focused': { borderColor: '#a5b4fc' },
  };

  return (
    <Box component="main" sx={{ p: '20px', display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Box sx={{ ...cardSx, p: 2, display: 'flex', alignItems: 'center', gap: '12px' }}>
        <Box
          sx={{
            height: 36,
            width: 36,
            borderRadius: '8px',
            background: '#fff1f2',
            display: 'grid',
            placeItems: 'center',
          }}
        >
          <svg
            style={{ width: 20, height: 20, color: '#f43f5e' }}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path d="M12 9v4M12 17h.01M10.3 3.9L2.4 18a2 2 0 001.7 3h15.8a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z" />
          </svg>
        </Box>
        <Box component="h1" sx={{ m: 0, fontSize: 17, fontWeight: 700, color: '#1e2536' }}>
          Reliability Risks
        </Box>
      </Box>

      <Box sx={{ ...cardSx, p: 0, overflow: 'hidden' }}>
        <Box
          sx={{
            px: '20px',
            py: '12px',
            borderBottom: '1px solid #eef0f6',
            display: 'flex',
            alignItems: 'center',
            gap: 1,
          }}
        >
          <InputBase
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="search…"
            sx={{ ...inputSx, width: 224 }}
          />
          <Box
            component="select"
            value={sev}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setSev(e.target.value)}
            sx={{
              background: '#f4f5f8',
              border: '1px solid #e9eaf0',
              borderRadius: '8px',
              px: '12px',
              py: '7px',
              fontSize: 14,
              outline: 'none',
              fontFamily: 'inherit',
              color: '#1e2536',
            }}
          >
            <option value="">all severities</option>
            <option value="critical">critical</option>
            <option value="warning">warning</option>
            <option value="info">info</option>
          </Box>
        </Box>

        <Box>
          {rows.length === 0 ? (
            <Box sx={{ py: 8, textAlign: 'center' }}>
              <Box
                sx={{
                  height: 48,
                  width: 48,
                  borderRadius: '50%',
                  background: '#f0fdf4',
                  display: 'grid',
                  placeItems: 'center',
                  mx: 'auto',
                  mb: 1,
                }}
              >
                <svg
                  style={{ width: 24, height: 24, color: '#16a34a' }}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2.2}
                >
                  <path d="M5 13l4 4L19 7" />
                </svg>
              </Box>
              <Box sx={{ fontSize: 14, color: '#16a34a' }}>
                All systems healthy, no insights available.
              </Box>
            </Box>
          ) : (
            rows.map((a, i) => {
              const s = SEV_PILL[a.severity] ?? { bg: '#f1f5f9', color: '#64748b' };
              return (
                <Box
                  key={i}
                  sx={{
                    px: '20px',
                    py: '12px',
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '12px',
                    borderBottom: '1px solid #f1f2f7',
                    '&:last-of-type': { borderBottom: 'none' },
                  }}
                >
                  <Box
                    component="span"
                    sx={{
                      fontSize: 11,
                      fontWeight: 600,
                      px: '9px',
                      py: '2px',
                      borderRadius: 999,
                      whiteSpace: 'nowrap',
                      mt: '2px',
                      background: s.bg,
                      color: s.color,
                    }}
                  >
                    {a.severity || 'info'}
                  </Box>
                  <Box>
                    <Box sx={{ fontWeight: 600, color: '#1e2536', fontSize: 13 }}>
                      {a.type || 'Alert'}
                    </Box>
                    <Box sx={{ fontSize: 12, color: '#64748b' }}>{a.message || a.workload || ''}</Box>
                  </Box>
                </Box>
              );
            })
          )}
        </Box>
      </Box>

      <Box
        component="footer"
        sx={{ textAlign: 'center', fontSize: 12, color: '#94a3b8', pt: 1, pb: 3 }}
      >
        CoolScaler · Reliability insights · live from the alerting engine
      </Box>
    </Box>
  );
}
