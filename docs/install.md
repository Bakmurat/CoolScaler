# Install

## Build the image

No image is published. Build one and push it to a registry your cluster can pull from.

With Docker:

```bash
docker build --build-arg VERSION=1.2.0 -t registry.example.com/coolscaler/coolscaler:1.2.0 .
docker push registry.example.com/coolscaler/coolscaler:1.2.0
```

Without a Docker daemon (needs `go`, `node`, `npm`, and `crane`):

```bash
crane auth login registry.example.com
REGISTRY=registry.example.com/coolscaler bash scripts/build.sh 1.2.0
```

Both routes bundle the same three upstream binaries (kube-state-metrics v2.10.1,
Prometheus v2.48.1, prometheus-config-reloader v0.71.2) next to the CoolScaler binary
and the built web app.

## Install with Helm

```bash
helm upgrade --install coolscaler charts/coolscaler \
  -n coolscaler-system --create-namespace \
  --set image.repository=registry.example.com/coolscaler/coolscaler \
  --set image.tag=1.2.0 \
  --set clusterName=example-cluster \
  --wait
```

Defaults: read-only, bundled Prometheus with a 10 Gi persistent volume and 30-day
retention, recommender with a 1 Gi persistent volume, dashboards exposed as a
NodePort on 30950. Clusters without a default StorageClass: set
`prometheus.storage={}` and `recommender.persistence.enabled=false` to use emptyDir.

## Reach the dashboard

- Port-forward: `kubectl -n coolscaler-system port-forward svc/coolscaler-dashboards 8088:8080` then http://localhost:8088
- NodePort: `http://<node-ip>:30950`
- Ingress: `--set ingress.enabled=true --set ingress.host=coolscaler.example.com`
- Istio: `--set istio.enabled=true --set istio.host=coolscaler.example.com --set istio.tlsCredentialName=<secret>`

## Enable automation

```bash
helm upgrade coolscaler charts/coolscaler -n coolscaler-system --reuse-values --set readOnly=false
kubectl label namespace <your-namespace> coolscaler.sh/optimize=true
```

Read [security.md](security.md) first.

## Upgrade

`helm upgrade` with the new `image.tag`. The agent reconciles CRDs on start
(`--update-crd=true`), which needs write access to CustomResourceDefinitions (granted
by the chart's ClusterRole).

## Uninstall

```bash
helm uninstall coolscaler -n coolscaler-system
kubectl delete crd -l app.kubernetes.io/part-of=coolscaler   # removes all CoolScaler custom resources
```
