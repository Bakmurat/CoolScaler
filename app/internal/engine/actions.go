package engine

import (
	"context"
	"fmt"
	"math"
	"os"
	"sort"
	"strings"
	"time"

	"coolscaler.sh/coolscaler/internal/pyjson"
)

// Workload apply / policy attach / rollout actions plus the POST endpoint
// bodies from RecommenderHandler.do_POST (8210–8740).

var wlAPI = map[string]string{
	"Deployment":  "/apis/apps/v1/namespaces/%s/deployments/%s",
	"StatefulSet": "/apis/apps/v1/namespaces/%s/statefulsets/%s",
	"DaemonSet":   "/apis/apps/v1/namespaces/%s/daemonsets/%s",
}

func (e *Engine) resolveWorkload(ctx context.Context, ns, kind, name string) *wlRow {
	e.mu.Lock()
	row := e.byKey[wlkey(ns, kind, name)]
	e.mu.Unlock()
	if row != nil {
		return row
	}
	if kind == "ReplicaSet" {
		rs, err := e.Kube.GetJSON(ctx, "/apis/apps/v1/namespaces/"+ns+"/replicasets/"+name)
		if err != nil {
			return nil
		}
		for _, ov := range getList(getObj(rs, "metadata"), "ownerReferences") {
			or := obj(ov)
			if truthy(or.GetD("controller", nil)) {
				e.mu.Lock()
				r := e.byKey[wlkey(ns, getStr(or, "kind"), getStr(or, "name"))]
				e.mu.Unlock()
				return r
			}
		}
	}
	return nil
}

func (e *Engine) convertAutoscalerTriggers(ctx context.Context, ns string, wl *wlRow) string {
	conv := getList(wl.obj, "hpaConversions")
	if len(conv) == 0 {
		return ""
	}
	var note []string
	hpa := str(wl.obj.GetD("hpaName", nil))
	if hpa != "" {
		hpaPath := "/apis/autoscaling/v2/namespaces/" + ns + "/horizontalpodautoscalers/" + hpa
		h, err := e.Kube.GetJSON(ctx, hpaPath)
		if err != nil {
			note = append(note, fmt.Sprintf("HPA convert failed: %v", err))
		} else {
			byres := map[string]*pyjson.Obj{}
			for _, cv := range conv {
				c := obj(cv)
				if getStr(c, "source") == "HPA" {
					byres[getStr(c, "resource")] = c
				}
			}
			metrics := getList(getObj(h, "spec"), "metrics")
			for _, mv := range metrics {
				res := getObj(obj(mv), "resource")
				rn := getStr(res, "name")
				if c, ok := byres[rn]; ok && getStr(getObj(res, "target"), "type") == "Utilization" {
					res.Set("target", pyjson.NewObj().
						Set("type", "AverageValue").
						Set("averageValue", c.GetD("averageValue", nil)))
				}
			}
			if _, perr := e.k8sPatch(ctx, hpaPath, pyjson.NewObj().
				Set("spec", pyjson.NewObj().Set("metrics", metrics))); perr == nil {
				note = append(note, fmt.Sprintf("HPA %s triggers → AverageValue", hpa))
			} else {
				note = append(note, fmt.Sprintf("HPA convert failed: %v", perr))
			}
		}
	}
	return strings.Join(note, "; ")
}

func (e *Engine) applyRecommendation(ctx context.Context, ns, kind, name string) (bool, string) {
	if e.Cfg.ReadOnly {
		return false, "Cluster is in Read-Only mode"
	}
	e.mu.Lock()
	wl := e.byKey[wlkey(ns, kind, name)]
	e.mu.Unlock()
	if wl == nil {
		return false, "workload not found"
	}
	api, ok := wlAPI[kind]
	if !ok {
		return false, "unsupported kind " + kind
	}
	containers := []any{}
	for _, cv := range getList(wl.obj, "containers") {
		c := obj(cv)
		if truthy(c.GetD("excluded", nil)) {
			continue // injected sidecars: never patch into the template (HTTP 422)
		}
		containers = append(containers, pyjson.NewObj().
			Set("name", c.GetD("name", nil)).
			Set("resources", pyjson.NewObj().
				Set("requests", pyjson.NewObj().
					Set("cpu", FmtCPU(f64d(c.GetD("recCpu", 0), 0))).
					Set("memory", FmtMem(f64d(c.GetD("recMem", 0), 0))))))
	}
	if len(containers) == 0 {
		return false, "nothing to apply (only injected sidecars present)"
	}
	hpaNote := ""
	if wl.hpaManaged {
		hpaNote = e.convertAutoscalerTriggers(ctx, ns, wl)
	}
	_, err := e.k8sPatch(ctx, fmt.Sprintf(api, ns, name), pyjson.NewObj().
		Set("spec", pyjson.NewObj().
			Set("template", pyjson.NewObj().
				Set("spec", pyjson.NewObj().Set("containers", containers)))))
	if err != nil {
		return false, err.Error()
	}
	msg := "applied (rolling update)"
	if hpaNote != "" {
		msg += " + " + hpaNote
	}
	return true, msg
}

func (e *Engine) resizePodInPlace(ctx context.Context, ns, pod string, containers []any) (bool, string) {
	body := []any{}
	for _, cv := range containers {
		c := obj(cv)
		if truthy(c.GetD("excluded", nil)) {
			continue
		}
		body = append(body, pyjson.NewObj().
			Set("name", c.GetD("name", nil)).
			Set("resources", pyjson.NewObj().
				Set("requests", pyjson.NewObj().
					Set("cpu", FmtCPU(f64d(c.GetD("recCpu", 0), 0))).
					Set("memory", FmtMem(f64d(c.GetD("recMem", 0), 0))))))
	}
	path := "/api/v1/namespaces/" + ns + "/pods/" + pod + "/resize"
	_, err := e.k8sReq(ctx, "PATCH", path, pyjson.NewObj().
		Set("spec", pyjson.NewObj().Set("containers", body)),
		"application/strategic-merge-patch+json")
	if err == nil {
		return true, "resized"
	}
	if code, ok := isHTTPError(err); ok {
		if code == 404 {
			return false, "resize subresource unavailable (HTTP 404)"
		}
		return false, fmt.Sprintf("HTTP %d: %s", code, err.Error())
	}
	return false, err.Error()
}

func (e *Engine) applyInplace(ctx context.Context, ns, kind, name string) (bool, string, []any) {
	if e.Cfg.ReadOnly {
		return false, "Cluster is in Read-Only mode", []any{}
	}
	e.mu.Lock()
	wl := e.byKey[wlkey(ns, kind, name)]
	e.mu.Unlock()
	if wl == nil {
		return false, "workload not found", []any{}
	}
	var pods []string
	for _, pv := range getList(wl.obj, "podNames") {
		pods = append(pods, str(pv))
	}
	if len(pods) == 0 {
		return false, "no running pods found for workload", []any{}
	}
	// No-op guard: if every non-excluded container's LIVE request already
	// matches the recommendation (within 2%), skip the resize entirely —
	// otherwise the updater loop re-"optimizes" the same workload every cycle
	// (event spam + pointless resize subresource churn).
	atRec := true
	for _, cv := range getList(wl.obj, "containers") {
		c := obj(cv)
		if truthy(c.GetD("excluded", nil)) {
			continue
		}
		req, rec := f64d(c.GetD("reqCpu", 0.0), 0), f64d(c.GetD("recCpu", 0.0), 0)
		if rec > 0 && (req <= 0 || req < rec*0.98 || req > rec*1.02) {
			atRec = false
			break
		}
		reqM, recM := f64d(c.GetD("reqMem", 0.0), 0), f64d(c.GetD("recMem", 0.0), 0)
		if recM > 0 && (reqM <= 0 || reqM < recM*0.98 || reqM > recM*1.02) {
			atRec = false
			break
		}
	}
	if atRec {
		return true, "already at recommendation", []any{}
	}
	if wl.hpaManaged {
		e.convertAutoscalerTriggers(ctx, ns, wl)
	}
	results := []any{}
	okAny, unsupported, okCount := false, false, 0
	for _, pod := range pods {
		ok, msg := e.resizePodInPlace(ctx, ns, pod, getList(wl.obj, "containers"))
		results = append(results, pyjson.NewObj().
			Set("pod", pod).Set("ok", ok).Set("message", msg))
		if ok {
			okAny = true
			okCount++
		}
		if strings.Contains(msg, "unavailable") {
			unsupported = true
		}
	}
	if unsupported && !okAny {
		ok, msg := e.applyRecommendation(ctx, ns, kind, name)
		return ok, "in-place unsupported → fell back to rolling update: " + msg, results
	}
	return okAny, fmt.Sprintf("resized %d/%d pods in place (no restart)", okCount, len(results)), results
}

func (e *Engine) attachPolicy(ctx context.Context, ns, kind, name, policy string) (bool, string) {
	names := e.builtinPolicyNameSet()
	for k := range e.loadPolicies(ctx) {
		names[k.name] = true
	}
	if !names[policy] {
		return false, fmt.Sprintf("unknown policy '%s'", policy)
	}
	if e.Cfg.ReadOnly {
		return false, "Cluster is in Read-Only mode (policy not written)"
	}
	api, ok := wlAPI[kind]
	if !ok {
		return false, "unsupported kind " + kind
	}
	_, err := e.k8sPatch(ctx, fmt.Sprintf(api, ns, name), pyjson.NewObj().
		Set("spec", pyjson.NewObj().Set("template", pyjson.NewObj().
			Set("metadata", pyjson.NewObj().
				Set("annotations", pyjson.NewObj().Set("coolscaler.sh/policy", policy))))))
	if err != nil {
		return false, err.Error()
	}
	return true, fmt.Sprintf("attached policy '%s'", policy)
}

