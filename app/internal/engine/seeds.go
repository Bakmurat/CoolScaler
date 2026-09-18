package engine

import (
	"context"
	"regexp"
	"strings"

	"coolscaler.sh/coolscaler/internal/pyjson"
)

// Built-in Policy catalog + ensure loops. Every literal dict is reproduced
// with the same key insertion order.

var strategyEnum = map[string]string{
	"Ongoing": "Ongoing", "Upon pod creation": "OnCreate", "Disabled": "Disabled",
}

type polSpecArgs struct {
	cpuPct, cpuHead, memPct, memHead int
	window                           string
	cpuMin, memMin, cpuMax, memMax   string
	strategy                         string
	inPlace, autoHeal, burst         bool
	bootTime, initOpt                bool
	limitStrategy                    string
	coverage                         int
	ephEnabled                       bool
	ephWindow                        string
	ephReduce, skipRollout           bool
	memKeepRequest                   bool
	histo                            *pyjson.Obj
}

func newPolSpecArgs(cpuPct, cpuHead, memPct, memHead int, window string) polSpecArgs {
	return polSpecArgs{
		cpuPct: cpuPct, cpuHead: cpuHead, memPct: memPct, memHead: memHead,
		window: window, strategy: "Ongoing", inPlace: true, autoHeal: true,
		burst: true, bootTime: true, initOpt: true, limitStrategy: "keepOriginal",
		coverage: 2, ephEnabled: true,
	}
}

func (e *Engine) policySpec(a polSpecArgs) *pyjson.Obj {
	cfg := e.Cfg
	ephWindow := a.ephWindow
	if ephWindow == "" {
		ephWindow = cfg.EphWindow
	}
	cpuMin := a.cpuMin
	if cpuMin == "" {
		cpuMin = FmtCPU(cfg.CPUFloorCores)
	}
	memMin := a.memMin
	if memMin == "" {
		memMin = FmtMem(cfg.MemFloorBytes)
	}
	cpuRC := pyjson.NewObj().
		Set("percentilePercentage", a.cpuPct).
		Set("headroomPercentage", a.cpuHead).
		Set("minAllowed", cpuMin)
	memRC := pyjson.NewObj().
		Set("percentilePercentage", a.memPct).
		Set("headroomPercentage", a.memHead).
		Set("minAllowed", memMin)
	if a.cpuMax != "" {
		cpuRC.Set("maxAllowed", a.cpuMax)
	}
	if a.memMax != "" {
		memRC.Set("maxAllowed", a.memMax)
	}
	if a.memKeepRequest {
		memRC.Set("keepRequest", true)
	}
	onCreate := strategyEnumOr(a.strategy) != "Ongoing"
	ubtm := pyjson.NewObj().
		Set("argoRollout", "OnCreate").
		Set("daemonSet", "OnCreate").
		Set("deployment", "OnCreate").
		Set("deploymentConfig", "OnCreate").
		Set("family", "OnCreate").
		Set("job", "OnCreate").
		Set("statefulSet", "OnCreate")
	if !onCreate {
		ubtm.Set("argoRollout", "Ongoing").
			Set("deployment", "Ongoing").
			Set("deploymentConfig", "Ongoing")
	}
	rsp := pyjson.NewObj().
		Set("allowEphemeralStorageReduction", a.ephReduce).
		Set("bootTimeOptimizationEnabled", a.bootTime).
		Set("ephemeralStorageOptimizationEnabled", a.ephEnabled).
		Set("limitConfigs", pyjson.NewObj().
			Set("cpu", pyjson.NewObj().Set("keepLimit", a.limitStrategy == "keepOriginal")).
			Set("ephemeral-storage", pyjson.NewObj().Set("keepLimit", true)).
			Set("memory", pyjson.NewObj().Set("keepLimit", a.limitStrategy == "keepOriginal"))).
		Set("nodeCappingPolicy", pyjson.NewObj().Set("nodeCappingAuto", true)).
		Set("requestsConfigs", pyjson.NewObj().
			Set("cpu", cpuRC).
			Set("memory", memRC).
			Set("ephemeral-storage", pyjson.NewObj().
				Set("percentilePercentage", int(cfg.EphPercentile)).
				Set("headroomPercentage", pyjson.RoundInt((cfg.EphHeadroom-1)*100)))).
		Set("windowByResource", pyjson.NewObj().
			Set("cpu", a.window).
			Set("memory", a.window).
			Set("ephemeral-storage", ephWindow))
	if a.histo != nil {
		rsp.Set("histogramReplicaPercentilePerMinuteByResource", a.histo.Clone())
	}
	return pyjson.NewObj().
		Set("type", "Optimize").
		Set("autoHealing", pyjson.NewObj().
			Set("enabledByResource", pyjson.NewObj().Set("ephemeral-storage", true)).
			Set("enabledV2", a.autoHeal)).
		Set("hpa", pyjson.NewObj().Set("manageHPA", true)).
		Set("policyOptimize", pyjson.NewObj().
			Set("fastReaction", pyjson.NewObj().
				Set("enabled", pyjson.NewObj().Set("cpu", a.burst).Set("memory", a.burst))).
			Set("rightSizePolicy", rsp)).
		Set("updatePolicy", pyjson.NewObj().
			Set("allowRollingUpdate", true).
			Set("binPackUnEvictablePods", true).
			Set("evictionSchedule", pyjson.NewObj().
				Set("scaleDown", "* * * * *").Set("scaleUp", "* * * * *")).
			Set("inPlaceUpdateStrategy", pyjson.NewObj().
				Set("enableInPlaceForOngoingStrategy", a.inPlace).
				Set("enableInPlaceForUponPodCreationStrategy", false)).
			Set("minReplicas", 1).
			Set("podMinReadySeconds", 5).
			Set("requiredWindowCoveragePercentage", a.coverage).
			Set("skipRolloutUponAutomation", a.skipRollout).
			Set("updateByTypeMode", ubtm))
}

func strategyEnumOr(s string) string {
	if v, ok := strategyEnum[s]; ok {
		return v
	}
	return "Ongoing"
}

// builtinPolicyDef is one BUILTIN_POLICIES entry.
type builtinPolicyDef struct {
	name string
	args polSpecArgs
	desc string
}

