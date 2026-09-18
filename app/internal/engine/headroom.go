package engine

import (
	"context"
	"fmt"
	"math"
	"os"
	"strings"
	"time"

	"coolscaler.sh/coolscaler/internal/pyjson"
)

// Cluster Headroom (v2)

const (
	headroomV2CM        = "coolscaler-static-headroom"
	headroomPartOf      = "coolscaler"
	headroomLabel       = "coolscaler.sh/headroom"
	headroomConfigLbl   = "coolscaler.sh/headroom-config"
	headroomPodSelector = "app.kubernetes.io/part-of=" + headroomPartOf + "," + headroomLabel + "=true"
)

// HeadroomOverview is GET /api/headroom/overview. With none present every value
// is 0. nodePoolsWithHeadroomPct is the share of node "pools" (grouped by
// instance-type, falling back to nodegroup) that host at least one headroom pod.
func (e *Engine) HeadroomOverview(ctx context.Context) *pyjson.Obj {
	var cpu, mem, gpu float64
	podsByNode := map[string]bool{}
	if pods, err := e.Kube.GetJSON(ctx, "/api/v1/pods?labelSelector="+headroomPodSelector); err == nil {
		for _, pv := range items(pods) {
			p := obj(pv)
			ph := getStr(getObj(p, "status"), "phase")
			if ph != "Running" && ph != "Pending" {
				continue
			}
			for _, cv := range getList(getObj(p, "spec"), "containers") {
				r := getObj(obj(obj(cv).GetD("resources", nil)), "requests")
				cpu += ParseCPU(r.GetD("cpu", nil))
				mem += ParseMem(r.GetD("memory", nil))
				gpu += anyQuantityFloat(r.GetD("nvidia.com/gpu", nil))
			}
			if nn := getStr(getObj(p, "spec"), "nodeName"); nn != "" {
				podsByNode[nn] = true
			}
		}
	}

	poolsTotal := map[string]bool{}
	poolsWith := map[string]bool{}
	if nodes, err := e.Kube.GetJSON(ctx, "/api/v1/nodes"); err == nil {
		for _, nv := range items(nodes) {
			n := obj(nv)
			md := getObj(n, "metadata")
			lbl := getObj(md, "labels")
			pool := nodeInstanceType(lbl)
			if pool == "" {
				pool = nodeGroup(lbl)
			}
			if pool == "" {
				pool = "default"
			}
			poolsTotal[pool] = true
			if podsByNode[getStr(md, "name")] {
				poolsWith[pool] = true
			}
		}
	}
	pct := 0.0
	if len(poolsTotal) > 0 {
		pct = float64(len(poolsWith)) / float64(len(poolsTotal)) * 100
	}

	return pyjson.NewObj().
		Set("cpuHeadroom", pyjson.Round(cpu, 3)).
		Set("memoryHeadroom", int64(mem)).
		Set("gpuHeadroom", int(gpu)).
		Set("nodePoolsWithHeadroomPct", pyjson.Round(pct, 1))
}

// headroomReserve sums the configured reservation across all v2 configs into a
// static part (absolute cores / bytes) and a dynamic part (fraction of
// allocatable, 0..1). The graph band is static + dynamic*allocatable per point.
func headroomReserve(cfgs []*pyjson.Obj) (cpuStatic, cpuDyn, memStatic, memDyn float64) {
	for _, c := range cfgs {
		cr := getObj(c, "cpu")
		if getStr(cr, "type") == "dynamic" {
			cpuDyn += f64d(cr.GetD("value", 0.0), 0) / 100.0
		} else {
			cpuStatic += f64d(cr.GetD("value", 0.0), 0)
		}
		mr := getObj(c, "memory")
		if getStr(mr, "type") == "dynamic" {
			memDyn += f64d(mr.GetD("value", 0.0), 0) / 100.0
		} else {
			// static memory input is in GiB (matches the UI unit label).
			memStatic += f64d(mr.GetD("value", 0.0), 0) * (1 << 30)
		}
	}
	return
}

