package engine

import (
	"context"
	"math"
	"strings"
	"time"

	"coolscaler.sh/coolscaler/internal/pyjson"
)

const (
	crdGroup = "analysis.coolscaler.sh"
	crdVer   = "v1alpha1"
)

func crdBase(plural, ns string) string {
	if ns != "" {
		return "/apis/" + crdGroup + "/" + crdVer + "/namespaces/" + ns + "/" + plural
	}
	return "/apis/" + crdGroup + "/" + crdVer + "/" + plural
}

// polKey is the (namespace, name) key of load_policies.
type polKey struct{ ns, name string }

// strategyLabel maps updateMode enum -> display label (STRATEGY_LABEL).
var strategyLabel = map[string]string{
	"Ongoing": "Ongoing", "OnCreate": "Upon pod creation", "Disabled": "Disabled",
}

func (e *Engine) defaultPolicy() *pyjson.Obj {
	cfg := e.Cfg
	return pyjson.NewObj().
		Set("window", "24h").
		Set("requestsConfigs", pyjson.NewObj().
			Set("cpu", pyjson.NewObj().
				Set("percentilePercentage", int(cfg.CPUPercentile)).
				Set("headroomPercentage", pyjson.RoundInt((cfg.CPUHeadroom-1)*100)).
				Set("minAllowed", FmtCPU(cfg.CPUFloorCores)).
				Set("maxAllowed", "4")).
			Set("memory", pyjson.NewObj().
				Set("percentilePercentage", int(cfg.MemPercentile)).
				Set("headroomPercentage", pyjson.RoundInt((cfg.MemHeadroom-1)*100)).
				Set("minAllowed", FmtMem(cfg.MemFloorBytes)).
				Set("maxAllowed", "8Gi"))).
		Set("updatePolicy", pyjson.NewObj().Set("updateMode", "Ongoing"))
}

func (e *Engine) loadPolicies(ctx context.Context) map[polKey]*pyjson.Obj {
	pols := map[polKey]*pyjson.Obj{}
	if resp, err := e.Kube.GetJSON(ctx, crdBase("policies", "")); err == nil {
		for _, it := range items(resp) {
			p := obj(it)
			md := getObj(p, "metadata")
			pols[polKey{getStr(md, "namespace"), getStr(md, "name")}] = getObj(p, "spec")
		}
	}
	if _, ok := pols[polKey{"__default__", "production"}]; !ok {
		pols[polKey{"__default__", "production"}] = e.defaultPolicy()
	}
	return pols
}

// The `default` builtin is retired; the alias keeps stored references working
// and `production` is the fallback.
func (e *Engine) resolvePolicy(pols map[polKey]*pyjson.Obj, ns, ann string) (string, *pyjson.Obj) {
	if ann == "java-memory-aware" {
		ann = "java"
	}
	if ann == "default" {
		ann = "production"
	}
	if ann != "" {
		if s, ok := pols[polKey{ns, ann}]; ok {
			return ann, s
		}
		if s, ok := pols[polKey{e.Cfg.Namespace, ann}]; ok {
			return ann, s
		}
	}
	if s, ok := pols[polKey{ns, "production"}]; ok {
		return "production", s
	}
	if s, ok := pols[polKey{e.Cfg.Namespace, "production"}]; ok {
		return "production", s
	}
	return "production", pols[polKey{"__default__", "production"}]
}

// knobs is the flattened policy_knobs result.
type knobs struct {
	cpuPct, memPct     float64
	cpuHead, memHead   float64
	cpuMin, cpuMax     float64
	memMin, memMax     float64
	window, strategy   string
	inPlace, autoHeal  bool
	burst, bootTime    bool
	initOpt            bool
	limitStrategy      string
	limCpu, limMem     limitCfg
	limEph             limitCfg
	ephOpt, ephReduce  bool
	ephPct, ephHead    float64
	ephWindow          string
	jvmRealUsage       bool
	jvmMemOpt          bool
	jvmGcOpt, jvmOomHl bool
}

