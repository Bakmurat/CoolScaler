package engine

import (
	"context"
	"fmt"
	"regexp"
	"strings"

	"coolscaler.sh/coolscaler/internal/pyjson"
)

// Policy editor — detail/spec (de)serialization + CRUD.

var res3 = []string{"cpu", "memory", "ephemeral-storage"}

var updateKinds = []string{"deployment", "statefulSet", "daemonSet", "rollout",
	"custom", "job", "family", "deploymentConfig"}

var reRFC1123 = regexp.MustCompile(`^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$`)

func (e *Engine) loadPolicyCRs(ctx context.Context) (map[string]*pyjson.Obj, []string) {
	out := map[string]*pyjson.Obj{}
	var order []string
	resp, err := e.Kube.GetJSON(ctx, crdBase("policies", e.Cfg.Namespace))
	if err != nil {
		return out, order
	}
	for _, it := range items(resp) {
		p := obj(it)
		name := getStr(getObj(p, "metadata"), "name")
		if _, ok := out[name]; !ok {
			order = append(order, name)
		}
		out[name] = p
	}
	return out, order
}

func rolloutToCron(arp *pyjson.Obj) *pyjson.Obj {
	tz := str(arp.GetD("timezone", "UTC"))
	days := getList(arp, "days")
	allDay := truthy(arp.GetD("allDay", true))
	if allDay && len(days) == 0 {
		return pyjson.NewObj().
			Set("scaleUp", "* * * * *").
			Set("scaleDown", "* * * * *").
			Set("timeZone", tz)
	}
	var parts []string
	for _, d := range days {
		parts = append(parts, pyStr(d))
	}
	dayStr := strings.Join(parts, ",")
	if dayStr == "" {
		dayStr = "*"
	}
	var cron string
	if allDay {
		cron = "* * * * " + dayStr
	} else {
		bh := strings.SplitN(str(arp.GetD("beginTime", "00:00")), ":", 2)[0]
		if bh == "" {
			bh = "*"
		}
		cron = "0 " + bh + " * * " + dayStr
	}
	return pyjson.NewObj().
		Set("scaleUp", cron).
		Set("scaleDown", cron).
		Set("timeZone", tz)
}

func pyStr(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case int64:
		return fmt.Sprintf("%d", x)
	case int:
		return fmt.Sprintf("%d", x)
	case float64:
		return pyjson.FloatRepr(x)
	case bool:
		if x {
			return "True"
		}
		return "False"
	case nil:
		return "None"
	}
	return fmt.Sprintf("%v", v)
}

// limitRatioCaps copies the ratio-boundary settings (min limit / max limit / max
// increase factor) that apply to BOTH ratio strategies.
func limitRatioCaps(lc, out *pyjson.Obj) {
	for _, cap := range []string{"minLimit", "maxLimit", "maxIncreaseFactor"} {
		if v := lc.GetD(cap, nil); v != nil && v != "" {
			out.Set(cap, v)
		}
	}
	if !out.Has("maxIncreaseFactor") {
		if v := lc.GetD("maxRecommendedLimitToOriginalLimitRatio", nil); v != nil && v != "" {
			out.Set("maxIncreaseFactor", v)
		}
	}
}

func limitDetail(lc *pyjson.Obj) *pyjson.Obj {
	if truthy(lc.GetD("noLimit", nil)) {
		return pyjson.NewObj().Set("strategy", "noLimit")
	}
	ratioRaw := firstTruthy(lc.GetD("limitToRequestRatio", nil), lc.GetD("setLimitRequestRatio", nil))
	ratio, _ := toFloatLoose(ratioRaw)
	hasRatio := lc.Has("limitToRequestRatio") || lc.Has("setLimitRequestRatio")
	if truthy(lc.GetD("equalsToRequest", nil)) || (hasRatio && ratio == 1) {
		return pyjson.NewObj().Set("strategy", "equalsToRequest")
	}
	if truthy(lc.GetD("setLimit", nil)) {
		return pyjson.NewObj().Set("strategy", "setLimit").Set("setLimit", lc.GetD("setLimit", nil))
	}
	if truthy(lc.GetD("keepLimitRequestRatio", nil)) {
		out := pyjson.NewObj().Set("strategy", "keepLimitRequestRatio")
		limitRatioCaps(lc, out)
		return out
	}
	if truthy(ratioRaw) {
		out := pyjson.NewObj().Set("strategy", "ratio").
			Set("limitToRequestRatio", ratioRaw)
		limitRatioCaps(lc, out)
		return out
	}
	return pyjson.NewObj().Set("strategy", "keepLimit")
}