// HeadroomGraph is GET /api/headroom/graph?range=7d|30d. Usage/request/
// allocatable come from the SAME cluster-resource series the Node Management
// page uses (clusterResQ over Prometheus range); the "headroom" band is the
// configured reservation (0 when no config). GPU is all-zero (no GPU nodes —
// honest). No history -> empty (never fabricated) series.
func (e *Engine) HeadroomGraph(ctx context.Context, rng string) *pyjson.Obj {
	if rng != "7d" && rng != "30d" {
		rng = "7d"
	}
	group := "hour"
	if rng == "30d" {
		group = "day"
	}
	cpuStatic, cpuDyn, memStatic, memDyn := headroomReserve(e.loadHeadroomConfigs(ctx))
	merged := e.promRangeMerge(ctx, clusterResQ, rng, group)

	cpu := []any{}
	mem := []any{}
	gpu := []any{}
	for _, pv := range merged {
		p := obj(pv)
		t, err := time.Parse("2006-01-02T15:04:05Z", getStr(p, "timestamp"))
		if err != nil {
			continue
		}
		unix := t.Unix()
		vals := getObj(p, "values")
		cAlloc := f64d(vals.GetD("cpuAllocatable", 0.0), 0)
		mAlloc := f64d(vals.GetD("memoryAllocatable", 0.0), 0)
		cpu = append(cpu, pyjson.NewObj().
			Set("ts", unix).
			Set("usage", pyjson.Round(f64d(vals.GetD("cpuUsageTotal", 0.0), 0), 4)).
			Set("request", pyjson.Round(f64d(vals.GetD("cpuRequests", 0.0), 0), 4)).
			Set("headroom", pyjson.Round(cpuStatic+cpuDyn*cAlloc, 4)).
			Set("allocatable", pyjson.Round(cAlloc, 4)))
		mem = append(mem, pyjson.NewObj().
			Set("ts", unix).
			Set("usage", pyjson.Round(f64d(vals.GetD("memoryUsageTotal", 0.0), 0), 4)).
			Set("request", pyjson.Round(f64d(vals.GetD("memoryRequests", 0.0), 0), 4)).
			Set("headroom", pyjson.Round(memStatic+memDyn*mAlloc, 4)).
			Set("allocatable", pyjson.Round(mAlloc, 4)))
		gpu = append(gpu, pyjson.NewObj().
			Set("ts", unix).
			Set("usage", 0).
			Set("request", 0).
			Set("headroom", 0).
			Set("allocatable", 0))
	}
	return pyjson.NewObj().Set("cpu", cpu).Set("memory", mem).Set("gpu", gpu)
}

// loadHeadroomConfigs reads the v2 configs from the coolscaler-static-headroom
// ConfigMap data key `configurationv2` ({"configurations":[...]}). Absent/null
// -> empty.
func (e *Engine) loadHeadroomConfigs(ctx context.Context) []*pyjson.Obj {
	cm, err := e.Kube.GetJSON(ctx,
		"/api/v1/namespaces/"+e.Cfg.Namespace+"/configmaps/"+headroomV2CM)
	if err != nil {
		return nil
	}
	raw := strings.TrimSpace(getStr(getObj(cm, "data"), "configurationv2"))
	if raw == "" || raw == "null" {
		return nil
	}
	v, err := pyjson.Decode([]byte(raw))
	if err != nil {
		return nil
	}
	var out []*pyjson.Obj
	for _, cv := range getList(obj(v), "configurations") {
		out = append(out, normalizeHeadroomConfig(obj(cv)))
	}
	return out
}

// normalizeResource renders a resource sub-object in canonical, stable key
// order: {type:"static"|"dynamic", value:<number>}.
func normalizeResource(o *pyjson.Obj) *pyjson.Obj {
	typ := str(o.GetD("type", "static"))
	if typ != "static" && typ != "dynamic" {
		typ = "static"
	}
	val := f64d(o.GetD("value", 0.0), 0)
	if val < 0 {
		val = 0
	}
	return pyjson.NewObj().Set("type", typ).Set("value", pyjson.Round(val, 4))
}

