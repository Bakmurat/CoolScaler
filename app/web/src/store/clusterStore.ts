// Zustand store for the cluster-wide polled state.
import { create } from 'zustand';
import { getJson } from '../api/client';
import type { OverviewResponse, Workload, WorkloadsResponse } from '../api/types';

export interface ClusterState {
  overview: OverviewResponse | null;
  workloads: Workload[];
  /** cluster read-only flag — true until first successful poll (safe default) */
  ro: boolean;
  refresh: () => Promise<void>;
}

export const useClusterStore = create<ClusterState>((set) => ({
  overview: null,
  workloads: [],
  ro: true,
  refresh: async () => {
    try {
      const [ov, wl] = await Promise.all([
        getJson<OverviewResponse>('/api/overview'),
        getJson<WorkloadsResponse>('/api/workloads'),
      ]);
      set({ overview: ov, workloads: wl.workloads || [], ro: !!ov.readOnly });
    } catch {
    }
  },
}));

let pollTimer: number | null = null;
let pollUsers = 0;

/** Start the 15s poll loop (ref-counted; provider mounts/unmounts drive it). */
export function startClusterPolling(): () => void {
  pollUsers += 1;
  if (pollTimer == null) {
    void useClusterStore.getState().refresh();
    pollTimer = window.setInterval(() => void useClusterStore.getState().refresh(), 15000);
  }
  return () => {
    pollUsers -= 1;
    if (pollUsers <= 0 && pollTimer != null) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
  };
}
