package engine

// Workload annotation controls + custom namespace labels + workload-operations
// matching + the coolscaler-control-actions reset. Precedence: a.
// coolscaler.sh/exclude-automation (workload or Namespace object) and the
// workload-operations exclude label/annotation matchers — force-excluded. b.
// coolscaler.sh/force-auto / coolscaler.sh/force-policy (legacy aliases
// coolscaler-sh/auto / coolscaler-sh/policy) — force automation/policy. c.
// General actions: UI-recorded state, AutomatedNamespace CRs, the cluster-
// operations CM (rightsize-optimize / replicas-optimize / pod-placement-
// optimize / default-rightsize-policy). d. Defaults:
// coolscaler.sh/default-*(auto|policy) annotations, the workload-operations
// include matchers, and custom-namespace-label include lists — applied ONLY
// while no UI/General action was recorded. Custom-namespace-label EXCLUDES sit
// below the explicit annotations (docs: "with lower precedence than the
// annotation") but above plain defaults.

import (
	"context"
	"fmt"
	"regexp"
	"strings"

	"coolscaler.sh/coolscaler/internal/pyjson"
)

// Annotation keys (workload controller object, pod template, or Namespace).
const (
	annExcludeAutomation = "coolscaler.sh/exclude-automation"

	annForceAuto         = "coolscaler.sh/force-auto"
	annForceAutoLegacy   = "coolscaler-sh/auto" // legacy hyphen alias
	annForcePolicy       = "coolscaler.sh/force-policy"
	annForcePolicyLegacy = "coolscaler-sh/policy" // legacy hyphen alias

	annDefaultAuto          = "coolscaler.sh/default-auto"
	annDefaultRightsizeAuto = "coolscaler.sh/default-rightsize-auto"
	annDefaultPolicy        = "coolscaler.sh/default-policy"
	annDefaultRightsizePol  = "coolscaler.sh/default-rightsize-policy"
	annDefaultJavaAuto      = "coolscaler.sh/default-java-auto"
	annDefaultReplicasAuto  = "coolscaler.sh/default-replicas-auto"
	annDefaultReplicasPol   = "coolscaler.sh/default-replicas-policy"

	// Pod Scheduling GitOps defaults (docs "Workload Actions").
	annDefaultPodSchedAuto = "coolscaler.sh/default-pod-scheduling-auto"
	annDefaultPodSchedPol  = "coolscaler.sh/default-pod-scheduling-policy"

	// Downscaler GitOps workload-schedule attachment: enable downscaler automation and
	// attach a named schedule policy directly on the workload manifest.
	annDefaultDownscalerAuto       = "coolscaler.sh/default-downscaler-auto"
	annDefaultDownscalerAutoLegacy = "coolscaler-sh/downscaler-auto" // legacy hyphen alias
	annDefaultDownscalerSchedule   = "coolscaler.sh/default-downscaler-schedule"
	annDefaultDownscalerSchedLeg   = "coolscaler-sh/downscaler-schedule" // legacy hyphen alias
)

// wlControls is the parsed per-workload annotation control set.
type wlControls struct {
	exclude   bool // workload-level coolscaler.sh/exclude-automation
	nsExclude bool // Namespace-object coolscaler.sh/exclude-automation

	forceAuto   *bool  // coolscaler.sh/force-auto / coolscaler-sh/auto
	forcePolicy string // coolscaler.sh/force-policy / coolscaler-sh/policy

	defaultAuto         bool   // default-auto / default-rightsize-auto (wl or ns)
	defaultPolicy       string // default-policy / default-rightsize-policy (wl, then ns)
	defaultJavaAuto     bool
	defaultReplicasAuto bool
	defaultReplicasPol  string // default-replicas-policy (attach HPA policy)

	// Pod Scheduling GitOps defaults.
	defaultPodSchedAuto bool
	defaultPodSchedPol  string

	// Downscaler GitOps: enable automation + attach a named schedule policy.
	defaultDownscalerAuto     bool
	defaultDownscalerSchedule string

	// skipReset: the docs' resetClusterWorkloadControl skip list — workloads
	// carrying exclude/force annotations keep their state through a reset.
	skipReset bool
}

// annLookup returns the first source (controller annotations first, then the
// aggregated pod annotations) that carries key.
func annLookup(sources []*pyjson.Obj, key string) (string, bool) {
	for _, src := range sources {
		if src == nil {
			continue
		}
		if v, ok := src.Get(key); ok {
			return str(v), true
		}
	}
	return "", false
}