func normalizeHeadroomConfig(o *pyjson.Obj) *pyjson.Obj {
	// schedule: list of {startTime,endTime,days:[...]} or null
	var schedule any = nil
	if sv, ok := o.Get("schedule"); ok && truthy(sv) {
		periods := []any{}
		for _, pv := range getList(o, "schedule") {
			p := obj(pv)
			days := []any{}
			for _, dv := range getList(p, "days") {
				days = append(days, int(i64(dv)))
			}
			periods = append(periods, pyjson.NewObj().
				Set("startTime", str(p.GetD("startTime", ""))).
				Set("endTime", str(p.GetD("endTime", ""))).
				Set("days", days))
		}
		schedule = periods
	}
	// tolerations: list of {key,operator,value,effect}
	tolerations := []any{}
	for _, tv := range getList(o, "tolerations") {
		t := obj(tv)
		tolerations = append(tolerations, pyjson.NewObj().
			Set("key", str(t.GetD("key", ""))).
			Set("operator", str(t.GetD("operator", "Equal"))).
			Set("value", str(t.GetD("value", ""))).
			Set("effect", str(t.GetD("effect", ""))))
	}
	// nodeSelector: string->string map (stable key order)
	nodeSelector := pyjson.NewObj()
	ns := getObj(o, "nodeSelector")
	for _, k := range ns.Keys() {
		nodeSelector.Set(k, str(ns.GetD(k, "")))
	}
	// nodePools: list of strings
	nodePools := []any{}
	for _, pv := range getList(o, "nodePools") {
		nodePools = append(nodePools, str(pv))
	}
	life := str(o.GetD("lifecycle", ""))
	if life != "spot" && life != "onDemand" {
		life = ""
	}
	return pyjson.NewObj().
		Set("name", str(o.GetD("name", ""))).
		Set("cpu", normalizeResource(getObj(o, "cpu"))).
		Set("memory", normalizeResource(getObj(o, "memory"))).
		Set("gpu", normalizeResource(getObj(o, "gpu"))).
		Set("lifecycle", life).
		Set("nodePools", nodePools).
		Set("schedule", schedule).
		Set("tolerations", tolerations).
		Set("nodeSelector", nodeSelector)
}

// HeadroomConfigurations is GET /api/headroom/configurations.
func (e *Engine) HeadroomConfigurations(ctx context.Context) *pyjson.Obj {
	cfgs := e.loadHeadroomConfigs(ctx)
	out := []any{}
	for _, c := range cfgs {
		out = append(out, c)
	}
	return pyjson.NewObj().Set("configurations", out)
}

// PostHeadroomConfigurations is POST /api/headroom/configurations
// {configurations:[...]} — validates, persists to the coolscaler-static-headroom
// CM (data.configurationv2), reconciles pause-pod Deployments (write-gated), and
// audits. The CM persist is the primary effect: the page works even when the
// Deployment reconcile is a no-op (read-only).
func (e *Engine) PostHeadroomConfigurations(ctx context.Context, body *pyjson.Obj) (int, *pyjson.Obj) {
	raw := getList(body, "configurations")
	seen := map[string]bool{}
	cfgs := []*pyjson.Obj{}
	for _, cv := range raw {
		c := normalizeHeadroomConfig(obj(cv))
		name := strings.TrimSpace(str(c.GetD("name", "")))
		if name == "" {
			return 400, pyjson.NewObj().Set("error", "every configuration requires a name")
		}
		if seen[name] {
			return 400, pyjson.NewObj().Set("error", "duplicate configuration name: "+name)
		}
		seen[name] = true
		c.Set("name", name)
		cfgs = append(cfgs, c)
	}
	e.saveHeadroomV2CM(ctx, cfgs)
	e.reconcileHeadroomDeployments(ctx, cfgs)
	e.audit("headroom-config-save", "cluster", "", fmt.Sprintf("%d configuration(s)", len(cfgs)), "user")
	return 200, pyjson.NewObj().Set("ok", true)
}