func (e *Engine) restoreSuggestedPolicy(ctx context.Context, ns, kind, name string) (bool, string, string) {
	e.mu.Lock()
	row := e.byKey[wlkey(ns, kind, name)]
	e.mu.Unlock()
	suggested := "production"
	if row != nil {
		suggested = str(row.obj.GetD("policySuggested", "production"))
	}
	if e.Cfg.ReadOnly {
		return false, "Cluster is in Read-Only mode (annotation not removed)", suggested
	}
	api, ok := wlAPI[kind]
	if !ok {
		return false, "unsupported kind " + kind, suggested
	}
	_, err := e.k8sReq(ctx, "PATCH", fmt.Sprintf(api, ns, name), pyjson.NewObj().
		Set("spec", pyjson.NewObj().Set("template", pyjson.NewObj().
			Set("metadata", pyjson.NewObj().
				Set("annotations", pyjson.NewObj().Set("coolscaler.sh/policy", nil))))),
		"application/merge-patch+json")
	if err != nil {
		return false, err.Error(), suggested
	}
	return true, fmt.Sprintf("restored suggested policy '%s'", suggested), suggested
}

func (e *Engine) rolloutWorkload(ctx context.Context, ns, kind, name string) (bool, string) {
	if e.Cfg.ReadOnly {
		return false, "Cluster is in Read-Only mode (rollout skipped)"
	}
	api, ok := wlAPI[kind]
	if !ok {
		return false, "unsupported kind " + kind
	}
	stamp := time.Now().UTC().Format("2006-01-02T15:04:05Z")
	_, err := e.k8sPatch(ctx, fmt.Sprintf(api, ns, name), pyjson.NewObj().
		Set("spec", pyjson.NewObj().Set("template", pyjson.NewObj().
			Set("metadata", pyjson.NewObj().
				Set("annotations", pyjson.NewObj().Set("coolscaler.sh/restartedAt", stamp))))))
	if err != nil {
		return false, err.Error()
	}
	return true, "rollout triggered at " + stamp
}

// Cluster-operations ConfigMap (Java toggles)

const clusterOpsCM = "coolscaler-cluster-operations"

func (e *Engine) clusterOps(ctx context.Context, force bool) *pyjson.Obj {
	now := float64(time.Now().UnixNano()) / 1e9
	e.mu.Lock()
	if !force && now-e.clusterOpsAt < 15 && e.clusterOpsData != nil {
		d := e.clusterOpsData
		e.mu.Unlock()
		return d
	}
	e.mu.Unlock()
	data := pyjson.NewObj()
	if cm, err := e.Kube.GetJSON(ctx, "/api/v1/namespaces/"+e.Cfg.Namespace+"/configmaps/"+clusterOpsCM); err == nil {
		data = getObj(cm, "data")
	}
	e.mu.Lock()
	e.clusterOpsAt = now
	e.clusterOpsData = data
	e.mu.Unlock()
	return data
}

func (e *Engine) javaEnabled() bool {
	return strings.EqualFold(os.Getenv("JAVA_OPTIMIZATION_ENABLED"), "true")
}

func (e *Engine) javaObservabilityOn(ctx context.Context) bool {
	return e.javaEnabled() || str(e.clusterOps(ctx, false).GetD("java-observability", nil)) == "true"
}

func (e *Engine) javaOptimizeOn(ctx context.Context) bool {
	return str(e.clusterOps(ctx, false).GetD("java-optimize", nil)) == "true"
}

func (e *Engine) javaAutoFor(ctx context.Context, ns, kind, name string, ann *pyjson.Obj, autoNs map[string]autoNS) bool {
	key := wlkey(ns, kind, name)
	e.mu.Lock()
	un, on := e.javaUnautomated[key], e.javaAutomated[key]
	e.mu.Unlock()
	if un {
		return false
	}
	if on {
		return true
	}
	if ann != nil {
		if av, ok := ann.Get("coolscaler.sh/java-auto"); ok && av != nil {
			return strings.EqualFold(str(av), "true")
		}
	}
	if autoNs == nil {
		autoNs = e.loadAutomatedNamespaces(ctx)
	}
	if autoNs[ns].javaOptimize {
		return true
	}
	return e.javaOptimizeOn(ctx)
}

func (e *Engine) setClusterOps(ctx context.Context, patch *pyjson.Obj) error {
	path := "/api/v1/namespaces/" + e.Cfg.Namespace + "/configmaps/" + clusterOpsCM
	_, err := e.Kube.GetJSON(ctx, path)
	if err == nil {
		if _, perr := e.k8sReq(ctx, "PATCH", path,
			pyjson.NewObj().Set("data", patch), "application/merge-patch+json"); perr != nil {
			return perr
		}
	} else if isHTTPNotFound(err) {
		body := pyjson.NewObj().
			Set("apiVersion", "v1").
			Set("kind", "ConfigMap").
			Set("metadata", pyjson.NewObj().
				Set("name", clusterOpsCM).
				Set("namespace", e.Cfg.Namespace).
				Set("labels", pyjson.NewObj().Set("app.kubernetes.io/part-of", "coolscaler"))).
			Set("data", patch)
		if _, perr := e.k8sReq(ctx, "POST", "/api/v1/namespaces/"+e.Cfg.Namespace+"/configmaps", body, "application/json"); perr != nil {
			return perr
		}
	} else {
		return err
	}
	e.clusterOps(ctx, true)
	return nil
}

func (e *Engine) setWorkloadTemplateAnnotations(ctx context.Context, ns, kind, name string, anns *pyjson.Obj) bool {
	api, ok := wlAPI[kind]
	if !ok {
		return false
	}
	_, err := e.k8sPatch(ctx, fmt.Sprintf(api, ns, name), pyjson.NewObj().
		Set("spec", pyjson.NewObj().Set("template", pyjson.NewObj().
			Set("metadata", pyjson.NewObj().Set("annotations", anns)))))
	if err != nil {
		e.Log.Info("set wl template annotations failed", "err", err)
		return false
	}
	return true
}

func ansDefaults() *pyjson.Obj {
	return pyjson.NewObj().
		Set("defaultPolicy", "production").
		Set("defaultRightsizePolicy", "production").
		Set("defaultReplicasPolicy", "production").
		Set("defaultGpuPolicy", "real-time").
		Set("defaultGpuMemoryPolicy", "vllm-memory-aware").
		Set("defaultSpotPolicy", "spot-friendly")
}

func (e *Engine) setAutomatedNsField(ctx context.Context, nsx, field string, on bool, source string) error {
	path := crdBase("automatednamespaces", "") + "/" + nsx
	ts := isoNow()
	spec := pyjson.NewObj().Set(field, on).Set(field+"UpdateVersion", ts)
	if field == "optimize" {
		spec.Set("rightsizeOptimize", on).Set("rightsizeOptimizeUpdateVersion", ts)
	} else if field == "rightsizeOptimize" {
		spec.Set("optimize", on).Set("optimizeUpdateVersion", ts)
	}
	ann := pyjson.NewObj().Set("coolscaler.sh/auto-indication", source)
	statusKey := "lastApplied" + strings.ToUpper(field[:1]) + field[1:]
	_, err := e.Kube.GetJSON(ctx, path)
	if err == nil {
		if _, perr := e.k8sReq(ctx, "PATCH", path, pyjson.NewObj().
			Set("metadata", pyjson.NewObj().Set("annotations", ann)).
			Set("spec", spec), "application/merge-patch+json"); perr != nil {
			return perr
		}
	} else if isHTTPNotFound(err) {
		full := ansDefaults()
		full.Update(spec)
		body := pyjson.NewObj().
			Set("apiVersion", crdGroup+"/"+crdVer).
			Set("kind", "AutomatedNamespace").
			Set("metadata", pyjson.NewObj().
				Set("name", nsx).
				Set("annotations", ann).
				Set("labels", pyjson.NewObj().Set("app.kubernetes.io/part-of", "coolscaler"))).
			Set("spec", full)
		if _, perr := e.k8sReq(ctx, "POST", crdBase("automatednamespaces", ""), body, "application/json"); perr != nil {
			return perr
		}
	} else {
		return err
	}
	statusBody := pyjson.NewObj()
	for _, k := range ansDefaults().Keys() {
		v := ansDefaults().GetD(k, nil)
		// "default..." -> "lastApplied" + k[7:].title-first
		statusBody.Set("lastApplied"+strings.ToUpper(k[7:8])+k[8:], v)
	}
	statusBody.Set(statusKey, on)
	for _, sp := range []string{path + "/status", path} {
		if _, perr := e.k8sReq(ctx, "PATCH", sp,
			pyjson.NewObj().Set("status", statusBody), "application/merge-patch+json"); perr == nil {
			break
		}
	}
	return nil
}

// save_automation_cm / save_cost_cm.

