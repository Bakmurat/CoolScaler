package engine

import (
	"context"
	"regexp"
	"strings"
	"time"

	"coolscaler.sh/coolscaler/internal/pyjson"
)

// "openshift.*") are anchored regexes, plain entries match exactly.
var staticIgnoredNamespaces = []string{
	"kube-system", "kube-public", "kube-node-lease",
	"openshift.*", "trident", "cluster-autoscaler",
}

func staticIgnoredNamespacesList() []any {
	out := make([]any, 0, len(staticIgnoredNamespaces))
	for _, s := range staticIgnoredNamespaces {
		out = append(out, s)
	}
	return out
}

func defaultGlobalAuto() *pyjson.Obj {
	return pyjson.NewObj().
		Set("automateAllNamespaces", false).
		Set("excludedWorkloadTypes", []any{}).
		Set("excludedNamespaces", staticIgnoredNamespacesList()).
		Set("excludedNamespacesRegex", "").
		Set("binPackKubeSystem", false).
		Set("binPackOwnerless", false).
		Set("binPackUnevictable", true).
		// Defaults chosen to match current CoolScaler behavior
		Set("binPackLocalStoragePods", false).
		Set("binPackUnhealthyPods", false).
		Set("binPackRelaxedAntiAffinity", false).
		Set("disableDaemonSetRightsizing", false).
		Set("globalHpaThresholdOptimizationEnabled", false).
		Set("globalJvmRightsizingEnabled", true).
		Set("globalUpgradeJavaWorkloadsSmartPolicy", false).
		Set("scheduleBlockersEnhancedZoneDistribution", false).
		Set("scheduleBlockersMinNodes", int64(0)).
		Set("scheduleBlockersExcludedWorkloads", []any{}).
		Set("automate", pyjson.NewObj().
			Set("rightsize", false).
			Set("replicas", false).
			Set("podPlacement", false).
			Set("podScheduling", false).
			Set("spot", false).
			Set("java", false).
			Set("gpu", false)).
		// Workload Operations: label/annotation automation matching
		// ("key=value" entries; value may be a regex for excludes).
		Set("workloadAutomation", pyjson.NewObj().
			Set("excludeLabels", []any{}).
			Set("includeLabels", []any{}).
			Set("excludeAnnotations", []any{}).
			Set("includeAnnotations", []any{})).
		Set("allowedInstanceTypes", []any{}).
		Set("blockedInstanceTypes", []any{})
}

func (e *Engine) loadAutomationCM(ctx context.Context) {
	cm, err := e.Kube.GetJSON(ctx, "/api/v1/namespaces/"+e.Cfg.Namespace+"/configmaps/coolscaler-automation-config")
	if err != nil {
		return
	}
	raw := getStr(getObj(cm, "data"), "config.json")
	if raw == "" {
		raw = "{}"
	}
	v, err := pyjson.Decode([]byte(raw))
	if err != nil {
		return
	}
	if data, ok := v.(*pyjson.Obj); ok && data.Len() > 0 {
		e.mu.Lock()
		e.globalAuto.Update(data)
		e.mu.Unlock()
		e.Log.Info("loaded automation-config from ConfigMap")
	}
}

// nsEntryMatches reports whether an ignored-namespaces entry matches ns:
// exact string match, or — for pattern entries like "openshift.*" — an
// anchored regex match.
func nsEntryMatches(entry, ns string) bool {
	if entry == ns {
		return true
	}
	if strings.ContainsAny(entry, "*?[](){}|^$+\\") {
		if re, err := regexp.Compile("^(?:" + entry + ")$"); err == nil && re.MatchString(ns) {
			return true
		}
	}
	return false
}

func (e *Engine) autoExcluded(ns, kind string) bool {
	ga := e.globalAuto
	for _, v := range getList(ga, "excludedWorkloadTypes") {
		if str(v) == kind {
			return true
		}
	}
	for _, v := range getList(ga, "excludedNamespaces") {
		if nsEntryMatches(str(v), ns) {
			return true
		}
	}
	rgx := getStr(ga, "excludedNamespacesRegex")
	if rgx != "" {
		if re, err := regexp.Compile(rgx); err == nil && re.MatchString(ns) {
			return true
		}
	}
	return false
}

