import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import { NavLink, useLocation } from 'react-router-dom';
import { palette } from '../theme';
import { useGlobalSearchString } from '../hooks/useUrlState';
import { getJson } from '../api/client';
import { useClusterData } from '../providers/ClusterDataProvider';
import type { AvailableActionsResponse, VersionResponse } from '../api/types';
import {
  AlertsIcon,
  AnalyticsIcon,
  CostReportIcon,
  CustomIcon,
  DownscaleIcon,
  EventsIcon,
  NetworkFlowIcon,
  JavaIcon,
  NodesIcon,
  OverviewIcon,
  PlacementIcon,
  PoliciesIcon,
  ReplicasIcon,
  RightsizingIcon,
  SavingsIcon,
  SchedulingIcon,
  SettingsIcon,
  SizingIcon,
  TroubleshootIcon,
  UsersIcon,
} from './NavIcons';

export const APP_VERSION = 'v0.61.2';

interface NavItem {
  label: string;
  to?: string;
  icon: JSX.Element;
  title?: string;
  /** extra paths that should also mark this item active */
  aliases?: string[];
  /**
   * top navbtn that has no data-view attribute) */
  noActive?: boolean;
}

/*
 * Per-item overlay badges: waste = the Workload-Rightsizing "-N%" pill; count = action-count dot.
*/
interface NavBadges {
  waste?: string;
  count?: number;
}

// Deliberate scope cut: NO GPU, NO Spot, NO AI-Agent items anywhere (per
// CoolScaler scope).
const topItem: NavItem = {
  label: 'Overview',
  to: '/multiCluster',
  icon: <OverviewIcon />,
  title: 'Multi-cluster overview',
  aliases: ['/multiCluster/multi-product'],
  noActive: true,
};

const coreInfra: NavItem[] = [
  {
    label: 'Overview',
    to: '/overview/multi-product',
    icon: <OverviewIcon />,
    aliases: ['/multiCluster/multi-product'],
  },
  {
    label: 'Workload Rightsizing',
    to: '/rightSizing/workloads',
    icon: <RightsizingIcon />,
    title: 'Workload Rightsizing',
  },
  { label: 'Java Optimization', to: '/java', icon: <JavaIcon /> },
  { label: 'Pod Placement', to: '/pod-placement', icon: <PlacementIcon /> },
  {
    label: 'Replicas Optimization',
    to: '/hpa/workloads',
    icon: <ReplicasIcon />,
    title: 'Replicas Optimization (HPA/KEDA min-replicas + CPU threshold)',
  },
  { label: 'Node Management', to: '/node-management', icon: <NodesIcon /> },
  {
    label: 'Cluster Headroom',
    to: '/cluster-headroom',
    icon: <NodesIcon />,
    title: 'Cluster Headroom — reserved capacity for instant scale-ups',
  },
];

const midItems: NavItem[] = [
  {
    label: 'Savings',
    to: '/savings',
    icon: <SavingsIcon />,
    title: 'Savings — allocatable comparison',
  },
  {
    label: 'Billing',
    to: '/billing',
    icon: <SavingsIcon />,
    title: 'Billing — cluster CPU-allocatable estimation',
  },
  {
    label: 'Troubleshooting',
    to: '/troubleshoot',
    icon: <TroubleshootIcon />,
    title: 'Troubleshooting — cluster health dashboard',
  },
  { label: 'Users', icon: <UsersIcon />, title: 'Users (not available)' },
];

const moreItems: NavItem[] = [
  {
    label: 'Policies',
    to: '/rightsize/policies',
    icon: <PoliciesIcon />,
    title: 'Rightsize Policies Management',
  },
  {
    label: 'Sizing',
    to: '/sizing',
    icon: <SizingIcon />,
    title: 'Recommendations by namespace (Goldilocks-style)',
  },
  {
    label: 'Custom',
    to: '/rightsize/custom-workloads',
    icon: <CustomIcon />,
    title: 'Custom Workloads',
  },
  {
    label: 'Analytics',
    to: '/analytics',
    icon: <AnalyticsIcon />,
    title: 'Resources Analytics',
  },
  {
    label: 'Scheduling',
    to: '/scheduling',
    icon: <SchedulingIcon />,
    title: 'Pod Scheduling (Beta) — relax self anti-affinity',
  },
  {
    label: 'Downscale',
    to: '/hpa/downscale',
    icon: <DownscaleIcon />,
    title: 'Replicas Downscale',
  },
  {
    label: 'Cost Report',
    to: '/cost-report',
    icon: <CostReportIcon />,
    title: 'Cost Report — cost breakdown & access',
  },
  {
    label: 'Network Report',
    to: '/cost-report/network',
    icon: <CostReportIcon />,
    title: 'Network Report — inter-namespace traffic & cost',
  },
  {
    label: 'Reports',
    to: '/reports',
    icon: <CostReportIcon />,
    title: 'Reports — custom report builder',
  },
  {
    label: 'Network Flow',
    to: '/cluster-network-flow',
    icon: <NetworkFlowIcon />,
    title: 'Cluster Network Flow — workload traffic map',
  },
  { label: 'Alerts', to: '/alerts', icon: <AlertsIcon />, title: 'Alerts & Audit' },
  { label: 'Events', to: '/events', icon: <EventsIcon />, title: 'Events — user actions & CoolScaler optimization events' },
  {
    label: 'Settings',
    to: '/settings',
    icon: <SettingsIcon />,
    title: 'Settings — component health & automation scope',
  },
];