// saveAutomationCM persists GLOBAL_AUTO. Caller must NOT hold e.mu.
func (e *Engine) saveAutomationCM(ctx context.Context) {
	if !e.Cfg.WriteRecommendationCRs {
		return
	}
	e.mu.Lock()
	blob := string(pyjson.Marshal(e.globalAuto))
	e.mu.Unlock()
	cmPath := "/api/v1/namespaces/" + e.Cfg.Namespace + "/configmaps/coolscaler-automation-config"
	data := pyjson.NewObj().Set("config.json", blob)
	if _, err := e.k8sReq(ctx, "PATCH", cmPath,
		pyjson.NewObj().Set("data", data), "application/merge-patch+json"); err != nil {
		if _, ok := isHTTPError(err); ok {
			_, err2 := e.k8sReq(ctx, "POST", "/api/v1/namespaces/"+e.Cfg.Namespace+"/configmaps",
				pyjson.NewObj().
					Set("apiVersion", "v1").
					Set("kind", "ConfigMap").
					Set("metadata", pyjson.NewObj().
						Set("name", "coolscaler-automation-config").
						Set("namespace", e.Cfg.Namespace)).
					Set("data", data), "application/json")
			if err2 != nil {
				e.Log.Info("save_automation_cm failed", "err", err2)
			}
		} else {
			e.Log.Info("save_automation_cm failed", "err", err)
		}
	}
}

// saveCostCM persists the editable pricing config.
func (e *Engine) saveCostCM(ctx context.Context) {
	if !e.Cfg.WriteRecommendationCRs {
		return
	}
	blob := string(pyjson.Marshal(e.CostConfigData().GetD("costConfig", pyjson.NewObj())))
	cmPath := "/api/v1/namespaces/" + e.Cfg.Namespace + "/configmaps/coolscaler-cost-config"
	data := pyjson.NewObj().Set("config.json", blob)
	if _, err := e.k8sReq(ctx, "PATCH", cmPath,
		pyjson.NewObj().Set("data", data), "application/merge-patch+json"); err != nil {
		if _, ok := isHTTPError(err); ok {
			_, err2 := e.k8sReq(ctx, "POST", "/api/v1/namespaces/"+e.Cfg.Namespace+"/configmaps",
				pyjson.NewObj().
					Set("apiVersion", "v1").
					Set("kind", "ConfigMap").
					Set("metadata", pyjson.NewObj().
						Set("name", "coolscaler-cost-config").
						Set("namespace", e.Cfg.Namespace)).
					Set("data", data), "application/json")
			if err2 != nil {
				e.Log.Info("save_cost_cm failed", "err", err2)
			}
		} else {
			e.Log.Info("save_cost_cm failed", "err", err)
		}
	}
}

// Pod Placement — data + bin-pack apply.

var placementReasonCat = map[string]string{
	"pdb": "unevictable", "annotation": "unevictable",
	"localstorage": "localstorage", "kube-system": "kube-system",
	"unready": "unready", "ownerless": "ownerless",
}

var placementReasonChip = map[string]string{
	"pdb": "PDB", "annotation": "annotation", "localstorage": "local storage",
	"kube-system": "kube-system", "unready": "un-ready", "ownerless": "ownerless",
}

type placementCat struct {
	key, label, desc string
	canOptimize      bool
}

var placementCats = []placementCat{
	{"unevictable", "Un-evictable workloads", "Workloads with PDB or not-safe-to-evict markers that prevent node scale down.", true},
	{"localstorage", "Workloads with local storage", "Pods with local storage that prevent node scale down.", true},
	{"kube-system", "Kube-system workloads", "Kube-system pods that prevent node scale down.", true},
	{"unready", "Un-ready workloads", "Pods of un-ready workloads that prevent node scale down.", false},
	{"ownerless", "Pods without owner", "Pods without owner that prevent node scale down.", false},
}

