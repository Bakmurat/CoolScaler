package engine

import (
	"context"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"coolscaler.sh/coolscaler/internal/pyjson"
)

// Page data builders: Policies, Policy Rules, Custom Workloads (+ over-time),
// Replicas Optimization, Replicas Policies, Downscaler.

func (e *Engine) policyRowObj(name string, spec *pyjson.Obj, desc string, used map[string]int, total int, builtin bool) *pyjson.Obj {
	kb := e.policyKnobs(spec)
	return pyjson.NewObj().
		Set("name", name).
		Set("description", desc).
		Set("usedBy", used[name]).
		Set("total", total).
		Set("window", kb.window).
		Set("cpuPercentile", kb.cpuPct).
		Set("memPercentile", kb.memPct).
		Set("cpuHeadroom", pyjson.RoundInt((kb.cpuHead-1)*100)).
		Set("memHeadroom", pyjson.RoundInt((kb.memHead-1)*100)).
		Set("strategy", kb.strategy).
		Set("inPlace", kb.inPlace).
		Set("autoHealing", kb.autoHeal).
		Set("burstReaction", kb.burst).
		Set("bootTime", kb.bootTime).
		Set("initOpt", kb.initOpt).
		Set("ephOpt", kb.ephOpt).
		Set("ephReduce", kb.ephReduce).
		Set("ephPercentile", kb.ephPct).
		Set("ephHeadroom", pyjson.RoundInt((kb.ephHead-1)*100)).
		Set("ephWindow", kb.ephWindow).
		Set("limitStrategy", kb.limitStrategy).
		Set("builtin", builtin).
		Set("schedule", false)
}

// schedule policies listed last.
func (e *Engine) PoliciesData(ctx context.Context) (*pyjson.Obj, error) {
	e.mu.Lock()
	rows := append([]*wlRow(nil), e.workloads...)
	scheds := append([]*schedulePolicy(nil), e.schedulePolicies...)
	e.mu.Unlock()
	total := len(rows)
	used := map[string]int{}
	for _, w := range rows {
		used[str(w.obj.GetD("policyName", "production"))]++
	}
	crs, crOrder := e.loadPolicyCRs(ctx)
	out := []*pyjson.Obj{}
	seen := map[string]bool{}
	for _, d := range e.builtinPolicies() {
		// detection-gated builtins (prometheus / high-replica) stay hidden until
		// a matching workload type exists (or their CR was already created).
		if conditionalBuiltinPolicyNames[d.name] && crs[d.name] == nil && !e.builtinPolicyDetected(d.name) {
			continue
		}
		spec := e.policySpec(d.args)
		s := spec
		if live, ok := crs[d.name].GetD("spec", nil).(*pyjson.Obj); ok &&
			live.Len() > 0 && str(live.GetD("type", nil)) != "Schedule" {
			s = live
		}
		out = append(out, e.policyRowObj(d.name, s, d.desc, used, total, true))
		seen[d.name] = true
	}
	for _, name := range crOrder {
		if seen[name] {
			continue
		}
		cr := crs[name]
		// the retired `default` builtin CR is deleted at startup by the seed
		// migration; skip it defensively until that runs (never list it).
		if name == "default" &&
			truthy(getObj(getObj(cr, "metadata"), "labels").GetD("coolscaler.sh/builtin-policy", nil)) {
			continue
		}
		spec := getObj(cr, "spec")
		if str(spec.GetD("type", nil)) == "Schedule" {
			continue // schedule policies are listed separately below
		}
		desc := str(getObj(getObj(cr, "metadata"), "annotations").
			GetD("coolscaler.sh/description", "This is a custom policy created by the user."))
		out = append(out, e.policyRowObj(name, spec, desc, used, total, false))
		seen[name] = true
	}
	sort.SliceStable(out, func(i, j int) bool {
		ui, uj := int(i64(out[i].GetD("usedBy", 0))), int(i64(out[j].GetD("usedBy", 0)))
		if ui != uj {
			return ui > uj
		}
		return str(out[i].GetD("name", "")) < str(out[j].GetD("name", ""))
	})
	// Schedule policies (type=Schedule) — shown with the currently-active sub-policy.
	now := time.Now()
	policies := []any{}
	for _, r := range out {
		policies = append(policies, r)
	}
	for _, sched := range scheds {
		// Replica/downscale schedule policies belong to the Replicas page only
		if replicaSchedulePolicyNames[sched.name] {
			continue
		}
		policies = append(policies, pyjson.NewObj().
			Set("name", sched.name).
			Set("description", sched.desc).
			Set("usedBy", used[sched.name]).
			Set("total", total).
			Set("schedule", true).
			Set("defaultPolicy", sched.defaultPolicy).
			Set("active", scheduleActivePolicy(sched, now)).
			Set("builtin", true))
	}
	return pyjson.NewObj().
		Set("policies", policies).
		Set("totals", pyjson.NewObj().
			Set("policies", len(policies)).
			Set("workloads", total)), nil
}

// replicaSchedulePolicyNames are the HPA/downscale schedule builtins surfaced on
// the Replicas page; they are not rightsize policies.
var replicaSchedulePolicyNames = map[string]bool{
	"every-day-nights": true, "weekend": true, "weekend-and-nights": true,
}

var identLabels = map[string]string{
	"labelKeys": "Label keys", "labelKV": "Label key & values",
	"annotationKeys": "Annotation keys", "annotationKV": "Annotation key & values",
	"envKeys": "Environment keys",
}

func (e *Engine) PolicyRulesData() (*pyjson.Obj, error) {
	e.mu.Lock()
	prs := append([]any(nil), e.policyRules...)
	e.mu.Unlock()
	out := []any{}
	for _, prv := range prs {
		pr := obj(prv)
		rules := []any{}
		for _, rv := range getList(pr, "rules") {
			rule := obj(rv)
			idents := []any{}
			for _, iv := range getList(rule, "identifiers") {
				id := obj(iv)
				tv := id.GetD("type", nil)
				var label any = tv
				if s, ok := tv.(string); ok {
					if l, hit := identLabels[s]; hit {
						label = l
					}
				}
				idents = append(idents, pyjson.NewObj().
					Set("type", label).
					Set("key", id.GetD("key", "")).
					Set("value", id.GetD("value", "")))
			}
			rules = append(rules, idents)
		}
		out = append(out, pyjson.NewObj().
			Set("policyName", pr.GetD("policyName", nil)).
			Set("tag", pr.GetD("tag", nil)).
			Set("rules", rules))
	}
	return pyjson.NewObj().Set("rules", out), nil
}

// Custom Workloads page.

