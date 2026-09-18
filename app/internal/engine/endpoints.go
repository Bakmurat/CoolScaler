package engine

import (
	"context"
	"fmt"
	"time"

	"coolscaler.sh/coolscaler/internal/pyjson"
)


func truncJSON(v any, n int) string {
	s := string(pyjson.Marshal(v))
	if len(s) > n {
		s = s[:n]
	}
	return s
}

// PostAlertSettings is POST /api/alert-settings.
func (e *Engine) PostAlertSettings(body *pyjson.Obj) (int, *pyjson.Obj) {
	rulesIn := getObj(body, "rules")
	e.mu.Lock()
	for _, rtype := range rulesIn.Keys() {
		patch, ok := rulesIn.GetD(rtype, nil).(*pyjson.Obj)
		if !ok || !e.alertRules.Has(rtype) {
			continue
		}
		tgt := getObj(e.alertRules, rtype)
		for _, k := range []string{"enabled", "severity", "threshold"} {
			if v, okV := patch.Get(k); okV {
				tgt.Set(k, v)
			}
		}
	}
	rules := e.alertRules
	e.mu.Unlock()
	e.audit("AlertSettingsUpdate", "alert-rules", "", truncJSON(rulesIn, 200), "user")
	return 200, pyjson.NewObj().Set("rules", rules)
}

// PostAutomationConfig is POST /api/automation-config.
func (e *Engine) PostAutomationConfig(ctx context.Context, body *pyjson.Obj) (int, *pyjson.Obj) {
	e.mu.Lock()
	for _, k := range []string{"automateAllNamespaces", "excludedWorkloadTypes", "excludedNamespaces",
		"excludedNamespacesRegex", "binPackKubeSystem", "binPackOwnerless",
		"binPackUnevictable", "allowedInstanceTypes", "blockedInstanceTypes",
		// coolscaler-admission-configuration global toggles
		"binPackLocalStoragePods", "binPackUnhealthyPods", "binPackRelaxedAntiAffinity",
		"disableDaemonSetRightsizing", "globalHpaThresholdOptimizationEnabled",
		"globalJvmRightsizingEnabled", "globalUpgradeJavaWorkloadsSmartPolicy",
		"scheduleBlockersEnhancedZoneDistribution", "scheduleBlockersMinNodes",
		"scheduleBlockersExcludedWorkloads"} {
		if v, ok := body.Get(k); ok {
			e.globalAuto.Set(k, v)
		}
	}
	if am, ok := body.GetD("automate", nil).(*pyjson.Obj); ok && am != nil {
		getObj(e.globalAuto, "automate").Update(am)
	}
	// Workload Operations lists (part of GLOBAL_AUTO, CM-persisted with it).
	if wa, ok := body.GetD("workloadAutomation", nil).(*pyjson.Obj); ok && wa != nil {
		tgt, okT := e.globalAuto.GetD("workloadAutomation", nil).(*pyjson.Obj)
		if !okT || tgt == nil {
			tgt = pyjson.NewObj()
			e.globalAuto.Set("workloadAutomation", tgt)
		}
		tgt.Update(wa)
	}
	// Custom namespace labels — persisted in the coolscaler-custom-namespace-
	// labels CM.
	nsLabelsChanged := false
	if nl, ok := body.GetD("namespaceLabels", nil).(*pyjson.Obj); ok && nl != nil {
		if l, okL := nl.GetD("includeLabels", nil).([]any); okL {
			e.customNsLabels["include-labels"] = strSlice(l)
			nsLabelsChanged = true
		}
		if l, okL := nl.GetD("excludeLabels", nil).([]any); okL {
			e.customNsLabels["exclude-labels"] = strSlice(l)
			nsLabelsChanged = true
		}
	}
	e.mu.Unlock()
	e.saveAutomationCM(ctx)
	e.saveUserIgnoredNamespacesCM(ctx)
	if nsLabelsChanged {
		e.saveCustomNsLabelsCM(ctx) // create-on-first-save, WRITE-gated
	}
	e.audit("AutomationConfigUpdate", "global", "", truncJSON(body, 200), "user")
	return 200, e.AutomationConfigData()
}

// PostCostConfig is POST /api/cost/config.
func (e *Engine) PostCostConfig(ctx context.Context, body *pyjson.Obj) (int, *pyjson.Obj) {
	cfg, ok := body.GetD("costConfig", nil).(*pyjson.Obj)
	if !ok || cfg == nil || cfg.Len() == 0 {
		cfg = body
	}
	e.mu.Lock()
	e.applyCostConfig(cfg)
	e.mu.Unlock()
	e.saveCostCM(ctx)
	e.audit("CostConfigUpdate", "pricing", "", truncJSON(body, 200), "user")
	return 200, e.CostConfigData().Set("ok", true)
}