func (e *Engine) placementData(ctx context.Context) (*pyjson.Obj, error) {
	nodes, err := e.Kube.GetJSON(ctx, "/api/v1/nodes")
	if err != nil {
		return nil, err
	}
	pods, err := e.Kube.GetJSON(ctx, "/api/v1/pods")
	if err != nil {
		return nil, err
	}
	replicasets, err := e.Kube.GetJSON(ctx, "/apis/apps/v1/replicasets")
	if err != nil {
		return nil, err
	}
	rsIndex := buildOwnerIndex(replicasets)
	pdbIndex := e.buildPDBIndex(ctx)

	nodeCost := map[string]float64{}
	type alloc struct{ cpu, mem float64 }
	nodeAlloc := map[string]alloc{}
	var nodeOrder []string
	schedulable := map[string]bool{}
	nodeReq := map[string]*[2]float64{}
	for _, nv := range items(nodes) {
		n := obj(nv)
		md, st := getObj(n, "metadata"), getObj(n, "status")
		lbl := getObj(md, "labels")
		aCpu := ParseCPU(getObj(st, "allocatable").GetD("cpu", nil))
		aMem := ParseMem(getObj(st, "allocatable").GetD("memory", nil))
		captype := getStr(lbl, "karpenter.sh/capacity-type")
		if captype == "" {
			captype = getStr(lbl, "eks.amazonaws.com/capacityType")
		}
		if captype == "" {
			captype = getStr(lbl, "node.kubernetes.io/capacity-type")
		}
		captype = strings.ToLower(captype)
		itype := getStr(lbl, "node.kubernetes.io/instance-type")
		if itype == "" {
			itype = getStr(lbl, "beta.kubernetes.io/instance-type")
		}
		name := getStr(md, "name")
		cost, _ := e.nodeMonthlyCost(itype, captype == "spot" || captype == "true", aCpu, aMem, 0)
		nodeCost[name] = cost
		nodeAlloc[name] = alloc{aCpu, aMem}
		nodeOrder = append(nodeOrder, name)
		nodeReq[name] = &[2]float64{}
		noSched := false
		for _, tv := range getList(getObj(n, "spec"), "taints") {
			eff := getStr(obj(tv), "effect")
			if eff == "NoSchedule" || eff == "NoExecute" {
				noSched = true
				break
			}
		}
		if !noSched {
			schedulable[name] = true
		}
	}

	reasonPods := map[string]int{}
	blocked := map[string]map[string]bool{}
	var blockedOrder []string
	nodeBlockPods := map[string]int{}
	pinned := map[string]bool{}
	// per-node pod categorization
	type nodeCats struct{ binPacked, unevictable, notReady, withoutOwner int }
	nodePodCats := map[string]*nodeCats{}
	for _, n := range nodeOrder {
		nodePodCats[n] = &nodeCats{}
	}
	type wlAgg struct {
		key, ns, kind, name string
		reasons             map[string]bool
		pods                int
		nodes               map[string]bool
	}
	wlMap := map[string]*wlAgg{}
	var wlOrder []string
	for _, pv := range items(pods) {
		p := obj(pv)
		spec, st := getObj(p, "spec"), getObj(p, "status")
		node := getStr(spec, "nodeName")
		running := getStr(st, "phase") == "Running"
		ready := false
		for _, cv := range getList(st, "conditions") {
			c := obj(cv)
			if getStr(c, "type") == "Ready" && getStr(c, "status") == "True" {
				ready = true
				break
			}
		}
		if node != "" {
			if _, ok := nodeAlloc[node]; ok {
				ph := getStr(st, "phase")
				if ph == "Running" || ph == "Pending" {
					for _, cv := range getList(spec, "containers") {
						req := getObj(getObj(obj(cv), "resources"), "requests")
						nodeReq[node][0] += ParseCPU(req.GetD("cpu", nil))
						nodeReq[node][1] += ParseMem(req.GetD("memory", nil))
					}
				}
			}
		}
		reasons := unevictableReasons(p, pdbIndex)
		if node != "" && running && !ready {
			reasons = append(reasons, "unready")
		}
		// categorize every scheduled pod for the by-node breakdown
		if nc := nodePodCats[node]; nc != nil {
			hasOwnerless, hasUnready, hasOther := false, false, false
			for _, r := range reasons {
				switch r {
				case "ownerless":
					hasOwnerless = true
				case "unready":
					hasUnready = true
				default:
					hasOther = true
				}
			}
			switch {
			case hasOwnerless:
				nc.withoutOwner++
			case hasUnready:
				nc.notReady++
			case hasOther:
				nc.unevictable++
			default:
				nc.binPacked++
			}
		}
		if len(reasons) == 0 {
			continue
		}
		for _, r := range reasons {
			reasonPods[r]++
		}
		if node != "" {
			if blocked[node] == nil {
				blocked[node] = map[string]bool{}
				blockedOrder = append(blockedOrder, node)
			}
			for _, r := range reasons {
				blocked[node][r] = true
			}
			nodeBlockPods[node]++
			for _, r := range reasons {
				if r == "localstorage" || r == "ownerless" {
					pinned[node] = true
				}
			}
		}
		ns, kind, name := topOwner(p, rsIndex)
		key := wlkey(ns, kind, name)
		w, ok := wlMap[key]
		if !ok {
			w = &wlAgg{key: key, ns: ns, kind: kind, name: name,
				reasons: map[string]bool{}, nodes: map[string]bool{}}
			wlMap[key] = w
			wlOrder = append(wlOrder, key)
		}
		for _, r := range reasons {
			w.reasons[r] = true
		}
		w.pods++
		if node != "" {
			w.nodes[node] = true
		}
	}

	// Greedy bin-pack: free most-expensive unpinned blocked nodes first.
	var candidates []string
	for _, n := range blockedOrder {
		if !pinned[n] {
			candidates = append(candidates, n)
		}
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		return nodeCost[candidates[i]] > nodeCost[candidates[j]]
	})
	remaining := map[string]bool{}
	for n := range nodeAlloc {
		remaining[n] = true
	}
	var freed []string
	freedSet := map[string]bool{}
	absorbedCpu, absorbedMem := 0.0, 0.0
	for _, c := range candidates {
		var spareCpu, spareMem float64
		for o := range remaining {
			if o != c && schedulable[o] {
				spareCpu += nodeAlloc[o].cpu - nodeReq[o][0]
				spareMem += nodeAlloc[o].mem - nodeReq[o][1]
			}
		}
		spareCpu -= absorbedCpu
		spareMem -= absorbedMem
		if nodeReq[c][0] <= spareCpu && nodeReq[c][1] <= spareMem {
			delete(remaining, c)
			freed = append(freed, c)
			freedSet[c] = true
			absorbedCpu += nodeReq[c][0]
			absorbedMem += nodeReq[c][1]
		}
	}
	blockedCost := 0.0
	for _, n := range freed {
		blockedCost += nodeCost[n]
	}
	totalPods := 0
	for _, n := range reasonPods {
		totalPods += n
	}
	if totalPods == 0 {
		totalPods = 1
	}
	blockedByReason := map[string]int{}
	for _, r := range []string{"pdb", "annotation", "localstorage", "kube-system", "unready", "ownerless"} {
		n := 0
		for _, rs := range blocked {
			if rs[r] {
				n++
			}
		}
		blockedByReason[r] = n
	}
	byReasonPanel := pyjson.NewObj().
		Set("pdb", blockedByReason["pdb"]+blockedByReason["annotation"]).
		Set("localstorage", blockedByReason["localstorage"]).
		Set("kube-system", blockedByReason["kube-system"]).
		Set("unready", blockedByReason["unready"]).
		Set("ownerless", blockedByReason["ownerless"])

	catPods := map[string]int{}
	for r, n := range reasonPods {
		catPods[placementReasonCat[r]] += n
	}
	e.mu.Lock()
	placementAutomated := map[string]bool{}
	for k := range e.placementAutomated {
		placementAutomated[k] = true
	}
	e.mu.Unlock()
	catAuto := map[string]int{}
	for _, key := range wlOrder {
		w := wlMap[key]
		if !placementAutomated[w.key] {
			continue
		}
		cats := map[string]bool{}
		for r := range w.reasons {
			cats[placementReasonCat[r]] = true
		}
		for c := range cats {
			catAuto[c]++
		}
	}
	categories := []any{}
	for _, pc := range placementCats {
		categories = append(categories, pyjson.NewObj().
			Set("key", pc.key).
			Set("label", pc.label).
			Set("desc", pc.desc).
			Set("canOptimize", pc.canOptimize).
			Set("pods", catPods[pc.key]).
			Set("automated", catAuto[pc.key]).
			Set("savings", blockedCost*float64(catPods[pc.key])/float64(totalPods)))
	}

	type wlRowP struct {
		obj     *pyjson.Obj
		savings float64
	}
	var wlRows []wlRowP
	automatedWl := 0
	for _, key := range wlOrder {
		w := wlMap[key]
		save := blockedCost * float64(w.pods) / float64(totalPods)
		automated := placementAutomated[w.key]
		if automated {
			automatedWl++
		}
		reasons := sortedKeys(w.reasons)
		chips := []any{}
		for _, r := range reasons {
			chips = append(chips, placementReasonChip[r])
		}
		// labels/annotations from the main workload index (for the
		// Pod Placement labels/annotations filters). byKey is refresh-owned;
		// guard the read like the other engine-state reads in this function.
		var wlLabels, wlAnns *pyjson.Obj
		e.mu.Lock()
		if br := e.byKey[w.key]; br != nil && br.obj != nil {
			wlLabels = getObj(br.obj, "labels").Clone()
			wlAnns = getObj(br.obj, "annotations").Clone()
		}
		e.mu.Unlock()
		if wlLabels == nil {
			wlLabels = pyjson.NewObj()
		}
		if wlAnns == nil {
			wlAnns = pyjson.NewObj()
		}
		wlRows = append(wlRows, wlRowP{pyjson.NewObj().
			Set("key", w.key).
			Set("namespace", w.ns).
			Set("kind", w.kind).
			Set("name", w.name).
			Set("reasons", strList(reasons)).
			Set("reasonChips", chips).
			Set("replicas", w.pods).
			Set("savings", save).
			Set("automated", automated).
			Set("optimized", automated).
			Set("nodes", strList(sortedKeys(w.nodes))).
			Set("labels", wlLabels).
			Set("annotations", wlAnns).
			Set("rolloutEligible", (w.kind == "Deployment" || w.kind == "StatefulSet" || w.kind == "DaemonSet") &&
				!w.reasons["ownerless"] && !w.reasons["unready"]), save})
	}
	sort.SliceStable(wlRows, func(i, j int) bool { return wlRows[i].savings > wlRows[j].savings })
	workloads := []any{}
	for _, r := range wlRows {
		workloads = append(workloads, r.obj)
	}

	type nodeRowP struct {
		obj      *pyjson.Obj
		freeable bool
		savings  float64
	}
	var nodeRows []nodeRowP
	for _, n := range blockedOrder {
		rs := sortedKeys(blocked[n])
		chips := []any{}
		for _, r := range rs {
			chips = append(chips, placementReasonChip[r])
		}
		save := 0.0
		if freedSet[n] {
			save = nodeCost[n]
		}
		nodeRows = append(nodeRows, nodeRowP{pyjson.NewObj().
			Set("node", n).
			Set("savings", save).
			Set("freeable", freedSet[n]).
			Set("pinned", pinned[n]).
			Set("pods", nodeBlockPods[n]).
			Set("reasons", strList(rs)).
			Set("reasonChips", chips), freedSet[n], save})
	}
	sort.SliceStable(nodeRows, func(i, j int) bool {
		if nodeRows[i].freeable != nodeRows[j].freeable {
			return nodeRows[i].freeable
		}
		return nodeRows[i].savings > nodeRows[j].savings
	})
	blockedRows := []any{}
	for _, r := range nodeRows {
		blockedRows = append(blockedRows, r.obj)
	}

	nNodes := len(items(nodes))
	totalNodeCost := 0.0
	for _, c := range nodeCost {
		totalNodeCost += c
	}
	unevictablePods := 0
	for _, n := range reasonPods {
		unevictablePods += n
	}
	wastePct := 0.0
	if len(nodeCost) > 0 && totalNodeCost != 0 {
		wastePct = blockedCost / totalNodeCost * 100.0
	}
	optNodes := nNodes - len(freed)
	if optNodes < 0 {
		optNodes = 0
	}
	totals := pyjson.NewObj().
		Set("monthlyCost", totalNodeCost).
		Set("unevictablePods", unevictablePods).
		Set("unevictableWorkloads", len(wlMap)).
		Set("blockedNodes", len(blocked)).
		Set("automated", automatedWl).
		Set("savings", blockedCost).
		Set("wastePct", ifFloat(len(nodeCost) > 0, wastePct, 0)).
		Set("blockedByReason", byReasonPanel).
		Set("nodes", nNodes).
		Set("freedNodes", len(freed)).
		Set("pinnedNodes", len(pinned)).
		Set("optimizedNodes", optNodes).
		Set("readOnly", e.Cfg.ReadOnly)
	podsByNode := []any{}
	for _, n := range nodeOrder {
		nc := nodePodCats[n]
		podsByNode = append(podsByNode, pyjson.NewObj().
			Set("node", n).
			Set("optimizedBinPacked", nc.binPacked).
			Set("unevictable", nc.unevictable).
			Set("notReady", nc.notReady).
			Set("withoutOwner", nc.withoutOwner))
	}
	return pyjson.NewObj().
		Set("categories", categories).
		Set("workloads", workloads).
		Set("blockedNodes", blockedRows).
		Set("podsByNode", podsByNode).
		Set("totals", totals).
		Set("clusterName", e.Cfg.ClusterName), nil
}

func (e *Engine) packingTargetNode(ctx context.Context) string {
	pd, err := e.placementData(ctx)
	if err != nil {
		return ""
	}
	rows := getList(pd, "blockedNodes")
	best, bestPods := "", int64(-1)
	for _, rv := range rows {
		r := obj(rv)
		if p := i64(r.GetD("pods", int64(0))); p > bestPods {
			bestPods = p
			best = getStr(r, "node")
		}
	}
	return best
}

