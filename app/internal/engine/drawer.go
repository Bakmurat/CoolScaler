package engine

import (
	"context"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"coolscaler.sh/coolscaler/internal/prom"
	"coolscaler.sh/coolscaler/internal/pyjson"
)

// Per-workload rightsizing DRAWER family: tuning time-series, what-if,
// troubleshoot grid, network/APIs tabs, diagnostics timeline and the
// composite recommendation detail.

var tsPeriodSeconds = map[string]int64{
	"1h": 3600, "1d": 86400, "2w": 1209600, "7d": 604800, "30d": 2592000,
}

const (
	capMsgLower = "Recommendation is constrained by minimum resource boundaries set by the policy"
	capMsgUpper = "Recommendation limit is constrained by the workload's preserved limit (configured in the policy)"
)

func firstTruthy(a, b any) any {
	if truthy(a) {
		return a
	}
	return b
}

// or z` over policy specs: first truthy (non-empty) spec wins, else the
// LAST value even when falsy.
func orSpec(vals ...*pyjson.Obj) *pyjson.Obj {
	for _, v := range vals {
		if v != nil && v.Len() > 0 {
			return v
		}
	}
	if len(vals) == 0 {
		return nil
	}
	return vals[len(vals)-1]
}

func (e *Engine) promRange(ctx context.Context, promql string, start, end, step int64) []prom.Series {
	if e.Prom == nil {
		return nil
	}
	series, err := e.Prom.QueryRange(ctx, promql,
		time.Unix(start, 0), time.Unix(end, 0), time.Duration(step)*time.Second)
	if err != nil {
		e.Log.Info("prometheus query_range failed", "err", err)
		return nil
	}
	return series
}

func (e *Engine) promSeriesAt(ctx context.Context, promql string, start, end, step int64) map[int64]float64 {
	out := map[int64]float64{}
	for _, s := range e.promRange(ctx, promql, start, end, step) {
		for _, p := range s.Points {
			out[p.Timestamp.Unix()] = p.Value
		}
	}
	return out
}

func (e *Engine) promAgg(ctx context.Context, promql string, start, end, step int64, agg string) []any {
	bucket := map[int64][]float64{}
	for _, s := range e.promRange(ctx, promql, start, end, step) {
		for _, p := range s.Points {
			t := p.Timestamp.Unix()
			bucket[t] = append(bucket[t], p.Value)
		}
	}
	var ts []int64
	for t := range bucket {
		ts = append(ts, t)
	}
	sort.Slice(ts, func(i, j int) bool { return ts[i] < ts[j] })
	out := []any{}
	for _, t := range ts {
		v := bucket[t]
		var val float64
		switch agg {
		case "avg":
			sum := 0.0
			for _, x := range v {
				sum += x
			}
			val = sum / float64(len(v))
		case "max":
			val = maxFloat(v)
		default:
			sum := 0.0
			for _, x := range v {
				sum += x
			}
			val = sum
		}
		out = append(out, pyjson.NewObj().Set("t", t*1000).Set("v", val))
	}
	return out
}

func (e *Engine) promByLabel(ctx context.Context, promql string, start, end, step int64, key string) []any {
	out := []any{}
	for _, s := range e.promRange(ctx, promql, start, end, step) {
		lbl := s.Metric[key]
		if lbl == "" {
			lbl = key
		}
		pts := []any{}
		for _, p := range s.Points {
			pts = append(pts, pyjson.NewObj().
				Set("t", p.Timestamp.Unix()*1000).
				Set("v", p.Value))
		}
		if len(pts) > 0 {
			out = append(out, pyjson.NewObj().Set("label", lbl).Set("points", pts))
		}
	}
	return out
}

func (e *Engine) workloadInstances(ctx context.Context, ns, name string) []string {
	q := fmt.Sprintf(`count by(instance)(container_cpu_usage_seconds_total`+
		`{namespace="%s",pod=~"%s-.*",container!="",container!="POD"})`, ns, name)
	var insts []string
	for _, r := range e.promQuery(ctx, q) {
		if v := r.Metric["instance"]; v != "" {
			insts = append(insts, v)
		}
	}
	return insts
}

func cappingConfig(c *pyjson.Obj, kb knobs, dim string) *pyjson.Obj {
	cs := obj(obj(c.GetD("capStatuses", nil)).GetD(dim, nil))
	var mn, mx float64
	var hasMax bool
	if dim == "cpu" {
		mn = kb.cpuMin * 1000.0
		hasMax = kb.cpuMax < 1e8
		if hasMax {
			mx = kb.cpuMax * 1000.0
		} else {
			mx = f64d(c.GetD("limCpu", 0.0), 0) * 1000.0
		}
	} else {
		mn = kb.memMin
		hasMax = kb.memMax < 1e17
		if hasMax {
			mx = kb.memMax
		} else {
			mx = f64d(c.GetD("limMem", 0.0), 0)
		}
	}
	src := str(cs.GetD("cappedSource", nil))
	if src == "" {
		if hasMax {
			src = "policyBoundary"
		} else {
			src = "keepLimitPolicy"
		}
	}
	return pyjson.NewObj().
		Set("isCapped", truthy(cs.GetD("isCapped", nil))).
		Set("upperCappedMessage", capMsgUpper).
		Set("lowerCappedMessage", capMsgLower).
		Set("minAllowed", pyjson.Round(mn, 3)).
		Set("maxAllowed", pyjson.Round(mx, 3)).
		Set("cappingSource", src)
}

// {} when unreadable.
func (e *Engine) crOriginResources(ctx context.Context, ns, kind, name, container string) *pyjson.Obj {
	cr, err := e.getRecommendationCR(ctx, ns, kind, name)
	if err != nil {
		return pyjson.NewObj()
	}
	for _, cv := range getList(obj(getObj(cr, "status").GetD("rightSize", nil)), "containers") {
		c := obj(cv)
		cn := c.GetD("containerName", c.GetD("name", nil))
		if s, ok := cn.(string); !ok || s != container {
			continue
		}
		orig := obj(firstTruthy(c.GetD("originRequestsResources", nil), c.GetD("originRequests", nil)))
		olim := obj(c.GetD("originLimitResources", nil))
		return pyjson.NewObj().
			Set("reqCpu", ParseCPU(orig.GetD("cpu", nil))).
			Set("reqMem", ParseMem(orig.GetD("memory", nil))).
			Set("limCpu", ParseCPU(olim.GetD("cpu", nil))).
			Set("limMem", ParseMem(olim.GetD("memory", nil)))
	}
	return pyjson.NewObj()
}

// wfResolveSpec is the shared spec-resolution chain of timeseries_data /
// recommendation_whatif (incl. type:Schedule indirection).
func (e *Engine) wfResolveSpec(pols map[polKey]*pyjson.Obj, ns, policyName string) *pyjson.Obj {
	pspec := orSpec(pols[polKey{ns, policyName}],
		pols[polKey{e.Cfg.Namespace, policyName}],
		pols[polKey{"__default__", "production"}])
	if pspec != nil && pspec.Len() > 0 && getStr(pspec, "type") == "Schedule" {
		e.mu.Lock()
		sched := e.scheduleByName[policyName]
		e.mu.Unlock()
		if sched != nil {
			act := scheduleActivePolicy(sched, time.Now())
			pspec = orSpec(pols[polKey{ns, act}], pols[polKey{e.Cfg.Namespace, act}], pspec)
		}
	}
	return pspec
}