// PostJavaConfig is POST /api/java/config.
func (e *Engine) PostJavaConfig(ctx context.Context, body *pyjson.Obj) (int, *pyjson.Obj) {
	patch := pyjson.NewObj()
	if v, ok := body.Get("observability"); ok {
		if truthy(v) {
			patch.Set("java-observability", "true")
		} else {
			patch.Set("java-observability", "false")
		}
	}
	if v, ok := body.Get("optimize"); ok {
		if truthy(v) {
			patch.Set("java-optimize", "true")
		} else {
			patch.Set("java-optimize", "false")
		}
	}
	// autoAssignPolicy: cluster-ops java-auto-policy — off stops auto-
	// assigning the `java` builtin policy to detected Java workloads.
	if v, ok := body.Get("autoAssignPolicy"); ok {
		if truthy(v) {
			patch.Set("java-auto-policy", "true")
		} else {
			patch.Set("java-auto-policy", "false")
		}
	}
	rolled := 0
	if patch.Len() > 0 {
		if err := e.setClusterOps(ctx, patch); err != nil {
			return 200, pyjson.NewObj().Set("ok", false).Set("message", err.Error())
		}
	}
	if truthy(body.GetD("rollout", nil)) {
		jd, err := e.JavaData(ctx)
		if err != nil {
			return 200, pyjson.NewObj().Set("ok", false).Set("message", err.Error())
		}
		seen := map[string]bool{}
		for _, rv := range getList(jd, "workloads") {
			r := obj(rv)
			k := getStr(r, "namespace") + "\x00" + getStr(r, "kind") + "\x00" + getStr(r, "name")
			if seen[k] {
				continue
			}
			seen[k] = true
			ok, _ := e.rolloutWorkload(ctx, getStr(r, "namespace"), getStr(r, "kind"), getStr(r, "name"))
			if ok {
				rolled++
			}
		}
	}
	e.audit("JavaConfigUpdate", "cluster", "", string(pyjson.Marshal(patch)), "user")
	return 200, pyjson.NewObj().
		Set("ok", true).
		Set("observability", e.javaObservabilityOn(ctx)).
		Set("optimize", e.javaOptimizeOn(ctx)).
		Set("autoAssignPolicy", e.javaAutoPolicyOn(ctx)).
		Set("rolledOut", rolled)
}

// PostJavaAction is POST /api/java/action.
func (e *Engine) PostJavaAction(ctx context.Context, body *pyjson.Obj) (int, *pyjson.Obj) {
	action := str(body.GetD("action", ""))
	scope := str(body.GetD("scope", "workload"))
	n := 0
	fail := func(err error) (int, *pyjson.Obj) {
		return 200, pyjson.NewObj().Set("ok", false).Set("message", err.Error())
	}
	switch scope {
	case "cluster":
		var err error
		if action == "automate" || action == "unautomate" {
			v := "false"
			if action == "automate" {
				v = "true"
			}
			err = e.setClusterOps(ctx, pyjson.NewObj().Set("java-optimize", v))
		} else if action == "enable-observability" || action == "disable-observability" {
			v := "false"
			if action == "enable-observability" {
				v = "true"
			}
			err = e.setClusterOps(ctx, pyjson.NewObj().Set("java-observability", v))
		}
		if err != nil {
			return fail(err)
		}
		n = 1
	case "namespace":
		for _, nv := range getList(body, "namespaces") {
			if err := e.setAutomatedNsField(ctx, str(nv), "javaOptimize", action == "automate", "UI-Namespace"); err != nil {
				return fail(err)
			}
			n++
		}
	default: // workload
		for _, tv := range getList(body, "targets") {
			t := obj(tv)
			ns, kind, name := getStr(t, "namespace"), getStr(t, "kind"), getStr(t, "name")
			if ns == "" || kind == "" || name == "" {
				continue
			}
			key := wlkey(ns, kind, name)
			switch action {
			case "automate":
				e.mu.Lock()
				e.javaAutomated[key] = true
				delete(e.javaUnautomated, key)
				e.mu.Unlock()
				e.setWorkloadTemplateAnnotations(ctx, ns, kind, name,
					pyjson.NewObj().Set("coolscaler.sh/java-auto", "true"))
				e.rolloutWorkload(ctx, ns, kind, name)
			case "unautomate":
				e.mu.Lock()
				e.javaUnautomated[key] = true
				delete(e.javaAutomated, key)
				e.mu.Unlock()
				e.setWorkloadTemplateAnnotations(ctx, ns, kind, name,
					pyjson.NewObj().Set("coolscaler.sh/java-auto", "false"))
				e.rolloutWorkload(ctx, ns, kind, name)
			case "exclude-observability":
				e.setWorkloadTemplateAnnotations(ctx, ns, kind, name,
					pyjson.NewObj().Set("coolscaler.sh/jmx-injection-disabled", "true"))
				e.mu.Lock()
				delete(e.javaHealing, key)
				e.mu.Unlock()
				e.rolloutWorkload(ctx, ns, kind, name)
			case "include-observability":
				e.setWorkloadTemplateAnnotations(ctx, ns, kind, name,
					pyjson.NewObj().Set("coolscaler.sh/jmx-injection-disabled", "false"))
				e.mu.Lock()
				delete(e.javaHealing, key)
				e.mu.Unlock()
				e.rolloutWorkload(ctx, ns, kind, name)
			case "rollout":
				e.rolloutWorkload(ctx, ns, kind, name)
			}
			n++
		}
	}
	e.audit("JavaAction", scope+":"+action, "", fmt.Sprintf("%d", n), "user")
	return 200, pyjson.NewObj().Set("ok", true).Set("count", n)
}

