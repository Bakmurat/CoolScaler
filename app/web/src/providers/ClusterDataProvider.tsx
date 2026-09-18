import { useEffect, type ReactNode } from 'react';
import { useClusterStore } from '../store/clusterStore';
import { startClusterPolling } from '../store/clusterStore';
import type { OverviewResponse } from '../api/types';

// The polled cluster state now lives in a zustand store (src/store/clusterStore)

export function useClusterData() {
  const overview = useClusterStore((s) => s.overview);
  const workloads = useClusterStore((s) => s.workloads);
  const ro = useClusterStore((s) => s.ro);
  const refresh = useClusterStore((s) => s.refresh);
  return { overview, workloads, ro, refresh };
}

/**
 * them: prefer features.rightsize.automation (eligible-set counters). */
export function automationCounts(ov: OverviewResponse | null): {
  auto: number;
  total: number;
  pct: number;
} {
  if (!ov) return { auto: 0, total: 0, pct: 0 };
  const rsAuto = ov.features?.rightsize?.automation ?? {};
  const auto = (rsAuto.autoAmount != null ? rsAuto.autoAmount : ov.automated) || 0;
  const total =
    (rsAuto.totalAmount != null
      ? rsAuto.totalAmount
      : ov.autoEligible != null
        ? ov.autoEligible
        : ov.sizable) || 0;
  return { auto, total, pct: total ? Math.round((auto / total) * 100) : 0 };
}

export default function ClusterDataProvider({ children }: { children: ReactNode }) {
  useEffect(() => startClusterPolling(), []);
  return <>{children}</>;
}