// loadIgnoredNamespaceCMs merges the static/user ignored-namespaces CM split
// into GLOBAL_AUTO.excludedNamespaces: the Helm-managed coolscaler-static-
// ignored-namespaces list plus the app-owned coolscaler-user-ignored-
// namespaces list.
func (e *Engine) loadIgnoredNamespaceCMs(ctx context.Context) {
	base := "/api/v1/namespaces/" + e.Cfg.Namespace + "/configmaps/"
	readList := func(name string) ([]any, bool) {
		cm, err := e.Kube.GetJSON(ctx, base+name)
		if err != nil {
			return nil, false
		}
		raw := strings.TrimSpace(getStr(getObj(cm, "data"), "namespaces"))
		if raw == "" {
			return []any{}, true
		}
		v, derr := pyjson.Decode([]byte(raw))
		if derr != nil {
			return []any{}, true
		}
		l, _ := v.([]any)
		return l, true
	}
	static, okStatic := readList("coolscaler-static-ignored-namespaces")
	if !okStatic {
		static = staticIgnoredNamespacesList()
	}
	user, okUser := readList("coolscaler-user-ignored-namespaces")
	if !okUser && e.Cfg.WriteRecommendationCRs {
		// first run: seed the empty user CM.
		cm := pyjson.NewObj().
			Set("apiVersion", "v1").
			Set("kind", "ConfigMap").
			Set("metadata", pyjson.NewObj().
				Set("name", "coolscaler-user-ignored-namespaces").
				Set("namespace", e.Cfg.Namespace).
				Set("annotations", pyjson.NewObj().
					Set("coolscaler.sh/post-static-install", "true"))).
			Set("data", pyjson.NewObj().
				Set("lastUpdateTime", time.Now().UTC().Format("02 Jan 06 15:04 MST")).
				Set("namespaces", "[]"))
		if _, perr := e.k8sReq(ctx, "POST", "/api/v1/namespaces/"+e.Cfg.Namespace+"/configmaps", cm, "application/json"); perr != nil {
			e.Log.Info("create user-ignored-namespaces CM failed", "err", perr)
		}
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	cur := getList(e.globalAuto, "excludedNamespaces")
	// overrideUserKubeSystemIgnoredNamespace: kube-system is force-ignored via
	// the static list; when the override is set, drop it from static so it is
	// only ignored if the user/current list names it explicitly (docs).
	userCurHasKubeSystem := false
	for _, lists := range [][]any{user, cur} {
		for _, v := range lists {
			if str(v) == "kube-system" {
				userCurHasKubeSystem = true
			}
		}
	}
	seen := map[string]bool{}
	merged := []any{}
	for li, lists := range [][]any{static, user, cur} {
		for _, v := range lists {
			s := str(v)
			if s == "" || seen[s] {
				continue
			}
			if li == 0 && s == "kube-system" && e.overrideKubeSystemIgnored && !userCurHasKubeSystem {
				continue // drop the forced static kube-system entry
			}
			seen[s] = true
			merged = append(merged, s)
		}
	}
	e.globalAuto.Set("excludedNamespaces", merged)
}

// saveUserIgnoredNamespacesCM persists the user half of the ignored-namespace
// split: every excludedNamespaces entry that is not in the static list.
// Called after automation-config saves (write-gated by k8sReq).
func (e *Engine) saveUserIgnoredNamespacesCM(ctx context.Context) {
	if !e.Cfg.WriteRecommendationCRs {
		return
	}
	staticSet := map[string]bool{}
	for _, s := range staticIgnoredNamespaces {
		staticSet[s] = true
	}
	e.mu.Lock()
	user := []any{}
	for _, v := range getList(e.globalAuto, "excludedNamespaces") {
		if s := str(v); s != "" && !staticSet[s] {
			user = append(user, s)
		}
	}
	e.mu.Unlock()
	data := pyjson.NewObj().
		Set("lastUpdateTime", time.Now().UTC().Format("02 Jan 06 15:04 MST")).
		Set("namespaces", string(pyjson.Marshal(user)))
	path := "/api/v1/namespaces/" + e.Cfg.Namespace + "/configmaps/coolscaler-user-ignored-namespaces"
	if _, err := e.k8sPatch(ctx, path, pyjson.NewObj().Set("data", data)); err != nil {
		if _, ok := isHTTPError(err); ok {
			cm := pyjson.NewObj().
				Set("apiVersion", "v1").
				Set("kind", "ConfigMap").
				Set("metadata", pyjson.NewObj().
					Set("name", "coolscaler-user-ignored-namespaces").
					Set("namespace", e.Cfg.Namespace).
					Set("annotations", pyjson.NewObj().
						Set("coolscaler.sh/post-static-install", "true"))).
				Set("data", data)
			_, _ = e.k8sReq(ctx, "POST", "/api/v1/namespaces/"+e.Cfg.Namespace+"/configmaps", cm, "application/json")
		}
	}
}

type autoNS struct {
	optimize           bool // rightsizeOptimize (or legacy `optimize`)
	policy             any  // defaultRightsizePolicy (or legacy `defaultPolicy`)
	replicasOptimize   bool
	replicasPolicy     any
	placementOptimize  bool
	schedulingOptimize bool
	javaOptimize       bool
	downscaler         bool
	excludeAutomation  bool // namespace-wide exclude across all products
}

// The optimize/ defaultPolicy legacy fields apply only to Workload Rightsizing
// (per the docs' backward-compat note).
func (e *Engine) loadAutomatedNamespaces(ctx context.Context) map[string]autoNS {
	out := map[string]autoNS{}
	resp, err := e.Kube.GetJSON(ctx, crdBase("automatednamespaces", ""))
	if err != nil {
		return out
	}
	firstOf := func(spec *pyjson.Obj, keys ...string) any {
		for _, k := range keys {
			if v, ok := spec.Get(k); ok {
				return v
			}
		}
		return nil
	}
	for _, it := range items(resp) {
		o := obj(it)
		spec := getObj(o, "spec")
		ns := getStr(getObj(o, "metadata"), "name")
		out[ns] = autoNS{
			optimize:           truthy(firstOf(spec, "rightsizeOptimize", "optimize")),
			policy:             firstOf(spec, "defaultRightsizePolicy", "defaultPolicy"),
			replicasOptimize:   truthy(firstOf(spec, "replicasOptimize", "scaleOutOptimize")),
			replicasPolicy:     spec.GetD("defaultReplicasPolicy", nil),
			placementOptimize:  truthy(spec.GetD("podPlacementOptimize", nil)),
			schedulingOptimize: truthy(spec.GetD("podSchedulingOptimize", nil)),
			javaOptimize:       truthy(spec.GetD("javaOptimize", nil)),
			downscaler:         truthy(spec.GetD("downscalerOptimize", nil)),
			excludeAutomation:  truthy(spec.GetD("excludeAutomation", nil)),
		}
	}
	return out
}

// Without this, every recommender restart silently un-automated the cluster
// (the long-standing in-memory-only bug fixed in v0.60.1).
func (e *Engine) loadAutomationStateFromRecs(ctx context.Context) {
	resp, err := e.Kube.GetJSON(ctx, crdBase("recommendations", ""))
	if err != nil {
		return
	}
	srcMap := map[string]string{"UI": "user", "UI-Cluster": "cluster", "ANS-Namespace": "namespace"}
	n := 0
	for _, it := range items(resp) {
		o := obj(it)
		spec := getObj(o, "spec")
		tr := getObj(spec, "targetRef")
		ns := getStr(tr, "namespace")
		if ns == "" {
			ns = getStr(getObj(o, "metadata"), "namespace")
		}
		kind, name := getStr(tr, "kind"), getStr(tr, "name")
		if ns == "" || kind == "" || name == "" {
			continue
		}
		// daemonsetnodesize split CRs map back to their DaemonSet key.
		if kind == "daemonsetnodesize" {
			if dsn := dsNameFromNodeSizeRef(name); dsn != "" {
				kind, name = "DaemonSet", dsn
			}
		}
		key := wlkey(ns, kind, name)
		e.mu.Lock()
		if truthy(spec.GetD("automationExcluded", nil)) {
			e.excluded[key] = true
		} else if truthy(spec.GetD("rightSizeOptimize", nil)) || truthy(spec.GetD("optimize", nil)) {
			e.automated[key] = true
			ab := getStr(getObj(spec, "Automation"), "automatedBy")
			if src, ok := srcMap[ab]; ok {
				e.automationSource[key] = src
			} else {
				e.automationSource[key] = "user"
			}
			n++
		}
		if truthy(spec.GetD("replicasOptimize", nil)) || truthy(spec.GetD("scaleOutOptimize", nil)) {
			e.replicasAutomated[key] = true
		}
		if truthy(spec.GetD("podPlacementOptimize", nil)) {
			e.placementAutomated[key] = true
		}
		if truthy(spec.GetD("podSchedulingOptimize", nil)) {
			e.schedulingAutomated[key] = true
		}
		e.mu.Unlock()
	}
	if n > 0 {
		e.Log.Info("restored automation state from Recommendation CRs", "workloads", n)
	}
}

// loadOriginFromRecs re-seeds ORIGIN_REQ from the Recommendation CRs'
// preserved originRequests.
func (e *Engine) loadOriginFromRecs(ctx context.Context) {
	resp, err := e.Kube.GetJSON(ctx, crdBase("recommendations", ""))
	if err != nil {
		return
	}
	for _, it := range items(resp) {
		o := obj(it)
		spec := getObj(o, "spec")
		tr := getObj(spec, "targetRef")
		ns := getStr(tr, "namespace")
		if ns == "" {
			ns = getStr(getObj(o, "metadata"), "namespace")
		}
		kind, name := getStr(tr, "kind"), getStr(tr, "name")
		if ns == "" || kind == "" || name == "" {
			continue
		}
		if kind == "daemonsetnodesize" {
			if dsn := dsNameFromNodeSizeRef(name); dsn != "" {
				kind, name = "DaemonSet", dsn
			}
		}
		containers := getList(getObj(getObj(o, "status"), "rightSize"), "containers")
		if len(containers) == 0 {
			continue
		}
		var cpu, mem float64
		for _, cv := range containers {
			c := obj(cv)
			po := getObj(c, "originRequestsResources")
			if po.Len() == 0 {
				po = getObj(c, "originRequests")
			}
			cpu += ParseCPU(po.GetD("cpu", nil))
			mem += ParseMem(po.GetD("memory", nil))
		}
		e.mu.Lock()
		e.originReq[wlkey(ns, kind, name)] = &origReq{cpu: cpu, mem: mem}
		e.mu.Unlock()
	}
}
