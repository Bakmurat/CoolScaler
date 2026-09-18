package engine

import (
	"context"
	"sort"
	"strings"

	"coolscaler.sh/coolscaler/internal/pyjson"
)

func (e *Engine) NodeDetail(ctx context.Context, name string) (*pyjson.Obj, error) {
	node, err := e.Kube.GetJSON(ctx, "/api/v1/nodes/"+name)
	if err != nil {
		return pyjson.NewObj().Set("found", false).Set("name", name), nil
	}
	md := getObj(node, "metadata")
	st := getObj(node, "status")
	spec := getObj(node, "spec")
	lbl := getObj(md, "labels")
	alloc := getObj(st, "allocatable")
	aCpu := ParseCPU(alloc.GetD("cpu", nil))
	aMem := ParseMem(alloc.GetD("memory", nil))
	gpus := int(anyQuantityFloat(alloc.GetD("nvidia.com/gpu", nil)))
	captype := ""
	for _, k := range []string{
		"karpenter.sh/capacity-type", "eks.amazonaws.com/capacityType",
		"node.kubernetes.io/capacity-type", "cloud.google.com/gke-spot",
	} {
		if v := getStr(lbl, k); v != "" {
			captype = v
			break
		}
	}
	captype = strings.ToLower(captype)
	isSpot := captype == "spot" || captype == "true"
	itype := nodeInstanceType(lbl)
	cost, priced := e.nodeMonthlyCost(itype, isSpot, aCpu, aMem, float64(gpus))
	ready := false
	for _, cv := range getList(st, "conditions") {
		c := obj(cv)
		if getStr(c, "type") == "Ready" && getStr(c, "status") == "True" {
			ready = true
		}
	}
	taints := getList(spec, "taints")
	noScheduleTaint := false
	for _, tv := range taints {
		eff := getStr(obj(tv), "effect")
		if eff == "NoSchedule" || eff == "NoExecute" {
			noScheduleTaint = true
		}
	}
	schedulable := !truthy(spec.GetD("unschedulable", nil)) && !noScheduleTaint

	pods, err := e.Kube.GetJSON(ctx, "/api/v1/pods")
	if err != nil {
		return nil, err
	}
	metrics, err := e.Kube.GetJSON(ctx, "/apis/metrics.k8s.io/v1beta1/pods")
	if err != nil {
		metrics = pyjson.NewObj().Set("items", []any{})
	}
	usage := podUsageIndex(metrics)
	rsIndex := map[string]*ownerRef{}
	if rss, err := e.Kube.GetJSON(ctx, "/apis/apps/v1/replicasets"); err == nil {
		rsIndex = buildOwnerIndex(rss)
	}
	pdbIndex := e.buildPDBIndex(ctx)

	var podRows []*pyjson.Obj
	var reqCpu, reqMem, useCpu, useMem float64
	for _, pv := range items(pods) {
		p := obj(pv)
		if getStr(getObj(p, "spec"), "nodeName") != name {
			continue
		}
		ph := getStr(getObj(p, "status"), "phase")
		if ph != "Running" && ph != "Pending" {
			continue
		}
		pm := getObj(p, "metadata")
		var rc, rm float64
		for _, cv := range getList(getObj(p, "spec"), "containers") {
			r := getObj(obj(obj(cv).GetD("resources", nil)), "requests")
			rc += ParseCPU(r.GetD("cpu", nil))
			rm += ParseMem(r.GetD("memory", nil))
		}
		u := usage[[2]string{getStr(pm, "namespace"), getStr(pm, "name")}]
		cu, cm := u[0], u[1]
		reqCpu += rc
		reqMem += rm
		useCpu += cu
		useMem += cm
		_, kind, _ := topOwner(p, rsIndex)
		reasons := unevictableReasons(p, pdbIndex)
		readyP := false
		for _, cv := range getList(getObj(p, "status"), "conditions") {
			c := obj(cv)
			if getStr(c, "type") == "Ready" && getStr(c, "status") == "True" {
				readyP = true
			}
		}
		if ph == "Running" && !readyP {
			reasons = append(reasons, "unready")
		}
		blockers := []any{}
		for _, r := range reasons {
			chip, ok := placementReasonChip[r]
			if !ok {
				chip = r // PLACEMENT_REASON_CHIP.get(r, r)
			}
			blockers = append(blockers, chip)
		}
		podRows = append(podRows, pyjson.NewObj().
			Set("namespace", getStr(pm, "namespace")).
			Set("name", getStr(pm, "name")).
			Set("workloadKind", kind).
			Set("cpuReq", rc).Set("cpuUse", cu).Set("memReq", rm).Set("memUse", cm).
			Set("blockers", blockers).
			Set("creationTimestamp", pm.GetD("creationTimestamp", nil)))
	}
	sort.SliceStable(podRows, func(i, j int) bool {
		return f64d(podRows[i].GetD("cpuReq", 0.0), 0) > f64d(podRows[j].GetD("cpuReq", 0.0), 0)
	})

	events := []any{}
	if ev, err := e.Kube.GetJSON(ctx,
		"/api/v1/events?fieldSelector=involvedObject.kind=Node,involvedObject.name="+name); err == nil {
		for _, iv := range items(ev) {
			it := obj(iv)
			lt := it.GetD("lastTimestamp", nil)
			if !truthy(lt) {
				lt = it.GetD("eventTime", nil)
			}
			events = append(events, pyjson.NewObj().
				Set("type", it.GetD("type", "")).
				Set("reason", it.GetD("reason", "")).
				Set("message", it.GetD("message", "")).
				Set("count", it.GetD("count", 1)).
				Set("lastTimestamp", lt))
		}
		sort.SliceStable(events, func(i, j int) bool {
			// key = x.get("lastTimestamp") or "", reverse=True
			return str(obj(events[i]).GetD("lastTimestamp", nil)) >
				str(obj(events[j]).GetD("lastTimestamp", nil))
		})
	}

	ninfo := getObj(st, "nodeInfo")
	taintRows := []any{}
	for _, tv := range taints {
		t := obj(tv)
		taintRows = append(taintRows, pyjson.NewObj().
			Set("key", t.GetD("key", nil)).
			Set("value", t.GetD("value", nil)).
			Set("effect", t.GetD("effect", nil)))
	}
	podRowsAny := []any{}
	for _, pr := range podRows {
		podRowsAny = append(podRowsAny, pr)
	}
	maxPods := int(ParseCPU(alloc.GetD("pods", nil)))
	if maxPods == 0 { // int(parse_cpu(...) or 110)
		maxPods = 110
	}
	return pyjson.NewObj().
		Set("found", true).Set("name", name).Set("cost", cost).Set("pricedBy", priced).Set("isSpot", isSpot).
		Set("instanceType", itype).Set("ready", ready).Set("schedulable", schedulable).
		Set("creationTimestamp", md.GetD("creationTimestamp", nil)).
		Set("kubeletVersion", ninfo.GetD("kubeletVersion", nil)).
		Set("os", ninfo.GetD("osImage", nil)).
		Set("containerRuntime", ninfo.GetD("containerRuntimeVersion", nil)).
		Set("allocatable", pyjson.NewObj().
			Set("cpu", aCpu).Set("mem", aMem).
			Set("pods", maxPods).Set("gpu", gpus)).
		Set("request", pyjson.NewObj().Set("cpu", reqCpu).Set("mem", reqMem)).
		Set("usage", pyjson.NewObj().Set("cpu", useCpu).Set("mem", useMem)).
		Set("taints", taintRows).
		Set("labels", lbl).Set("podCount", len(podRows)).Set("pods", podRowsAny).Set("events", events).
		Set("node", node).Set("clusterName", e.Cfg.ClusterName), nil
}