func (e *Engine) policyDetailFromSpec(name string, spec *pyjson.Obj, builtin bool) *pyjson.Obj {
	rc := getObj(spec, "requestsConfigs")
	rsp := getObj(getObj(spec, "policyOptimize"), "rightSizePolicy")
	rspRC := getObj(rsp, "requestsConfigs")
	if rc.Len() == 0 {
		// builtin CRs store requestsConfigs ONLY at the canonical nested path
		// (spec.policyOptimize.rightSizePolicy.requestsConfigs)
		rc = rspRC
	}
	wbr := obj(rsp.GetD("windowByResource", nil))
	if wbr.Len() == 0 {
		wbr = getObj(spec, "windowByResource")
	}
	fast := getObj(getObj(spec, "policyOptimize"), "fastReaction")
	ah := getObj(spec, "autoHealing")
	up := getObj(spec, "updatePolicy")
	ip := getObj(up, "inPlaceUpdateStrategy")
	lc := getObj(rsp, "limitConfigs")
	if lc.Len() == 0 {
		lc = getObj(spec, "limitConfigs")
	}
	ubt := getObj(up, "updateByTypeMode")

	win := func(r string) any {
		if v := wbr.GetD(r, nil); truthy(v) {
			return v
		}
		if v := spec.GetD("window", nil); truthy(v) {
			return v
		}
		return "24h"
	}
	num := func(d *pyjson.Obj, k string, def any) any {
		if v := d.GetD(k, nil); v != nil {
			return v
		}
		return def
	}
	burst := getObj(fast, "enabled").GetD("cpu", nil)
	if burst == nil {
		burst = getObj(spec, "burstReaction").GetD("enabled", true)
	}
	sched := pyjson.NewObj().Set("defaultPolicy", "").Set("rules", []any{})
	psc := getObj(getObj(spec, "policySchedule"), "schedulePolicyConfig")
	if psc.Len() > 0 {
		sched.Set("defaultPolicy", psc.GetD("defaultPolicy", ""))
		rules := []any{}
		for _, rv := range getList(psc, "rules") {
			r := obj(rv)
			hw := "current"
			if str(r.GetD("historyWindowDataPoints", nil)) == "all" {
				hw = "all"
			}
			periods := []any{}
			for _, pv := range getList(r, "periods") {
				wc := getObj(obj(pv), "weeklyConfig")
				bt := str(wc.GetD("beginTime", "00:00"))
				et := str(wc.GetD("endTime", "00:00"))
				periods = append(periods, pyjson.NewObj().
					Set("days", wc.GetD("days", []any{})).
					Set("allDay", bt == "00:00" && (et == "00:00" || et == "23:59")).
					Set("beginTime", bt).
					Set("endTime", et))
			}
			rules = append(rules, pyjson.NewObj().
				Set("policyName", r.GetD("policyName", "")).
				Set("sleep", truthy(r.GetD("sleep", false))).
				Set("historyWindowDataPoints", hw).
				Set("periods", periods))
		}
		sched.Set("rules", rules)
	}
	perRes := func(f func(r string) any) *pyjson.Obj {
		out := pyjson.NewObj()
		for _, r := range res3 {
			out.Set(r, f(r))
		}
		return out
	}
	arp := up.GetD("allowedRolloutPeriod", nil)
	if !truthy(arp) {
		arp = pyjson.NewObj().
			Set("timezone", "UTC").
			Set("days", []any{}).
			Set("allDay", true).
			Set("beginTime", "00:00").
			Set("endTime", "00:00")
	}
	minRep, _ := toFloatLoose(up.GetD("minReplicas", int64(1)))
	readiness, okR := toFloatLoose(up.GetD("podMinReadySeconds", int64(5)))
	if !okR {
		readiness = 0
	}
	jv := getObj(spec, "javaOptimization")
	return pyjson.NewObj().
		Set("name", name).
		Set("builtin", builtin).
		Set("type", spec.GetD("type", "Optimize")).
		Set("request", pyjson.NewObj().
			Set("window", perRes(win)).
			Set("headroom", perRes(func(r string) any { return num(getObj(rc, r), "headroomPercentage", 0) })).
			Set("percentile", perRes(func(r string) any { return num(getObj(rc, r), "percentilePercentage", 95) })).
			Set("minAllowed", perRes(func(r string) any { return getObj(rc, r).GetD("minAllowed", "") })).
			Set("maxAllowed", perRes(func(r string) any { return getObj(rc, r).GetD("maxAllowed", "") })).
			Set("keepRequest", pyjson.NewObj().
				Set("cpu", truthy(getObj(rspRC, "cpu").GetD("keepRequest", false))).
				Set("memory", truthy(getObj(rspRC, "memory").GetD("keepRequest", false)))).
			Set("integerCPU", truthy(getObj(rspRC, "cpu").GetD("integerCPU", rsp.GetD("cpuInteger", false)))).
			Set("memReplicasPercentile", rsp.GetD("memReplicasPercentile", nil)).
			Set("setMaxAllowedAsNodeSize", truthy(rsp.GetD("setMaxAllowedAsNodeSize", false))).
			Set("burstReaction", truthy(burst)).
			Set("autoHealing", truthy(ah.GetD("enabledV2", ah.GetD("enabled", true)))).
			Set("bootTime", truthy(rsp.GetD("bootTimeOptimizationEnabled", true))).
			Set("eph", pyjson.NewObj().
				Set("enabled", truthy(rsp.GetD("ephemeralStorageOptimizationEnabled", true))).
				Set("allowReduction", truthy(rsp.GetD("allowEphemeralStorageReduction", false))).
				Set("autoHealing", truthy(getObj(ah, "enabledByResource").GetD("ephemeral-storage", true))))).
		Set("limit", perRes(func(r string) any { return limitDetail(getObj(lc, r)) })).
		Set("automation", pyjson.NewObj().
			Set("updateByTypeMode", func() *pyjson.Obj {
				out := pyjson.NewObj()
				for _, k := range updateKinds {
					lookup := k
					if k == "rollout" {
						lookup = "argoRollout"
					}
					def := up.GetD("updateMode", "Ongoing")
					if k == "custom" && !ubt.Has("custom") {
						def = "OnCreate"
					}
					out.Set(k, ubt.GetD(lookup, def))
				}
				return out
			}()).
			Set("inPlace", pyjson.NewObj().
				Set("ongoing", truthy(ip.GetD("enableInPlaceForOngoingStrategy", up.GetD("inPlace", true)))).
				Set("onCreate", truthy(ip.GetD("enableInPlaceForUponPodCreationStrategy", false)))).
			Set("zeroDowntime", pyjson.NewObj().
				Set("singleReplica", truthy(up.GetD("allowRollingUpdate", true))).
				Set("multiReplicaRestrictedScaleDown", truthy(up.GetD("considerDeploymentStrategy", false)))).
			Set("ensureHA", pyjson.NewObj().
				Set("ensureAtLeastOne", int(minRep) >= 1).
				Set("respectUnevictable", !truthy(up.GetD("ignoreAutoscalerSafeToEvictAnnotations", false)))).
			Set("readinessBufferSeconds", int(readiness)).
			Set("updateHPATriggers", truthy(getObj(spec, "hpa").GetD("manageHPA", true))).
			Set("activeEnforcement", truthy(up.GetD("activelyEnforceOptimizationByContext", false))).
			Set("optimizeInitContainers", truthy(rsp.GetD("initContainersOptimizationEnabled", false))).
			Set("optimizeUponAutomation", !truthy(up.GetD("skipRolloutUponAutomation", false))).
			Set("binPackUnevictable", truthy(up.GetD("binPackUnEvictablePods", false))).
			Set("nodeCappingAuto", truthy(getObj(rsp, "nodeCappingPolicy").GetD("nodeCappingAuto", false))).
			Set("requiredWindowCoveragePercentage", num(up, "requiredWindowCoveragePercentage", 2)).
			Set("allowedRolloutPeriod", arp)).
		Set("schedule", sched).
		Set("java", pyjson.NewObj().
			Set("realUsage", truthy(jv.GetD("realUsage", true))).
			Set("memoryOptimization", truthy(jv.GetD("memoryOptimization", true))).
			Set("gcOptimization", truthy(jv.GetD("gcOptimization", true))).
			Set("oomAutoHealing", truthy(jv.GetD("oomAutoHealing", true))))
}