// PostHeadroom is POST /api/headroom.
func (e *Engine) PostHeadroom(body *pyjson.Obj) (int, *pyjson.Obj) {
	e.mu.Lock()
	for _, k := range []string{"enabled", "cpuClusterProportion", "memoryClusterProportion", "isScheduled"} {
		v, ok := body.Get(k)
		if !ok {
			continue
		}
		e.headroomRaw.Set(k, v)
		switch k {
		case "enabled":
			e.headroomEnabled = truthy(v)
		case "cpuClusterProportion":
			if f, okF := toFloatLoose(v); okF {
				e.headroomCpuPct = f
			}
		case "memoryClusterProportion":
			if f, okF := toFloatLoose(v); okF {
				e.headroomMemPct = f
			}
		case "isScheduled":
			e.headroomScheduled = truthy(v)
		}
	}
	out := e.clusterHeadroomLocked()
	e.mu.Unlock()
	e.audit("HeadroomUpdate", "cluster", "", truncJSON(body, 200), "user")
	return 200, out
}

// PostAutomate is POST /api/automate.
func (e *Engine) PostAutomate(body *pyjson.Obj) (int, *pyjson.Obj) {
	key := str(body.GetD("key", ""))
	enabledRaw := body.GetD("enabled", true)
	enabled := truthy(enabledRaw)
	source := str(body.GetD("source", "user"))
	if source == "" {
		source = "user"
	}
	e.mu.Lock()
	if enabled {
		delete(e.excluded, key) // automating clears any exclusion
		e.automated[key] = true
		e.automationSource[key] = source
	} else {
		delete(e.automated, key)
		delete(e.automationSource, key)
	}
	e.mu.Unlock()
	val := "off"
	if enabled {
		val = "on"
	}
	e.audit("Automate", key, "", val, source)
	return 200, pyjson.NewObj().
		Set("key", key).
		Set("automated", enabledRaw).
		Set("readOnly", e.Cfg.ReadOnly)
}

// PostAutomateBulk is POST /api/automate-bulk.
func (e *Engine) PostAutomateBulk(ctx context.Context, body *pyjson.Obj) (int, *pyjson.Obj) {
	scope := str(body.GetD("scope", "cluster"))
	ns := str(body.GetD("namespace", ""))
	keySet := map[string]bool{}
	for _, kv := range getList(body, "keys") {
		keySet[str(kv)] = true
	}
	enabledRaw := body.GetD("enabled", true)
	enabled := truthy(enabledRaw)
	n := 0
	e.mu.Lock()
	rows := append([]*wlRow(nil), e.workloads...)
	e.mu.Unlock()
	for _, w := range rows {
		if !w.sizable {
			continue
		}
		if scope == "namespace" && w.namespace != ns {
			continue
		}
		if scope == "selected" && !keySet[w.key] {
			continue
		}
		e.mu.Lock()
		if e.excluded[w.key] {
			e.mu.Unlock()
			continue // exclusion wins over bulk automation
		}
		if enabled {
			e.automated[w.key] = true
			e.automationSource[w.key] = scope
		} else {
			delete(e.automated, w.key)
			delete(e.automationSource, w.key)
		}
		e.mu.Unlock()
		n++
	}
	if scope == "namespace" && ns != "" {
		_ = e.setAutomatedNsField(ctx, ns, "optimize", enabled, "UI-Namespace")
	}
	if scope == "cluster" {
		e.mu.Lock()
		getObj(e.globalAuto, "automate").Set("rightsize", enabled)
		e.mu.Unlock()
		e.saveAutomationCM(ctx)
	}
	tgt := scope + ":" + ns
	if ns == "" {
		tgt = scope + ":*"
	}
	val := "off"
	if enabled {
		val = "on"
	}
	e.audit("AutomateBulk", tgt, "", fmt.Sprintf("%d workloads %s", n, val), "user")
	return 200, pyjson.NewObj().
		Set("scope", scope).
		Set("count", n).
		Set("automated", enabledRaw).
		Set("readOnly", e.Cfg.ReadOnly)
}