// limitCfg is the per-resource recommended-LIMIT policy: base strategy +
// dynamic caps. has=false → keepOriginal (limit passes through unchanged;
// the safe default when a policy configures no limit strategy).
type limitCfg struct {
	strategy    string  // noLimit|equalsToRequest|setLimit|ratio|keepLimitRequestRatio|keepOriginal
	ratio       float64 // for "ratio"
	setLimit    float64 // for "setLimit"
	minLimit    float64 // absolute floor (0 = unset)
	maxLimit    float64 // absolute ceiling (0 = unset)
	maxIncrease float64 // maxRecommendedLimitToOriginalLimitRatio (0 = unset)
	has         bool
}

// parseLimitCfg reads one limitConfigs.{cpu,memory,ephemeral-storage} entry.
func parseLimitCfg(lc *pyjson.Obj) limitCfg {
	if lc == nil || lc.Len() == 0 {
		return limitCfg{}
	}
	flt := func(v any) float64 { f, _ := toFloatLoose(v); return f }
	c := limitCfg{
		has:         true,
		minLimit:    flt(lc.GetD("minLimit", nil)),
		maxLimit:    flt(lc.GetD("maxLimit", nil)),
		maxIncrease: flt(firstTruthy(lc.GetD("maxIncreaseFactor", nil), lc.GetD("maxRecommendedLimitToOriginalLimitRatio", nil))),
	}
	switch {
	case truthy(lc.GetD("noLimit", nil)):
		c.strategy = "noLimit"
	case truthy(lc.GetD("equalsToRequest", nil)):
		c.strategy = "equalsToRequest"
	case truthy(lc.GetD("setLimit", nil)):
		c.strategy, c.setLimit = "setLimit", flt(lc.GetD("setLimit", nil))
	case truthy(lc.GetD("keepLimitRequestRatio", nil)):
		c.strategy = "keepLimitRequestRatio"
	default:
		r := firstTruthy(lc.GetD("limitToRequestRatio", nil), lc.GetD("setLimitRequestRatio", nil))
		if truthy(r) {
			c.ratio = flt(r)
			if c.ratio == 1 {
				c.strategy = "equalsToRequest"
			} else {
				c.strategy = "ratio"
			}
		} else {
			// no computing strategy → keepOriginal; nothing to enforce.
			c.strategy, c.has = "keepOriginal", false
		}
	}
	return c
}