// saveHeadroomV2CM persists the v2 configs to the CM's configurationv2 data key
// (PATCH-then-POST, honoring the WRITE_ENABLED gate via k8sReq). The legacy
// `configuration` key (if any) is left untouched.
func (e *Engine) saveHeadroomV2CM(ctx context.Context, cfgs []*pyjson.Obj) {
	lst := []any{}
	for _, c := range cfgs {
		lst = append(lst, c)
	}
	blob := string(pyjson.Marshal(pyjson.NewObj().Set("configurations", lst)))
	data := pyjson.NewObj().Set("configurationv2", blob)
	cmPath := "/api/v1/namespaces/" + e.Cfg.Namespace + "/configmaps/" + headroomV2CM
	if _, err := e.k8sReq(ctx, "PATCH", cmPath,
		pyjson.NewObj().Set("data", data), "application/merge-patch+json"); err != nil {
		if _, ok := isHTTPError(err); ok {
			_, err2 := e.k8sReq(ctx, "POST", "/api/v1/namespaces/"+e.Cfg.Namespace+"/configmaps",
				pyjson.NewObj().
					Set("apiVersion", "v1").
					Set("kind", "ConfigMap").
					Set("metadata", pyjson.NewObj().
						Set("name", headroomV2CM).
						Set("namespace", e.Cfg.Namespace).
						Set("labels", pyjson.NewObj().
							Set("app.kubernetes.io/part-of", headroomPartOf))).
					Set("data", data), "application/json")
			if err2 != nil {
				e.Log.Info("save_headroom_v2_cm failed", "err", err2)
			}
		} else {
			e.Log.Info("save_headroom_v2_cm failed", "err", err)
		}
	}
}

// headroomImage is the pause-pod image: the running CoolScaler image (busybox
// base, so `sleep infinity` works), falling back to plain busybox.
func headroomImage() string {
	if img := os.Getenv("JMX_AGENT_IMAGE"); img != "" {
		return img
	}
	return "busybox:stable-glibc"
}

// headroomDeployName is the reconciled Deployment name for a config.
func headroomDeployName(name string) string {
	return crName("headroom", name) // sanitized, <=253, dns-safe
}