func cogSimulateItems(groupBys []any, podItems []any, rsIndex map[string]*ownerRef, nodeLbls map[string]*pyjson.Obj) *pyjson.Obj {
	type agg struct {
		pods                  int
		cpu, mem, gpu, gpuMem float64
		namespaces            map[string]bool
	}
	groups := map[string]*agg{}
	var order []string
	for _, pv := range podItems {
		p := obj(pv)
		gk, ok := cogMatch(groupBys, podIdents(p, rsIndex, nodeLbls))
		if !ok {
			continue
		}
		g, exists := groups[gk]
		if !exists {
			g = &agg{namespaces: map[string]bool{}}
			groups[gk] = g
			order = append(order, gk)
		}
		g.pods++
		for _, cv := range getList(getObj(p, "spec"), "containers") {
			req := getObj(getObj(obj(cv), "resources"), "requests")
			g.cpu += ParseCPU(req.GetD("cpu", nil))
			g.mem += ParseMem(req.GetD("memory", nil))
			g.gpu += gpuReq(req)
		}
		g.namespaces[getStr(getObj(p, "metadata"), "namespace")] = true
	}
	type row struct {
		obj  *pyjson.Obj
		pods int
	}
	var rows []row
	totalPods := 0
	for _, gk := range order {
		g := groups[gk]
		totalPods += g.pods
		rows = append(rows, row{pyjson.NewObj().
			Set("name", gk).
			Set("pods", g.pods).
			Set("cpu", g.cpu).
			Set("mem", g.mem).
			Set("gpu", g.gpu).
			Set("gpuMem", g.gpuMem).
			Set("namespaces", strList(sortedKeys(g.namespaces))), g.pods})
	}
	sort.SliceStable(rows, func(i, j int) bool { return rows[i].pods > rows[j].pods })
	out := []any{}
	for _, r := range rows {
		out = append(out, r.obj)
	}
	return pyjson.NewObj().
		Set("groups", out).
		Set("matchedWorkloads", len(out)).
		Set("matchedPods", totalPods)
}

var standardOwnerKinds = map[string]bool{
	"Deployment": true, "StatefulSet": true, "DaemonSet": true,
	"ReplicaSet": true, "Job": true, "CronJob": true,
}

func (e *Engine) CustomWorkloadsData(ctx context.Context) (*pyjson.Obj, error) {
	pods, err := e.Kube.GetJSON(ctx, "/api/v1/pods")
	if err != nil {
		return nil, err
	}
	rsResp, err := e.Kube.GetJSON(ctx, "/apis/apps/v1/replicasets")
	if err != nil {
		return nil, err
	}
	rsIndex := buildOwnerIndex(rsResp)
	nodes, err := e.Kube.GetJSON(ctx, "/api/v1/nodes")
	if err != nil {
		return nil, err
	}
	nodeLbls := map[string]*pyjson.Obj{}
	nodeBuckets := map[string]string{} // capacity-derived node-size buckets
	for _, nv := range items(nodes) {
		n := obj(nv)
		nn := getStr(getObj(n, "metadata"), "name")
		nodeLbls[nn] = getObj(getObj(n, "metadata"), "labels")
		nodeBuckets[nn] = nodeCapacityBucket(n)
	}
	type unrecAgg struct {
		pods          int
		cpu, mem, gpu float64
	}
	unrec := map[string]*unrecAgg{}
	var unrecOrder []string
	unrecPods := map[string][]any{}
	type dsKey struct{ name, bucket string }
	type dsAgg struct {
		pods     int
		cpu, mem float64
	}
	dsBySize := map[dsKey]*dsAgg{}
	var dsOrder []dsKey
	for _, pv := range items(pods) {
		p := obj(pv)
		_, kind, name := topOwner(p, rsIndex)
		containers := getList(getObj(p, "spec"), "containers")
		var cpu, mem, gpu float64
		for _, cv := range containers {
			req := getObj(getObj(obj(cv), "resources"), "requests")
			cpu += ParseCPU(req.GetD("cpu", nil))
			mem += ParseMem(req.GetD("memory", nil))
			gpu += gpuReq(req)
		}
		var cpuAny, memAny, gpuAny any = cpu, mem, gpu
		if len(containers) == 0 {
			cpuAny, memAny, gpuAny = 0, 0, 0
		}
		if kind == "Pod" || kind == "ReplicaSet" || !standardOwnerKinds[kind] {
			ownerKind := kind
			if kind == "Pod" {
				ownerKind = "Ownerless"
			}
			u, exists := unrec[ownerKind]
			if !exists {
				u = &unrecAgg{}
				unrec[ownerKind] = u
				unrecOrder = append(unrecOrder, ownerKind)
			}
			u.pods++
			u.cpu += cpu
			u.mem += mem
			u.gpu += gpu
			md := getObj(p, "metadata")
			if len(unrecPods[ownerKind]) < 60 {
				images := []any{}
				for _, cv := range containers {
					images = append(images, getStr(obj(cv), "image"))
				}
				var owner any = "—"
				if kind != "Pod" {
					owner = fmt.Sprintf("%s/%s", kind, name)
				}
				unrecPods[ownerKind] = append(unrecPods[ownerKind], pyjson.NewObj().
					Set("name", md.GetD("name", "")).
					Set("namespace", md.GetD("namespace", "")).
					Set("cpu", cpuAny).
					Set("mem", memAny).
					Set("gpu", gpuAny).
					Set("labels", getObj(md, "labels")).
					Set("annotations", getObj(md, "annotations")).
					Set("images", images).
					Set("owner", owner))
			}
		}
		if kind == "DaemonSet" {
			node := getStr(getObj(p, "spec"), "nodeName")
			bucket := "node"
			if node != "" {
				if b, ok := nodeBuckets[node]; ok {
					bucket = b
				}
			}
			k := dsKey{name, bucket}
			g, exists := dsBySize[k]
			if !exists {
				g = &dsAgg{}
				dsBySize[k] = g
				dsOrder = append(dsOrder, k)
			}
			g.pods++
			g.cpu += cpu
			g.mem += mem
		}
	}
	// live match counts for built-in custom owners
	e.mu.Lock()
	cogState := map[string]*pyjson.Obj{}
	for k, v := range e.builtinCogState {
		cogState[k] = v
	}
	userCogEntries := append([]*pyjson.Obj(nil), e.customOwnerGroupings...)
	e.mu.Unlock()
	builtins := []any{}
	for _, bw := range builtinCustomWorkloads {
		cwname, owner, desc := bw[0], bw[1], bw[2]
		match := 0
		if cwname == "DaemonSetNodeSize" {
			match = len(dsBySize)
		}
		cpu, mem := 0.0, 0.0
		if cwname == "DaemonSetNodeSize" {
			for _, v := range dsBySize {
				cpu += v.cpu
				mem += v.mem
			}
		}
		ov := obj(cogState[cwname])
		builtins = append(builtins, pyjson.NewObj().
			Set("name", cwname).
			Set("ownerKind", owner).
			Set("description", desc).
			Set("workloads", match).
			Set("cpu", cpu).
			Set("mem", mem).
			Set("gpu", 0.0).
			Set("gpuMem", 0.0).
			Set("enabled", ov.GetD("enabled", true)).
			Set("defaultPolicy", ov.GetD("defaultPolicy", "Auto detected")).
			Set("defaultAuto", ov.GetD("defaultAuto", false)).
			Set("builtIn", true).
			Set("weight", 0))
	}
	sortedDs := append([]dsKey(nil), dsOrder...)
	sort.SliceStable(sortedDs, func(i, j int) bool {
		if sortedDs[i].name != sortedDs[j].name {
			return sortedDs[i].name < sortedDs[j].name
		}
		return sortedDs[i].bucket < sortedDs[j].bucket
	})
	dsGroups := []any{}
	for _, k := range sortedDs {
		v := dsBySize[k]
		dsGroups = append(dsGroups, pyjson.NewObj().
			Set("daemonset", k.name).
			Set("nodeSize", k.bucket).
			Set("pods", v.pods).
			Set("cpu", v.cpu).
			Set("mem", v.mem))
	}
	sortedUnrec := append([]string(nil), unrecOrder...)
	sort.SliceStable(sortedUnrec, func(i, j int) bool {
		return unrec[sortedUnrec[i]].pods > unrec[sortedUnrec[j]].pods
	})
	unrecList := []any{}
	unrecPodsTotal := 0
	for _, k := range sortedUnrec {
		u := unrec[k]
		unrecPodsTotal += u.pods
		unrecList = append(unrecList, pyjson.NewObj().
			Set("ownerKind", k).
			Set("pods", u.pods).
			Set("cpu", u.cpu).
			Set("mem", u.mem).
			Set("gpu", u.gpu))
	}
	unrecPodsObj := pyjson.NewObj()
	for _, k := range unrecOrder {
		lst := unrecPods[k]
		if lst == nil {
			lst = []any{}
		}
		unrecPodsObj.Set(k, lst)
	}
	// user-defined Custom Owner Groupings, with live match counts simulated now.
	userCogs := []any{}
	podItems := items(pods)
	for _, cog := range userCogEntries {
		sim := cogSimulateItems(getList(cog, "groupBys"), podItems, rsIndex, nodeLbls)
		groups := getList(sim, "groups")
		sumOf := func(field string) any {
			if len(groups) == 0 {
				return 0
			}
			s := 0.0
			for _, gv := range groups {
				s += f64d(obj(gv).GetD(field, nil), 0)
			}
			return s
		}
		userCogs = append(userCogs, pyjson.NewObj().
			Set("name", cog.GetD("name", nil)).
			Set("ownerKind", "Custom").
			Set("groupBys", cog.GetD("groupBys", nil)).
			Set("defaultPolicy", cog.GetD("defaultPolicy", "Auto detected")).
			Set("defaultAuto", cog.GetD("defaultAuto", false)).
			Set("weight", cog.GetD("weight", 0)).
			Set("enabled", cog.GetD("enabled", true)).
			Set("builtIn", false).
			Set("cpu", sumOf("cpu")).
			Set("mem", sumOf("mem")).
			Set("gpu", sumOf("gpu")).
			Set("gpuMem", 0.0).
			Set("workloads", sim.GetD("matchedWorkloads", nil)).
			Set("pods", sim.GetD("matchedPods", nil)).
			Set("groups", groups))
	}
	// unified list (user first — they take precedence over built-ins), reference-style.
	unified := []any{}
	unified = append(unified, userCogs...)
	unified = append(unified, builtins...)
	return pyjson.NewObj().
		Set("builtins", builtins).
		Set("unrecognized", unrecList).
		Set("unrecognizedPods", unrecPodsObj).
		Set("daemonsetBySize", dsGroups).
		Set("userCogs", userCogs).
		Set("customWorkloads", unified).
		Set("totals", pyjson.NewObj().
			Set("builtins", len(builtins)).
			Set("unrecognizedPods", unrecPodsTotal).
			Set("daemonsetGroups", len(dsGroups)).
			Set("userCogs", len(userCogs))), nil
}

