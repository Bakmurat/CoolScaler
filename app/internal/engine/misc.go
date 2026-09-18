package engine

import (
	"context"
	"fmt"
	"math"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"coolscaler.sh/coolscaler/internal/pyjson"
)


// installDate analog).
var startTimeISO = isoNow()

var analyticsFile = os.Getenv("ANALYTICS_FILE")

var (
	k8sVersionMu    sync.Mutex
	k8sVersionCache string
)

func pyInt(s string) (int64, error) {
	v, err := strconv.ParseInt(strings.TrimSpace(s), 10, 64)
	if err != nil {
		return 0, fmt.Errorf("invalid literal for int() with base 10: '%s'", s)
	}
	return v, nil
}

func (e *Engine) promScalar(ctx context.Context, q string) any {
	r := e.promQuery(ctx, q)
	if len(r) == 0 {
		return nil
	}
	return r[0].Value
}

func (e *Engine) CurSettingsData() *pyjson.Obj {
	return pyjson.NewObj().
		Set("enabled", false).
		Set("configured", false).
		Set("provider", "").
		Set("accountId", "").
		Set("projectId", "").
		Set("externalId", "").
		Set("show", false).
		Set("multiCluster", false).
		Set("note", "No cloud Cost & Usage Report is connected; CoolScaler prices from its own node resource model.")
}

// reqDelta is one _range_request_deltas entry.
type reqDelta struct {
	origCpu, curCpu float64
	origMem, curMem float64
	hasCpu, hasMem  bool
}

func (e *Engine) rangeRequestDeltas(ctx context.Context, frm, to int64, wls []*pyjson.Obj) map[string]*reqDelta {
	out := map[string]*reqDelta{}
	if e.Prom == nil || to <= frm {
		return out
	}
	idx := map[string][]*pyjson.Obj{}
	for _, w := range wls {
		ns := getStr(w, "namespace")
		idx[ns] = append(idx[ns], w)
	}
	for ns := range idx {
		lst := idx[ns]
		sort.SliceStable(lst, func(i, j int) bool { // longest prefix wins
			return len(getStr(lst[i], "name")) > len(getStr(lst[j], "name"))
		})
	}
	step := (to - frm) / 24
	if step < 3600 {
		step = 3600
	}
	specs := []struct {
		res string
		set func(d *reqDelta, orig, cur float64)
	}{
		{"cpu", func(d *reqDelta, o, c float64) { d.origCpu, d.curCpu, d.hasCpu = o, c, true }},
		{"memory", func(d *reqDelta, o, c float64) { d.origMem, d.curMem, d.hasMem = o, c, true }},
	}
	for _, sp := range specs {
		per := map[string]map[int64]float64{} // wlkey -> t -> summed request
		q := fmt.Sprintf(`sum by (namespace,pod) (kube_pod_container_resource_requests{resource="%s"})`, sp.res)
		series, err := e.Prom.QueryRange(ctx, q, time.Unix(frm, 0), time.Unix(to, 0),
			time.Duration(step)*time.Second)
		if err != nil {
			e.Log.Info("prometheus query_range failed", "err", err)
			series = nil
		}
		for _, s := range series {
			ns, pod := s.Metric["namespace"], s.Metric["pod"]
			var wl *pyjson.Obj
			for _, w := range idx[ns] {
				name := getStr(w, "name")
				if pod == name || strings.HasPrefix(pod, name+"-") {
					wl = w
					break
				}
			}
			if wl == nil {
				continue
			}
			key := getStr(wl, "key")
			m := per[key]
			if m == nil {
				m = map[int64]float64{}
				per[key] = m
			}
			for _, p := range s.Points {
				m[p.Timestamp.Unix()] += p.Value
			}
		}
		for k, tsmap := range per {
			ts := make([]int64, 0, len(tsmap))
			for t := range tsmap {
				ts = append(ts, t)
			}
			sort.Slice(ts, func(i, j int) bool { return ts[i] < ts[j] })
			d := out[k]
			if d == nil {
				d = &reqDelta{}
				out[k] = d
			}
			sp.set(d, tsmap[ts[0]], tsmap[ts[len(ts)-1]])
		}
	}
	return out
}

