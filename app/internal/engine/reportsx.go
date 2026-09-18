package engine

// reportsx.go

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"coolscaler.sh/coolscaler/internal/pyjson"
)

// ---------------------------------------------------------------------------
// Reports builder: POST /api/reports/new + GET /api/reports/graph
// ---------------------------------------------------------------------------

var reportsGraphKeyMap = [][2]string{
	{"allocatableCpu", "cpuAllocatable"},
	{"cpuRequests", "cpuRequests"},
	{"cpuRequestsOrigin", "cpuRequestsOrigin"},
	{"memoryRequests", "memoryRequests"},
	{"memoryRequestsOrigin", "memoryRequestsOrigin"},
	{"rightSizedPods", "numberOfAutomatedPods"},
	{"unevictablePods", "podPlacementTotal"},
	{"binPackedPods", "podPlacementAutomated"},
	{"totalPods", "totalNumberOfPods"},
}

// ReportsGraph is GET /api/reports/graph
func (e *Engine) ReportsGraph(rng string) *pyjson.Obj {
	types := make([]string, 0, len(reportsGraphKeyMap))
	for _, kv := range reportsGraphKeyMap {
		types = append(types, kv[1])
	}
	g := e.AnalyticsGraph(rng, "hour", types)
	out := []any{}
	for _, pv := range getList(g, "values") {
		p := obj(pv)
		v := getObj(p, "values")
		row := pyjson.NewObj().Set("timestamp", p.GetD("timestamp", nil))
		for _, kv := range reportsGraphKeyMap {
			row.Set(kv[0], v.GetD(kv[1], nil))
		}
		out = append(out, row)
	}
	return pyjson.NewObj().Set("values", out)
}

var reportAggregators = map[string]string{
	"Total Cost":       "totalWorkloadCostMonthly",
	"Savings Overtime": "availableSavings",
	"Total Waste":      "wastedSpend",
	"CPU Request":      "cpuRequests",
	"Memory Request":   "memoryRequests",
	"GPU Request":      "", // no GPUs on this cluster — honest 0
}

// ReportsNew is POST /api/reports/new {from,to,aggregators,namespaceFilters,
// labelsFilters} → {data:{aggregates:[{name,value}]}}. when namespace/label
// filters are present the values are computed from the LIVE workload rows
// (snapshots are cluster-scope), flagged via "scope".
func (e *Engine) ReportsNew(body *pyjson.Obj) *pyjson.Obj {
	fromMs := i64(body.GetD("from", int64(0)))
	toMs := i64(body.GetD("to", int64(0)))
	var aggs []string
	for _, v := range getList(body, "aggregators") {
		aggs = append(aggs, str(v))
	}
	if len(aggs) == 0 {
		for k := range reportAggregators {
			aggs = append(aggs, k)
		}
		sort.Strings(aggs)
	}
	var nsFilters []string
	for _, v := range getList(body, "namespaceFilters") {
		nsFilters = append(nsFilters, str(v))
	}
	labelFilters := map[string]string{}
	for _, v := range getList(body, "labelsFilters") {
		s := str(v)
		if i := strings.IndexByte(s, '='); i > 0 {
			labelFilters[s[:i]] = s[i+1:]
		} else if s != "" {
			labelFilters[s] = ""
		}
	}
	filtered := len(nsFilters) > 0 || len(labelFilters) > 0

	rows := []any{}
	if !filtered {
		// average the snapshot buffer over the window
		snaps := e.analyticsWindow("30d")
		for _, name := range aggs {
			field := reportAggregators[name]
			sum, n := 0.0, 0
			for _, s := range snaps {
				ts := i64(s.GetD("t", int64(0))) * 1000
				if fromMs > 0 && ts < fromMs {
					continue
				}
				if toMs > 0 && ts > toMs {
					continue
				}
				if field != "" {
					sum += f64d(s.GetD(field, 0.0), 0)
					n++
				}
			}
			val := 0.0
			if n > 0 {
				val = sum / float64(n)
			}
			rows = append(rows, pyjson.NewObj().
				Set("name", name).
				Set("value", pyjson.Round(val, 2)).
				Set("scope", "cluster"))
		}
	} else {
		// live per-workload aggregation honoring the filters
		nsSet := map[string]bool{}
		for _, ns := range nsFilters {
			nsSet[ns] = true
		}
		var cost, sav, cpu, mem float64
		e.mu.Lock()
		for _, w := range e.workloads {
			if w.kind == "Node" {
				continue
			}
			if len(nsSet) > 0 && !nsSet[w.namespace] {
				continue
			}
			if len(labelFilters) > 0 {
				lbls := obj(w.obj.GetD("labels", nil))
				match := true
				for k, v := range labelFilters {
					got, ok := lbls.Get(k)
					if !ok || (v != "" && str(got) != v) {
						match = false
						break
					}
				}
				if !match {
					continue
				}
			}
			reps := float64(w.replicas)
			if reps < 1 {
				reps = 1
			}
			cost += f64d(w.obj.GetD("monthlyCost", 0.0), 0)
			sav += f64d(w.obj.GetD("savings", 0.0), 0)
			cpu += f64d(w.obj.GetD("reqCpu", 0.0), 0) * reps
			mem += f64d(w.obj.GetD("reqMem", 0.0), 0) * reps
		}
		e.mu.Unlock()
		vals := map[string]float64{
			"Total Cost": cost, "Savings Overtime": sav, "Total Waste": sav,
			"CPU Request": cpu, "Memory Request": mem, "GPU Request": 0,
		}
		for _, name := range aggs {
			rows = append(rows, pyjson.NewObj().
				Set("name", name).
				Set("value", pyjson.Round(vals[name], 2)).
				Set("scope", "live-filtered"))
		}
	}
	return pyjson.NewObj().Set("data", pyjson.NewObj().Set("aggregates", rows))
}