// Custom Workloads over-time.

// aggPoint is one _prom_agg output point ({"t": ms, "v": value}).
type aggPoint struct {
	t int64
	v float64
}

func (e *Engine) promAggRange(ctx context.Context, promql string, start, end, step int64, agg string) []aggPoint {
	if e.Prom == nil {
		return nil
	}
	series, err := e.Prom.QueryRange(ctx, promql,
		time.Unix(start, 0), time.Unix(end, 0), time.Duration(step)*time.Second)
	if err != nil {
		return nil
	}
	bucket := map[int64][]float64{}
	for _, s := range series {
		for _, p := range s.Points {
			t := p.Timestamp.Unix()
			bucket[t] = append(bucket[t], p.Value)
		}
	}
	var keys []int64
	for t := range bucket {
		keys = append(keys, t)
	}
	sort.Slice(keys, func(i, j int) bool { return keys[i] < keys[j] })
	out := make([]aggPoint, 0, len(keys))
	for _, t := range keys {
		v := bucket[t]
		var val float64
		switch agg {
		case "avg":
			sum := 0.0
			for _, x := range v {
				sum += x
			}
			val = sum / float64(len(v))
		case "max":
			val = v[0]
			for _, x := range v {
				if x > val {
					val = x
				}
			}
		default:
			for _, x := range v {
				val += x
			}
		}
		out = append(out, aggPoint{t: t * 1000, v: val})
	}
	return out
}

var podNameSanitizeRe = regexp.MustCompile(`[^A-Za-z0-9_.-]`)