// PVCs support expansion but NOT in-place shrink, so low utilization is
// reported as over-provisioned/informational, never claimed as reclaimable.
func (e *Engine) VolumesData(ctx context.Context) (*pyjson.Obj, error) {
	if e.Prom == nil {
		return pyjson.NewObj().
			Set("volumes", []any{}).
			Set("totals", pyjson.NewObj()).
			Set("note", "no Prometheus"), nil
	}
	type pvcKey [2]string // (namespace, persistentvolumeclaim)
	used := map[pvcKey]float64{}
	cap_ := map[pvcKey]float64{}
	var capOrder []pvcKey
	for _, r := range e.promQuery(ctx, "kubelet_volume_stats_used_bytes") {
		k := pvcKey{r.Metric["namespace"], r.Metric["persistentvolumeclaim"]}
		if k[0] != "" && k[1] != "" {
			used[k] = r.Value
		}
	}
	for _, r := range e.promQuery(ctx, "kubelet_volume_stats_capacity_bytes") {
		k := pvcKey{r.Metric["namespace"], r.Metric["persistentvolumeclaim"]}
		if k[0] != "" && k[1] != "" {
			if _, seen := cap_[k]; !seen {
				capOrder = append(capOrder, k)
			}
			cap_[k] = r.Value
		}
	}
	var rows []*pyjson.Obj
	var totCap, totUsed float64
	for _, k := range capOrder {
		c := cap_[k]
		u := used[k] // 0.0 default
		util := 0.0
		if c != 0 {
			util = u / c * 100.0
		}
		over := c - u
		if over < 0 {
			over = 0.0 // max(0.0, c - u)
		}
		rec := u * 1.25
		if giB := float64(1 << 30); rec < giB {
			rec = giB
		}
		if rec > c {
			rec = c // min(c, max(u*1.25, 1Gi))
		}
		rows = append(rows, pyjson.NewObj().
			Set("namespace", k[0]).Set("pvc", k[1]).
			Set("usedBytes", u).Set("capacityBytes", c).
			Set("utilizationPct", pyjson.Round(util, 1)).
			Set("overProvisionedBytes", over).
			Set("recommendedBytes", rec))
		totCap += c
		totUsed += u
	}
	// sort key = -(capacityBytes - usedBytes) -> descending headroom, stable
	sort.SliceStable(rows, func(i, j int) bool {
		hi := f64d(rows[i].GetD("capacityBytes", 0.0), 0) - f64d(rows[i].GetD("usedBytes", 0.0), 0)
		hj := f64d(rows[j].GetD("capacityBytes", 0.0), 0) - f64d(rows[j].GetD("usedBytes", 0.0), 0)
		return hi > hj
	})
	rowsAny := []any{}
	for _, r := range rows {
		rowsAny = append(rowsAny, r)
	}
	overPct := 0.0
	if totCap != 0 {
		overPct = pyjson.Round((totCap-totUsed)/totCap*100.0, 1)
	}
	return pyjson.NewObj().
		Set("volumes", rowsAny).
		Set("totals", pyjson.NewObj().
			Set("count", len(rows)).
			Set("capacityBytes", totCap).
			Set("usedBytes", totUsed).
			Set("overProvisionedPct", overPct)), nil
}