func (e *Engine) builtinPolicies() []builtinPolicyDef {
	with := func(a polSpecArgs, f func(*polSpecArgs)) polSpecArgs { f(&a); return a }
	return []builtinPolicyDef{
		{"production", with(newPolSpecArgs(93, 10, 93, 5, "24h"), func(a *polSpecArgs) {
			a.cpuMin, a.memMin = "10m", "20Mi"
		}), "Balanced defaults with extra headroom for services that must not be starved"},
		{"high-availability", with(newPolSpecArgs(95, 5, 95, 5, "96h"), func(a *polSpecArgs) {
			a.cpuMin, a.memMin = "70m", "100Mi"
			a.strategy = "Upon pod creation"
			a.coverage = 7
		}), "Higher percentiles, larger minimums and request-time sizing for services where availability matters most"},
		{"cost", with(newPolSpecArgs(75, 5, 90, 5, "12h"), func(a *polSpecArgs) {
			a.cpuMin, a.memMin = "1m", "10Mi"
			a.coverage = 1
		}), "Aggressive sizing with a short window and small minimums, meant for development namespaces"},
		{"batch", with(newPolSpecArgs(85, 5, 95, 5, "96h"), func(a *polSpecArgs) {
			a.cpuMin, a.memMin = "10m", "100Mi"
			a.strategy = "Upon pod creation"
			a.coverage = 1
			a.skipRollout = true
		}), "Sizes batch pods at creation from a four-day window and never restarts them"},
		{"system", with(newPolSpecArgs(95, 5, 95, 5, "96h"), func(a *polSpecArgs) {
			a.cpuMin, a.memMin = "70m", "100Mi"
			a.strategy = "Upon pod creation"
			a.coverage = 7
			a.skipRollout = true
		}), "Conservative sizing for cluster system components; no rollouts, high percentiles"},
		{"daemonset-workloads", with(newPolSpecArgs(87, 10, 87, 5, "24h"), func(a *polSpecArgs) {
			a.cpuMin, a.memMin = "10m", "20Mi"
			a.histo = pyjson.NewObj().Set("memory", 87)
		}), "Stable per-node sizing for DaemonSets"},
		{"daemonset-demand-aware", with(newPolSpecArgs(93, 10, 93, 5, "24h"), func(a *polSpecArgs) {
			a.cpuMin, a.memMin = "10m", "20Mi"
			a.histo = pyjson.NewObj().Set("memory", 90)
		}), "Sizes DaemonSet pods separately for each node size"},
		{"java", with(newPolSpecArgs(95, 15, 93, 5, "24h"), func(a *polSpecArgs) {
			a.cpuMin, a.memMin = "80m", "50Mi"
			a.coverage = 10
			a.burst = false
		}), "Extra CPU headroom and larger minimums so JVM start-up and class loading do not throttle"},
		{"spark", with(newPolSpecArgs(95, 5, 95, 5, "96h"), func(a *polSpecArgs) {
			a.cpuMin, a.memMin = "70m", "100Mi"
			a.strategy = "Upon pod creation"
			a.coverage = 1
			a.skipRollout = true
			a.memKeepRequest = true
		}), "Sizes Spark executors and drivers at creation and keeps their memory requests"},
		{"flink", with(newPolSpecArgs(95, 5, 95, 5, "96h"), func(a *polSpecArgs) {
			a.cpuMin, a.memMin = "70m", "100Mi"
			a.strategy = "Upon pod creation"
			a.coverage = 7
			a.skipRollout = true
			a.memKeepRequest = true
		}), "Sizes Flink managers at creation and keeps their memory requests"},
		{"airflow", with(newPolSpecArgs(93, 10, 93, 5, "96h"), func(a *polSpecArgs) {
			a.cpuMin, a.memMin = "10m", "20Mi"
			a.coverage = 1
			a.skipRollout = true
		}), ""},
		{"high-replica", newPolSpecArgs(90, 5, 92, 5, "24h"),
			"For workloads with many replicas whose usage varies between pods"},
		{"prometheus", with(newPolSpecArgs(97, 20, 97, 20, "96h"), func(a *polSpecArgs) {
			a.coverage = 10
		}), "Generous headroom for Prometheus, Thanos and similar monitoring components"},
	}
}

func (e *Engine) builtinPolicyNameSet() map[string]bool {
	out := map[string]bool{}
	for _, d := range e.builtinPolicies() {
		out[d.name] = true
	}
	return out
}

var dynamicPolicyNames = map[string]bool{
	"airflow": true, "daemonset-workloads": true, "daemonset-demand-aware": true,
	"flink": true, "java": true, "spark": true, "system": true,
}

// Re-checked every refresh pass; an existing CR is never deleted.
var conditionalBuiltinPolicyNames = map[string]bool{
	"high-replica": true, "prometheus": true,
}

// prometheusWorkloadHints match monitoring-stack images/names.
var prometheusWorkloadHints = []string{
	"prometheus", "thanos", "victoria-metrics", "vmstorage", "vminsert",
	"vmselect", "vmagent",
}

// highReplicaThreshold: a workload with this many running replicas triggers
// the high-replica builtin seed (matches autodetectPolicy's >= 10 rule).
const highReplicaThreshold = 10

// policyInUse reports whether any workload row currently references a policy.
func (e *Engine) policyInUse(name string) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, w := range e.workloads {
		if str(w.obj.GetD("policyName", "")) == name {
			return true
		}
	}
	return false
}

// builtinPolicyDetected reports whether the cluster has a workload matching a
// conditional builtin policy's type. Always false before the first refresh.
func (e *Engine) builtinPolicyDetected(name string) bool {
	e.mu.Lock()
	rows := append([]*wlRow(nil), e.workloads...)
	e.mu.Unlock()
	switch name {
	case "prometheus":
		for _, w := range rows {
			blob := strings.ToLower(str(w.obj.GetD("name", "")))
			for _, iv := range getList(w.obj, "images") {
				blob += " " + strings.ToLower(str(iv))
			}
			for _, h := range prometheusWorkloadHints {
				if strings.Contains(blob, h) {
					return true
				}
			}
		}
	case "high-replica":
		for _, w := range rows {
			if w.replicas >= highReplicaThreshold {
				return true
			}
		}
	}
	return false
}

var helmPolicyNames = map[string]bool{
	"batch": true, "cost": true, "high-availability": true, "production": true,
	"weekly-optimization": true,
}

func builtinPolicyMeta(name, desc string) (*pyjson.Obj, *pyjson.Obj) {
	labels := pyjson.NewObj().
		Set("app.kubernetes.io/part-of", "coolscaler").
		Set("coolscaler.sh/builtin-policy", "true")
	ann := pyjson.NewObj().Set("coolscaler.sh/description", desc)
	if dynamicPolicyNames[name] {
		labels.Set("coolscaler.sh/dynamic-policy", "true")
	} else {
		labels.Set("coolscaler.sh", "true")
		ann.Set("coolscaler.sh/default-auto", "true")
		ann.Set("helm.sh/resource-policy", "keep")
	}
	return labels, ann
}