func editorToSpec(d *pyjson.Obj) *pyjson.Obj {
	req := getObj(d, "request")
	auto := getObj(d, "automation")
	win := getObj(req, "window")
	head := getObj(req, "headroom")
	pct := getObj(req, "percentile")
	mn := getObj(req, "minAllowed")
	mx := getObj(req, "maxAllowed")
	keep := getObj(req, "keepRequest")
	eph := getObj(req, "eph")
	ubt := getObj(auto, "updateByTypeMode")
	ip := getObj(auto, "inPlace")
	zd := getObj(auto, "zeroDowntime")
	ha := getObj(auto, "ensureHA")
	arp := getObj(auto, "allowedRolloutPeriod")
	cov := auto.GetD("requiredWindowCoveragePercentage", 2)

	wv := func(r string) any {
		if v := win.GetD(r, nil); truthy(v) {
			return v
		}
		if v := win.GetD("cpu", nil); truthy(v) {
			return v
		}
		return "24h"
	}
	rcEntry := func(r string) *pyjson.Obj {
		e := pyjson.NewObj().
			Set("percentilePercentage", pct.GetD(r, 95)).
			Set("headroomPercentage", head.GetD(r, 0))
		if truthy(mn.GetD(r, nil)) {
			e.Set("minAllowed", mn.GetD(r, nil))
		}
		if truthy(mx.GetD(r, nil)) {
			e.Set("maxAllowed", mx.GetD(r, nil))
		}
		return e
	}
	lcEntry := func(r string) *pyjson.Obj {
		l := getObj(getObj(d, "limit"), r)
		switch str(l.GetD("strategy", "keepLimit")) {
		case "noLimit":
			return pyjson.NewObj().Set("noLimit", true)
		case "equalsToRequest":
			return pyjson.NewObj().Set("equalsToRequest", true)
		case "setLimit":
			return pyjson.NewObj().Set("setLimit", l.GetD("setLimit", ""))
		case "keepLimitRequestRatio":
			entry := pyjson.NewObj().Set("keepLimitRequestRatio", true)
			for _, cap := range []string{"minLimit", "maxLimit", "maxIncreaseFactor"} {
				if v := l.GetD(cap, nil); v != nil && v != "" {
					entry.Set(cap, v)
				}
			}
			return entry
		case "ratio":
			entry := pyjson.NewObj().Set("limitToRequestRatio", l.GetD("limitToRequestRatio", 1))
			for _, cap := range []string{"minLimit", "maxLimit", "maxIncreaseFactor"} {
				if v := l.GetD(cap, nil); v != nil && v != "" {
					entry.Set(cap, v)
				}
			}
			return entry
		}
		return pyjson.NewObj().Set("keepLimit", true)
	}
	perRes := func(f func(r string) any) *pyjson.Obj {
		out := pyjson.NewObj()
		for _, r := range res3 {
			out.Set(r, f(r))
		}
		return out
	}
	flatLimit := pyjson.NewObj()
	for _, r := range []string{"cpu", "memory"} {
		s := str(getObj(getObj(d, "limit"), r).GetD("strategy", "keepLimit"))
		if s == "noLimit" {
			flatLimit.Set(r, "noLimit")
		} else {
			flatLimit.Set(r, "keepOriginal")
		}
	}
	burst := truthy(req.GetD("burstReaction", true))
	autoheal := truthy(req.GetD("autoHealing", true))
	rolloutMode := str(ubt.GetD("rollout", ubt.GetD("deployment", "Ongoing")))
	byType := pyjson.NewObj()
	for _, k := range updateKinds {
		outK := k
		if k == "rollout" {
			outK = "argoRollout"
		}
		byType.Set(outK, ubt.GetD(k, "Ongoing"))
	}
	byType.Set("rollout", rolloutMode) // keep both spellings for round-trip
	minRep := 0
	if truthy(ha.GetD("ensureAtLeastOne", true)) {
		minRep = 1
	}
	updMode := "Ongoing"
	if rolloutMode == "Ongoing" || rolloutMode == "OnCreate" {
		updMode = rolloutMode
	}
	spec := pyjson.NewObj().
		Set("type", d.GetD("type", "Optimize")).
		Set("window", wv("cpu")).
		Set("windowByResource", perRes(wv)).
		Set("requestsConfigs", perRes(func(r string) any { return rcEntry(r) })).
		Set("limitStrategy", flatLimit).
		Set("limitConfigs", perRes(func(r string) any { return lcEntry(r) })).
		Set("burstReaction", pyjson.NewObj().Set("enabled", burst)).
		Set("autoHealing", pyjson.NewObj().
			Set("enabled", autoheal).
			Set("enabledV2", autoheal).
			Set("enabledByResource", pyjson.NewObj().
				Set("cpu", autoheal).
				Set("memory", autoheal).
				Set("ephemeral-storage", truthy(eph.GetD("autoHealing", true)))).
			Set("minSteps", pyjson.NewObj().Set("cpu", 1).Set("memory", 1)).
			Set("multiplier", pyjson.NewObj().Set("cpu", 1.2).Set("memory", 1.2))).
		Set("hpa", pyjson.NewObj().Set("manageHPA", truthy(auto.GetD("updateHPATriggers", true)))).
		Set("ensureHighAvailability", pyjson.NewObj().
			Set("minReplicas", minRep).
			Set("respectUnevictable", truthy(ha.GetD("respectUnevictable", true)))).
		Set("requiredWindowCoveragePercentage", cov).
		Set("policyOptimize", pyjson.NewObj().
			Set("fastReaction", pyjson.NewObj().
				Set("enabled", pyjson.NewObj().Set("cpu", burst).Set("memory", burst))).
			Set("rightSizePolicy", pyjson.NewObj().
				Set("bootTimeOptimizationEnabled", truthy(req.GetD("bootTime", true))).
				Set("initContainersOptimizationEnabled", truthy(auto.GetD("optimizeInitContainers", false))).
				Set("ephemeralStorageOptimizationEnabled", truthy(eph.GetD("enabled", true))).
				Set("allowEphemeralStorageReduction", truthy(eph.GetD("allowReduction", false))).
				Set("cpuInteger", truthy(req.GetD("integerCPU", false))).
				Set("setMaxAllowedAsNodeSize", truthy(req.GetD("setMaxAllowedAsNodeSize", false))).
				Set("memReplicasPercentile", req.GetD("memReplicasPercentile", nil)).
				Set("nodeCappingPolicy", pyjson.NewObj().
					Set("nodeCappingAuto", truthy(auto.GetD("nodeCappingAuto", true)))).
				Set("windowByResource", perRes(wv)).
				Set("requestsConfigs", pyjson.NewObj().
					Set("cpu", rcEntry("cpu").
						Set("keepRequest", truthy(keep.GetD("cpu", false))).
						Set("integerCPU", truthy(req.GetD("integerCPU", false)))).
					Set("memory", rcEntry("memory").
						Set("keepRequest", truthy(keep.GetD("memory", false)))).
					Set("ephemeral-storage", rcEntry("ephemeral-storage"))).
				Set("limitConfigs", perRes(func(r string) any { return lcEntry(r) })))).
		Set("updatePolicy", pyjson.NewObj().
			Set("updateMode", updMode).
			Set("inPlace", truthy(ip.GetD("ongoing", true))).
			Set("updateByTypeMode", byType).
			Set("inPlaceUpdateStrategy", pyjson.NewObj().
				Set("enableInPlaceForOngoingStrategy", truthy(ip.GetD("ongoing", true))).
				Set("enableInPlaceForUponPodCreationStrategy", truthy(ip.GetD("onCreate", false)))).
			Set("allowRollingUpdate", truthy(zd.GetD("singleReplica", true))).
			Set("considerDeploymentStrategy", truthy(zd.GetD("multiReplicaRestrictedScaleDown", false))).
			Set("minReplicas", minRep).
			Set("ignoreAutoscalerSafeToEvictAnnotations", !truthy(ha.GetD("respectUnevictable", true))).
			Set("podMinReadySeconds", auto.GetD("readinessBufferSeconds", 5)).
			Set("activelyEnforceOptimizationByContext", truthy(auto.GetD("activeEnforcement", false))).
			Set("skipRolloutUponAutomation", !truthy(auto.GetD("optimizeUponAutomation", false))).
			Set("binPackUnEvictablePods", truthy(auto.GetD("binPackUnevictable", false))).
			Set("requiredWindowCoveragePercentage", cov).
			Set("allowedRolloutPeriod", arp).
			Set("evictionSchedule", rolloutToCron(arp)))
	jv := getObj(d, "java")
	spec.Set("javaOptimization", pyjson.NewObj().
		Set("realUsage", truthy(jv.GetD("realUsage", true))).
		Set("memoryOptimization", truthy(jv.GetD("memoryOptimization", true))).
		Set("gcOptimization", truthy(jv.GetD("gcOptimization", true))).
		Set("oomAutoHealing", truthy(jv.GetD("oomAutoHealing", true))))
	sch := getObj(d, "schedule")
	if len(getList(sch, "rules")) > 0 {
		days := func(p *pyjson.Obj) []any {
			dv := p.GetD("days", nil)
			if dv == "all" {
				return []any{int64(0), int64(1), int64(2), int64(3), int64(4), int64(5), int64(6)}
			}
			if l, ok := dv.([]any); ok {
				return l
			}
			return []any{}
		}
		rules := []any{}
		for _, rv := range getList(sch, "rules") {
			r := obj(rv)
			periods := []any{}
			for _, pv := range getList(r, "periods") {
				p := obj(pv)
				bt, et := "00:00", "23:59"
				if !truthy(p.GetD("allDay", nil)) {
					bt = str(p.GetD("beginTime", "00:00"))
					et = str(p.GetD("endTime", "23:59"))
				}
				periods = append(periods, pyjson.NewObj().
					Set("weeklyConfig", pyjson.NewObj().
						Set("days", days(p)).
						Set("beginTime", bt).
						Set("endTime", et)))
			}
			rules = append(rules, pyjson.NewObj().
				Set("policyName", r.GetD("policyName", nil)).
				Set("sleep", truthy(r.GetD("sleep", nil))).
				Set("historyWindowDataPoints", r.GetD("historyWindowDataPoints", "current")).
				Set("periods", periods))
		}
		spec.Set("policySchedule", pyjson.NewObj().Set("schedulePolicyConfig", pyjson.NewObj().
			Set("defaultPolicy", sch.GetD("defaultPolicy", "")).
			Set("rules", rules)))
	}
	return spec
}