func (e *Engine) applyPlacement(ctx context.Context, ns, kind, name string) (bool, string) {
	if e.Cfg.ReadOnly {
		return false, "Cluster is in Read-Only mode"
	}
	api, ok := wlAPI[kind]
	if !ok {
		return false, fmt.Sprintf("bin-packing supports Deployment/StatefulSet/DaemonSet (got %s)", kind)
	}
	target := e.packingTargetNode(ctx)
	if target == "" {
		return false, "no blocked node available as a packing target"
	}
	if _, err := e.k8sPatch(ctx, "/api/v1/nodes/"+target, pyjson.NewObj().
		Set("metadata", pyjson.NewObj().
			Set("labels", pyjson.NewObj().Set("coolscaler.sh/node-packing", "true")))); err != nil {
		return false, fmt.Sprintf("could not label packing node %s: %v", target, err)
	}
	patch := pyjson.NewObj().Set("spec", pyjson.NewObj().Set("template", pyjson.NewObj().
		Set("metadata", pyjson.NewObj().
			Set("labels", pyjson.NewObj().Set("coolscaler.sh/managed-unevictable", "true"))).
		Set("spec", pyjson.NewObj().Set("affinity", pyjson.NewObj().
			Set("nodeAffinity", pyjson.NewObj().
				Set("preferredDuringSchedulingIgnoredDuringExecution", []any{
					pyjson.NewObj().
						Set("weight", 100).
						Set("preference", pyjson.NewObj().
							Set("matchExpressions", []any{pyjson.NewObj().
								Set("key", "coolscaler.sh/node-packing").
								Set("operator", "In").
								Set("values", []any{"true"})})),
				}))))))
	if _, err := e.k8sPatch(ctx, fmt.Sprintf(api, ns, name), patch); err != nil {
		return false, err.Error()
	}
	return true, fmt.Sprintf("bin-packed → packing node %s, preferred affinity added (rolling update)", target)
}

// Pod Scheduling — data + relax apply.

func (e *Engine) schedulingPolicyFor(key string) (string, *pyjson.Obj) {
	e.mu.Lock()
	defer e.mu.Unlock()
	name, ok := e.schedulingPolAssign[key]
	if !ok {
		name = "high-availability"
	}
	kb := e.schedulingPolicyKnobs[name]
	if kb == nil {
		kb = e.schedulingPolicyKnobs["high-availability"]
	}
	return name, kb
}

func selfAntiAffinity(template, selLabels *pyjson.Obj) (bool, bool, any) {
	aff := getObj(obj(getObj(getObj(template, "spec"), "affinity")), "podAntiAffinity")
	for _, entry := range []struct {
		required bool
		key      string
	}{{true, "requiredDuringSchedulingIgnoredDuringExecution"},
		{false, "preferredDuringSchedulingIgnoredDuringExecution"}} {
		for _, tv := range getList(aff, entry.key) {
			t := obj(tv)
			term := getObj(t, "podAffinityTerm")
			if !t.Has("podAffinityTerm") {
				term = t
			}
			sel := obj(term.GetD("labelSelector", nil))
			ml := getObj(sel, "matchLabels")
			selfMatch := false
			for _, k := range ml.Keys() {
				if selLabels.GetD(k, nil) == ml.GetD(k, nil) {
					selfMatch = true
					break
				}
			}
			for _, ev := range getList(sel, "matchExpressions") {
				ex := obj(ev)
				if getStr(ex, "operator") == "In" {
					v := selLabels.GetD(getStr(ex, "key"), nil)
					for _, vv := range getList(ex, "values") {
						if v == vv {
							selfMatch = true
						}
					}
				}
			}
			if selfMatch {
				return true, entry.required, term.GetD("topologyKey", "kubernetes.io/hostname")
			}
		}
	}
	return false, false, nil
}

func (e *Engine) schedulingData(ctx context.Context) (*pyjson.Obj, error) {
	nodes, err := e.Kube.GetJSON(ctx, "/api/v1/nodes")
	if err != nil {
		return nil, err
	}
	nodeN := len(items(nodes))
	if nodeN < 1 {
		nodeN = 1
	}
	totalNodeCost := 0.0
	for _, nv := range items(nodes) {
		n := obj(nv)
		st, lbl := getObj(n, "status"), getObj(getObj(n, "metadata"), "labels")
		aCpu := ParseCPU(getObj(st, "allocatable").GetD("cpu", nil))
		aMem := ParseMem(getObj(st, "allocatable").GetD("memory", nil))
		captype := getStr(lbl, "karpenter.sh/capacity-type")
		if captype == "" {
			captype = getStr(lbl, "node.kubernetes.io/capacity-type")
		}
		captype = strings.ToLower(captype)
		itype := getStr(lbl, "node.kubernetes.io/instance-type")
		c, _ := e.nodeMonthlyCost(itype, captype == "spot" || captype == "true", aCpu, aMem, 0)
		totalNodeCost += c
	}
	avgNode := totalNodeCost / float64(nodeN)

	type item struct {
		o    *pyjson.Obj
		kind string
	}
	var wlItems []item
	for _, src := range []struct{ api, kind string }{
		{"/apis/apps/v1/deployments", "Deployment"},
		{"/apis/apps/v1/statefulsets", "StatefulSet"},
	} {
		if resp, err := e.Kube.GetJSON(ctx, src.api); err == nil {
			for _, iv := range items(resp) {
				wlItems = append(wlItems, item{obj(iv), src.kind})
			}
		}
	}
	e.mu.Lock()
	schedAuto := map[string]bool{}
	for k := range e.schedulingAutomated {
		schedAuto[k] = true
	}
	e.mu.Unlock()

	type row struct {
		obj     *pyjson.Obj
		savings float64
	}
	var rows []row
	freedTotal, automatedN := 0, 0
	for _, it := range wlItems {
		md, spec := getObj(it.o, "metadata"), getObj(it.o, "spec")
		sel := getObj(obj(spec.GetD("selector", nil)), "matchLabels")
		has, required, topo := selfAntiAffinity(getObj(spec, "template"), sel)
		if !has {
			continue
		}
		key := wlkey(getStr(md, "namespace"), it.kind, getStr(md, "name"))
		replicas := int(i64(spec.GetD("replicas", int64(1))))
		if replicas == 0 {
			replicas = 1
		}
		polName, kb := e.schedulingPolicyFor(key)
		before := replicas
		spread := int(f64d(kb.GetD("minimumNodesSpread", 1), 1))
		after := replicas
		if spread < after {
			after = spread
		}
		freed := before - after
		if freed < 0 {
			freed = 0
		}
		freedTotal += freed
		savings := float64(freed) * avgNode
		automated := schedAuto[key]
		if automated {
			automatedN++
		}
		rows = append(rows, row{pyjson.NewObj().
			Set("key", key).
			Set("namespace", getStr(md, "namespace")).
			Set("kind", it.kind).
			Set("name", getStr(md, "name")).
			Set("replicas", replicas).
			Set("selfBefore", before).
			Set("selfAfter", after).
			Set("savings", savings).
			Set("policyName", polName).
			Set("automated", automated).
			Set("required", required).
			Set("topologyKey", topo).
			Set("concerns", []any{"Pod anti-affinity"}).
			Set("eligible", it.kind == "Deployment"), savings})
	}
	sort.SliceStable(rows, func(i, j int) bool { return rows[i].savings > rows[j].savings })
	workloads := []any{}
	sumSavings := 0.0
	for _, r := range rows {
		workloads = append(workloads, r.obj)
		sumSavings += r.savings
	}
	blockedNodes := freedTotal
	if nodeN < blockedNodes {
		blockedNodes = nodeN
	}
	wastePct := 0.0
	if totalNodeCost != 0 {
		wastePct = sumSavings / totalNodeCost * 100.0
	}
	optNodes := nodeN - blockedNodes
	if optNodes < 0 {
		optNodes = 0
	}
	totals := pyjson.NewObj().
		Set("monthlyCost", totalNodeCost).
		Set("blockedNodes", blockedNodes).
		Set("savings", sumSavings).
		Set("wastePct", ifFloat(totalNodeCost != 0, wastePct, 0)).
		Set("workloads", len(rows)).
		Set("automated", automatedN).
		Set("nodes", nodeN).
		Set("optimizedNodes", optNodes).
		Set("readOnly", e.Cfg.ReadOnly)
	return pyjson.NewObj().
		Set("workloads", workloads).
		Set("totals", totals).
		Set("clusterName", e.Cfg.ClusterName), nil
}