func (e *Engine) ensureBuiltinPolicies(ctx context.Context) {
	if !e.Cfg.WriteRecommendationCRs {
		return
	}
	path := crdBase("policies", e.Cfg.Namespace)
	if old, err := e.Kube.GetJSON(ctx, path+"/java-memory-aware"); err == nil {
		if truthy(getObj(getObj(old, "metadata"), "labels").GetD("coolscaler.sh/builtin-policy", nil)) {
			if _, derr := e.k8sReq(ctx, "DELETE", path+"/java-memory-aware", nil, "application/json"); derr == nil {
				e.Log.Info("migrated builtin Policy java-memory-aware -> java")
			}
		}
	}
	// one-time migration: the `default` builtin is retired. Only delete OUR
	// builtin-labeled CR; a user-created `default` Policy is left untouched.
	if old, err := e.Kube.GetJSON(ctx, path+"/default"); err == nil {
		if truthy(getObj(getObj(old, "metadata"), "labels").GetD("coolscaler.sh/builtin-policy", nil)) {
			if _, derr := e.k8sReq(ctx, "DELETE", path+"/default", nil, "application/json"); derr == nil {
				e.Log.Info("retired builtin Policy default (production is the fallback)")
			}
		}
	}
	for _, d := range e.builtinPolicies() {
		spec := e.policySpec(d.args)
		labels, ann := builtinPolicyMeta(d.name, d.desc)
		cur, err := e.Kube.GetJSON(ctx, path+"/"+d.name)
		if err == nil {
			// reconcile builtin: full spec replace (PUT), merging our labels/ann.
			cur.Set("spec", spec)
			md := getObj(cur, "metadata")
			if !cur.Has("metadata") {
				cur.Set("metadata", md)
			}
			l := getObj(md, "labels")
			if !md.Has("labels") {
				md.Set("labels", l)
			}
			l.Update(labels)
			a := getObj(md, "annotations")
			if !md.Has("annotations") {
				md.Set("annotations", a)
			}
			a.Update(ann)
			_, _ = e.k8sReq(ctx, "PUT", path+"/"+d.name, cur, "application/json")
			continue
		}
		if !isHTTPNotFound(err) {
			continue
		}
		if conditionalBuiltinPolicyNames[d.name] && !e.builtinPolicyDetected(d.name) {
			continue // seeded only when the workload type exists (re-checked per refresh)
		}
		body := pyjson.NewObj().
			Set("apiVersion", crdGroup+"/"+crdVer).
			Set("kind", "Policy").
			Set("metadata", pyjson.NewObj().
				Set("name", d.name).
				Set("namespace", e.Cfg.Namespace).
				Set("labels", labels).
				Set("annotations", ann)).
			Set("spec", spec)
		if _, perr := e.k8sReq(ctx, "POST", path, body, "application/json"); perr == nil {
			e.Log.Info("created builtin Policy", "name", d.name)
		} else {
			e.Log.Info("ensure_builtin_policies failed", "name", d.name, "err", perr)
		}
	}
}

// ensureConditionalBuiltinPolicies re-checks the detection-gated builtin seeds
// after each refresh pass (workload rows exist by then). Creates the CR when
// the workload type is detected; retires OUR builtin-labeled CR when the type
// is gone AND no workload references the policy. User CRs (no builtin label)
// and attached policies are never deleted.
func (e *Engine) ensureConditionalBuiltinPolicies(ctx context.Context) {
	if !e.Cfg.WriteRecommendationCRs {
		return
	}
	path := crdBase("policies", e.Cfg.Namespace)
	for _, d := range e.builtinPolicies() {
		if !conditionalBuiltinPolicyNames[d.name] {
			continue
		}
		if !e.builtinPolicyDetected(d.name) {
			if e.policyInUse(d.name) {
				continue
			}
			if cur, gerr := e.Kube.GetJSON(ctx, path+"/"+d.name); gerr == nil &&
				truthy(getObj(getObj(cur, "metadata"), "labels").GetD("coolscaler.sh/builtin-policy", nil)) {
				if _, derr := e.k8sReq(ctx, "DELETE", path+"/"+d.name, nil, "application/json"); derr == nil {
					e.Log.Info("retired conditional builtin Policy (no matching workload type)", "name", d.name)
				}
			}
			continue
		}
		_, err := e.Kube.GetJSON(ctx, path+"/"+d.name)
		if err == nil || !isHTTPNotFound(err) {
			continue
		}
		labels, ann := builtinPolicyMeta(d.name, d.desc)
		body := pyjson.NewObj().
			Set("apiVersion", crdGroup+"/"+crdVer).
			Set("kind", "Policy").
			Set("metadata", pyjson.NewObj().
				Set("name", d.name).
				Set("namespace", e.Cfg.Namespace).
				Set("labels", labels).
				Set("annotations", ann)).
			Set("spec", e.policySpec(d.args))
		if _, perr := e.k8sReq(ctx, "POST", path, body, "application/json"); perr == nil {
			e.Log.Info("created builtin Policy (workload type detected)", "name", d.name)
		} else {
			e.Log.Info("ensure_conditional_builtin_policies failed", "name", d.name, "err", perr)
		}
	}
}

// Schedule Policies (type: Schedule) — spec builder + ensure.

func (e *Engine) schedulePolicySpec(s *schedulePolicy) *pyjson.Obj {
	base := e.policySpec(with96(newPolSpecArgs(93, 10, 93, 5, "24h")))
	rules := []any{}
	for _, ov := range s.overrides {
		periods := []any{}
		for _, p := range ov.periods {
			days := make([]any, len(p.days))
			for i, d := range p.days {
				days[i] = d
			}
			periods = append(periods, pyjson.NewObj().
				Set("weeklyConfig", pyjson.NewObj().
					Set("days", days).
					Set("beginTime", p.begin).
					Set("endTime", p.end)))
		}
		dp := ov.dataPoints
		if dp == "" {
			dp = "currentPeriods"
		}
		rules = append(rules, pyjson.NewObj().
			Set("policyName", ov.policyName).
			Set("historyWindowDataPoints", dp).
			Set("sleep", ov.sleep).
			Set("periods", periods))
	}
	return pyjson.NewObj().
		Set("type", "Schedule").
		Set("autoHealing", base.GetD("autoHealing", pyjson.NewObj())).
		Set("hpa", base.GetD("hpa", pyjson.NewObj())).
		Set("policyOptimize", base.GetD("policyOptimize", pyjson.NewObj())).
		Set("updatePolicy", base.GetD("updatePolicy", pyjson.NewObj())).
		Set("policySchedule", pyjson.NewObj().
			Set("schedulePolicyConfig", pyjson.NewObj().
				Set("defaultPolicy", s.defaultPolicy).
				Set("rules", rules)))
}

// with96 applies the min-allowed knobs of the `production` policy used by schedule_policy_spec
// (_policy_spec(93,10,93,5,"24h", cpu_min="10m", mem_min="20Mi")).
func with96(a polSpecArgs) polSpecArgs {
	a.cpuMin, a.memMin = "10m", "20Mi"
	return a
}