func (e *Engine) policyKnobs(spec *pyjson.Obj) knobs {
	cfg := e.Cfg
	rc := getObj(spec, "requestsConfigs")
	rsp := getObj(getObj(spec, "policyOptimize"), "rightSizePolicy")
	rspRC := getObj(rsp, "requestsConfigs")
	merge := func(res string) *pyjson.Obj {
		m := getObj(rspRC, res).Clone()
		m.Update(getObj(rc, res))
		return m
	}
	cpu, mem, eph := merge("cpu"), merge("memory"), merge("ephemeral-storage")
	wbr := getObj(spec, "windowByResource")
	if wbr.Len() == 0 {
		wbr = getObj(rsp, "windowByResource")
	}
	up := getObj(spec, "updatePolicy")

	toF := func(v any, def float64) float64 {
		if f, ok := toFloatLoose(v); ok {
			return f
		}
		return def
	}

	k := knobs{}
	k.cpuPct = toF(cpu.GetD("percentilePercentage", nil), cfg.CPUPercentile)
	k.memPct = toF(mem.GetD("percentilePercentage", nil), cfg.MemPercentile)
	k.cpuHead = 1 + toF(cpu.GetD("headroomPercentage", nil), (cfg.CPUHeadroom-1)*100)/100.0
	k.memHead = 1 + toF(mem.GetD("headroomPercentage", nil), (cfg.MemHeadroom-1)*100)/100.0
	k.cpuMin = ParseCPU(cpu.GetD("minAllowed", FmtCPU(cfg.CPUFloorCores)))
	k.cpuMax = ParseCPU(cpu.GetD("maxAllowed", "0"))
	if k.cpuMax == 0 {
		k.cpuMax = 1e9
	}
	k.memMin = ParseMem(mem.GetD("minAllowed", FmtMem(cfg.MemFloorBytes)))
	k.memMax = ParseMem(mem.GetD("maxAllowed", "0"))
	if k.memMax == 0 {
		k.memMax = 1e18
	}

	// window: flat -> windowByResource.cpu -> PROM_WINDOW (falsy-chained).
	k.window = getStr(spec, "window")
	if k.window == "" {
		k.window = getStr(wbr, "cpu")
	}
	if k.window == "" {
		k.window = cfg.PromWindow
	}
	// strategy: updateMode or updateByTypeMode.deployment, mapped to a label.
	updMode := getStr(up, "updateMode")
	if updMode == "" {
		ubt := getObj(up, "updateByTypeMode")
		updMode = str(ubt.GetD("deployment", "Ongoing"))
		if updMode == "" && !ubt.Has("deployment") {
			updMode = "Ongoing"
		}
	}
	if lbl, ok := strategyLabel[updMode]; ok {
		k.strategy = lbl
	} else {
		k.strategy = updMode
	}
	// inPlace: flat, else inPlaceUpdateStrategy.enableInPlaceForOngoingStrategy (default true).
	if v, ok := up.Get("inPlace"); ok {
		k.inPlace = truthy(v)
	} else {
		k.inPlace = truthy(getObj(up, "inPlaceUpdateStrategy").GetD("enableInPlaceForOngoingStrategy", true))
	}
	ah := getObj(spec, "autoHealing")
	if v, ok := ah.Get("enabled"); ok {
		k.autoHeal = truthy(v)
	} else {
		k.autoHeal = truthy(ah.GetD("enabledV2", true))
	}
	// burst: burstReaction.enabled, else policyOptimize.fastReaction.enabled.cpu (default true).
	br := getObj(spec, "burstReaction")
	if v, ok := br.Get("enabled"); ok {
		k.burst = truthy(v)
	} else {
		fr := getObj(getObj(spec, "policyOptimize"), "fastReaction")
		k.burst = truthy(obj(fr.GetD("enabled", nil)).GetD("cpu", true))
	}
	k.bootTime = truthy(rsp.GetD("bootTimeOptimizationEnabled", true))
	k.initOpt = truthy(rsp.GetD("initContainersOptimizationEnabled", true))
	// limitStrategy: flat limitStrategy.cpu, else rightSizePolicy.limitConfigs.cpu.strategy.
	k.limitStrategy = getStr(getObj(spec, "limitStrategy"), "cpu")
	if k.limitStrategy == "" {
		k.limitStrategy = getStr(getObj(getObj(rsp, "limitConfigs"), "cpu"), "strategy")
	}
	if k.limitStrategy == "" {
		k.limitStrategy = "keepOriginal"
	}
	// Per-resource limit strategy + dynamic caps (enforced in refresh.go).
	lc := getObj(rsp, "limitConfigs")
	if lc.Len() == 0 {
		lc = getObj(spec, "limitConfigs")
	}
	k.limCpu = parseLimitCfg(getObj(lc, "cpu"))
	k.limMem = parseLimitCfg(getObj(lc, "memory"))
	k.limEph = parseLimitCfg(getObj(lc, "ephemeral-storage"))
	k.ephOpt = truthy(rsp.GetD("ephemeralStorageOptimizationEnabled", true))
	k.ephReduce = truthy(rsp.GetD("allowEphemeralStorageReduction", false))
	k.ephPct = toF(eph.GetD("percentilePercentage", nil), cfg.EphPercentile)
	k.ephHead = 1 + toF(eph.GetD("headroomPercentage", nil), (cfg.EphHeadroom-1)*100)/100.0
	k.ephWindow = str(wbr.GetD("ephemeral-storage", cfg.EphWindow))
	jo := getObj(spec, "javaOptimization")
	k.jvmRealUsage = truthy(jo.GetD("realUsage", true))
	k.jvmMemOpt = truthy(jo.GetD("memoryOptimization", true))
	k.jvmGcOpt = truthy(jo.GetD("gcOptimization", true))
	k.jvmOomHl = truthy(jo.GetD("oomAutoHealing", true))
	return k
}

