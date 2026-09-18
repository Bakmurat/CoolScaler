package engine

// settingsx.go

import (
	"context"
	"sort"

	"coolscaler.sh/coolscaler/internal/pyjson"
)

// ClusterSettingsData is GET /api/settings/cluster-settings
func (e *Engine) ClusterSettingsData(ctx context.Context) *pyjson.Obj {
	e.mu.Lock()
	ga := e.globalAuto
	dsOff := truthy(ga.GetD("disableDaemonSetRightsizing", false))
	hpaThr := truthy(ga.GetD("globalHpaThresholdOptimizationEnabled", false))
	exTypes := ga.GetD("excludedWorkloadTypes", []any{})
	waCfg := getObj(ga, "workloadAutomation")
	exLabels := waCfg.GetD("excludeLabels", []any{})
	exAnns := waCfg.GetD("excludeAnnotations", []any{})
	e.mu.Unlock()
	jvmOn := e.javaObservabilityOn(ctx)
	return pyjson.NewObj().
		Set("isDaemonsetRightsizingDisabled", dsOff).
		Set("excludedWorkloadTypesStatic", []any{}).
		Set("excludedWorkloadTypesMutable", exTypes).
		Set("excludedWorkloadLabelsStatic", nil).
		Set("excludedWorkloadLabelsMutable", exLabels).
		Set("excludedWorkloadAnnotationsMutable", exAnns).
		Set("globalJvmRightsizingEnabled", jvmOn).
		Set("globalJvmRightsizingRollout", jvmOn).
		Set("globalHpaThresholdOptimizationEnabled", hpaThr)
}

// ClusterSettingsSave is PUT /api/settings/cluster-settings
func (e *Engine) ClusterSettingsSave(ctx context.Context, body *pyjson.Obj) *pyjson.Obj {
	fwd := pyjson.NewObj()
	if v, ok := body.Get("isDaemonsetRightsizingDisabled"); ok {
		fwd.Set("disableDaemonSetRightsizing", truthy(v))
	}
	if v, ok := body.Get("globalHpaThresholdOptimizationEnabled"); ok {
		fwd.Set("globalHpaThresholdOptimizationEnabled", truthy(v))
	}
	if v, ok := body.Get("excludedWorkloadTypesMutable"); ok {
		fwd.Set("excludedWorkloadTypes", v)
	}
	wa := pyjson.NewObj()
	if v, ok := body.Get("excludedWorkloadLabelsMutable"); ok {
		wa.Set("excludeLabels", v)
	}
	if v, ok := body.Get("excludedWorkloadAnnotationsMutable"); ok {
		wa.Set("excludeAnnotations", v)
	}
	if wa.Len() > 0 {
		fwd.Set("workloadAutomation", wa)
	}
	if fwd.Len() > 0 {
		e.PostAutomationConfig(ctx, fwd)
	}
	return e.ClusterSettingsData(ctx)
}

// UserIgnoredNamespacesData is GET /api/settings/user-ignored-namespaces.
func (e *Engine) UserIgnoredNamespacesData() *pyjson.Obj {
	e.mu.Lock()
	user := e.globalAuto.GetD("excludedNamespaces", []any{})
	e.mu.Unlock()
	return pyjson.NewObj().
		Set("namespaces", user).
		Set("staticNamespaces", strList(staticIgnoredNamespaces))
}

// UserIgnoredNamespacesSave is PUT /api/settings/user-ignored-namespaces —
// writes through the SAME automation-config contract.
func (e *Engine) UserIgnoredNamespacesSave(ctx context.Context, body *pyjson.Obj) *pyjson.Obj {
	if v, ok := body.Get("namespaces"); ok {
		e.PostAutomationConfig(ctx, pyjson.NewObj().Set("excludedNamespaces", v))
	}
	return e.UserIgnoredNamespacesData()
}

// AdmissionSettingsData is GET /api/admission/settings
func (e *Engine) AdmissionSettingsData(ctx context.Context) *pyjson.Obj {
	e.mu.Lock()
	ga := e.globalAuto
	out := pyjson.NewObj().
		Set("binPackOwnerlessPods", truthy(ga.GetD("binPackOwnerless", false))).
		Set("binPackUnevictablePods", truthy(ga.GetD("binPackUnevictable", false))).
		Set("binPackUnHealthyPods", truthy(ga.GetD("binPackUnhealthyPods", false))).
		Set("binPackKubeSystemPods", truthy(ga.GetD("binPackKubeSystem", false))).
		Set("binPackLocalStoragePods", truthy(ga.GetD("binPackLocalStoragePods", false))).
		Set("excludedWorkloadTypes", ga.GetD("excludedWorkloadTypes", []any{})).
		Set("excludedWorkloadLabels", nil).
		Set("excludedWorkloadAnnotations", nil)
	e.mu.Unlock()
	jvmOn := e.javaObservabilityOn(ctx)
	return out.
		Set("globalJvmRightsizingEnabled", jvmOn).
		Set("globalJvmRightsizingRollout", jvmOn)
}