// schedulingDrawerBlock builds the per-workload Pod Scheduling view for the
// Workload-overview Scheduling tab (docs: Nodes-over-time, self-anti-affinity
// replicas-over-time, timeline). Deployments only. Returns nil when the workload
// has no self anti-affinity to relax — the drawer then keeps the tab disabled.
func (e *Engine) schedulingDrawerBlock(ctx context.Context, ns, kind, name string) any {
	if kind != "Deployment" {
		return nil
	}
	dep, err := e.Kube.GetJSON(ctx, "/apis/apps/v1/namespaces/"+ns+"/deployments/"+name)
	if err != nil {
		return nil
	}
	spec := getObj(dep, "spec")
	tmpl := getObj(spec, "template")
	sel := getObj(obj(spec.GetD("selector", nil)), "matchLabels")
	has, required, topo := selfAntiAffinity(tmpl, sel)
	if !has {
		return nil
	}
	key := wlkey(ns, kind, name)
	replicas := int(i64(spec.GetD("replicas", int64(1))))
	if replicas == 0 {
		replicas = 1
	}
	polName, kb := e.schedulingPolicyFor(key)
	spread := int(f64d(kb.GetD("minimumNodesSpread", 1), 1))
	if spread < 1 {
		spread = 1
	}
	before := replicas
	after := replicas
	if spread < after {
		after = spread
	}
	freed := before - after
	if freed < 0 {
		freed = 0
	}
	// average node cost across the cluster (for the workload's savings).
	nodes, nerr := e.Kube.GetJSON(ctx, "/api/v1/nodes")
	nodeN := 1
	totalNodeCost := 0.0
	if nerr == nil {
		nodeN = len(items(nodes))
		if nodeN < 1 {
			nodeN = 1
		}
		for _, nv := range items(nodes) {
			n := obj(nv)
			st, lbl := getObj(n, "status"), getObj(getObj(n, "metadata"), "labels")
			aCpu := ParseCPU(getObj(st, "allocatable").GetD("cpu", nil))
			aMem := ParseMem(getObj(st, "allocatable").GetD("memory", nil))
			captype := strings.ToLower(getStr(lbl, "karpenter.sh/capacity-type"))
			if captype == "" {
				captype = strings.ToLower(getStr(lbl, "node.kubernetes.io/capacity-type"))
			}
			itype := getStr(lbl, "node.kubernetes.io/instance-type")
			c, _ := e.nodeMonthlyCost(itype, captype == "spot" || captype == "true", aCpu, aMem, 0)
			totalNodeCost += c
		}
	}
	avgNode := totalNodeCost / float64(nodeN)
	savings := float64(freed) * avgNode

	e.mu.Lock()
	automated := e.schedulingAutomated[key]
	e.mu.Unlock()

	// scheduling concerns (docs): self anti-affinity always; add node affinity /
	// node selector / topology spread when the pod template carries them (these
	// are surfaced but NOT relaxed — only self anti-affinity is).
	concerns := []any{"Pod anti-affinity"}
	podSpec := getObj(tmpl, "spec")
	if getObj(obj(getObj(podSpec, "affinity")), "nodeAffinity").Len() > 0 {
		concerns = append(concerns, "Node affinity")
	}
	if getObj(podSpec, "nodeSelector").Len() > 0 {
		concerns = append(concerns, "Node selector")
	}
	if len(getList(podSpec, "topologySpreadConstraints")) > 0 {
		concerns = append(concerns, "Topology spread")
	}

	// flat "over time" trends: no historical scheduling data exists, so project
	// the current state as flat lines. 30 points each.
	flat := func(v int) []any {
		out := make([]any, 30)
		for i := range out {
			out[i] = v
		}
		return out
	}
	return pyjson.NewObj().
		Set("has", true).
		Set("policyName", polName).
		Set("minimumNodesSpread", spread).
		Set("zones", kb.GetD("enhanceAvailabilityOnDifferentZones", false)).
		Set("replicas", replicas).
		Set("selfBefore", before).
		Set("selfAfter", after).
		Set("nodesBefore", before).
		Set("nodesAfter", after).
		Set("savings", savings).
		Set("automated", automated).
		Set("required", required).
		Set("topologyKey", topo).
		Set("concerns", concerns).
		Set("nodesTrend", flat(before)).
		Set("nodesOptTrend", flat(after)).
		Set("selfTrend", flat(before)).
		Set("selfOptTrend", flat(after)).
		Set("timeline", []any{}) // honest: no scheduling events recorded yet
}

func (e *Engine) SchedulingPoliciesData(ctx context.Context) *pyjson.Obj {
	sd, err := e.schedulingData(ctx)
	var sched []any
	if err == nil {
		sched = getList(sd, "workloads")
	}
	total := len(sched)
	used := map[string]int{}
	for _, wv := range sched {
		used[getStr(obj(wv), "policyName")]++
	}
	type cat struct {
		name string
		kb   *pyjson.Obj
		desc string
	}
	var catalog []cat
	for _, d := range schedulingPoliciesBuiltin {
		catalog = append(catalog, cat{d.name, e.schedulingPolicyKnobs[d.name], d.desc})
	}
	e.mu.Lock()
	userNames := make([]string, 0, len(e.schedulingUser))
	for n := range e.schedulingUser {
		userNames = append(userNames, n)
	}
	// map order is close enough for the sorted output below — the list is re-
	// sorted anyway.
	sortStrings(userNames)
	for _, n := range userNames {
		v := e.schedulingUser[n]
		catalog = append(catalog, cat{n, obj(v.GetD("knobs", nil)), str(v.GetD("desc", ""))})
	}
	isUser := map[string]bool{}
	for n := range e.schedulingUser {
		isUser[n] = true
	}
	e.mu.Unlock()
	type prow struct {
		obj    *pyjson.Obj
		usedBy int
		name   string
	}
	var rows []prow
	for _, c := range catalog {
		if c.kb == nil {
			c.kb = pyjson.NewObj()
		}
		rows = append(rows, prow{pyjson.NewObj().
			Set("name", c.name).
			Set("description", c.desc).
			Set("usedBy", used[c.name]).
			Set("total", total).
			Set("minimumNodesSpread", c.kb.GetD("minimumNodesSpread", nil)).
			Set("zones", c.kb.GetD("enhanceAvailabilityOnDifferentZones", false)).
			Set("builtIn", !isUser[c.name]), used[c.name], c.name})
	}
	sort.SliceStable(rows, func(i, j int) bool {
		if rows[i].usedBy != rows[j].usedBy {
			return rows[i].usedBy > rows[j].usedBy
		}
		return rows[i].name < rows[j].name
	})
	out := []any{}
	for _, r := range rows {
		out = append(out, r.obj)
	}
	return pyjson.NewObj().
		Set("policies", out).
		Set("totals", pyjson.NewObj().Set("policies", len(out)).Set("workloads", total))
}

func (e *Engine) applyScheduling(ctx context.Context, ns, kind, name string) (bool, string) {
	if e.Cfg.ReadOnly {
		return false, "Cluster is in Read-Only mode"
	}
	if kind != "Deployment" {
		return false, fmt.Sprintf("Pod Scheduling relaxes Deployments only (got %s)", kind)
	}
	api := wlAPI[kind]
	dep, err := e.Kube.GetJSON(ctx, fmt.Sprintf(api, ns, name))
	if err != nil {
		return false, err.Error()
	}
	spec := getObj(dep, "spec")
	sel := getObj(obj(spec.GetD("selector", nil)), "matchLabels")
	tmpl := getObj(spec, "template")
	aff := getObj(obj(getObj(getObj(tmpl, "spec"), "affinity")), "podAntiAffinity")
	req := getList(aff, "requiredDuringSchedulingIgnoredDuringExecution")
	if len(req) == 0 {
		return false, "no required self anti-affinity to relax"
	}
	_, kb := e.schedulingPolicyFor(wlkey(ns, kind, name))
	pref := getList(aff, "preferredDuringSchedulingIgnoredDuringExecution")
	for _, tv := range req {
		pref = append(pref, pyjson.NewObj().Set("weight", 100).Set("podAffinityTerm", tv))
	}
	newAff := pyjson.NewObj().
		Set("requiredDuringSchedulingIgnoredDuringExecution", nil).
		Set("preferredDuringSchedulingIgnoredDuringExecution", pref)
	replicas := int(i64(spec.GetD("replicas", int64(1))))
	if replicas == 0 {
		replicas = 1
	}
	spread := int(f64d(kb.GetD("minimumNodesSpread", 1), 1))
	if spread < 1 {
		spread = 1
	}
	maxSkew := (replicas + spread - 1) / spread // ceil
	if maxSkew < 1 {
		maxSkew = 1
	}
	tsc := []any{}
	for _, cv := range getList(getObj(tmpl, "spec"), "topologySpreadConstraints") {
		if getStr(obj(cv), "topologyKey") != "kubernetes.io/hostname" {
			tsc = append(tsc, cv)
		}
	}
	tsc = append(tsc, pyjson.NewObj().
		Set("maxSkew", maxSkew).
		Set("topologyKey", "kubernetes.io/hostname").
		Set("whenUnsatisfiable", "ScheduleAnyway").
		Set("labelSelector", pyjson.NewObj().Set("matchLabels", sel)))
	patch := pyjson.NewObj().Set("spec", pyjson.NewObj().Set("template", pyjson.NewObj().
		Set("spec", pyjson.NewObj().
			Set("affinity", pyjson.NewObj().Set("podAntiAffinity", newAff)).
			Set("topologySpreadConstraints", tsc))))
	if _, perr := e.k8sReq(ctx, "PATCH", fmt.Sprintf(api, ns, name), patch, "application/merge-patch+json"); perr != nil {
		return false, perr.Error()
	}
	return true, fmt.Sprintf("relaxed self anti-affinity → preferred, min %d-node spread (maxSkew %d)",
		spread, maxSkew)
}

// Replicas (HPA) policy resolution + apply.

func hpaSchedActive(sched *pyjson.Obj, now time.Time) string {
	t := now.UTC()
	dSun := int(t.Weekday()) % 7
	h := t.Hour()
	for _, rv := range getList(sched, "rules") {
		r := obj(rv)
		hit := false
		for _, dv := range getList(r, "days") {
			if int(i64(dv)) == dSun {
				hit = true
				break
			}
		}
		if !hit {
			continue
		}
		b := hourOf(str(r.GetD("beginTime", "00:00")), 0)
		en := hourOf(str(r.GetD("endTime", "23:59")), 23)
		var on bool
		if en > b {
			on = b <= h && h < en
		} else {
			on = h >= b || h < en
		}
		if on {
			return str(r.GetD("policyName", sched.GetD("defaultPolicy", "production")))
		}
	}
	return str(sched.GetD("defaultPolicy", "production"))
}