func (e *Engine) TimeseriesData(ctx context.Context, ns, kind, name, container, res, policyName, period string) (*pyjson.Obj, error) {
	key := wlkey(ns, kind, name)
	e.mu.Lock()
	row := e.byKey[key]
	e.mu.Unlock()
	ro := pyjson.NewObj()
	var conts []any
	if row != nil {
		ro = row.obj
		conts = getList(ro, "containers")
	}
	if len(conts) == 0 {
		return pyjson.NewObj().Set("found", false), nil
	}
	c := obj(conts[0])
	for _, xv := range conts {
		if getStr(obj(xv), "name") == container {
			c = obj(xv)
			break
		}
	}
	secs, ok := tsPeriodSeconds[period]
	if !ok {
		secs = 86400
	}
	end := time.Now().Unix()
	start := end - secs
	step := secs / 240 // ~240 points
	if step < 60 {
		step = 60
	}
	// Match the workload's pods by NAME PREFIX (robust to pod churn). NB: never
	// re.escape — hyphens must stay raw for Prometheus RE2.
	podRe := name + "-.*"
	var metric, unit string
	switch res {
	case "memory":
		metric = `container_memory_working_set_bytes{namespace="%s",pod=~"%s",container="%s"}`
		unit = "bytes"
	case "ephemeral":
		metric = `container_fs_usage_bytes{namespace="%s",pod=~"%s",container="%s"}`
		unit = "bytes"
	default:
		metric = `rate(container_cpu_usage_seconds_total` +
			`{namespace="%s",pod=~"%s",container="%s"}[5m])`
		unit = "cores"
	}
	series := e.promRange(ctx, fmt.Sprintf(metric, ns, podRe, container), start, end, step)
	points := []any{}
	var usageAll []float64
	var dataSource string
	if len(series) > 0 {
		// transpose to per-timestamp arrays across the workload's pods
		bucket := map[int64][]float64{}
		for _, s := range series {
			for _, p := range s.Points {
				t := p.Timestamp.Unix()
				bucket[t] = append(bucket[t], p.Value)
			}
		}
		var ts []int64
		for t := range bucket {
			ts = append(ts, t)
		}
		sort.Slice(ts, func(i, j int) bool { return ts[i] < ts[j] })
		for _, t := range ts {
			vals := bucket[t]
			sum := 0.0
			for _, v := range vals {
				sum += v
			}
			points = append(points, pyjson.NewObj().
				Set("t", t*1000).
				Set("avg", sum/float64(len(vals))).
				Set("p90", Percentile(vals, 90)).
				Set("max", maxFloat(vals)))
			usageAll = append(usageAll, vals...)
		}
		dataSource = "prometheus"
	} else {
		// fallback: in-memory rolling history (per-replica avg only → p90≈max≈avg)
		e.mu.Lock()
		hist := append([]histPoint(nil), e.history[key][container]...)
		e.mu.Unlock()
		useMem := res == "memory"
		base := end - int64(len(hist))*int64(e.Cfg.SampleIntervalSeconds)
		for i, h := range hist {
			v := h.cpu
			if useMem {
				v = h.mem
			}
			usageAll = append(usageAll, v)
			points = append(points, pyjson.NewObj().
				Set("t", (base+int64(i)*int64(e.Cfg.SampleIntervalSeconds))*1000).
				Set("avg", v).Set("p90", v).Set("max", v))
		}
		if len(points) > 0 {
			dataSource = "in-memory"
		} else {
			dataSource = "none"
		}
	}

	if res != "cpu" && res != "memory" && res != "ephemeral" {
		return nil, fmt.Errorf("'%s'", res)
	}
	var curAny, limAny any
	switch res {
	case "cpu":
		curAny = c.GetD("reqCpu", nil)
		limAny = c.GetD("limCpu", 0)
	case "memory":
		curAny = c.GetD("reqMem", nil)
		limAny = c.GetD("limMem", 0)
	default:
		curAny = c.GetD("reqEph", 0)
		limAny = c.GetD("limEph", 0)
	}
	curF := f64d(curAny, 0)
	// optimized line — recompute the recommendation under the chosen policy (what-if)
	pols := e.loadPolicies(ctx)
	pspec := e.wfResolveSpec(pols, ns, policyName)
	kb := e.policyKnobs(pspec)
	var opt float64
	switch res {
	case "cpu":
		if len(usageAll) > 0 {
			opt = Percentile(usageAll, kb.cpuPct) * kb.cpuHead
		} else {
			opt = f64d(c.GetD("recCpu", nil), 0)
		}
		opt = math.Max(kb.cpuMin, math.Min(opt, kb.cpuMax))
	case "memory":
		if len(usageAll) > 0 {
			opt = Percentile(usageAll, kb.memPct) * kb.memHead
		} else {
			opt = f64d(c.GetD("recMem", nil), 0)
		}
		opt = math.Max(kb.memMin, math.Min(opt, kb.memMax))
	default:
		if len(usageAll) > 0 {
			opt = maxFloat(usageAll) * kb.ephHead
		} else {
			opt = f64d(c.GetD("recEph", 0), 0)
		}
		if !kb.ephReduce && truthy(curAny) {
			opt = math.Max(opt, curF)
		}
	}
	cname := getStr(c, "name")
	origin := e.crOriginResources(ctx, ns, kind, name, cname)
	var origReqRaw, origLimRaw any
	switch res {
	case "cpu":
		origReqRaw = origin.GetD("reqCpu", nil)
		origLimRaw = origin.GetD("limCpu", nil)
	case "memory":
		origReqRaw = origin.GetD("reqMem", nil)
		origLimRaw = origin.GetD("limMem", nil)
	}
	origReq := firstTruthy(origReqRaw, curAny)
	origLim := firstTruthy(origLimRaw, limAny)
	reqAt, limAt := map[int64]float64{}, map[int64]float64{}
	if (res == "cpu" || res == "memory") && len(points) > 0 && dataSource == "prometheus" {
		ksmSel := fmt.Sprintf(`namespace="%s",pod=~"%s",container="%s",resource="%s"`,
			ns, podRe, cname, res)
		reqAt = e.promSeriesAt(ctx, "max(kube_pod_container_resource_requests{"+ksmSel+"})", start, end, step)
		limAt = e.promSeriesAt(ctx, "max(kube_pod_container_resource_limits{"+ksmSel+"})", start, end, step)
	}
	for _, pv := range points {
		p := obj(pv)
		t := i64(p.GetD("t", int64(0))) / 1000
		if v, ok := reqAt[t]; ok {
			p.Set("currentRequest", v)
		} else {
			p.Set("currentRequest", curAny)
		}
		p.Set("originRequest", origReq)
		p.Set("recommendedRequest", opt)
		if v, ok := limAt[t]; ok {
			p.Set("currentLimit", v)
		} else {
			p.Set("currentLimit", limAny)
		}
		p.Set("originalLimit", origLim)
	}
	javaPoints := []any{}
	if res == "memory" && truthy(ro.GetD("java", nil)) {
		jseries := e.promRange(ctx, fmt.Sprintf(
			`java_lang_Memory_HeapMemoryUsage_used{namespace="%s",pod=~"%s"}`, ns, podRe),
			start, end, step)
		jb := map[int64][]float64{}
		for _, s := range jseries {
			for _, p := range s.Points {
				t := p.Timestamp.Unix()
				jb[t] = append(jb[t], p.Value)
			}
		}
		var jts []int64
		for t := range jb {
			jts = append(jts, t)
		}
		sort.Slice(jts, func(i, j int) bool { return jts[i] < jts[j] })
		for _, t := range jts {
			vals := jb[t]
			javaPoints = append(javaPoints, pyjson.NewObj().
				Set("t", t*1000).
				Set("p90", Percentile(vals, 90)).
				Set("max", maxFloat(vals)))
		}
	}
	contNames := []any{}
	for _, xv := range conts {
		contNames = append(contNames, obj(xv).GetD("name", nil))
	}
	return pyjson.NewObj().
		Set("found", true).
		Set("res", res).
		Set("unit", unit).
		Set("container", c.GetD("name", nil)).
		Set("containers", contNames).
		Set("dataSource", dataSource).
		Set("period", period).
		Set("policy", policyName).
		Set("points", points).
		Set("javaPoints", javaPoints).
		Set("lines", pyjson.NewObj().
			Set("optimized", opt).
			Set("current", curAny).
			Set("original", origReq).
			Set("limit", limAny).
			Set("originalLimit", origLim)).
		Set("cpuCappingConfig", cappingConfig(c, kb, "cpu")).
		Set("memoryCappingConfig", cappingConfig(c, kb, "memory")), nil
}

func (e *Engine) wfPctile(ctx context.Context, ns, name, container, res string, pct float64) (float64, bool) {
	if e.Prom == nil {
		return 0, false
	}
	podRe := name + "-.*"
	var base string
	switch res {
	case "cpu":
		base = fmt.Sprintf(`rate(container_cpu_usage_seconds_total`+
			`{namespace="%s",pod=~"%s",container="%s"}[5m])`, ns, podRe, container)
	case "ephemeral":
		base = fmt.Sprintf(`container_fs_usage_bytes`+
			`{namespace="%s",pod=~"%s",container="%s"}`, ns, podRe, container)
	default:
		base = fmt.Sprintf(`container_memory_working_set_bytes`+
			`{namespace="%s",pod=~"%s",container="%s"}`, ns, podRe, container)
	}
	q := fmt.Sprintf("quantile_over_time(%.2f, (%s)[%s:%s])", pct/100.0, base,
		e.Cfg.PromWindow, e.Cfg.PromStep)
	var vals []float64
	for _, r := range e.promQuery(ctx, q) {
		vals = append(vals, r.Value)
	}
	if len(vals) == 0 {
		return 0, false
	}
	return maxFloat(vals), true
}