func (e *Engine) CostReportData(ctx context.Context, frmMs, toMs *string) (*pyjson.Obj, error) {
	e.mu.Lock()
	wlsAll := make([]*pyjson.Obj, 0, len(e.workloads))
	for _, w := range e.workloads {
		wlsAll = append(wlsAll, w.obj)
	}
	e.mu.Unlock()
	nt, err := e.NodeTable(ctx)
	if err != nil {
		return nil, err
	}
	nodeRows := getList(nt, "nodes")
	nodeTotal := f64d(getObj(nt, "totals").GetD("monthlyCost", 0.0), 0)
	// Exclude kind=Node rows (system reservations) — they belong in
	// by-node/node-cost, not in workload/namespace cost.
	wls := make([]*pyjson.Obj, 0, len(wlsAll))
	for _, w := range wlsAll {
		if getStr(w, "kind") != "Node" {
			wls = append(wls, w)
		}
	}
	nsAgg := pyjson.NewObj() // namespace -> agg dict, insertion-ordered
	for _, w := range wls {
		ns := getStr(w, "namespace")
		var a *pyjson.Obj
		if v, ok := nsAgg.Get(ns); ok {
			a = v.(*pyjson.Obj)
		} else {
			a = pyjson.NewObj().
				Set("namespace", ns).Set("monthlyCost", 0.0).
				Set("savings", 0.0).Set("workloads", 0).Set("pods", 0).
				Set("cpuRequest", 0.0).Set("memRequest", 0.0)
			nsAgg.Set(ns, a)
		}
		a.Set("monthlyCost", f64d(a.GetD("monthlyCost", 0.0), 0)+f64d(w.GetD("monthlyCost", 0.0), 0))
		a.Set("savings", f64d(a.GetD("savings", 0.0), 0)+math.Max(f64d(w.GetD("savings", 0.0), 0), 0.0))
		a.Set("workloads", int(i64(a.GetD("workloads", 0)))+1)
		reps := math.Max(1, float64(i64(w.GetD("replicas", 0))))
		a.Set("cpuRequest", f64d(a.GetD("cpuRequest", 0.0), 0)+f64d(w.GetD("reqCpu", 0.0), 0)*reps)
		a.Set("memRequest", f64d(a.GetD("memRequest", 0.0), 0)+f64d(w.GetD("reqMem", 0.0), 0)*reps)
		pods := len(getList(w, "podNames"))
		if pods == 0 {
			pods = int(i64(w.GetD("replicas", 0)))
		}
		a.Set("pods", int(i64(a.GetD("pods", 0)))+pods)
	}
	byNs := make([]*pyjson.Obj, 0, nsAgg.Len())
	for _, k := range nsAgg.Keys() {
		byNs = append(byNs, obj(nsAgg.GetD(k, nil)))
	}
	sort.SliceStable(byNs, func(i, j int) bool {
		return f64d(byNs[i].GetD("monthlyCost", 0.0), 0) > f64d(byNs[j].GetD("monthlyCost", 0.0), 0)
	})
	// Spot / on-demand split: with zero spot nodes in the cluster the split is
	// exactly 0/100 for every namespace; with spot nodes present, per-pod node
	// attribution would be needed → null (honest-unknown), never estimated.
	spotNodes := 0
	for _, nv := range nodeRows {
		if truthy(obj(nv).GetD("isSpot", nil)) {
			spotNodes++
		}
	}
	for _, a := range byNs {
		a.Set("cpuRequest", pyjson.Round(f64d(a.GetD("cpuRequest", 0.0), 0), 2))
		if spotNodes == 0 {
			a.Set("spotPct", 0).Set("onDemandPct", 100)
		} else {
			a.Set("spotPct", nil).Set("onDemandPct", nil)
		}
	}
	var wlCost, savings float64
	for _, w := range wls {
		wlCost += f64d(w.GetD("monthlyCost", 0.0), 0)
		savings += math.Max(f64d(w.GetD("savings", 0.0), 0), 0.0)
	}
	top := make([]*pyjson.Obj, 0, len(wls))
	for _, w := range wls {
		reps := math.Max(1, float64(i64(w.GetD("replicas", 0))))
		top = append(top, pyjson.NewObj().
			Set("namespace", getStr(w, "namespace")).
			Set("name", getStr(w, "name")).
			Set("kind", getStr(w, "kind")).
			Set("monthlyCost", f64d(w.GetD("monthlyCost", 0.0), 0)).
			Set("savings", math.Max(f64d(w.GetD("savings", 0.0), 0), 0.0)).
			Set("cpuRequest", pyjson.Round(f64d(w.GetD("reqCpu", 0.0), 0)*reps, 2)).
			Set("memRequest", f64d(w.GetD("reqMem", 0.0), 0)*reps))
	}
	sort.SliceStable(top, func(i, j int) bool {
		return f64d(top[i].GetD("monthlyCost", 0.0), 0) > f64d(top[j].GetD("monthlyCost", 0.0), 0)
	})
	if len(top) > 25 {
		top = top[:25]
	}
	byNode := []any{}
	for _, nv := range nodeRows {
		n := obj(nv)
		inst := getStr(n, "instanceType")
		if inst == "" {
			inst = "unknown"
		}
		lifecycle := "on-demand"
		if truthy(n.GetD("isSpot", nil)) {
			lifecycle = "spot"
		}
		byNode = append(byNode, pyjson.NewObj().
			Set("name", getStr(n, "name")).
			Set("instanceType", inst).
			Set("lifecycle", lifecycle).
			Set("monthlyCost", pyjson.Round(f64d(n.GetD("cost", 0.0), 0), 2)).
			Set("runningPods", n.GetD("runningPods", 0)))
	}
	// --- Time dimension: per-workload rows + stacked cost-over-time ---
	nowMs := time.Now().UnixMilli()
	toV := nowMs
	if toMs != nil && *toMs != "" {
		v, err := pyInt(*toMs)
		if err != nil {
			return nil, err
		}
		toV = v
	}
	frmV := toV - 30*86400000
	if frmMs != nil && *frmMs != "" {
		v, err := pyInt(*frmMs)
		if err != nil {
			return nil, err
		}
		frmV = v
	}
	hours := math.Max(0.0, float64(toV-frmV)/3600000.0)
	scale := hours / hoursPerMonth // monthly-$ → $-in-range
	deltas := e.rangeRequestDeltas(ctx, frmV/1000, toV/1000, wls)
	rows := make([]*pyjson.Obj, 0, len(wls))
	for _, w := range wls {
		wid := fmt.Sprintf("%s/%s/%s/%s", e.Cfg.ClusterName, getStr(w, "namespace"),
			strings.ToLower(getStr(w, "kind")), getStr(w, "name"))
		d := deltas[getStr(w, "key")]
		// activeSavings = realized $.
		active := 0.0
		if d != nil && d.hasCpu {
			active = math.Max(0.0, e.monthlyCost(d.origCpu, d.origMem)-
				e.monthlyCost(d.curCpu, d.curMem)) * scale
		}
		rows = append(rows, pyjson.NewObj().
			Set("id", wid).
			Set("workloadName", getStr(w, "name")).
			Set("workloadType", strings.ToLower(getStr(w, "kind"))).
			Set("clusterName", e.Cfg.ClusterName).
			Set("namespace", getStr(w, "namespace")).
			Set("ownerCpuRequest", pyjson.Round(f64d(w.GetD("reqCpu", 0.0), 0), 4)).
			Set("ownerMemoryRequest", int64(f64d(w.GetD("reqMem", 0.0), 0))).
			Set("totalCost", pyjson.Round(f64d(w.GetD("monthlyCost", 0.0), 0)*scale, 2)).
			Set("spot", 0).
			Set("onDemand", pyjson.Round(hours, 1)).
			Set("replicas", w.GetD("replicas", 0)).
			Set("savingsAvailable", pyjson.Round(math.Max(f64d(w.GetD("savings", 0.0), 0), 0.0)*scale, 2)).
			Set("activeSavings", pyjson.Round(active, 2)))
	}
	sort.SliceStable(rows, func(i, j int) bool {
		return f64d(rows[i].GetD("totalCost", 0.0), 0) > f64d(rows[j].GetD("totalCost", 0.0), 0)
	})
	// Stacked series from the per-refresh recorder. Top 20 workloads by latest
	// cost stay named.
	lo, hi := frmV/1000, toV/1000
	e.mu.Lock()
	var samples []*pyjson.Obj
	for _, s := range e.costOvertime {
		t := i64(s.GetD("t", 0))
		if lo <= t && t <= hi {
			samples = append(samples, s)
		}
	}
	e.mu.Unlock()
	stride := len(samples) / 200
	if stride < 1 {
		stride = 1
	}
	strided := make([]*pyjson.Obj, 0, len(samples)/stride+1)
	for i := 0; i < len(samples); i += stride {
		strided = append(strided, samples[i])
	}
	samples = strided
	var topIds []string
	topSet := map[string]bool{}
	if len(samples) > 0 {
		costs := getObj(samples[len(samples)-1], "costs")
		type kvT struct {
			id string
			v  float64
		}
		kvs := make([]kvT, 0, costs.Len())
		for _, k := range costs.Keys() {
			kvs = append(kvs, kvT{k, f64d(costs.GetD(k, 0.0), 0)})
		}
		sort.SliceStable(kvs, func(i, j int) bool { return kvs[i].v > kvs[j].v })
		for i, kv := range kvs {
			if i >= 20 {
				break
			}
			topIds = append(topIds, kv.id)
			topSet[kv.id] = true
		}
	}
	costOverTime := []any{}
	for _, s := range samples {
		costs := getObj(s, "costs")
		named := []any{}
		for _, id := range topIds {
			if v, ok := costs.Get(id); ok {
				named = append(named, pyjson.NewObj().
					Set("id", id).Set("value", pyjson.Round(f64d(v, 0), 4)))
			}
		}
		other := 0.0
		for _, k := range costs.Keys() {
			if !topSet[k] {
				other += f64d(costs.GetD(k, 0.0), 0)
			}
		}
		if other > 0 {
			named = append(named, pyjson.NewObj().
				Set("id", "other").Set("value", pyjson.Round(other, 4)))
		}
		costOverTime = append(costOverTime, pyjson.NewObj().
			Set("timestamp", time.Unix(i64(s.GetD("t", 0)), 0).UTC().Format("2006-01-02T15:04:05Z")).
			Set("costs", named))
	}
	savingsPct := 0.0
	if wlCost != 0 {
		savingsPct = pyjson.Round(savings/wlCost*100, 1)
	}
	byNsOut := []any{}
	for _, a := range byNs {
		a.Set("monthlyCost", pyjson.Round(f64d(a.GetD("monthlyCost", 0.0), 0), 2))
		a.Set("savings", pyjson.Round(f64d(a.GetD("savings", 0.0), 0), 2))
		byNsOut = append(byNsOut, a)
	}
	topOut := []any{}
	for _, t := range top {
		t.Set("monthlyCost", pyjson.Round(f64d(t.GetD("monthlyCost", 0.0), 0), 2))
		t.Set("savings", pyjson.Round(f64d(t.GetD("savings", 0.0), 0), 2))
		topOut = append(topOut, t)
	}
	rowsOut := []any{}
	for _, r := range rows {
		rowsOut = append(rowsOut, r)
	}
	return pyjson.NewObj().
		Set("currency", "USD").
		Set("source", "node-price-model").
		Set("clusterName", e.Cfg.ClusterName).
		Set("cloudIntegration", pyjson.NewObj().
			Set("configured", false).
			Set("provider", "").
			Set("note", "Cost is modeled from node resources; no cloud Cost & Usage Report is connected on this cluster.")).
		Set("totals", pyjson.NewObj().
			Set("monthlyNodeCost", pyjson.Round(nodeTotal, 2)).
			Set("monthlyWorkloadCost", pyjson.Round(wlCost, 2)).
			Set("monthlySavingsAvailable", pyjson.Round(savings, 2)).
			Set("savingsPct", savingsPct)).
		Set("byNamespace", byNsOut).
		Set("topWorkloads", topOut).
		Set("byNode", byNode).
		Set("range", pyjson.NewObj().
			Set("from", frmV).Set("to", toV).Set("hours", pyjson.Round(hours, 1))).
		Set("workloads", rowsOut).
		Set("costOverTime", costOverTime), nil
}

