package engine

import (
	"context"
	"fmt"
	"sort"
	"time"

	"coolscaler.sh/coolscaler/internal/pyjson"
)

// Analytics family + alerts + audits + headroom + automation-config data
// functions.

var rangeSeconds = map[string]int64{
	"1h": 3600, "6h": 21600, "12h": 43200, "24h": 86400, "1d": 86400,
	"2d": 172800, "7d": 604800, "14d": 1209600, "30d": 2592000,
}

var groupbySeconds = map[string]int64{
	"5m": 300, "15m": 900, "30m": 1800, "hour": 3600, "1h": 3600,
	"day": 86400, "1d": 86400,
}

func (e *Engine) analyticsWindow(rangeStr string) []*pyjson.Obj {
	secs, ok := rangeSeconds[rangeStr]
	if !ok {
		secs = 604800
	}
	cutoff := time.Now().Unix() - secs
	e.mu.Lock()
	defer e.mu.Unlock()
	var out []*pyjson.Obj
	for _, s := range e.analytics {
		if i64(s.GetD("t", int64(0))) >= cutoff {
			out = append(out, s)
		}
	}
	return out
}

func analyticsAvg(points []*pyjson.Obj, field string) float64 {
	sum, n := 0.0, 0
	for _, p := range points {
		if v, ok := p.Get(field); ok && v != nil {
			if f, okF := f64(v); okF {
				sum += f
				n++
			}
		}
	}
	if n == 0 {
		return 0.0
	}
	return sum / float64(n)
}

func analyticsBucket(points []*pyjson.Obj, groupStr string, types []string) []any {
	step, ok := groupbySeconds[groupStr]
	if !ok {
		step = 900
	}
	type acc struct {
		sum float64
		n   int
	}
	buckets := map[int64]map[string]*acc{}
	bucketOrder := map[int64]map[string]bool{} // preserve per-bucket type insertion order
	typeOrder := map[int64][]string{}
	for _, p := range points {
		b := i64(p.GetD("t", int64(0))) / step * step
		slot, okS := buckets[b]
		if !okS {
			slot = map[string]*acc{}
			buckets[b] = slot
			bucketOrder[b] = map[string]bool{}
		}
		for _, t := range types {
			if v, okV := p.Get(t); okV && v != nil {
				if f, okF := f64(v); okF {
					a, okA := slot[t]
					if !okA {
						a = &acc{}
						slot[t] = a
						if !bucketOrder[b][t] {
							bucketOrder[b][t] = true
							typeOrder[b] = append(typeOrder[b], t)
						}
					}
					a.sum += f
					a.n++
				}
			}
		}
	}
	var keys []int64
	for b := range buckets {
		keys = append(keys, b)
	}
	sort.Slice(keys, func(i, j int) bool { return keys[i] < keys[j] })
	out := []any{}
	for _, b := range keys {
		vals := pyjson.NewObj()
		for _, t := range typeOrder[b] {
			a := buckets[b][t]
			vals.Set(t, pyjson.Round(a.sum/float64(a.n), 4))
		}
		out = append(out, pyjson.NewObj().
			Set("timestamp", time.Unix(b, 0).UTC().Format("2006-01-02T15:04:05Z")).
			Set("values", vals))
	}
	return out
}

var clusterResQ = [][2]string{
	{"cpuAllocatable", `sum(kube_node_status_allocatable{resource="cpu"})`},
	{"cpuRequests", `sum(kube_pod_container_resource_requests{resource="cpu"})`},
	{"cpuUsageTotal", `sum(rate(container_cpu_usage_seconds_total{container!="",container!="POD"}[5m]))`},
	{"memoryAllocatable", `sum(kube_node_status_allocatable{resource="memory"})`},
	{"memoryRequests", `sum(kube_pod_container_resource_requests{resource="memory"})`},
	{"memoryUsageTotal", `sum(container_memory_working_set_bytes{container!="",container!="POD"})`},
}

var javaResQ = [][2]string{
	{"jvmHeapUsed", `sum(java_lang_Memory_HeapMemoryUsage_used)`},
	{"jvmHeapCommitted", `sum(java_lang_Memory_HeapMemoryUsage_committed)`},
	{"jvmNonHeap", `sum(java_lang_Memory_NonHeapMemoryUsage_used)`},
	{"memUsage", `sum(container_memory_working_set_bytes{container!="",container!="POD"} and on(namespace,pod) java_lang_Memory_HeapMemoryUsage_used)`},
	{"memRequest", `sum(kube_pod_container_resource_requests{resource="memory"} and on(namespace,pod) java_lang_Memory_HeapMemoryUsage_used)`},
	{"cpuUsage", `sum(rate(container_cpu_usage_seconds_total{container!="",container!="POD"}[5m]) and on(namespace,pod) java_lang_Memory_HeapMemoryUsage_used)`},
	{"cpuRequest", `sum(kube_pod_container_resource_requests{resource="cpu"} and on(namespace,pod) java_lang_Memory_HeapMemoryUsage_used)`},
}

