import { useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { GLOBAL_URL_PARAMS } from '../../hooks/useUrlState';

// /overview/multi-product path (they have no route of their own in
// VIEW_ROUTES); section=core is only present on the landing subview
// (viewToUrl adds it for v==='overview' only).

export type OverviewSubview = 'core' | 'recactions' | 'reliability';

export function useOverviewNav(): (v: OverviewSubview) => void {
  const navigate = useNavigate();
  const [params] = useSearchParams();

  return useCallback(
    (v: OverviewSubview) => {
      const sp = new URLSearchParams();
      for (const k of GLOBAL_URL_PARAMS) {
        const val = params.get(k);
        if (val !== null) sp.set(k, val);
      }
      if (!sp.get('currentClusterURLParam'))
        sp.set('currentClusterURLParam', 'example-cluster');
      if (v === 'core') sp.set('section', 'core');
      navigate(
        { pathname: '/overview/multi-product', search: '?' + sp.toString() },
        { state: v === 'core' ? null : { subview: v } },
      );
    },
    [navigate, params],
  );
}
