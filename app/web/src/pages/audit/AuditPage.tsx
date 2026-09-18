// (Troubleshooting) view with no sub-tab split, so this route renders the
// same view as /alerts (audit trail is the bottom section of that page).
import AlertsPage from '../alerts/AlertsPage';

export default function AuditPage() {
  return <AlertsPage />;
}