func (e *Engine) promRangeMerge(ctx context.Context, qmap [][2]string, rangeStr, group string) []any {
	secs, ok := rangeSeconds[rangeStr]
	if !ok {
		secs = 604800
	}
	step, ok := groupbySeconds[group]
	if !ok {
		step = 900
	}
	end := time.Now().Unix()
	start := end - secs
	merged := map[int64]*pyjson.Obj{}
	if e.Prom != nil {
		for _, kv := range qmap {
			key, q := kv[0], kv[1]
			series, err := e.Prom.QueryRange(ctx, q,
				time.Unix(start, 0), time.Unix(end, 0), time.Duration(step)*time.Second)
			if err != nil {
				continue
			}
			for _, s := range series {
				for _, p := range s.Points {
					ts := p.Timestamp.Unix()
					m, okM := merged[ts]
					if !okM {
						m = pyjson.NewObj()
						merged[ts] = m
					}
					m.Set(key, pyjson.Round(p.Value, 4))
				}
			}
		}
	}
	var keys []int64
	for t := range merged {
		keys = append(keys, t)
	}
	sort.Slice(keys, func(i, j int) bool { return keys[i] < keys[j] })
	out := []any{}
	for _, t := range keys {
		out = append(out, pyjson.NewObj().
			Set("timestamp", time.Unix(t, 0).UTC().Format("2006-01-02T15:04:05Z")).
			Set("values", merged[t]))
	}
	return out
}

// NodesGraph is GET /api/nodes/graph.
func (e *Engine) NodesGraph(ctx context.Context, rng, group string) *pyjson.Obj {
	return pyjson.NewObj().
		Set("values", e.promRangeMerge(ctx, clusterResQ, rng, group)).
		Set("clusterName", e.Cfg.ClusterName)
}

// JavaGraph is GET /api/java/graph.
func (e *Engine) JavaGraph(ctx context.Context, rng, group string) *pyjson.Obj {
	return pyjson.NewObj().
		Set("values", e.promRangeMerge(ctx, javaResQ, rng, group)).
		Set("clusterName", e.Cfg.ClusterName)
}

// AnalyticsSummary is GET /api/analytics/summary.
func (e *Engine) AnalyticsSummary() *pyjson.Obj {
	pts := e.analyticsWindow("7d")
	keySet := map[string]bool{}
	for _, p := range pts {
		for _, k := range p.Keys() {
			if k == "t" {
				continue
			}
			if _, okF := f64(p.GetD(k, nil)); okF {
				keySet[k] = true
			}
		}
	}
	averages := pyjson.NewObj()
	for _, k := range sortedKeys(keySet) {
		averages.Set(k, pyjson.Round(analyticsAvg(pts, k), 4))
	}
	return pyjson.NewObj().
		Set("averages", averages).
		Set("points", len(pts)).
		Set("clusters", []any{e.Cfg.ClusterName})
}

// AnalyticsSingle is GET /api/analytics/single.
func (e *Engine) AnalyticsSingle(rng, typ string) *pyjson.Obj {
	pts := e.analyticsWindow(rng)
	return pyjson.NewObj().
		Set("value", analyticsAvg(pts, typ)).
		Set("clusters", []any{e.Cfg.ClusterName})
}

// AnalyticsGraph is GET /api/analytics/graph.
func (e *Engine) AnalyticsGraph(rng, group string, types []string) *pyjson.Obj {
	pts := e.analyticsWindow(rng)
	return pyjson.NewObj().
		Set("values", analyticsBucket(pts, group, types)).
		Set("clusters", []any{e.Cfg.ClusterName})
}

