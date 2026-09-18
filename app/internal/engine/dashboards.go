package engine

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"coolscaler.sh/coolscaler/internal/pyjson"
)

// Analytics Dashboards: a chart catalog, a builtin "Performance" dashboard,
// user dashboards persisted in the coolscaler-dashboards-config ConfigMap,
// and a cluster-scope data endpoint with namespace/type/workload filters over
// an arbitrary time range. charts with no data return empty series — never
// fabricated.

const dashboardsCM = "coolscaler-dashboards-config"

// dashChart is one catalog entry. kind: "line" | "multi" (per-entity lines) | "events"
// (scatter-style event points). GPU / Node-I/O-via-node-exporter / Karpenter charts are
// scope-cut.
type dashChart struct {
	id, title, unit, kind, cat string
}

// dashChartCatalog is the selectable chart set, grouped by category. charts
// with no data in the window render honestly empty — nothing is fabricated.
var dashChartCatalog = []dashChart{
	// ---- Optimization ----
	{"automation-events", "Automation Events", "count", "events", "Optimization"},
	{"optimized-pods", "Optimized Pods", "count", "multi", "Optimization"},
	{"automated-workloads", "Automated Workloads", "count", "multi", "Optimization"},
	{"downscaled-workloads", "Downscaled Workloads", "count", "line", "Optimization"},
	// ---- Performance ----
	{"cpu-underprovisioned-stressed", "CPU Under Provisioned Workloads on Stressed Nodes", "count", "line", "Performance"},
	{"memory-underprovisioned-stressed", "Memory Under Provisioned Workloads on Stressed Nodes", "count", "line", "Performance"},
	{"workload-disruptions", "Workload Disruptions", "count", "events", "Performance"},
	{"oom-events", "Out-of-Memory Events", "count", "events", "Performance"},
	{"downtime-events", "Downtime Events", "count", "line", "Performance"},
	{"cpu-throttling", "CPU Throttling", "ratio", "line", "Performance"},
	{"liveness-probe-failures", "Liveness Probe Failures", "count", "line", "Performance"},
	{"container-restarts", "Container Restarts", "count", "line", "Performance"},
	{"cpu-requests-by-type", "CPU Requests by Workload Type", "cores", "multi", "Performance"},
	{"memory-requests-by-type", "Memory Requests by Workload Type", "bytes", "multi", "Performance"},
	{"most-disruptive-workloads", "Most Disruptive Workloads", "count", "multi", "Performance"},
	{"node-disruptions", "Node Disruptions", "count", "line", "Performance"},
	{"healing-statuses", "CoolScaler Healing Statuses", "count", "multi", "Performance"},
	// ---- Replicas ----
	{"pod-count", "Pod Count", "count", "line", "Replicas"},
	{"hpa-current-replicas", "HPA Scale Events", "count", "multi", "Replicas"},
	{"hpa-trigger-change", "HPA Resource Trigger Change Events", "count", "multi", "Replicas"},
	{"replicas-increase", "Replicas Increase", "count", "line", "Replicas"},
	// ---- Cost ----
	{"cpu-allocatable", "CPU Allocatable", "cores", "line", "Cost"},
	{"memory-allocatable", "Memory Allocatable", "bytes", "line", "Cost"},
	{"cluster-cpu", "CPU Usage vs Request", "cores", "line", "Cost"},
	{"cluster-memory", "Memory Usage vs Request", "bytes", "line", "Cost"},
	{"wasted-cpu", "Wasted CPU", "cores", "line", "Cost"},
	{"wasted-memory", "Wasted Memory", "bytes", "line", "Cost"},
	{"init-cpu-overhead", "Init Container CPU Request Overhead", "cores", "line", "Cost"},
	{"init-memory-overhead", "Init Container Memory Request Overhead", "bytes", "line", "Cost"},
	{"expensive", "Expensive", "usd", "multi", "Cost"},
	{"wasteful", "Wasteful", "usd", "multi", "Cost"},
	{"cpu-request-increase", "CPU Request Increase", "count", "line", "Cost"},
	{"memory-request-increase", "Memory Request Increase", "count", "line", "Cost"},
	// ---- Nodes ----
	{"node-cpu-utilization", "Node CPU Utilization", "ratio", "multi", "Nodes"},
	{"node-memory-utilization", "Node Memory Utilization", "ratio", "multi", "Nodes"},
	{"pods-per-node", "Pods per Node", "count", "multi", "Nodes"},
	{"node-avg-load", "Node Average Load", "count", "multi", "Nodes"},
	{"node-cpu-allocation", "Node CPU Allocation", "cores", "multi", "Nodes"},
	{"node-memory-allocation", "Node Memory Allocation", "bytes", "multi", "Nodes"},
	{"node-eph-utilization", "Node Ephemeral Storage Utilization", "ratio", "multi", "Nodes"},
	{"node-eph-allocation", "Node Ephemeral Storage Allocation", "bytes", "multi", "Nodes"},
	{"node-conditions", "Node Conditions", "count", "multi", "Nodes"},
	{"node-instance-type", "Node Instance Type", "count", "multi", "Nodes"},
	{"node-lifecycle", "Node Life Cycle", "count", "multi", "Nodes"},
	{"node-not-scaling-down", "Node not Scaling Down Reason", "count", "line", "Nodes"},
	{"node-blocked-cpu", "Node Allocatable CPU Blocked by Reason", "cores", "line", "Nodes"},
	{"node-blocked-memory", "Node Allocatable Memory Blocked by Reason", "bytes", "line", "Nodes"},
	// ---- CoolScaler Workloads ----
	{"coolscaler-cpu-usage", "CoolScaler CPU Usage", "cores", "multi", "CoolScaler Workloads"},
	{"coolscaler-memory-usage", "CoolScaler Memory Usage", "bytes", "multi", "CoolScaler Workloads"},
	{"coolscaler-cpu-requests", "CoolScaler CPU Requests", "cores", "line", "CoolScaler Workloads"},
	{"coolscaler-memory-requests", "CoolScaler Memory Requests", "bytes", "line", "CoolScaler Workloads"},
	{"prometheus-tsdb-size", "CoolScaler Prometheus Volume", "bytes", "line", "CoolScaler Workloads"},
	{"prometheus-retention", "CoolScaler Prometheus Retention", "int", "line", "CoolScaler Workloads"},
	// ---- Pressure Stall (PSI) ----
	{"psi-cpu", "Node CPU Wait Time (%)", "ratio", "multi", "Pressure Stall (PSI)"},
	{"psi-memory", "Node Memory Wait Time (%)", "ratio", "multi", "Pressure Stall (PSI)"},
	{"psi-io", "Node Disk I/O Wait Time (%)", "ratio", "multi", "Pressure Stall (PSI)"},
	// ---- Resource Quotas ----
	{"quota-cpu-requests", "Namespace Limitation by CPU Requests", "ratio", "multi", "Resource Quotas"},
	{"quota-memory-requests", "Namespace Limitation by Memory Requests", "ratio", "multi", "Resource Quotas"},
	{"quota-cpu-limits", "Namespace Limitation by CPU Limits", "ratio", "multi", "Resource Quotas"},
	{"quota-memory-limits", "Namespace Limitation by Memory Limits", "ratio", "multi", "Resource Quotas"},
	{"quota-pods", "Namespace Limitation by Pods", "ratio", "multi", "Resource Quotas"},
	{"quota-replicasets", "Namespace Limitation by Replica Sets", "ratio", "multi", "Resource Quotas"},
	// ---- Node I/O ----
	{"node-network-throughput", "Node Network Throughput", "bytes", "multi", "Node I/O"},
	{"node-network-throughput-agg", "Node Network Throughput (Aggregated)", "bytes", "multi", "Node I/O"},
	{"node-dropped-packets", "Total Network Dropped Packets per Node", "count", "multi", "Node I/O"},
	{"node-disk-throughput", "Node Disk Throughput", "bytes", "multi", "Node I/O"},
	{"node-disk-throughput-agg", "Node Disk Throughput (Aggregated)", "bytes", "multi", "Node I/O"},
	{"node-disk-iops", "Node Disk IOPS", "count", "multi", "Node I/O"},
	{"node-disk-iops-agg", "Node Disk IOPS (Aggregated)", "count", "multi", "Node I/O"},
	// late additions
	{"update-evictions", "CoolScaler Update Evictions", "count", "multi", "Optimization"},
	{"oom-limit-events", "Out-of-Memory Limit Events", "count", "events", "Performance"},
	{"oom-node-events", "Out-of-Memory Node Events", "count", "events", "Performance"},
	{"cpu-underprovisioned", "CPU Under Provisioned", "count", "line", "Performance"},
	{"memory-underprovisioned", "Memory Under Provisioned", "count", "line", "Performance"},
	{"container-exit-codes", "Container Exit Codes", "count", "multi", "Performance"},
	{"workloads-issues", "CoolScaler Workloads Issues", "count", "line", "CoolScaler Workloads"},
	{"version", "Version", "count", "multi", "CoolScaler Workloads"},
	{"smart-policy-waste", "Smart Policy Waste", "usd", "line", "Cost"},
}

