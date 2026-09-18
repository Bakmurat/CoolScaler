package engine

import (
	"context"
	"sort"
	"strings"

	"coolscaler.sh/coolscaler/internal/pyjson"
)

// nodeCapType extracts the spot/on-demand capacity-type label chain used by
// node_table / node_detail / refresh.
func nodeCapType(lbl *pyjson.Obj) string {
	for _, k := range []string{
		"karpenter.sh/capacity-type", "eks.amazonaws.com/capacityType",
		"node.kubernetes.io/capacity-type", "cloud.google.com/gke-spot",
	} {
		if v := getStr(lbl, k); v != "" {
			return strings.ToLower(v)
		}
	}
	return ""
}

func nodeInstanceType(lbl *pyjson.Obj) string {
	if v := getStr(lbl, "node.kubernetes.io/instance-type"); v != "" {
		return v
	}
	return getStr(lbl, "beta.kubernetes.io/instance-type")
}

// nodeGroup extracts the node-pool/group name from the common provider label
// chains; "" when the cluster has no grouping labels (column renders "—").
func nodeGroup(lbl *pyjson.Obj) string {
	for _, k := range []string{
		"eks.amazonaws.com/nodegroup", "cloud.google.com/gke-nodepool",
		"karpenter.sh/nodepool", "karpenter.sh/provisioner-name",
		"kops.k8s.io/instancegroup", "node.kubernetes.io/instancegroup",
		"agentpool", "kubernetes.azure.com/agentpool",
		"rke.cattle.io/pool-name", "cluster.x-k8s.io/deployment-name",
	} {
		if v := getStr(lbl, k); v != "" {
			return v
		}
	}
	return ""
}

// podUsageIndex builds the (ns,name) -> (cpu,mem) usage map from the metrics
// API response (shared by node_table / node_detail).
func podUsageIndex(metrics *pyjson.Obj) map[[2]string][2]float64 {
	usage := map[[2]string][2]float64{}
	for _, mv := range items(metrics) {
		m := obj(mv)
		md := getObj(m, "metadata")
		var cu, cm float64
		for _, cv := range getList(m, "containers") {
			u := getObj(obj(cv), "usage")
			cu += ParseCPU(u.GetD("cpu", nil))
			cm += ParseMem(u.GetD("memory", nil))
		}
		usage[[2]string{getStr(md, "namespace"), getStr(md, "name")}] = [2]float64{cu, cm}
	}
	return usage
}