// AnalyticsAutomation is GET /api/analytics/automation.
func (e *Engine) AnalyticsAutomation(rng string) *pyjson.Obj {
	pts := e.analyticsWindow(rng)
	avg := func(f string) float64 { return analyticsAvg(pts, f) }
	zero := func() *pyjson.Obj {
		return pyjson.NewObj().Set("automated", 0).Set("total", 0)
	}
	return pyjson.NewObj().
		Set("rightsizing", pyjson.NewObj().
			Set("automated", avg("rightsizingAutomated")).Set("total", avg("rightsizingTotal"))).
		Set("podPlacement", pyjson.NewObj().
			Set("automated", avg("podPlacementAutomated")).Set("total", avg("podPlacementTotal"))).
		Set("replicas", pyjson.NewObj().
			Set("automated", avg("replicasAutomated")).Set("total", avg("replicasTotal"))).
		Set("spotOptimization", pyjson.NewObj().
			Set("automated", avg("spotAutomated")).Set("total", avg("spotTotal"))).
		Set("podScheduling", zero()).
		Set("gpuRightsizing", zero()).
		Set("nodeManagement", zero()).
		Set("clusters", []any{e.Cfg.ClusterName})
}

func (e *Engine) BillingData(ctx context.Context, rng string) (*pyjson.Obj, error) {
	nt, err := e.NodeTable(ctx)
	if err != nil {
		return nil, err
	}
	pts := e.analyticsWindow(rng)
	series := []any{}
	var sum float64
	var n int
	monthAgg := map[string]*[2]float64{} // "YYYY-MM" -> {sum, count}
	var monthOrder []string
	for _, p := range pts {
		t := i64(p.GetD("t", int64(0)))
		v := f64d(p.GetD("cpuAllocatable", 0.0), 0)
		if v <= 0 {
			continue
		}
		series = append(series, pyjson.NewObj().Set("t", t).Set("v", pyjson.Round(v, 2)))
		sum += v
		n++
		mk := time.Unix(t, 0).UTC().Format("2006-01")
		a := monthAgg[mk]
		if a == nil {
			a = &[2]float64{}
			monthAgg[mk] = a
			monthOrder = append(monthOrder, mk)
		}
		a[0] += v
		a[1]++
	}
	avgAlloc := 0.0
	if n > 0 {
		avgAlloc = sum / float64(n)
	} else {
		avgAlloc = f64d(getObj(nt, "totals").GetD("cpuAllocatable", 0.0), 0)
	}
	sortStrings(monthOrder)
	monthly := []any{}
	for _, mk := range monthOrder {
		a := monthAgg[mk]
		mv := 0.0
		if a[1] > 0 {
			mv = a[0] / a[1]
		}
		monthly = append(monthly, pyjson.NewObj().
			Set("month", mk).Set("cpuAllocatable", pyjson.Round(mv, 2)))
	}
	// Per-product automation percentages.
	auto := e.AnalyticsAutomation(rng)
	pct := func(key string) any {
		o := getObj(auto, key)
		tot := f64d(o.GetD("total", 0.0), 0)
		if tot <= 0 {
			return nil
		}
		return int(f64d(o.GetD("automated", 0.0), 0) / tot * 100.0)
	}
	cluster := pyjson.NewObj().
		Set("name", e.Cfg.ClusterName).
		Set("cpuAllocatable", int(avgAlloc+0.5)).
		Set("monthlyUptime", 100).
		Set("automation", pyjson.NewObj().
			Set("rightsizing", pct("rightsizing")).
			Set("podPlacement", pct("podPlacement")).
			Set("replicasOptimization", pct("replicas")).
			Set("gpuRightsizing", pct("gpuRightsizing")).
			Set("spotOptimization", pct("spotOptimization")).
			Set("nodeManagement", pct("nodeManagement")))
	return pyjson.NewObj().
		Set("totalCpuAllocatable", int(avgAlloc+0.5)).
		Set("totalClusters", 1).
		Set("cpuOverTime", series).
		Set("clusters", []any{cluster}).
		Set("monthlyAllocatable", monthly), nil
}

func (e *Engine) VcpuCostData() *pyjson.Obj {
	e.mu.Lock()
	nodeCost := 0.0
	if e.overview != nil {
		nodeCost = f64d(e.overview.GetD("nodeCost", 0.0), 0)
	}
	cpuAlloc := 0.0
	if len(e.analytics) > 0 {
		cpuAlloc = f64d(e.analytics[len(e.analytics)-1].GetD("cpuAllocatable", 0.0), 0)
	}
	e.mu.Unlock()
	return pyjson.NewObj().
		Set("totalMonthlyCost", pyjson.Round(nodeCost, 2)).
		Set("totalCPUCapacity", pyjson.Round(cpuAlloc, 3)).
		Set("origin", "estimated").
		Set("mixedOrigins", false).
		Set("clusters", []any{e.Cfg.ClusterName})
}