var dashChartByID = func() map[string]dashChart {
	m := map[string]dashChart{}
	for _, c := range dashChartCatalog {
		m[c.id] = c
	}
	return m
}()

// builtinDashboards are the "Built in" dashboards. Each is a named, ordered chart set.
// Charts must exist in the catalog.
var builtinDashboards = []struct {
	name   string
	charts []string
}{
	{"Performance", []string{
		"node-cpu-utilization", "node-memory-utilization", "automation-events",
		"workload-disruptions", "oom-events", "downtime-events",
		"cpu-underprovisioned-stressed", "memory-underprovisioned-stressed", "cpu-throttling",
	}},
	{"Overall Costs", []string{
		"cpu-allocatable", "memory-allocatable", "cluster-cpu", "cluster-memory",
		"wasted-cpu", "wasted-memory", "init-cpu-overhead", "init-memory-overhead",
	}},
	{"CoolScaler Health", []string{
		"workloads-issues", "version", "coolscaler-cpu-requests",
		"coolscaler-memory-requests", "coolscaler-cpu-usage", "coolscaler-memory-usage",
		"prometheus-tsdb-size", "prometheus-retention",
	}},
	{"Advanced Performance", []string{
		"psi-cpu", "psi-memory", "psi-io", "pods-per-node",
		"node-network-throughput", "node-disk-throughput", "node-disk-iops", "node-dropped-packets",
	}},
}

func builtinDashboardCharts(name string) []any {
	for _, d := range builtinDashboards {
		if d.name == name {
			out := []any{}
			for _, c := range d.charts {
				out = append(out, c)
			}
			return out
		}
	}
	return []any{}
}

func isBuiltinDashName(name string) bool {
	for _, d := range builtinDashboards {
		if d.name == name {
			return true
		}
	}
	return false
}

func dashCatalogJSON() []any {
	out := []any{}
	for _, c := range dashChartCatalog {
		out = append(out, pyjson.NewObj().
			Set("id", c.id).
			Set("title", c.title).
			Set("unit", c.unit).
			Set("kind", c.kind).
			Set("category", c.cat))
	}
	return out
}

// loadCustomDashboards reads the persisted user dashboards; empty on any error.
func (e *Engine) loadCustomDashboards(ctx context.Context) []*pyjson.Obj {
	cm, err := e.Kube.GetJSON(ctx,
		"/api/v1/namespaces/"+e.Cfg.Namespace+"/configmaps/"+dashboardsCM)
	if err != nil {
		return nil
	}
	raw := getStr(getObj(cm, "data"), "config.json")
	if raw == "" {
		return nil
	}
	v, err := pyjson.Decode([]byte(raw))
	if err != nil {
		return nil
	}
	var out []*pyjson.Obj
	for _, dv := range getList(obj(v), "dashboards") {
		out = append(out, obj(dv))
	}
	return out
}

// saveCustomDashboards persists the user dashboards (PATCH-then-POST like the
// other config ConfigMaps; honors the WRITE_ENABLED gate).
func (e *Engine) saveCustomDashboards(ctx context.Context, dashboards []*pyjson.Obj) {
	lst := []any{}
	for _, d := range dashboards {
		lst = append(lst, d)
	}
	blob := string(pyjson.Marshal(pyjson.NewObj().Set("dashboards", lst)))
	cmPath := "/api/v1/namespaces/" + e.Cfg.Namespace + "/configmaps/" + dashboardsCM
	data := pyjson.NewObj().Set("config.json", blob)
	if _, err := e.k8sReq(ctx, "PATCH", cmPath,
		pyjson.NewObj().Set("data", data), "application/merge-patch+json"); err != nil {
		if _, ok := isHTTPError(err); ok {
			_, err2 := e.k8sReq(ctx, "POST", "/api/v1/namespaces/"+e.Cfg.Namespace+"/configmaps",
				pyjson.NewObj().
					Set("apiVersion", "v1").
					Set("kind", "ConfigMap").
					Set("metadata", pyjson.NewObj().
						Set("name", dashboardsCM).
						Set("namespace", e.Cfg.Namespace)).
					Set("data", data), "application/json")
			if err2 != nil {
				e.Log.Info("save_dashboards_cm failed", "err", err2)
			}
		} else {
			e.Log.Info("save_dashboards_cm failed", "err", err)
		}
	}
}