// parseWorkloadControls resolves the annotation controls for one workload.
// sources = [controller-object annotations, aggregated pod annotations]
// (template annotations propagate to pods, so pods act as the fallback).
func parseWorkloadControls(sources []*pyjson.Obj, nsAnn *pyjson.Obj) wlControls {
	c := wlControls{}
	if v, ok := annLookup(sources, annExcludeAutomation); ok {
		c.exclude = strings.EqualFold(v, "true")
	}
	if nsAnn != nil {
		c.nsExclude = strings.EqualFold(getStr(nsAnn, annExcludeAutomation), "true")
	}
	forceRaw, forceSet := annLookup(sources, annForceAuto)
	if !forceSet {
		forceRaw, forceSet = annLookup(sources, annForceAutoLegacy)
	}
	if forceSet && forceRaw != "" {
		b := strings.EqualFold(forceRaw, "true")
		c.forceAuto = &b
	}
	if v, ok := annLookup(sources, annForcePolicy); ok && v != "" {
		c.forcePolicy = v
	} else if v, ok := annLookup(sources, annForcePolicyLegacy); ok && v != "" {
		c.forcePolicy = v
	}
	if v, ok := annLookup(sources, annDefaultAuto); ok {
		c.defaultAuto = strings.EqualFold(v, "true")
	} else if v, ok := annLookup(sources, annDefaultRightsizeAuto); ok {
		c.defaultAuto = strings.EqualFold(v, "true")
	} else if nsAnn != nil && strings.EqualFold(getStr(nsAnn, annDefaultAuto), "true") {
		c.defaultAuto = true
	}
	if v, ok := annLookup(sources, annDefaultPolicy); ok && v != "" {
		c.defaultPolicy = v
	} else if v, ok := annLookup(sources, annDefaultRightsizePol); ok && v != "" {
		c.defaultPolicy = v
	} else if nsAnn != nil {
		c.defaultPolicy = getStr(nsAnn, annDefaultPolicy)
	}
	if v, ok := annLookup(sources, annDefaultJavaAuto); ok {
		c.defaultJavaAuto = strings.EqualFold(v, "true")
	}
	if v, ok := annLookup(sources, annDefaultReplicasAuto); ok {
		c.defaultReplicasAuto = strings.EqualFold(v, "true")
	}
	if v, ok := annLookup(sources, annDefaultReplicasPol); ok && v != "" {
		c.defaultReplicasPol = v
	}
	if v, ok := annLookup(sources, annDefaultPodSchedAuto); ok {
		c.defaultPodSchedAuto = strings.EqualFold(v, "true")
	}
	if v, ok := annLookup(sources, annDefaultPodSchedPol); ok && v != "" {
		c.defaultPodSchedPol = v
	}
	if v, ok := annLookup(sources, annDefaultDownscalerAuto); ok {
		c.defaultDownscalerAuto = strings.EqualFold(v, "true")
	} else if v, ok := annLookup(sources, annDefaultDownscalerAutoLegacy); ok {
		c.defaultDownscalerAuto = strings.EqualFold(v, "true")
	}
	if v, ok := annLookup(sources, annDefaultDownscalerSchedule); ok && v != "" {
		c.defaultDownscalerSchedule = v
	} else if v, ok := annLookup(sources, annDefaultDownscalerSchedLeg); ok && v != "" {
		c.defaultDownscalerSchedule = v
	}
	c.skipReset = c.exclude || c.forceAuto != nil || c.forcePolicy != ""
	return c
}

// ---------------------------------------------------------------------------
// "key=value" matchers (value may be a regex) — used by the workload-
// operations lists and the custom-namespace-label lists.
// ---------------------------------------------------------------------------

type kvMatcher struct {
	key, val string
	re       *regexp.Regexp
	keyOnly  bool
}

// parseKVMatchers compiles "key=value" entries; a value carrying regex
// metacharacters also gets an anchored regex (like the ignored-ns pattern
// entries); a bare "key" matches key presence.
func parseKVMatchers(entries []any) []kvMatcher {
	var out []kvMatcher
	for _, ev := range entries {
		s := str(ev)
		if s == "" {
			continue
		}
		k, v, found := strings.Cut(s, "=")
		m := kvMatcher{key: k, val: v, keyOnly: !found}
		if found && strings.ContainsAny(v, "*?[](){}|^$+\\.") {
			if re, err := regexp.Compile("^(?:" + v + ")$"); err == nil {
				m.re = re
			}
		}
		out = append(out, m)
	}
	return out
}

func (m kvMatcher) match(labels *pyjson.Obj) bool {
	if labels == nil {
		return false
	}
	v, ok := labels.Get(m.key)
	if !ok {
		return false
	}
	if m.keyOnly {
		return true
	}
	s := str(v)
	if s == m.val {
		return true
	}
	return m.re != nil && m.re.MatchString(s)
}