func (e *Engine) NodeTable(ctx context.Context) (*pyjson.Obj, error) {
	nodes, err := e.Kube.GetJSON(ctx, "/api/v1/nodes")
	if err != nil {
		return nil, err
	}
	pods, err := e.Kube.GetJSON(ctx, "/api/v1/pods")
	if err != nil {
		return nil, err
	}
	metrics, err := e.Kube.GetJSON(ctx, "/apis/metrics.k8s.io/v1beta1/pods")
	if err != nil {
		metrics = pyjson.NewObj().Set("items", []any{})
	}
	usage := podUsageIndex(metrics)

	// init per-node accumulators, preserving node-list order
	byName := map[string]*pyjson.Obj{}
	var order []*pyjson.Obj
	for _, nv := range items(nodes) {
		n := obj(nv)
		md := getObj(n, "metadata")
		st := getObj(n, "status")
		lbl := getObj(md, "labels")
		captype := nodeCapType(lbl)
		alloc := getObj(st, "allocatable")
		ready := false
		for _, cv := range getList(st, "conditions") {
			c := obj(cv)
			if getStr(c, "type") == "Ready" && getStr(c, "status") == "True" {
				ready = true
			}
		}
		taints := []any{}
		for _, tv := range getList(getObj(n, "spec"), "taints") {
			taints = append(taints, obj(tv).GetD("key", nil))
		}
		maxPods := int(ParseCPU(alloc.GetD("pods", nil)))
		if maxPods == 0 {
			maxPods = 110
		}
		isSpot := captype == "spot" || captype == "true"
		discountType := "" // no cloud RI/SavingsPlan discounts on this cluster
		if isSpot {
			discountType = "spot"
		}
		nd := pyjson.NewObj().
			Set("name", getStr(md, "name")).
			Set("instanceType", nodeInstanceType(lbl)).
			Set("nodeGroup", nodeGroup(lbl)).
			Set("discountType", discountType).
			Set("isSpot", isSpot).
			Set("cpuAllocatable", ParseCPU(alloc.GetD("cpu", nil))).
			Set("memoryAllocatable", ParseMem(alloc.GetD("memory", nil))).
			Set("maxPods", maxPods).
			Set("cpuRequest", 0.0).Set("memoryRequest", 0.0).
			Set("cpuUsage", 0.0).Set("memoryUsage", 0.0).
			Set("runningPods", 0).Set("daemonSetPods", 0).Set("pendingPods", 0).
			Set("blockers", 0).Set("blockerReasons", pyjson.NewObj()).
			Set("ready", ready).
			Set("taints", taints)
		gpus := int(f64d(anyQuantityFloat(alloc.GetD("nvidia.com/gpu", nil)), 0))
		nd.Set("gpus", gpus)
		cost, pricedBy := e.nodeMonthlyCost(
			getStr(nd, "instanceType"), truthy(nd.GetD("isSpot", false)),
			f64d(nd.GetD("cpuAllocatable", 0.0), 0), f64d(nd.GetD("memoryAllocatable", 0.0), 0),
			float64(gpus))
		nd.Set("cost", cost).Set("pricedBy", pricedBy)
		byName[getStr(md, "name")] = nd
		order = append(order, nd)
	}

	for _, pv := range items(pods) {
		p := obj(pv)
		spec := getObj(p, "spec")
		md := getObj(p, "metadata")
		node := getStr(spec, "nodeName")
		phase := getStr(getObj(p, "status"), "phase")
		nd, okNode := byName[node]
		if node == "" || !okNode {
			continue
		}
		if phase == "Pending" {
			nd.Set("pendingPods", int(i64(nd.GetD("pendingPods", 0)))+1)
			continue
		}
		nd.Set("runningPods", int(i64(nd.GetD("runningPods", 0)))+1)
		for _, ov := range getList(md, "ownerReferences") {
			if getStr(obj(ov), "kind") == "DaemonSet" {
				nd.Set("daemonSetPods", int(i64(nd.GetD("daemonSetPods", 0)))+1)
				break
			}
		}
		for _, cv := range getList(spec, "containers") {
			req := getObj(getObj(obj(cv), "resources"), "requests")
			nd.Set("cpuRequest", f64d(nd.GetD("cpuRequest", 0.0), 0)+ParseCPU(req.GetD("cpu", nil)))
			nd.Set("memoryRequest", f64d(nd.GetD("memoryRequest", 0.0), 0)+ParseMem(req.GetD("memory", nil)))
		}
		u := usage[[2]string{getStr(md, "namespace"), getStr(md, "name")}]
		nd.Set("cpuUsage", f64d(nd.GetD("cpuUsage", 0.0), 0)+u[0])
		nd.Set("memoryUsage", f64d(nd.GetD("memoryUsage", 0.0), 0)+u[1])
		if reason := podUnevictable(p); reason != "" {
			nd.Set("blockers", int(i64(nd.GetD("blockers", 0)))+1)
			br := getObj(nd, "blockerReasons")
			br.Set(reason, int(i64(br.GetD(reason, 0)))+1)
		}
	}

	rows := make([]*pyjson.Obj, len(order))
	copy(rows, order)
	sort.SliceStable(rows, func(i, j int) bool {
		return f64d(rows[i].GetD("cost", 0.0), 0) > f64d(rows[j].GetD("cost", 0.0), 0)
	})
	var totAllocCpu, totAllocMem, totCost, sReqCpu, sUseCpu, sReqMem, sUseMem float64
	spotNodes, blockedNodes := 0, 0
	for _, r := range rows {
		totAllocCpu += f64d(r.GetD("cpuAllocatable", 0.0), 0)
		totAllocMem += f64d(r.GetD("memoryAllocatable", 0.0), 0)
		totCost += f64d(r.GetD("cost", 0.0), 0)
		sReqCpu += f64d(r.GetD("cpuRequest", 0.0), 0)
		sUseCpu += f64d(r.GetD("cpuUsage", 0.0), 0)
		sReqMem += f64d(r.GetD("memoryRequest", 0.0), 0)
		sUseMem += f64d(r.GetD("memoryUsage", 0.0), 0)
		if truthy(r.GetD("isSpot", false)) {
			spotNodes++
		}
		if i64(r.GetD("blockers", 0)) > 0 {
			blockedNodes++
		}
	}
	divCpu, divMem := totAllocCpu, totAllocMem
	if divCpu == 0 {
		divCpu = 1
	}
	if divMem == 0 {
		divMem = 1
	}
	rowsAny := make([]any, len(rows))
	for i, r := range rows {
		rowsAny[i] = r
	}
	totals := pyjson.NewObj().
		Set("nodes", len(rows)).
		Set("monthlyCost", totCost).
		Set("cpuAllocatable", totAllocCpu).
		Set("memoryAllocatable", totAllocMem).
		Set("cpuRequestPct", sReqCpu/divCpu*100.0).
		Set("cpuUsagePct", sUseCpu/divCpu*100.0).
		Set("memoryRequestPct", sReqMem/divMem*100.0).
		Set("memoryUsagePct", sUseMem/divMem*100.0).
		Set("spotNodes", spotNodes).
		Set("blockedNodes", blockedNodes)
	return pyjson.NewObj().
		Set("nodes", rowsAny).
		Set("totals", totals).
		Set("clusterName", e.Cfg.ClusterName), nil
}

func anyQuantityFloat(v any) float64 {
	if v == nil {
		return 0
	}
	if f, ok := f64(v); ok {
		return f
	}
	if s, ok := v.(string); ok {
		if f, ok := parseFloatPy(s); ok {
			return f
		}
	}
	return 0
}