// buildHeadroomDeployment renders the pause-pod Deployment for a config: replicas =
// ceil(cpu.value) for static CPU, the low-priority overprovisioning PriorityClass,
// preemptionPolicy Never, plus the config's lifecycle/nodeSelector/tolerations.
func (e *Engine) buildHeadroomDeployment(depName string, c *pyjson.Obj) *pyjson.Obj {
	name := str(c.GetD("name", ""))
	cr := getObj(c, "cpu")
	reps := 0
	if getStr(cr, "type") == "static" {
		reps = int(math.Ceil(f64d(cr.GetD("value", 0.0), 0)))
	} else if f64d(cr.GetD("value", 0.0), 0) > 0 {
		reps = 1
	}
	if reps < 0 {
		reps = 0
	}

	labels := pyjson.NewObj().
		Set("app.kubernetes.io/part-of", headroomPartOf).
		Set(headroomLabel, "true").
		Set(headroomConfigLbl, depName)
	matchLabels := pyjson.NewObj().Set(headroomConfigLbl, depName)

	// nodeSelector from config
	nodeSelector := pyjson.NewObj()
	ns := getObj(c, "nodeSelector")
	for _, k := range ns.Keys() {
		nodeSelector.Set(k, str(ns.GetD(k, "")))
	}
	// tolerations from config
	tolerations := []any{}
	for _, tv := range getList(c, "tolerations") {
		t := obj(tv)
		tol := pyjson.NewObj().Set("key", str(t.GetD("key", "")))
		if op := str(t.GetD("operator", "")); op != "" {
			tol.Set("operator", op)
		}
		if v := str(t.GetD("value", "")); v != "" {
			tol.Set("value", v)
		}
		if ef := str(t.GetD("effect", "")); ef != "" {
			tol.Set("effect", ef)
		}
		tolerations = append(tolerations, tol)
	}

	podSpec := pyjson.NewObj().
		Set("priorityClassName", "coolscaler-overprovisioning").
		Set("preemptionPolicy", "Never").
		Set("terminationGracePeriodSeconds", 0).
		Set("containers", []any{pyjson.NewObj().
			Set("name", "pause").
			Set("image", headroomImage()).
			Set("command", []any{"/bin/sh", "-c", "sleep infinity"}).
			Set("resources", pyjson.NewObj().
				Set("requests", pyjson.NewObj().Set("cpu", "1").Set("memory", "1Gi")).
				Set("limits", pyjson.NewObj().Set("cpu", "1").Set("memory", "1Gi")))})
	if len(nodeSelector.Keys()) > 0 {
		podSpec.Set("nodeSelector", nodeSelector)
	}
	if len(tolerations) > 0 {
		podSpec.Set("tolerations", tolerations)
	}

	return pyjson.NewObj().
		Set("apiVersion", "apps/v1").
		Set("kind", "Deployment").
		Set("metadata", pyjson.NewObj().
			Set("name", depName).
			Set("namespace", e.Cfg.Namespace).
			Set("labels", labels).
			Set("annotations", pyjson.NewObj().Set("coolscaler.sh/headroom-config-name", name))).
		Set("spec", pyjson.NewObj().
			Set("replicas", reps).
			Set("selector", pyjson.NewObj().Set("matchLabels", matchLabels)).
			Set("template", pyjson.NewObj().
				Set("metadata", pyjson.NewObj().Set("labels", labels)).
				Set("spec", podSpec)))
}

// reconcileHeadroomDeployments creates/updates a pause-pod Deployment per config
// and deletes Deployments for removed configs. Write-gated (no-op read-only);
// best-effort (errors logged, never fatal). CM persistence is the primary path.
func (e *Engine) reconcileHeadroomDeployments(ctx context.Context, cfgs []*pyjson.Obj) {
	if !e.Cfg.WriteRecommendationCRs {
		return
	}
	ns := e.Cfg.Namespace
	want := map[string]*pyjson.Obj{}
	for _, c := range cfgs {
		name := str(c.GetD("name", ""))
		if name == "" {
			continue
		}
		want[headroomDeployName(name)] = c
	}

	// delete Deployments for removed configs
	if lst, err := e.Kube.GetJSON(ctx,
		"/apis/apps/v1/namespaces/"+ns+"/deployments?labelSelector="+headroomLabel+"=true"); err == nil {
		for _, dv := range items(lst) {
			dn := getStr(getObj(obj(dv), "metadata"), "name")
			if _, ok := want[dn]; !ok {
				if _, derr := e.k8sReq(ctx, "DELETE",
					"/apis/apps/v1/namespaces/"+ns+"/deployments/"+dn, nil, ""); derr != nil {
					e.Log.Info("headroom deployment delete failed", "name", dn, "err", derr)
				}
			}
		}
	}

	// upsert wanted Deployments (PATCH-then-POST, like the config CMs)
	for dn, c := range want {
		dep := e.buildHeadroomDeployment(dn, c)
		path := "/apis/apps/v1/namespaces/" + ns + "/deployments/" + dn
		if _, err := e.k8sReq(ctx, "PATCH", path, dep, "application/merge-patch+json"); err != nil {
			if _, ok := isHTTPError(err); ok {
				if _, perr := e.k8sReq(ctx, "POST",
					"/apis/apps/v1/namespaces/"+ns+"/deployments", dep, "application/json"); perr != nil {
					e.Log.Info("headroom deployment create failed", "name", dn, "err", perr)
				}
			} else {
				e.Log.Info("headroom deployment patch failed", "name", dn, "err", err)
			}
		}
	}
}