// anyKVMatch reports whether any matcher hits any of the given label/annotation maps.
func anyKVMatch(ms []kvMatcher, objs ...*pyjson.Obj) bool {
	for _, m := range ms {
		for _, o := range objs {
			if m.match(o) {
				return true
			}
		}
	}
	return false
}

// Custom namespace labels ConfigMap (coolscaler-custom-namespace-labels)

const customNsLabelsCM = "coolscaler-custom-namespace-labels"

var customNsLabelKeys = []string{
	"default-auto", "default-auto-regex",
	"exclude-automation", "exclude-automation-regex",
	"exclude-labels", "exclude-namespaces-regex",
	"include-labels", "include-namespaces-regex",
}

func emptyCustomNsLabels() map[string][]string {
	m := make(map[string][]string, len(customNsLabelKeys))
	for _, k := range customNsLabelKeys {
		m[k] = []string{}
	}
	return m
}

// loadCustomNsLabelsCM refreshes the custom namespace-label lists from the
// ConfigMap.
func (e *Engine) loadCustomNsLabelsCM(ctx context.Context) {
	cm := e.getCM(ctx, customNsLabelsCM)
	if cm == nil {
		return
	}
	data := getObj(cm, "data")
	loaded := emptyCustomNsLabels()
	for _, k := range customNsLabelKeys {
		raw := strings.TrimSpace(getStr(data, k))
		if raw == "" {
			continue
		}
		v, err := pyjson.Decode([]byte(raw))
		if err != nil {
			continue
		}
		if l, ok := v.([]any); ok {
			loaded[k] = strSlice(l)
		}
	}
	e.mu.Lock()
	e.customNsLabels = loaded
	e.mu.Unlock()
}

// saveCustomNsLabelsCM persists all eight keys (create-on-first-save; every
// write goes through the WRITE_ENABLED-gated k8sReq inside upsertCM).
func (e *Engine) saveCustomNsLabelsCM(ctx context.Context) {
	e.mu.Lock()
	data := pyjson.NewObj()
	for _, k := range customNsLabelKeys {
		l := []any{}
		for _, s := range e.customNsLabels[k] {
			l = append(l, s)
		}
		data.Set(k, string(pyjson.Marshal(l)))
	}
	e.mu.Unlock()
	e.upsertCM(ctx, customNsLabelsCM,
		pyjson.NewObj().Set("labels", pyjson.NewObj().Set("app.kubernetes.io/part-of", "coolscaler")),
		data, nil)
}

// customNsMatch is the compiled matcher bundle for one refresh pass.
type customNsMatch struct {
	includeLabels, excludeLabels []kvMatcher
	defaultAutoNames             map[string]bool
	excludeNames                 map[string]bool
	defaultAutoRe, excludeRe     []*regexp.Regexp
	includeNsRe, excludeNsRe     []*regexp.Regexp
}

func compileNsRegexList(patterns []string) []*regexp.Regexp {
	var out []*regexp.Regexp
	for _, p := range patterns {
		if p == "" {
			continue
		}
		if re, err := regexp.Compile("^(?:" + p + ")$"); err == nil {
			out = append(out, re)
		}
	}
	return out
}

func toAnyList(ss []string) []any {
	out := make([]any, 0, len(ss))
	for _, s := range ss {
		out = append(out, s)
	}
	return out
}

// customNsMatchers compiles the current CM state (takes e.mu itself).
func (e *Engine) customNsMatchers() *customNsMatch {
	e.mu.Lock()
	raw := e.customNsLabels
	get := func(k string) []string { return raw[k] }
	c := &customNsMatch{
		includeLabels:    parseKVMatchers(toAnyList(get("include-labels"))),
		excludeLabels:    parseKVMatchers(toAnyList(get("exclude-labels"))),
		defaultAutoNames: map[string]bool{},
		excludeNames:     map[string]bool{},
		defaultAutoRe:    compileNsRegexList(get("default-auto-regex")),
		excludeRe:        compileNsRegexList(get("exclude-automation-regex")),
		includeNsRe:      compileNsRegexList(get("include-namespaces-regex")),
		excludeNsRe:      compileNsRegexList(get("exclude-namespaces-regex")),
	}
	for _, n := range get("default-auto") {
		c.defaultAutoNames[n] = true
	}
	for _, n := range get("exclude-automation") {
		c.excludeNames[n] = true
	}
	e.mu.Unlock()
	return c
}

func matchAnyRe(res []*regexp.Regexp, s string) bool {
	for _, re := range res {
		if re.MatchString(s) {
			return true
		}
	}
	return false
}