func (e *Engine) PolicyDetail(ctx context.Context, name string) *pyjson.Obj {
	builtin := e.builtinPolicyNameSet()[name]
	crs, _ := e.loadPolicyCRs(ctx)
	if cr, ok := crs[name]; ok {
		return e.policyDetailFromSpec(name, getObj(cr, "spec"), builtin)
	}
	for _, d := range e.builtinPolicies() {
		if d.name == name {
			return e.policyDetailFromSpec(name, e.policySpec(d.args), true)
		}
	}
	return nil
}

func (e *Engine) PolicySave(ctx context.Context, body *pyjson.Obj) (int, *pyjson.Obj) {
	name := strings.TrimSpace(str(body.GetD("name", "")))
	isNew := truthy(body.GetD("isNew", nil))
	if name == "" || !reRFC1123.MatchString(name) {
		return 400, pyjson.NewObj().Set("ok", false).Set("message", "a valid lowercase name is required")
	}
	if e.builtinPolicyNameSet()[name] {
		return 400, pyjson.NewObj().Set("ok", false).Set("message", "built-in policies are read-only — duplicate to edit")
	}
	spec := editorToSpec(body)
	path := crdBase("policies", e.Cfg.Namespace)
	desc := str(body.GetD("description", ""))
	if desc == "" {
		desc = "This is a custom policy created by the user."
	}
	var err error
	if isNew {
		cr := pyjson.NewObj().
			Set("apiVersion", crdGroup+"/"+crdVer).
			Set("kind", "Policy").
			Set("metadata", pyjson.NewObj().
				Set("name", name).
				Set("namespace", e.Cfg.Namespace).
				Set("labels", pyjson.NewObj().
					Set("app.kubernetes.io/part-of", "coolscaler").
					Set("coolscaler.sh/builtin-policy", "false")).
				Set("annotations", pyjson.NewObj().Set("coolscaler.sh/description", desc))).
			Set("spec", spec)
		_, err = e.k8sReq(ctx, "POST", path, cr, "application/json")
	} else {
		_, err = e.k8sReq(ctx, "PATCH", path+"/"+name,
			pyjson.NewObj().Set("spec", spec), "application/merge-patch+json")
	}
	if err != nil {
		if code, ok := isHTTPError(err); ok {
			detail := err.Error()
			if len(detail) > 200 {
				detail = detail[:200]
			}
			return 400, pyjson.NewObj().Set("ok", false).
				Set("message", fmt.Sprintf("save failed: HTTP %d %s", code, detail))
		}
		return 400, pyjson.NewObj().Set("ok", false).Set("message", "save failed: "+err.Error())
	}
	verb := "updated"
	if isNew {
		verb = "created"
	}
	e.audit("PolicySave", name, "", verb, "user")
	return 200, pyjson.NewObj().Set("ok", true).Set("name", name).Set("message", "Policy saved")
}