func containsStar(lst []any) bool {
	for _, v := range lst {
		if s, ok := v.(string); ok && s == "*" {
			return true
		}
	}
	return false
}

func (e *Engine) AuthRbacData(ctx context.Context) (*pyjson.Obj, error) {
	rules := []any{}
	if cr, err := e.Kube.GetJSON(ctx, "/apis/rbac.authorization.k8s.io/v1/clusterroles/coolscaler"); err == nil {
		for _, rv := range getList(cr, "rules") {
			r := obj(rv)
			rules = append(rules, pyjson.NewObj().
				Set("apiGroups", r.GetD("apiGroups", []any{})).
				Set("resources", r.GetD("resources", []any{})).
				Set("verbs", r.GetD("verbs", []any{})))
		}
	}
	wildcard := false
	for _, rv := range rules {
		r := rv.(*pyjson.Obj)
		if containsStar(getList(r, "verbs")) && containsStar(getList(r, "resources")) {
			wildcard = true
			break
		}
	}
	roleDesc := "scoped role"
	if wildcard {
		roleDesc = "cluster-admin / wildcard"
	}
	return pyjson.NewObj().
		Set("authMode", "none").
		Set("ssoEnabled", false).
		Set("currentUser", pyjson.NewObj().
			Set("name", "coolscaler-recommender").
			Set("groups", []any{"system:serviceaccounts:" + e.Cfg.Namespace}).
			Set("role", "Admin")).
		Set("canAutomateCluster", !e.Cfg.ReadOnly).
		Set("clusterAdmin", wildcard).
		Set("clustersInfo", []any{pyjson.NewObj().
			Set("name", e.Cfg.ClusterName).
			Set("role", "Admin").
			Set("canAutomate", !e.Cfg.ReadOnly)}).
		Set("rules", rules).
		Set("note", fmt.Sprintf("CoolScaler's dashboard has no per-user authentication; every caller acts as the in-cluster ServiceAccount (%s).", roleDesc)), nil
}

func (e *Engine) CappedStatusesData() (*pyjson.Obj, error) {
	e.mu.Lock()
	wls := append([]*wlRow(nil), e.workloads...)
	e.mu.Unlock()
	seen := map[[3]string]bool{}
	out := []any{}
	for _, w := range wls {
		for _, cv := range getList(w.obj, "containers") {
			cs := getObj(obj(cv), "capStatuses")
			for _, res := range cs.Keys() {
				st := obj(cs.GetD(res, nil)) // st or {}
				if !truthy(st.GetD("isCapped", nil)) {
					continue
				}
				tup := [3]string{res, getStr(st, "cappedType"), getStr(st, "cappedSource")}
				if seen[tup] {
					continue
				}
				seen[tup] = true
				out = append(out, pyjson.NewObj().
					Set("resource", res).Set("type", tup[1]).Set("source", tup[2]))
			}
		}
	}
	return pyjson.NewObj().
		Set("cappedStatusFilterValues", out).
		Set("clusters", []any{e.Cfg.ClusterName}), nil
}