func (e *Engine) CustomOvertimeData(ctx context.Context, rng string) (*pyjson.Obj, error) {
	secs, ok := rangeSeconds[rng]
	if !ok {
		secs = 604800
	}
	end := time.Now().Unix()
	start := end - secs
	var step int64 = 86400
	if rng == "7d" {
		step = 3600
	}
	// unrecognized pod names = Ownerless or non-standard top-owner kind,
	// grouped BY OWNER KIND so the chart tooltip can show a per-type breakdown.
	var unrecPodNames []string
	unrecByKind := map[string][]string{}
	var kindOrder []string
	if rsResp, err := e.Kube.GetJSON(ctx, "/apis/apps/v1/replicasets"); err == nil {
		if pods, perr := e.Kube.GetJSON(ctx, "/api/v1/pods"); perr == nil {
			rsIndex := buildOwnerIndex(rsResp)
			for _, pv := range items(pods) {
				p := obj(pv)
				_, okind, _ := topOwner(p, rsIndex)
				if okind == "Pod" || okind == "ReplicaSet" || !standardOwnerKinds[okind] {
					name := getStr(getObj(p, "metadata"), "name")
					unrecPodNames = append(unrecPodNames, name)
					k := okind
					if okind == "Pod" {
						k = "Ownerless"
					}
					if _, exists := unrecByKind[k]; !exists {
						kindOrder = append(kindOrder, k)
					}
					unrecByKind[k] = append(unrecByKind[k], name)
				}
			}
		}
	}
	joinSanitized := func(names []string, cap int) string {
		if len(names) > cap {
			names = names[:cap]
		}
		out := ""
		for i, x := range names {
			if i > 0 {
				out += "|"
			}
			out += podNameSanitizeRe.ReplaceAllString(x, "")
		}
		return out
	}
	unrecRe := joinSanitized(unrecPodNames, 300)
	podf := ""
	if unrecRe != "" {
		podf = fmt.Sprintf(`,pod=~"%s"`, unrecRe)
	}
	ksm := func(res, filt string) []aggPoint {
		return e.promAggRange(ctx,
			fmt.Sprintf(`sum(kube_pod_container_resource_requests{resource="%s"%s})`, res, filt),
			start, end, step, "avg")
	}
	cpuT, memT, gpuT := ksm("cpu", ""), ksm("memory", ""), ksm("nvidia_com_gpu", "")
	var cpuU, memU, gpuU []aggPoint
	if podf != "" {
		cpuU, memU, gpuU = ksm("cpu", podf), ksm("memory", podf), ksm("nvidia_com_gpu", podf)
	}
	// Per-owner-kind unrecognized-request series — capped at the 6 largest kinds
	// to bound the query count. Powers "Hover for breakdown".
	sortedKinds := append([]string(nil), kindOrder...)
	sort.SliceStable(sortedKinds, func(i, j int) bool {
		return len(unrecByKind[sortedKinds[i]]) > len(unrecByKind[sortedKinds[j]])
	})
	if len(sortedKinds) > 6 {
		sortedKinds = sortedKinds[:6]
	}
	type kindSeries struct {
		cpu, mem, gpu []aggPoint
	}
	kindMaps := map[string]*kindSeries{}
	var kindSeriesOrder []string
	for _, k := range sortedKinds {
		re := joinSanitized(unrecByKind[k], 200)
		if re == "" {
			continue
		}
		f := fmt.Sprintf(`,pod=~"%s"`, re)
		kindMaps[k] = &kindSeries{cpu: ksm("cpu", f), mem: ksm("memory", f), gpu: ksm("nvidia_com_gpu", f)}
		kindSeriesOrder = append(kindSeriesOrder, k)
	}
	cuse := e.promAggRange(ctx,
		`sum(rate(container_cpu_usage_seconds_total{container!="",container!="POD"}[5m]))`,
		start, end, step, "avg")
	muse := e.promAggRange(ctx,
		`sum(container_memory_working_set_bytes{container!="",container!="POD"})`,
		start, end, step, "avg")
	m := func(s []aggPoint) map[int64]float64 {
		out := map[int64]float64{}
		for _, p := range s {
			out[p.t] = p.v
		}
		return out
	}
	cpuTm, cpuUm, cum := m(cpuT), m(cpuU), m(cuse)
	memTm, memUm, mum := m(memT), m(memU), m(muse)
	gpuTm, gpuUm := m(gpuT), m(gpuU)
	type kindMapSet struct{ cpu, mem, gpu map[int64]float64 }
	kindPtMaps := map[string]*kindMapSet{}
	for _, k := range kindSeriesOrder {
		km := kindMaps[k]
		kindPtMaps[k] = &kindMapSet{cpu: m(km.cpu), mem: m(km.mem), gpu: m(km.gpu)}
	}
	tset := map[int64]bool{}
	for t := range cpuTm {
		tset[t] = true
	}
	for t := range memTm {
		tset[t] = true
	}
	for t := range gpuTm {
		tset[t] = true
	}
	var ts []int64
	for t := range tset {
		ts = append(ts, t)
	}
	sort.Slice(ts, func(i, j int) bool { return ts[i] < ts[j] })
	out := []any{}
	for _, t := range ts {
		ct, mt := cpuTm[t], memTm[t]
		breakdown := pyjson.NewObj()
		for _, k := range kindSeriesOrder {
			km := kindPtMaps[k]
			breakdown.Set(k, pyjson.NewObj().
				Set("cpu", km.cpu[t]).
				Set("mem", km.mem[t]).
				Set("gpu", km.gpu[t]))
		}
		out = append(out, pyjson.NewObj().
			Set("timestamp", t).
			Set("values", pyjson.NewObj().
				Set("cpuUnrecognized", cpuUm[t]).
				Set("cpuTotal", ct).
				Set("cpuWaste", math.Max(0.0, pyjson.Round(ct-cum[t], 4))).
				Set("memUnrecognized", memUm[t]).
				Set("memTotal", mt).
				Set("memWaste", math.Max(0.0, pyjson.Round(mt-mum[t], 1))).
				Set("gpuUnrecognized", gpuUm[t]).
				Set("gpuTotal", gpuTm[t]).
				Set("gpuWaste", 0.0)).
			Set("breakdown", breakdown))
	}
	return pyjson.NewObj().Set("range", rng).Set("values", out), nil
}

// Replicas Optimization.

// replGraphWL carries the per-workload numbers the Replicas over-time graphs
// need (collected while building the table rows).
type replGraphWL struct {
	namespace, name, hpaName         string
	origMin, curMin                  float64
	recMin                           int
	reqCpu, reqMem, origCpu, origMem float64
}

func (e *Engine) ReplicasData(ctx context.Context, rng string) (*pyjson.Obj, error) {
	e.mu.Lock()
	var rows []*wlRow
	for _, w := range e.workloads {
		if w.hpaManaged {
			rows = append(rows, w)
		}
	}
	replAuto := map[string]bool{}
	for k := range e.replicasAutomated {
		replAuto[k] = true
	}
	e.mu.Unlock()
	type outRow struct {
		obj  *pyjson.Obj
		save float64
	}
	var out []outRow
	var graphWLs []*replGraphWL
	totCost, totSavings := 0.0, 0.0
	unoptMin, unoptThr, predictableN, automatedN := 0, 0, 0, 0
	origCpu, curCpu, origMem, curMem := 0.0, 0.0, 0.0, 0.0
	for _, w := range rows {
		key := w.key
		polName, pol := e.replicasPolicyFor(key)
		recMin, recThr, predictable, trend := e.replicaRecommendation(w, pol)
		origMinRaw := w.obj.GetD("hpaMin", nil)
		var origMinAny any = origMinRaw
		if !truthy(origMinRaw) {
			origMinAny = 1
		}
		origMin := f64d(origMinAny, 1)
		curThr := w.obj.GetD("cpuTarget", nil)
		reps := f64d(w.obj.GetD("replicas", 1), 1)
		if reps < 1 {
			reps = 1
		}
		monthlyCost := f64d(w.obj.GetD("monthlyCost", nil), 0)
		perReplica := monthlyCost / reps
		save := math.Max(0, origMin-float64(recMin)) * perReplica
		// cluster CPU/Memory request footprint at original vs optimized minReplicas
		reqCpu := f64d(w.obj.GetD("reqCpu", 0), 0)
		reqMem := f64d(w.obj.GetD("reqMem", 0), 0)
		origCpu += reqCpu * origMin
		curCpu += reqCpu * float64(recMin)
		origMem += reqMem * origMin
		curMem += reqMem * float64(recMin)
		if float64(recMin) < origMin {
			unoptMin++
		}
		if truthy(curThr) && truthy(recThr) {
			ct, _ := toFloatLoose(curThr)
			rt, _ := toFloatLoose(recThr)
			if rt > ct {
				unoptThr++
			}
		}
		if predictable {
			predictableN++
		}
		automated := replAuto[key]
		if automated {
			automatedN++
		}
		totCost += monthlyCost
		totSavings += save
		var kedaName = w.obj.GetD("kedaName", nil)
		triggerType := "HPA"
		if truthy(kedaName) {
			triggerType = "KEDA"
		}
		// collect the graph inputs (over-time series below)
		hpaName := str(w.obj.GetD("hpaName", ""))
		if hpaName == "" && truthy(kedaName) {
			hpaName = "keda-hpa-" + str(kedaName) // KEDA's managed-HPA naming
		}
		curMin := f64d(w.obj.GetD("hpaMin", 1), 1)
		if curMin < 1 {
			curMin = 1
		}
		graphWLs = append(graphWLs, &replGraphWL{
			namespace: w.namespace, name: w.name, hpaName: hpaName,
			origMin: origMin, curMin: curMin, recMin: recMin,
			reqCpu: reqCpu, reqMem: reqMem,
			origCpu: f64d(w.obj.GetD("origCpu", reqCpu), reqCpu),
			origMem: f64d(w.obj.GetD("origMem", reqMem), reqMem)})
		out = append(out, outRow{pyjson.NewObj().
			Set("key", key).
			Set("namespace", w.namespace).
			Set("name", w.name).
			Set("kind", w.kind).
			Set("replicas", w.obj.GetD("replicas", nil)).
			Set("maxReplicas", w.obj.GetD("hpaMax", nil)).
			Set("origMin", origMinAny).
			Set("recMin", recMin).
			Set("curThreshold", curThr).
			Set("recThreshold", recThr).
			Set("predictable", predictable).
			Set("savings", save).
			Set("policyName", polName).
			Set("automated", automated).
			Set("trend", trend).
			Set("monthlyCost", w.obj.GetD("monthlyCost", nil)).
			Set("hpaName", w.obj.GetD("hpaName", nil)).
			Set("kedaName", kedaName).
			Set("triggerType", triggerType).
			Set("metrics", w.obj.GetD("hpaMetrics", []any{})), save})
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].save > out[j].save })
	workloads := []any{}
	for _, r := range out {
		workloads = append(workloads, r.obj)
	}
	wastedPct := 0.0
	if totCost != 0 {
		wastedPct = totSavings / totCost * 100.0
	}
	replicasOT, cpuOT, memOT := e.replicasGraphs(ctx, graphWLs, rng)
	return pyjson.NewObj().
		Set("workloads", workloads).
		Set("range", rng).
		Set("replicasOverTime", replicasOT).
		Set("cpuOverTime", cpuOT).
		Set("memOverTime", memOT).
		Set("totals", pyjson.NewObj().
			Set("monthlyCost", totCost).
			Set("savings", totSavings).
			Set("wastedPct", wastedPct).
			Set("origCpu", origCpu).
			Set("curCpu", curCpu).
			Set("origMem", origMem).
			Set("curMem", curMem).
			Set("unoptimizedMinReplicas", unoptMin).
			Set("unoptimizedThresholds", unoptThr).
			Set("predictable", predictableN).
			Set("automated", automatedN).
			Set("total", len(rows))), nil
}

