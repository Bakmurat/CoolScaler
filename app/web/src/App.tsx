import { lazy, Suspense } from 'react';
import Box from '@mui/material/Box';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import Sidebar from './components/Sidebar';
import Topbar from './components/Topbar';

// Lazy page chunks.
const OverviewPage = lazy(() => import('./pages/overview/OverviewPage'));
const WorkloadsPage = lazy(() => import('./pages/rightsizing/WorkloadsPage'));
const PoliciesPage = lazy(() => import('./pages/policies/PoliciesPage'));
const CustomWorkloadsPage = lazy(() => import('./pages/customWorkloads/CustomWorkloadsPage'));
const ReplicasPage = lazy(() => import('./pages/replicas/ReplicasPage'));
const PodPlacementPage = lazy(() => import('./pages/podPlacement/PodPlacementPage'));
const NodeManagementPage = lazy(() => import('./pages/nodeManagement/NodeManagementPage'));
const ClusterHeadroomPage = lazy(() => import('./pages/clusterHeadroom/ClusterHeadroomPage'));
const JavaPage = lazy(() => import('./pages/java/JavaPage'));
const SavingsPage = lazy(() => import('./pages/savings/SavingsPage'));
const TroubleshootPage = lazy(() => import('./pages/troubleshoot/TroubleshootPage'));
const SizingPage = lazy(() => import('./pages/sizing/SizingPage'));
const AnalyticsPage = lazy(() => import('./pages/analytics/AnalyticsPage'));
const SchedulingPage = lazy(() => import('./pages/scheduling/SchedulingPage'));
const CostReportPage = lazy(() => import('./pages/costReport/CostReportPage'));
const ReportsPage = lazy(() => import('./pages/reports/ReportsPage'));
const AlertsPage = lazy(() => import('./pages/alerts/AlertsPage'));
const AuditPage = lazy(() => import('./pages/audit/AuditPage'));
const SettingsPage = lazy(() => import('./pages/settings/SettingsPage'));
const MultiClusterPage = lazy(() => import('./pages/multiCluster/MultiClusterPage'));
const BillingPage = lazy(() => import('./pages/billing/BillingPage'));
const EventsPage = lazy(() => import('./pages/events/EventsPage'));
const NetworkReportPage = lazy(() => import('./pages/networkReport/NetworkReportPage'));
const ClusterNetworkFlowPage = lazy(() => import('./pages/networkFlow/ClusterNetworkFlowPage'));

/** Redirect that preserves the query string (deep-link params survive). */
function RedirectKeepSearch({ to }: { to: string }) {
  const { search } = useLocation();
  return <Navigate to={{ pathname: to, search }} replace />;
}

export default function App() {
  return (
    <Box sx={{ display: 'flex', minHeight: '100vh' }}>
      <Sidebar />
      <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <Topbar />
        <Suspense fallback={null}>
          <Routes>
            <Route path="/overview/multi-product" element={<OverviewPage />} />
            <Route path="/multiCluster" element={<MultiClusterPage />} />
            <Route
              path="/multiCluster/multi-product"
              element={<RedirectKeepSearch to="/overview/multi-product" />}
            />
            <Route path="/rightSizing/workloads" element={<WorkloadsPage />} />
            <Route path="/rightsize/policies" element={<PoliciesPage />} />
            <Route path="/rightsize/custom-workloads" element={<CustomWorkloadsPage />} />
            <Route path="/hpa/workloads" element={<ReplicasPage />} />
            <Route path="/hpa/downscale" element={<ReplicasPage />} />
            <Route path="/replicas" element={<RedirectKeepSearch to="/hpa/workloads" />} />
            <Route path="/pod-placement" element={<PodPlacementPage />} />
            <Route path="/unevictable" element={<RedirectKeepSearch to="/pod-placement" />} />
            <Route path="/node-management" element={<NodeManagementPage />} />
            <Route path="/nodes" element={<RedirectKeepSearch to="/node-management" />} />
            <Route path="/cluster-headroom" element={<ClusterHeadroomPage />} />
            <Route path="/java" element={<JavaPage />} />
            <Route path="/java/workloads" element={<RedirectKeepSearch to="/java" />} />
            <Route path="/savings" element={<SavingsPage />} />
            <Route path="/billing" element={<BillingPage />} />
            <Route path="/troubleshoot" element={<TroubleshootPage />} />
            <Route path="/dashboards/insight" element={<TroubleshootPage />} />
            <Route path="/dashboards/analytics" element={<RedirectKeepSearch to="/analytics" />} />
            <Route path="/audits" element={<RedirectKeepSearch to="/events" />} />
            <Route path="/multiCluster/alerts" element={<RedirectKeepSearch to="/alerts" />} />
            <Route path="/multiCluster/insight" element={<RedirectKeepSearch to="/troubleshoot" />} />
            <Route path="/cost-comparison" element={<RedirectKeepSearch to="/savings" />} />
            <Route path="/sizing" element={<SizingPage />} />
            <Route
              path="/rightsize/recommendations"
              element={<RedirectKeepSearch to="/sizing" />}
            />
            <Route path="/analytics" element={<AnalyticsPage />} />
            <Route path="/scheduling" element={<SchedulingPage />} />
            <Route path="/podScheduling" element={<RedirectKeepSearch to="/scheduling" />} />
            <Route path="/downscale" element={<RedirectKeepSearch to="/hpa/downscale" />} />
            <Route path="/cost-report" element={<CostReportPage />} />
            <Route path="/reports" element={<ReportsPage />} />
            <Route path="/multiCluster/reports" element={<ReportsPage />} />
            <Route path="/cost-report/compute" element={<CostReportPage />} />
            <Route path="/cost-report/network" element={<NetworkReportPage />} />
            <Route path="/cluster-network-flow" element={<ClusterNetworkFlowPage />} />
            <Route path="/alerts" element={<AlertsPage />} />
            <Route path="/troubleshooting" element={<RedirectKeepSearch to="/alerts" />} />
            <Route path="/events" element={<EventsPage />} />
            <Route path="/audit" element={<AuditPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/" element={<RedirectKeepSearch to="/overview/multi-product" />} />
            <Route path="*" element={<RedirectKeepSearch to="/overview/multi-product" />} />
          </Routes>
        </Suspense>
      </Box>
    </Box>
  );
}