func (e *Engine) AvailableSavingsData() (*pyjson.Obj, error) {
	e.mu.Lock()
	wls := append([]*wlRow(nil), e.workloads...)
	cpuReclaim := 0.0
	if e.overview != nil {
		cpuReclaim = f64d(e.overview.GetD("cpuReclaim", 0.0), 0)
	}
	e.mu.Unlock()
	var unopt, unrec, initCpu float64
	for _, w := range wls {
		if truthy(w.obj.GetD("sizable", nil)) && !truthy(w.obj.GetD("automated", nil)) {
			unopt += math.Max(0.0, f64d(w.obj.GetD("reqCpu", 0), 0)-f64d(w.obj.GetD("recCpu", 0), 0))
		}
		if !truthy(w.obj.GetD("sizable", nil)) {
			unrec += f64d(w.obj.GetD("reqCpu", 0), 0)
		}
		for _, iv := range getList(w.obj, "initOptimization") {
			io := obj(iv)
			// float(i.get("reqCpu", i.get("cpu", 0)) or 0)
			rq := 0.0
			if v := io.GetD("reqCpu", io.GetD("cpu", 0)); truthy(v) {
				rq = f64d(v, 0)
			}
			rc := 0.0
			if v := io.GetD("recCpu", 0); truthy(v) {
				rc = f64d(v, 0)
			}
			initCpu += math.Max(0.0, rq-rc)
		}
	}
	return pyjson.NewObj().
		Set("unoptimizedWorkloads", pyjson.NewObj().Set("potentialInCpu", pyjson.Round(unopt, 3))).
		Set("unrecognizedWorkloads", pyjson.NewObj().Set("potentialInCpu", pyjson.Round(unrec, 3))).
		Set("initContainers", pyjson.NewObj().Set("potentialInCpu", pyjson.Round(initCpu, 3))).
		Set("wastedResources", pyjson.NewObj().Set("potentialInCpu", pyjson.Round(cpuReclaim, 3))), nil
}

func (e *Engine) ClustersRegistryData(ctx context.Context) ([]any, error) {
	k8sVersionMu.Lock()
	ver := k8sVersionCache
	k8sVersionMu.Unlock()
	if ver == "" {
		if d, err := e.Kube.GetJSON(ctx, "/version"); err == nil {
			ver = getStr(d, "gitVersion")
			k8sVersionMu.Lock()
			k8sVersionCache = ver
			k8sVersionMu.Unlock()
		}
	}
	return []any{pyjson.NewObj().
		Set("name", e.Cfg.ClusterName).
		Set("lastPing", isoNow()).
		Set("isOpen", true).
		Set("isParent", false).
		Set("userRole", "admin").
		Set("version", strings.TrimLeft(ver, "v")).
		Set("installDate", startTimeISO).
		Set("displayName", e.Cfg.ClusterName)}, nil
}

// ?product= narrows the aggregates to one product (rightsizing / replicas /
// placement / scheduling / java / nodes).
func (e *Engine) MulticlusterData(ctx context.Context, product string) (*pyjson.Obj, error) {
	e.mu.Lock()
	wls := append([]*wlRow(nil), e.workloads...)
	var ov *pyjson.Obj
	if e.overview != nil {
		ov = e.overview.Clone()
	} else {
		ov = pyjson.NewObj()
	}
	replAuto := map[string]bool{}
	for k := range e.replicasAutomated {
		replAuto[k] = true
	}
	e.mu.Unlock()

	include := func(w *wlRow) bool {
		switch product {
		case "rightsizing":
			return w.sizable
		case "replicas":
			return w.hpaManaged
		case "java":
			return w.java
		default: // "", placement, scheduling, nodes: whole-cluster footprint
			return true
		}
	}
	var monthlyCost, cpuReq, memReq, gpu float64
	replicas := 0
	for _, w := range wls {
		if !include(w) {
			continue
		}
		reps := float64(w.replicas)
		monthlyCost += w.monthlyCost
		cpuReq += f64d(w.obj.GetD("reqCpu", 0), 0) * reps
		memReq += f64d(w.obj.GetD("reqMem", 0), 0) * reps
		gpu += f64d(w.obj.GetD("gpuReq", 0), 0) * reps
		replicas += w.replicas
	}

	availableSavings := f64d(ov.GetD("availableSavings", 0.0), 0)
	automationPct := f64d(getObj(getObj(getObj(ov, "features"), "rightsize"), "automation").
		GetD("percentage", 0.0), 0)
	switch product {
	case "replicas":
		// state-derived HPA savings + automation (same math as /api/replicas)
		savings, auto, total := 0.0, 0, 0
		for _, w := range wls {
			if !w.hpaManaged {
				continue
			}
			total++
			if replAuto[w.key] {
				auto++
			}
			_, pol := e.replicasPolicyFor(w.key)
			recMin, _, _, _ := e.replicaRecommendation(w, pol)
			origMin := f64d(w.obj.GetD("hpaMin", 1), 1)
			if origMin < 1 {
				origMin = 1
			}
			reps := f64d(w.obj.GetD("replicas", 1), 1)
			if reps < 1 {
				reps = 1
			}
			savings += math.Max(0, origMin-float64(recMin)) * (w.monthlyCost / reps)
		}
		availableSavings = savings
		automationPct = pctOf(auto, total)
	case "placement":
		if pd, err := e.placementData(ctx); err == nil {
			t := getObj(pd, "totals")
			availableSavings = f64d(t.GetD("savings", 0.0), 0)
			automationPct = pctOf(int(i64(t.GetD("automated", 0))),
				int(i64(t.GetD("unevictableWorkloads", 0))))
			monthlyCost = f64d(t.GetD("monthlyCost", 0.0), 0)
		}
	case "scheduling":
		if sd, err := e.schedulingData(ctx); err == nil {
			t := getObj(sd, "totals")
			availableSavings = f64d(t.GetD("savings", 0.0), 0)
			automationPct = pctOf(int(i64(t.GetD("automated", 0))),
				int(i64(t.GetD("workloads", 0))))
		}
	case "java":
		if jd, err := e.JavaData(ctx); err == nil {
			t := getObj(jd, "totals")
			availableSavings = f64d(t.GetD("savings", 0.0), 0)
			automationPct = pctOf(int(i64(t.GetD("automated", 0))),
				int(i64(t.GetD("javaWorkloads", 0))))
		}
	case "nodes":
		if nt, err := e.NodeTable(ctx); err == nil {
			monthlyCost = f64d(getObj(nt, "totals").GetD("monthlyCost", 0.0), 0)
		}
		if pd, err := e.placementData(ctx); err == nil {
			t := getObj(pd, "totals")
			availableSavings = f64d(t.GetD("savings", 0.0), 0)
			automationPct = pctOf(int(i64(t.GetD("optimizedNodes", 0))),
				int(i64(t.GetD("nodes", 0))))
		}
	}

	row := pyjson.NewObj().
		Set("name", e.Cfg.ClusterName).
		Set("monthlyCost", pyjson.Round(monthlyCost, 2)).
		Set("availableSavings", pyjson.Round(availableSavings, 2)).
		Set("cpuRequest", pyjson.Round(cpuReq, 3)).
		Set("memRequest", memReq).
		Set("totalGpu", gpu).
		Set("replicas", replicas).
		Set("automationPct", pyjson.Round(automationPct, 2))
	return pyjson.NewObj().
		Set("clusters", []any{row}).
		Set("product", product), nil
}