func (e *Engine) PolicyDuplicate(ctx context.Context, body *pyjson.Obj) (int, *pyjson.Obj) {
	src := strings.TrimSpace(str(body.GetD("source", "")))
	newName := strings.TrimSpace(str(body.GetD("name", "")))
	if newName == "" || !reRFC1123.MatchString(newName) {
		return 400, pyjson.NewObj().Set("ok", false).Set("message", "a valid new name is required")
	}
	crs, _ := e.loadPolicyCRs(ctx)
	if e.builtinPolicyNameSet()[newName] || crs[newName] != nil {
		return 400, pyjson.NewObj().Set("ok", false).Set("message", "that name is already in use")
	}
	detail := e.PolicyDetail(ctx, src)
	if detail == nil {
		return 400, pyjson.NewObj().Set("ok", false).Set("message", "source policy not found")
	}
	detail.Set("name", newName)
	detail.Set("isNew", true)
	detail.Set("builtin", false)
	detail.Set("description", "Duplicated from "+src+".")
	return e.PolicySave(ctx, detail)
}

func (e *Engine) PolicyDelete(ctx context.Context, body *pyjson.Obj) (int, *pyjson.Obj) {
	name := strings.TrimSpace(str(body.GetD("name", "")))
	if e.builtinPolicyNameSet()[name] {
		return 400, pyjson.NewObj().Set("ok", false).Set("message", "built-in policies cannot be deleted")
	}
	if _, err := e.k8sReq(ctx, "DELETE", crdBase("policies", e.Cfg.Namespace)+"/"+name, nil, "application/json"); err != nil {
		return 400, pyjson.NewObj().Set("ok", false).Set("message", "delete failed: "+err.Error())
	}
	e.audit("PolicyDelete", name, "", "", "user")
	return 200, pyjson.NewObj().Set("ok", true).Set("message", "Policy deleted")
}

func (e *Engine) PolicySimulate(body *pyjson.Obj) *pyjson.Obj {
	warnings := []any{}
	req := getObj(body, "request")
	for _, r := range []string{"cpu", "memory"} {
		if p := getObj(req, "percentile").GetD(r, nil); p != nil {
			if f, ok := toFloatLoose(p); ok && (f < 50 || f > 100) {
				warnings = append(warnings, fmt.Sprintf("%s percentile %s%% is unusual (expected 50–100)", r, pyStr(p)))
			}
		}
		if h := getObj(req, "headroom").GetD(r, nil); h != nil {
			if f, ok := toFloatLoose(h); ok && f > 100 {
				warnings = append(warnings, fmt.Sprintf("%s headroom %s%% is very high", r, pyStr(h)))
			}
		}
	}
	spec := editorToSpec(body)
	kb := e.policyKnobs(spec)
	return pyjson.NewObj().
		Set("ok", true).
		Set("warnings", warnings).
		Set("spec", spec).
		Set("sampleImpact", pyjson.NewObj().
			Set("cpuPct", kb.cpuPct).
			Set("memPct", kb.memPct).
			Set("cpuHeadroom", pyjson.RoundInt((kb.cpuHead-1)*100)).
			Set("memHeadroom", pyjson.RoundInt((kb.memHead-1)*100)).
			Set("window", kb.window))
}

func (e *Engine) SchedulePolicySave(ctx context.Context, body *pyjson.Obj) (int, *pyjson.Obj) {
	name := strings.TrimSpace(str(body.GetD("name", "")))
	if name == "" || !reRFC1123.MatchString(name) {
		return 400, pyjson.NewObj().Set("ok", false).Set("message", "a valid name is required")
	}
	if e.builtinPolicyNameSet()[name] {
		return 400, pyjson.NewObj().Set("ok", false).Set("message", "name collides with a built-in policy")
	}
	sch := getObj(body, "schedule")
	var overrides []scheduleOverride
	for _, rv := range getList(sch, "rules") {
		r := obj(rv)
		var periods []schedulePeriod
		for _, pv := range getList(r, "periods") {
			p := obj(pv)
			allDay := truthy(p.GetD("allDay", true))
			var days []int64
			if p.GetD("days", nil) == "all" {
				days = []int64{0, 1, 2, 3, 4, 5, 6}
			} else {
				for _, dv := range getList(p, "days") {
					if f, ok := toFloatLoose(dv); ok {
						days = append(days, int64(f))
					}
				}
			}
			begin, end := "00:00", "00:00"
			if !allDay {
				begin = str(p.GetD("beginTime", "00:00"))
				end = str(p.GetD("endTime", "00:00"))
			}
			periods = append(periods, schedulePeriod{days: days, begin: begin, end: end})
		}
		dp := "currentPeriods"
		if str(r.GetD("historyWindowDataPoints", nil)) == "all" {
			dp = "all"
		}
		overrides = append(overrides, scheduleOverride{
			policyName: str(r.GetD("policyName", "production")),
			dataPoints: dp,
			sleep:      truthy(r.GetD("sleep", false)),
			periods:    periods,
		})
	}
	desc := str(body.GetD("description", "User-defined schedule policy."))
	entry := &schedulePolicy{
		name:          name,
		defaultPolicy: str(sch.GetD("defaultPolicy", "production")),
		desc:          desc,
		overrides:     overrides,
	}
	if e.Cfg.WriteRecommendationCRs {
		spec := e.schedulePolicySpec(entry)
		path := crdBase("policies", e.Cfg.Namespace)
		if _, err := e.k8sReq(ctx, "PATCH", path+"/"+name,
			pyjson.NewObj().Set("spec", spec), "application/merge-patch+json"); err != nil {
			if _, ok := isHTTPError(err); ok {
				cr := pyjson.NewObj().
					Set("apiVersion", crdGroup+"/"+crdVer).
					Set("kind", "Policy").
					Set("metadata", pyjson.NewObj().
						Set("name", name).
						Set("namespace", e.Cfg.Namespace).
						Set("labels", pyjson.NewObj().
							Set("app.kubernetes.io/part-of", "coolscaler").
							Set("coolscaler.sh/schedule-policy", "true")).
						Set("annotations", pyjson.NewObj().Set("coolscaler.sh/description", entry.desc))).
					Set("spec", spec)
				if _, perr := e.k8sReq(ctx, "POST", path, cr, "application/json"); perr != nil {
					e.Log.Info("schedule_policy_save failed", "name", name, "err", perr)
				}
			} else {
				e.Log.Info("schedule_policy_save failed", "name", name, "err", err)
			}
		}
	}
	e.mu.Lock()
	kept := e.schedulePolicies[:0]
	for _, s := range e.schedulePolicies {
		if s.name != name {
			kept = append(kept, s)
		}
	}
	e.schedulePolicies = append(kept, entry)
	e.scheduleByName[name] = entry
	e.mu.Unlock()
	e.audit("SchedulePolicySave", name, "", "", "user")
	return 200, pyjson.NewObj().Set("ok", true).Set("name", name)
}