func (e *Engine) ensureSchedulePolicies(ctx context.Context) {
	if !e.Cfg.WriteRecommendationCRs {
		return
	}
	path := crdBase("policies", e.Cfg.Namespace)
	for _, sched := range builtinSchedulePolicies() {
		name := sched.name
		cur, err := e.Kube.GetJSON(ctx, path+"/"+name)
		if err == nil {
			// one-time migration: weekly-optimization Optimize -> Schedule.
			if name == "weekly-optimization" && getStr(getObj(cur, "spec"), "type") != "Schedule" {
				cur.Set("spec", e.schedulePolicySpec(sched))
				if _, perr := e.k8sReq(ctx, "PUT", path+"/"+name, cur, "application/json"); perr == nil {
					e.Log.Info("migrated weekly-optimization to type: Schedule")
				}
			}
			continue
		}
		if !isHTTPNotFound(err) {
			continue
		}
		lbl := pyjson.NewObj().
			Set("app.kubernetes.io/part-of", "coolscaler").
			Set("coolscaler.sh/schedule-policy", "true").
			Set("coolscaler.sh/builtin-policy", "true")
		ann := pyjson.NewObj().Set("coolscaler.sh/description", sched.desc)
		if helmPolicyNames[name] {
			lbl.Set("coolscaler.sh", "true")
			ann.Set("coolscaler.sh/default-auto", "true")
			ann.Set("helm.sh/resource-policy", "keep")
		}
		body := pyjson.NewObj().
			Set("apiVersion", crdGroup+"/"+crdVer).
			Set("kind", "Policy").
			Set("metadata", pyjson.NewObj().
				Set("name", name).
				Set("namespace", e.Cfg.Namespace).
				Set("labels", lbl).
				Set("annotations", ann)).
			Set("spec", e.schedulePolicySpec(sched))
		if _, perr := e.k8sReq(ctx, "POST", path, body, "application/json"); perr == nil {
			e.Log.Info("created schedule Policy", "name", name)
		} else {
			e.Log.Info("ensure_schedule_policies failed", "name", name, "err", perr)
		}
	}
}

// HPA (Replicas) policy catalog + ensure.

type repPolicyArgs struct {
	genEn      bool
	genPct     int
	genWin     string
	predEn     bool
	predPct    int
	predWin    string
	prediction bool
	lookAhead  string
	threshold  bool
	maxDev     int
	reqHist    int
	coverage   string
	minAllowed int
	capOrigin  bool
}

func newRepPolicyArgs() repPolicyArgs {
	return repPolicyArgs{
		genEn: true, genPct: 80, genWin: "168h",
		predEn: true, predPct: 80, predWin: "168h",
		prediction: true, lookAhead: "20m",
		threshold: false, maxDev: 50, reqHist: 4, coverage: "24h",
		minAllowed: 1, capOrigin: true,
	}
}

// knobsObj is _rep_policy's returned dict (key order preserved).
func (a repPolicyArgs) knobsObj() *pyjson.Obj {
	return pyjson.NewObj().
		Set("genEnabled", a.genEn).
		Set("genPct", a.genPct).
		Set("genWindow", a.genWin).
		Set("predEnabled", a.predEn).
		Set("predPct", a.predPct).
		Set("predWindow", a.predWin).
		Set("predictionEnabled", a.prediction).
		Set("lookAhead", a.lookAhead).
		Set("thresholdEnabled", a.threshold).
		Set("maxDeviation", a.maxDev).
		Set("requiredHistory", a.reqHist).
		Set("coverage", a.coverage).
		Set("minAllowed", a.minAllowed).
		Set("capByOrigin", a.capOrigin)
}

type replicasPolicyDef struct {
	name string
	kb   *pyjson.Obj
	desc string
}

var replicasPolicies = buildReplicasPolicies()

func buildReplicasPolicies() []replicasPolicyDef {
	mk := func(f func(*repPolicyArgs)) *pyjson.Obj {
		a := newRepPolicyArgs()
		if f != nil {
			f(&a)
		}
		return a.knobsObj()
	}
	return []replicasPolicyDef{
		{"production", mk(nil), "Default replica sizing for HPA-managed workloads"},
		{"cost", mk(func(a *repPolicyArgs) {
			a.genPct, a.genWin, a.predPct, a.predWin = 60, "96h", 60, "96h"
			a.prediction, a.coverage = false, "48h"
		}), "Lower percentiles over a longer window, trading headroom for fewer replicas"},
		{"high-availability", mk(nil),
			"Default replica sizing with a higher availability floor"},
		{"performance", mk(func(a *repPolicyArgs) {
			a.genPct, a.genWin, a.predWin = 98, "336h", "336h"
			a.lookAhead, a.coverage = "30m", "168h"
		}), "High percentiles over a two-week window with a 30-minute look-ahead for latency-sensitive services"},
		{"predictive", mk(func(a *repPolicyArgs) {
			a.genEn, a.predPct = false, 90
		}), "Scales ahead of demand from recorded trends; workloads without a repeating pattern are left alone"},
		{"production-with-threshold-optimization", mk(func(a *repPolicyArgs) {
			a.threshold = true
		}), ""},
		{"cost-with-threshold-optimization", mk(func(a *repPolicyArgs) {
			a.genPct, a.genWin, a.predPct, a.predWin = 60, "96h", 60, "96h"
			a.prediction, a.threshold, a.coverage = false, true, "48h"
		}), ""},
		{"high-availability-with-threshold-optimization", mk(func(a *repPolicyArgs) {
			a.threshold = true
		}), ""},
		{"performance-with-threshold-optimization", mk(func(a *repPolicyArgs) {
			a.genPct, a.genWin, a.predWin = 98, "336h", "336h"
			a.lookAhead, a.threshold, a.coverage = "30m", true, "168h"
		}), ""},
		{"predictive-with-threshold-optimization", mk(func(a *repPolicyArgs) {
			a.genEn, a.predPct, a.threshold = false, 90, true
		}), ""},
	}
}

var hpaBuiltinNames = func() map[string]bool {
	out := map[string]bool{}
	for _, d := range replicasPolicies {
		out[d.name] = true
	}
	return out
}()

func replicasPolicyKnob(name string) *pyjson.Obj {
	for _, d := range replicasPolicies {
		if d.name == name {
			return d.kb
		}
	}
	return nil
}

func hpapolicySpec(kb *pyjson.Obj) *pyjson.Obj {
	return pyjson.NewObj().
		Set("policyOptimize", pyjson.NewObj().
			Set("minReplicas", pyjson.NewObj().
				Set("capByOriginMinReplicas", kb.GetD("capByOrigin", nil)).
				Set("minAllowed", kb.GetD("minAllowed", nil)).
				Set("setMinReplicas", kb.GetD("setMin", nil)).
				Set("generalWorkloads", pyjson.NewObj().
					Set("enabled", kb.GetD("genEnabled", nil)).
					Set("keepMinReplicas", kb.GetD("keepMin", false)).
					Set("percentilePercentage", kb.GetD("genPct", nil)).
					Set("window", kb.GetD("genWindow", nil))).
				Set("predictableWorkloads", pyjson.NewObj().
					Set("enabled", kb.GetD("predEnabled", nil)).
					Set("keepMinReplicas", kb.GetD("keepMin", false)).
					Set("percentilePercentage", kb.GetD("predPct", nil)).
					Set("window", kb.GetD("predWindow", nil)))).
			Set("maxReplicas", pyjson.NewObj().
				Set("setMaxReplicas", kb.GetD("setMax", nil))).
			Set("replicas", pyjson.NewObj().
				Set("prediction", pyjson.NewObj().
					Set("enabled", kb.GetD("predictionEnabled", nil)).
					Set("headroomPercentage", kb.GetD("headroom", 0)).
					Set("lookAheadDuration", kb.GetD("lookAhead", nil)))).
			Set("thresholdOptimization", pyjson.NewObj().
				Set("enabled", kb.GetD("thresholdEnabled", nil)).
				Set("historyWindow", kb.GetD("thHistoryWindow", "168h")).
				Set("maxDeviationPercentage", kb.GetD("maxDeviation", nil)).
				Set("requiredHistory", kb.GetD("requiredHistory", nil)))).
		Set("updatePolicy", pyjson.NewObj().
			Set("requiredWindowCoverageDuration", kb.GetD("coverage", nil)))
}

