# Configuration

All settings are Helm values (`charts/coolscaler/values.yaml`); the chart turns
them into environment variables on each component.

| Value | Default | Meaning |
|---|---|---|
| `clusterName` | `my-cluster` | Display name and the `CLUSTER_NAME` seen by the API |
| `readOnly` | `true` | Master safety switch: observe and recommend only |
| `image.repository` / `image.tag` | placeholder / `1.2.0` | Your built image |
| `rbac.create` | `true` | Create the ClusterRole and binding |
| `rbac.unrestricted` | `false` | Add a wildcard rule to the ClusterRole (escape hatch, see security.md) |
| `engine.sampleIntervalSeconds` | `30` | Sampling cadence |
| `engine.historyPoints` | `1440` | Rolling in-memory history length |
| `engine.cpuPercentile` / `engine.memPercentile` | `93` / `93` | Percentile of usage used for the recommendation |
| `engine.cpuHeadroom` / `engine.memHeadroom` | `1.10` / `1.05` | Multiplier applied on top of the percentile |
| `engine.promWindow` / `engine.promStep` | `24h` / `5m` | Prometheus history window and step |
| `costModel.cpuCoreMonth` / `memGbMonth` / `gpuHourly` / `spotFraction` | see file | Prices used to value the gap |
| `priorityClasses.*` | create | PriorityClasses for CoolScaler's own pods and for headroom pods |
| `java.enabled` / `java.observability.enabled` | `false` | JVM observability: injects a JMX exporter agent into Java pods in opted-in namespaces |
| `workloadAutomation.*` | empty | Include/exclude lists (types, labels, annotations) for automation |
| `namespaceAutomation.*` | empty | Namespace include/exclude by label |
| `clusterAutomation.*` | off | Seeds cluster-wide automation defaults on first install |
| `recommender`, `dashboards`, `agent`, `updater`, `admissions`, `kubeStateMetrics`, `prometheus`, `networkMonitor` | see file | Per-component replicas, resources, persistence, service type |
| `ingress.*` / `istio.*` | disabled | Exposure |

Engine environment variables read by the binary (for local runs): `READ_ONLY`,
`WRITE_ENABLED`, `CLUSTER_NAME`, `NAMESPACE`, `PROMETHEUS_URL`, `PROM_WINDOW`,
`PROM_STEP`, `SAMPLE_INTERVAL_SECONDS`, `HISTORY_POINTS`, `CPU_PERCENTILE`,
`MEM_PERCENTILE`, `CPU_HEADROOM`, `MEM_HEADROOM`, `CPU_FLOOR_CORES`,
`MEM_FLOOR_BYTES`, `EPH_*`, `LOWERBOUND_PERCENTILE`, `UPPERBOUND_PERCENTILE`,
`UPPERBOUND_MARGIN`, `EXCLUDE_CONTAINERS`, `RECOMMENDER_URL`,
`UPDATER_INTERVAL_SECONDS`, `AGENT_INTERVAL_SECONDS`, `MIN_APPLY_SAVINGS`,
`TLS_DIR`, `WRITE_RECOMMENDATION_CRS`, `LEASE_DURATION_SECONDS`, `KUBE_CONTEXT`
(out-of-cluster only), `JAVA_OPTIMIZATION_ENABLED`, `JMX_AGENT_IMAGE`,
`JMX_AGENT_JAR`. Defaults are in `app/internal/config/config.go`.

Settings changed in the dashboard (automation config, ignored namespaces, cost
config, alert settings, Slack, custom dashboards) persist in ConfigMaps in the
release namespace and survive `helm upgrade`.