func pctOf(n, total int) float64 {
	if total == 0 {
		return 0
	}
	return float64(n) / float64(total) * 100.0
}

func (e *Engine) PriorityClassesData(ctx context.Context) (*pyjson.Obj, error) {
	var its []any
	if d, err := e.Kube.GetJSON(ctx, "/apis/scheduling.k8s.io/v1/priorityclasses"); err == nil {
		its = items(d)
	}
	if its == nil {
		its = []any{}
	}
	for _, iv := range its {
		getObj(obj(iv), "metadata").Del("managedFields")
	}
	return pyjson.NewObj().Set("priorityClasses", its), nil
}

func (e *Engine) ClusterComparison(ctx context.Context, windowHours int) *pyjson.Obj {
	w := fmt.Sprintf("%dh", windowHours)
	metrics := []struct {
		res string
		qs  [][2]string
	}{
		{"cpu", [][2]string{
			{"allocatable", `sum(kube_node_status_allocatable{resource="cpu"})`},
			{"request", `sum(kube_pod_container_resource_requests{resource="cpu"})`},
			{"usage", `sum(rate(container_cpu_usage_seconds_total{container!="",container!="POD"}[5m]))`},
		}},
		{"mem", [][2]string{
			{"allocatable", `sum(kube_node_status_allocatable{resource="memory"})`},
			{"request", `sum(kube_pod_container_resource_requests{resource="memory"})`},
			{"usage", `sum(container_memory_working_set_bytes{container!="",container!="POD"})`},
		}},
	}
	periodA := pyjson.NewObj().Set("cpu", pyjson.NewObj()).Set("mem", pyjson.NewObj())
	periodB := pyjson.NewObj().Set("cpu", pyjson.NewObj()).Set("mem", pyjson.NewObj())
	out := pyjson.NewObj().
		Set("windowHours", windowHours).
		Set("periodA", periodA).
		Set("periodB", periodB).
		Set("ready", e.Prom != nil)
	for _, m := range metrics {
		for _, kq := range m.qs {
			k, q := kq[0], kq[1]
			getObj(periodB, m.res).Set(k, e.promScalar(ctx,
				fmt.Sprintf("avg_over_time((%s)[%s:10m])", q, w)))
			getObj(periodA, m.res).Set(k, e.promScalar(ctx,
				fmt.Sprintf("avg_over_time((%s)[%s:10m] offset %s)", q, w, w)))
		}
	}
	// "Original request" compare-card rows
	e.mu.Lock()
	var ov *pyjson.Obj
	if e.overview != nil {
		ov = e.overview.Clone()
	} else {
		ov = pyjson.NewObj()
	}
	e.mu.Unlock()
	// cluster-scope original = original requests of sizable workloads + the
	// (unchanged) current requests of everything else, so the row is directly
	// comparable to the cluster-total "Request" row above it.
	origCpuTot := f64d(ov.GetD("origCpu", 0.0), 0) +
		math.Max(0, f64d(ov.GetD("clusterReqCpu", 0.0), 0)-f64d(ov.GetD("reqCpu", 0.0), 0))
	origMemTot := f64d(ov.GetD("origMem", 0.0), 0) +
		math.Max(0, f64d(ov.GetD("clusterReqMem", 0.0), 0)-f64d(ov.GetD("reqMem", 0.0), 0))
	getObj(periodA, "cpu").Set("originalRequest", origCpuTot)
	getObj(periodB, "cpu").Set("originalRequest", origCpuTot)
	getObj(periodA, "mem").Set("originalRequest", origMemTot)
	getObj(periodB, "mem").Set("originalRequest", origMemTot)
	e.comparisonSeries(ctx, out, ov, windowHours)
	return out
}

func comparisonEmptySeries() *pyjson.Obj {
	one := func() *pyjson.Obj {
		return pyjson.NewObj().
			Set("ts", []any{}).Set("optimizedRequest", []any{}).
			Set("request", []any{}).Set("originalRequest", []any{})
	}
	return pyjson.NewObj().Set("periodA", one()).Set("periodB", one())
}