func (e *Engine) ensureHpaPolicies(ctx context.Context) {
	if !e.Cfg.WriteRecommendationCRs {
		return
	}
	path := crdBase("hpapolicies", e.Cfg.Namespace)
	builtinLabels := func() *pyjson.Obj {
		return pyjson.NewObj().
			Set("app.kubernetes.io/part-of", "coolscaler").
			Set("coolscaler.sh", "true").
			Set("coolscaler.sh/builtin-policy", "true")
	}
	for _, d := range replicasPolicies {
		cur, err := e.Kube.GetJSON(ctx, path+"/"+d.name)
		if err == nil {
			mr := getObj(getObj(getObj(cur, "spec"), "policyOptimize"), "minReplicas")
			if mr.Has("setMaxReplicas") || mr.Has("keepMinReplicas") || mr.Has("keepMaxReplicas") {
				_, _ = e.k8sReq(ctx, "PATCH", path+"/"+d.name,
					pyjson.NewObj().
						Set("metadata", pyjson.NewObj().Set("labels", builtinLabels())).
						Set("spec", hpapolicyLegacyNulls(hpapolicySpec(d.kb))),
					"application/merge-patch+json")
				e.Log.Info("migrated HPAPolicy to the current spec shape", "name", d.name)
			}
			continue
		}
		if !isHTTPNotFound(err) {
			continue
		}
		body := pyjson.NewObj().
			Set("apiVersion", crdGroup+"/"+crdVer).
			Set("kind", "HPAPolicy").
			Set("metadata", pyjson.NewObj().
				Set("name", d.name).
				Set("namespace", e.Cfg.Namespace).
				Set("labels", builtinLabels()).
				Set("annotations", pyjson.NewObj().
					Set("coolscaler.sh/description", d.desc))).
			Set("spec", hpapolicySpec(d.kb))
		if _, perr := e.k8sReq(ctx, "POST", path, body, "application/json"); perr == nil {
			e.Log.Info("created HPAPolicy", "name", d.name)
		} else {
			e.Log.Info("ensure_hpa_policies failed", "name", d.name, "err", perr)
		}
	}
}

// hpapolicyLegacyNulls decorates an hpapolicySpec merge-patch body with
// explicit nulls that delete the legacy invented keys from existing CRs
// (merge-patch semantics: null removes the key). Only for PATCH bodies —
// never send these nulls in a create.
func hpapolicyLegacyNulls(spec *pyjson.Obj) *pyjson.Obj {
	out := spec.Clone()
	po := getObj(out, "policyOptimize")
	mr := getObj(po, "minReplicas").Clone()
	mr.Set("setMaxReplicas", nil)
	mr.Set("keepMinReplicas", nil)
	mr.Set("keepMaxReplicas", nil)
	po = po.Clone()
	po.Set("minReplicas", mr)
	out.Set("policyOptimize", po)
	return out
}

func hpapolicyKnobsFromSpec(spec *pyjson.Obj) *pyjson.Obj {
	po := getObj(spec, "policyOptimize")
	mr := getObj(po, "minReplicas")
	gw := getObj(mr, "generalWorkloads")
	pw := getObj(mr, "predictableWorkloads")
	pred := getObj(getObj(po, "replicas"), "prediction")
	th := getObj(po, "thresholdOptimization")
	up := getObj(spec, "updatePolicy")
	toInt := func(v any, def int) int {
		if f, ok := toFloatLoose(v); ok {
			return int(f)
		}
		return def
	}
	return pyjson.NewObj().
		Set("genEnabled", truthy(gw.GetD("enabled", true))).
		Set("genPct", toInt(gw.GetD("percentilePercentage", nil), 80)).
		Set("genWindow", gw.GetD("window", "168h")).
		Set("predEnabled", truthy(pw.GetD("enabled", true))).
		Set("predPct", toInt(pw.GetD("percentilePercentage", nil), 80)).
		Set("predWindow", pw.GetD("window", "168h")).
		Set("predictionEnabled", truthy(pred.GetD("enabled", true))).
		Set("lookAhead", pred.GetD("lookAheadDuration", "20m")).
		Set("thresholdEnabled", truthy(th.GetD("enabled", false))).
		Set("maxDeviation", toInt(th.GetD("maxDeviationPercentage", nil), 50)).
		Set("requiredHistory", toInt(th.GetD("requiredHistory", nil), 4)).
		Set("thHistoryWindow", th.GetD("historyWindow", "168h")).
		Set("coverage", up.GetD("requiredWindowCoverageDuration", "24h")).
		Set("minAllowed", toInt(mr.GetD("minAllowed", nil), 1)).
		Set("capByOrigin", truthy(mr.GetD("capByOriginMinReplicas", true))).
		Set("setMin", mr.GetD("setMinReplicas", nil)).
		Set("setMax", getObj(po, "maxReplicas").GetD("setMaxReplicas", mr.GetD("setMaxReplicas", nil))).
		Set("keepMin", truthy(gw.GetD("keepMinReplicas", nil)) ||
			truthy(pw.GetD("keepMinReplicas", nil)) ||
			truthy(mr.GetD("keepMinReplicas", false))).
		Set("headroom", toInt(pred.GetD("headroomPercentage", nil), 0))
}

// hpaScheduleFromSpec reads an HPA schedule from a HpaPolicy CR spec into the
// flat internal shape {defaultPolicy, rules[{policyName, days, beginTime,
// endTime}]}. falls back to the legacy invented spec.schedule for CRs written
// before the migration. Returns nil when the spec carries no schedule (knob
// policy).
func hpaScheduleFromSpec(spec *pyjson.Obj) *pyjson.Obj {
	if cfgO := getObj(getObj(spec, "schedulePolicy"), "schedulePolicyConfig"); cfgO.Len() > 0 {
		rules := []any{}
		for _, rv := range getList(cfgO, "rules") {
			r := obj(rv)
			for _, pv := range getList(r, "periods") {
				wc := getObj(obj(pv), "weeklyConfig")
				var days []any
				for _, dv := range getList(wc, "days") {
					if f, ok := toFloatLoose(dv); ok {
						days = append(days, int64(f))
					}
				}
				if days == nil {
					days = []any{}
				}
				rules = append(rules, pyjson.NewObj().
					Set("policyName", r.GetD("policyName", "production")).
					Set("days", days).
					Set("beginTime", wc.GetD("beginTime", "00:00")).
					Set("endTime", wc.GetD("endTime", "23:59")))
			}
		}
		return pyjson.NewObj().
			Set("defaultPolicy", cfgO.GetD("defaultPolicy", "production")).
			Set("rules", rules)
	}
	if sched, ok := spec.GetD("schedule", nil).(*pyjson.Obj); ok && sched != nil {
		return sched
	}
	return nil
}