function NavButton({ item, badges }: { item: NavItem; badges?: NavBadges }) {
  const search = useGlobalSearchString();
  const { pathname } = useLocation();
  const inert = !item.to;
  const active =
    !inert &&
    !item.noActive &&
    (pathname === item.to || (item.aliases ?? []).some((a) => pathname === a));

  const baseSx = {
    position: 'relative' as const,
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    gap: '3px',
    p: '9px 4px',
    borderRadius: '11px',
    fontSize: 9,
    fontWeight: 500,
    textAlign: 'center' as const,
    lineHeight: 1.15,
    textDecoration: 'none',
    color: inert ? palette.sidebarInert : palette.sidebarIdle,
    transition: '.15s',
    ...(active && {
      background: palette.sidebarActiveBg,
      color: '#fff',
      boxShadow: '0 0 0 2px rgba(99,102,241,.35)',
    }),
    ...(!inert &&
      !active && {
        cursor: 'pointer',
        '&:hover': { background: palette.sidebarHoverBg, color: palette.sidebarHoverText },
      }),
    ...(inert && { cursor: 'default', opacity: 0.6 }),
  };

  const badgeNodes = (
    <>
      {badges?.waste && (
        <Box
          component="span"
          sx={{
            position: 'absolute',
            top: 7,
            right: 2,
            borderRadius: '6px',
            background: active ? 'rgba(255,255,255,.22)' : 'rgba(16,185,129,.18)',
            color: active ? '#fff' : '#34d399',
            fontSize: 8,
            fontWeight: 700,
            px: '4px',
            py: '1px',
            lineHeight: 1.3,
          }}
        >
          {badges.waste}
        </Box>
      )}
      {badges?.count ? (
        <Box
          component="span"
          sx={{
            position: 'absolute',
            top: 3,
            right: 3,
            minWidth: 15,
            height: 15,
            px: '3px',
            borderRadius: '8px',
            background: active ? '#fff' : '#6366f1',
            color: active ? '#6366f1' : '#fff',
            fontSize: 8,
            fontWeight: 700,
            lineHeight: '15px',
            textAlign: 'center',
          }}
        >
          {badges.count > 99 ? '99+' : badges.count}
        </Box>
      ) : null}
    </>
  );

  if (inert) {
    return (
      <Box sx={baseSx} title={item.title ?? item.label}>
        {item.icon}
        {item.label}
      </Box>
    );
  }
  return (
    <Box
      component={NavLink}
      to={{ pathname: item.to!, search }}
      sx={baseSx}
      title={item.title ?? item.label}
    >
      {badgeNodes}
      {item.icon}
      {item.label}
    </Box>
  );
}

