import type { ReactNode } from 'react';

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      style={{ width: 20, height: 20 }}
    >
      {children}
    </svg>
  );
}

export const OverviewIcon = () => (
  <Icon>
    <rect x="3" y="3" width="7" height="7" rx="1.5" />
    <rect x="14" y="3" width="7" height="7" rx="1.5" />
    <rect x="3" y="14" width="7" height="7" rx="1.5" />
    <rect x="14" y="14" width="7" height="7" rx="1.5" />
  </Icon>
);

export const RightsizingIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="9" />
    <path d="M16 8l-5.5 5.5M16 8l-2 6-6 2z" />
  </Icon>
);

export const JavaIcon = () => (
  <Icon>
    <path d="M8 18c0 1.5 2 2 4 2s4-.5 4-2M8 14c0 1.2 1.8 2 4 2s4-.8 4-2M12 3c2 2-1 3 0 5M9 6c1.5 1.5-.5 2.5 0 4" />
  </Icon>
);

export const PlacementIcon = () => (
  <Icon>
    <rect x="3" y="3" width="8" height="8" rx="1.5" />
    <rect x="13" y="13" width="8" height="8" rx="1.5" />
    <path d="M11 7h6M7 11v6" />
  </Icon>
);

export const ReplicasIcon = () => (
  <Icon>
    <path d="M4 7h11M4 7l3-3M4 7l3 3M20 17H9M20 17l-3-3M20 17l-3 3" />
  </Icon>
);

export const NodesIcon = () => (
  <Icon>
    <rect x="3" y="4" width="18" height="6" rx="1.5" />
    <rect x="3" y="14" width="18" height="6" rx="1.5" />
    <path d="M7 7h.01M7 17h.01" />
  </Icon>
);

export const SavingsIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v10M9.5 9.5c0-1 1-1.5 2.5-1.5s2.5.6 2.5 1.6c0 2.4-5 1.4-5 3.8 0 1 1 1.6 2.5 1.6s2.5-.5 2.5-1.5" />
  </Icon>
);

export const TroubleshootIcon = () => (
  <Icon>
    <rect x="3" y="4" width="18" height="14" rx="2" />
    <path d="M7 12h3l2-4 2 6 2-2h1M9 21h6" />
  </Icon>
);

export const UsersIcon = () => (
  <Icon>
    <circle cx="12" cy="8" r="3.5" />
    <path d="M5 20c0-3.5 3-5.5 7-5.5s7 2 7 5.5" />
  </Icon>
);

export const PoliciesIcon = () => (
  <Icon>
    <path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z" />
    <path d="M9 12l2 2 4-4" />
  </Icon>
);

export const SizingIcon = () => (
  <Icon>
    <path d="M4 6h16M4 12h16M4 18h10M18 16l2 2-2 2" />
  </Icon>
);

export const CustomIcon = () => (
  <Icon>
    <path d="M12 2v4M12 18v4M2 12h4M18 12h4M5 5l3 3M16 16l3 3M19 5l-3 3M8 16l-3 3" />
    <circle cx="12" cy="12" r="3" />
  </Icon>
);

export const AnalyticsIcon = () => (
  <Icon>
    <path d="M4 19V5M4 19h16M8 16v-5M12 16V8M16 16v-3M20 16v-7" />
  </Icon>
);

export const SchedulingIcon = () => (
  <Icon>
    <circle cx="6" cy="6" r="2.5" />
    <circle cx="18" cy="6" r="2.5" />
    <circle cx="12" cy="18" r="2.5" />
    <path d="M6 8.5v3a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-3" />
  </Icon>
);

export const DownscaleIcon = () => (
  <Icon>
    <rect x="3" y="3" width="13" height="13" rx="2" />
    <path d="M8 8h13v13H8" />
  </Icon>
);

export const CostReportIcon = () => (
  <Icon>
    <path d="M4 5h16v14H4z" />
    <path d="M4 9h16M8 13h5" />
  </Icon>
);

export const AlertsIcon = () => (
  <Icon>
    <circle cx="11" cy="11" r="7" />
    <path d="M21 21l-4-4" />
  </Icon>
);

export const EventsIcon = () => (
  <Icon>
    <rect x="3" y="4" width="18" height="17" rx="2" />
    <path d="M3 9h18M8 3v3M16 3v3M8 14h4M8 17h7" />
  </Icon>
);

export const NetworkFlowIcon = () => (
  <Icon>
    <circle cx="5" cy="12" r="2.4" />
    <circle cx="19" cy="6" r="2.4" />
    <circle cx="19" cy="18" r="2.4" />
    <path d="M7.2 11l9.6-4M7.2 13l9.6 4" />
  </Icon>
);

export const SettingsIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </Icon>
);