// ---------------------------------------------------------------------------
// Troubleshoot export bundle: GET/POST /api/troubleshoot/export (+/download)
// ---------------------------------------------------------------------------

// TroubleshootExportState is GET/POST /api/troubleshoot/export.
func (e *Engine) TroubleshootExportState() *pyjson.Obj {
	return pyjson.NewObj().Set("state", "ready")
}

// TroubleshootExportBundle builds a tar.gz of the live diagnostic JSONs.
func (e *Engine) TroubleshootExportBundle(ctx context.Context) ([]byte, error) {
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	add := func(name string, payload *pyjson.Obj) {
		if payload == nil {
			return
		}
		data := pyjson.Marshal(payload)
		_ = tw.WriteHeader(&tar.Header{
			Name: name, Mode: 0o644, Size: int64(len(data)),
			ModTime: time.Now(),
		})
		_, _ = tw.Write(data)
	}
	e.mu.Lock()
	ov := e.overview
	e.mu.Unlock()
	add("overview.json", ov)
	add("workloads.json", e.WorkloadsData())
	add("health.json", e.HealthData(ctx))
	add("audits.json", e.AuditsData(0, 0))
	add("alerts.json", e.AlertsData())
	add("version.json", pyjson.NewObj().
		Set("cluster", e.Cfg.ClusterName).
		Set("exportedAt", time.Now().UTC().Format(time.RFC3339)))
	if err := tw.Close(); err != nil {
		return nil, err
	}
	if err := gz.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// ---------------------------------------------------------------------------
// COG discovery: GET /api/custom-workloads/owners/unknown + /pod-templates
// ---------------------------------------------------------------------------

// CogUnknownOwners is GET /api/custom-workloads/owners/unknown.
func (e *Engine) CogUnknownOwners(ctx context.Context) *pyjson.Obj {
	cw, err := e.CustomWorkloadsData(ctx)
	if err != nil {
		cw = pyjson.NewObj()
	}
	owners := []any{}
	for _, uv := range getList(cw, "unrecognized") {
		u := obj(uv)
		owners = append(owners, pyjson.NewObj().
			Set("ownerKind", u.GetD("ownerKind", "")).
			Set("pods", u.GetD("pods", 0)))
	}
	alloc := 0.0
	e.mu.Lock()
	if e.overview != nil {
		alloc = f64d(getObj(e.overview, "headroom").GetD("cpuAllocatable", 0.0), 0)
	}
	e.mu.Unlock()
	if alloc == 0 {
		if rows := e.promQuery(ctx, `sum(kube_node_status_allocatable{resource="cpu"})`); len(rows) > 0 {
			alloc = rows[0].Value
		}
	}
	return pyjson.NewObj().
		Set("unknownOwners", owners).
		Set("totalClusterAllocatableCpu", alloc)
}

// CogPodTemplates is GET /api/custom-workloads/pod-templates — one template
// per unrecognized owner kind (labels/images/container names of a sample pod).
func (e *Engine) CogPodTemplates(ctx context.Context) *pyjson.Obj {
	cw, err := e.CustomWorkloadsData(ctx)
	if err != nil {
		cw = pyjson.NewObj()
	}
	unrecPods := getObj(cw, "unrecognizedPods")
	templates := []any{}
	for _, kind := range unrecPods.Keys() {
		names := getList(unrecPods, kind)
		tpl := pyjson.NewObj().Set("ownerKind", kind).
			Set("labels", pyjson.NewObj()).
			Set("images", []any{}).
			Set("containerNames", []any{})
		if len(names) > 0 {
			// sample the first pod's live object for labels/images
			parts := strings.SplitN(str(names[0]), "/", 2)
			if len(parts) == 2 {
				if pod, err := e.Kube.GetJSON(ctx, "/api/v1/namespaces/"+parts[0]+"/pods/"+parts[1]); err == nil {
					tpl.Set("labels", getObj(getObj(pod, "metadata"), "labels"))
					imgs, cns := []any{}, []any{}
					for _, cv := range getList(getObj(pod, "spec"), "containers") {
						c := obj(cv)
						imgs = append(imgs, c.GetD("image", ""))
						cns = append(cns, c.GetD("name", ""))
					}
					tpl.Set("images", imgs).Set("containerNames", cns)
				}
			}
		}
		templates = append(templates, tpl)
	}
	return pyjson.NewObj().Set("podTemplates", templates)
}

// ---------------------------------------------------------------------------
// Rebalance: POST /api/nodes/rebalance-once + GET /api/nodes/rebalance-status
// ---------------------------------------------------------------------------

const rebalanceCM = "coolscaler-rebalance-status"

// RebalanceOnce triggers the same placement automation the UI's Automate All
// uses, and records the run.
func (e *Engine) RebalanceOnce(ctx context.Context) *pyjson.Obj {
	if e.Cfg.ReadOnly {
		return pyjson.NewObj().Set("ok", false).Set("error", "Cluster is in Read-Only mode")
	}
	code, resp := e.PostPlacementAutomateAll(ctx, pyjson.NewObj().Set("automate", true))
	e.upsertCM(ctx, rebalanceCM, nil, pyjson.NewObj().
		Set("lastRun", time.Now().UTC().Format(time.RFC3339)).
		Set("lastResult", fmt.Sprintf("%d", code)), nil)
	e.audit("RebalanceOnce", "cluster", "", "", "user")
	return pyjson.NewObj().Set("ok", code < 300).Set("result", resp)
}

// RebalanceStatus is GET /api/nodes/rebalance-status
func (e *Engine) RebalanceStatus(ctx context.Context) *pyjson.Obj {
	cm := e.getCM(ctx, rebalanceCM)
	d := getObj(cm, "data")
	status := pyjson.NewObj().Set("retryCounter", 0)
	if lr := getStr(d, "lastRun"); lr != "" {
		status.Set("lastUpdateTime", lr)
	}
	return pyjson.NewObj().
		Set("spec", pyjson.NewObj().
			Set("maxInProgress", "10%").
			Set("gracePeriod", 1800).
			Set("skipNodesWithGPU", true).
			Set("ignoreSafeToEvict", "AlwaysIgnore").
			Set("ignorePDB", "AlwaysIgnore").
			Set("replacementEnabled", true)).
		Set("status", status)
}

// ---------------------------------------------------------------------------
// Per-node analytics: GET /api/node-analytics?name=&types=&from=&to=
// ---------------------------------------------------------------------------

func nodeAnalyticsQuery(typ, node string) string {
	n := node // k8s node names are RFC1123 — regex-safe
	switch typ {
	case "utilizationCpu":
		return `100 * sum(rate(container_cpu_usage_seconds_total{id="/",node="` + n + `"}[5m])) / clamp_min(sum(kube_node_status_allocatable{resource="cpu",node="` + n + `"}),0.001)`
	case "utilizationMemory":
		return `100 * sum(container_memory_working_set_bytes{id="/",node="` + n + `"}) / clamp_min(sum(kube_node_status_allocatable{resource="memory",node="` + n + `"}),1)`
	case "podsCpuUsage":
		return `sum(rate(container_cpu_usage_seconds_total{id="/",node="` + n + `"}[5m]))`
	case "podsMemoryUsage":
		return `sum(container_memory_working_set_bytes{id="/",node="` + n + `"})`
	case "nodeLoad1":
		return `max(coolscaler_node_load1{node="` + n + `"})`
	case "nodePressure":
		return `100 * max(rate(node_pressure_cpu_waiting_seconds_total{node="` + n + `"}[5m]) or rate(coolscaler_node_psi_cpu_some_seconds_total{node="` + n + `"}[5m]))`
	case "outOfMemory":
		return `sum(coolscaler_oom_limit_events_by_workload) or vector(0)`
	default:
		return ""
	}
}

// NodeAnalytics is GET /api/node-analytics.
func (e *Engine) NodeAnalytics(ctx context.Context, node string, types []string, fromS, toS int64) *pyjson.Obj {
	if toS == 0 {
		toS = time.Now().Unix()
	}
	if fromS == 0 {
		fromS = toS - 24*3600
	}
	step := (toS - fromS) / 200
	if step < 60 {
		step = 60
	}
	// one merged values list, keyed per type
	merged := map[int64]*pyjson.Obj{}
	var order []int64
	for _, typ := range types {
		q := nodeAnalyticsQuery(typ, node)
		if q == "" {
			continue
		}
		for _, ptv := range e.promAgg(ctx, q, fromS, toS, step, "avg") {
			pt := obj(ptv)
			ts := i64(pt.GetD("t", int64(0))) / 1000
			row := merged[ts]
			if row == nil {
				row = pyjson.NewObj()
				merged[ts] = row
				order = append(order, ts)
			}
			row.Set(typ, pt.GetD("v", nil))
		}
	}
	sort.Slice(order, func(i, j int) bool { return order[i] < order[j] })
	out := []any{}
	for _, ts := range order {
		out = append(out, pyjson.NewObj().
			Set("timestamp", time.Unix(ts, 0).UTC().Format(time.RFC3339)).
			Set("values", merged[ts]))
	}
	return pyjson.NewObj().Set("values", out)
}

// ---------------------------------------------------------------------------
// Generic topk: GET/POST /api/analytics/topk
// ---------------------------------------------------------------------------

var topkQueries = map[string]string{
	"systemCPUUsage":       `topk(15, sum by(pod)(rate(container_cpu_usage_seconds_total{namespace="%NS%",id!="/"}[5m])))`,
	"systemMemoryUsage":    `topk(15, sum by(pod)(container_memory_working_set_bytes{namespace="%NS%",id!="/"}))`,
	"systemCPURequests":    `topk(15, sum by(pod)(kube_pod_container_resource_requests{namespace="%NS%",resource="cpu"}))`,
	"systemMemoryRequests": `topk(15, sum by(pod)(kube_pod_container_resource_requests{namespace="%NS%",resource="memory"}))`,
	"version":                `max by(version)(coolscaler_version_info)`,
}

// AnalyticsTopk is GET/POST /api/analytics/topk.
func (e *Engine) AnalyticsTopk(ctx context.Context, queryKey, rng string) *pyjson.Obj {
	q, ok := topkQueries[queryKey]
	if !ok {
		return pyjson.NewObj().Set("values", []any{}).Set("error", "unknown queryKey")
	}
	q = strings.ReplaceAll(q, "%NS%", e.Cfg.Namespace)
	end := time.Now().Unix()
	secs := int64(3 * 24 * 3600)
	if n, err := pyInt(strings.TrimSuffix(rng, "d")); err == nil && n > 0 {
		secs = n * 24 * 3600
	}
	start := end - secs
	step := secs / 200
	if step < 60 {
		step = 60
	}
	lbl := "pod"
	if queryKey == "version" {
		lbl = "version"
	}
	out := []any{}
	for _, sv := range e.promByLabel(ctx, q, start, end, step, lbl) {
		so := obj(sv)
		out = append(out, pyjson.NewObj().
			Set("name", so.GetD("label", "")).
			Set("values", so.GetD("points", []any{})))
	}
	return pyjson.NewObj().Set("values", out)
}

// ---------------------------------------------------------------------------
// Drawer helper aliases: pods / autoIndication / additional-info
// ---------------------------------------------------------------------------

// WorkloadPodsAlias is GET /api/workload/:ns/:kind/:name/pods
func (e *Engine) WorkloadPodsAlias(ns, kind, name string) *pyjson.Obj {
	e.mu.Lock()
	row := e.byKey[wlkey(ns, kind, name)]
	var podInfo []any
	var reqCpu, reqMem float64
	if row != nil {
		podInfo = getList(row.obj, "podInfo")
		reqCpu = f64d(row.obj.GetD("reqCpu", 0.0), 0)
		reqMem = f64d(row.obj.GetD("reqMem", 0.0), 0)
	}
	e.mu.Unlock()
	pods := []any{}
	for _, pv := range podInfo {
		p := obj(pv)
		pods = append(pods, pyjson.NewObj().
			Set("name", p.GetD("name", "")).
			Set("status", p.GetD("phase", p.GetD("status", "Running"))).
			Set("cpuRequest", reqCpu).
			Set("memoryRequest", reqMem).
			Set("cpuUsage", p.GetD("cpu", nil)).
			Set("memoryUsage", p.GetD("mem", nil)).
			Set("ready", p.GetD("ready", true)))
	}
	return pyjson.NewObj().Set("pods", pods)
}

// WorkloadAutoIndication is GET /api/workload/:ns/:kind/:name/autoIndication
func (e *Engine) WorkloadAutoIndication(ns, kind, name string) *pyjson.Obj {
	e.mu.Lock()
	row := e.byKey[wlkey(ns, kind, name)]
	var isAuto bool
	src := ""
	if row != nil {
		isAuto = row.automated
		src = str(row.obj.GetD("automationSource", ""))
	}
	e.mu.Unlock()
	ind := src
	if ind == "" && isAuto {
		ind = "UI"
	}
	return pyjson.NewObj().
		Set("autoIndication", ind).
		Set("isAuto", isAuto).
		Set("autoIndications", pyjson.NewObj().
			Set("rightsize", pyjson.NewObj().Set("sourceName", ind)))
}

// ---------------------------------------------------------------------------
// Init containers: GET/POST /api/init-containers/
// ---------------------------------------------------------------------------

// InitContainersData is GET /api/init-containers/ — per-init-container
// request + reclaimable waste across all workloads.
func (e *Engine) InitContainersData() *pyjson.Obj {
	agg := pyjson.NewObj()
	e.mu.Lock()
	for _, w := range e.workloads {
		for _, iv := range getList(w.obj, "initOptimization") {
			ic := obj(iv)
			nm := getStr(ic, "name")
			if nm == "" {
				continue
			}
			cur, _ := agg.GetD(nm, nil).(*pyjson.Obj)
			if cur == nil {
				cur = pyjson.NewObj().
					Set("request", pyjson.NewObj().Set("cpu", 0.0).Set("memory", 0.0)).
					Set("waste", pyjson.NewObj().Set("cpu", 0.0).Set("memory", 0.0))
				agg.Set(nm, cur)
			}
			req := getObj(cur, "request")
			waste := getObj(cur, "waste")
			rc := f64d(ic.GetD("reqCpu", 0.0), 0)
			rm := f64d(ic.GetD("reqMem", 0.0), 0)
			oc := f64d(ic.GetD("recCpu", 0.0), 0)
			om := f64d(ic.GetD("recMem", 0.0), 0)
			req.Set("cpu", f64d(req.GetD("cpu", 0.0), 0)+rc)
			req.Set("memory", f64d(req.GetD("memory", 0.0), 0)+rm)
			if rc > oc {
				waste.Set("cpu", f64d(waste.GetD("cpu", 0.0), 0)+(rc-oc))
			}
			if rm > om {
				waste.Set("memory", f64d(waste.GetD("memory", 0.0), 0)+(rm-om))
			}
		}
	}
	e.mu.Unlock()
	return pyjson.NewObj().Set("initContainers", agg)
}