// PostExclude is POST /api/exclude.
func (e *Engine) PostExclude(body *pyjson.Obj) (int, *pyjson.Obj) {
	key := str(body.GetD("key", ""))
	exclRaw := body.GetD("excluded", true)
	excl := truthy(exclRaw)
	e.mu.Lock()
	if excl {
		e.excluded[key] = true
		delete(e.automated, key)
		delete(e.automationSource, key)
	} else {
		delete(e.excluded, key)
	}
	e.mu.Unlock()
	val := "re-included"
	if excl {
		val = "excluded"
	}
	e.audit("Exclude", key, "", val, "user")
	return 200, pyjson.NewObj().Set("key", key).Set("excluded", exclRaw)
}

// PostAttachPolicy is POST /api/attach-policy.
func (e *Engine) PostAttachPolicy(ctx context.Context, body *pyjson.Obj) (int, *pyjson.Obj) {
	ns, kind, name := str(body.GetD("namespace", nil)), str(body.GetD("kind", nil)), str(body.GetD("name", nil))
	pol := str(body.GetD("policy", "production"))
	ok, msg := e.attachPolicy(ctx, ns, kind, name, pol)
	code := 400
	if ok {
		code = 200
	}
	return code, pyjson.NewObj().Set("ok", ok).Set("message", msg).Set("policy", pol)
}

// PostRestorePolicy is POST /api/restore-policy.
func (e *Engine) PostRestorePolicy(ctx context.Context, body *pyjson.Obj) (int, *pyjson.Obj) {
	ok, msg, pol := e.restoreSuggestedPolicy(ctx,
		str(body.GetD("namespace", nil)), str(body.GetD("kind", nil)), str(body.GetD("name", nil)))
	code := 400
	if ok {
		code = 200
	}
	return code, pyjson.NewObj().Set("ok", ok).Set("message", msg).Set("policy", pol)
}

// PostRollout is POST /api/rollout.
func (e *Engine) PostRollout(ctx context.Context, body *pyjson.Obj) (int, *pyjson.Obj) {
	ok, msg := e.rolloutWorkload(ctx,
		str(body.GetD("namespace", nil)), str(body.GetD("kind", nil)), str(body.GetD("name", nil)))
	code := 400
	if ok {
		code = 200
	}
	return code, pyjson.NewObj().Set("ok", ok).Set("message", msg)
}

// PostReplicasAutomate is POST /api/replicas-automate.
func (e *Engine) PostReplicasAutomate(body *pyjson.Obj) (int, *pyjson.Obj) {
	key := str(body.GetD("key", ""))
	enabledRaw := body.GetD("enabled", true)
	e.mu.Lock()
	if truthy(enabledRaw) {
		e.replicasAutomated[key] = true
	} else {
		delete(e.replicasAutomated, key)
	}
	e.mu.Unlock()
	return 200, pyjson.NewObj().
		Set("key", key).
		Set("automated", enabledRaw).
		Set("readOnly", e.Cfg.ReadOnly)
}

// PostReplicasAutomateAll is POST /api/replicas-automate-all.
func (e *Engine) PostReplicasAutomateAll(body *pyjson.Obj) (int, *pyjson.Obj) {
	enabledRaw := body.GetD("enabled", true)
	e.mu.Lock()
	var keys []string
	for _, w := range e.workloads {
		if w.hpaManaged {
			keys = append(keys, w.key)
		}
	}
	if truthy(enabledRaw) {
		for _, k := range keys {
			e.replicasAutomated[k] = true
		}
	} else {
		for _, k := range keys {
			delete(e.replicasAutomated, k)
		}
	}
	e.mu.Unlock()
	return 200, pyjson.NewObj().
		Set("count", len(keys)).
		Set("automated", enabledRaw).
		Set("readOnly", e.Cfg.ReadOnly)
}

// PostReplicasApply is POST /api/replicas-apply.
func (e *Engine) PostReplicasApply(ctx context.Context, body *pyjson.Obj) (int, *pyjson.Obj) {
	ok, msg := e.applyReplicas(ctx,
		str(body.GetD("namespace", nil)), str(body.GetD("kind", nil)), str(body.GetD("name", nil)))
	code := 400
	if ok {
		code = 200
	}
	return code, pyjson.NewObj().Set("ok", ok).Set("message", msg)
}

