package engine

// Java Optimization policy surface (the java-memory-aware policy drawer).
// CoolScaler serves the same shape from the API and persists the four toggles
// in the cluster-operations CM under `java-policy-config`. The Policy CR
// catalog keeps the builtin named `java`.

import (
	"context"

	"coolscaler.sh/coolscaler/internal/pyjson"
)

const javaPolicyConfigKey = "java-policy-config"

const javaMemoryAwareDescription = "An enhanced policy for Java workloads " +
	"with optimized JVM memory management and two-stage optimization workflow."

// javaPolicyConfig reads the persisted toggle set. Tolerates an absent
// cluster-operations CM.
func (e *Engine) javaPolicyConfig(ctx context.Context) *pyjson.Obj {
	cfg := pyjson.NewObj().
		Set("realUsageCalculation", true).
		Set("memoryOptimization", true).
		Set("gcOptimization", true).
		Set("oomAutoHealing", true)
	raw := str(e.clusterOps(ctx, false).GetD(javaPolicyConfigKey, ""))
	if raw == "" {
		return cfg
	}
	v, err := pyjson.Decode([]byte(raw))
	if err != nil {
		return cfg
	}
	o, ok := v.(*pyjson.Obj)
	if !ok {
		return cfg
	}
	for _, k := range cfg.Keys() {
		if vv, okK := o.Get(k); okK {
			cfg.Set(k, truthy(vv))
		}
	}
	return cfg
}

// javaAutoPolicyOn is the cluster-ops `java-auto-policy` switch (default on): when off,
// detected Java workloads no longer auto-suggest the `java` builtin policy.
func (e *Engine) javaAutoPolicyOn(ctx context.Context) bool {
	return str(e.clusterOps(ctx, false).GetD("java-auto-policy", nil)) != "false"
}

// JavaConfigData is GET /api/java/config.
func (e *Engine) JavaConfigData(ctx context.Context) *pyjson.Obj {
	return pyjson.NewObj().
		Set("observability", e.javaObservabilityOn(ctx)).
		Set("optimize", e.javaOptimizeOn(ctx)).
		Set("autoAssignPolicy", e.javaAutoPolicyOn(ctx))
}

// JavaPoliciesData is GET /api/java/policies.
func (e *Engine) JavaPoliciesData(ctx context.Context) *pyjson.Obj {
	cfg := e.javaPolicyConfig(ctx)
	usedByCount := 0
	if jd, err := e.JavaData(ctx); err == nil {
		usedByCount = len(getList(jd, "workloads"))
	} else {
		e.mu.Lock()
		for _, w := range e.workloads {
			if w.java {
				usedByCount++
			}
		}
		e.mu.Unlock()
	}
	pol := pyjson.NewObj().
		Set("name", "java-memory-aware").
		Set("builtin", true).
		Set("description", javaMemoryAwareDescription).
		Set("usedBy", "All Java workloads").
		Set("usedByCount", usedByCount).
		Set("recommendation", pyjson.NewObj().
			Set("realUsageCalculation", truthy(cfg.GetD("realUsageCalculation", true)))).
		Set("automation", pyjson.NewObj().
			Set("memoryOptimization", truthy(cfg.GetD("memoryOptimization", true))).
			Set("gcOptimization", truthy(cfg.GetD("gcOptimization", true))).
			Set("oomAutoHealing", truthy(cfg.GetD("oomAutoHealing", true))))
	return pyjson.NewObj().Set("policies", []any{pol})
}

// PostJavaPolicySave is POST /api/java/policy/save.
func (e *Engine) PostJavaPolicySave(ctx context.Context, body *pyjson.Obj) (int, *pyjson.Obj) {
	cfg := e.javaPolicyConfig(ctx)
	if rec, ok := body.GetD("recommendation", nil).(*pyjson.Obj); ok && rec != nil {
		if v, okV := rec.Get("realUsageCalculation"); okV {
			cfg.Set("realUsageCalculation", truthy(v))
		}
	}
	if au, ok := body.GetD("automation", nil).(*pyjson.Obj); ok && au != nil {
		for _, k := range []string{"memoryOptimization", "gcOptimization", "oomAutoHealing"} {
			if v, okV := au.Get(k); okV {
				cfg.Set(k, truthy(v))
			}
		}
	}
	if err := e.setClusterOps(ctx, pyjson.NewObj().
		Set(javaPolicyConfigKey, string(pyjson.Marshal(cfg)))); err != nil {
		return 200, pyjson.NewObj().Set("ok", false).Set("message", err.Error())
	}
	name := str(body.GetD("name", "java-memory-aware"))
	e.audit("JavaPolicyUpdate", name, "", truncJSON(body, 200), "user")
	return 200, pyjson.NewObj().Set("ok", true)
}
