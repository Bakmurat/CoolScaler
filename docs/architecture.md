# Architecture

## One image, many roles

Every component runs the same static Go binary (`app/cmd/coolscaler`) with a
different subcommand, so the Helm chart deploys one image in several Deployments
and one DaemonSet. The dashboard is a React single-page application built with
Vite and served by the `dashboard-api` role, which reverse-proxies `/api/*` to the
recommender.

```
recommender (recommendation)   engine + /api/*     <- Prometheus, metrics.k8s.io, API server
dashboards  (dashboard-api)    static SPA + proxy  <- browser
agent       (agent)            CRD install/update, workload discovery
updater     (updater)          applies recommendations to automated workloads (leader-elected via Leases)
admissions  (admissions-controller)  mutating webhook: pods CREATE, HPA and KEDA ScaledObject UPDATE
network-monitor                DaemonSet stub exposing /metrics
kube-state-metrics, prometheus bundled upstream binaries
```

## Data flow

1. Prometheus scrapes cAdvisor (`/metrics/cadvisor` on each node), kube-state-metrics,
   and each CoolScaler component's own `/metrics`.
2. The recommender samples every workload on a fixed interval, keeps a rolling
   history, and computes per-container recommendations: percentile of usage over
   the window, multiplied by headroom, floored by minimums.
3. Recommendations are written as `Recommendation` custom resources (status
   subresource) and also served by the API for the dashboard.
4. A `Policy` custom resource (built-in ones are seeded on first start) holds the
   tuning knobs: percentiles, headroom, limits strategy, automation flags,
   schedules, detection rules.
5. When automation is on, the updater (one leader at a time) patches the
   workload's requests, or uses the pod resize subresource where the cluster
   supports it; the admission webhook injects the current recommendation into
   pods as they are created.

## Custom resources (`analysis.coolscaler.sh/v1alpha1`)

`Policy`, `Recommendation`, `HpaPolicy`, `DownscalerPolicy`, `DownscaleConfiguration`,
`AutomatedNamespace`, `CustomOwnerGrouping`, `PodSchedulingPolicy`, `SpotPolicy`,
`GpuPolicy`, `GpuMemoryPolicy`, `AutoHealing`. The definitions live in
`app/internal/crds/*.yaml` (embedded in the binary for `agent --update-crd`) and in
`charts/coolscaler/templates/crds.yaml`.

## Runtime configuration

Runtime settings that the UI can change (automation config, cluster operations,
custom dashboards, node state, headroom, ignored namespaces, alert settings, Slack
configuration) are stored as ConfigMaps in the release namespace. Helm seeds some
of them on first install only; later edits from the UI or API win.

## API

The recommender serves a JSON API under `/api/*` (overview, workloads, workload
detail and YAML, recommendations, policies, HPA policies, scheduling, headroom,
nodes, cost config and reports, analytics, alerts, audits, Slack, settings,
troubleshoot exports). The web client in `app/web/src/api/` is the reference for
the shapes.