// ---------------------------------------------------------------------------
// Auto-detect policy heuristics + smart-policy workload types.
// ---------------------------------------------------------------------------

var workloadTypes = []struct {
	label string
	hints []string
}{
	{"Argo", []string{"argocd", "argo-", "argo-rollouts", "workflow-controller"}},
	{"Prometheus", []string{"prometheus", "thanos", "victoria", "vmstorage", "vminsert", "vmselect", "vmagent"}},
	{"Elasticsearch", []string{"elasticsearch", "elastic", "opensearch", "kibana", "logstash"}},
	{"Kafka", []string{"kafka", "zookeeper", "strimzi"}},
	{"Redis", []string{"redis", "valkey", "keydb"}},
	{"Database", []string{"postgres", "mysql", "mariadb", "mongodb", "cassandra", "cockroach"}},
	{"Spark", []string{"spark"}},
	{"Flink", []string{"flink"}},
	{"Airflow", []string{"airflow"}},
	{"Ingress", []string{"ingress-nginx", "nginx-ingress", "istio", "envoy", "traefik", "haproxy"}},
	{"ServiceMesh", []string{"linkerd", "cilium", "calico"}},
	{"CICD", []string{"jenkins", "gitlab-runner", "tekton", "drone"}},
}

func detectWorkloadType(name string, images []string, kind, ns, ownNS string) any {
	if ownNS != "" && ns == ownNS {
		return "CoolScaler"
	}
	blob := strings.ToLower(name + " " + strings.Join(images, " "))
	for _, wt := range workloadTypes {
		for _, h := range wt.hints {
			if strings.Contains(blob, h) {
				return wt.label
			}
		}
	}
	if kind == "DaemonSet" {
		return "DaemonSet"
	}
	return nil
}

// detectLanguage best-effort maps a workload to its runtime language for the
// drawer's "Detected workload" chip. Only CLEAR signals are used: the
// JavaDetect flag, or an unambiguous base-image name token; anything else
// returns "" (the frontend hides the chip). No fabrication.
func detectLanguage(isJava bool, images []string) string {
	if isJava {
		return "Java"
	}
	for _, img := range images {
		base := strings.ToLower(img)
		if i := strings.LastIndex(base, "/"); i >= 0 {
			base = base[i+1:]
		}
		name := strings.SplitN(base, "@", 2)[0] // drop digest
		name = strings.SplitN(name, ":", 2)[0]  // drop tag
		switch {
		case name == "golang" || name == "go" || strings.HasPrefix(name, "golang-"):
			return "Go"
		case name == "python" || strings.HasPrefix(name, "python-") ||
			strings.Contains(name, "django") || strings.Contains(name, "flask"):
			return "Python"
		case name == "node" || name == "nodejs" || strings.HasPrefix(name, "node-"):
			return "Node.js"
		case name == "ruby" || strings.Contains(name, "rails"):
			return "Ruby"
		case strings.Contains(name, "dotnet") || strings.Contains(name, "aspnet"):
			return ".NET"
		case name == "php" || strings.HasPrefix(name, "php-"):
			return "PHP"
		case name == "rust" || strings.HasPrefix(name, "rust-"):
			return "Rust"
		case strings.Contains(name, "openjdk") || strings.Contains(name, "temurin") ||
			strings.Contains(name, "jdk") || strings.Contains(name, "jre"):
			return "Java"
		}
	}
	return ""
}