// comparisonSeries adds the Savings A/B per-period series families to the
// /api/comparison payload: - series.periodA/B.cpu|mem:
// request/usage/allocatable over time, -
// automationProgress.<product>.periodA/B: {ts, automated, total} pairs
func (e *Engine) comparisonSeries(ctx context.Context, out, ov *pyjson.Obj, windowHours int) {
	wsecs := int64(windowHours) * 3600
	if wsecs <= 0 {
		wsecs = 86400
	}
	step := wsecs / 100
	if step < 60 {
		step = 60
	}
	now := time.Now().Unix()
	type window struct {
		key        string
		start, end int64
	}
	windows := []window{
		{"periodA", now - 2*wsecs, now - wsecs},
		{"periodB", now - wsecs, now},
	}
	grid := func(win window) []int64 {
		var ts []int64
		for t := win.start; t <= win.end; t += step {
			ts = append(ts, t)
		}
		return ts
	}
	msList := func(ts []int64) []any {
		o := make([]any, 0, len(ts))
		for _, t := range ts {
			o = append(o, t*1000)
		}
		return o
	}
	mapped := func(ts []int64, m map[int64]float64) []any {
		o := make([]any, 0, len(ts))
		for _, t := range ts {
			if v, ok := m[t]; ok {
				o = append(o, v)
			} else {
				o = append(o, nil)
			}
		}
		return o
	}
	flat := func(ts []int64, v float64) []any {
		o := make([]any, 0, len(ts))
		for range ts {
			o = append(o, v)
		}
		return o
	}
	flatI := func(ts []int64, v int) []any {
		o := make([]any, 0, len(ts))
		for range ts {
			o = append(o, v)
		}
		return o
	}

	// per-period CPU/Memory request/usage/allocatable series
	qs := map[string][2]string{
		"cpu": {
			`sum(kube_pod_container_resource_requests{resource="cpu",container!=""})`,
			`sum(rate(container_cpu_usage_seconds_total{container!="",container!="POD"}[5m]))`,
		},
		"mem": {
			`sum(kube_pod_container_resource_requests{resource="memory",container!=""})`,
			`sum(container_memory_working_set_bytes{container!="",container!="POD"})`,
		},
	}
	allocQ := map[string]string{
		"cpu": `sum(kube_node_status_allocatable{resource="cpu"})`,
		"mem": `sum(kube_node_status_allocatable{resource="memory"})`,
	}
	series := pyjson.NewObj()
	reqSeriesByWin := map[string]map[string][]any{} // win -> res -> mapped request
	tsByWin := map[string][]int64{}
	for _, win := range windows {
		ts := grid(win)
		tsByWin[win.key] = ts
		perRes := pyjson.NewObj()
		reqSeriesByWin[win.key] = map[string][]any{}
		for _, res := range []string{"cpu", "mem"} {
			reqM := e.promSeriesAt(ctx, qs[res][0], win.start, win.end, step)
			useM := e.promSeriesAt(ctx, qs[res][1], win.start, win.end, step)
			alcM := e.promSeriesAt(ctx, allocQ[res], win.start, win.end, step)
			reqList := mapped(ts, reqM)
			reqSeriesByWin[win.key][res] = reqList
			perRes.Set(res, pyjson.NewObj().
				Set("ts", msList(ts)).
				Set("request", reqList).
				Set("usage", mapped(ts, useM)).
				Set("allocatable", mapped(ts, alcM)))
		}
		series.Set(win.key, perRes)
	}
	out.Set("series", series)

	// current automation / resource state
	e.mu.Lock()
	wls := append([]*wlRow(nil), e.workloads...)
	replAuto := map[string]bool{}
	for k := range e.replicasAutomated {
		replAuto[k] = true
	}
	e.mu.Unlock()
	sizPods, autoPods := 0, 0
	replPods, replAutoPods := 0, 0
	type hpaWL struct {
		w               *wlRow
		recMin          int
		origMin, curMin float64
	}
	var hpaWLs []hpaWL
	for _, w := range wls {
		if w.sizable {
			sizPods += w.replicas
			if w.automated {
				autoPods += w.replicas
			}
		}
		if w.hpaManaged {
			replPods += w.replicas
			if replAuto[w.key] {
				replAutoPods += w.replicas
			}
			_, pol := e.replicasPolicyFor(w.key)
			recMin, _, _, _ := e.replicaRecommendation(w, pol)
			origMin := f64d(w.obj.GetD("hpaMin", 1), 1)
			if origMin < 1 {
				origMin = 1
			}
			hpaWLs = append(hpaWLs, hpaWL{w: w, recMin: recMin, origMin: origMin, curMin: origMin})
		}
	}
	// replicas-optimization request totals (per-replica request x replica floors)
	var replOptCpu, replOptMem, replOrigCpu, replOrigMem float64
	var hpaPodNames []string
	for _, h := range hpaWLs {
		reqCpu := f64d(h.w.obj.GetD("reqCpu", 0), 0)
		reqMem := f64d(h.w.obj.GetD("reqMem", 0), 0)
		replOptCpu += reqCpu * float64(h.recMin)
		replOptMem += reqMem * float64(h.recMin)
		replOrigCpu += f64d(h.w.obj.GetD("origCpu", reqCpu), reqCpu) * h.origMin
		replOrigMem += f64d(h.w.obj.GetD("origMem", reqMem), reqMem) * h.origMin
		hpaPodNames = append(hpaPodNames, podNameSanitizeRe.ReplaceAllString(h.w.name, ""))
	}

	// placement / unevictable + node facts
	unevictPods, unevictAutoPods := 0, 0
	nodesTotal, optimizedNodes := 0, 0
	haveUnevict := false
	if pd, err := e.placementData(ctx); err == nil {
		haveUnevict = true
		unevictPods = int(i64(getObj(pd, "totals").GetD("unevictablePods", 0)))
		nodesTotal = int(i64(getObj(pd, "totals").GetD("nodes", 0)))
		optimizedNodes = int(i64(getObj(pd, "totals").GetD("optimizedNodes", 0)))
		for _, wv := range getList(pd, "workloads") {
			wo := obj(wv)
			if truthy(wo.GetD("automated", nil)) {
				unevictAutoPods += int(i64(wo.GetD("replicas", 0)))
			}
		}
	}
	// allocatable blocked by unevictable pods = allocatable of nodes that
	// currently host scale-down blockers.
	blockedAllocCpu, blockedAllocMem := 0.0, 0.0
	haveBlocked := false
	if nt, err := e.NodeTable(ctx); err == nil {
		haveBlocked = true
		for _, nv := range getList(nt, "nodes") {
			n := obj(nv)
			if i64(n.GetD("blockers", 0)) > 0 {
				blockedAllocCpu += f64d(n.GetD("cpuAllocatable", 0.0), 0)
				blockedAllocMem += f64d(n.GetD("memoryAllocatable", 0.0), 0)
			}
		}
	}
	// pod-scheduling (self-anti-affinity) automation counts
	schedPods, schedAutoPods := 0, 0
	haveSched := false
	if sd, err := e.schedulingData(ctx); err == nil {
		haveSched = true
		for _, wv := range getList(sd, "workloads") {
			wo := obj(wv)
			schedPods += int(i64(wo.GetD("replicas", 0)))
			if truthy(wo.GetD("automated", nil)) {
				schedAutoPods += int(i64(wo.GetD("replicas", 0)))
			}
		}
	}

	pairFor := func(automated, total int, have bool) *pyjson.Obj {
		p := pyjson.NewObj()
		for _, win := range windows {
			ts := tsByWin[win.key]
			if !have {
				p.Set(win.key, pyjson.NewObj().
					Set("ts", []any{}).Set("automated", []any{}).
					Set("total", []any{}).Set("pct", []any{}))
				continue
			}
			pct := 0.0
			if total != 0 {
				pct = float64(automated) / float64(total) * 100.0
			}
			p.Set(win.key, pyjson.NewObj().
				Set("ts", msList(ts)).
				Set("automated", flatI(ts, automated)).
				Set("total", flatI(ts, total)).
				Set("pct", flat(ts, pyjson.Round(pct, 2))))
		}
		return p
	}
	out.Set("automationProgress", pyjson.NewObj().
		Set("rightsizing", pairFor(autoPods, sizPods, true)).
		Set("unevictable", pairFor(unevictAutoPods, unevictPods, haveUnevict)).
		Set("replicas", pairFor(replAutoPods, replPods, true)).
		Set("optimizedNodes", pairFor(optimizedNodes, nodesTotal, haveUnevict)).
		Set("podScheduling", pairFor(schedAutoPods, schedPods, haveSched)))

	// ---- automated resources progress (three lines per chart) ----
	// optimized/original are re-based to cluster scope (sizable delta on top of
	// the unchanged rest) so they overlay the cluster-total request line.
	restCpu := math.Max(0, f64d(ov.GetD("clusterReqCpu", 0.0), 0)-f64d(ov.GetD("reqCpu", 0.0), 0))
	restMem := math.Max(0, f64d(ov.GetD("clusterReqMem", 0.0), 0)-f64d(ov.GetD("reqMem", 0.0), 0))
	recCpuTot := f64d(ov.GetD("recCpu", 0.0), 0) + restCpu
	recMemTot := f64d(ov.GetD("recMem", 0.0), 0) + restMem
	origCpuTot := f64d(ov.GetD("origCpu", 0.0), 0) + restCpu
	origMemTot := f64d(ov.GetD("origMem", 0.0), 0) + restMem
	threeLines := func(request map[string][]any, opt, orig float64, haveOptOrig, have bool) *pyjson.Obj {
		p := pyjson.NewObj()
		for _, win := range windows {
			ts := tsByWin[win.key]
			if !have {
				p.Set(win.key, pyjson.NewObj().
					Set("ts", []any{}).Set("optimizedRequest", []any{}).
					Set("request", []any{}).Set("originalRequest", []any{}))
				continue
			}
			optList, origList := []any{}, []any{}
			if haveOptOrig {
				optList, origList = flat(ts, opt), flat(ts, orig)
			}
			p.Set(win.key, pyjson.NewObj().
				Set("ts", msList(ts)).
				Set("optimizedRequest", optList).
				Set("request", request[win.key]).
				Set("originalRequest", origList))
		}
		return p
	}
	rsCpuReq := map[string][]any{}
	rsMemReq := map[string][]any{}
	for _, win := range windows {
		rsCpuReq[win.key] = reqSeriesByWin[win.key]["cpu"]
		rsMemReq[win.key] = reqSeriesByWin[win.key]["mem"]
	}
	replCpuReq := map[string][]any{}
	replMemReq := map[string][]any{}
	haveReplReq := len(hpaPodNames) > 0 && e.Prom != nil
	if haveReplReq {
		podf := fmt.Sprintf(`,pod=~"(%s)-.*"`, strings.Join(hpaPodNames, "|"))
		for _, win := range windows {
			ts := tsByWin[win.key]
			replCpuReq[win.key] = mapped(ts, e.promSeriesAt(ctx, fmt.Sprintf(
				`sum(kube_pod_container_resource_requests{resource="cpu",container!=""%s})`, podf),
				win.start, win.end, step))
			replMemReq[win.key] = mapped(ts, e.promSeriesAt(ctx, fmt.Sprintf(
				`sum(kube_pod_container_resource_requests{resource="memory",container!=""%s})`, podf),
				win.start, win.end, step))
		}
	}
	blockedCpuReq := map[string][]any{}
	blockedMemReq := map[string][]any{}
	for _, win := range windows {
		ts := tsByWin[win.key]
		blockedCpuReq[win.key] = flat(ts, blockedAllocCpu)
		blockedMemReq[win.key] = flat(ts, blockedAllocMem)
	}
	arp := pyjson.NewObj().
		Set("rightsizingCpu", threeLines(rsCpuReq, recCpuTot, origCpuTot, true, e.Prom != nil)).
		Set("rightsizingMem", threeLines(rsMemReq, recMemTot, origMemTot, true, e.Prom != nil)).
		Set("unevictableCpu", threeLines(blockedCpuReq, 0, 0, false, haveBlocked)).
		Set("unevictableMem", threeLines(blockedMemReq, 0, 0, false, haveBlocked)).
		Set("replicasCpu", threeLines(replCpuReq, replOptCpu, replOrigCpu, true, haveReplReq)).
		Set("replicasMem", threeLines(replMemReq, replOptMem, replOrigMem, true, haveReplReq)).
		// no eBPF/anti-affinity automation history exists on this cluster —
		// honest empty series, never fabricated.
		Set("antiAffinityCpu", comparisonEmptySeries()).
		Set("antiAffinityMem", comparisonEmptySeries())
	out.Set("automatedResourcesProgress", arp)
}