// DashboardsData is GET /api/dashboards: builtin + persisted user dashboards
// plus the selectable chart catalog.
func (e *Engine) DashboardsData(ctx context.Context) *pyjson.Obj {
	dashboards := []any{}
	for _, b := range builtinDashboards {
		dashboards = append(dashboards, pyjson.NewObj().
			Set("name", b.name).
			Set("builtin", true).
			Set("charts", builtinDashboardCharts(b.name)).
			Set("aggregation", "workloads"))
	}
	for _, d := range e.loadCustomDashboards(ctx) {
		if isBuiltinDashName(str(d.GetD("name", ""))) {
			continue // builtin names are reserved
		}
		dashboards = append(dashboards, pyjson.NewObj().
			Set("name", d.GetD("name", "")).
			Set("builtin", false).
			Set("charts", d.GetD("charts", []any{})).
			Set("aggregation", d.GetD("aggregation", "workloads")))
	}
	return pyjson.NewObj().
		Set("dashboards", dashboards).
		Set("catalog", dashCatalogJSON())
}

// SaveDashboard is POST /api/dashboards/save {name, charts, aggregation}.
func (e *Engine) SaveDashboard(ctx context.Context, body *pyjson.Obj) (int, *pyjson.Obj) {
	name := strings.TrimSpace(str(body.GetD("name", "")))
	if name == "" {
		return 400, pyjson.NewObj().Set("error", "name required")
	}
	if isBuiltinDashName(name) {
		return 400, pyjson.NewObj().Set("error", "builtin dashboard is locked")
	}
	charts := []any{}
	for _, cv := range getList(body, "charts") {
		if _, ok := dashChartByID[str(cv)]; ok {
			charts = append(charts, str(cv))
		}
	}
	if len(charts) == 0 {
		return 400, pyjson.NewObj().Set("error", "at least one known chart id required")
	}
	agg := str(body.GetD("aggregation", "workloads"))
	if agg == "" {
		agg = "workloads"
	}
	existing := e.loadCustomDashboards(ctx)
	var out []*pyjson.Obj
	replaced := false
	for _, d := range existing {
		if str(d.GetD("name", "")) == name {
			replaced = true
			continue
		}
		out = append(out, d)
	}
	out = append(out, pyjson.NewObj().
		Set("name", name).
		Set("charts", charts).
		Set("aggregation", agg))
	e.saveCustomDashboards(ctx, out)
	e.audit("dashboard-save", name, "", fmt.Sprintf("%d charts", len(charts)), "user")
	return 200, pyjson.NewObj().Set("ok", true).Set("updated", replaced)
}

// DeleteDashboard is POST /api/dashboards/delete {name} (builtin locked).
func (e *Engine) DeleteDashboard(ctx context.Context, body *pyjson.Obj) (int, *pyjson.Obj) {
	name := strings.TrimSpace(str(body.GetD("name", "")))
	if name == "" {
		return 400, pyjson.NewObj().Set("error", "name required")
	}
	if isBuiltinDashName(name) {
		return 400, pyjson.NewObj().Set("error", "builtin dashboard is locked")
	}
	existing := e.loadCustomDashboards(ctx)
	var out []*pyjson.Obj
	found := false
	for _, d := range existing {
		if str(d.GetD("name", "")) == name {
			found = true
			continue
		}
		out = append(out, d)
	}
	if !found {
		return 404, pyjson.NewObj().Set("error", "dashboard not found")
	}
	e.saveCustomDashboards(ctx, out)
	e.audit("dashboard-delete", name, "", "", "user")
	return 200, pyjson.NewObj().Set("ok", true)
}

var dashRangeSeconds = map[string]int64{
	"1h": 3600, "6h": 21600, "24h": 86400, "1d": 86400,
	"3d": 259200, "7d": 604800, "2w": 1209600, "30d": 2592000,
}

// DashFilters narrows the workload scope of the data endpoint.
type DashFilters struct {
	Namespaces []string // exact namespace names
	Types      []string // workload kinds (Deployment/StatefulSet/...)
	Workloads  []string // workload names or "ns/kind/name" keys
}

func (f DashFilters) empty() bool {
	return len(f.Namespaces) == 0 && len(f.Types) == 0 && len(f.Workloads) == 0
}

// dashSelector resolves the filters against the live workload inventory into
// prometheus matcher fragments (`,namespace=~"..."` / `,pod=~"(...)-.*"`).
// Returns matched=false when filters are set but match nothing (charts then
// render honestly empty).
func (e *Engine) dashSelector(f DashFilters) (nsSel, podSel string, matched bool) {
	if f.empty() {
		return "", "", true
	}
	nsWant := map[string]bool{}
	for _, n := range f.Namespaces {
		nsWant[n] = true
	}
	tWant := map[string]bool{}
	for _, t := range f.Types {
		tWant[t] = true
	}
	wWant := map[string]bool{}
	for _, w := range f.Workloads {
		wWant[w] = true
	}
	e.mu.Lock()
	wls := append([]*wlRow(nil), e.workloads...)
	e.mu.Unlock()
	nsSet := map[string]bool{}
	nameSet := map[string]bool{}
	for _, w := range wls {
		if len(nsWant) > 0 && !nsWant[w.namespace] {
			continue
		}
		if len(tWant) > 0 && !tWant[w.kind] {
			continue
		}
		if len(wWant) > 0 && !wWant[w.name] && !wWant[w.key] {
			continue
		}
		nsSet[w.namespace] = true
		nameSet[w.name] = true
	}
	if len(nameSet) == 0 {
		return "", "", false
	}
	san := func(s string) string { return podNameSanitizeRe.ReplaceAllString(s, "") }
	var nss, names []string
	for _, n := range sortedKeys(nsSet) {
		nss = append(nss, san(n))
	}
	for _, n := range sortedKeys(nameSet) {
		names = append(names, san(n))
	}
	nsSel = fmt.Sprintf(`,namespace=~"%s"`, strings.Join(nss, "|"))
	podSel = fmt.Sprintf(`,namespace=~"%s",pod=~"(%s)-.*"`,
		strings.Join(nss, "|"), strings.Join(names, "|"))
	return nsSel, podSel, true
}