// cpuOverTime / memOverTime: Request (measured KSM, scoped), Optimized /
// Original request (per-replica requests x optimized/original replicas),
// Waste, plus cluster Total request and Allocatable context lines. All
// series are empty when Prometheus is unavailable — never fabricated.
func (e *Engine) replicasGraphs(ctx context.Context, wls []*replGraphWL, rng string) (*pyjson.Obj, *pyjson.Obj, *pyjson.Obj) {
	emptyRepl := func() *pyjson.Obj {
		return pyjson.NewObj().
			Set("ts", []any{}).Set("optimized", []any{}).Set("current", []any{}).
			Set("original", []any{}).Set("waste", []any{})
	}
	emptyRes := func() *pyjson.Obj {
		return pyjson.NewObj().
			Set("ts", []any{}).Set("optimized", []any{}).Set("request", []any{}).
			Set("waste", []any{}).Set("totalRequest", []any{}).
			Set("originalRequest", []any{}).Set("allocatable", []any{})
	}
	if e.Prom == nil || len(wls) == 0 {
		return emptyRepl(), emptyRes(), emptyRes()
	}
	secs, ok := rangeSeconds[rng]
	if !ok {
		secs = 604800
	}
	end := time.Now().Unix()
	start := end - secs
	step := int64(3600)
	if secs > 604800 {
		step = 14400
	} else if secs <= 21600 {
		step = 300
	}
	san := func(s string) string { return podNameSanitizeRe.ReplaceAllString(s, "") }

	// ---- per-workload replica history (KSM HPA status; Deployment fallback) ----
	perWL := map[*replGraphWL]map[int64]float64{}
	tsSet := map[int64]bool{}
	byHpaKey := map[string]*replGraphWL{}
	var hpaNames []string
	for _, w := range wls {
		if w.hpaName != "" {
			byHpaKey[w.namespace+"/"+w.hpaName] = w
			hpaNames = append(hpaNames, san(w.hpaName))
		}
	}
	if len(hpaNames) > 0 {
		q := fmt.Sprintf(`max by(namespace,horizontalpodautoscaler)`+
			`(kube_horizontalpodautoscaler_status_current_replicas{horizontalpodautoscaler=~"%s"})`,
			strings.Join(hpaNames, "|"))
		for _, s := range e.promRange(ctx, q, start, end, step) {
			w := byHpaKey[s.Metric["namespace"]+"/"+s.Metric["horizontalpodautoscaler"]]
			if w == nil {
				continue
			}
			m := map[int64]float64{}
			for _, p := range s.Points {
				m[p.Timestamp.Unix()] = p.Value
				tsSet[p.Timestamp.Unix()] = true
			}
			perWL[w] = m
		}
	}
	// Deployment-metric fallback for workloads the HPA family missed.
	byDepKey := map[string]*replGraphWL{}
	var depNames []string
	for _, w := range wls {
		if perWL[w] == nil {
			byDepKey[w.namespace+"/"+w.name] = w
			depNames = append(depNames, san(w.name))
		}
	}
	if len(depNames) > 0 {
		q := fmt.Sprintf(`max by(namespace,deployment)`+
			`(kube_deployment_status_replicas{deployment=~"%s"})`, strings.Join(depNames, "|"))
		for _, s := range e.promRange(ctx, q, start, end, step) {
			w := byDepKey[s.Metric["namespace"]+"/"+s.Metric["deployment"]]
			if w == nil {
				continue
			}
			m := map[int64]float64{}
			for _, p := range s.Points {
				m[p.Timestamp.Unix()] = p.Value
				tsSet[p.Timestamp.Unix()] = true
			}
			perWL[w] = m
		}
	}

	// measured request/total/allocatable series
	var podNames []string
	for _, w := range wls {
		podNames = append(podNames, san(w.name))
	}
	podf := fmt.Sprintf(`,pod=~"(%s)-.*"`, strings.Join(podNames, "|"))
	reqCpuM := e.promSeriesAt(ctx, fmt.Sprintf(
		`sum(kube_pod_container_resource_requests{resource="cpu",container!=""%s})`, podf),
		start, end, step)
	reqMemM := e.promSeriesAt(ctx, fmt.Sprintf(
		`sum(kube_pod_container_resource_requests{resource="memory",container!=""%s})`, podf),
		start, end, step)
	totCpuM := e.promSeriesAt(ctx,
		`sum(kube_pod_container_resource_requests{resource="cpu",container!=""})`, start, end, step)
	totMemM := e.promSeriesAt(ctx,
		`sum(kube_pod_container_resource_requests{resource="memory",container!=""})`, start, end, step)
	allocCpuM := e.promSeriesAt(ctx,
		`sum(kube_node_status_allocatable{resource="cpu"})`, start, end, step)
	allocMemM := e.promSeriesAt(ctx,
		`sum(kube_node_status_allocatable{resource="memory"})`, start, end, step)
	for t := range reqCpuM {
		tsSet[t] = true
	}
	var ts []int64
	for t := range tsSet {
		ts = append(ts, t)
	}
	sort.Slice(ts, func(i, j int) bool { return ts[i] < ts[j] })

	tsOut := []any{}
	rOpt, rCur, rOrig, rWaste := []any{}, []any{}, []any{}, []any{}
	cOpt, cReq, cWaste, cTot, cOrig, cAlloc := []any{}, []any{}, []any{}, []any{}, []any{}, []any{}
	mOpt, mReq, mWaste, mTot, mOrig, mAlloc := []any{}, []any{}, []any{}, []any{}, []any{}, []any{}
	for _, t := range ts {
		var cur, opt, orig float64
		var cpuOpt, cpuOrig, cpuCurDerived float64
		var memOpt, memOrig, memCurDerived float64
		seen := false
		for _, w := range wls {
			m := perWL[w]
			if m == nil {
				continue
			}
			v, ok := m[t]
			if !ok {
				continue
			}
			seen = true
			cur += v
			o := v
			if v <= w.curMin { // pinned at the HPA min — our recMin applies
				o = float64(w.recMin)
			}
			opt += o
			og := v
			if og < w.origMin { // original minReplicas would have floored higher
				og = w.origMin
			}
			orig += og
			cpuOpt += w.reqCpu * o
			memOpt += w.reqMem * o
			cpuOrig += w.origCpu * og
			memOrig += w.origMem * og
			cpuCurDerived += w.reqCpu * v
			memCurDerived += w.reqMem * v
		}
		tsOut = append(tsOut, t*1000)
		if seen {
			rCur = append(rCur, cur)
			rOpt = append(rOpt, opt)
			rOrig = append(rOrig, orig)
			rWaste = append(rWaste, math.Max(0.0, cur-opt))
		} else {
			rCur = append(rCur, nil)
			rOpt = append(rOpt, nil)
			rOrig = append(rOrig, nil)
			rWaste = append(rWaste, nil)
		}
		// measured request wins; replica-derived request is the fallback
		reqC, okC := reqCpuM[t]
		if !okC && seen {
			reqC, okC = cpuCurDerived, true
		}
		reqM, okM := reqMemM[t]
		if !okM && seen {
			reqM, okM = memCurDerived, true
		}
		appendF := func(lst []any, v float64, ok bool) []any {
			if !ok {
				return append(lst, nil)
			}
			return append(lst, v)
		}
		cReq = appendF(cReq, reqC, okC)
		mReq = appendF(mReq, reqM, okM)
		if seen {
			cOpt = append(cOpt, cpuOpt)
			mOpt = append(mOpt, memOpt)
			cOrig = append(cOrig, cpuOrig)
			mOrig = append(mOrig, memOrig)
			if okC {
				cWaste = append(cWaste, math.Max(0.0, reqC-cpuOpt))
			} else {
				cWaste = append(cWaste, nil)
			}
			if okM {
				mWaste = append(mWaste, math.Max(0.0, reqM-memOpt))
			} else {
				mWaste = append(mWaste, nil)
			}
		} else {
			cOpt = append(cOpt, nil)
			mOpt = append(mOpt, nil)
			cOrig = append(cOrig, nil)
			mOrig = append(mOrig, nil)
			cWaste = append(cWaste, nil)
			mWaste = append(mWaste, nil)
		}
		v, ok := totCpuM[t]
		cTot = appendF(cTot, v, ok)
		v, ok = totMemM[t]
		mTot = appendF(mTot, v, ok)
		v, ok = allocCpuM[t]
		cAlloc = appendF(cAlloc, v, ok)
		v, ok = allocMemM[t]
		mAlloc = appendF(mAlloc, v, ok)
	}
	replOT := pyjson.NewObj().
		Set("ts", tsOut).Set("optimized", rOpt).Set("current", rCur).
		Set("original", rOrig).Set("waste", rWaste)
	cpuOT := pyjson.NewObj().
		Set("ts", tsOut).Set("optimized", cOpt).Set("request", cReq).
		Set("waste", cWaste).Set("totalRequest", cTot).
		Set("originalRequest", cOrig).Set("allocatable", cAlloc)
	memOT := pyjson.NewObj().
		Set("ts", tsOut).Set("optimized", mOpt).Set("request", mReq).
		Set("waste", mWaste).Set("totalRequest", mTot).
		Set("originalRequest", mOrig).Set("allocatable", mAlloc)
	return replOT, cpuOT, memOT
}

