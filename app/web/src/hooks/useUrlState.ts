import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

/*
 * Well-known global query params that must survive navigation: cluster selection + workload-drawer
 * deep links.
*/
export const GLOBAL_URL_PARAMS = [
  'currentClusterURLParam',
  'selectedWorkloadOverviewId',
  'policyTuningViewPeriod',
  'policyTuningSelectedTab',
] as const;

export type GlobalUrlParam = (typeof GLOBAL_URL_PARAMS)[number];

/**
 * Read/write a single query param without clobbering the rest of the URL
 * state. Setting `null`/`''` removes the param. Uses `replace` by default so
 * tab/period tweaks don't spam history; pass push=true for drawer opens.
 */
export function useUrlState(
  key: string,
): [string | null, (value: string | null, opts?: { push?: boolean }) => void] {
  const [searchParams, setSearchParams] = useSearchParams();
  const value = searchParams.get(key);

  const setValue = useCallback(
    (next: string | null, opts?: { push?: boolean }) => {
      setSearchParams(
        (prev) => {
          const sp = new URLSearchParams(prev);
          if (next === null || next === '') sp.delete(key);
          else sp.set(key, next);
          return sp;
        },
        { replace: !opts?.push },
      );
    },
    [key, setSearchParams],
  );

  return [value, setValue];
}

/**
 * Search string (e.g. "?currentClusterURLParam=x") carrying only the params
 * that should persist across page switches — used by nav links so switching
 * views never loses the selected cluster / open drawer.
 */
export function useGlobalSearchString(): string {
  const [searchParams] = useSearchParams();
  const sp = new URLSearchParams();
  for (const key of GLOBAL_URL_PARAMS) {
    const v = searchParams.get(key);
    if (v !== null) sp.set(key, v);
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}