func (e *Engine) loadHpaOverrides(ctx context.Context) {
	resp, err := e.Kube.GetJSON(ctx, crdBase("hpapolicies", e.Cfg.Namespace))
	if err != nil {
		return
	}
	for _, it := range items(resp) {
		cr := obj(it)
		md := getObj(cr, "metadata")
		name := getStr(md, "name")
		if name == "" || hpaBuiltinNames[name] {
			continue
		}
		spec := getObj(cr, "spec")
		e.mu.Lock()
		if sched := hpaScheduleFromSpec(spec); sched != nil {
			e.hpaSched[name] = sched
		} else {
			e.hpaPolicyOverrides[name] = hpapolicyKnobsFromSpec(spec)
		}
		e.hpaPolicyDescOv[name] = str(getObj(md, "annotations").GetD("coolscaler.sh/description", "Custom HPA policy."))
		e.mu.Unlock()
	}
}

// Pod-Scheduling policy catalog + ensure.

type schedulingPolicyDef struct {
	name               string
	minimumNodesSpread int
	zones              bool
	desc               string
}

var schedulingPoliciesBuiltin = []schedulingPolicyDef{
	{"high-availability", 3, true,
		"Spread replicas across at least three nodes and across zones"},
	{"production", 2, false, "Keep replicas on at least two nodes with relaxed anti-affinity"},
	{"cost", 1, false, "Consolidate replicas onto as few nodes as possible"},
}

func (d schedulingPolicyDef) knobs() *pyjson.Obj {
	return pyjson.NewObj().
		Set("enabled", true).
		Set("minimumNodesSpread", d.minimumNodesSpread).
		Set("enhanceAvailabilityOnDifferentZones", d.zones)
}

func (e *Engine) ensureSchedulingPolicies(ctx context.Context) {
	if !e.Cfg.WriteRecommendationCRs {
		return
	}
	path := crdBase("podschedulingpolicies", e.Cfg.Namespace)
	for _, d := range schedulingPoliciesBuiltin {
		_, err := e.Kube.GetJSON(ctx, path+"/"+d.name)
		if err == nil || !isHTTPNotFound(err) {
			continue
		}
		body := pyjson.NewObj().
			Set("apiVersion", crdGroup+"/"+crdVer).
			Set("kind", "PodSchedulingPolicy").
			Set("metadata", pyjson.NewObj().
				Set("name", d.name).
				Set("namespace", e.Cfg.Namespace).
				Set("labels", pyjson.NewObj().
					Set("app.kubernetes.io/part-of", "coolscaler").
					Set("coolscaler.sh/builtin-schedpolicy", "true")).
				Set("annotations", pyjson.NewObj().
					Set("coolscaler.sh/description", d.desc))).
			Set("spec", pyjson.NewObj().Set("selfAntiAffinityOptimization", d.knobs()))
		if _, perr := e.k8sReq(ctx, "POST", path, body, "application/json"); perr == nil {
			e.Log.Info("created PodSchedulingPolicy", "name", d.name)
		} else {
			e.Log.Info("ensure_scheduling_policies failed", "name", d.name, "err", perr)
		}
	}
}

func (e *Engine) loadSchedulingCRs(ctx context.Context) {
	if !e.Cfg.WriteRecommendationCRs {
		return
	}
	builtins := map[string]bool{}
	for _, d := range schedulingPoliciesBuiltin {
		builtins[d.name] = true
	}
	resp, err := e.Kube.GetJSON(ctx, crdBase("podschedulingpolicies", e.Cfg.Namespace))
	if err != nil {
		return
	}
	n := 0
	for _, it := range items(resp) {
		cr := obj(it)
		nm := getStr(getObj(cr, "metadata"), "name")
		kb := getObj(getObj(cr, "spec"), "selfAntiAffinityOptimization")
		if nm == "" || builtins[nm] || !kb.Has("minimumNodesSpread") {
			continue
		}
		desc := str(getObj(getObj(cr, "metadata"), "annotations").
			GetD("coolscaler.sh/description", "User-defined scheduling policy."))
		e.mu.Lock()
		e.schedulingPolicyKnobs[nm] = kb
		e.schedulingUser[nm] = pyjson.NewObj().Set("knobs", kb).Set("desc", desc)
		e.mu.Unlock()
		n++
	}
	if n > 0 {
		e.Log.Info("loaded user scheduling policies from CRs", "count", n)
	}
}

// Built-in DownscalerPolicy catalog + ensure.

var builtinDownscalerNames = []string{"nights", "weekends", "nights-and-weekends"}

func builtinDownscalerSchedule(name string) []any {
	wc := func(days []any, begin, end string) any {
		return pyjson.NewObj().Set("weeklyConfig", pyjson.NewObj().
			Set("days", days).Set("beginTime", begin).Set("endTime", end))
	}
	allDays := []any{int64(0), int64(1), int64(2), int64(3), int64(4), int64(5), int64(6)}
	wkndDays := []any{int64(6), int64(0)}
	switch name {
	case "nights":
		return []any{wc(allDays, "04:00", "12:00")}
	case "weekends":
		return []any{wc(wkndDays, "05:00", "05:00")}
	case "nights-and-weekends":
		return []any{wc(allDays, "04:00", "12:00"), wc(wkndDays, "05:00", "05:00")}
	}
	return nil
}

func (e *Engine) ensureDownscalerPolicies(ctx context.Context) {
	if !e.Cfg.WriteRecommendationCRs {
		return
	}
	path := crdBase("downscalerpolicies", e.Cfg.Namespace)
	for _, name := range builtinDownscalerNames {
		spec := pyjson.NewObj().
			Set("name", name).
			Set("minReplicas", 1).
			Set("replicas", 1).
			Set("schedule", builtinDownscalerSchedule(name))
		cur, err := e.Kube.GetJSON(ctx, path+"/"+name)
		if err == nil {
			if truthy(getObj(getObj(cur, "metadata"), "labels").GetD("coolscaler.sh/builtin-downscaler", nil)) {
				cur.Set("spec", spec)
				_, _ = e.k8sReq(ctx, "PUT", path+"/"+name, cur, "application/json")
			}
			continue
		}
		if !isHTTPNotFound(err) {
			continue
		}
		body := pyjson.NewObj().
			Set("apiVersion", crdGroup+"/"+crdVer).
			Set("kind", "DownscalerPolicy").
			Set("metadata", pyjson.NewObj().
				Set("name", name).
				Set("namespace", e.Cfg.Namespace).
				Set("labels", pyjson.NewObj().
					Set("app.kubernetes.io/part-of", "coolscaler").
					Set("coolscaler.sh/builtin-downscaler", "true"))).
			Set("spec", spec)
		if _, perr := e.k8sReq(ctx, "POST", path, body, "application/json"); perr == nil {
			e.Log.Info("created DownscalerPolicy", "name", name)
		} else {
			e.Log.Info("ensure_downscaler_policies failed", "name", name, "err", perr)
		}
	}
}