func (e *Engine) NodeOptimizationData(ctx context.Context) (*pyjson.Obj, error) {
	nt, err := e.NodeTable(ctx)
	if err != nil {
		return nil, err
	}
	rows := getList(nt, "nodes")
	allowed := map[string]bool{}
	blocked := map[string]bool{}
	e.mu.Lock()
	for _, v := range getList(e.globalAuto, "allowedInstanceTypes") {
		allowed[strings.ToLower(str(v))] = true
	}
	for _, v := range getList(e.globalAuto, "blockedInstanceTypes") {
		blocked[strings.ToLower(str(v))] = true
	}
	e.mu.Unlock()

	// instance-type catalog observed in the cluster + admin pool status
	// (defaultdict insertion order = first-seen instance type over rows)
	type typeAgg struct {
		nodes       int
		monthlyCost float64
	}
	byType := map[string]*typeAgg{}
	var typeOrder []string
	for _, rv := range rows {
		r := obj(rv)
		it := getStr(r, "instanceType")
		if it == "" {
			it = "unknown"
		}
		agg, ok := byType[it]
		if !ok {
			agg = &typeAgg{}
			byType[it] = agg
			typeOrder = append(typeOrder, it)
		}
		agg.nodes++
		agg.monthlyCost += f64d(r.GetD("cost", 0.0), 0)
	}
	sortedTypes := make([]string, len(typeOrder))
	copy(sortedTypes, typeOrder)
	sort.SliceStable(sortedTypes, func(i, j int) bool {
		return byType[sortedTypes[i]].monthlyCost > byType[sortedTypes[j]].monthlyCost
	})
	instanceTypes := []any{}
	for _, it := range sortedTypes {
		agg := byType[it]
		itl := strings.ToLower(it)
		status := "not-allowed"
		if blocked[itl] {
			status = "blocked"
		} else if len(allowed) == 0 || allowed[itl] {
			status = "allowed"
		}
		instanceTypes = append(instanceTypes, pyjson.NewObj().
			Set("instanceType", it).
			Set("nodes", agg.nodes).
			Set("monthlyCost", pyjson.Round(agg.monthlyCost, 2)).
			Set("status", status))
	}

	// consolidation candidates: under-utilized (cpu request < 45% of
	// allocatable) AND unblocked (no unevictable pods) nodes whose pods could
	// bin-pack elsewhere.
	var candidates []*pyjson.Obj
	for _, rv := range rows {
		r := obj(rv)
		capC := f64d(r.GetD("cpuAllocatable", nil), 0)
		if capC == 0 {
			capC = 1
		}
		util := f64d(r.GetD("cpuRequest", 0), 0) / capC * 100.0
		if i64(r.GetD("blockers", 0)) == 0 && util < 45.0 && i64(r.GetD("runningPods", 0)) <= 12 {
			candidates = append(candidates, pyjson.NewObj().
				Set("node", getStr(r, "name")).
				Set("instanceType", r.GetD("instanceType", nil)).
				Set("cpuRequestPct", pyjson.Round(util, 1)).
				Set("runningPods", r.GetD("runningPods", 0)).
				Set("monthlyCost", pyjson.Round(f64d(r.GetD("cost", 0.0), 0), 2)).
				Set("isSpot", r.GetD("isSpot", false)))
		}
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		return f64d(candidates[i].GetD("monthlyCost", 0.0), 0) > f64d(candidates[j].GetD("monthlyCost", 0.0), 0)
	})
	potentialSavingsAny := any(0)
	potentialSavings := 0.0
	candidatesAny := []any{}
	for _, c := range candidates {
		potentialSavings += f64d(c.GetD("monthlyCost", 0.0), 0)
		candidatesAny = append(candidatesAny, c)
	}
	if len(candidates) > 0 {
		potentialSavingsAny = pyjson.Round(potentialSavings, 2)
	}
	optimizedNodes := len(rows) - len(candidates)
	if optimizedNodes < 0 {
		optimizedNodes = 0
	}
	return pyjson.NewObj().
		Set("instanceTypes", instanceTypes).
		Set("consolidation", pyjson.NewObj().
			Set("candidates", candidatesAny).
			Set("candidateCount", len(candidates)).
			Set("potentialMonthlySavings", potentialSavingsAny).
			Set("currentNodes", len(rows)).
			Set("optimizedNodes", optimizedNodes)).
		Set("allowedInstanceTypes", strList(sortedKeys(allowed))).
		Set("blockedInstanceTypes", strList(sortedKeys(blocked))).
		Set("clusterName", e.Cfg.ClusterName), nil
}
