import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import { useLocation, useSearchParams } from 'react-router-dom';
import { RecommendedActionsCard, ReliabilityCard } from './TopCards';
import HeroCostCards from './HeroCostCards';
import CoreInfraSection from './CoreInfraSection';
import RecActionsView from './RecActionsView';
import ReliabilityView from './ReliabilityView';
import { OverviewFooter } from './shared';
import { useOverviewNav, type OverviewSubview } from './subview';
import { getJson } from '../../api/client';
import { useClusterData } from '../../providers/ClusterDataProvider';
import type { AlertsResponse } from '../../api/types';

// VIEW 1

export default function OverviewPage() {
  const location = useLocation();
  const nav = useOverviewNav();
  const { overview } = useClusterData();
  const [searchParams, setSearchParams] = useSearchParams();
  const [alerts, setAlerts] = useState<AlertsResponse | null>(null);

  const subview: OverviewSubview =
    ((location.state as { subview?: OverviewSubview } | null)?.subview as OverviewSubview) ||
    'core';

  // Deep-link contract: landing on /overview/multi-product always carries
  useEffect(() => {
    if (subview !== 'core') return;
    if (searchParams.get('section') === 'core' && searchParams.get('currentClusterURLParam'))
      return;
    setSearchParams(
      (prev) => {
        const sp = new URLSearchParams(prev);
        sp.set('section', 'core');
        if (!sp.get('currentClusterURLParam'))
          sp.set('currentClusterURLParam', overview?.clusterName || 'example-cluster');
        return sp;
      },
      { replace: true },
    );
  }, [subview, searchParams, setSearchParams, overview]);

  // Reliability risks = live alerts; refetched on every overview poll,
  // like renderAlerts() inside renderLauncher().
  useEffect(() => {
    let cancelled = false;
    getJson<AlertsResponse>('/api/alerts')
      .then((d) => !cancelled && setAlerts(d))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [overview]);

  if (subview === 'recactions') return <RecActionsView />;
  if (subview === 'reliability') return <ReliabilityView />;

  return (
    <Box component="main" sx={{ p: '20px', display: 'flex', flexDirection: 'column', gap: 2 }}>
      {/* hero: Live monthly cost + Wasted spend */}
      <HeroCostCards />
      {/* hero: Recommended actions + Reliability risks */}
      <Box
        component="section"
        sx={{
          display: 'grid',
          // Tailwind lg: breakpoint (1024px) — grid-cols-[1.25fr_1fr]
          gridTemplateColumns: '1fr',
          '@media (min-width:1024px)': { gridTemplateColumns: '1.25fr 1fr' },
          gap: 2,
          alignItems: 'stretch',
        }}
      >
        <RecommendedActionsCard onViewAll={() => nav('recactions')} />
        <ReliabilityCard alerts={alerts} onViewAll={() => nav('reliability')} />
      </Box>

      {/* Core Infra boxed product launcher */}
      <Box
        component="section"
        sx={{
          borderRadius: '16px',
          border: '1px solid #dde1f2',
          background: '#edeffa',
          p: 2,
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: '12px', px: '4px', pt: '4px' }}>
          <Box
            sx={{
              height: 44,
              width: 44,
              borderRadius: '12px',
              background: '#e0e7ff',
              display: 'grid',
              placeItems: 'center',
              flexShrink: 0,
            }}
          >
            <svg
              style={{ width: 24, height: 24, color: '#6366f1' }}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.6}
            >
              <path d="M12 3l7 4v10l-7 4-7-4V7z" />
              <circle cx="12" cy="12" r="2.5" />
              <path d="M12 3v6.5M19 7l-4.8 2.8M19 17l-4.8-2.8M12 21v-6.5M5 17l4.8-2.8M5 7l4.8 2.8" />
            </svg>
          </Box>
          <Box>
            <Box component="h2" sx={{ m: 0, fontSize: 17, fontWeight: 700, color: '#1e2536' }}>
              Core Infra
            </Box>
            <Box component="p" sx={{ m: 0, fontSize: 13, color: '#64748b' }}>
              Optimize{' '}
              <Box component="b" sx={{ fontWeight: 600, color: '#475569' }}>
                workloads
              </Box>
              ,{' '}
              <Box component="b" sx={{ fontWeight: 600, color: '#475569' }}>
                nodes
              </Box>
              ,{' '}
              <Box component="b" sx={{ fontWeight: 600, color: '#475569' }}>
                replicas
              </Box>
              , and{' '}
              <Box component="b" sx={{ fontWeight: 600, color: '#475569' }}>
                pod placement
              </Box>
              .
            </Box>
          </Box>
        </Box>
        <Box sx={{ borderTop: '1px solid #d6daee', mt: '12px', mb: 2 }} />
        <CoreInfraSection />
      </Box>

      <OverviewFooter />
    </Box>
  );
}