func autodetectPolicy(ns, kind, name string, isJava bool, replicas int, images []string) string {
	blob := strings.ToLower(name + " " + strings.Join(images, " "))
	if isJava {
		return "java"
	}
	if strings.Contains(blob, "prometheus") || strings.Contains(blob, "thanos") {
		return "prometheus"
	}
	if strings.Contains(blob, "spark") {
		return "spark"
	}
	if strings.Contains(blob, "flink") {
		return "flink"
	}
	if strings.Contains(blob, "airflow") {
		return "airflow"
	}
	if kind == "DaemonSet" {
		return "daemonset-workloads"
	}
	if ns == "kube-system" || strings.HasSuffix(ns, "-system") {
		return "system"
	}
	if replicas >= 10 {
		return "high-replica"
	}
	if strings.HasSuffix(ns, "-dev") || containsSeg(ns, "dev") || strings.Contains(ns, "staging") {
		return "cost"
	}
	return "production"
}

func containsSeg(ns, seg string) bool {
	for _, p := range strings.Split(ns, "-") {
		if p == seg {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// Schedule policies (type: Schedule) — built-ins + user CRs.
// ---------------------------------------------------------------------------

type schedulePeriod struct {
	days       []int64
	begin, end string
}

type scheduleOverride struct {
	policyName string
	dataPoints string // historyWindowDataPoints ("currentPeriods" | "all")
	sleep      bool
	periods    []schedulePeriod
}

type schedulePolicy struct {
	name          string
	defaultPolicy string
	desc          string
	overrides     []scheduleOverride
}

func builtinSchedulePolicies() []*schedulePolicy {
	return []*schedulePolicy{
		{name: "weekly-optimization", defaultPolicy: "production",
			desc: "Optimizes workloads for weekdays and weekends separately, based on the past week",
			overrides: []scheduleOverride{
				{policyName: "production", dataPoints: "currentPeriods", periods: []schedulePeriod{
					{days: []int64{5}, begin: "16:00", end: "00:00"},
					{days: []int64{6}, begin: "00:00", end: "00:00"},
					{days: []int64{0}, begin: "00:00", end: "16:00"}}},
				{policyName: "production", dataPoints: "currentPeriods", periods: []schedulePeriod{
					{days: []int64{0}, begin: "16:00", end: "00:00"},
					{days: []int64{2, 3, 4, 1}, begin: "00:00", end: "00:00"},
					{days: []int64{5}, begin: "00:00", end: "16:00"}}},
			}},
		{name: "every-day-nights", defaultPolicy: "production",
			desc: "Cost policy every night (21:00–08:00 UTC); production by day.",
			overrides: []scheduleOverride{
				{policyName: "cost", dataPoints: "currentPeriods", periods: []schedulePeriod{
					{days: []int64{0, 1, 2, 3, 4, 5, 6}, begin: "21:00", end: "08:00"}}},
			}},
		{name: "weekend", defaultPolicy: "production",
			desc: "Cost policy on weekends (Fri 18:00 → Mon 08:00 UTC).",
			overrides: []scheduleOverride{
				{policyName: "cost", dataPoints: "currentPeriods", periods: []schedulePeriod{
					{days: []int64{5}, begin: "18:00", end: "00:00"},
					{days: []int64{6, 0}, begin: "00:00", end: "00:00"},
					{days: []int64{1}, begin: "00:00", end: "08:00"}}},
			}},
		{name: "weekend-and-nights", defaultPolicy: "production",
			desc: "Cost policy on weekends and every night — maximum off-peak savings.",
			overrides: []scheduleOverride{
				{policyName: "cost", dataPoints: "currentPeriods", periods: []schedulePeriod{
					{days: []int64{5}, begin: "18:00", end: "00:00"},
					{days: []int64{6, 0}, begin: "00:00", end: "00:00"},
					{days: []int64{1}, begin: "00:00", end: "08:00"},
					{days: []int64{0, 1, 2, 3, 4, 5, 6}, begin: "21:00", end: "08:00"}}},
			}},
	}
}

func hhmm(s string) int {
	parts := strings.SplitN(s, ":", 2)
	if len(parts) != 2 {
		return 0
	}
	h, err1 := parseIntPy(parts[0])
	m, err2 := parseIntPy(parts[1])
	if !err1 || !err2 {
		return 0
	}
	return h*60 + m
}

func parseIntPy(s string) (int, bool) {
	f, ok := parseFloatPy(s)
	if !ok || f != math.Trunc(f) {
		return 0, false
	}
	return int(f), true
}

func periodActive(p schedulePeriod, prodDay, curMin int) bool {
	found := false
	for _, d := range p.days {
		if int(d) == prodDay {
			found = true
			break
		}
	}
	if !found {
		return false
	}
	b := hhmm(p.begin)
	en := hhmm(p.end)
	if en == 0 {
		en = 1440
	}
	if en <= b {
		return curMin >= b || curMin < en
	}
	return b <= curMin && curMin < en
}

func scheduleActivePolicy(s *schedulePolicy, now time.Time) string {
	t := now.UTC()
	prodDay := (int(t.Weekday())) % 7
	curMin := t.Hour()*60 + t.Minute()
	for _, ov := range s.overrides {
		for _, per := range ov.periods {
			if periodActive(per, prodDay, curMin) {
				return ov.policyName
			}
		}
	}
	return s.defaultPolicy
}

// scheduleCurrentPeriods reports whether any override restricts sampling to the
// current period (historyWindowDataPoints == "currentPeriods") — the weekly-
// optimization weekday/weekend split.
func scheduleCurrentPeriods(s *schedulePolicy) bool {
	for _, ov := range s.overrides {
		if ov.dataPoints == "currentPeriods" {
			return true
		}
	}
	return false
}

// isWeekendUTC reports Saturday/Sunday (UTC), the weekend period.
func isWeekendUTC(t time.Time) bool {
	wd := t.UTC().Weekday()
	return wd == time.Saturday || wd == time.Sunday
}

func (e *Engine) loadScheduleCRs(ctx context.Context) {
	if !e.Cfg.WriteRecommendationCRs {
		return
	}
	resp, err := e.Kube.GetJSON(ctx, crdBase("policies", e.Cfg.Namespace))
	if err != nil {
		return
	}
	pre := map[string]bool{}
	for name := range e.scheduleByName {
		pre[name] = true
	}
	n := 0
	for _, it := range items(resp) {
		p := obj(it)
		spec := getObj(p, "spec")
		nm := getStr(getObj(p, "metadata"), "name")
		if getStr(spec, "type") != "Schedule" || nm == "" || pre[nm] {
			continue
		}
		cfg := getObj(getObj(spec, "policySchedule"), "schedulePolicyConfig")
		desc := str(getObj(getObj(p, "metadata"), "annotations").GetD("coolscaler.sh/description", "User-defined schedule policy."))
		entry := &schedulePolicy{name: nm, defaultPolicy: str(cfg.GetD("defaultPolicy", "production")), desc: desc}
		for _, rv := range getList(cfg, "rules") {
			r := obj(rv)
			ov := scheduleOverride{
				policyName: str(r.GetD("policyName", "production")),
				dataPoints: str(r.GetD("historyWindowDataPoints", "currentPeriods")),
				sleep:      truthy(r.GetD("sleep", false)),
			}
			for _, pv := range getList(r, "periods") {
				wc := getObj(obj(pv), "weeklyConfig")
				per := schedulePeriod{
					begin: str(wc.GetD("beginTime", "00:00")),
					end:   str(wc.GetD("endTime", "00:00")),
				}
				for _, dv := range getList(wc, "days") {
					per.days = append(per.days, i64(dv))
				}
				ov.periods = append(ov.periods, per)
			}
			entry.overrides = append(entry.overrides, ov)
		}
		e.mu.Lock()
		kept := e.schedulePolicies[:0]
		for _, s := range e.schedulePolicies {
			if s.name != nm {
				kept = append(kept, s)
			}
		}
		e.schedulePolicies = append(kept, entry)
		e.scheduleByName[nm] = entry
		e.mu.Unlock()
		n++
	}
	if n > 0 {
		e.Log.Info("loaded user schedule policies from CRs", "count", n)
	}
}

// ---------------------------------------------------------------------------
// Policy Rules (detection rules) — seeds + ConfigMap override + matching.
// ---------------------------------------------------------------------------

func defaultPolicyRules() []any {
	mk := func(t, k, v string) *pyjson.Obj {
		o := pyjson.NewObj().Set("type", t).Set("key", k)
		if v != "" || t == "labelKV" || t == "annotationKV" {
			o.Set("value", v)
		}
		return o
	}
	group := func(idents ...any) *pyjson.Obj {
		return pyjson.NewObj().Set("identifiers", idents)
	}
	rule := func(policy, tag string, groups ...any) *pyjson.Obj {
		return pyjson.NewObj().Set("policyName", policy).Set("tag", tag).Set("rules", groups)
	}
	return []any{
		rule("high-availability", "core-system",
			group(mk("labelKV", "system", "Core")),
			group(mk("annotationKV", "production", "true"))),
		rule("production", "team-a-prod",
			group(mk("annotationKeys", "team/a", ""), mk("envKeys", "PRODUCTION", ""))),
		rule("cost", "dev",
			group(mk("labelKV", "environment", "dev")),
			group(mk("labelKV", "env", "staging"))),
	}
}

func (e *Engine) loadPolicyRulesCM(ctx context.Context) {
	cm, err := e.Kube.GetJSON(ctx, "/api/v1/namespaces/"+e.Cfg.Namespace+"/configmaps/coolscaler-policy-rules")
	if err != nil {
		return
	}
	raw := getStr(getObj(cm, "data"), "rules.json")
	if raw == "" {
		raw = "[]"
	}
	v, err := pyjson.Decode([]byte(raw))
	if err != nil {
		return
	}
	if lst, ok := v.([]any); ok && len(lst) > 0 {
		e.mu.Lock()
		e.policyRules = lst
		e.mu.Unlock()
		e.Log.Info("loaded policy rules from ConfigMap", "count", len(lst))
	}
}

func identMatch(ident *pyjson.Obj, labels, anns *pyjson.Obj, env map[string]string) bool {
	t := getStr(ident, "type")
	k := getStr(ident, "key")
	v := ident.GetD("value", nil)
	switch t {
	case "labelKeys":
		return labels.Has(k)
	case "labelKV":
		return labels.GetD(k, nil) == v
	case "annotationKeys":
		return anns.Has(k)
	case "annotationKV":
		return anns.GetD(k, nil) == v
	case "envKeys":
		_, ok := env[k]
		return ok
	case "envKV":
		ev, ok := env[k]
		return ok && ev == str(v)
	}
	return false
}

// Returns ("","") for no match (rendered as null by callers).
func (e *Engine) matchPolicyRules(rules []any, labels, anns *pyjson.Obj, env map[string]string) (string, string) {
	for _, prv := range rules {
		pr := obj(prv)
		for _, rv := range getList(pr, "rules") {
			ids := getList(obj(rv), "identifiers")
			if len(ids) == 0 {
				continue
			}
			all := true
			for _, iv := range ids {
				if !identMatch(obj(iv), labels, anns, env) {
					all = false
					break
				}
			}
			if all {
				return getStr(pr, "policyName"), getStr(pr, "tag")
			}
		}
	}
	return "", ""
}