func (e *Engine) RecommendationWhatif(ctx context.Context, ns, kind, name, policy string) (*pyjson.Obj, error, bool) {
	e.mu.Lock()
	row := e.byKey[wlkey(ns, kind, name)]
	e.mu.Unlock()
	if row == nil {
		return nil, nil, false
	}
	conts := getList(row.obj, "containers")
	replicas := row.replicas
	if replicas < 1 {
		replicas = 1
	}
	pols := e.loadPolicies(ctx)
	pspec := e.wfResolveSpec(pols, ns, policy)
	kb := e.policyKnobs(pspec)
	out := []any{}
	curCpuT, curMemT, optCpuT, optMemT := 0.0, 0.0, 0.0, 0.0
	for _, cv := range conts {
		c := obj(cv)
		curCpu := f64d(c.GetD("reqCpu", 0.0), 0)
		curMem := f64d(c.GetD("reqMem", 0.0), 0)
		cname := getStr(c, "name")
		uCpu, okCpu := e.wfPctile(ctx, ns, name, cname, "cpu", kb.cpuPct)
		uMem, okMem := e.wfPctile(ctx, ns, name, cname, "memory", kb.memPct)
		var optCpu, optMem float64
		if okCpu {
			optCpu = math.Max(kb.cpuMin, math.Min(uCpu*kb.cpuHead, kb.cpuMax))
		} else {
			optCpu = f64d(c.GetD("recCpu", nil), curCpu)
		}
		if okMem {
			optMem = math.Max(kb.memMin, math.Min(uMem*kb.memHead, kb.memMax))
		} else {
			optMem = f64d(c.GetD("recMem", nil), curMem)
		}
		req := pyjson.NewObj().Set("cpu", FmtCPU(optCpu)).Set("memory", FmtMem(optMem))
		orig := pyjson.NewObj().Set("cpu", FmtCPU(curCpu)).Set("memory", FmtMem(curMem))
		// ephemeral-storage what-if — keep the eph row alive when the container
		// has a disk request
		curEph := f64d(c.GetD("reqEph", 0.0), 0)
		if curEph != 0 {
			uEph, okEph := e.wfPctile(ctx, ns, name, cname, "ephemeral", kb.ephPct)
			var optEph float64
			if okEph {
				optEph = uEph * kb.ephHead
			} else {
				optEph = f64d(c.GetD("recEph", nil), curEph)
			}
			if !kb.ephReduce {
				optEph = math.Max(optEph, curEph) // never lower disk unless the policy allows it
			}
			req.Set("ephemeral-storage", FmtMem(optEph))
			orig.Set("ephemeral-storage", FmtMem(curEph))
		}
		out = append(out, pyjson.NewObj().
			Set("name", c.GetD("name", nil)).
			Set("requests", req).
			Set("originRequests", orig))
		curCpuT += curCpu
		curMemT += curMem
		optCpuT += optCpu
		optMemT += optMem
	}
	curCost := e.monthlyCost(curCpuT*float64(replicas), curMemT*float64(replicas))
	reclaim := e.monthlyCost(math.Max(0.0, curCpuT-optCpuT)*float64(replicas),
		math.Max(0.0, curMemT-optMemT)*float64(replicas))
	// include init-container savings (policy-independent) so switching policy in
	// the what-if doesn't collapse an init-heavy workload's savings.
	reclaim += f64d(row.obj.GetD("initSavings", 0.0), 0)
	dataSource := "estimate"
	if e.Prom != nil {
		dataSource = "prometheus"
	}
	return pyjson.NewObj().
		Set("policy", policy).
		Set("containers", out).
		Set("monthlyCost", pyjson.Round(curCost, 2)).
		Set("savings", pyjson.Round(reclaim, 2)).
		Set("dataSource", dataSource), nil, true
}

func tsLinePts(label, color string, points []any, dash bool) *pyjson.Obj {
	if points == nil {
		points = []any{}
	}
	return pyjson.NewObj().
		Set("label", label).Set("color", color).Set("dash", dash).
		Set("points", points)
}

func tsLineFlat(label, color string, flat any, dash bool) *pyjson.Obj {
	return pyjson.NewObj().
		Set("label", label).Set("color", color).Set("dash", dash).
		Set("flat", flat)
}