// Call with e.mu held? — no: takes the lock itself.
func (e *Engine) hpaAllKnobs() map[string]*pyjson.Obj {
	cat := map[string]*pyjson.Obj{}
	for _, d := range replicasPolicies {
		cat[d.name] = d.kb
	}
	e.mu.Lock()
	for n, kb := range e.hpaPolicyOverrides {
		cat[n] = kb
	}
	e.mu.Unlock()
	return cat
}

func (e *Engine) replicasPolicyFor(key string) (string, *pyjson.Obj) {
	cat := e.hpaAllKnobs()
	e.mu.Lock()
	name, ok := e.replicasPolicyAssign[key]
	if !ok {
		name = "production"
	}
	sched := e.hpaSched[name]
	e.mu.Unlock()
	if sched != nil {
		name = hpaSchedActive(sched, time.Now())
	}
	if _, ok := cat[name]; !ok {
		name = "production"
	}
	return name, cat[name]
}

func (e *Engine) replicaRecommendation(w *wlRow, pol *pyjson.Obj) (int, any, bool, []any) {
	e.mu.Lock()
	hist := append([]replicaPoint(nil), e.replicaHistory[w.key]...)
	e.mu.Unlock()
	var desired []float64
	var desiredInt []int64
	for _, h := range hist {
		desired = append(desired, float64(h.desired))
		desiredInt = append(desiredInt, h.desired)
	}
	if len(desired) == 0 {
		desired = []float64{float64(w.replicas)}
		desiredInt = []int64{int64(w.replicas)}
	}
	origMinF, ok := toFloatLoose(w.obj.GetD("hpaMin", nil))
	if !ok || origMinF == 0 {
		origMinF = 1
	}
	origMin := int(origMinF)
	minD, maxD := desired[0], desired[0]
	for _, d := range desired {
		if d < minD {
			minD = d
		}
		if d > maxD {
			maxD = d
		}
	}
	predictable := (maxD - minD) >= 2
	var recMin int
	if truthy(pol.GetD("keepMin", nil)) {
		recMin = origMin
	} else if truthy(pol.GetD("setMin", nil)) {
		recMin = int(f64d(pol.GetD("setMin", 0), 0))
	} else {
		var grpEnabled bool
		var grpPct float64
		if predictable {
			grpEnabled = truthy(pol.GetD("predEnabled", nil))
			grpPct = f64d(pol.GetD("predPct", 0), 0)
		} else {
			grpEnabled = truthy(pol.GetD("genEnabled", nil))
			grpPct = f64d(pol.GetD("genPct", 0), 0)
		}
		if !grpEnabled {
			recMin = origMin
		} else {
			recMin = pyjson.RoundInt(Percentile(desired, grpPct))
			if recMin < 1 {
				recMin = 1
			}
		}
		if head := f64d(pol.GetD("headroom", 0), 0); head != 0 {
			recMin = int(math.Ceil(float64(recMin) * (1 + head/100.0)))
		}
	}
	if ma := int(f64d(pol.GetD("minAllowed", 0), 0)); recMin < ma {
		recMin = ma
	}
	if truthy(pol.GetD("capByOrigin", nil)) && recMin > origMin {
		recMin = origMin
	}
	if recMin < 1 {
		recMin = 1
	}
	curThr := w.obj.GetD("cpuTarget", nil)
	recThr := curThr
	if truthy(pol.GetD("thresholdEnabled", nil)) && truthy(curThr) {
		sum := 0.0
		for _, d := range desired {
			sum += d
		}
		avgDesired := sum / float64(len(desired))
		if avgDesired <= float64(origMin)*0.7 {
			ct, _ := toFloatLoose(curThr)
			v := int(ct * (1 + f64d(pol.GetD("maxDeviation", 0), 0)/100.0))
			if v > 90 {
				v = 90
			}
			recThr = v
		}
	}
	trend := []any{}
	start := 0
	if len(desiredInt) > 30 {
		start = len(desiredInt) - 30
	}
	for _, d := range desiredInt[start:] {
		trend = append(trend, d)
	}
	return recMin, recThr, predictable, trend
}

func (e *Engine) applyReplicas(ctx context.Context, ns, kind, name string) (bool, string) {
	if e.Cfg.ReadOnly {
		return false, "Cluster is in Read-Only mode"
	}
	e.mu.Lock()
	w := e.byKey[wlkey(ns, kind, name)]
	e.mu.Unlock()
	if w == nil || !w.hpaManaged {
		return false, "not an HPA/KEDA-managed workload"
	}
	_, pol := e.replicasPolicyFor(w.key)
	recMin, recThrAny, _, _ := e.replicaRecommendation(w, pol)
	var notes []string
	hpa := str(w.obj.GetD("hpaName", nil))
	if hpa != "" {
		hpaPath := "/apis/autoscaling/v2/namespaces/" + ns + "/horizontalpodautoscalers/" + hpa
		h, err := e.Kube.GetJSON(ctx, hpaPath)
		if err != nil {
			return false, fmt.Sprintf("HPA patch failed: %v", err)
		}
		specPatch := pyjson.NewObj().Set("minReplicas", recMin)
		recThr, okThr := toFloatLoose(recThrAny)
		curTarget, okCur := toFloatLoose(w.obj.GetD("cpuTarget", nil))
		withMetrics := false
		if okThr && recThr != 0 && okCur && curTarget != 0 && recThr != curTarget {
			metrics := getList(getObj(h, "spec"), "metrics")
			for _, mv := range metrics {
				res := getObj(obj(mv), "resource")
				if getStr(res, "name") == "cpu" && getStr(getObj(res, "target"), "type") == "Utilization" {
					getObj(res, "target").Set("averageUtilization", int(recThr))
				}
			}
			specPatch.Set("metrics", metrics)
			withMetrics = true
		}
		if _, perr := e.k8sPatch(ctx, hpaPath, pyjson.NewObj().Set("spec", specPatch)); perr != nil {
			return false, fmt.Sprintf("HPA patch failed: %v", perr)
		}
		note := fmt.Sprintf("HPA %s minReplicas → %d", hpa, recMin)
		if withMetrics {
			note += fmt.Sprintf(", CPU threshold → %d%%", int(recThr))
		}
		notes = append(notes, note)
	}
	keda := str(w.obj.GetD("kedaName", nil))
	if keda != "" {
		if _, perr := e.k8sReq(ctx, "PATCH",
			"/apis/keda.sh/v1alpha1/namespaces/"+ns+"/scaledobjects/"+keda,
			pyjson.NewObj().Set("spec", pyjson.NewObj().Set("minReplicaCount", recMin)),
			"application/merge-patch+json"); perr != nil {
			return false, fmt.Sprintf("KEDA patch failed: %v", perr)
		}
		notes = append(notes, fmt.Sprintf("KEDA %s minReplicaCount → %d", keda, recMin))
	}
	msg := strings.Join(notes, "; ")
	if msg == "" {
		msg = "no change"
	}
	return true, msg
}

// Java page data.

func (e *Engine) javaNonheapFraction() float64 { return envFloat("JAVA_NONHEAP_FRACTION", 0.25) }
func (e *Engine) javaNonheapMin() float64 {
	return envFloat("JAVA_NONHEAP_MIN_BYTES", 256*(1<<20))
}
func jmxAgentImage() string {
	if v := os.Getenv("JMX_AGENT_IMAGE"); v != "" {
		return v
	}
	return "registry.example.com/coolscaler/coolscaler:latest"
}

