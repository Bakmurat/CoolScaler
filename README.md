# CoolScaler

**Stop paying for Kubernetes capacity you never use.**

CoolScaler is an open-source Kubernetes workload right-sizing and cost-optimization platform. Resource requests
are set once, by guess, and then never revisited, so most clusters run at a fraction of what they reserve while the
bill reflects the reservation. CoolScaler measures what every Deployment, StatefulSet, and DaemonSet actually uses,
recommends CPU and memory requests that fit with statistical headroom, prices the gap between requests and usage in
your own cost model, and, only when you switch it on, applies the recommendations for you, safely, at the moment
pods are created. One container image, a handful of cooperating components, and a full web dashboard.

Personal project by its sole author, [Bakmurat Kubanaliev](https://github.com/Bakmurat); inspired by commercial
Kubernetes right-sizing products; released under the Apache License 2.0.

## Why it matters

- **Right-sizing is the largest untouched lever in most clusters.** Requests drive scheduling and node count; every
  over-request is capacity you pay for and cannot use.
- **Recommendations nobody applies are worthless.** CoolScaler closes the loop: an updater patches automated
  workloads and a mutating admission webhook injects the right requests into new pods, so the fix lands without a
  ticket.
- **Automation must be earned.** Everything installs read-only. Mutation is opt-in per namespace, the updater is
  leader-elected, RBAC is explicit, and every change is recorded in the audit view.
- **Cost is a first-class signal.** Recommendations carry a price, so teams see the money, not just the millicores.

## Capabilities

| Capability | What it delivers |
|---|---|
| **Workload discovery** | Walks pod `ownerReferences` to find every Deployment, StatefulSet, DaemonSet, and their HPAs and KEDA ScaledObjects. |
| **Usage measurement** | Bundled Prometheus (cAdvisor and kube-state-metrics) with 30-day retention by default, plus `metrics.k8s.io` for live values. |
| **Percentile recommendations** | Requests sized at a configurable percentile plus headroom over a configurable window (defaults: P93, +10% CPU, +5% memory, 24 hours). |
| **Cost model** | Prices the request-versus-recommendation gap; per-cluster pricing you control. |
| **Policies as CRDs** | `Policy`, `Recommendation`, `HpaPolicy`, `DownscalerPolicy` and more under `analysis.coolscaler.sh/v1alpha1`; built-in policy catalog, custom policies. |
| **Safe automation** | Updater for automated workloads; mutating admission webhook for pods, HPAs, and KEDA ScaledObjects in namespaces labeled `coolscaler.sh/optimize=true`. |
| **Replica and schedule optimization** | HPA policy tuning and time-based downscaling of non-production environments. |
| **Dashboard** | Savings, right-sizing, replicas, scheduling, node management, cluster headroom, JVM observability, cost reports, alerts, and audit events. |
| **Security posture** | Read-only by default, explicit RBAC rules derived from the API paths the code calls, documented webhook failure policy. |

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

## Status

CoolScaler is an actively developed personal project. It runs end to end in the author's own Kubernetes
environment (RKE2 on Harvester), where the recommender, updater, admission webhook, and dashboard operate against
real workloads. No prebuilt image is published yet: build your own and point the chart at your registry. No savings
figures are claimed in this repository; what the dashboard shows is computed from your cluster and your cost model.

## Roadmap

1. Prebuilt, signed container images and a published Helm repository.
2. eBPF-based network and L7 observability to replace the network-monitor stub.
3. Node-pool automation for Karpenter and Cluster Autoscaler node groups.
4. Large-cluster and long-duration benchmarks; web-app test suite.
5. Independent security review before automation is recommended for regulated environments.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