// Custom Owner Grouping (COG) CR persistence.

var cogSlugRe = regexp.MustCompile(`[^a-z0-9-]`)
var cogDashRe = regexp.MustCompile(`-{2,}`)

func cogCrname(name string) string {
	slug := cogDashRe.ReplaceAllString(cogSlugRe.ReplaceAllString(strings.ToLower(name), "-"), "-")
	slug = strings.Trim(slug, "-")
	if slug == "" {
		slug = "x"
	}
	out := "cog-" + slug
	if len(out) > 253 {
		out = out[:253]
	}
	return out
}

func cogSpec(entry *pyjson.Obj, builtin bool) *pyjson.Obj {
	disp := pyjson.NewObj().Set("hideGeneratedSuffix", truthy(entry.GetD("hideSuffix", true)))
	if fields, ok := entry.GetD("displayFields", nil).([]any); ok && fields != nil {
		disp.Set("fields", append([]any{}, fields...))
	}
	gbs := entry.GetD("groupBys", nil)
	if gbs == nil {
		gbs = []any{}
	}
	return pyjson.NewObj().
		Set("displayName", entry.GetD("name", nil)).
		Set("builtIn", builtin).
		Set("groupBys", gbs).
		Set("defaultPolicy", entry.GetD("defaultPolicy", "Auto detected")).
		Set("defaultAuto", truthy(entry.GetD("defaultAuto", false))).
		Set("enabled", truthy(entry.GetD("enabled", true))).
		Set("hideSuffix", truthy(entry.GetD("hideSuffix", true))).
		Set("displayOptions", disp).
		Set("groupBy", pyjson.NewObj().Set("positiveRegexMatch", false)).
		Set("recommendationRetentionPeriodMinutes", int(f64d(entry.GetD("recommendationRetentionPeriodMinutes", 0), 0))).
		Set("weight", int(f64d(entry.GetD("weight", 0), 0)))
}

type cogMeta struct {
	ret        int
	fields     []any
	apiVersion string
	kind       string
	nameRegex  string
	hideSuffix *bool
}

var cogFalse = false

var cogRealMeta = map[string]cogMeta{
	"CronJob":           {ret: 11520, fields: []any{"ownerName"}, apiVersion: "batch/v1"},
	"DaemonSetNodeSize": {ret: 0, fields: []any{"ownerName", "nodeSize"}},
	"GitHubListener": {ret: 0, fields: []any{"ownerName"}, apiVersion: "actions.github.com/v1alpha1",
		nameRegex: "^(.+)-[a-z0-9]+-listener$"},
	"GitHubRunner": {ret: 0, fields: []any{"labels"}, apiVersion: "actions.github.com/v1alpha1",
		kind: "EphemeralRunner", nameRegex: "^(.+)-[a-z0-9]+-runner-[a-z0-9]+$"},
	"GitLabRunner":    {ret: 10080},
	"JenkinsJob":      {ret: 10080, fields: []any{"annotations"}, hideSuffix: &cogFalse},
	"PyTorchJob":      {ret: 11520, fields: []any{"labels"}, apiVersion: "kubeflow.org/v1"},
	"TFJob":           {ret: 11520, fields: []any{"labels"}, apiVersion: "kubeflow.org/v1"},
	"MPIJob":          {ret: 11520, fields: []any{"labels"}, apiVersion: "kubeflow.org/v1"},
	"XGBoostJob":      {ret: 11520, fields: []any{"labels"}, apiVersion: "kubeflow.org/v1"},
	"PaddleJob":       {ret: 11520, fields: []any{"labels"}, apiVersion: "kubeflow.org/v1"},
	"JAXJob":          {ret: 11520, fields: []any{"labels"}, apiVersion: "kubeflow.org/v1"},
	"KubeflowTrainer": {ret: 11520, fields: []any{"labels"}},
	"KedaScaledJob":   {ret: 0, fields: []any{"ownerName"}, apiVersion: "keda.sh/v1alpha1"},
	"StrimziPodSet":   {ret: 0, fields: []any{"ownerName"}, apiVersion: "core.strimzi.io/v1beta2"},
	"Airflow":         {ret: 1440},
	"ArgoWorkflows":   {ret: 1440},
	"Flink":           {ret: 1440},
	"FlinkApache":     {ret: 1440},
}

var builtinCustomWorkloads = [][3]string{
	{"DaemonSetNodeSize", "DaemonSet", "Group DaemonSet pods by node size — one recommendation per size."},
	{"Airflow", "Airflow", "Apache Airflow workers and schedulers."},
	{"ArgoWorkflows", "Workflow", "Argo Workflows pods."},
	{"CronJob", "CronJob", "CronJob-spawned pods, grouped to a single recommendation."},
	{"Flink", "FlinkDeployment", "Apache Flink task/job managers (Flink operator)."},
	{"FlinkApache", "FlinkApplication", "Apache Flink native deployments."},
	{"Spark", "SparkApplication", "Apache Spark drivers and executors."},
	{"RayCluster", "RayCluster", "Ray head and worker pods."},
	{"StrimziPodSet", "StrimziPodSet", "Strimzi-managed Kafka / ZooKeeper pods."},
	{"GitHubRunner", "Runner", "Self-hosted GitHub Actions runners (ARC)."},
	{"GitHubListener", "AutoscalingListener", "GitHub ARC autoscaling listeners."},
	{"GitLabRunner", "Runner", "GitLab CI runners."},
	{"JenkinsJob", "Job", "Jenkins build jobs."},
	{"PyTorchJob", "PyTorchJob", "Kubeflow PyTorch distributed training jobs."},
	{"TFJob", "TFJob", "Kubeflow TensorFlow training jobs."},
	{"MPIJob", "MPIJob", "Kubeflow MPI (all-reduce) training jobs."},
	{"XGBoostJob", "XGBoostJob", "Kubeflow XGBoost training jobs."},
	{"PaddleJob", "PaddleJob", "Kubeflow PaddlePaddle training jobs."},
	{"JAXJob", "JAXJob", "Kubeflow JAX training jobs."},
	{"KubeflowTrainer", "TrainJob", "Kubeflow Trainer (TrainJob) workloads."},
	{"Vertex", "Vertex", "Google Vertex AI training/serving pods."},
	{"KedaScaledJob", "ScaledJob", "KEDA-scaled jobs."},
}

