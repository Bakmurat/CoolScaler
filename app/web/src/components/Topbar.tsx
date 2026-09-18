import { useState } from 'react';
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import ClickAwayListener from '@mui/material/ClickAwayListener';
import InputBase from '@mui/material/InputBase';
import { useNavigate } from 'react-router-dom';
import { palette } from '../theme';
import { getJson } from '../api/client';
import type { HealthResponse } from '../api/types';
import { useGlobalSearchString } from '../hooks/useUrlState';
import { useClusterData, automationCounts } from '../providers/ClusterDataProvider';
import { useFeedback } from '../providers/FeedbackProvider';
import { useOverviewNav } from '../pages/overview/subview';

// Top bar shared by all views

const border = '1px solid #c9cddc';
const numFont = '"JetBrains Mono",ui-monospace,monospace';

export default function Topbar() {
  const navigate = useNavigate();
  const search = useGlobalSearchString();
  const { overview } = useClusterData();
  const { toast } = useFeedback();
  const overviewNav = useOverviewNav();
  const [adoptOpen, setAdoptOpen] = useState(false);

  const clusterName = overview?.clusterName || 'example-cluster';
  const { pct: adoptPct } = automationCounts(overview);
  const adoptLabel = adoptPct >= 100 ? 'Fully adopted' : 'Adoption';

  // Health check — the button is a plain LINK to the built-in
  // "CoolScaler Health" insight dashboard; the live
  // /api/health probe stays as a toast only when something is degraded.
  const runHealthCheck = async () => {
    try {
      const h = await getJson<HealthResponse>('/api/health');
      if (!h.healthy) {
        const bad = (h.components ?? []).filter((c) => !c.healthy).map((c) => c.component);
        toast('Health check failed:\n' + (bad.length ? bad.join(', ') : 'degraded components'));
      }
    } catch {
      toast('Health check failed: API unreachable.');
    }
    const sp = new URLSearchParams(search);
    sp.set('dashboard', 'CoolScaler Health');
    navigate({ pathname: '/troubleshoot', search: '?' + sp.toString() });
  };

  return (
    <Box
      component="header"
      sx={{
        background: '#fff',
        borderBottom: `1px solid ${palette.line}`,
        px: '20px',
        height: 56,
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        position: 'sticky',
        top: 0,
        zIndex: 20,
      }}
    >
      {/* multi-cluster launcher icon */}
      <ButtonBase
        onClick={() => overviewNav('core')}
        title="Multi-cluster view"
        sx={{
          height: 36,
          width: 36,
          flexShrink: 0,
          display: 'grid',
          placeItems: 'center',
          border: '1px solid #e3e5ee',
          borderRadius: '50%',
          color: '#6366f1',
          '&:hover': { background: palette.brand50 },
        }}
      >
        <svg
          style={{ width: 18, height: 18 }}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
        >
          <circle cx="12" cy="12" r="2.5" />
          <path d="M12 2v4M12 18v4M2 12h4M18 12h4M5 5l2.5 2.5M16.5 16.5L19 19M19 5l-2.5 2.5M7.5 16.5L5 19" />
        </svg>
      </ButtonBase>

      {/* cluster dropdown (display only) */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          fontSize: 14,
          color: palette.inkStrong,
          border,
          borderRadius: '6px',
          px: '12px',
          py: '6px',
          background: '#fff',
          minWidth: 230,
          cursor: 'default',
        }}
      >
        <Box component="span" sx={{ fontWeight: 700 }}>
          cluster:
        </Box>
        <Box component="span" sx={{ fontWeight: 500 }}>
          {clusterName}
        </Box>
        <svg
          style={{ width: 14, height: 14, color: '#64748b', marginLeft: 'auto' }}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </Box>

      <ButtonBase
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          fontSize: 14,
          fontWeight: 500,
          fontFamily: 'inherit',
          color: palette.inkStrong,
          border,
          borderRadius: '6px',
          px: '12px',
          py: '6px',
          '&:hover': { background: '#f8fafc' },
        }}
      >
        <svg
          style={{ width: 16, height: 16 }}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8v8M8 12h8" />
        </svg>
        Add Cluster
      </ButtonBase>

      <Box sx={{ height: 28, width: '1px', background: '#e3e5ee', mx: '2px' }} />

      <ButtonBase
        onClick={runHealthCheck}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          fontSize: 14,
          fontWeight: 600,
          fontFamily: 'inherit',
          color: palette.good600,
          border: '1px solid #6ee7b7',
          borderRadius: '6px',
          px: '12px',
          py: '6px',
          '&:hover': { background: '#ecfdf5' },
        }}
      >
        <svg style={{ width: 16, height: 16 }} viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
        </svg>
        Health check
      </ButtonBase>

      <Box sx={{ flex: 1 }} />

      {/* adoption progress pill + popover */}
      <ClickAwayListener onClickAway={() => setAdoptOpen(false)}>
        <Box sx={{ position: 'relative' }}>
          <ButtonBase
            onClick={() => setAdoptOpen((o) => !o)}
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              fontSize: 14,
              fontWeight: 600,
              fontFamily: 'inherit',
              color: palette.good600,
              background: '#ecfdf5',
              border: '1px solid #d1fae5',
              borderRadius: 999,
              px: '14px',
              py: '6px',
              '&:hover': { background: '#d1fae5' },
            }}
          >
            <svg
              style={{ width: 16, height: 16 }}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.8}
            >
              <circle cx="12" cy="12" r="9" />
              <path d="M10 8.5l5 3.5-5 3.5z" fill="currentColor" stroke="none" />
            </svg>
            <span>{adoptLabel}</span>
            <Box component="span" sx={{ fontWeight: 700, fontFamily: numFont }}>
              {adoptPct}%
            </Box>
            <svg
              style={{ width: 14, height: 14 }}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2.2}
            >
              <path d="M9 6l6 6-6 6" />
            </svg>
          </ButtonBase>

          {adoptOpen && (
            <Box
              sx={{
                position: 'absolute',
                right: 0,
                top: '100%',
                mt: 1,
                width: 430,
                background: '#fff',
                borderRadius: '16px',
                boxShadow: '0 25px 50px -12px rgba(0,0,0,.25)',
                border: `1px solid ${palette.line}`,
                p: '20px',
                zIndex: 40,
                textAlign: 'left',
              }}
            >
              <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
                <Box
                  sx={{
                    height: 36,
                    width: 36,
                    borderRadius: '8px',
                    background: '#ecfdf5',
                    display: 'grid',
                    placeItems: 'center',
                    flexShrink: 0,
                  }}
                >
                  <svg
                    style={{ width: 20, height: 20, color: palette.good600 }}
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.8}
                  >
                    <circle cx="12" cy="12" r="9" />
                    <path d="M10 8.5l5 3.5-5 3.5z" fill="currentColor" stroke="none" />
                  </svg>
                </Box>
                <Box>
                  <Box sx={{ fontWeight: 700, color: palette.good600, fontSize: 15 }}>
                    CoolScaler Adoption Progress
                  </Box>
                  <Box sx={{ fontSize: 12, color: '#64748b', mt: '2px' }}>
                    Complete full adoption to optimize savings and performance
                  </Box>
                </Box>
              </Box>
              <Box sx={{ mt: 2, display: 'flex', alignItems: 'center', gap: '12px' }}>
                <Box
                  sx={{
                    flex: 1,
                    height: 8,
                    background: '#eef0f6',
                    borderRadius: 999,
                    overflow: 'hidden',
                  }}
                >
                  <Box
                    sx={{
                      height: 8,
                      background: palette.good,
                      borderRadius: 999,
                      transition: 'width .3s',
                      width: `${adoptPct}%`,
                    }}
                  />
                </Box>
                <Box
                  component="span"
                  sx={{ fontSize: 13, fontWeight: 700, color: palette.good600, fontFamily: numFont }}
                >
                  {adoptPct}%
                </Box>
              </Box>
              <ButtonBase
                onClick={() => {
                  setAdoptOpen(false);
                  overviewNav('recactions');
                }}
                sx={{
                  mt: 2,
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '4px',
                  background: palette.good,
                  color: '#fff',
                  fontWeight: 700,
                  fontFamily: 'inherit',
                  borderRadius: '12px',
                  py: '10px',
                  fontSize: 14,
                  '&:hover': { background: palette.good600 },
                }}
              >
                View Recommended Actions
                <svg
                  style={{ width: 16, height: 16 }}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2.4}
                >
                  <path d="M9 6l6 6-6 6" />
                </svg>
              </ButtonBase>
            </Box>
          )}
        </Box>
      </ClickAwayListener>

      <Box sx={{ position: 'relative' }}>
        <svg
          style={{
            width: 16,
            height: 16,
            color: '#94a3b8',
            position: 'absolute',
            left: 12,
            top: '50%',
            transform: 'translateY(-50%)',
          }}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
        >
          <circle cx="11" cy="11" r="7" />
          <path d="M21 21l-4-4" />
        </svg>
        <InputBase
          placeholder="search…"
          sx={{
            background: '#fff',
            border: '1px solid #e3e5ee',
            borderRadius: 999,
            pl: '36px',
            pr: '48px',
            py: '2px',
            fontSize: 14,
            width: 208,
            '&.Mui-focused': { borderColor: '#a5b4fc' },
          }}
        />
        <Box
          component="span"
          sx={{
            position: 'absolute',
            right: 10,
            top: '50%',
            transform: 'translateY(-50%)',
            fontSize: 10,
            fontWeight: 600,
            color: '#94a3b8',
            border: '1px solid #e2e8f0',
            borderRadius: '4px',
            px: '4px',
          }}
        >
          ⌘K
        </Box>
      </Box>

      <ButtonBase
        title="Settings"
        onClick={() => navigate({ pathname: '/settings', search })}
        sx={{
          height: 32,
          width: 32,
          display: 'grid',
          placeItems: 'center',
          borderRadius: '8px',
          color: '#64748b',
          '&:hover': { background: '#f1f5f9' },
        }}
      >
        <svg
          style={{ width: 20, height: 20 }}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.7}
        >
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </ButtonBase>

      <ButtonBase
        title="Audit & alerts"
        onClick={() => navigate({ pathname: '/alerts', search })}
        sx={{
          height: 32,
          width: 32,
          display: 'grid',
          placeItems: 'center',
          borderRadius: '8px',
          color: '#64748b',
          '&:hover': { background: '#f1f5f9' },
        }}
      >
        <svg
          style={{ width: 20, height: 20 }}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.7}
        >
          <path d="M7 3h7l5 5v13H7z" />
          <path d="M14 3v5h5M10 13h6M10 17h6" />
        </svg>
      </ButtonBase>

      <Box
        sx={{
          height: 32,
          width: 32,
          borderRadius: '50%',
          background: 'linear-gradient(to bottom right, #818cf8, #8b5cf6)',
          display: 'grid',
          placeItems: 'center',
          color: '#fff',
          fontSize: 12,
          fontWeight: 700,
        }}
      >
        CS
      </Box>
    </Box>
  );
}