// PostReplicasBulk is POST /api/replicas-bulk.
func (e *Engine) PostReplicasBulk(ctx context.Context, body *pyjson.Obj) (int, *pyjson.Obj) {
	action := str(body.GetD("action", "automate"))
	var keys []string
	for _, kv := range getList(body, "keys") {
		keys = append(keys, str(kv))
	}
	ns := str(body.GetD("namespace", ""))
	policy := str(body.GetD("policy", nil))
	e.mu.Lock()
	rows := map[string]*wlRow{}
	var rowOrder []string
	for _, w := range e.workloads {
		if w.hpaManaged {
			rows[w.key] = w
			rowOrder = append(rowOrder, w.key)
		}
	}
	e.mu.Unlock()
	scope := str(body.GetD("scope", nil))
	if scope == "namespace" && ns != "" {
		keys = nil
		for _, k := range rowOrder {
			if rows[k].namespace == ns {
				keys = append(keys, k)
			}
		}
	} else if scope == "cluster" {
		keys = rowOrder
	}
	n := 0
	msgs := []any{}
	for _, key := range keys {
		w := rows[key]
		if w == nil {
			continue
		}
		switch action {
		case "automate":
			e.mu.Lock()
			e.replicasAutomated[key] = true
			e.mu.Unlock()
			n++
		case "unautomate":
			e.mu.Lock()
			delete(e.replicasAutomated, key)
			e.mu.Unlock()
			n++
		case "attach":
			if replicasPolicyKnob(policy) != nil {
				e.mu.Lock()
				e.replicasPolicyAssign[key] = policy
				e.mu.Unlock()
				n++
			}
		case "restore":
			e.mu.Lock()
			delete(e.replicasPolicyAssign, key)
			e.mu.Unlock()
			n++
		case "optimize":
			ok, msg := e.applyReplicas(ctx, w.namespace, w.kind, w.name)
			if ok {
				n++
			}
			msgs = append(msgs, msg)
		}
	}
	if len(msgs) > 6 {
		msgs = msgs[:6]
	}
	return 200, pyjson.NewObj().
		Set("ok", true).
		Set("action", action).
		Set("count", n).
		Set("messages", msgs)
}

// PostReplicasAttachPolicy is POST /api/replicas-attach-policy.
func (e *Engine) PostReplicasAttachPolicy(body *pyjson.Obj) (int, *pyjson.Obj) {
	key := wlkey(str(body.GetD("namespace", nil)), str(body.GetD("kind", nil)), str(body.GetD("name", nil)))
	pol := str(body.GetD("policy", "production"))
	_, inCat := e.hpaAllKnobs()[pol]
	e.mu.Lock()
	_, inSched := e.hpaSched[pol]
	e.mu.Unlock()
	if !inCat && !inSched {
		return 400, pyjson.NewObj().Set("ok", false).Set("message", "unknown replicas policy")
	}
	e.mu.Lock()
	e.replicasPolicyAssign[key] = pol
	e.mu.Unlock()
	return 200, pyjson.NewObj().Set("ok", true).Set("policy", pol).Set("key", key)
}

// PostPlacementAutomate is POST /api/placement-automate.
func (e *Engine) PostPlacementAutomate(body *pyjson.Obj) (int, *pyjson.Obj) {
	key := str(body.GetD("key", ""))
	enabledRaw := body.GetD("enabled", true)
	e.mu.Lock()
	if truthy(enabledRaw) {
		e.placementAutomated[key] = true
	} else {
		delete(e.placementAutomated, key)
	}
	e.mu.Unlock()
	return 200, pyjson.NewObj().
		Set("key", key).
		Set("automated", enabledRaw).
		Set("readOnly", e.Cfg.ReadOnly)
}

// PostPlacementAutomateAll is POST /api/placement-automate-all.
func (e *Engine) PostPlacementAutomateAll(ctx context.Context, body *pyjson.Obj) (int, *pyjson.Obj) {
	cat := str(body.GetD("category", nil))
	enabledRaw := body.GetD("enabled", true)
	var wls []any
	if pd, err := e.placementData(ctx); err == nil {
		wls = getList(pd, "workloads")
	}
	n := 0
	for _, wv := range wls {
		w := obj(wv)
		if cat != "" {
			hit := false
			for _, rv := range getList(w, "reasons") {
				if placementReasonCat[str(rv)] == cat {
					hit = true
					break
				}
			}
			if !hit {
				continue
			}
		}
		key := getStr(w, "key")
		e.mu.Lock()
		if truthy(enabledRaw) {
			e.placementAutomated[key] = true
		} else {
			delete(e.placementAutomated, key)
		}
		e.mu.Unlock()
		n++
	}
	return 200, pyjson.NewObj().
		Set("count", n).
		Set("category", body.GetD("category", nil)).
		Set("automated", enabledRaw).
		Set("readOnly", e.Cfg.ReadOnly)
}