// LabelsData is the /api/labels dispatch body: distinct namespace/kind/policy
// values for filter autocomplete (M9).
func (e *Engine) LabelsData() *pyjson.Obj {
	e.mu.Lock()
	wls := append([]*wlRow(nil), e.workloads...)
	e.mu.Unlock()
	nsSet, kindSet := map[string]bool{}, map[string]bool{}
	polSet, wtSet := map[string]bool{}, map[string]bool{}
	for _, w := range wls {
		nsSet[getStr(w.obj, "namespace")] = true
		kindSet[getStr(w.obj, "kind")] = true
		if v, ok := w.obj.Get("policyName"); ok && v != nil {
			polSet[str(v)] = true
		}
		if v, ok := w.obj.Get("smartPolicyWorkloadType"); ok && v != nil {
			wtSet[str(v)] = true
		}
	}
	return pyjson.NewObj().
		Set("namespaces", strList(sortedKeys(nsSet))).
		Set("types", strList(sortedKeys(kindSet))).
		Set("policies", strList(sortedKeys(polSet))).
		Set("workloadTypes", strList(sortedKeys(wtSet)))
}

func (e *Engine) NamespacesData() *pyjson.Obj {
	e.mu.Lock()
	wls := append([]*wlRow(nil), e.workloads...)
	e.mu.Unlock()
	agg := pyjson.NewObj() // namespace -> agg dict, insertion-ordered
	for _, w := range wls {
		ns := getStr(w.obj, "namespace")
		var a *pyjson.Obj
		if v, ok := agg.Get(ns); ok {
			a = v.(*pyjson.Obj)
		} else {
			a = pyjson.NewObj().Set("namespace", ns).Set("workloads", 0).Set("savings", 0.0)
			agg.Set(ns, a)
		}
		a.Set("workloads", int(i64(a.GetD("workloads", 0)))+1)
		a.Set("savings", f64d(a.GetD("savings", 0.0), 0)+math.Max(f64d(w.obj.GetD("savings", 0.0), 0), 0.0))
	}
	vals := make([]*pyjson.Obj, 0, agg.Len())
	for _, k := range agg.Keys() {
		vals = append(vals, obj(agg.GetD(k, nil)))
	}
	sort.SliceStable(vals, func(i, j int) bool {
		return f64d(vals[i].GetD("savings", 0.0), 0) > f64d(vals[j].GetD("savings", 0.0), 0)
	})
	out := []any{}
	for _, v := range vals {
		out = append(out, v)
	}
	return pyjson.NewObj().Set("namespaces", out)
}