func (e *Engine) ReplicasPoliciesData() (*pyjson.Obj, error) {
	e.mu.Lock()
	total := 0
	used := map[string]int{}
	for _, w := range e.workloads {
		if !w.hpaManaged {
			continue
		}
		total++
		name, ok := e.replicasPolicyAssign[w.key]
		if !ok {
			name = "production"
		}
		used[name]++
	}
	var customNames []string
	for n := range e.hpaPolicyOverrides {
		if !hpaBuiltinNames[n] {
			customNames = append(customNames, n)
		}
	}
	var schedNames []string
	scheds := map[string]*pyjson.Obj{}
	for n, s := range e.hpaSched {
		schedNames = append(schedNames, n)
		scheds[n] = s
	}
	e.mu.Unlock()
	sortStrings(customNames)
	sortStrings(schedNames)
	cat := e.hpaAllKnobs()
	descMap := e.hpaAllDesc()
	var names []string
	for _, d := range replicasPolicies {
		names = append(names, d.name)
	}
	names = append(names, customNames...)
	type polRow struct {
		obj     *pyjson.Obj
		builtin bool
		usedBy  int
		name    string
	}
	var out []polRow
	for _, name := range names {
		kb := cat[name]
		if kb == nil {
			continue
		}
		// min-replicas strategy label
		var stratLbl string
		if truthy(kb.GetD("keepMin", nil)) {
			stratLbl = "keep original min"
		} else if truthy(kb.GetD("setMin", nil)) {
			stratLbl = fmt.Sprintf("set min = %s", pyStr(kb.GetD("setMin", nil)))
		} else {
			p1 := "static: keep"
			if truthy(kb.GetD("genEnabled", nil)) {
				p1 = fmt.Sprintf("static p%d/%s", i64(kb.GetD("genPct", nil)), pyStr(kb.GetD("genWindow", nil)))
			}
			p2 := "predictable: keep"
			if truthy(kb.GetD("predEnabled", nil)) {
				p2 = fmt.Sprintf("predictable p%d/%s", i64(kb.GetD("predPct", nil)), pyStr(kb.GetD("predWindow", nil)))
			}
			stratLbl = p1 + " · " + p2
		}
		out = append(out, polRow{pyjson.NewObj().
			Set("name", name).
			Set("description", descMap[name]).
			Set("usedBy", used[name]).
			Set("total", total).
			Set("builtin", hpaBuiltinNames[name]).
			Set("minStrategy", stratLbl).
			Set("predictablePct", kb.GetD("predPct", nil)).
			Set("staticPct", kb.GetD("genPct", nil)).
			Set("prediction", kb.GetD("predictionEnabled", nil)).
			Set("lookAhead", kb.GetD("lookAhead", nil)).
			Set("coverage", kb.GetD("coverage", nil)).
			Set("minAllowed", kb.GetD("minAllowed", nil)).
			Set("threshold", kb.GetD("thresholdEnabled", nil)).
			Set("maxBoundary", kb.GetD("maxDeviation", nil)),
			hpaBuiltinNames[name], used[name], name})
	}
	// Policy Schedules (meta-policies that switch HPA policy by UTC time)
	for _, name := range schedNames {
		sched := scheds[name]
		active := hpaSchedActive(sched, time.Now())
		desc, ok := descMap[name]
		if !ok {
			desc = "Policy schedule."
		}
		out = append(out, polRow{pyjson.NewObj().
			Set("name", name).
			Set("description", desc).
			Set("usedBy", used[name]).
			Set("total", total).
			Set("builtin", false).
			Set("schedule", true).
			Set("minStrategy", fmt.Sprintf("schedule → default: %s · now: %s",
				pyStr(sched.GetD("defaultPolicy", "production")), active)).
			Set("predictablePct", "—").
			Set("staticPct", "—").
			Set("prediction", false).
			Set("lookAhead", "").
			Set("coverage", "").
			Set("minAllowed", "").
			Set("threshold", false).
			Set("maxBoundary", 0),
			false, used[name], name})
	}
	sort.SliceStable(out, func(i, j int) bool {
		// key: (not builtin, -usedBy, name)
		bi, bj := 0, 0
		if !out[i].builtin {
			bi = 1
		}
		if !out[j].builtin {
			bj = 1
		}
		if bi != bj {
			return bi < bj
		}
		if out[i].usedBy != out[j].usedBy {
			return out[i].usedBy > out[j].usedBy
		}
		return out[i].name < out[j].name
	})
	policies := []any{}
	for _, r := range out {
		policies = append(policies, r.obj)
	}
	return pyjson.NewObj().
		Set("policies", policies).
		Set("totals", pyjson.NewObj().
			Set("policies", len(policies)).
			Set("workloads", total)), nil
}