func (e *Engine) TroubleshootData(ctx context.Context, ns, kind, name, period string) (*pyjson.Obj, error) {
	e.mu.Lock()
	row := e.byKey[wlkey(ns, kind, name)]
	e.mu.Unlock()
	if row == nil {
		return pyjson.NewObj().Set("found", false), nil
	}
	ro := row.obj
	secs, ok := tsPeriodSeconds[period]
	if !ok {
		secs = 86400
	}
	end := time.Now().Unix()
	start := end - secs
	step := secs / 200
	if step < 60 {
		step = 60
	}
	podRe := name + "-.*"
	reps := row.replicas
	if reps < 1 {
		reps = 1
	}
	sel := fmt.Sprintf(`namespace="%s",pod=~"%s",container!="",container!="POD"`, ns, podRe)
	key := wlkey(ns, kind, name)
	e.mu.Lock()
	replicasAuto := e.replicasAutomated[key]
	schedAuto := e.schedulingAutomated[key]
	e.mu.Unlock()
	charts := []any{}
	add := func(ch *pyjson.Obj, selected bool) {
		charts = append(charts, ch.Set("selected", selected))
	}

	// --- First card: CPU + Memory with the full 8-series set (Usage avg/p90/
	// max across the workload's pods + Optimized/Request/Original request +
	// Current/Original limit), reusing the rightsizing-tab per-pod transpose. ---
	podDist := func(promql string) (avgPts, p90Pts, maxPts []any) {
		avgPts, p90Pts, maxPts = []any{}, []any{}, []any{}
		bucket := map[int64][]float64{}
		for _, s := range e.promRange(ctx, promql, start, end, step) {
			for _, p := range s.Points {
				t := p.Timestamp.Unix()
				bucket[t] = append(bucket[t], p.Value)
			}
		}
		var ts []int64
		for t := range bucket {
			ts = append(ts, t)
		}
		sort.Slice(ts, func(i, j int) bool { return ts[i] < ts[j] })
		for _, t := range ts {
			vals := bucket[t]
			sum := 0.0
			for _, v := range vals {
				sum += v
			}
			avgPts = append(avgPts, pyjson.NewObj().Set("t", t*1000).Set("v", sum/float64(len(vals))))
			p90Pts = append(p90Pts, pyjson.NewObj().Set("t", t*1000).Set("v", Percentile(vals, 90)))
			maxPts = append(maxPts, pyjson.NewObj().Set("t", t*1000).Set("v", maxFloat(vals)))
		}
		return
	}
	// current limits = sum over the workload's containers (per replica)
	var limCpu, limMem float64
	for _, cv := range getList(ro, "containers") {
		c := obj(cv)
		limCpu += f64d(c.GetD("limCpu", 0.0), 0)
		limMem += f64d(c.GetD("limMem", 0.0), 0)
	}
	origLimCpu, origLimMem := e.crOriginLimitTotals(ctx, ns, kind, name)
	if origLimCpu == 0 {
		origLimCpu = limCpu
	}
	if origLimMem == 0 {
		origLimMem = limMem
	}
	firstCard := func(id, title, unit, promql string, opt, req, orig, lim, origLim float64) (*pyjson.Obj, bool) {
		avgPts, p90Pts, maxPts := podDist(promql)
		series := []any{
			tsLinePts("Usage (avg)", "#3b82f6", avgPts, false),
			tsLinePts("Usage (P90)", "#60a5fa", p90Pts, false),
			tsLinePts("Usage (max)", "#93c5fd", maxPts, false),
			tsLineFlat("Optimized request", "#10b981", opt, true),
			tsLineFlat("Request", "#f59e0b", req, false),
			tsLineFlat("Original request", "#fbbf24", orig, true),
		}
		if lim > 0 {
			series = append(series, tsLineFlat("Current limit", "#ef4444", lim, false))
		}
		if origLim > 0 {
			series = append(series, tsLineFlat("Original limit", "#fca5a5", origLim, true))
		}
		return pyjson.NewObj().
			Set("id", id).Set("title", title).Set("unit", unit).
			Set("series", series), len(avgPts) > 0
	}
	cpuChart, cpuHit := firstCard("cpu", "CPU", "cores",
		fmt.Sprintf(`sum by(pod)(rate(container_cpu_usage_seconds_total{%s}[5m]))`, sel),
		f64d(ro.GetD("recCpu", 0), 0), f64d(ro.GetD("reqCpu", 0), 0),
		f64d(ro.GetD("origCpu", ro.GetD("reqCpu", 0)), 0), limCpu, origLimCpu)
	add(cpuChart, true)
	memChart, memHit := firstCard("mem", "Memory", "bytes",
		fmt.Sprintf(`sum by(pod)(container_memory_working_set_bytes{%s})`, sel),
		f64d(ro.GetD("recMem", 0), 0), f64d(ro.GetD("reqMem", 0), 0),
		f64d(ro.GetD("origMem", ro.GetD("reqMem", 0)), 0), limMem, origLimMem)
	add(memChart, true)
	// Ephemeral storage (only when the workload uses it)
	if truthy(ro.GetD("reqEph", 0)) || truthy(ro.GetD("useEph", 0)) {
		ephUse := e.promAgg(ctx, fmt.Sprintf(`sum(container_fs_usage_bytes{%s})`, sel), start, end, step, "sum")
		add(pyjson.NewObj().
			Set("id", "eph").Set("title", "Ephemeral storage").Set("unit", "bytes").
			Set("series", []any{
				tsLinePts("Usage", "#3b82f6", ephUse, false),
				tsLineFlat("Request", "#f59e0b", f64d(ro.GetD("reqEph", 0), 0)*float64(reps), false),
				tsLineFlat("Recommendation", "#10b981", f64d(ro.GetD("recEph", 0), 0)*float64(reps), true),
			}), true)
	}
	realHit := cpuHit || memHit

	// Node CPU / Memory Utilization
	insts := e.workloadInstances(ctx, ns, name)
	nodeFilter := func(series []any) []any {
		if len(insts) == 0 {
			return series
		}
		want := map[string]bool{}
		for _, in := range insts {
			want[strings.SplitN(in, ":", 2)[0]] = true
		}
		kept := []any{}
		for _, sv := range series {
			lbl := strings.SplitN(getStr(obj(sv), "label"), ":", 2)[0]
			if want[lbl] {
				kept = append(kept, sv)
			}
		}
		if len(kept) > 0 {
			return kept
		}
		return series
	}
	colors := []string{"#4f46e5", "#0ea5e9", "#f59e0b", "#22c55e", "#ec4899", "#14b8a6"}
	ncpu := nodeFilter(e.promByLabel(ctx,
		`1 - avg by(instance)(rate(node_cpu_seconds_total{mode="idle"}[5m]))`,
		start, end, step, "instance"))
	if len(ncpu) > 0 {
		realHit = true
	}
	add(pyjson.NewObj().
		Set("id", "nodecpu").Set("title", "Node CPU Utilization").Set("unit", "ratio").
		Set("series", multiSeries(ncpu, colors, "Utilization")), true)
	nmem := nodeFilter(e.promByLabel(ctx,
		`1 - (node_memory_MemAvailable_bytes / clamp_min(node_memory_MemTotal_bytes,1))`,
		start, end, step, "instance"))
	if len(nmem) > 0 {
		realHit = true
	}
	add(pyjson.NewObj().
		Set("id", "nodemem").Set("title", "Node Memory Utilization").Set("unit", "ratio").
		Set("series", multiSeries(nmem, colors, "Utilization")), true)
	// Automated — categorical per-product rows.
	b2i := func(b bool) int {
		if b {
			return 1
		}
		return 0
	}
	add(pyjson.NewObj().
		Set("id", "automated").Set("title", "Automated").Set("unit", "categorical").
		Set("series", []any{
			tsLineFlat("Rightsizing", "#22c55e", b2i(truthy(ro.GetD("automated", nil))), false),
			tsLineFlat("Replicas", "#3b82f6", b2i(replicasAuto), false),
			tsLineFlat("GPU", "#a855f7", 0, false),
			tsLineFlat("Spot", "#f59e0b", 0, false),
			tsLineFlat("Scheduling", "#14b8a6", b2i(schedAuto), false),
		}), true)
	// Replicas — ready vs desired
	ready := e.promAgg(ctx, fmt.Sprintf(
		`count(kube_pod_status_phase{namespace="%s",pod=~"%s",phase="Running"})`, ns, podRe),
		start, end, step, "max")
	add(pyjson.NewObj().
		Set("id", "replicas").Set("title", "Replicas").Set("unit", "count").
		Set("series", []any{
			tsLinePts("Ready", "#3b82f6", ready, false),
			tsLineFlat("Desired", "#94a3b8", reps, true)}), true)
	// CPU throttling
	thr := e.promAgg(ctx, fmt.Sprintf(
		`sum(rate(container_cpu_cfs_throttled_periods_total{%s}[5m]))`+
			`/clamp_min(sum(rate(container_cpu_cfs_periods_total{%s}[5m])),1)`, sel, sel),
		start, end, step, "avg")
	add(pyjson.NewObj().
		Set("id", "throttle").Set("title", "CPU Throttling").Set("unit", "ratio").
		Set("series", []any{tsLinePts("Throttled periods", "#b45309", thr, false)}), true)
	// Out-of-Memory
	oom := e.promAgg(ctx, fmt.Sprintf(
		`sum(increase(kube_pod_container_status_terminated_reason`+
			`{namespace="%s",pod=~"%s",reason="OOMKilled"}[5m]))`, ns, podRe),
		start, end, step, "max")
	add(pyjson.NewObj().
		Set("id", "oom").Set("title", "Out-of-Memory").Set("unit", "count").
		Set("series", []any{tsLinePts("OOM kills", "#dc2626", oom, false)}), true)
	// Liveness Probe Failure
	live := e.promAgg(ctx, fmt.Sprintf(
		`sum(increase(prober_probe_total{probe_type="Liveness",result!="successful",`+
			`namespace="%s",pod=~"%s"}[5m]))`, ns, podRe),
		start, end, step, "max")
	add(pyjson.NewObj().
		Set("id", "liveness").Set("title", "Liveness Probe Failure").Set("unit", "count").
		Set("series", []any{tsLinePts("Failures", "#f59e0b", live, false)}), true)
	// Pod Disruption Reasons
	disr := e.promAgg(ctx, fmt.Sprintf(
		`sum(kube_pod_status_reason{namespace="%s",pod=~"%s",`+
			`reason=~"Evicted|NodeLost|Shutdown|NodeAffinity|UnexpectedAdmissionError"})`, ns, podRe),
		start, end, step, "max")
	add(pyjson.NewObj().
		Set("id", "disruption").Set("title", "Pod Disruption Reasons").Set("unit", "count").
		Set("series", []any{tsLinePts("Disruptions", "#e11d48", disr, false)}), true)
	// CPU / Memory Noisy Neighbors
	instRe := ""
	if len(insts) > 0 {
		cleaned := make([]string, len(insts))
		for i, in := range insts {
			cleaned[i] = cleanInstanceLabel(in)
		}
		instRe = strings.Join(cleaned, "|")
	}
	var cpuNodes, memNodes []any
	if instRe != "" {
		cpuNodes = e.promByLabel(ctx, fmt.Sprintf(
			`sum by(instance)(rate(container_cpu_usage_seconds_total`+
				`{instance=~"%s",container!="",container!="POD"}[5m]))`, instRe),
			start, end, step, "instance")
		memNodes = e.promByLabel(ctx, fmt.Sprintf(
			`sum by(instance)(container_memory_working_set_bytes`+
				`{instance=~"%s",container!="",container!="POD"})`, instRe),
			start, end, step, "instance")
	}
	if len(cpuNodes) > 0 {
		realHit = true
	}
	add(pyjson.NewObj().
		Set("id", "cpunoisy").Set("title", "CPU Noisy Neighbors").
		Set("unit", "cores").Set("series", noisySeries(cpuNodes, colors)), true)
	add(pyjson.NewObj().
		Set("id", "memnoisy").Set("title", "Memory Noisy Neighbors").
		Set("unit", "bytes").Set("series", noisySeries(memNodes, colors)), true)
	// Container Restarts
	rst := e.promAgg(ctx, fmt.Sprintf(
		`sum(kube_pod_container_status_restarts_total{namespace="%s",pod=~"%s"})`, ns, podRe),
		start, end, step, "max")
	add(pyjson.NewObj().
		Set("id", "restarts").Set("title", "Container Restarts").Set("unit", "count").
		Set("series", []any{tsLinePts("Restarts", "#ef4444", rst, false)}), true)
	// API observability charts
	add(pyjson.NewObj().
		Set("id", "apireq").Set("title", "API Requests").Set("unit", "rps").
		Set("series", []any{
			tsLinePts("All", "#3b82f6", nil, false),
			tsLinePts("OK", "#22c55e", nil, false),
			tsLinePts("Errors", "#ef4444", nil, false)}), true)
	add(pyjson.NewObj().
		Set("id", "apierr").Set("title", "API Errors").Set("unit", "rps").
		Set("series", []any{tsLinePts("Errors", "#ef4444", nil, false)}), true)
	add(pyjson.NewObj().
		Set("id", "apilat").Set("title", "API Latency").Set("unit", "ms").
		Set("series", []any{
			tsLinePts("P50", "#a5b4fc", nil, false),
			tsLinePts("P95", "#6366f1", nil, false)}), true)
	add(pyjson.NewObj().
		Set("id", "apireqpod").Set("title", "API Requests per Pod").Set("unit", "rps").
		Set("series", []any{tsLinePts("Per pod", "#8b5cf6", nil, false)}), true)
	add(pyjson.NewObj().
		Set("id", "apiinflight").Set("title", "API In-Flight per Pod").Set("unit", "count").
		Set("series", []any{tsLinePts("In-flight", "#6366f1", nil, false)}), true)

	// --- Available-charts catalog (picker extras, selected=false) ---
	ksmNs := fmt.Sprintf(`namespace="%s",pod=~"%s"`, ns, podRe)
	// HPA CPU / Memory
	if hpaName := str(ro.GetD("hpaName", nil)); hpaName != "" {
		hpaSel := fmt.Sprintf(`namespace="%s",horizontalpodautoscaler="%s"`, ns, hpaName)
		for _, hr := range []struct{ id, title, metric string }{
			{"hpacpu", "HPA CPU", "cpu"},
			{"hpamem", "HPA Memory", "memory"},
		} {
			cur := e.promAgg(ctx, fmt.Sprintf(
				`max(kube_horizontalpodautoscaler_status_target_metric{%s,metric_name="%s"})`,
				hpaSel, hr.metric), start, end, step, "max")
			tgt := e.promAgg(ctx, fmt.Sprintf(
				`max(kube_horizontalpodautoscaler_spec_target_metric{%s,metric_name="%s"})`,
				hpaSel, hr.metric), start, end, step, "max")
			add(pyjson.NewObj().
				Set("id", hr.id).Set("title", hr.title).Set("unit", "ratio").
				Set("series", []any{
					tsLinePts("Current", "#3b82f6", cur, false),
					tsLinePts("Target", "#94a3b8", tgt, true)}), false)
		}
	}
	// Pod CPU / Memory Request
	podCpuReq := e.promAgg(ctx, fmt.Sprintf(
		`avg(sum by(pod)(kube_pod_container_resource_requests{%s,resource="cpu",container!=""}))`, ksmNs),
		start, end, step, "avg")
	add(pyjson.NewObj().
		Set("id", "podcpureq").Set("title", "Pod CPU Request").Set("unit", "cores").
		Set("series", []any{tsLinePts("Request", "#f59e0b", podCpuReq, false)}), false)
	podMemReq := e.promAgg(ctx, fmt.Sprintf(
		`avg(sum by(pod)(kube_pod_container_resource_requests{%s,resource="memory",container!=""}))`, ksmNs),
		start, end, step, "avg")
	add(pyjson.NewObj().
		Set("id", "podmemreq").Set("title", "Pod Memory Request").Set("unit", "bytes").
		Set("series", []any{tsLinePts("Request", "#f59e0b", podMemReq, false)}), false)
	// Nodes life cycle
	spotN, ondemandN := e.nodeLifecycleCounts(ctx)
	add(pyjson.NewObj().
		Set("id", "nodelifecycle").Set("title", "Nodes life cycle").Set("unit", "count").
		Set("series", []any{
			tsLineFlat("On-demand", "#3b82f6", ondemandN, false),
			tsLineFlat("Spot", "#f59e0b", spotN, false)}), false)
	// Init-container charts — only when the workload has init containers today.
	if initList := getList(ro, "initOptimization"); len(initList) > 0 {
		var initNames []string
		for _, iv := range initList {
			if n := getStr(obj(iv), "name"); n != "" {
				initNames = append(initNames, n)
			}
		}
		if len(initNames) > 0 {
			initSel := fmt.Sprintf(`namespace="%s",pod=~"%s",container=~"%s"`,
				ns, podRe, strings.Join(initNames, "|"))
			initCpu := e.promByLabel(ctx, fmt.Sprintf(
				`sum by(container)(rate(container_cpu_usage_seconds_total{%s}[5m]))`, initSel),
				start, end, step, "container")
			add(pyjson.NewObj().
				Set("id", "initcpu").Set("title", "Init Containers CPU").Set("unit", "cores").
				Set("series", multiSeries(initCpu, colors, "Usage")), false)
			initMem := e.promByLabel(ctx, fmt.Sprintf(
				`sum by(container)(container_memory_working_set_bytes{%s})`, initSel),
				start, end, step, "container")
			add(pyjson.NewObj().
				Set("id", "initmem").Set("title", "Init Containers Memory").Set("unit", "bytes").
				Set("series", multiSeries(initMem, colors, "Usage")), false)
		}
		// Init-container REQUEST OVERHEAD: the extra CPU/mem an init container
		// reserves above the main-container recommendation. Flat lines: max init
		// request vs recommended main request + the overhead gap.
		maxICpu, maxIMem := 0.0, 0.0
		for _, iv := range initList {
			io := obj(iv)
			if c := f64d(io.GetD("reqCpu", 0.0), 0); c > maxICpu {
				maxICpu = c
			}
			if m := f64d(io.GetD("reqMem", 0.0), 0); m > maxIMem {
				maxIMem = m
			}
		}
		add(pyjson.NewObj().
			Set("id", "initcpuover").Set("title", "Init Container CPU Request Overhead").Set("unit", "cores").
			Set("series", []any{
				tsLineFlat("Max init request", "#f59e0b", maxICpu, false),
				tsLineFlat("Recommended request", "#3b82f6", f64d(ro.GetD("recCpu", 0.0), 0), true),
				tsLineFlat("Overhead", "#ef4444", f64d(ro.GetD("initOverCpu", 0.0), 0), false),
			}), false)
		add(pyjson.NewObj().
			Set("id", "initmemover").Set("title", "Init Container Memory Request Overhead").Set("unit", "bytes").
			Set("series", []any{
				tsLineFlat("Max init request", "#f59e0b", maxIMem, false),
				tsLineFlat("Recommended request", "#3b82f6", f64d(ro.GetD("recMem", 0.0), 0), true),
				tsLineFlat("Overhead", "#ef4444", f64d(ro.GetD("initOverMem", 0.0), 0), false),
			}), false)
	}

	src := "synthesized"
	if realHit {
		src = "prometheus"
	}
	return pyjson.NewObj().
		Set("found", true).
		Set("period", period).
		Set("dataSource", src).
		Set("charts", charts), nil
}