func (e *Engine) SchedulePolicyDelete(ctx context.Context, body *pyjson.Obj) (int, *pyjson.Obj) {
	name := strings.TrimSpace(str(body.GetD("name", "")))
	_, _ = e.k8sReq(ctx, "DELETE", crdBase("policies", e.Cfg.Namespace)+"/"+name, nil, "application/json")
	e.mu.Lock()
	kept := e.schedulePolicies[:0]
	for _, s := range e.schedulePolicies {
		if s.name != name {
			kept = append(kept, s)
		}
	}
	e.schedulePolicies = kept
	delete(e.scheduleByName, name)
	e.mu.Unlock()
	e.audit("SchedulePolicyDelete", name, "", "", "user")
	return 200, pyjson.NewObj().Set("ok", true).Set("name", name)
}

func (e *Engine) PolicyRulesSave(ctx context.Context, body *pyjson.Obj) (int, *pyjson.Obj) {
	newRules := []any{}
	for _, rv := range getList(body, "rules") {
		r := obj(rv)
		groups := []any{}
		for _, gv := range getList(r, "rules") {
			var group []any
			if g, ok := gv.(*pyjson.Obj); ok {
				group = getList(g, "identifiers")
			} else if l, ok := gv.([]any); ok {
				group = l
			}
			idents := []any{}
			for _, iv := range group {
				i := obj(iv)
				if !truthy(i.GetD("type", nil)) {
					continue
				}
				idents = append(idents, pyjson.NewObj().
					Set("type", i.GetD("type", nil)).
					Set("key", i.GetD("key", "")).
					Set("value", i.GetD("value", "")))
			}
			if len(idents) > 0 {
				groups = append(groups, pyjson.NewObj().Set("identifiers", idents))
			}
		}
		if truthy(r.GetD("policyName", nil)) && len(groups) > 0 {
			newRules = append(newRules, pyjson.NewObj().
				Set("policyName", r.GetD("policyName", nil)).
				Set("tag", r.GetD("tag", "")).
				Set("rules", groups))
		}
	}
	e.mu.Lock()
	e.policyRules = newRules
	e.mu.Unlock()
	if e.Cfg.WriteRecommendationCRs {
		cmPath := "/api/v1/namespaces/" + e.Cfg.Namespace + "/configmaps/coolscaler-policy-rules"
		data := pyjson.NewObj().Set("rules.json", string(pyjson.Marshal(newRules)))
		if _, err := e.k8sReq(ctx, "PATCH", cmPath,
			pyjson.NewObj().Set("data", data), "application/merge-patch+json"); err != nil {
			if _, ok := isHTTPError(err); ok {
				cm := pyjson.NewObj().
					Set("apiVersion", "v1").
					Set("kind", "ConfigMap").
					Set("metadata", pyjson.NewObj().
						Set("name", "coolscaler-policy-rules").
						Set("namespace", e.Cfg.Namespace)).
					Set("data", data)
				if _, perr := e.k8sReq(ctx, "POST", "/api/v1/namespaces/"+e.Cfg.Namespace+"/configmaps", cm, "application/json"); perr != nil {
					e.Log.Info("policy_rules_save failed", "err", perr)
				}
			} else {
				e.Log.Info("policy_rules_save failed", "err", err)
			}
		}
	}
	e.audit("PolicyRulesSave", "policy-rules", "", fmt.Sprintf("%d rules", len(newRules)), "user")
	return 200, pyjson.NewObj().Set("ok", true).Set("count", len(newRules))
}

// HPA policy editor.

func hpaStrategy(kb *pyjson.Obj) string {
	if truthy(kb.GetD("keepMin", nil)) {
		return "keepAll"
	}
	if truthy(kb.GetD("setMin", nil)) {
		return "setAll"
	}
	gen, pred := truthy(kb.GetD("genEnabled", nil)), truthy(kb.GetD("predEnabled", nil))
	switch {
	case gen && pred:
		return "historyAll"
	case pred && !gen:
		return "historyPredictable"
	case gen && !pred:
		return "historyStatic"
	}
	return "keepAll"
}

func (e *Engine) hpaAllDesc() map[string]string {
	d := map[string]string{}
	for _, p := range replicasPolicies {
		d[p.name] = p.desc
	}
	e.mu.Lock()
	for n, v := range e.hpaPolicyDescOv {
		d[n] = v
	}
	e.mu.Unlock()
	return d
}