// PostPlacementOptimize is POST /api/placement-optimize.
func (e *Engine) PostPlacementOptimize(ctx context.Context, body *pyjson.Obj) (int, *pyjson.Obj) {
	ok, msg := e.applyPlacement(ctx,
		str(body.GetD("namespace", nil)), str(body.GetD("kind", nil)), str(body.GetD("name", nil)))
	code := 400
	if ok {
		code = 200
	}
	return code, pyjson.NewObj().Set("ok", ok).Set("message", msg)
}

// PostPlacementBulk is POST /api/placement-bulk.
func (e *Engine) PostPlacementBulk(ctx context.Context, body *pyjson.Obj) (int, *pyjson.Obj) {
	action := str(body.GetD("action", "rollout"))
	rows := map[string]*pyjson.Obj{}
	if pd, err := e.placementData(ctx); err == nil {
		for _, wv := range getList(pd, "workloads") {
			w := obj(wv)
			rows[getStr(w, "key")] = w
		}
	}
	n := 0
	msgs := []any{}
	for _, kv := range getList(body, "keys") {
		key := str(kv)
		w := rows[key]
		if w == nil {
			continue
		}
		switch action {
		case "automate":
			e.mu.Lock()
			e.placementAutomated[key] = true
			e.mu.Unlock()
			n++
		case "rollout":
			if truthy(w.GetD("rolloutEligible", nil)) {
				ok, msg := e.applyPlacement(ctx, getStr(w, "namespace"), getStr(w, "kind"), getStr(w, "name"))
				if ok {
					n++
				}
				msgs = append(msgs, msg)
			}
		}
	}
	if len(msgs) > 6 {
		msgs = msgs[:6]
	}
	return 200, pyjson.NewObj().
		Set("ok", true).
		Set("action", action).
		Set("count", n).
		Set("messages", msgs)
}

// PostSchedulingAutomate is POST /api/scheduling-automate.
func (e *Engine) PostSchedulingAutomate(body *pyjson.Obj) (int, *pyjson.Obj) {
	key := str(body.GetD("key", ""))
	enabledRaw := body.GetD("enabled", true)
	e.mu.Lock()
	if truthy(enabledRaw) {
		e.schedulingAutomated[key] = true
	} else {
		delete(e.schedulingAutomated, key)
	}
	e.mu.Unlock()
	return 200, pyjson.NewObj().
		Set("key", key).
		Set("automated", enabledRaw).
		Set("readOnly", e.Cfg.ReadOnly)
}

// PostSchedulingAutomateAll is POST /api/scheduling-automate-all.
func (e *Engine) PostSchedulingAutomateAll(ctx context.Context, body *pyjson.Obj) (int, *pyjson.Obj) {
	enabledRaw := body.GetD("enabled", true)
	var wls []any
	if sd, err := e.schedulingData(ctx); err == nil {
		wls = getList(sd, "workloads")
	}
	n := 0
	for _, wv := range wls {
		w := obj(wv)
		if !truthy(w.GetD("eligible", nil)) {
			continue
		}
		key := getStr(w, "key")
		e.mu.Lock()
		if truthy(enabledRaw) {
			e.schedulingAutomated[key] = true
		} else {
			delete(e.schedulingAutomated, key)
		}
		e.mu.Unlock()
		n++
	}
	return 200, pyjson.NewObj().
		Set("count", n).
		Set("automated", enabledRaw).
		Set("readOnly", e.Cfg.ReadOnly)
}

// PostSchedulingApply is POST /api/scheduling-apply.
func (e *Engine) PostSchedulingApply(ctx context.Context, body *pyjson.Obj) (int, *pyjson.Obj) {
	ok, msg := e.applyScheduling(ctx,
		str(body.GetD("namespace", nil)), str(body.GetD("kind", nil)), str(body.GetD("name", nil)))
	code := 400
	if ok {
		code = 200
	}
	return code, pyjson.NewObj().Set("ok", ok).Set("message", msg)
}

// PostSchedulingBulk is POST /api/scheduling-bulk.
func (e *Engine) PostSchedulingBulk(ctx context.Context, body *pyjson.Obj) (int, *pyjson.Obj) {
	action := str(body.GetD("action", "automate"))
	rows := map[string]*pyjson.Obj{}
	if sd, err := e.schedulingData(ctx); err == nil {
		for _, wv := range getList(sd, "workloads") {
			w := obj(wv)
			rows[getStr(w, "key")] = w
		}
	}
	n := 0
	msgs := []any{}
	for _, kv := range getList(body, "keys") {
		key := str(kv)
		w := rows[key]
		if w == nil {
			continue
		}
		switch action {
		case "automate":
			e.mu.Lock()
			e.schedulingAutomated[key] = true
			e.mu.Unlock()
			n++
		case "apply":
			if truthy(w.GetD("eligible", nil)) {
				ok, msg := e.applyScheduling(ctx, getStr(w, "namespace"), getStr(w, "kind"), getStr(w, "name"))
				if ok {
					n++
				}
				msgs = append(msgs, msg)
			}
		}
	}
	if len(msgs) > 6 {
		msgs = msgs[:6]
	}
	return 200, pyjson.NewObj().
		Set("ok", true).
		Set("action", action).
		Set("count", n).
		Set("messages", msgs)
}