func (e *Engine) ensureBuiltinCogs(ctx context.Context) {
	if !e.Cfg.WriteRecommendationCRs {
		return
	}
	n := 0
	base := crdBase("customownergroupings", e.Cfg.Namespace)
	for _, bw := range builtinCustomWorkloads {
		cwname, owner := bw[0], bw[1]
		crn := cogCrname("builtin-" + cwname)
		meta := cogRealMeta[cwname]
		tocKind := meta.kind
		if tocKind == "" {
			tocKind = owner
		}
		toc := pyjson.NewObj().Set("kind", tocKind)
		if meta.apiVersion != "" {
			toc.Set("apiVersion", meta.apiVersion)
		}
		if meta.nameRegex != "" {
			toc.Set("name", meta.nameRegex)
		}
		hideSuffix := true
		if meta.hideSuffix != nil {
			hideSuffix = *meta.hideSuffix
		}
		entry := pyjson.NewObj().
			Set("name", cwname).
			Set("groupBys", []any{pyjson.NewObj().Set("topOwnerController", toc)}).
			Set("recommendationRetentionPeriodMinutes", meta.ret).
			Set("displayFields", anyOrNil(meta.fields)).
			Set("hideSuffix", hideSuffix)
		_, err := e.Kube.GetJSON(ctx, base+"/"+crn)
		if err == nil {
			// present
			disp := pyjson.NewObj().Set("hideGeneratedSuffix", hideSuffix)
			if meta.fields != nil {
				disp.Set("fields", append([]any{}, meta.fields...))
			}
			patch := pyjson.NewObj().Set("spec", pyjson.NewObj().
				Set("recommendationRetentionPeriodMinutes", meta.ret).
				Set("displayOptions", disp).
				Set("groupBy", pyjson.NewObj().Set("positiveRegexMatch", false)).
				Set("groupBys", entry.GetD("groupBys", nil)))
			_, _ = e.k8sReq(ctx, "PATCH", base+"/"+crn, patch, "application/merge-patch+json")
			continue
		}
		if !isHTTPNotFound(err) {
			continue
		}
		e.mu.Lock()
		st := e.builtinCogState[cwname]
		e.mu.Unlock()
		if st == nil {
			st = pyjson.NewObj()
		}
		entry.Set("defaultPolicy", st.GetD("defaultPolicy", "Auto detected")).
			Set("defaultAuto", truthy(st.GetD("defaultAuto", false))).
			Set("enabled", truthy(st.GetD("enabled", true)))
		e.writeCogCR(ctx, entry, true)
		n++
	}
	if n > 0 {
		e.Log.Info("materialized built-in custom owner groupings as CRs", "count", n)
	}
}

func anyOrNil(v []any) any {
	if v == nil {
		return nil
	}
	return v
}

func (e *Engine) writeCogCR(ctx context.Context, entry *pyjson.Obj, builtin bool) {
	if !e.Cfg.WriteRecommendationCRs {
		return
	}
	name := str(entry.GetD("name", ""))
	crnBase := name
	if builtin {
		crnBase = "builtin-" + name
	}
	crn := cogCrname(crnBase)
	spec := cogSpec(entry, builtin)
	path := crdBase("customownergroupings", e.Cfg.Namespace)
	builtinLbl := "false"
	if builtin {
		builtinLbl = "true"
	}
	cr := pyjson.NewObj().
		Set("apiVersion", crdGroup+"/"+crdVer).
		Set("kind", "CustomOwnerGrouping").
		Set("metadata", pyjson.NewObj().
			Set("name", crn).
			Set("namespace", e.Cfg.Namespace).
			Set("labels", pyjson.NewObj().
				Set("app.kubernetes.io/part-of", "coolscaler").
				Set("coolscaler.sh/builtin", builtinLbl))).
		Set("spec", spec)
	if _, err := e.k8sReq(ctx, "PATCH", path+"/"+crn,
		pyjson.NewObj().Set("spec", spec), "application/merge-patch+json"); err != nil {
		if _, ok := isHTTPError(err); ok {
			if _, perr := e.k8sReq(ctx, "POST", path, cr, "application/json"); perr != nil {
				e.Log.Info("write_cog_cr failed", "name", name, "err", perr)
			}
		} else {
			e.Log.Info("write_cog_cr failed", "name", name, "err", err)
		}
	}
}

func (e *Engine) deleteCogCR(ctx context.Context, name string, builtin bool) {
	if !e.Cfg.WriteRecommendationCRs {
		return
	}
	crnBase := name
	if builtin {
		crnBase = "builtin-" + name
	}
	crn := cogCrname(crnBase)
	_, _ = e.k8sReq(ctx, "DELETE", crdBase("customownergroupings", e.Cfg.Namespace)+"/"+crn, nil, "application/json")
}

func (e *Engine) loadCogCRs(ctx context.Context) {
	if !e.Cfg.WriteRecommendationCRs {
		return
	}
	resp, err := e.Kube.GetJSON(ctx, crdBase("customownergroupings", e.Cfg.Namespace))
	if err != nil {
		return
	}
	nuser, nbi := 0, 0
	for _, it := range items(resp) {
		cr := obj(it)
		spec := getObj(cr, "spec")
		nm := getStr(spec, "displayName")
		if nm == "" {
			nm = getStr(getObj(cr, "metadata"), "name")
		}
		if nm == "" {
			continue
		}
		if truthy(spec.GetD("builtIn", nil)) {
			e.mu.Lock()
			e.builtinCogState[nm] = pyjson.NewObj().
				Set("enabled", spec.GetD("enabled", true)).
				Set("defaultPolicy", spec.GetD("defaultPolicy", "Auto detected")).
				Set("defaultAuto", truthy(spec.GetD("defaultAuto", false)))
			e.mu.Unlock()
			nbi++
		} else {
			entry := pyjson.NewObj().
				Set("name", nm).
				Set("groupBys", spec.GetD("groupBys", []any{})).
				Set("defaultPolicy", spec.GetD("defaultPolicy", "Auto detected")).
				Set("defaultAuto", truthy(spec.GetD("defaultAuto", false))).
				Set("enabled", spec.GetD("enabled", true)).
				Set("hideSuffix", spec.GetD("hideSuffix", true))
			e.mu.Lock()
			kept := e.customOwnerGroupings[:0]
			for _, c := range e.customOwnerGroupings {
				if str(c.GetD("name", "")) != nm {
					kept = append(kept, c)
				}
			}
			e.customOwnerGroupings = append(kept, entry)
			e.mu.Unlock()
			nuser++
		}
	}
	if nuser > 0 || nbi > 0 {
		e.Log.Info("loaded custom owner groupings from CRs", "user", nuser, "builtin", nbi)
	}
}

// per-rule key order preserved).
func defaultAlertRules() *pyjson.Obj {
	mk := func(sev string, threshold int, desc string) *pyjson.Obj {
		return pyjson.NewObj().
			Set("severity", sev).
			Set("threshold", threshold).
			Set("enabled", true).
			Set("desc", desc)
	}
	return pyjson.NewObj().
		Set("OutOfMemory", mk("critical", 1, "Workloads with OOMKilled containers")).
		Set("CpuThrottling", mk("warning", 1, "Workloads with throttled CPU")).
		Set("UnderProvisioned", mk("warning", 1, "Workloads whose recommendation raises requests")).
		Set("OverProvisioned", mk("info", 50, "Workloads wasting ≥ threshold% of requested resources")).
		Set("FrequentRestarts", mk("warning", 5, "Workloads with frequent container restarts")).
		Set("CrashLoopBackOff", mk("critical", 1, "Workloads in CrashLoopBackOff")).
		Set("NodeUtilization", mk("warning", 90, "Nodes blocked from scale-down by un-evictable pods")).
		Set("SystemDown", mk("critical", 1, "A CoolScaler control-plane component is unavailable"))
}
