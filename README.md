# CoolScaler

CoolScaler is an open-source Kubernetes workload right-sizing and cost-optimization
platform. It watches what every Deployment, StatefulSet and DaemonSet actually uses,
recommends CPU and memory requests that fit, prices the gap between requests and
usage, and, only when you switch it on, applies the recommendations for you. It ships
as one container image with a small set of cooperating components and a web dashboard.

CoolScaler is inspired by commercial Kubernetes right-sizing products. It is a
personal project by its sole author, [Bakmurat Kubanaliev](https://github.com/Bakmurat),
and is released under the Apache License 2.0.

## Status

- Working: it runs end to end in the author's own Kubernetes environment (RKE2 on
  Harvester), where the recommender, updater, admission webhook and dashboard have
  been exercised against real workloads.
- Not production-hardened: there has been no multi-cluster, large-cluster, or
  long-duration operation, no security audit, and no third-party review.
- No prebuilt image is published yet. Build your own (below) and point the chart at
  your registry.
- Installs in read-only mode. Nothing is mutated until you set `readOnly=false`.

## What it does

- Discovers workloads by walking pod `ownerReferences`.
- Measures usage from the bundled Prometheus (cAdvisor and kube-state-metrics
  scrapes) and from `metrics.k8s.io`.
- Recommends requests at a configurable percentile plus headroom over a
  configurable history window (defaults: P93 CPU and memory, +10% CPU, +5%
  memory, 24 hours).
- Prices the request-versus-recommendation gap with a configurable cost model.
- Stores its state as Kubernetes custom resources (`Policy`, `Recommendation`,
  `HpaPolicy`, `DownscalerPolicy`, ... under `analysis.coolscaler.sh/v1alpha1`).
- Optionally applies: an updater patches automated workloads, and a mutating
  admission webhook injects recommended requests into pods at creation time, in
  namespaces you opt in with the label `coolscaler.sh/optimize=true`.
- Shows it all in a React dashboard: savings, right-sizing, replicas, scheduling,
  node management, cluster headroom, Java (JVM) observability, cost reports,
  alerts and audit events.

## Components

| Component | Subcommand | Role |
|---|---|---|
| `coolscaler-recommender` | `recommendation` | Recommendation engine and the `/api/*` backend |
| `coolscaler-dashboards` | `dashboard-api` | Serves the web UI and proxies `/api/*` to the recommender |
| `coolscaler-agent` | `agent` | Watches new workloads; installs or updates the CRDs (`--update-crd`) |
| `coolscaler-updater` | `updater` | Applies recommendations to automated workloads (leader-elected) |
| `coolscaler-admissions` | `admissions-controller` | Mutating webhook for pods, HPAs and KEDA ScaledObjects |
| `coolscaler-network-monitor` | `network-monitor` | Per-node DaemonSet; a non-privileged stub that exposes `/metrics` |
| `coolscaler-kube-state-metrics` | (bundled binary) | Workload metadata for Prometheus |
| `coolscaler-prometheus-server` | (bundled binary) | Metrics history, 30-day retention by default |

## Quick start

```bash
# 1. Build the image and push it to a registry you control
REGISTRY=registry.example.com/coolscaler bash scripts/build.sh 1.2.0
#    or: docker build --build-arg VERSION=1.2.0 -t registry.example.com/coolscaler/coolscaler:1.2.0 . && docker push ...

# 2. Install in read-only mode
helm upgrade --install coolscaler charts/coolscaler \
  -n coolscaler-system --create-namespace \
  --set image.repository=registry.example.com/coolscaler/coolscaler \
  --set image.tag=1.2.0 \
  --set clusterName=example-cluster --wait

# 3. Open the dashboard
kubectl -n coolscaler-system port-forward svc/coolscaler-dashboards 8088:8080
open http://localhost:8088
```

Give Prometheus a couple of minutes to collect history before expecting
recommendations.

To let CoolScaler change things (updater applies, webhook mutates):

```bash
helm upgrade coolscaler charts/coolscaler -n coolscaler-system --reuse-values --set readOnly=false
kubectl label namespace <your-namespace> coolscaler.sh/optimize=true
```

## Documentation

- [docs/architecture.md](docs/architecture.md): components, data flow, CRDs, API.
- [docs/install.md](docs/install.md): building the image, Helm install, exposure options, upgrades, uninstall.
- [docs/configuration.md](docs/configuration.md): every chart value and environment variable that matters.
- [docs/security.md](docs/security.md): read-only mode, RBAC scope, the admission webhook's failure policy, what to review before enabling automation.
- [docs/development.md](docs/development.md): building, running locally, tests, dependency licenses.

## Limitations

- The network monitor is a stub; there is no eBPF or L7 traffic observability, so
  network-cost and API-latency views show what the stub can see, which is little.
- Node pool automation for cloud autoscalers (Karpenter, cluster autoscaler node
  pools) is not implemented.
- Tested only on small clusters. Expect rough edges on large ones.
- The Go packages have unit tests, the web app has none, and `scripts/test.sh` is
  a smoke suite that needs a live installation.
- No figures about savings are claimed anywhere in this repository; what the
  dashboard shows is computed from your own cluster and your own cost model.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