func (e *Engine) HpaPolicyDetail(name string) *pyjson.Obj {
	e.mu.Lock()
	sched := e.hpaSched[name]
	e.mu.Unlock()
	if sched != nil {
		names := []any{}
		for _, p := range replicasPolicies {
			names = append(names, p.name)
		}
		e.mu.Lock()
		var userNames []string
		for n := range e.hpaPolicyOverrides {
			if !hpaBuiltinNames[n] {
				userNames = append(userNames, n)
			}
		}
		e.mu.Unlock()
		sortStrings(userNames)
		for _, n := range userNames {
			names = append(names, n)
		}
		return pyjson.NewObj().
			Set("name", name).
			Set("builtin", false).
			Set("type", "Schedule").
			Set("description", e.hpaAllDesc()[name]).
			Set("defaultPolicy", sched.GetD("defaultPolicy", "production")).
			Set("rules", sched.GetD("rules", []any{})).
			Set("policyNames", names)
	}
	kb := e.hpaAllKnobs()[name]
	if kb == nil {
		return nil
	}
	setMin := kb.GetD("setMin", nil)
	if !truthy(setMin) {
		setMin = 1
	}
	setMax := kb.GetD("setMax", nil)
	setMaxOut := setMax
	if !truthy(setMaxOut) {
		setMaxOut = 0
	}
	return pyjson.NewObj().
		Set("name", name).
		Set("builtin", hpaBuiltinNames[name]).
		Set("description", e.hpaAllDesc()[name]).
		Set("strategy", hpaStrategy(kb)).
		Set("minBoundary", kb.GetD("minAllowed", nil)).
		Set("minHeadroom", kb.GetD("headroom", 0)).
		Set("capByOrigin", truthy(kb.GetD("capByOrigin", true))).
		Set("setMin", setMin).
		Set("setMaxEnabled", setMax != nil).
		Set("setMax", setMaxOut).
		Set("requiredHistory", kb.GetD("coverage", nil)).
		Set("prediction", kb.GetD("predictionEnabled", nil)).
		Set("lookAhead", kb.GetD("lookAhead", nil)).
		Set("predHistoryWindow", "14d").
		Set("predMinEnabled", kb.GetD("predEnabled", nil)).
		Set("predWindow", kb.GetD("predWindow", nil)).
		Set("predPct", kb.GetD("predPct", nil)).
		Set("staticMinEnabled", kb.GetD("genEnabled", nil)).
		Set("staticWindow", kb.GetD("genWindow", nil)).
		Set("staticPct", kb.GetD("genPct", nil)).
		Set("threshold", pyjson.NewObj().
			Set("enabled", kb.GetD("thresholdEnabled", nil)).
			Set("requiredHistory", kb.GetD("requiredHistory", nil)).
			Set("historyWindow", kb.GetD("thHistoryWindow", "168h")).
			Set("maxBoundary", kb.GetD("maxDeviation", nil)))
}

func editorToHpaKnobs(body *pyjson.Obj) *pyjson.Obj {
	strat := str(body.GetD("strategy", "historyAll"))
	th := getObj(body, "threshold")
	iOf := func(v any, def int) int {
		if f, ok := toFloatLoose(v); ok {
			return int(f)
		}
		return def
	}
	var setMin, setMax any
	if strat == "setAll" {
		setMin = iOf(body.GetD("setMin", nil), 1)
	}
	if truthy(body.GetD("setMaxEnabled", nil)) {
		setMax = iOf(body.GetD("setMax", nil), 0)
	}
	return pyjson.NewObj().
		Set("genEnabled", strat == "historyAll" || strat == "historyStatic").
		Set("genPct", iOf(body.GetD("staticPct", nil), 80)).
		Set("genWindow", body.GetD("staticWindow", "168h")).
		Set("predEnabled", strat == "historyAll" || strat == "historyPredictable").
		Set("predPct", iOf(body.GetD("predPct", nil), 80)).
		Set("predWindow", body.GetD("predWindow", "168h")).
		Set("predictionEnabled", truthy(body.GetD("prediction", true))).
		Set("lookAhead", body.GetD("lookAhead", "20m")).
		Set("thresholdEnabled", truthy(th.GetD("enabled", false))).
		Set("maxDeviation", iOf(th.GetD("maxBoundary", nil), 50)).
		Set("requiredHistory", iOf(th.GetD("requiredHistory", nil), 4)).
		Set("thHistoryWindow", th.GetD("historyWindow", "168h")).
		Set("coverage", body.GetD("requiredHistory", "24h")).
		Set("minAllowed", iOf(body.GetD("minBoundary", nil), 1)).
		Set("capByOrigin", truthy(body.GetD("capByOrigin", true))).
		Set("setMin", setMin).
		Set("setMax", setMax).
		Set("keepMin", strat == "keepAll").
		Set("headroom", iOf(body.GetD("minHeadroom", nil), 0))
}

