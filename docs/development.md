# Development

## Layout

```
app/cmd/coolscaler      main.go: cobra root + one subcommand per component
app/internal/api        Gin routes for /api/*
app/internal/engine     recommendation engine, cost model, policies, analytics, actions
app/internal/server     component runners: recommendation, dashboard, agent, updater, admissions, worker, leases
app/internal/webhook    mutating admission logic and certificate handling
app/internal/crds       embedded CRD manifests
app/internal/kube       thin API-server client (REST paths, order-preserving JSON)
app/internal/prom       Prometheus query client
app/internal/pyjson     order-preserving JSON encoder/decoder used by the API
app/web                 React + TypeScript + MUI dashboard (Vite)
charts/coolscaler       Helm chart
scripts/build.sh        daemonless image build with crane
scripts/test.sh         smoke suite against a live installation
```

## Build and test

```bash
cd app && go build ./... && go vet ./... && go test ./...
cd app/web && npm ci && npm run typecheck && npm run build
helm lint charts/coolscaler && helm template x charts/coolscaler >/dev/null
```

Run a component locally against a kubeconfig context (read-only by default):

```bash
cd app && KUBE_CONTEXT=<context> PROMETHEUS_URL=http://localhost:9090 go run ./cmd/coolscaler recommendation
cd app/web && npm run dev     # proxies /api to http://localhost:8088 (port-forward the dashboards Service there)
```

`scripts/test.sh [context] [namespace]` needs a live installation and exercises
every component and endpoint.

## Dependency licenses

Go modules (see `app/go.mod`): Gin (MIT), zapr and zap (MIT), google/uuid (BSD-3),
prometheus/client_golang (Apache-2.0), cobra (Apache-2.0), Kubernetes api,
apimachinery, client-go, component-base, klog, utils (Apache-2.0),
controller-runtime (Apache-2.0), sigs.k8s.io/yaml (MIT and BSD-3). npm packages
(see `app/web/package.json`): React, react-dom, react-router-dom, MUI material and
icons, Emotion, Formik, Yup, Recharts, Zustand, Vite, TypeScript (all MIT), and
`@mui/x-data-grid` community edition (MIT; the Pro and Premium editions are
commercial and are not used). The container image bundles kube-state-metrics,
Prometheus and prometheus-config-reloader binaries from their upstream images
(Apache-2.0); they are not vendored in this repository.