// AutoDetectedPolicies is the /api/auto-detected-policies dispatch
// body.
func (e *Engine) AutoDetectedPolicies() *pyjson.Obj {
	e.mu.Lock()
	wls := append([]*wlRow(nil), e.workloads...)
	e.mu.Unlock()
	smartSet, typeSet := map[string]bool{}, map[string]bool{}
	for _, w := range wls {
		if truthy(w.obj.GetD("usingSmartPolicy", nil)) {
			if v, ok := w.obj.Get("smartPolicyName"); ok && v != nil {
				smartSet[str(v)] = true
			}
		}
		if v, ok := w.obj.Get("smartPolicyWorkloadType"); ok && v != nil {
			typeSet[str(v)] = true
		}
	}
	return pyjson.NewObj().
		Set("smartDetectedPolicies", strList(sortedKeys(smartSet))).
		Set("smartWorkloadTypes", strList(sortedKeys(typeSet))).
		Set("customDetectedPolicies", []any{})
}

// AvailableActionsData is the /api/available-actions dispatch body: the feature/product
// catalog that drives card & nav visibility: shouldDisplay + waste + counts.
func (e *Engine) AvailableActionsData() *pyjson.Obj {
	e.mu.Lock()
	defer e.mu.Unlock()
	ov := e.overview
	if ov == nil {
		ov = pyjson.NewObj()
	}
	f := getObj(ov, "features")
	pr := getObj(ov, "products")
	rs := getObj(f, "rightsize")
	return pyjson.NewObj().Set("features", pyjson.NewObj().
		Set("rightsize", pyjson.NewObj().
			Set("shouldDisplay", f64d(getObj(pr, "rightsizing").GetD("workloads", 0), 0) > 0).
			Set("rolloutCount", getObj(rs, "automation").GetD("actionableUnautomated", 0)).
			Set("waste", pyjson.RoundInt(f64d(ov.GetD("savingsPct", 0), 0))).
			Set("workloadsWaste", getObj(pr, "rightsizing").GetD("workloads", 0)).
			Set("jvmOptimizationCount", getObj(ov, "signals").GetD("initOpt", 0))).
		Set("replicasOptimization", pyjson.NewObj().
			Set("shouldDisplay", f64d(getObj(pr, "replicas").GetD("workloads", 0), 0) > 0).
			Set("workloadsWaste", getObj(pr, "replicas").GetD("workloads", 0))).
		Set("podPlacement", pyjson.NewObj().
			Set("shouldDisplay", f64d(getObj(pr, "podPlacement").GetD("workloads", 0), 0) > 0).
			Set("workloadsWaste", getObj(pr, "podPlacement").GetD("workloads", 0))).
		Set("nodes", pyjson.NewObj().
			Set("shouldDisplay", true).
			Set("blockedNodesCount", getObj(pr, "podPlacement").GetD("blockedNodes", 0))).
		Set("nodeOptimization", pyjson.NewObj().Set("shouldDisplay", false)).
		Set("gpuRightsize", pyjson.NewObj().Set("shouldDisplay", false)).
		Set("spotOptimization", pyjson.NewObj().
			Set("shouldDisplay", f64d(getObj(pr, "spot").GetD("workloads", 0), 0) > 0).
			Set("workloadsWaste", getObj(pr, "spot").GetD("workloads", 0))))
}

// Durable analytics: persist the ANALYTICS snapshot buffer to a file so usage
// history survives recommender restarts. Off unless ANALYTICS_FILE is set.

func (e *Engine) loadAnalytics() {
	if analyticsFile == "" {
		return
	}
	raw, err := os.ReadFile(analyticsFile)
	if err != nil {
		if os.IsNotExist(err) {
			return
		}
		e.Log.Info(fmt.Sprintf("analytics load error: %v", err))
		return
	}
	v, err := pyjson.Decode(raw)
	if err != nil {
		e.Log.Info(fmt.Sprintf("analytics load error: %v", err))
		return
	}
	data, _ := v.([]any)
	cutoff := float64(time.Now().Unix()) - float64(rangeSeconds["30d"])
	e.mu.Lock()
	for _, sv := range data {
		s, ok := sv.(*pyjson.Obj)
		if !ok {
			continue
		}
		if f64d(s.GetD("t", 0), 0) >= cutoff {
			e.analytics = append(e.analytics, s)
		}
	}
	// keep the tail.
	if max := e.Cfg.AnalyticsPoints; max > 0 && len(e.analytics) > max {
		e.analytics = e.analytics[len(e.analytics)-max:]
	}
	n := len(e.analytics)
	e.mu.Unlock()
	e.Log.Info(fmt.Sprintf("loaded %d analytics points from %s", n, analyticsFile))
}

func (e *Engine) saveAnalytics() {
	if analyticsFile == "" {
		return
	}
	e.mu.Lock()
	data := make([]any, len(e.analytics))
	for i, s := range e.analytics {
		data[i] = s
	}
	e.mu.Unlock()
	tmp := analyticsFile + ".tmp"
	if err := os.WriteFile(tmp, pyjson.Marshal(data), 0o644); err != nil {
		e.Log.Info(fmt.Sprintf("analytics save error: %v", err))
		return
	}
	if err := os.Rename(tmp, analyticsFile); err != nil {
		e.Log.Info(fmt.Sprintf("analytics save error: %v", err))
	}
}