// PostSchedulingAttachPolicy is POST /api/scheduling-attach-policy.
func (e *Engine) PostSchedulingAttachPolicy(body *pyjson.Obj) (int, *pyjson.Obj) {
	key := wlkey(str(body.GetD("namespace", nil)), str(body.GetD("kind", nil)), str(body.GetD("name", nil)))
	pol := str(body.GetD("policy", "high-availability"))
	e.mu.Lock()
	_, known := e.schedulingPolicyKnobs[pol]
	e.mu.Unlock()
	if !known {
		return 400, pyjson.NewObj().Set("ok", false).Set("message", "unknown scheduling policy")
	}
	e.mu.Lock()
	e.schedulingPolAssign[key] = pol
	e.mu.Unlock()
	return 200, pyjson.NewObj().Set("ok", true).Set("policy", pol).Set("key", key)
}

// PostDownscaleAttach is POST /api/downscale-attach.
func (e *Engine) PostDownscaleAttach(body *pyjson.Obj) (int, *pyjson.Obj) {
	key := wlkey(str(body.GetD("namespace", nil)), str(body.GetD("kind", nil)), str(body.GetD("name", nil)))
	sched := str(body.GetD("schedule", "nights"))
	e.mu.Lock()
	e.downscaleAssign[key] = sched
	e.mu.Unlock()
	return 200, pyjson.NewObj().Set("ok", true).Set("schedule", sched).Set("key", key)
}

// PostDownscaleAutomate is POST /api/downscale-automate.
func (e *Engine) PostDownscaleAutomate(body *pyjson.Obj) (int, *pyjson.Obj) {
	var key string
	if truthy(body.GetD("namespace", nil)) {
		key = wlkey(str(body.GetD("namespace", nil)), str(body.GetD("kind", nil)), str(body.GetD("name", nil)))
	} else {
		key = str(body.GetD("key", ""))
	}
	enabledRaw := body.GetD("enabled", true)
	if e.Cfg.ReadOnly {
		return 200, pyjson.NewObj().Set("ok", false).Set("readOnly", true).Set("message", "Read-Only mode")
	}
	e.mu.Lock()
	if truthy(enabledRaw) {
		e.downscaleAutomated[key] = true
	} else {
		delete(e.downscaleAutomated, key)
	}
	e.mu.Unlock()
	return 200, pyjson.NewObj().Set("ok", true).Set("key", key).Set("automated", enabledRaw)
}

// PostDownscaleAutomateNs is POST /api/downscale-automate-ns.
func (e *Engine) PostDownscaleAutomateNs(ctx context.Context, body *pyjson.Obj) (int, *pyjson.Obj) {
	nsx := str(body.GetD("namespace", ""))
	enabled := truthy(body.GetD("enabled", true))
	if e.Cfg.ReadOnly {
		return 200, pyjson.NewObj().Set("ok", false).Set("readOnly", true).Set("message", "Read-Only mode")
	}
	if nsx == "" {
		return 400, pyjson.NewObj().Set("ok", false).Set("message", "namespace required")
	}
	if err := e.setAutomatedNsField(ctx, nsx, "downscalerOptimize", enabled, "UI-Namespace"); err != nil {
		return 200, pyjson.NewObj().Set("ok", false).Set("message", err.Error())
	}
	val := "off"
	if enabled {
		val = "on"
	}
	e.audit("DownscaleNamespaceAutomate", nsx, "", val, "user")
	return 200, pyjson.NewObj().Set("ok", true).Set("namespace", nsx).Set("automated", enabled)
}

// PostDownscaleBulk is POST /api/downscale-bulk.
func (e *Engine) PostDownscaleBulk(body *pyjson.Obj) (int, *pyjson.Obj) {
	if e.Cfg.ReadOnly {
		return 200, pyjson.NewObj().Set("ok", false).Set("readOnly", true).
			Set("count", 0).Set("message", "Read-Only mode")
	}
	action := str(body.GetD("action", ""))
	keys := getList(body, "keys")
	sched := str(body.GetD("schedule", nil))
	e.mu.Lock()
	switch action {
	case "automate":
		for _, kv := range keys {
			e.downscaleAutomated[str(kv)] = true
		}
	case "unautomate":
		for _, kv := range keys {
			delete(e.downscaleAutomated, str(kv))
		}
	case "attach":
		if sched != "" {
			for _, kv := range keys {
				e.downscaleAssign[str(kv)] = sched
			}
		}
	}
	e.mu.Unlock()
	return 200, pyjson.NewObj().Set("ok", true).Set("action", action).Set("count", len(keys))
}