// excludesNS: exclude-labels matchers + exclude-automation name list + the
// two exclude regex lists. Excluded namespaces stay VISIBLE (unlike
// ignoredNamespaces) — they are only removed from automation.
func (c *customNsMatch) excludesNS(ns string, lbl *pyjson.Obj) bool {
	if c == nil {
		return false
	}
	return anyKVMatch(c.excludeLabels, lbl) || c.excludeNames[ns] ||
		matchAnyRe(c.excludeRe, ns) || matchAnyRe(c.excludeNsRe, ns)
}

// defaultsNS: include-labels matchers + default-auto name list + the two
// include/default regex lists — namespace-level default automation.
func (c *customNsMatch) defaultsNS(ns string, lbl *pyjson.Obj) bool {
	if c == nil {
		return false
	}
	return anyKVMatch(c.includeLabels, lbl) || c.defaultAutoNames[ns] ||
		matchAnyRe(c.defaultAutoRe, ns) || matchAnyRe(c.includeNsRe, ns)
}

// ---------------------------------------------------------------------------
// Namespace metadata index (annotations + labels), fetched once per refresh.
// ---------------------------------------------------------------------------

func (e *Engine) loadNamespaceMeta(ctx context.Context) (map[string]*pyjson.Obj, map[string]*pyjson.Obj) {
	anns := map[string]*pyjson.Obj{}
	lbls := map[string]*pyjson.Obj{}
	resp, err := e.Kube.GetJSON(ctx, "/api/v1/namespaces")
	if err != nil {
		return anns, lbls
	}
	for _, iv := range items(resp) {
		md := getObj(obj(iv), "metadata")
		name := getStr(md, "name")
		if name == "" {
			continue
		}
		anns[name] = getObj(md, "annotations")
		lbls[name] = getObj(md, "labels")
	}
	return anns, lbls
}

// ---------------------------------------------------------------------------
// Reset mechanism: coolscaler-control-actions CM with
// resetClusterWorkloadControl: "true" triggers a one-time cluster-wide reset
// of UI-recorded automation + policy state (skipping annotated workloads).
// ---------------------------------------------------------------------------

const controlActionsCM = "coolscaler-control-actions"

// controlResetRequested reads the control-actions CM.
func (e *Engine) controlResetRequested(ctx context.Context) bool {
	if !e.Cfg.WriteRecommendationCRs {
		return false // WRITE-gated: a read-only engine never mutates state
	}
	cm := e.getCM(ctx, controlActionsCM)
	if cm == nil {
		return false
	}
	data := getObj(cm, "data")
	return getStr(data, "resetClusterWorkloadControl") == "true" &&
		getStr(data, "processed") == ""
}

// finishControlReset removes the UI policy annotations from the reset
// workloads, deletes the control-actions CM, and writes the audit event.
// Called AFTER the refresh pass cleared the in-memory maps (without e.mu).
func (e *Engine) finishControlReset(ctx context.Context, n int, policyTargets [][3]string) {
	for _, t := range policyTargets {
		ns, kind, name := t[0], t[1], t[2]
		api, ok := wlAPI[kind]
		if !ok {
			continue
		}
		// merge-patch null removes the UI policy assignment annotation.
		_, _ = e.k8sReq(ctx, "PATCH", fmt.Sprintf(api, ns, name), pyjson.NewObj().
			Set("spec", pyjson.NewObj().Set("template", pyjson.NewObj().
				Set("metadata", pyjson.NewObj().
					Set("annotations", pyjson.NewObj().Set("coolscaler.sh/policy", nil))))),
			"application/merge-patch+json")
	}
	path := "/api/v1/namespaces/" + e.Cfg.Namespace + "/configmaps/" + controlActionsCM
	if _, err := e.k8sReq(ctx, "DELETE", path, nil, "application/json"); err != nil {
		// deletion refused (e.g. RBAC): mark processed so the reset stays one-time.
		_, _ = e.k8sReq(ctx, "PATCH", path, pyjson.NewObj().
			Set("data", pyjson.NewObj().Set("processed", isoNow())),
			"application/merge-patch+json")
	}
	e.audit("ControlReset", "cluster", "",
		fmt.Sprintf("%d workloads reset to default automation state", n), "system")
	e.Log.Info("cluster workload-control reset processed", "workloads", n)
}

// strSlice converts a decoded JSON list to []string.
func strSlice(l []any) []string {
	out := make([]string, 0, len(l))
	for _, v := range l {
		if s := str(v); s != "" {
			out = append(out, s)
		}
	}
	return out
}