// CustomRulesAttributes is GET /api/custom-rules-attributes.
func (e *Engine) CustomRulesAttributes() *pyjson.Obj {
	e.mu.Lock()
	cat := e.attrCatalog
	e.mu.Unlock()
	return pyjson.NewObj().
		Set("labels", cat.GetD("labels", pyjson.NewObj())).
		Set("annotations", cat.GetD("annotations", pyjson.NewObj())).
		Set("envs", cat.GetD("envs", pyjson.NewObj()))
}

// CogGroupByOptions is GET /api/cog/group-by-options.
func (e *Engine) CogGroupByOptions() *pyjson.Obj {
	e.mu.Lock()
	cat := e.attrCatalog
	e.mu.Unlock()
	kv := func(m *pyjson.Obj) []any {
		out := []any{}
		for _, k := range m.Keys() {
			for _, vv := range getList(m, k) {
				if len(out) >= 1000 {
					return out
				}
				out = append(out, k+"="+str(vv))
			}
		}
		return out
	}
	sortedObjKeys := func(m *pyjson.Obj) []any {
		ks := m.Keys()
		sortStrings(ks)
		return strList(ks)
	}
	labels := getObj(cat, "labels")
	anns := getObj(cat, "annotations")
	envs := getObj(cat, "envs")
	emptyList := func(k string) any {
		if v, ok := cat.Get(k); ok {
			return v
		}
		return []any{}
	}
	return pyjson.NewObj().
		Set("labelsKeys", sortedObjKeys(labels)).
		Set("annotationsKey", sortedObjKeys(anns)).
		Set("labelsKeyValue", kv(labels)).
		Set("annotationsKeyValue", kv(anns)).
		Set("owners", emptyList("owners")).
		Set("images", emptyList("images")).
		Set("namespaces", emptyList("namespaces")).
		Set("ownerIdentifier", emptyList("ownerIdentifier")).
		Set("envsKeys", sortedObjKeys(envs)).
		Set("envsKeyValue", kv(envs))
}

func (e *Engine) evaluateAlerts() []any {
	e.mu.Lock()
	wls := append([]*wlRow(nil), e.workloads...)
	var ov *pyjson.Obj
	if e.overview != nil {
		ov = e.overview.Clone()
	} else {
		ov = pyjson.NewObj()
	}
	ready := e.ready
	rules := e.alertRules
	e.mu.Unlock()
	now := time.Now().UTC().Format("2006-01-02T15:04:05Z")
	out := []any{}
	fire := func(rtype, message string, workload, value any) {
		r := getObj(rules, rtype)
		out = append(out, pyjson.NewObj().
			Set("type", rtype).
			Set("severity", r.GetD("severity", "info")).
			Set("message", message).
			Set("workload", workload).
			Set("value", value).
			Set("since", now))
	}
	rule := func(t string) *pyjson.Obj { return getObj(rules, t) }
	thr := func(t string) float64 { return f64d(rule(t).GetD("threshold", 0), 0) }
	en := func(t string) bool { return truthy(rule(t).GetD("enabled", nil)) }
	for _, w := range wls {
		sig := getObj(w.obj, "signals")
		nm := w.namespace + "/" + w.name
		oom := i64(sig.GetD("oom", int64(0)))
		if en("OutOfMemory") && float64(oom) >= thr("OutOfMemory") {
			fire("OutOfMemory", fmt.Sprintf("%s has %d OOMKilled container(s)", nm, oom), nm, oom)
		}
		// Preserved.
		if en("CpuThrottling") && truthy(sig.GetD("throttling", nil)) && w.sizable {
			fire("CpuThrottling", nm+" is CPU-throttled", nm, nil)
		}
		crash := i64(sig.GetD("crashloop", int64(0)))
		if en("CrashLoopBackOff") && float64(crash) >= thr("CrashLoopBackOff") {
			fire("CrashLoopBackOff", nm+" in CrashLoopBackOff", nm, crash)
		}
		if en("UnderProvisioned") && w.recCpu > w.reqCpu*1.03 {
			fire("UnderProvisioned", nm+" is under-provisioned (recommendation raises requests)", nm, nil)
		}
		if en("OverProvisioned") && w.sizable && w.reqCpu > 0 {
			wastePct := mathMax0(w.reqCpu-w.recCpu) / w.reqCpu * 100
			if wastePct >= thr("OverProvisioned") {
				pct := pyjson.RoundInt(wastePct)
				fire("OverProvisioned", fmt.Sprintf("%s wastes ~%d%% of CPU request", nm, pct), nm, pct)
			}
		}
	}
	bnv := i64(getObj(getObj(ov, "products"), "podPlacement").GetD("blockedNodes", int64(0)))
	if en("NodeUtilization") && bnv != 0 {
		fire("NodeUtilization", fmt.Sprintf("%d node(s) blocked from scale-down by un-evictable pods", bnv), nil, bnv)
	}
	if en("SystemDown") && !ready {
		fire("SystemDown", "Recommender has not completed its first sample", nil, nil)
	}
	sevRank := map[string]int{"critical": 0, "warning": 1, "info": 2}
	sort.SliceStable(out, func(i, j int) bool {
		si := str(obj(out[i]).GetD("severity", ""))
		sj := str(obj(out[j]).GetD("severity", ""))
		ri, ok := sevRank[si]
		if !ok {
			ri = 3
		}
		rj, ok := sevRank[sj]
		if !ok {
			rj = 3
		}
		return ri < rj
	})
	return out
}