// AdmissionSettingsSave is POST /api/admission/settings.
func (e *Engine) AdmissionSettingsSave(ctx context.Context, body *pyjson.Obj) *pyjson.Obj {
	fwd := pyjson.NewObj()
	for bodyKey, gaKey := range map[string]string{
		"binPackOwnerlessPods":    "binPackOwnerless",
		"binPackUnevictablePods":  "binPackUnevictable",
		"binPackKubeSystemPods":   "binPackKubeSystem",
		"binPackUnHealthyPods":    "binPackUnhealthyPods",
		"binPackLocalStoragePods": "binPackLocalStoragePods",
	} {
		if v, ok := body.Get(bodyKey); ok {
			fwd.Set(gaKey, truthy(v))
		}
	}
	if fwd.Len() > 0 {
		e.PostAutomationConfig(ctx, fwd)
	}
	return e.AdmissionSettingsData(ctx)
}

// ResourceQuotaExists is GET /api/analytics/resourcequota/exists.
func (e *Engine) ResourceQuotaExists(ctx context.Context) *pyjson.Obj {
	rows := e.promQuery(ctx, `count(kube_resourcequota)`)
	exists := len(rows) > 0 && rows[0].Value > 0
	return pyjson.NewObj().
		Set("exists", exists).
		Set("clusters", []any{e.Cfg.ClusterName})
}

// NodeOptimizationGraph is GET /api/nodeOptimization/graph
func (e *Engine) NodeOptimizationGraph(rng string) *pyjson.Obj {
	g := e.AnalyticsGraph(rng, "hour", []string{
		"cpuRequests", "cpuRequestsOrigin", "cpuRecommendation", "cpuAllocatable", "cpuUsageTotal",
		"memoryRequests", "memoryRequestsOrigin", "memoryRecommendation", "memoryAllocatable", "memoryUsageTotal",
	})
	out := []any{}
	for _, pv := range getList(g, "values") {
		p := obj(pv)
		v := getObj(p, "values")
		mk := func(prefix string) *pyjson.Obj {
			return pyjson.NewObj().
				Set("request", v.GetD(prefix+"Requests", nil)).
				Set("requestOrigin", v.GetD(prefix+"RequestsOrigin", nil)).
				Set("recommended", v.GetD(prefix+"Recommendation", nil)).
				Set("allocatable", v.GetD(prefix+"Allocatable", nil)).
				Set("usage", v.GetD(prefix+"UsageTotal", nil))
		}
		out = append(out, pyjson.NewObj().
			Set("timestamp", p.GetD("timestamp", nil)).
			Set("cpu", mk("cpu")).
			Set("memory", mk("memory")))
	}
	return pyjson.NewObj().Set("values", out)
}

// DashboardTimeseries is POST /api/dashboard/timeseries
func (e *Engine) DashboardTimeseries() *pyjson.Obj {
	e.mu.Lock()
	ov := e.overview
	e.mu.Unlock()
	if ov == nil {
		return pyjson.NewObj()
	}
	avail := f64d(ov.GetD("availableSavings", 0.0), 0)
	active := f64d(ov.GetD("activeSavings", 0.0), 0)
	cur := f64d(ov.GetD("totalWorkloadCostMonthly", ov.GetD("monthlyCost", 0.0)), 0)
	return pyjson.NewObj().
		Set("availableSavings", pyjson.Round(avail, 2)).
		Set("activeSavings", pyjson.Round(active, 2)).
		Set("currentCost", pyjson.Round(cur, 2)).
		Set("potentialCost", pyjson.Round(cur-avail, 2)).
		Set("unAllocatedCost", nil)
}

// ClusterActionsMultiCluster is GET /api/cluster-actions/multi-cluster
func (e *Engine) ClusterActionsMultiCluster() *pyjson.Obj {
	type cand struct {
		ns, kind, name string
		savings        float64
	}
	e.mu.Lock()
	var cands []cand
	for _, w := range e.workloads {
		if w.kind == "Node" || !w.sizable {
			continue
		}
		if s := f64d(w.obj.GetD("savings", 0.0), 0); s > 0.5 {
			cands = append(cands, cand{w.namespace, w.kind, w.name, s})
		}
	}
	e.mu.Unlock()
	sort.SliceStable(cands, func(i, j int) bool { return cands[i].savings > cands[j].savings })
	if len(cands) > 5 {
		cands = cands[:5]
	}
	actions := []any{}
	for _, c := range cands {
		actions = append(actions, pyjson.NewObj().
			Set("actionType", "RolloutWorkloads").
			Set("category", "rightsizing").
			Set("clusterName", e.Cfg.ClusterName).
			Set("route", "/rightSizing/workloads").
			Set("queryParams", "availableSavingsFilter=Positive").
			Set("metrics", pyjson.NewObj().
				Set("savingsAvailable", pyjson.Round(c.savings, 2))).
			Set("title", "Rightsize "+c.ns+"/"+c.name).
			Set("workload", pyjson.NewObj().
				Set("namespace", c.ns).Set("workloadType", c.kind).Set("workloadName", c.name)))
	}
	return pyjson.NewObj().Set("actions", actions)
}