func (e *Engine) JavaData(ctx context.Context) (*pyjson.Obj, error) {
	pods, err := e.Kube.GetJSON(ctx, "/api/v1/pods")
	if err != nil {
		return nil, err
	}
	rs, err := e.Kube.GetJSON(ctx, "/apis/apps/v1/replicasets")
	if err != nil {
		rs = pyjson.NewObj().Set("items", []any{})
	}
	rsIndex := buildOwnerIndex(rs)
	e.mu.Lock()
	byKey := map[string]*wlRow{}
	for k, v := range e.byKey {
		byKey[k] = v
	}
	e.mu.Unlock()

	jvm := e.promJVM(ctx)
	type fkey struct{ wk, cname string }
	type finfo struct {
		xmx            int64
		image          string
		ns, kind, name string
		injected       bool
		pods           map[string]bool
	}
	found := map[fkey]*finfo{}
	var order []fkey
	for _, pv := range items(pods) {
		p := obj(pv)
		ns, kind, name := topOwner(p, rsIndex)
		pmeta := getObj(p, "metadata")
		podname := getStr(pmeta, "name")
		injected := str(getObj(pmeta, "annotations").GetD("coolscaler.sh/jmx-injected", nil)) == "true"
		for _, cv := range getList(getObj(p, "spec"), "containers") {
			c := obj(cv)
			isJava, xmx := javaDetect(c)
			if !isJava {
				continue
			}
			fk := fkey{wlkey(ns, kind, name), getStr(c, "name")}
			cur, ok := found[fk]
			if !ok {
				cur = &finfo{xmx: xmx, image: getStr(c, "image"), ns: ns, kind: kind,
					name: name, injected: injected, pods: map[string]bool{}}
				found[fk] = cur
				order = append(order, fk)
			}
			cur.pods[podname] = true
			cur.injected = cur.injected || injected
			if xmx > cur.xmx {
				cur.xmx = xmx
			}
		}
	}
	autoNs := e.loadAutomatedNamespaces(ctx)
	type jrow struct {
		obj     *pyjson.Obj
		savings float64
	}
	var rows []jrow
	totSavings := 0.0
	oomRisk, overProv := 0, 0
	// workload-level KPI accumulators (rows are per container; count each
	// workload once for cost / savings-available totals)
	seenWl := map[string]bool{}
	var costCpuCur, costCpuOrig, costMemCur, costMemOrig, totCost, totRowSavings float64
	for _, fk := range order {
		info := found[fk]
		row := byKey[fk.wk]
		if row == nil {
			continue
		}
		var rc *pyjson.Obj
		for _, cv := range getList(row.obj, "containers") {
			c := obj(cv)
			if getStr(c, "name") == fk.cname {
				rc = c
				break
			}
		}
		if rc == nil {
			continue
		}
		xmxI := info.xmx
		jv := map[string]float64{}
		for pn := range info.pods {
			if d := jvm[ppKey{info.ns, pn}]; d != nil {
				for kf, val := range d {
					if val > jv[kf] {
						jv[kf] = val
					} else if _, ok := jv[kf]; !ok {
						jv[kf] = 0.0
					}
				}
			}
		}
		real := jv["heapP90"] != 0
		heapP90 := jv["heapP90"]
		heapMax := jv["heapMax"]
		nonHeapReal := jv["nonHeapUsed"]
		jvmXmx := jv["heapCeiling"]
		if jvmXmx != 0 && xmxI == 0 {
			xmxI = int64(jvmXmx)
		}
		xmx := float64(xmxI)
		var nonHeap float64
		if real && nonHeapReal != 0 {
			nonHeap = nonHeapReal
		} else if xmx != 0 {
			nonHeap = math.Max(e.javaNonheapMin(), xmx*e.javaNonheapFraction())
		} else {
			nonHeap = e.javaNonheapMin()
		}
		var jvmCeilingOut any = 0
		jvmCeiling := 0.0
		if xmx != 0 {
			jvmCeiling = xmx + nonHeap
			jvmCeilingOut = jvmCeiling
		}
		memReq := f64d(rc.GetD("reqMem", 0), 0)
		memUse := f64d(rc.GetD("useMem", 0), 0)
		memRec := f64d(rc.GetD("recMem", 0), 0)
		javaRealMem := 0.0
		if real {
			javaRealMem = heapP90 + nonHeapReal
		}
		var javaRecMem float64
		var recXmx any
		if real {
			jm, jx, _ := e.javaMemFromJVM(jv, 0)
			javaRecMem, recXmx = jm, jx
		} else {
			if jvmCeiling != 0 {
				javaRecMem = math.Max(memRec, jvmCeiling)
			} else {
				javaRecMem = memRec
			}
			if memUse != 0 {
				if f := (memUse - nonHeap) * 1.10; f > 64*(1<<20) {
					recXmx = f
				} else {
					recXmx = 64 * (1 << 20) // int
				}
			} else {
				recXmx = xmxI
			}
		}
		var status string
		switch {
		case xmx != 0 && memReq != 0 && memReq < jvmCeiling:
			status = "oom-risk"
			oomRisk++
		case real && javaRealMem != 0 && memReq > javaRealMem*1.5:
			status = "over-provisioned"
			overProv++
		case !real && memUse != 0 && memReq > math.Max(jvmCeiling, memUse)*1.5:
			status = "over-provisioned"
			overProv++
		default:
			status = "ok"
		}
		replicas := row.replicas
		savings := math.Max((memReq-javaRecMem)/(1<<30)*e.costMemGBMonth*float64(replicas), 0.0)
		totSavings += savings
		// workload-level KPI totals (orig -> current cost split by CPU/Mem)
		if !seenWl[fk.wk] {
			seenWl[fk.wk] = true
			reps := float64(replicas)
			wReqCpu := f64d(row.obj.GetD("reqCpu", 0), 0)
			wReqMem := f64d(row.obj.GetD("reqMem", 0), 0)
			wOrigCpu := f64d(row.obj.GetD("origCpu", wReqCpu), wReqCpu)
			wOrigMem := f64d(row.obj.GetD("origMem", wReqMem), wReqMem)
			costCpuCur += wReqCpu * reps * e.costCPUCoreMonth
			costCpuOrig += wOrigCpu * reps * e.costCPUCoreMonth
			costMemCur += wReqMem / (1 << 30) * reps * e.costMemGBMonth
			costMemOrig += wOrigMem / (1 << 30) * reps * e.costMemGBMonth
			totCost += f64d(row.obj.GetD("monthlyCost", 0.0), 0)
			totRowSavings += math.Max(0.0, f64d(row.obj.GetD("savings", 0.0), 0))
		}
		e.mu.Lock()
		heal := e.javaHealing[fk.wk]
		e.mu.Unlock()
		healFatal := heal != nil && truthy(heal.GetD("fatal", nil))
		healReason := ""
		if healFatal {
			healReason = str(heal.GetD("reason", ""))
		}
		jvmXmxOut := any(int(xmxI))
		if jvmXmx != 0 {
			jvmXmxOut = int(jvmXmx)
		}
		rows = append(rows, jrow{pyjson.NewObj().
			Set("namespace", info.ns).
			Set("kind", info.kind).
			Set("name", info.name).
			Set("container", fk.cname).
			Set("image", info.image).
			Set("replicas", replicas).
			Set("xmx", int(xmxI)).
			Set("nonHeapReserve", nonHeap).
			Set("jvmCeiling", jvmCeilingOut).
			Set("memRequest", memReq).
			Set("memUsage", memUse).
			Set("memRec", javaRecMem).
			Set("recommendedXmx", recXmx).
			Set("status", status).
			Set("savings", savings).
			Set("savingsAvailable", math.Max(0.0, f64d(row.obj.GetD("savings", 0.0), 0))).
			Set("cpuRequest", f64d(row.obj.GetD("reqCpu", 0), 0)).
			Set("memoryRequest", f64d(row.obj.GetD("reqMem", 0), 0)).
			Set("replicasRunning", len(info.pods)).
			Set("replicasDesired", replicas).
			Set("automated", truthy(row.obj.GetD("automated", nil))).
			Set("observability", info.injected).
			Set("policyName", str(row.obj.GetD("policyName", "java"))).
			Set("javaAuto", e.javaAutoFor(ctx, info.ns, info.kind, info.name, nil, autoNs)).
			Set("obsExcluded", str(getObj(row.obj, "annotations").GetD("coolscaler.sh/jmx-injection-disabled", nil)) == "true").
			Set("injectionFatal", healFatal).
			Set("injectionGap", healReason).
			Set("realUsage", real).
			Set("javaRealMem", javaRealMem).
			Set("heapUsedP90", heapP90).
			Set("heapUsedMax", heapMax).
			Set("nonHeapUsed", nonHeapReal).
			Set("heapCommitted", jv["heapCommitted"]).
			Set("jvmXmx", jvmXmxOut).
			Set("gcSecondsRate", jv["gcSecondsRate"]).
			Set("hpaManaged", row.hpaManaged), savings})
	}
	sort.SliceStable(rows, func(i, j int) bool { return rows[i].savings > rows[j].savings })
	out := []any{}
	withXmx, automated, gaps, observ, realObs := 0, 0, 0, 0, 0
	for _, r := range rows {
		out = append(out, r.obj)
		if truthy(r.obj.GetD("xmx", nil)) {
			withXmx++
		}
		if truthy(r.obj.GetD("javaAuto", nil)) {
			automated++
		}
		if truthy(r.obj.GetD("injectionFatal", nil)) {
			gaps++
		}
		if truthy(r.obj.GetD("observability", nil)) {
			observ++
		}
		if truthy(r.obj.GetD("realUsage", nil)) {
			realObs++
		}
	}
	wastedSpendPct := 0.0
	if totCost != 0 {
		wastedSpendPct = totSavings / totCost * 100.0
	}
	totals := pyjson.NewObj().
		Set("javaWorkloads", len(rows)).
		Set("oomRisk", oomRisk).
		Set("overProvisioned", overProv).
		Set("savings", totSavings).
		Set("savingsAvailable", totRowSavings).
		Set("monthlyCost", totCost).
		Set("costCpuOriginal", costCpuOrig).
		Set("costCpuCurrent", costCpuCur).
		Set("costMemOriginal", costMemOrig).
		Set("costMemCurrent", costMemCur).
		Set("wastedSpendPct", wastedSpendPct).
		Set("unautomated", len(rows)-automated).
		Set("withXmx", withXmx).
		Set("automated", automated).
		Set("injectionGaps", gaps).
		Set("observability", observ).
		Set("realObservability", realObs).
		Set("enabled", e.javaEnabled()).
		Set("jmxAgentImage", jmxAgentImage()).
		Set("observabilityEnabled", e.javaObservabilityOn(ctx)).
		Set("optimizeEnabled", e.javaOptimizeOn(ctx)).
		Set("readOnly", e.Cfg.ReadOnly)
	return pyjson.NewObj().
		Set("workloads", out).
		Set("totals", totals).
		Set("clusterName", e.Cfg.ClusterName), nil
}