// crOriginLimitTotals sums the Recommendation CR's originLimitResources across
// containers (per replica); zeros when the CR is unreadable.
func (e *Engine) crOriginLimitTotals(ctx context.Context, ns, kind, name string) (limCpu, limMem float64) {
	cr, err := e.getRecommendationCR(ctx, ns, kind, name)
	if err != nil {
		return 0, 0
	}
	for _, cv := range getList(obj(getObj(cr, "status").GetD("rightSize", nil)), "containers") {
		olim := obj(obj(cv).GetD("originLimitResources", nil))
		limCpu += ParseCPU(olim.GetD("cpu", nil))
		limMem += ParseMem(olim.GetD("memory", nil))
	}
	return limCpu, limMem
}

func (e *Engine) nodeLifecycleCounts(ctx context.Context) (spot, onDemand int) {
	nodes, err := e.Kube.GetJSON(ctx, "/api/v1/nodes")
	if err != nil {
		return 0, 0
	}
	for _, nv := range items(nodes) {
		lbl := getObj(getObj(obj(nv), "metadata"), "labels")
		captype := ""
		for _, k := range []string{
			"karpenter.sh/capacity-type", "eks.amazonaws.com/capacityType",
			"node.kubernetes.io/capacity-type", "cloud.google.com/gke-spot",
		} {
			if v := getStr(lbl, k); v != "" {
				captype = v
				break
			}
		}
		captype = strings.ToLower(captype)
		if captype == "spot" || captype == "true" {
			spot++
		} else {
			onDemand++
		}
	}
	return spot, onDemand
}