// Downscaler page.

var downscaleSchedulePairs = [][2]string{
	{"nights", "nights"},
	{"nights-and-weekends", "nights_weekends"},
	{"weekends", "weekends"},
}

// true = scale-down window.
func scheduleGridKind(kind string) [7][24]bool {
	var grid [7][24]bool
	for d := 0; d < 7; d++ {
		for h := 0; h < 24; h++ {
			night := h >= 20 || h < 8
			weekend := d >= 5
			switch kind {
			case "nights":
				grid[d][h] = night
			case "weekends":
				grid[d][h] = weekend
			default:
				grid[d][h] = night || weekend
			}
		}
	}
	return grid
}

func gridHoursCount(grid [7][24]bool) int {
	n := 0
	for _, row := range grid {
		for _, c := range row {
			if c {
				n++
			}
		}
	}
	return n
}

// gridJSONRows renders a 7×24 grid as nested JSON lists of bools.
func gridJSONRows(grid [7][24]bool) []any {
	out := []any{}
	for _, row := range grid {
		r := []any{}
		for _, c := range row {
			r = append(r, c)
		}
		out = append(out, r)
	}
	return out
}

func pagesGridFromSchedule(schedule []any) [7][24]bool {
	var grid [7][24]bool
	for _, ev := range schedule {
		entry := obj(ev)
		wc := getObj(entry, "weeklyConfig")
		if !entry.Has("weeklyConfig") {
			wc = entry
		}
		days := getList(wc, "days")
		if !wc.Has("days") {
			days = []any{int64(0), int64(1), int64(2), int64(3), int64(4), int64(5), int64(6)}
		}
		bt := pyStr(wc.GetD("beginTime", "00:00"))
		et := pyStr(wc.GetD("endTime", "23:59"))
		bh, ok1 := parseHourStrict(bt)
		eh, ok2 := parseHourStrict(et)
		if !ok1 || !ok2 {
			bh, eh = 0, 23
		}
		for _, dv := range days {
			d := ((int(i64(dv))+6)%7 + 7) % 7 // Sun=0..Sat=6 -> Mon=0..Sun=6
			for h := 0; h < 24; h++ {
				var on bool
				if eh > bh {
					on = bh <= h && h < eh
				} else {
					on = h >= bh || h < eh
				}
				if on {
					grid[d][h] = true
				}
			}
		}
	}
	return grid
}

// parseHourStrict is int(str(t).split(":")[0]).
func parseHourStrict(s string) (int, bool) {
	for i := 0; i < len(s); i++ {
		if s[i] == ':' {
			s = s[:i]
			break
		}
	}
	return parseIntPy(s)
}

func periodsForEditor(schedule []any) []any {
	out := []any{}
	for _, ev := range schedule {
		entry := obj(ev)
		wc := getObj(entry, "weeklyConfig")
		if !entry.Has("weeklyConfig") {
			wc = entry
		}
		daysRaw := getList(wc, "days")
		if !wc.Has("days") {
			daysRaw = []any{int64(0), int64(1), int64(2), int64(3), int64(4), int64(5), int64(6)}
		}
		days := make([]int, 0, len(daysRaw))
		for _, dv := range daysRaw {
			days = append(days, int(i64(dv)))
		}
		sort.Ints(days)
		preset := "all"
		switch {
		case intsEqual(days, []int{0, 1, 2, 3, 4, 5, 6}):
			preset = "all"
		case intsEqual(days, []int{1, 2, 3, 4, 5}):
			preset = "weekdays"
		case intsEqual(days, []int{0, 6}):
			preset = "weekends"
		case len(days) == 1:
			preset = strconv.Itoa(days[0])
		}
		out = append(out, pyjson.NewObj().
			Set("days", preset).
			Set("beginTime", wc.GetD("beginTime", "00:00")).
			Set("endTime", wc.GetD("endTime", "23:59")))
	}
	return out
}

func intsEqual(a, b []int) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func (e *Engine) loadDownscalerPolicyList(ctx context.Context) []*pyjson.Obj {
	resp, err := e.Kube.GetJSON(ctx, crdBase("downscalerpolicies", e.Cfg.Namespace))
	if err != nil {
		return nil
	}
	out := []*pyjson.Obj{}
	for _, it := range items(resp) {
		o := obj(it)
		s := getObj(o, "spec")
		out = append(out, pyjson.NewObj().
			Set("name", getObj(o, "metadata").GetD("name", nil)).
			Set("replicas", s.GetD("replicas", 1)).
			Set("minReplicas", s.GetD("minReplicas", 1)).
			Set("schedule", s.GetD("schedule", []any{})).
			Set("includedWorkloads", s.GetD("includedWorkloads", []any{})).
			Set("hpaEnabled", s.GetD("hpaEnabled", true)).
			Set("sleep", s.GetD("sleep", false)))
	}
	return out
}

// dsMeta is one sched_meta entry ({grid, hpaMin, target, sleep}).
type dsMeta struct {
	grid   [7][24]bool
	hpaMin any
	target any
	sleep  any
}

func dsMetaFromPolicy(p *pyjson.Obj) *dsMeta {
	grid := scheduleGridKind("nights")
	if truthy(p.GetD("schedule", nil)) {
		grid = pagesGridFromSchedule(getList(p, "schedule"))
	}
	return &dsMeta{grid: grid,
		hpaMin: p.GetD("minReplicas", 1),
		target: p.GetD("replicas", 1),
		sleep:  p.GetD("sleep", false)}
}

