// /rightSizing/workloads — the flagship Workload Rightsizing surface.
// KPI row (Live|30d), 7/30-day charts, Recommended actions + namespace savings,
// the Workloads|Aggregation table, and the workload-overview drawer with
// selectedWorkloadOverviewId / policyTuningViewPeriod / policyTuningSelectedTab
// deep links (opening pushes the URL; browser back closes the drawer).
import { useCallback, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import './rightsizing.css';
import KpiSection from './KpiSection';
import RsCharts from './RsCharts';
import WorkloadsTable, { type ChipName } from './WorkloadsTable';
import WorkloadDrawer from './drawer/WorkloadDrawer';
import { parseWorkloadOverviewId, workloadOverviewId, type DrawerTarget } from './lib';
import { useClusterData } from '../../providers/ClusterDataProvider';
import { useGlobalSearchString } from '../../hooks/useUrlState';

const DRAWER_PARAMS = ['selectedWorkloadOverviewId', 'policyTuningViewPeriod', 'policyTuningSelectedTab'];

export default function WorkloadsPage() {
  const { overview } = useClusterData();
  const navigate = useNavigate();
  const search = useGlobalSearchString();
  const [searchParams, setSearchParams] = useSearchParams();
  const [chips, setChips] = useState<Set<ChipName>>(new Set());
  const tableRef = useRef<HTMLDivElement | null>(null);

  // ?types=<cog-name> — Custom Workloads "Explore workloads" deep link
  const typesFilter = searchParams.get('types');
  const clearTypes = useCallback(() => {
    setSearchParams(
      (prev) => {
        const sp = new URLSearchParams(prev);
        sp.delete('types');
        return sp;
      },
      { replace: true },
    );
  }, [setSearchParams]);

  const selId = searchParams.get('selectedWorkloadOverviewId');
  const target: DrawerTarget | null = useMemo(() => parseWorkloadOverviewId(selId), [selId]);
  const initialTab = searchParams.get('policyTuningSelectedTab');
  const initialPeriod = searchParams.get('policyTuningViewPeriod');

  const cluster =
    searchParams.get('currentClusterURLParam') || overview?.clusterName || 'example-cluster';

  // drawerPushUrl port — opening the drawer PUSHES the deep link so browser
  // back closes it (the URL is the single source of drawer state).
  const openDrawer = useCallback(
    (w: { namespace: string; kind: string; name: string }) => {
      setSearchParams(
        (prev) => {
          const sp = new URLSearchParams(prev);
          sp.set('selectedWorkloadOverviewId', workloadOverviewId(cluster, w));
          return sp;
        },
        { replace: false },
      );
    },
    [cluster, setSearchParams],
  );

  // closeDrawer port — drop the drawer deep-link params (shareable-state hygiene)
  const closeDrawer = useCallback(() => {
    setSearchParams(
      (prev) => {
        const sp = new URLSearchParams(prev);
        DRAWER_PARAMS.forEach((k) => sp.delete(k));
        return sp;
      },
      { replace: true },
    );
  }, [setSearchParams]);

  // rsIssueFilter port — issue-links card → matching filter chip + scroll to table
  const issueFilter = useCallback((chip: 'under' | 'inits') => {
    setChips((prev) => {
      const n = new Set(prev);
      n.add(chip);
      return n;
    });
    tableRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  return (
    <main style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16, background: '#f3f4f9' }}>
      <KpiSection
        onIssueFilter={issueFilter}
        onUnrecognized={() => navigate({ pathname: '/rightsize/custom-workloads', search })}
      />
      <RsCharts />
      <WorkloadsTable
        ref={tableRef}
        chips={chips}
        setChips={setChips}
        onOpenDrawer={openDrawer}
        typesFilter={typesFilter}
        onClearTypes={clearTypes}
      />
      <footer style={{ textAlign: 'center', fontSize: 12, color: '#94a3b8', paddingTop: 8, paddingBottom: 24 }}>
        CoolScaler · Kubernetes right-sizing · refreshes every 15s
      </footer>

      {target && (
        <WorkloadDrawer
          key={`${target.namespace}/${target.kind}/${target.name}`}
          target={target}
          initialTab={initialTab}
          initialPeriod={initialPeriod}
          onClose={closeDrawer}
        />
      )}
    </main>
  );
}