func (e *Engine) HpaPolicySave(ctx context.Context, body *pyjson.Obj) (int, *pyjson.Obj) {
	name := strings.TrimSpace(str(body.GetD("name", "")))
	isNew := truthy(body.GetD("isNew", nil))
	if name == "" || !reRFC1123.MatchString(name) {
		return 400, pyjson.NewObj().Set("ok", false).Set("message", "a valid lowercase name is required")
	}
	if hpaBuiltinNames[name] {
		return 400, pyjson.NewObj().Set("ok", false).Set("message", "built-in HPA policies are read-only — duplicate to edit")
	}
	path := crdBase("hpapolicies", e.Cfg.Namespace)
	upsert := func(spec *pyjson.Obj, cr *pyjson.Obj) (int, *pyjson.Obj, bool) {
		var err error
		if isNew {
			_, err = e.k8sReq(ctx, "POST", path, cr, "application/json")
		} else {
			_, err = e.k8sReq(ctx, "PATCH", path+"/"+name,
				pyjson.NewObj().Set("spec", spec), "application/merge-patch+json")
		}
		if err != nil {
			if code, ok := isHTTPError(err); ok {
				if isNew && code == 409 {
					if _, err2 := e.k8sReq(ctx, "PATCH", path+"/"+name,
						pyjson.NewObj().Set("spec", spec), "application/merge-patch+json"); err2 != nil {
						return 400, pyjson.NewObj().Set("ok", false).Set("message", "save failed: "+err2.Error()), false
					}
					return 0, nil, true
				}
				detail := err.Error()
				if len(detail) > 200 {
					detail = detail[:200]
				}
				return 400, pyjson.NewObj().Set("ok", false).
					Set("message", fmt.Sprintf("save failed: HTTP %d %s", code, detail)), false
			}
			return 400, pyjson.NewObj().Set("ok", false).Set("message", "save failed: "+err.Error()), false
		}
		return 0, nil, true
	}
	if str(body.GetD("type", nil)) == "Schedule" {
		rules := []any{}
		crRules := []any{}
		for _, rv := range getList(body, "rules") {
			r := obj(rv)
			var days []any
			for _, dv := range getList(r, "days") {
				if f, ok := toFloatLoose(dv); ok {
					days = append(days, int64(f))
				}
			}
			if days == nil {
				days = []any{}
			}
			begin := r.GetD("beginTime", "00:00")
			end := r.GetD("endTime", "23:59")
			rules = append(rules, pyjson.NewObj().
				Set("policyName", r.GetD("policyName", "production")).
				Set("days", days).
				Set("beginTime", begin).
				Set("endTime", end))
			crRules = append(crRules, pyjson.NewObj().
				Set("policyName", r.GetD("policyName", "production")).
				Set("periods", []any{pyjson.NewObj().
					Set("weeklyConfig", pyjson.NewObj().
						Set("days", days).
						Set("beginTime", begin).
						Set("endTime", end))}))
		}
		// in-memory/UI shape stays flat
		sched := pyjson.NewObj().
			Set("defaultPolicy", body.GetD("defaultPolicy", "production")).
			Set("rules", rules)
		spec := pyjson.NewObj().Set("schedulePolicy", pyjson.NewObj().
			Set("schedulePolicyConfig", pyjson.NewObj().
				Set("defaultPolicy", body.GetD("defaultPolicy", "production")).
				Set("rules", crRules)))
		desc := str(body.GetD("description", ""))
		if desc == "" {
			desc = "Policy schedule (switches HPA policy by time)."
		}
		if e.Cfg.WriteRecommendationCRs {
			cr := pyjson.NewObj().
				Set("apiVersion", crdGroup+"/"+crdVer).
				Set("kind", "HPAPolicy").
				Set("metadata", pyjson.NewObj().
					Set("name", name).
					Set("namespace", e.Cfg.Namespace).
					Set("labels", pyjson.NewObj().
						Set("app.kubernetes.io/part-of", "coolscaler").
						Set("coolscaler.sh/hpa-schedule", "true")).
					Set("annotations", pyjson.NewObj().Set("coolscaler.sh/description", desc))).
				Set("spec", spec)
			// PATCH body carries schedule:null to delete the legacy invented
			// spec.schedule key from older CRs (merge-patch semantics).
			if code, resp, ok := upsert(spec.Clone().Set("schedule", nil), cr); !ok {
				return code, resp
			}
		}
		e.mu.Lock()
		e.hpaSched[name] = sched
		e.hpaPolicyDescOv[name] = desc
		e.mu.Unlock()
		verb := "updated"
		if isNew {
			verb = "created"
		}
		e.audit("HpaSchedulePolicySave", name, "", verb, "user")
		return 200, pyjson.NewObj().Set("ok", true).Set("name", name).Set("message", "Policy schedule saved")
	}
	kb := editorToHpaKnobs(body)
	spec := hpapolicySpec(kb)
	desc := str(body.GetD("description", ""))
	if desc == "" {
		desc = "Custom HPA policy created by the user."
	}
	if e.Cfg.WriteRecommendationCRs {
		cr := pyjson.NewObj().
			Set("apiVersion", crdGroup+"/"+crdVer).
			Set("kind", "HPAPolicy").
			Set("metadata", pyjson.NewObj().
				Set("name", name).
				Set("namespace", e.Cfg.Namespace).
				Set("labels", pyjson.NewObj().
					Set("app.kubernetes.io/part-of", "coolscaler").
					Set("coolscaler.sh", "true")).
				Set("annotations", pyjson.NewObj().Set("coolscaler.sh/description", desc))).
			Set("spec", spec)
		// PATCH body deletes the legacy invented replica keys from older CRs.
		if code, resp, ok := upsert(hpapolicyLegacyNulls(spec), cr); !ok {
			return code, resp
		}
	}
	e.mu.Lock()
	e.hpaPolicyOverrides[name] = kb
	e.hpaPolicyDescOv[name] = desc
	e.mu.Unlock()
	verb := "updated"
	if isNew {
		verb = "created"
	}
	e.audit("HpaPolicySave", name, "", verb, "user")
	return 200, pyjson.NewObj().Set("ok", true).Set("name", name).Set("message", "HPA policy saved")
}

func (e *Engine) HpaPolicyDuplicate(ctx context.Context, body *pyjson.Obj) (int, *pyjson.Obj) {
	src := strings.TrimSpace(str(body.GetD("source", "")))
	newName := strings.TrimSpace(str(body.GetD("name", "")))
	if newName == "" || !reRFC1123.MatchString(newName) {
		return 400, pyjson.NewObj().Set("ok", false).Set("message", "a valid new name is required")
	}
	e.mu.Lock()
	_, taken := e.hpaPolicyOverrides[newName]
	e.mu.Unlock()
	if hpaBuiltinNames[newName] || taken {
		return 400, pyjson.NewObj().Set("ok", false).Set("message", "that name is already in use")
	}
	detail := e.HpaPolicyDetail(src)
	if detail == nil {
		return 400, pyjson.NewObj().Set("ok", false).Set("message", "source policy not found")
	}
	detail.Set("name", newName)
	detail.Set("isNew", true)
	detail.Set("builtin", false)
	detail.Set("description", "Duplicated from "+src+".")
	return e.HpaPolicySave(ctx, detail)
}

func (e *Engine) HpaPolicyDelete(ctx context.Context, body *pyjson.Obj) (int, *pyjson.Obj) {
	name := strings.TrimSpace(str(body.GetD("name", "")))
	if hpaBuiltinNames[name] {
		return 400, pyjson.NewObj().Set("ok", false).Set("message", "built-in HPA policies cannot be deleted")
	}
	if e.Cfg.WriteRecommendationCRs {
		if _, err := e.k8sReq(ctx, "DELETE", crdBase("hpapolicies", e.Cfg.Namespace)+"/"+name, nil, "application/json"); err != nil {
			e.Log.Info("hpa_policy_delete failed", "name", name, "err", err)
		}
	}
	e.mu.Lock()
	delete(e.hpaPolicyOverrides, name)
	delete(e.hpaPolicyDescOv, name)
	delete(e.hpaSched, name)
	for k, v := range e.replicasPolicyAssign {
		if v == name {
			e.replicasPolicyAssign[k] = "production"
		}
	}
	e.mu.Unlock()
	e.audit("HpaPolicyDelete", name, "", "", "user")
	return 200, pyjson.NewObj().Set("ok", true).Set("message", "HPA policy deleted")
}