// nodeAggSeries renders the "(Aggregated)" chart variants: Average / p90 / Max
// statistics computed across the per-node series of `perNode` (a PromQL
// expression grouped `by(node)`).
func (e *Engine) nodeAggSeries(ctx context.Context, perNode string, start, end, step int64) []any {
	avg := e.promAgg(ctx, "avg("+perNode+")", start, end, step, "avg")
	p90 := e.promAgg(ctx, "quantile(0.90, "+perNode+")", start, end, step, "avg")
	mx := e.promAgg(ctx, "max("+perNode+")", start, end, step, "avg")
	return []any{
		tsLinePts("Average", "#3b82f6", avg, false),
		tsLinePts("p90", "#8b5cf6", p90, false),
		tsLinePts("Max", "#ef4444", mx, false),
	}
}

// quotaByNs returns the per-namespace used/hard percentage for a ResourceQuota
// resource (requests.cpu / limits.memory / pods / count/replicasets...) — the
// Resource-Quota Troubleshoot charts. Honest-empty when no ResourceQuota exists.
func (e *Engine) quotaByNs(ctx context.Context, resource string, start, end, step int64) []any {
	return e.promByLabel(ctx, fmt.Sprintf(
		`100 * sum by(namespace)(kube_resourcequota{resource="%s",type="used"})`+
			` / clamp_min(sum by(namespace)(kube_resourcequota{resource="%s",type="hard"}),1)`,
		resource, resource), start, end, step, "namespace")
}

// eventPoints keeps only non-zero points (scatter-style event series).
func eventPoints(pts []any) []any {
	out := []any{}
	for _, pv := range pts {
		p := obj(pv)
		if f64d(p.GetD("v", 0.0), 0) > 0 {
			out = append(out, p)
		}
	}
	return out
}

// auditEventSeries buckets the in-memory audit log into event points.
func (e *Engine) auditEventSeries(start, end, step int64) []any {
	e.mu.Lock()
	entries := append([]*pyjson.Obj(nil), e.auditLog...)
	e.mu.Unlock()
	bucket := map[int64]float64{}
	for _, ent := range entries {
		t, err := time.Parse("2006-01-02T15:04:05Z", str(ent.GetD("timestamp", "")))
		if err != nil {
			continue
		}
		u := t.Unix()
		if u < start || u > end {
			continue
		}
		bucket[start+((u-start)/step)*step]++
	}
	var ts []int64
	for t := range bucket {
		ts = append(ts, t)
	}
	sort.Slice(ts, func(i, j int) bool { return ts[i] < ts[j] })
	pts := []any{}
	for _, t := range ts {
		pts = append(pts, pyjson.NewObj().Set("t", t*1000).Set("v", bucket[t]))
	}
	return pts
}