func (e *Engine) DownscaleData(ctx context.Context) (*pyjson.Obj, error) {
	t := time.Now().UTC()
	curDay := (int(t.Weekday()) + 6) % 7
	curHour := t.Hour()
	e.mu.Lock()
	workloads := append([]*wlRow(nil), e.workloads...)
	overview := obj(e.overview).Clone()
	assign := map[string]string{}
	for k, v := range e.downscaleAssign {
		assign[k] = v
	}
	automated := map[string]bool{}
	for k := range e.downscaleAutomated {
		automated[k] = true
	}
	e.mu.Unlock()
	// namespace-level downscale automation (AutomatedNamespace.downscalerOptimize)
	dsAutoNs := map[string]bool{}
	for ns, v := range e.loadAutomatedNamespaces(ctx) {
		if v.downscaler {
			dsAutoNs[ns] = true
		}
	}
	// ---- assemble schedule policies (built-in + user DownscalerPolicy CRs) ----
	// The seeded builtin DownscalerPolicy CRs share the builtin names
	// (nights/weekends/nights-and-weekends); dedupe by name — the CR wins.
	crPolicies := e.loadDownscalerPolicyList(ctx)
	crByName := map[string]*pyjson.Obj{}
	for _, p := range crPolicies {
		crByName[str(p.GetD("name", nil))] = p
	}
	schedMeta := map[string]*dsMeta{}
	for _, pair := range downscaleSchedulePairs {
		schedMeta[pair[0]] = &dsMeta{grid: scheduleGridKind(pair[1]), hpaMin: 1, target: 1, sleep: false}
	}
	for _, p := range crPolicies {
		schedMeta[str(p.GetD("name", nil))] = dsMetaFromPolicy(p)
	}
	// default-assign unassigned workloads to "nights"
	schedOf := func(key string) string {
		n, ok := assign[key]
		if !ok {
			n = "nights"
		}
		if _, hit := schedMeta[n]; hit {
			return n
		}
		return "nights"
	}
	attachedCount := map[string]int{}
	for _, w := range workloads {
		attachedCount[schedOf(w.key)]++
	}
	// per-workload rows + savings
	rows := []any{}
	totCost, totSavingsUnauto := 0.0, 0.0
	activeScaled := 0
	cpuSaved, memSaved, gpuSaved := 0.0, 0.0, 0.0
	for _, w := range workloads {
		sname := schedOf(w.key)
		meta := schedMeta[sname]
		grid := meta.grid
		downFrac := float64(gridHoursCount(grid)) / 168.0
		reps := f64d(w.obj.GetD("replicas", 1), 1)
		if reps < 1 {
			reps = 1
		}
		target := meta.target
		if truthy(w.obj.GetD("hpaManaged", nil)) {
			target = meta.hpaMin
		}
		downscalable := w.kind == "Deployment"
		dropFrac := 0.0
		if downscalable {
			dropFrac = math.Max(0.0, (reps-f64d(target, 0))/reps)
		}
		cost := f64d(w.obj.GetD("monthlyCost", 0.0), 0)
		save := cost * downFrac * dropFrac
		isAuto := automated[w.key] || dsAutoNs[w.namespace]
		active := isAuto && grid[curDay][curHour] && dropFrac > 0
		if active {
			activeScaled++
		}
		if !isAuto {
			totSavingsUnauto += save
		}
		totCost += cost
		// resource savings from downscaling automated workloads
		if isAuto && downscalable {
			dropped := (reps - f64d(target, 0)) * downFrac
			cpuSaved += f64d(w.obj.GetD("reqCpu", 0), 0) * dropped
			memSaved += f64d(w.obj.GetD("reqMem", 0), 0) * dropped
			gpuSaved += f64d(w.obj.GetD("reqGpu", 0), 0) * dropped
		}
		rows = append(rows, pyjson.NewObj().
			Set("key", w.obj.GetD("key", nil)).
			Set("namespace", w.obj.GetD("namespace", nil)).
			Set("kind", w.obj.GetD("kind", nil)).
			Set("name", w.obj.GetD("name", nil)).
			Set("replicas", w.obj.GetD("replicas", nil)).
			Set("reqCpu", w.obj.GetD("reqCpu", nil)).
			Set("reqMem", w.obj.GetD("reqMem", nil)).
			Set("reqGpu", w.obj.GetD("reqGpu", 0)).
			Set("downscalable", downscalable).
			Set("hpaManaged", w.obj.GetD("hpaManaged", nil)).
			Set("schedule", sname).
			Set("automated", isAuto).
			Set("currentlyDownscaled", active).
			Set("savings", save).
			Set("target", target))
	}
	schedules := []any{}
	builtinKindOf := map[string]string{}
	for _, pair := range downscaleSchedulePairs {
		builtinKindOf[pair[0]] = pair[1]
	}
	for _, pair := range downscaleSchedulePairs {
		name, kind := pair[0], pair[1]
		m := schedMeta[name]
		entry := pyjson.NewObj().
			Set("name", name).
			Set("kind", kind).
			Set("windows", gridJSONRows(m.grid)).
			Set("builtIn", true).
			Set("hpaMinReplicas", m.hpaMin).
			Set("targetReplicas", m.target).
			Set("sleep", m.sleep)
		// CR wins over the seed: expose its editable fields on the builtin row.
		if p, ok := crByName[name]; ok {
			entry.Set("hpaEnabled", p.GetD("hpaEnabled", true)).
				Set("periods", periodsForEditor(getList(p, "schedule")))
		}
		schedules = append(schedules, entry.
			Set("attachedWorkloads", attachedCount[name]).
			Set("activeNow", m.grid[curDay][curHour]))
	}
	for _, p := range crPolicies {
		name := str(p.GetD("name", nil))
		if _, isBuiltin := builtinKindOf[name]; isBuiltin {
			continue // already emitted above (dedupe: seed + CR share the name)
		}
		m := schedMeta[name]
		if m == nil {
			m = dsMetaFromPolicy(p)
		}
		schedules = append(schedules, pyjson.NewObj().
			Set("name", p.GetD("name", nil)).
			Set("kind", "custom").
			Set("windows", gridJSONRows(m.grid)).
			Set("builtIn", false).
			Set("sleep", m.sleep).
			Set("hpaMinReplicas", m.hpaMin).
			Set("targetReplicas", m.target).
			Set("hpaEnabled", p.GetD("hpaEnabled", true)).
			Set("periods", periodsForEditor(getList(p, "schedule"))).
			Set("attachedWorkloads", attachedCount[name]).
			Set("activeNow", m.grid[curDay][curHour]))
	}
	wastedPct := 0.0
	if totCost != 0 {
		wastedPct = totSavingsUnauto / totCost * 100.0
	}
	totals := pyjson.NewObj().
		Set("monthlyCost", overview.GetD("monthlyCost", 0.0)).
		Set("downscalerWorkloads", len(rows)).
		Set("automated", len(automated)).
		Set("wastedPct", wastedPct).
		Set("savingsAvailable", totSavingsUnauto).
		Set("cpuSaved", cpuSaved).
		Set("memSaved", memSaved).
		Set("gpuSaved", gpuSaved).
		Set("activeScaledDown", activeScaled).
		Set("curDay", curDay).
		Set("curHour", curHour).
		Set("readOnly", e.Cfg.ReadOnly)
	return pyjson.NewObj().
		Set("schedules", schedules).
		Set("workloads", rows).
		Set("totals", totals).
		Set("clusterName", e.Cfg.ClusterName), nil
}
