import Box from '@mui/material/Box';
import { useNavigate } from 'react-router-dom';
import { cardSx, numSx, OutlineButton, ApplyButton, useApplyWorkload, recommendedActions } from './shared';
import { usd } from '../../lib/format';
import { useClusterData } from '../../providers/ClusterDataProvider';
import { useGlobalSearchString } from '../../hooks/useUrlState';
import { workloadOverviewId } from '../rightsizing/lib';
import type { AlertItem, AlertsResponse } from '../../api/types';

// The two hero cards at the top of the Overview landing view:
// "Recommended actions" (top-3 savings) and "Reliability risks" (live alerts).

const th: React.CSSProperties = {
  fontWeight: 700,
  padding: '10px 0',
  textAlign: 'center',
  borderRight: '1px solid #f6f7fb',
};

export function RecommendedActionsCard({ onViewAll }: { onViewAll: () => void }) {
  const { workloads, ro, overview } = useClusterData();
  const navigate = useNavigate();
  const search = useGlobalSearchString();
  const applyWl = useApplyWorkload();
  const cluster = overview?.clusterName || 'cluster';
  const top = recommendedActions(workloads).slice(0, 3);

  return (
    <Box sx={{ ...cardSx, p: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      {/* header — emerald gradient + zap icon */}
      <Box
        sx={{
          px: 2,
          py: '14px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          background:
            'linear-gradient(to right, rgba(236,253,245,.8), rgba(236,253,245,.3), transparent)',
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <Box
            sx={{
              height: 32,
              width: 32,
              borderRadius: '8px',
              background: '#22c55e',
              display: 'grid',
              placeItems: 'center',
              flexShrink: 0,
              boxShadow: '0 1px 2px rgba(16,24,40,.08)',
            }}
          >
            <svg style={{ width: 16, height: 16, color: '#fff' }} viewBox="0 0 24 24" fill="currentColor">
              <path d="M13 2L4 14h6l-1 8 9-12h-6z" />
            </svg>
          </Box>
          <Box component="h2" sx={{ m: 0, fontWeight: 700, fontSize: 16, color: '#1e2536' }}>
            Recommended actions
          </Box>
        </Box>
        <OutlineButton onClick={onViewAll}>View all</OutlineButton>
      </Box>

      {/* top-3 table */}
      <Box sx={{ px: 2, pb: 2, pt: 0.5, overflowX: 'auto', flex: 1 }}>
        <Box
          component="table"
          sx={{ width: '100%', fontSize: 14, border: '1px solid #e6e8f0', borderCollapse: 'collapse' }}
        >
          <thead>
            <tr style={{ background: '#e9ebf3', fontSize: 13, color: '#2b3147' }}>
              <th style={th}>Name</th>
              <th style={{ ...th, width: 96 }}>Savings</th>
              <th style={{ ...th, width: 112 }}>Explore</th>
              <th style={{ ...th, borderRight: 'none', width: 128 }}>Action</th>
            </tr>
          </thead>
          <tbody>
            {top.length === 0 ? (
              <tr>
                <td
                  colSpan={4}
                  style={{ padding: '40px 0', textAlign: 'center', color: '#94a3b8', fontSize: 14 }}
                >
                  No savings available — all workloads are right-sized.
                </td>
              </tr>
            ) : (
              top.map((w) => {
                const dis = ro || !!w.hpaManaged;
                const tip = w.hpaManaged
                  ? 'HPA-managed — apply disabled'
                  : ro
                    ? 'Read-only mode'
                    : undefined;
                return (
                  <Box
                    component="tr"
                    key={w.key}
                    sx={{
                      borderBottom: '1px solid #eef0f5',
                      transition: 'background-color .15s',
                      '&:hover': { background: '#eef1fc' },
                    }}
                  >
                    <td style={{ padding: '12px 0 12px 16px' }}>
                      <Box
                        sx={{
                          fontWeight: 600,
                          color: '#1e2536',
                          fontSize: 13,
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        Rightsize {w.name}
                      </Box>
                      <Box
                        sx={{
                          fontSize: 11,
                          color: '#94a3b8',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        Cluster: <Box component="span" sx={{ color: '#64748b' }}>{cluster}</Box> ·{' '}
                        {w.namespace} · {w.kind}
                      </Box>
                    </td>
                    <Box
                      component="td"
                      sx={{ textAlign: 'center', fontWeight: 600, color: '#16a34a', ...numSx }}
                    >
                      {usd(w.savings)}
                    </Box>
                    <td style={{ textAlign: 'center' }}>
                      <OutlineButton
                        onClick={() => {
                          // row targeting: deep-link straight into this
                          // workload's drawer on /rightSizing/workloads
                          const sp = new URLSearchParams(search);
                          sp.set('selectedWorkloadOverviewId', workloadOverviewId(cluster, w));
                          navigate({ pathname: '/rightSizing/workloads', search: '?' + sp.toString() });
                        }}
                        sx={{ fontSize: 12, fontWeight: 600 }}
                      >
                        Explore
                      </OutlineButton>
                    </td>
                    <td style={{ textAlign: 'center', paddingRight: 8 }}>
                      <ApplyButton disabled={dis} title={tip} onClick={() => applyWl(w)}>
                        Apply
                      </ApplyButton>
                    </td>
                  </Box>
                );
              })
            )}
          </tbody>
        </Box>
      </Box>
    </Box>
  );
}

// severity → [pill bg, pill text, pill border, dot color] (ALERT_SEV port)
export const ALERT_SEV: Record<string, [string, string, string, string]> = {
  critical: ['#fff1f2', '#e11d48', '#fecdd3', '#f43f5e'],
  warning: ['#fffbeb', '#d97706', '#fde68a', '#f59e0b'],
  info: ['#f0f9ff', '#0284c7', '#bae6fd', '#0ea5e9'],
};

function CountPill({ n, sev, label }: { n: number; sev: string; label: string }) {
  const s = ALERT_SEV[sev];
  return (
    <Box
      component="span"
      sx={{
        fontSize: 11,
        fontWeight: 600,
        px: '9px',
        py: '2px',
        borderRadius: 999,
        display: 'inline-flex',
        alignItems: 'center',
        gap: '5px',
        whiteSpace: 'nowrap',
        background: s[0],
        color: s[1],
        border: `1px solid ${s[2]}`,
      }}
    >
      {n} {label}
    </Box>
  );
}

export function ReliabilityCard({
  alerts,
  onViewAll,
}: {
  alerts: AlertsResponse | null;
  onViewAll: () => void;
}) {
  const list: AlertItem[] = alerts?.alerts ?? [];
  const c = alerts?.counts ?? {};

  return (
    <Box sx={{ ...cardSx, p: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      {/* header — rose gradient + shield icon */}
      <Box
        sx={{
          px: 2,
          py: '14px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          background:
            'linear-gradient(to right, rgba(255,241,242,.8), rgba(255,241,242,.3), transparent)',
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <Box
            sx={{
              height: 32,
              width: 32,
              borderRadius: '8px',
              background: '#f43f5e',
              display: 'grid',
              placeItems: 'center',
              flexShrink: 0,
              boxShadow: '0 1px 2px rgba(16,24,40,.08)',
            }}
          >
            <svg
              style={{ width: 16, height: 16, color: '#fff' }}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path d="M12 3l8 4v6c0 4-3.5 6.5-8 8-4.5-1.5-8-4-8-8V7z" />
              <path d="M12 8v4M12 15.5h.01" />
            </svg>
          </Box>
          <Box component="h2" sx={{ m: 0, fontWeight: 700, fontSize: 16, color: '#1e2536' }}>
            Reliability risks
          </Box>
        </Box>
        <OutlineButton onClick={onViewAll}>View all</OutlineButton>
      </Box>

      {/* body */}
      {list.length === 0 ? (
        <Box
          sx={{
            flex: 1,
            display: 'grid',
            placeItems: 'center',
            py: '40px',
            px: 2,
            textAlign: 'center',
          }}
        >
          <Box>
            <Box
              sx={{
                height: 48,
                width: 48,
                borderRadius: '50%',
                border: '2px solid #22c55e',
                display: 'grid',
                placeItems: 'center',
                mx: 'auto',
                mb: '12px',
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
            <Box sx={{ fontSize: 14, fontWeight: 500, color: '#16a34a' }}>
              All systems healthy, no insights available.
            </Box>
          </Box>
        </Box>
      ) : (
        <Box sx={{ flex: 1, py: '20px', px: 2, textAlign: 'left', width: '100%' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
            {c.critical ? <CountPill n={c.critical} sev="critical" label="critical" /> : null}
            {c.warning ? <CountPill n={c.warning} sev="warning" label="warning" /> : null}
            {c.info ? <CountPill n={c.info} sev="info" label="info" /> : null}
          </Box>
          {list.slice(0, 8).map((a, i) => {
            const s = ALERT_SEV[a.severity] ?? ALERT_SEV.info;
            return (
              <Box
                key={i}
                sx={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 1,
                  py: '6px',
                  borderBottom: '1px solid #f4f5f9',
                  '&:last-of-type': { borderBottom: 'none' },
                }}
              >
                <Box
                  component="span"
                  sx={{
                    mt: '2px',
                    height: 8,
                    width: 8,
                    borderRadius: '50%',
                    flexShrink: 0,
                    background: s[3],
                  }}
                />
                <Box sx={{ minWidth: 0 }}>
                  <Box sx={{ fontSize: 12, fontWeight: 600, color: s[1] }}>{a.type}</Box>
                  <Box
                    sx={{
                      fontSize: 11,
                      color: '#64748b',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {a.message}
                  </Box>
                </Box>
              </Box>
            );
          })}
          {list.length > 8 && (
            <Box sx={{ fontSize: 11, color: '#94a3b8', mt: '6px', textAlign: 'center' }}>
              +{list.length - 8} more
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
}