// DashboardsChartData is GET /api/dashboards/data: per-chart series over an
// arbitrary range, cluster scope, honoring the workload filters.
func (e *Engine) DashboardsChartData(ctx context.Context, chartIDs []string,
	rng string, from, to *int64, aggregation string, filters DashFilters) *pyjson.Obj {
	secs, ok := dashRangeSeconds[rng]
	if !ok {
		secs = 86400
	}
	end := time.Now().Unix()
	start := end - secs
	if from != nil && *from > 0 {
		start = *from
	}
	if to != nil && *to > 0 {
		end = *to
	}
	if end <= start {
		end = start + 3600
	}
	step := (end - start) / 200
	if step < 60 {
		step = 60
	}
	nsSel, podSel, matched := e.dashSelector(filters)
	colors := []string{"#4f46e5", "#0ea5e9", "#f59e0b", "#22c55e", "#ec4899",
		"#14b8a6", "#a855f7", "#ef4444", "#84cc16", "#f97316", "#06b6d4", "#6366f1"}
	// cadvisor / KSM matcher fragments
	cSel := `container!="",container!="POD"` + podSel
	if aggregation == "" {
		aggregation = "workloads"
	}

	charts := []any{}
	for _, id := range chartIDs {
		meta, ok := dashChartByID[id]
		if !ok {
			continue
		}
		ch := pyjson.NewObj().
			Set("id", meta.id).Set("title", meta.title).
			Set("unit", meta.unit).Set("kind", meta.kind)
		series := []any{}
		if matched {
			switch meta.id {
			case "node-cpu-utilization":
				// node-exporter when present; else the kubelet/cAdvisor
				// machine-level metrics (root cgroup / machine_cpu_cores).
				per := e.promByLabel(ctx,
					`1 - avg by(instance)(rate(node_cpu_seconds_total{mode="idle"}[5m]))`,
					start, end, step, "instance")
				if len(per) == 0 {
					per = e.promByLabel(ctx,
						`sum by(instance)(rate(container_cpu_usage_seconds_total{id="/"}[5m]))`+
							` / on(instance) sum by(instance)(machine_cpu_cores)`,
						start, end, step, "instance")
				}
				series = multiSeries(per, colors, "Utilization")
			case "node-memory-utilization":
				per := e.promByLabel(ctx,
					`1 - (node_memory_MemAvailable_bytes / clamp_min(node_memory_MemTotal_bytes,1))`,
					start, end, step, "instance")
				if len(per) == 0 {
					per = e.promByLabel(ctx,
						`sum by(instance)(container_memory_working_set_bytes{id="/"})`+
							` / on(instance) sum by(instance)(machine_memory_bytes)`,
						start, end, step, "instance")
				}
				series = multiSeries(per, colors, "Utilization")
			case "automation-events":
				series = []any{tsLinePts("Automation actions", "#6366f1",
					e.auditEventSeries(start, end, step), false)}
			case "workload-disruptions":
				pts := e.promAgg(ctx, fmt.Sprintf(
					`sum(kube_pod_status_reason{reason=~"Evicted|NodeLost|Shutdown|NodeAffinity|UnexpectedAdmissionError"%s})`,
					podSel), start, end, step, "max")
				series = []any{tsLinePts("Disruptions", "#4f46e5", eventPoints(pts), false)}
			case "oom-events":
				pts := e.promAgg(ctx, fmt.Sprintf(
					`sum(increase(kube_pod_container_status_terminated_reason{reason="OOMKilled"%s}[5m]))`,
					podSel), start, end, step, "max")
				series = []any{tsLinePts("OOM kills", "#dc2626", eventPoints(pts), false)}
			case "downtime-events":
				pts := e.promAgg(ctx, fmt.Sprintf(
					`count(kube_deployment_status_replicas_unavailable{%s} > 0)`,
					strings.TrimPrefix(nsSel, ",")), start, end, step, "max")
				series = []any{tsLinePts("Workloads with unavailable replicas", "#22c55e", pts, false)}
			case "cpu-underprovisioned-stressed":
				pts := e.promAgg(ctx, fmt.Sprintf(
					`count(sum by(namespace,pod)(rate(container_cpu_usage_seconds_total{%s}[5m]))`+
						` > on(namespace,pod) sum by(namespace,pod)`+
						`(kube_pod_container_resource_requests{resource="cpu",container!=""%s}))`,
					cSel, podSel), start, end, step, "max")
				series = []any{tsLinePts("Under-provisioned workloads", "#f59e0b", pts, false)}
			case "memory-underprovisioned-stressed":
				pts := e.promAgg(ctx, fmt.Sprintf(
					`count(sum by(namespace,pod)(container_memory_working_set_bytes{%s})`+
						` > on(namespace,pod) sum by(namespace,pod)`+
						`(kube_pod_container_resource_requests{resource="memory",container!=""%s}))`,
					cSel, podSel), start, end, step, "max")
				series = []any{tsLinePts("Under-provisioned workloads", "#ef4444", pts, false)}
			case "cpu-throttling":
				pts := e.promAgg(ctx, fmt.Sprintf(
					`sum(rate(container_cpu_cfs_throttled_periods_total{%s}[5m]))`+
						`/clamp_min(sum(rate(container_cpu_cfs_periods_total{%s}[5m])),1)`,
					cSel, cSel), start, end, step, "avg")
				series = []any{tsLinePts("Throttled periods", "#b45309", pts, false)}
			case "liveness-probe-failures":
				pts := e.promAgg(ctx, fmt.Sprintf(
					`sum(increase(prober_probe_total{probe_type="Liveness",result!="successful"%s}[5m]))`,
					podSel), start, end, step, "max")
				series = []any{tsLinePts("Failures", "#f59e0b", eventPoints(pts), false)}
			case "container-restarts":
				pts := e.promAgg(ctx, fmt.Sprintf(
					`sum(kube_pod_container_status_restarts_total{%s})`,
					strings.TrimPrefix(podSel, ",")), start, end, step, "max")
				series = []any{tsLinePts("Restarts", "#ef4444", pts, false)}
			case "cluster-cpu":
				use := e.promAgg(ctx, fmt.Sprintf(
					`sum(rate(container_cpu_usage_seconds_total{%s}[5m]))`, cSel),
					start, end, step, "avg")
				req := e.promAgg(ctx, fmt.Sprintf(
					`sum(kube_pod_container_resource_requests{resource="cpu",container!=""%s})`, podSel),
					start, end, step, "avg")
				series = []any{
					tsLinePts("Usage", "#3b82f6", use, false),
					tsLinePts("Request", "#f59e0b", req, false)}
			case "cluster-memory":
				use := e.promAgg(ctx, fmt.Sprintf(
					`sum(container_memory_working_set_bytes{%s})`, cSel),
					start, end, step, "avg")
				req := e.promAgg(ctx, fmt.Sprintf(
					`sum(kube_pod_container_resource_requests{resource="memory",container!=""%s})`, podSel),
					start, end, step, "avg")
				series = []any{
					tsLinePts("Usage", "#3b82f6", use, false),
					tsLinePts("Request", "#f59e0b", req, false)}
			// ---- Optimization ----
			case "optimized-pods":
				auto := e.promAgg(ctx, `coolscaler_sum_automated_pods_count`, start, end, step, "avg")
				total := e.promAgg(ctx, `coolscaler_sum_pods_count`, start, end, step, "avg")
				series = []any{
					tsLinePts("Pods with automation", "#16a34a", auto, false),
					tsLinePts("Total pods", "#4f46e5", total, false)}
			case "automated-workloads":
				auto := e.promAgg(ctx, `coolscaler_total_automated_workloads`, start, end, step, "avg")
				total := e.promAgg(ctx,
					`coolscaler_total_automated_workloads + coolscaler_total_unautomated_workloads`,
					start, end, step, "avg")
				series = []any{
					tsLinePts("Workloads with automation", "#16a34a", auto, false),
					tsLinePts("Total workloads", "#4f46e5", total, false)}
			// ---- Performance (requests by workload type) ----
			case "cpu-requests-by-type":
				per := e.promByLabel(ctx, fmt.Sprintf(
					`sum by(owner_type)(coolscaler_pod_container_resource_requests{resource="cpu"%s})`, nsSel),
					start, end, step, "owner_type")
				series = multiSeries(per, colors, "CPU requests")
			case "memory-requests-by-type":
				per := e.promByLabel(ctx, fmt.Sprintf(
					`sum by(owner_type)(coolscaler_pod_container_resource_requests{resource="memory"%s})`, nsSel),
					start, end, step, "owner_type")
				series = multiSeries(per, colors, "Memory requests")
			// ---- Replicas ----
			case "pod-count":
				pts := e.promAgg(ctx, `coolscaler_sum_pods_count`, start, end, step, "avg")
				series = []any{tsLinePts("Running pods", "#4f46e5", pts, false)}
			case "hpa-current-replicas":
				per := e.promByLabel(ctx,
					`max by(horizontalpodautoscaler)(kube_horizontalpodautoscaler_status_current_replicas)`,
					start, end, step, "horizontalpodautoscaler")
				series = multiSeries(per, colors, "Current replicas")
			// ---- Cost ----
			case "cpu-allocatable":
				pts := e.promAgg(ctx, `coolscaler_sum_cpu_kube_node_status_allocatable`, start, end, step, "avg")
				series = []any{tsLinePts("Allocatable CPU", "#3b82f6", pts, false)}
			case "memory-allocatable":
				pts := e.promAgg(ctx, `coolscaler_sum_memory_kube_node_status_allocatable`, start, end, step, "avg")
				series = []any{tsLinePts("Allocatable memory", "#3b82f6", pts, false)}
			case "wasted-cpu":
				pts := e.promAgg(ctx, fmt.Sprintf(
					`clamp_min(sum(kube_pod_container_resource_requests{resource="cpu",container!=""%s})`+
						` - sum(rate(container_cpu_usage_seconds_total{%s}[5m])), 0)`, podSel, cSel),
					start, end, step, "avg")
				series = []any{tsLinePts("Wasted CPU", "#f59e0b", pts, false)}
			case "wasted-memory":
				pts := e.promAgg(ctx, fmt.Sprintf(
					`clamp_min(sum(kube_pod_container_resource_requests{resource="memory",container!=""%s})`+
						` - sum(container_memory_working_set_bytes{%s}), 0)`, podSel, cSel),
					start, end, step, "avg")
				series = []any{tsLinePts("Wasted memory", "#f59e0b", pts, false)}
			case "init-cpu-overhead":
				pts := e.promAgg(ctx, fmt.Sprintf(
					`sum(kube_pod_init_container_resource_requests{resource="cpu"%s})`, podSel),
					start, end, step, "avg")
				series = []any{tsLinePts("Init container CPU request", "#a855f7", pts, false)}
			case "init-memory-overhead":
				pts := e.promAgg(ctx, fmt.Sprintf(
					`sum(kube_pod_init_container_resource_requests{resource="memory"%s})`, podSel),
					start, end, step, "avg")
				series = []any{tsLinePts("Init container memory request", "#a855f7", pts, false)}
			// ---- Nodes (I/O + density from cadvisor, no node-exporter) ----
			case "pods-per-node":
				per := e.promByLabel(ctx, `coolscaler_pod_count_per_node`, start, end, step, "node")
				series = multiSeries(per, colors, "Pods")
			case "node-network-throughput":
				per := e.promByLabel(ctx,
					`sum by(node)(rate(container_network_receive_bytes_total{id="/"}[5m])`+
						` + rate(container_network_transmit_bytes_total{id="/"}[5m]))`,
					start, end, step, "node")
				series = multiSeries(per, colors, "Throughput")
			case "node-disk-throughput":
				per := e.promByLabel(ctx,
					`sum by(node)(rate(container_fs_reads_bytes_total[5m])`+
						` + rate(container_fs_writes_bytes_total[5m]))`,
					start, end, step, "node")
				series = multiSeries(per, colors, "Throughput")
			case "node-disk-iops":
				per := e.promByLabel(ctx,
					`sum by(node)(rate(container_fs_reads_total[5m])`+
						` + rate(container_fs_writes_total[5m]))`,
					start, end, step, "node")
				series = multiSeries(per, colors, "IOPS")
			case "node-dropped-packets":
				per := e.promByLabel(ctx,
					`sum by(node)(rate(container_network_receive_packets_dropped_total{id="/"}[5m])`+
						` + rate(container_network_transmit_packets_dropped_total{id="/"}[5m]))`,
					start, end, step, "node")
				series = multiSeries(per, colors, "Dropped packets")
			// ---- CoolScaler Workloads (own namespace) ----
			case "coolscaler-cpu-usage":
				// group by derived workload name (strip the ReplicaSet+pod hash)
				// so pod churn over the window collapses to ~one line/component
				// instead of hundreds of dead per-pod series.
				per := e.promByLabel(ctx, fmt.Sprintf(
					`sum by(workload)(label_replace(label_replace(`+
						`sum by(pod)(rate(container_cpu_usage_seconds_total{namespace="%s",container!="",container!="POD"}[5m])),`+
						`"workload","$1","pod","^(.+)-[a-z0-9]{5}$"),`+
						`"workload","$1","workload","^(.+)-[0-9a-f]{6,10}$"))`,
					e.Cfg.Namespace), start, end, step, "workload")
				series = multiSeries(per, colors, "CPU usage")
			case "coolscaler-memory-usage":
				per := e.promByLabel(ctx, fmt.Sprintf(
					`sum by(workload)(label_replace(label_replace(`+
						`sum by(pod)(container_memory_working_set_bytes{namespace="%s",container!="",container!="POD"}),`+
						`"workload","$1","pod","^(.+)-[a-z0-9]{5}$"),`+
						`"workload","$1","workload","^(.+)-[0-9a-f]{6,10}$"))`,
					e.Cfg.Namespace), start, end, step, "workload")
				series = multiSeries(per, colors, "Memory usage")
			case "coolscaler-cpu-requests":
				pts := e.promAgg(ctx, fmt.Sprintf(
					`sum(kube_pod_container_resource_requests{resource="cpu",container!="",namespace="%s"})`,
					e.Cfg.Namespace), start, end, step, "avg")
				series = []any{tsLinePts("CPU requests", "#3b82f6", pts, false)}
			case "coolscaler-memory-requests":
				pts := e.promAgg(ctx, fmt.Sprintf(
					`sum(kube_pod_container_resource_requests{resource="memory",container!="",namespace="%s"})`,
					e.Cfg.Namespace), start, end, step, "avg")
				series = []any{tsLinePts("Memory requests", "#3b82f6", pts, false)}
			case "prometheus-tsdb-size":
				pts := e.promAgg(ctx,
					`sum(prometheus_tsdb_storage_blocks_bytes) + sum(prometheus_tsdb_wal_storage_size_bytes)`,
					start, end, step, "avg")
				series = []any{tsLinePts("TSDB size", "#8b5cf6", pts, false)}
			// ---- Pressure Stall (PSI): cadvisor id="/" waiting rate, netmon fallback ----
			case "psi-cpu":
				per := e.promByLabel(ctx,
					`max by(node)(rate(container_pressure_cpu_waiting_seconds_total{id="/"}[5m])) * 100`,
					start, end, step, "node")
				if len(per) == 0 {
					per = e.promByLabel(ctx,
						`max by(node)(rate(coolscaler_node_pressure_cpu_waiting_seconds_total[5m])) * 100`,
						start, end, step, "node")
				}
				series = multiSeries(per, colors, "CPU wait %")
			case "psi-memory":
				per := e.promByLabel(ctx,
					`max by(node)(rate(container_pressure_memory_waiting_seconds_total{id="/"}[5m])) * 100`,
					start, end, step, "node")
				if len(per) == 0 {
					per = e.promByLabel(ctx,
						`max by(node)(rate(coolscaler_node_pressure_memory_waiting_seconds_total[5m])) * 100`,
						start, end, step, "node")
				}
				series = multiSeries(per, colors, "Memory wait %")
			case "psi-io":
				per := e.promByLabel(ctx,
					`max by(node)(rate(container_pressure_io_waiting_seconds_total{id="/"}[5m])) * 100`,
					start, end, step, "node")
				if len(per) == 0 {
					per = e.promByLabel(ctx,
						`max by(node)(rate(coolscaler_node_pressure_io_waiting_seconds_total[5m])) * 100`,
						start, end, step, "node")
				}
				series = multiSeries(per, colors, "I/O wait %")
			// ---- Resource Quotas (empty unless a ResourceQuota exists) ----
			case "quota-cpu-requests":
				per := e.promByLabel(ctx,
					`100 * sum by(namespace)(kube_resourcequota{resource="requests.cpu",type="used"})`+
						` / clamp_min(sum by(namespace)(kube_resourcequota{resource="requests.cpu",type="hard"}),1)`,
					start, end, step, "namespace")
				series = multiSeries(per, colors, "CPU quota %")
			case "quota-memory-requests":
				per := e.promByLabel(ctx,
					`100 * sum by(namespace)(kube_resourcequota{resource="requests.memory",type="used"})`+
						` / clamp_min(sum by(namespace)(kube_resourcequota{resource="requests.memory",type="hard"}),1)`,
					start, end, step, "namespace")
				series = multiSeries(per, colors, "Memory quota %")
			case "quota-cpu-limits":
				series = multiSeries(e.quotaByNs(ctx, "limits.cpu", start, end, step), colors, "CPU limit %")
			case "quota-memory-limits":
				series = multiSeries(e.quotaByNs(ctx, "limits.memory", start, end, step), colors, "Memory limit %")
			case "quota-pods":
				series = multiSeries(e.quotaByNs(ctx, "pods", start, end, step), colors, "Pods %")
			case "quota-replicasets":
				series = multiSeries(e.quotaByNs(ctx, "count/replicasets", start, end, step), colors, "ReplicaSets %")
			// ---- Performance (additional) ----
			case "most-disruptive-workloads":
				per := e.promByLabel(ctx,
					`topk(10, sum by(pod)(kube_pod_status_reason{reason=~"Evicted|NodeLost|Shutdown|NodeAffinity|UnexpectedAdmissionError"}))`,
					start, end, step, "pod")
				series = multiSeries(per, colors, "Disruptions")
			case "node-disruptions":
				pts := e.promAgg(ctx,
					`sum(changes(kube_node_status_condition{condition="Ready",status="true"}[10m]))`,
					start, end, step, "max")
				series = []any{tsLinePts("Node ready transitions", "#ef4444", eventPoints(pts), false)}
			// ---- Replicas (additional) ----
			case "hpa-trigger-change":
				per := e.promByLabel(ctx,
					`max by(horizontalpodautoscaler)(kube_horizontalpodautoscaler_spec_target_metric)`,
					start, end, step, "horizontalpodautoscaler")
				series = multiSeries(per, colors, "Target metric")
			case "replicas-increase":
				pts := e.promAgg(ctx,
					`sum(increase(kube_horizontalpodautoscaler_status_current_replicas[10m]) > bool 0)`,
					start, end, step, "max")
				series = []any{tsLinePts("HPAs scaled up", "#22c55e", pts, false)}
			// ---- Nodes (additional) ----
			case "node-cpu-allocation":
				per := e.promByLabel(ctx, `coolscaler_node_cpu_request`, start, end, step, "node")
				series = multiSeries(per, colors, "CPU requested")
			case "node-memory-allocation":
				per := e.promByLabel(ctx, `coolscaler_node_memory_request`, start, end, step, "node")
				series = multiSeries(per, colors, "Memory requested")
			case "node-eph-utilization":
				// root-fs usage ÷ root-fs LIMIT.
				per := e.promByLabel(ctx,
					`100 * max by(node)(container_fs_usage_bytes{id="/"})`+
						` / clamp_min(max by(node)(container_fs_limit_bytes{id="/"}),1)`,
					start, end, step, "node")
				series = multiSeries(per, colors, "Ephemeral %")
			case "node-eph-allocation":
				per := e.promByLabel(ctx,
					`sum by(node)(kube_pod_container_resource_requests{resource="ephemeral_storage"})`,
					start, end, step, "node")
				series = multiSeries(per, colors, "Ephemeral requested")
			case "node-conditions":
				per := e.promByLabel(ctx,
					`sum by(condition)(kube_node_status_condition{status="true",condition=~"Ready|MemoryPressure|DiskPressure|PIDPressure"})`,
					start, end, step, "condition")
				series = multiSeries(per, colors, "Nodes")
			case "node-instance-type":
				per := e.promByLabel(ctx,
					`count by(label_node_kubernetes_io_instance_type)(kube_node_labels)`,
					start, end, step, "label_node_kubernetes_io_instance_type")
				if len(per) == 0 {
					per = e.promByLabel(ctx, `count by(label_beta_kubernetes_io_instance_type)(kube_node_labels)`,
						start, end, step, "label_beta_kubernetes_io_instance_type")
				}
				series = multiSeries(per, colors, "Nodes")
			case "node-lifecycle":
				per := e.promByLabel(ctx,
					`count by(label_node_kubernetes_io_lifecycle)(kube_node_labels)`,
					start, end, step, "label_node_kubernetes_io_lifecycle")
				series = multiSeries(per, colors, "Nodes")
			case "node-not-scaling-down":
				// nodes pinned from scale-down by unevictable pods (pods→node join).
				pts := e.promAgg(ctx,
					`count(group by(node)(coolscaler_active_pods and on(namespace,pod) coolscaler_active_unevictable_pod_info))`,
					start, end, step, "max")
				series = []any{tsLinePts("Nodes blocked by unevictable pods", "#ef4444", pts, false)}
			case "node-blocked-cpu":
				pts := e.promAgg(ctx,
					`sum(max by(node)(kube_node_status_allocatable{resource="cpu"}) and on(node)`+
						` group by(node)(coolscaler_active_pods and on(namespace,pod) coolscaler_active_unevictable_pod_info))`,
					start, end, step, "avg")
				series = []any{tsLinePts("CPU blocked by unevictable pods", "#f59e0b", pts, false)}
			case "node-blocked-memory":
				pts := e.promAgg(ctx,
					`sum(max by(node)(kube_node_status_allocatable{resource="memory"}) and on(node)`+
						` group by(node)(coolscaler_active_pods and on(namespace,pod) coolscaler_active_unevictable_pod_info))`,
					start, end, step, "avg")
				series = []any{tsLinePts("Memory blocked by unevictable pods", "#ef4444", pts, false)}
			// ---- CoolScaler Workloads (additional) ----
			case "prometheus-retention":
				pts := e.promAgg(ctx,
					`(time() - min(prometheus_tsdb_lowest_timestamp_seconds)) / 86400`,
					start, end, step, "avg")
				series = []any{tsLinePts("Retention (days)", "#8b5cf6", pts, false)}
			// ---- Optimization / Performance / Cost (self-metric backed) ----
			case "downscaled-workloads":
				pts := e.promAgg(ctx, `coolscaler_workloads_downscaled`, start, end, step, "avg")
				series = []any{tsLinePts("Downscaled workloads", "#16a34a", pts, false)}
			case "healing-statuses":
				per := e.promByLabel(ctx, `max by(reason)(coolscaler_workloads_healing)`, start, end, step, "reason")
				series = multiSeries(per, colors, "Healing workloads")
			case "expensive":
				per := e.promByLabel(ctx,
					`topk(10, sum by(owner_name)(coolscaler_owner_hourly_cost_avg_1h)) * 730`,
					start, end, step, "owner_name")
				series = multiSeries(per, colors, "Monthly $")
			case "wasteful":
				per := e.promByLabel(ctx,
					`topk(10, sum by(owner_name)(coolscaler_owner_hourly_available_savings_cost_avg_1h)) * 730`,
					start, end, step, "owner_name")
				series = multiSeries(per, colors, "Reclaimable $/mo")
			case "cpu-request-increase":
				pts := e.promAgg(ctx,
					`count(sum by(namespace,owner_name)(delta(coolscaler_pod_container_resource_requests{resource="cpu"}[30m])) > bool 0)`,
					start, end, step, "max")
				series = []any{tsLinePts("Workloads increasing CPU request", "#f59e0b", pts, false)}
			case "memory-request-increase":
				pts := e.promAgg(ctx,
					`count(sum by(namespace,owner_name)(delta(coolscaler_pod_container_resource_requests{resource="memory"}[30m])) > bool 0)`,
					start, end, step, "max")
				series = []any{tsLinePts("Workloads increasing memory request", "#ef4444", pts, false)}
			// ---- Node I/O aggregated (avg/p90/max across nodes) + node load ----
			case "node-avg-load":
				per := e.promByLabel(ctx, `max by(node)(coolscaler_node_load1)`, start, end, step, "node")
				series = multiSeries(per, colors, "Load (1m)")
			case "node-network-throughput-agg":
				series = e.nodeAggSeries(ctx,
					`sum by(node)(rate(container_network_receive_bytes_total{id="/"}[5m]) + rate(container_network_transmit_bytes_total{id="/"}[5m]))`,
					start, end, step)
			case "node-disk-throughput-agg":
				series = e.nodeAggSeries(ctx,
					`sum by(node)(rate(container_fs_reads_bytes_total[5m]) + rate(container_fs_writes_bytes_total[5m]))`,
					start, end, step)
			case "node-disk-iops-agg":
				series = e.nodeAggSeries(ctx,
					`sum by(node)(rate(container_fs_reads_total[5m]) + rate(container_fs_writes_total[5m]))`,
					start, end, step)
			// ---- late additions ----
			case "update-evictions":
				per := e.promByLabel(ctx, `max by(eviction_type)(coolscaler_updater_evictions)`,
					start, end, step, "eviction_type")
				series = multiSeries(per, colors, "Evictions")
			case "oom-limit-events":
				pts := e.promAgg(ctx, `sum(coolscaler_oom_limit_events_by_workload)`, start, end, step, "max")
				series = []any{tsLinePts("OOM (limit)", "#dc2626", eventPoints(pts), false)}
			case "oom-node-events":
				pts := e.promAgg(ctx, `sum(coolscaler_oom_node_events_by_workload)`, start, end, step, "max")
				series = []any{tsLinePts("OOM (node pressure)", "#f97316", eventPoints(pts), false)}
			case "cpu-underprovisioned":
				pts := e.promAgg(ctx,
					`count(sum by(namespace,owner_name)(coolscaler_pod_container_resource_recommendation_requests{resource="cpu"})/1000`+
						` > sum by(namespace,owner_name)(coolscaler_pod_container_resource_requests{resource="cpu"}) * 1.03)`,
					start, end, step, "max")
				series = []any{tsLinePts("Under-provisioned workloads (CPU)", "#f59e0b", pts, false)}
			case "memory-underprovisioned":
				pts := e.promAgg(ctx,
					`count(sum by(namespace,owner_name)(coolscaler_pod_container_resource_recommendation_requests{resource="memory"})`+
						` > sum by(namespace,owner_name)(coolscaler_pod_container_resource_requests{resource="memory"}) * 1.03)`,
					start, end, step, "max")
				series = []any{tsLinePts("Under-provisioned workloads (memory)", "#ef4444", pts, false)}
			case "container-exit-codes":
				per := e.promByLabel(ctx,
					`count by(exit_code)(kube_pod_container_status_last_terminated_exitcode > 0)`,
					start, end, step, "exit_code")
				series = multiSeries(per, colors, "Exit code")
			case "version":
				per := e.promByLabel(ctx, `max by(version)(coolscaler_version_info)`,
					start, end, step, "version")
				series = multiSeries(per, colors, "Version")
			case "workloads-issues":
				// count of CoolScaler health checks currently failing (0).
				pts := e.promAgg(ctx,
					`count({__name__=~"coolscaler_health_check_.*"} == 0) or vector(0)`,
					start, end, step, "max")
				series = []any{tsLinePts("Failing health checks", "#dc2626", pts, false)}
			case "smart-policy-waste":
				// $/mo reclaimable on workloads NOT under automation — the
				// savings forgone by ignoring the recommendation.
				pts := e.promAgg(ctx,
					`sum(sum by(namespace,owner_name)(coolscaler_owner_hourly_available_savings_cost_avg_1h)`+
						` and on(namespace,owner_name) (max by(namespace,owner_name)(coolscaler_recommendation_managed_workload_status) == 0)) * 730`,
					start, end, step, "avg")
				series = []any{tsLinePts("Un-automated reclaimable $/mo", "#f59e0b", pts, false)}
			}
		}
		if series == nil {
			series = []any{}
		}
		charts = append(charts, ch.Set("series", series))
	}
	return pyjson.NewObj().
		Set("from", start*1000).
		Set("to", end*1000).
		Set("step", step).
		Set("aggregation", aggregation).
		Set("charts", charts)
}