// PostApply is POST /api/apply.
func (e *Engine) PostApply(ctx context.Context, body *pyjson.Obj) (int, *pyjson.Obj) {
	ns, kind, name := str(body.GetD("namespace", nil)), str(body.GetD("kind", nil)), str(body.GetD("name", nil))
	ok, msg := e.applyRecommendation(ctx, ns, kind, name)
	val := "applied"
	if !ok {
		m := msg
		if len(m) > 80 {
			m = m[:80]
		}
		val = "failed: " + m
	}
	// Manual UI apply → user audit.
	if ok && str(body.GetD("source", "user")) == "automation" {
		e.sysEvent("podEviction", ns, kind, name)
		e.sysEvent("podOptimized", ns, kind, name)
	} else {
		e.audit("Apply", ns+"/"+kind+"/"+name, "", val, "user")
	}
	code := 400
	if ok {
		code = 200
	}
	return code, pyjson.NewObj().Set("ok", ok).Set("message", msg)
}

// PostResize is POST /api/resize (in-place vertical resize).
func (e *Engine) PostResize(ctx context.Context, body *pyjson.Obj) (int, *pyjson.Obj) {
	ns, kind, name := str(body.GetD("namespace", nil)), str(body.GetD("kind", nil)), str(body.GetD("name", nil))
	ok, msg, results := e.applyInplace(ctx, ns, kind, name)
	val := "failed"
	if ok {
		val = "resized"
	}
	// Manual UI resize → user audit. A no-op ("already at recommendation") records
	// NOTHING — otherwise the updater cycle floods the Events tab with phantom
	// optimizations.
	if msg != "already at recommendation" {
		if ok && str(body.GetD("source", "user")) == "automation" {
			e.sysEvent("inPlaceResize", ns, kind, name)
		} else {
			e.audit("InPlaceResize", ns+"/"+kind+"/"+name, "", val, "user")
		}
	}
	code := 400
	if ok {
		code = 200
	}
	return code, pyjson.NewObj().Set("ok", ok).Set("message", msg).Set("pods", results)
}

// Schedule-policies GET payload.

var dayNames = []string{"Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"}

func (e *Engine) SchedulePoliciesData() *pyjson.Obj {
	now := time.Now()
	e.mu.Lock()
	scheds := append([]*schedulePolicy(nil), e.schedulePolicies...)
	e.mu.Unlock()
	out := []any{}
	for _, sched := range scheds {
		active := scheduleActivePolicy(sched, now)
		ovs := []any{}
		for _, ov := range sched.overrides {
			periods := []any{}
			for _, p := range ov.periods {
				days := []any{}
				for _, d := range p.days {
					if d >= 0 && int(d) < len(dayNames) {
						days = append(days, dayNames[d])
					}
				}
				periods = append(periods, pyjson.NewObj().
					Set("days", days).
					Set("begin", p.begin).
					Set("end", p.end))
			}
			dp := ov.dataPoints
			if dp == "" {
				dp = "currentPeriods"
			}
			ovs = append(ovs, pyjson.NewObj().
				Set("policyName", ov.policyName).
				Set("dataPoints", dp).
				Set("sleep", ov.sleep).
				Set("periods", periods))
		}
		out = append(out, pyjson.NewObj().
			Set("name", sched.name).
			Set("defaultPolicy", sched.defaultPolicy).
			Set("desc", sched.desc).
			Set("active", active).
			Set("overrideActive", active != sched.defaultPolicy).
			Set("overrides", ovs))
	}
	return pyjson.NewObj().
		Set("schedules", out).
		Set("nowUTC", now.UTC().Format("Mon 15:04")+" UTC")
}

// PlacementData / SchedulingData exported wrappers for the API layer.
func (e *Engine) PlacementData(ctx context.Context) (*pyjson.Obj, error) {
	return e.placementData(ctx)
}
func (e *Engine) SchedulingData(ctx context.Context) (*pyjson.Obj, error) {
	return e.schedulingData(ctx)
}

func (e *Engine) CogSimulatePost(ctx context.Context, body *pyjson.Obj) (int, *pyjson.Obj) {
	res, err := e.CogSimulate(ctx, getList(body, "groupBys"))
	if err != nil {
		return 200, pyjson.NewObj().
			Set("groups", []any{}).
			Set("matchedWorkloads", 0).
			Set("matchedPods", 0).
			Set("error", err.Error())
	}
	return 200, res
}