func cleanInstanceLabel(s string) string {
	var b strings.Builder
	for _, r := range s {
		if (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') ||
			r == '_' || r == '.' || r == ':' || r == '\\' || r == '-' {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func multiSeries(entries []any, colors []string, fallback string) []any {
	series := []any{}
	for i, sv := range entries {
		s := obj(sv)
		pts, _ := s.GetD("points", nil).([]any)
		series = append(series, tsLinePts(getStr(s, "label"), colors[i%len(colors)], pts, false))
	}
	if len(series) == 0 {
		series = []any{tsLinePts(fallback, "#4f46e5", nil, false)}
	}
	return series
}

// noisySeries renders the per-node noisy-neighbor lines.
func noisySeries(nodes []any, colors []string) []any {
	return multiSeries(nodes, colors, "Node share")
}

func (e *Engine) NetworkData(ctx context.Context, ns, kind, name string) (*pyjson.Obj, error) {
	e.mu.Lock()
	row := e.byKey[wlkey(ns, kind, name)]
	e.mu.Unlock()
	if row == nil {
		return pyjson.NewObj().Set("found", false), nil
	}
	net := fmt.Sprintf(`namespace="%s",pod=~"%s-.*"`, ns, name)
	inst := func(promql string) float64 {
		r := e.promQuery(ctx, promql)
		if len(r) == 0 {
			return 0.0
		}
		return r[0].Value
	}
	ingress := inst(fmt.Sprintf(`sum(rate(container_network_receive_bytes_total{%s}[5m]))`, net))
	egress := inst(fmt.Sprintf(`sum(rate(container_network_transmit_bytes_total{%s}[5m]))`, net))
	end := time.Now().Unix()
	start := end - 3600
	var step int64 = 120
	inr := e.promAgg(ctx, fmt.Sprintf(`sum(rate(container_network_receive_bytes_total{%s}[5m]))`, net), start, end, step, "avg")
	outr := e.promAgg(ctx, fmt.Sprintf(`sum(rate(container_network_transmit_bytes_total{%s}[5m]))`, net), start, end, step, "avg")
	outm := map[int64]float64{}
	for _, pv := range outr {
		p := obj(pv)
		outm[i64(p.GetD("t", int64(0)))] = f64d(p.GetD("v", 0), 0)
	}
	series := []any{}
	for _, pv := range inr {
		p := obj(pv)
		t := i64(p.GetD("t", int64(0)))
		series = append(series, pyjson.NewObj().
			Set("t", p.GetD("t", nil)).
			Set("in", p.GetD("v", nil)).
			Set("out", outm[t]))
	}
	return pyjson.NewObj().
		Set("found", true).
		Set("peers", []any{}).
		Set("topologyAvailable", false).
		Set("totals", pyjson.NewObj().Set("ingressBps", ingress).Set("egressBps", egress)).
		Set("series", series), nil
}

// netWindows whitelists the ?window= values for the network rollup (the range
// picker on the flow/report pages).
var netWindows = map[string]bool{"5m": true, "1h": true, "24h": true, "7d": true}

// cross-AZ $ / topology have NO source and stay null/unavailable. window picks
// the rate() averaging window; top bounds the flow-map node count.
func (e *Engine) NetworkCostData(ctx context.Context, window string, top int) (*pyjson.Obj, error) {
	if !netWindows[window] {
		window = "5m"
	}
	if top <= 0 || top > 50 {
		top = 10
	}
	byNs := func(promql string) *pyjson.Obj {
		out := pyjson.NewObj()
		for _, r := range e.promQuery(ctx, promql) {
			out.Set(r.Metric["namespace"], r.Value)
		}
		return out
	}
	ing := byNs(`sum by(namespace)(rate(container_network_receive_bytes_total{namespace!=""}[` + window + `]))`)
	egr := byNs(`sum by(namespace)(rate(container_network_transmit_bytes_total{namespace!=""}[` + window + `]))`)
	seen := map[string]bool{}
	var names []string
	for _, k := range ing.Keys() {
		if !seen[k] {
			seen[k] = true
			names = append(names, k)
		}
	}
	for _, k := range egr.Keys() {
		if !seen[k] {
			seen[k] = true
			names = append(names, k)
		}
	}
	sortStrings(names)
	type nsRow struct {
		o     *pyjson.Obj
		total float64
	}
	var rows []nsRow
	for _, n := range names {
		in := f64d(ing.GetD(n, 0.0), 0)
		out := f64d(egr.GetD(n, 0.0), 0)
		rows = append(rows, nsRow{pyjson.NewObj().
			Set("namespace", n).
			Set("ingressBps", in).
			Set("egressBps", out).
			Set("crossAzMonthlyCost", nil), in + out}) // None → ??? (no attribution source)
	}
	sort.SliceStable(rows, func(i, j int) bool { return rows[i].total > rows[j].total })
	nss := []any{}
	for _, r := range rows {
		nss = append(nss, r.o)
	}
	// Pods whose owner is unknown are aggregated under their namespace as
	// "<ns>/(other pods)".
	podRate := func(promql string) map[[2]string]float64 {
		out := map[[2]string]float64{}
		for _, r := range e.promQuery(ctx, promql) {
			out[[2]string{r.Metric["namespace"], r.Metric["pod"]}] = r.Value
		}
		return out
	}
	podIn := podRate(`sum by(namespace,pod)(rate(container_network_receive_bytes_total{namespace!="",pod!=""}[` + window + `]))`)
	podOut := podRate(`sum by(namespace,pod)(rate(container_network_transmit_bytes_total{namespace!="",pod!=""}[` + window + `]))`)
	type wlAgg struct {
		ns, kind, name string
		in, out        float64
	}
	pod2wl := map[[2]string][2]string{} // (ns,pod) -> (kind,name)
	e.mu.Lock()
	for _, w := range e.workloads {
		if w.kind == "Node" {
			// Node pseudo-rows list every pod ON the node — attributing pod
			// traffic to them would double-aggregate whole nodes as workloads.
			continue
		}
		for _, pv := range getList(w.obj, "podNames") {
			pod2wl[[2]string{w.namespace, str(pv)}] = [2]string{w.kind, w.name}
		}
	}
	e.mu.Unlock()
	wlAggs := map[string]*wlAgg{}
	addPod := func(key [2]string, in, out float64) {
		kind, name := "Namespace", key[0]+"/(other pods)"
		if wk, ok := pod2wl[key]; ok {
			kind, name = wk[0], wk[1]
		}
		id := key[0] + "|" + kind + "|" + name
		a := wlAggs[id]
		if a == nil {
			a = &wlAgg{ns: key[0], kind: kind, name: name}
			wlAggs[id] = a
		}
		a.in += in
		a.out += out
	}
	seenPod := map[[2]string]bool{}
	for k, v := range podIn {
		seenPod[k] = true
		addPod(k, v, podOut[k])
	}
	for k, v := range podOut {
		if !seenPod[k] {
			addPod(k, 0, v)
		}
	}
	var wlRows []*wlAgg
	for _, a := range wlAggs {
		wlRows = append(wlRows, a)
	}
	sort.SliceStable(wlRows, func(i, j int) bool {
		ti, tj := wlRows[i].in+wlRows[i].out, wlRows[j].in+wlRows[j].out
		if ti != tj {
			return ti > tj
		}
		return wlRows[i].ns+wlRows[i].name < wlRows[j].ns+wlRows[j].name
	})
	wlList := []any{}
	for _, a := range wlRows {
		wlList = append(wlList, pyjson.NewObj().
			Set("namespace", a.ns).Set("workloadType", a.kind).Set("workloadName", a.name).
			Set("ingressBps", a.in).Set("egressBps", a.out).
			Set("crossAzMonthlyCost", nil))
	}
	mapNodes := []any{}
	mapEdges := []any{}
	const extID = "__external__"
	topWl := wlRows
	if len(topWl) > top {
		topWl = topWl[:top]
	}
	for _, a := range topWl {
		id := a.ns + "|" + a.kind + "|" + a.name
		mapNodes = append(mapNodes, pyjson.NewObj().
			Set("id", id).Set("label", a.ns+"/"+a.name).Set("nodeType", "workload").
			Set("workloadType", a.kind).Set("namespace", a.ns).
			Set("boundary", "cluster").Set("ingressBps", a.in).Set("egressBps", a.out))
		mapEdges = append(mapEdges, pyjson.NewObj().
			Set("sourceId", id).Set("targetId", extID).
			Set("egressBps", a.out).Set("ingressBps", a.in))
	}
	if len(mapNodes) > 0 {
		mapNodes = append(mapNodes, pyjson.NewObj().
			Set("id", extID).Set("label", "External traffic").
			Set("nodeType", "external").Set("boundary", "vpc"))
	}
	sumVals := func(o *pyjson.Obj) any {
		if o.Len() == 0 {
			return 0
		}
		total := 0.0
		for _, k := range o.Keys() {
			total += f64d(o.GetD(k, 0.0), 0)
		}
		return total
	}
	return pyjson.NewObj().
		Set("totals", pyjson.NewObj().
			Set("ingressBps", sumVals(ing)).
			Set("egressBps", sumVals(egr)).
			Set("crossAzMonthlyCost", nil).
			Set("topologyAvailable", false)).
		Set("namespaces", nss).
		Set("workloads", wlList).
		Set("window", window).
		Set("map", pyjson.NewObj().Set("nodes", mapNodes).Set("edges", mapEdges)), nil
}

func (e *Engine) ApisData(ctx context.Context, ns, kind, name string) (*pyjson.Obj, error) {
	e.mu.Lock()
	row := e.byKey[wlkey(ns, kind, name)]
	e.mu.Unlock()
	if row == nil {
		return pyjson.NewObj().Set("found", false), nil
	}
	sel := fmt.Sprintf(`namespace="%s",pod=~"%s-.*"`, ns, name)
	v := func(promql string) (float64, bool) {
		r := e.promQuery(ctx, promql)
		if len(r) == 0 {
			return 0, false
		}
		return r[0].Value, true
	}
	rps, okRps := v(fmt.Sprintf(`sum(rate(http_requests_total{%s}[5m]))`, sel))
	if !okRps {
		return pyjson.NewObj().
			Set("found", true).
			Set("available", false).
			Set("routes", []any{}).
			Set("totals", pyjson.NewObj()), nil
	}
	errr, okErr := v(fmt.Sprintf(`sum(rate(http_requests_total{%s,code=~"5.."}[5m]))`, sel))
	if !okErr {
		errr = 0.0
	}
	p99, okP99 := v(fmt.Sprintf(`histogram_quantile(0.99,sum(rate(http_latency_ms_bucket{%s}[5m])) by (le))`, sel))
	if !okP99 {
		p99 = 0.0
	}
	var errRate any = 0.0
	if rps != 0 {
		errRate = pyjson.Round(errr/rps*100, 2)
	}
	return pyjson.NewObj().
		Set("found", true).
		Set("available", true).
		Set("routes", []any{}).
		Set("totals", pyjson.NewObj().
			Set("rps", pyjson.Round(rps, 2)).
			Set("errorRate", errRate).
			Set("p99", pyjson.Round(p99, 1))), nil
}

// zero-value dict on any error.
func (e *Engine) PodResizeStatus(ctx context.Context, ns, pod string) *pyjson.Obj {
	fallback := pyjson.NewObj().Set("resize", "").Set("allocatedResources", pyjson.NewObj())
	p, err := e.Kube.GetJSON(ctx, "/api/v1/namespaces/"+ns+"/pods/"+pod)
	if err != nil {
		return fallback
	}
	st := getObj(p, "status")
	alloc := pyjson.NewObj()
	for _, cv := range getList(st, "containerStatuses") {
		cs := obj(cv)
		nv, ok := cs.Get("name")
		if !ok {
			return fallback
		}
		alloc.Set(str(nv), cs.GetD("allocatedResources", pyjson.NewObj()))
	}
	return pyjson.NewObj().
		Set("resize", st.GetD("resize", "")).
		Set("allocatedResources", alloc)
}

// nil when unreadable — never fabricated.
func (e *Engine) rolloutStrategy(ctx context.Context, ns, kind, name string) *pyjson.Obj {
	api, ok := wlAPI[kind]
	if !ok {
		return nil
	}
	o, err := e.Kube.GetJSON(ctx, fmt.Sprintf(api, ns, name))
	if err != nil {
		return nil
	}
	spec := getObj(o, "spec")
	st := obj(spec.GetD("strategy", nil))
	if st.Len() == 0 {
		st = obj(spec.GetD("updateStrategy", nil))
	}
	ru := obj(st.GetD("rollingUpdate", nil))
	surgeDef, unavailDef := 0, 1
	if kind == "Deployment" {
		surgeDef, unavailDef = 1, 0
	}
	return pyjson.NewObj().
		Set("strategyName", "Strategy").
		Set("strategyType", st.GetD("type", "RollingUpdate")).
		// k8s serializes these as int OR "25%" strings — pass through untouched
		Set("maxSurge", ru.GetD("maxSurge", surgeDef)).
		Set("maxUnavailable", ru.GetD("maxUnavailable", unavailDef))
}

// ConfigParams + RolloutUpdateStrategy. nil = 404.
func (e *Engine) WorkloadDiag(ctx context.Context, ns, kind, name string) *pyjson.Obj {
	e.mu.Lock()
	w := e.byKey[wlkey(ns, kind, name)]
	e.mu.Unlock()
	if w == nil {
		return nil
	}
	wo := w.obj
	sig := obj(wo.GetD("signals", nil))
	caps := []any{}
	for _, cv := range getList(wo, "containers") {
		c := obj(cv)
		cs := obj(c.GetD("capStatuses", nil))
		for _, dim := range []string{"cpu", "memory"} {
			ci := obj(cs.GetD(dim, nil))
			if truthy(ci.GetD("isCapped", nil)) {
				caps = append(caps, pyjson.NewObj().
					Set("container", c.GetD("name", nil)).
					Set("resource", dim).
					Set("cappedType", ci.GetD("cappedType", nil)).
					Set("message", ci.GetD("message", nil)).
					Set("originalValue", ci.GetD("originalCappedValue", nil)))
			}
		}
	}
	under := f64d(wo.GetD("recCpu", 0), 0) > f64d(wo.GetD("reqCpu", 0), 0)*1.03 ||
		f64d(wo.GetD("recMem", 0), 0) > f64d(wo.GetD("reqMem", 0), 0)*1.03
	pname := str(firstTruthy(firstTruthy(wo.GetD("policyName", nil), wo.GetD("policySuggested", nil)), "production"))
	pols := e.loadPolicies(ctx)
	pspec := orSpec(pols[polKey{ns, pname}],
		pols[polKey{e.Cfg.Namespace, pname}],
		pols[polKey{"__default__", "production"}])
	if pspec == nil {
		pspec = pyjson.NewObj()
	}
	kb := e.policyKnobs(pspec)
	policyTuning := pyjson.NewObj().
		Set("policy", pname).
		Set("cpu", pyjson.NewObj().
			Set("percentile", kb.cpuPct).
			Set("headroomPct", pyjson.RoundInt((kb.cpuHead-1)*100)).
			Set("minAllowed", FmtCPU(kb.cpuMin)).
			Set("maxAllowed", FmtCPU(kb.cpuMax)).
			Set("window", kb.window)).
		Set("memory", pyjson.NewObj().
			Set("percentile", kb.memPct).
			Set("headroomPct", pyjson.RoundInt((kb.memHead-1)*100)).
			Set("minAllowed", FmtMem(kb.memMin)).
			Set("maxAllowed", FmtMem(kb.memMax)).
			Set("window", kb.window)).
		// ephemeral-storage dimension (P90/+5%/48h defaults) — same knob source
		Set("ephemeral", pyjson.NewObj().
			Set("percentile", kb.ephPct).
			Set("headroomPct", pyjson.RoundInt((kb.ephHead-1)*100)).
			Set("window", kb.ephWindow))
	cccCpu, cccMem := pyjson.NewObj(), pyjson.NewObj()
	for _, cv := range getList(wo, "containers") {
		c := obj(cv)
		if truthy(c.GetD("excluded", nil)) {
			continue
		}
		cccCpu.Set(getStr(c, "name"), cappingConfig(c, kb, "cpu"))
		cccMem.Set(getStr(c, "name"), cappingConfig(c, kb, "memory"))
	}
	// cappingInfo = the first capped container's config (else the first container's)
	pick := func(m *pyjson.Obj) any {
		for _, k := range m.Keys() {
			v := obj(m.GetD(k, nil))
			if truthy(v.GetD("isCapped", nil)) {
				return v
			}
		}
		if ks := m.Keys(); len(ks) > 0 {
			return m.GetD(ks[0], nil)
		}
		return nil
	}
	var cccCpuOut, cccMemOut any
	if cccCpu.Len() > 0 {
		cccCpuOut = cccCpu
	}
	if cccMem.Len() > 0 {
		cccMemOut = cccMem
	}
	cpuParams := pyjson.NewObj().
		Set("historyWindow", kb.window).
		Set("percentile", kb.cpuPct).
		Set("headroom", pyjson.RoundInt((kb.cpuHead-1)*100)).
		Set("minAllowed", FmtCPU(kb.cpuMin)).
		Set("cappingInfo", pick(cccCpu)).
		Set("ContainerCappingConfig", cccCpuOut).
		Set("isOverridden", false)
	memParams := pyjson.NewObj().
		Set("historyWindow", kb.window).
		Set("percentile", kb.memPct).
		Set("headroom", pyjson.RoundInt((kb.memHead-1)*100)).
		Set("minAllowed", FmtMem(kb.memMin)).
		Set("cappingInfo", pick(cccMem)).
		Set("ContainerCappingConfig", cccMemOut).
		Set("isOverridden", false)
	ephParams := pyjson.NewObj().
		Set("historyWindow", kb.ephWindow).
		Set("percentile", kb.ephPct).
		Set("headroom", pyjson.RoundInt((kb.ephHead-1)*100)).
		Set("ContainerCappingConfig", nil).
		Set("isOverridden", false)
	var rollout any
	if rs := e.rolloutStrategy(ctx, ns, kind, name); rs != nil {
		rollout = rs
	}
	return pyjson.NewObj().
		Set("found", true).
		Set("cpuPolicyTuningParams", cpuParams).
		Set("memoryPolicyTuningParams", memParams).
		Set("ephemeralStoragePolicyTuningParams", ephParams).
		Set("updaterAnnotationEventInfo", pyjson.NewObj().Set("additionalInfo", pyjson.NewObj())).
		Set("RolloutUpdateStrategy", rollout).
		Set("workload", pyjson.NewObj().
			Set("namespace", ns).Set("kind", kind).Set("name", name).
			Set("replicas", wo.GetD("replicas", nil)).
			Set("policyName", firstTruthy(wo.GetD("policyName", nil), wo.GetD("policySuggested", nil))).
			Set("automated", wo.GetD("automated", nil)).
			Set("excluded", wo.GetD("excluded", nil)).
			Set("health", wo.GetD("health", nil)).
			Set("sizable", wo.GetD("sizable", nil))).
		Set("resources", pyjson.NewObj().
			Set("cpu", pyjson.NewObj().
				Set("request", wo.GetD("reqCpu", nil)).
				Set("recommended", wo.GetD("recCpu", nil)).
				Set("usage", wo.GetD("useCpu", nil))).
			Set("memory", pyjson.NewObj().
				Set("request", wo.GetD("reqMem", nil)).
				Set("recommended", wo.GetD("recMem", nil)).
				Set("usage", wo.GetD("useMem", nil)))).
		Set("policyTuning", policyTuning).
		Set("diagnostics", pyjson.NewObj().
			Set("signals", sig).
			Set("health", wo.GetD("health", nil)).
			Set("underProvisioned", under).
			Set("savings", wo.GetD("savings", nil)).
			Set("readyRecommendation", wo.GetD("isReadyRecommendation", nil)).
			Set("capStatuses", caps).
			Set("workloadErrors", wo.GetD("workloadErrors", []any{})).
			Set("unevictableReasons", wo.GetD("unevictableReasons", []any{}))).
		Set("events", wo.GetD("events", []any{})).
		Set("pods", wo.GetD("podInfo", []any{}))
}

func goTs(t int64) string {
	return time.Unix(t, 0).UTC().Format("2006-01-02 15:04:05 +0000 UTC")
}

func (e *Engine) DiagnosticsData(ctx context.Context, ns, kind, name string, frm, to *string) (*pyjson.Obj, error) {
	e.mu.Lock()
	row := e.byKey[wlkey(ns, kind, name)]
	e.mu.Unlock()
	if row == nil {
		return pyjson.NewObj().Set("diagnosticEventsSeries", []any{}), nil
	}
	var end, start int64
	if to != nil && *to != "" {
		v, err := pyInt(*to)
		if err != nil {
			return nil, err
		}
		end = pyFloorDiv(v, 1000)
	} else {
		end = time.Now().Unix()
	}
	if frm != nil && *frm != "" {
		v, err := pyInt(*frm)
		if err != nil {
			return nil, err
		}
		start = pyFloorDiv(v, 1000)
	} else {
		start = end - 86400
	}
	if end <= start {
		return pyjson.NewObj().Set("diagnosticEventsSeries", []any{}), nil
	}
	step := (end - start) / 300
	if step < 60 {
		step = 60
	}
	podRe := name + "-.*" // raw prefix — never re.escape (RE2)
	sel := fmt.Sprintf(`namespace="%s",pod=~"%s",container!="",container!="POD"`, ns, podRe)
	ksm := fmt.Sprintf(`namespace="%s",pod=~"%s"`, ns, podRe)
	oom := e.promSeriesAt(ctx, fmt.Sprintf(`sum(increase(container_oom_events_total{%s}[%ds]))`, sel, step),
		start, end, step)
	thr := e.promSeriesAt(ctx, fmt.Sprintf(
		`sum(rate(container_cpu_cfs_throttled_periods_total{%s}[5m])) / `+
			`sum(rate(container_cpu_cfs_periods_total{%s}[5m]))`, sel, sel), start, end, step)
	cpuUtil := e.promSeriesAt(ctx, fmt.Sprintf(
		`sum(rate(container_cpu_usage_seconds_total{%s}[5m])) / `+
			`sum(kube_pod_container_resource_requests{%s,resource="cpu"})`, sel, ksm),
		start, end, step)
	memUtil := e.promSeriesAt(ctx, fmt.Sprintf(
		`sum(container_memory_working_set_bytes{%s}) / `+
			`sum(kube_pod_container_resource_requests{%s,resource="memory"})`, sel, ksm),
		start, end, step)
	automated := truthy(row.obj.GetD("automated", nil))
	series := []any{}
	for t := start; t <= end; t += step {
		pt := pyjson.NewObj().Set("timestamp", goTs(t))
		if automated {
			pt.Set("auto", 1)
		}
		if oom[t] > 0 {
			pt.Set("oomEvent", 1)
		}
		if thr[t] > 0.25 {
			pt.Set("cpuThrottling", 1)
		}
		if cpuUtil[t] > 0.90 {
			pt.Set("highCpuUtilization", 1)
		}
		if memUtil[t] > 0.90 {
			pt.Set("highMemoryUtilization", 1)
		}
		series = append(series, pt)
	}
	return pyjson.NewObj().Set("diagnosticEventsSeries", series), nil
}

func pyFloorDiv(a, b int64) int64 {
	q := a / b
	if (a%b != 0) && ((a < 0) != (b < 0)) {
		q--
	}
	return q
}

// RecommendationDetail is the composite /api/recommendation/<ns>/<kind>/<name>
// handler: workload detail straight from the Recommendation CR plus the live
// row extras.
func (e *Engine) RecommendationDetail(ctx context.Context, ns, kind, name string) *pyjson.Obj {
	crn := crName(kind, name)
	cr, err := e.getRecommendationCR(ctx, ns, kind, name)
	if err != nil {
		return pyjson.NewObj().Set("found", false).Set("crName", crn)
	}
	key := wlkey(ns, kind, name)
	e.mu.Lock()
	row := e.byKey[key]
	replicasAuto := e.replicasAutomated[key]
	e.mu.Unlock()
	ro := pyjson.NewObj()
	if row != nil {
		ro = row.obj
	}
	pods := getList(ro, "podNames")
	// in-place resize: restart-free kinds with live pods, GA on k8s 1.35.
	inPlaceCapable := len(pods) > 0 &&
		(kind == "Deployment" || kind == "StatefulSet" || kind == "DaemonSet" || kind == "ReplicaSet")
	// Replicas Optimization detail (HPA/KEDA workloads) for the drawer tab.
	var replicasBlock any
	if truthy(ro.GetD("hpaManaged", nil)) && row != nil {
		rpName, rpKnobs := e.replicasPolicyFor(key)
		rmin, rthr, rpred, rtrend := e.replicaRecommendation(row, rpKnobs)
		ominOut := firstTruthy(ro.GetD("hpaMin", nil), 1)
		omin := i64(ominOut)
		reps := row.replicas
		if reps < 1 {
			reps = 1
		}
		perRep := f64d(ro.GetD("monthlyCost", 0), 0) / float64(reps)
		diff := omin - int64(rmin)
		if diff < 0 {
			diff = 0
		}
		rsave := float64(diff) * perRep
		var optCost any = 0
		if v := f64d(ro.GetD("monthlyCost", 0), 0) - rsave; v > 0 {
			optCost = v
		}
		policies := []any{}
		for _, d := range replicasPolicies {
			policies = append(policies, d.name)
		}
		e.mu.Lock()
		var custom []string
		for n := range e.hpaPolicyOverrides {
			if !hpaBuiltinNames[n] {
				custom = append(custom, n)
			}
		}
		e.mu.Unlock()
		sortStrings(custom)
		for _, n := range custom {
			policies = append(policies, n)
		}
		trigger := "HPA"
		if truthy(ro.GetD("kedaName", nil)) {
			trigger = "KEDA"
		}
		replicasBlock = pyjson.NewObj().
			Set("origMin", ominOut).
			Set("recMin", rmin).
			Set("curThreshold", ro.GetD("cpuTarget", nil)).
			Set("recThreshold", rthr).
			Set("predictable", rpred).
			Set("policyName", rpName).
			Set("savings", rsave).
			Set("monthlyCost", ro.GetD("monthlyCost", 0)).
			Set("optimizedCost", optCost).
			Set("policies", policies).
			Set("automated", replicasAuto).
			Set("maxReplicas", ro.GetD("hpaMax", nil)).
			Set("trend", rtrend).
			Set("triggerType", trigger)
	}
	var javaJvm any
	if truthy(ro.GetD("java", nil)) {
		if jd, jerr := e.JavaData(ctx); jerr == nil {
			for _, wv := range getList(jd, "workloads") {
				jr := obj(wv)
				if getStr(jr, "namespace") == ns && getStr(jr, "kind") == kind && getStr(jr, "name") == name {
					javaJvm = jr
					break
				}
			}
		}
	}
	inPlaceStatus := pyjson.NewObj()
	if len(pods) > 0 {
		inPlaceStatus = e.PodResizeStatus(ctx, ns, str(pods[0]))
	}
	return pyjson.NewObj().
		Set("found", true).
		Set("crName", crn).
		Set("namespace", ns).
		Set("apiVersion", crdGroup+"/"+crdVer).
		Set("kind", "Recommendation").
		Set("spec", cr.GetD("spec", pyjson.NewObj())).
		Set("status", cr.GetD("status", pyjson.NewObj())).
		Set("replicasOpt", replicasBlock).
		Set("schedulingOpt", e.schedulingDrawerBlock(ctx, ns, kind, name)).
		Set("javaJvm", javaJvm).
		// live extras the CR doesn't carry, for the drawer header + tabs:
		Set("replicas", ro.GetD("replicas", nil)).
		Set("monthlyCost", ro.GetD("monthlyCost", nil)).
		Set("savings", ro.GetD("savings", nil)).
		Set("sizable", ro.GetD("sizable", nil)).
		Set("automated", ro.GetD("automated", nil)).
		Set("excluded", ro.GetD("excluded", nil)).
		Set("automationSource", ro.GetD("automationSource", nil)).
		Set("policyName", ro.GetD("policyName", nil)).
		Set("policySuggested", ro.GetD("policySuggested", nil)).
		Set("policyActive", ro.GetD("policyActive", nil)).
		Set("detectedTag", ro.GetD("detectedTag", nil)).
		Set("smartPolicyWorkloadType", ro.GetD("smartPolicyWorkloadType", nil)).
		Set("language", func() string {
			var imgs []string
			for _, iv := range getList(ro, "images") {
				imgs = append(imgs, str(iv))
			}
			return detectLanguage(truthy(ro.GetD("java", nil)), imgs)
		}()).
		Set("origCpu", ro.GetD("origCpu", nil)).
		Set("origMem", ro.GetD("origMem", nil)).
		Set("activeSavings", ro.GetD("activeSavings", nil)).
		Set("labels", ro.GetD("labels", pyjson.NewObj())).
		Set("annotations", ro.GetD("annotations", pyjson.NewObj())).
		Set("java", ro.GetD("java", nil)).
		Set("gpuReq", ro.GetD("gpuReq", 0)).
		Set("spotEligible", ro.GetD("spotEligible", nil)).
		Set("reqEph", ro.GetD("reqEph", 0)).
		Set("useEph", ro.GetD("useEph", 0)).
		Set("recEph", ro.GetD("recEph", 0)).
		Set("hpaManaged", ro.GetD("hpaManaged", nil)).
		Set("hpaMetrics", ro.GetD("hpaMetrics", []any{})).
		Set("hpaName", ro.GetD("hpaName", nil)).
		Set("kedaName", ro.GetD("kedaName", nil)).
		Set("hpaConversions", ro.GetD("hpaConversions", []any{})).
		Set("health", ro.GetD("health", nil)).
		Set("signals", ro.GetD("signals", pyjson.NewObj())).
		Set("events", ro.GetD("events", []any{})).
		Set("initOptimization", ro.GetD("initOptimization", []any{})).
		Set("initSavings", ro.GetD("initSavings", 0)).
		Set("bootCpu", ro.GetD("bootCpu", 0)).
		Set("containersLive", ro.GetD("containers", []any{})).
		Set("podInfo", ro.GetD("podInfo", []any{})).
		Set("nodeSizes", ro.GetD("nodeSizes", []any{})).
		Set("inPlace", pyjson.NewObj().
			Set("capable", inPlaceCapable).
			Set("pods", pods).
			Set("status", inPlaceStatus)).
		Set("readOnly", e.Cfg.ReadOnly)
}

// RecommendFor is the /api/recommend/<ns>/<kind>/<name> handler body on top
// of resolve_workload. nil = {"found": false}.
func (e *Engine) RecommendFor(ctx context.Context, ns, kind, name string) *pyjson.Obj {
	row := e.resolveWorkload(ctx, ns, kind, name)
	if row == nil {
		return nil
	}
	conts := getList(row.obj, "containers")
	if conts == nil {
		conts = []any{}
	}
	// optimized -Xmx per Java container (bytes) for the webhook
	javaXmx := pyjson.NewObj()
	for _, cv := range conts {
		c := obj(cv)
		javaXmx.Set(getStr(c, "name"), c.GetD("javaXmx", 0))
	}
	var ann *pyjson.Obj
	if a, ok := row.obj.GetD("annotations", nil).(*pyjson.Obj); ok {
		ann = a
	}
	return pyjson.NewObj().
		Set("found", true).
		Set("containers", conts).
		Set("sizable", row.obj.GetD("sizable", nil)).
		Set("automated", row.obj.GetD("automated", nil)).
		Set("hpaManaged", row.obj.GetD("hpaManaged", nil)).
		Set("java", row.obj.GetD("java", false)).
		Set("javaXmx", javaXmx).
		// Java automation scope (workload/namespace/cluster) for the webhook
		Set("javaAuto", e.javaAutoFor(ctx, ns, kind, name, ann, nil))
}