func mathMax0(v float64) float64 {
	if v < 0 {
		return 0.0
	}
	return v
}

// AlertsData is GET /api/alerts.
func (e *Engine) AlertsData() *pyjson.Obj {
	alerts := e.evaluateAlerts()
	counts := pyjson.NewObj().Set("critical", 0).Set("warning", 0).Set("info", 0)
	for _, av := range alerts {
		sev := str(obj(av).GetD("severity", ""))
		cur := int(i64(counts.GetD(sev, int64(0))))
		counts.Set(sev, cur+1)
	}
	return pyjson.NewObj().
		Set("alerts", alerts).
		Set("counts", counts).
		Set("total", len(alerts))
}

// AlertSettingsData is GET /api/alert-settings.
func (e *Engine) AlertSettingsData() *pyjson.Obj {
	e.mu.Lock()
	defer e.mu.Unlock()
	return pyjson.NewObj().Set("rules", e.alertRules)
}

// HeadroomData is GET /api/headroom ({**CLUSTER_HEADROOM, computed}).
func (e *Engine) HeadroomData() *pyjson.Obj {
	e.mu.Lock()
	defer e.mu.Unlock()
	computed := pyjson.NewObj()
	if e.overview != nil {
		computed = getObj(e.overview, "headroom")
	}
	return e.clusterHeadroomLocked().Set("computed", computed)
}

// clusterHeadroomLocked renders CLUSTER_HEADROOM (caller holds e.mu).
func (e *Engine) clusterHeadroomLocked() *pyjson.Obj {
	out := pyjson.NewObj().
		Set("enabled", e.headroomEnabled).
		Set("cpuClusterProportion", e.headroomCpuPct).
		Set("memoryClusterProportion", e.headroomMemPct).
		Set("isScheduled", e.headroomScheduled)
	for _, k := range e.headroomRaw.Keys() {
		out.Set(k, e.headroomRaw.GetD(k, nil))
	}
	return out
}

// AuditsData is GET /api/audits.
func (e *Engine) AuditsData(fromMs, toMs int64) *pyjson.Obj {
	e.mu.Lock()
	defer e.mu.Unlock()
	records := []any{}
	for _, r := range e.auditLog {
		if fromMs > 0 || toMs > 0 {
			ts := str(r.GetD("timestamp", ""))
			t, err := time.Parse(time.RFC3339, ts)
			if err == nil {
				ms := t.UnixMilli()
				if (fromMs > 0 && ms < fromMs) || (toMs > 0 && ms > toMs) {
					continue
				}
			}
		}
		if len(records) >= 500 {
			break
		}
		records = append(records, r)
	}
	return pyjson.NewObj().
		Set("audits", records).
		Set("clusters", []any{e.Cfg.ClusterName}).
		Set("total", len(e.auditLog)).
		Set("retentionInDays", 30)
}

// AutomationConfigData is GET /api/automation-config. GLOBAL_AUTO plus the
// custom-namespace-labels view (persisted in its OWN ConfigMap, not the
// automation-config CM).
func (e *Engine) AutomationConfigData() *pyjson.Obj {
	e.mu.Lock()
	defer e.mu.Unlock()
	out := e.globalAuto.Clone()
	out.Set("namespaceLabels", pyjson.NewObj().
		Set("includeLabels", strList(e.customNsLabels["include-labels"])).
		Set("excludeLabels", strList(e.customNsLabels["exclude-labels"])))
	return out
}