export default function Sidebar() {
  const { overview } = useClusterData();
  const [version, setVersion] = useState(APP_VERSION);
  const [actions, setActions] = useState<AvailableActionsResponse['features']>({});

  useEffect(() => {
    getJson<VersionResponse>('/api/version')
      .then((v) => v?.currentVersion && setVersion(v.currentVersion))
      .catch(() => {});
  }, []);

  // refreshNavBadges() port — per-product actionable counts every 30s
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      getJson<AvailableActionsResponse>('/api/available-actions')
        .then((d) => !cancelled && setActions(d.features ?? {}))
        .catch(() => {});
    load();
    const t = window.setInterval(load, 30000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, []);

  // sidebar Workload-Rightsizing "-N%" waste badge (current reclaimable waste)
  const badgesFor = (label: string): NavBadges | undefined => {
    switch (label) {
      case 'Workload Rightsizing':
        return overview ? { waste: '-' + Math.round(overview.savingsPct || 0) + '%' } : undefined;
      case 'Replicas Optimization':
        return { count: actions?.replicasOptimization?.workloadsWaste || 0 };
      case 'Pod Placement':
        return { count: actions?.podPlacement?.workloadsWaste || 0 };
      case 'Node Management':
        return { count: actions?.nodes?.blockedNodesCount || 0 };
      default:
        return undefined;
    }
  };

  return (
    <Box
      component="aside"
      sx={{
        width: 88,
        flexShrink: 0,
        background: palette.sidebarBg,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'stretch',
        py: '12px',
        px: '10px',
        gap: '2px',
        position: 'sticky',
        top: 0,
        height: '100vh',
        overflowY: 'auto',
      }}
    >
      {/* logo — doubles as the multi-cluster launcher */}
      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', mb: 1 }}>
        <Box
          component={NavLink}
          to="/multiCluster"
          title="Multi-cluster launcher"
          sx={{
            textDecoration: 'none',
            height: 40,
            width: 40,
            borderRadius: '12px',
            background: '#fff',
            display: 'grid',
            placeItems: 'center',
            boxShadow: '0 10px 15px -3px rgba(49,46,129,.4)',
          }}
        >
          <svg width={30} height={30} viewBox="0 0 48 48" fill="none">
            <g stroke="#9db8ff" strokeWidth={2} strokeLinecap="round">
              <path d="M18 11 L12.5 15.5" />
              <path d="M12.5 32.5 L18 37" />
              <path d="M26.5 11 L30 15" />
              <path d="M26.5 37 L30 32" />
              <path d="M11 24 L11 25" />
              <path d="M27 23.3 L30 23.3" />
            </g>
            <rect x="18" y="4" width="9" height="9" rx="2.5" fill="#2f6bff" />
            <rect x="5" y="13" width="11" height="11" rx="3" fill="#2554d6" />
            <rect x="5" y="25" width="11" height="11" rx="3" fill="#2554d6" />
            <rect x="18" y="36" width="9" height="9" rx="2.5" fill="#2f6bff" />
            <rect x="19" y="19.5" width="8" height="8" rx="2.5" fill="#2f6bff" />
            <rect x="30" y="12" width="7" height="7" rx="2" fill="#9db8ff" />
            <rect x="30" y="20.5" width="5.5" height="5.5" rx="1.5" fill="#9db8ff" />
            <rect x="30" y="28" width="7" height="7" rx="2" fill="#9db8ff" />
            <path d="M43 13 L43 30 M39 26 L43 31 L47 26" stroke="#2f6bff" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Box>
      </Box>

      {/* multi-cluster overview */}
      <NavButton item={topItem} />

      <Box
        sx={{
          fontSize: 8,
          fontWeight: 700,
          letterSpacing: '.08em',
          color: palette.sidebarGroupLabel,
          textAlign: 'center',
          p: '8px 0 2px',
        }}
      >
        CORE INFRA
      </Box>
      {coreInfra.map((item) => (
        <NavButton key={item.label} item={item} badges={badgesFor(item.label)} />
      ))}

      <Box sx={{ mt: '4px', borderTop: '1px solid rgba(255,255,255,.05)', pt: '4px' }} />
      {midItems.map((item) => (
        <NavButton key={item.label} item={item} />
      ))}

      <Box
        sx={{
          fontSize: 8,
          fontWeight: 700,
          letterSpacing: '.08em',
          color: palette.sidebarGroupLabel,
          textAlign: 'center',
          p: '8px 0 2px',
        }}
      >
        MORE
      </Box>
      {moreItems.map((item) => (
        <NavButton key={item.label} item={item} />
      ))}

      {/* bottom: upgrade arrow + version label */}
      <Box
        sx={{
          mt: 'auto',
          pt: '12px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '6px',
        }}
      >
        <Box
          sx={{
            height: 28,
            width: 28,
            borderRadius: '50%',
            border: '1px solid rgba(16,185,129,.6)',
            display: 'grid',
            placeItems: 'center',
            color: '#34d399',
          }}
        >
          <svg
            style={{ width: 14, height: 14 }}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.2}
          >
            <path d="M12 19V5M5 12l7-7 7 7" />
          </svg>
        </Box>
        <Box
          id="verLabel"
          sx={{ textAlign: 'center', fontSize: 9, fontWeight: 600, color: palette.sidebarIdle }}
        >
          {version}
        </Box>
      </Box>
    </Box>
  );
}
