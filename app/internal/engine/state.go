package engine

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"sort"
	"strconv"
	"time"

	"coolscaler.sh/coolscaler/internal/pyjson"
)

// durable ConfigMap state layer

const (
	auditCMName    = "coolscaler-audit-events"
	overviewCMName = "coolscaler-overview-metrics"
	aggrCMName     = "coolscaler-resources-over-time-aggr"

	analyticsCMPrefix = "analytics-metrics-"
	analyticsCMLabel  = "coolscaler.sh/analytics-metric"

	cmPayloadBudget = 900 * 1024 // bytes of encoded payload per CM

	auditPersistMinGap  = 60 * time.Second   // write-behind, rate-limited
	analyticsPersistGap = 900 * time.Second
	overviewPersistGap  = 300 * time.Second
	aggrPersistGap      = 3600 * time.Second
	notEvictPersistGap  = 300 * time.Second
	costCachePersistGap = 3600 * time.Second
	aggrWindowHours     = 720
)

var analyticsCMKeys = [][2]string{
	{"cost-over-time", "totalWorkloadCostMonthly"},
	{"available-savings-over-time", "availableSavings"},
	{"active-savings-over-time-with-replicas", "activeSavings"},
	{"automated-workloads", "rightsizingAutomated"},
	{"total-automated-workloads", "rightsizingAutomated"},
	{"cpu-usage", "cpuUsageTotal"},
	{"memory-usage", "memoryUsageTotal"},
	{"cpu-requests", "cpuRequests"},
	{"memory-requests", "memoryRequests"},
	{"cpu-requests-origin", "cpuRequestsOrigin"},
	{"memory-requests-origin", "memoryRequestsOrigin"},
	{"cpu-recommendation", "cpuRecommendation"},
	{"memory-recommendation", "memoryRecommendation"},
	{"cpu-allocatable", "cpuAllocatable"},
	{"memory-allocatable", "memoryAllocatable"},
	{"cpu-allocatable-on-demand", "cpuAllocatableOnDemand"},
	{"memory-allocatable-on-demand", "memoryAllocatableOnDemand"},
	{"blocked-nodes-over-time", "blockedNodes"},
	{"total-number-of-workloads", "totalNumberOfWorkloads"},
	{"total-number-of-pods", "totalNumberOfPods"},
	{"number-of-automated-pods", "numberOfAutomatedPods"},
	{"number-of-nodes", "nodes"},
	{"performance-optimized-workloads", "performanceOptimizedWorkloads"},
	{"total-cpu-requests-origin", "totalCpuRequestsOrigin"},
	{"total-memory-requests-origin", "totalMemoryRequestsOrigin"},
	{"total-number-of-unevictable-pods", "numberOfUnevictablePods"},
	{"total-hpa-cpu-requests", "totalHpaRequests"},
}

// gunzipB64 reverses gzb64: base64 -> gzip -> raw bytes.
func gunzipB64(s string) ([]byte, error) {
	raw, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		return nil, err
	}
	zr, err := gzip.NewReader(bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	defer zr.Close()
	return io.ReadAll(io.LimitReader(zr, 64<<20))
}

func b64(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }

// upsertCM merge-patches a ConfigMap, creating it when the patch fails.
func (e *Engine) upsertCM(ctx context.Context, name string, meta, data, binaryData *pyjson.Obj) {
	nsPath := "/api/v1/namespaces/" + e.Cfg.Namespace + "/configmaps"
	body := pyjson.NewObj()
	if meta != nil && meta.Len() > 0 {
		body.Set("metadata", meta)
	}
	if data != nil {
		body.Set("data", data)
	}
	if binaryData != nil {
		body.Set("binaryData", binaryData)
	}
	if _, err := e.k8sPatch(ctx, nsPath+"/"+name, body); err != nil {
		if _, ok := isHTTPError(err); !ok {
			return
		}
		md := pyjson.NewObj().Set("name", name).Set("namespace", e.Cfg.Namespace)
		if meta != nil {
			md.Update(meta)
		}
		cm := pyjson.NewObj().
			Set("apiVersion", "v1").
			Set("kind", "ConfigMap").
			Set("metadata", md)
		if data != nil {
			cm.Set("data", data)
		}
		if binaryData != nil {
			cm.Set("binaryData", binaryData)
		}
		if _, perr := e.k8sReq(ctx, "POST", nsPath, cm, "application/json"); perr != nil {
			e.Log.Info("state CM create failed", "name", name, "err", perr)
		}
	}
}

// getCM fetches a ConfigMap in the component namespace (nil when absent).
func (e *Engine) getCM(ctx context.Context, name string) *pyjson.Obj {
	cm, err := e.Kube.GetJSON(ctx, "/api/v1/namespaces/"+e.Cfg.Namespace+"/configmaps/"+name)
	if err != nil {
		return nil
	}
	return cm
}

// ---------------------------------------------------------------------------
// Startup loads.
// ---------------------------------------------------------------------------

// loadStateCMs restores the durable state written by persistStateCMs. Runs
// after loadAnalytics (the legacy ANALYTICS_FILE path) so CM-backed points
// only fill timestamps the file did not cover.
func (e *Engine) loadStateCMs(ctx context.Context) {
	e.loadAuditCM(ctx)
	e.loadAnalyticsCMs(ctx)
	e.loadOverviewCM(ctx)
	e.loadAggrCM(ctx)
}

// loadAuditCM restores the audit deque from coolscaler-audit-events.
func (e *Engine) loadAuditCM(ctx context.Context) {
	cm := e.getCM(ctx, auditCMName)
	if cm == nil {
		return
	}
	raw, err := gunzipB64(getStr(getObj(cm, "binaryData"), "auditByTimestamp"))
	if err != nil {
		e.Log.Info("audit CM decode failed", "err", err)
		return
	}
	v, err := pyjson.Decode(raw)
	if err != nil {
		return
	}
	m, ok := v.(*pyjson.Obj)
	if !ok {
		return
	}
	type entT struct {
		id  int64
		rec *pyjson.Obj
	}
	var ents []entT
	for _, k := range m.Keys() {
		en := obj(m.GetD(k, nil))
		if en.Len() == 0 {
			continue
		}
		// Native fields round-trip losslessly
		ts := str(en.GetD("timestamp", nil))
		if ts == "" {
			ts = str(en.GetD("startTimestamp", k))
		}
		at := str(en.GetD("actionType", nil))
		if at == "" {
			at = str(en.GetD("operation", ""))
		}
		tgt := str(en.GetD("target", nil))
		if tgt == "" {
			tgt = str(en.GetD("message", ""))
		}
		rec := pyjson.NewObj().
			Set("timestamp", ts).
			Set("actionType", at).
			Set("target", tgt).
			Set("oldValue", en.GetD("oldValue", "")).
			Set("newValue", en.GetD("newValue", "")).
			Set("user", en.GetD("user", ""))
		if k := str(en.GetD("kind", "")); k != "" {
			rec.Set("kind", k).
				Set("operation", en.GetD("operation", "")).
				Set("message", en.GetD("message", "")).
				Set("namespace", en.GetD("namespace", "")).
				Set("workloadType", en.GetD("workloadType", "")).
				Set("workloadName", en.GetD("workloadName", ""))
		}
		ents = append(ents, entT{i64(en.GetD("id", int64(0))), rec})
	}
	sort.SliceStable(ents, func(i, j int) bool { return ents[i].id < ents[j].id })
	e.mu.Lock()
	if len(e.auditLog) == 0 { // startup only — never clobber live entries
		for _, en := range ents { // ascending ids -> prepend => newest first
			e.auditLog = append([]*pyjson.Obj{en.rec}, e.auditLog...)
		}
		if len(e.auditLog) > 1000 {
			e.auditLog = e.auditLog[:1000]
		}
	}
	n := len(e.auditLog)
	e.mu.Unlock()
	e.Log.Info("restored audit events from ConfigMap", "entries", n)
}

// loadAnalyticsCMs merges persisted analytics-metrics-<key> series back into
// the in-memory ANALYTICS ring (only timestamps not already present).
func (e *Engine) loadAnalyticsCMs(ctx context.Context) {
	merged := map[int64]*pyjson.Obj{}
	for _, kv := range analyticsCMKeys {
		key, field := kv[0], kv[1]
		cm := e.getCM(ctx, analyticsCMPrefix+key)
		if cm == nil {
			continue
		}
		raw, err := gunzipB64(getStr(getObj(cm, "data"), "zip64"))
		if err != nil {
			continue
		}
		v, err := pyjson.Decode(raw)
		if err != nil {
			continue
		}
		pts, _ := v.([]any)
		for _, pv := range pts {
			p := obj(pv)
			ts := i64(p.GetD("Timestamp", int64(0)))
			if ts == 0 {
				continue
			}
			m, okM := merged[ts]
			if !okM {
				m = pyjson.NewObj().Set("t", ts)
				merged[ts] = m
			}
			m.Set(field, f64d(p.GetD("Value", 0.0), 0))
		}
	}
	if len(merged) == 0 {
		return
	}
	cutoff := time.Now().Unix() - rangeSeconds["30d"]
	e.mu.Lock()
	have := map[int64]bool{}
	for _, s := range e.analytics {
		have[i64(s.GetD("t", int64(0)))] = true
	}
	added := 0
	var extra []*pyjson.Obj
	for ts, s := range merged {
		if ts < cutoff || have[ts] {
			continue
		}
		extra = append(extra, s)
		added++
	}
	if added > 0 {
		e.analytics = append(e.analytics, extra...)
		sort.SliceStable(e.analytics, func(i, j int) bool {
			return i64(e.analytics[i].GetD("t", int64(0))) < i64(e.analytics[j].GetD("t", int64(0)))
		})
		if max := e.Cfg.AnalyticsPoints; max > 0 && len(e.analytics) > max {
			e.analytics = e.analytics[len(e.analytics)-max:]
		}
	}
	e.mu.Unlock()
	if added > 0 {
		e.Log.Info("restored analytics points from ConfigMaps", "points", added)
	}
}

// loadOverviewCM restores the 5-min overview rollup ring.
func (e *Engine) loadOverviewCM(ctx context.Context) {
	cm := e.getCM(ctx, overviewCMName)
	if cm == nil {
		return
	}
	bd := getObj(cm, "binaryData")
	if raw, err := gunzipB64(getStr(bd, "metrics")); err == nil {
		if v, derr := pyjson.Decode(raw); derr == nil {
			if l, okL := v.([]any); okL {
				e.mu.Lock()
				e.overviewMetrics = l
				e.mu.Unlock()
				e.Log.Info("restored overview-metrics from ConfigMap", "entries", len(l))
			}
		}
	}
	if raw, err := gunzipB64(getStr(bd, "createdAt")); err == nil {
		var s string
		if v, derr := pyjson.Decode(raw); derr == nil {
			s = str(v)
		}
		if s != "" {
			e.mu.Lock()
			e.overviewCreatedAt = s
			e.mu.Unlock()
		}
	}
}

// loadAggrCM restores the hourly resources-over-time rollup.
func (e *Engine) loadAggrCM(ctx context.Context) {
	cm := e.getCM(ctx, aggrCMName)
	if cm == nil {
		return
	}
	raw, err := gunzipB64(getStr(getObj(cm, "binaryData"), "details"))
	if err != nil {
		return
	}
	v, err := pyjson.Decode(raw)
	if err != nil {
		return
	}
	d := obj(v)
	byTs := getObj(d, "namespaceDetailsByTimestamp")
	if byTs.Len() == 0 {
		return
	}
	e.mu.Lock()
	e.aggrDetails = byTs
	e.mu.Unlock()
	e.Log.Info("restored resources-over-time-aggr from ConfigMap", "hours", byTs.Len())
}

// ---------------------------------------------------------------------------
// Persistence (called from the sampler loop after each successful refresh).
// ---------------------------------------------------------------------------

// persistStateCMs runs the cadence-gated write-behind of all durable CMs.
func (e *Engine) persistStateCMs(ctx context.Context) {
	now := time.Now()
	e.mu.Lock()
	doAudit := e.auditDirty && now.Sub(e.lastAuditPersist) >= auditPersistMinGap
	doAnalytics := now.Sub(e.lastAnalyticsPersist) >= analyticsPersistGap
	doOverview := now.Sub(e.lastOverviewPersist) >= overviewPersistGap
	doAggr := now.Sub(e.lastAggrPersist) >= aggrPersistGap
	doNotEvict := now.Sub(e.lastNotEvictPersist) >= notEvictPersistGap
	doCostCache := now.Sub(e.lastCostCachePersist) >= costCachePersistGap
	if doAudit {
		e.auditDirty = false
		e.lastAuditPersist = now
	}
	if doAnalytics {
		e.lastAnalyticsPersist = now
	}
	if doOverview {
		e.lastOverviewPersist = now
	}
	if doAggr {
		e.lastAggrPersist = now
	}
	if doNotEvict {
		e.lastNotEvictPersist = now
	}
	if doCostCache {
		e.lastCostCachePersist = now
	}
	e.mu.Unlock()
	if doAudit {
		e.persistAuditCM(ctx)
	}
	if doAnalytics {
		e.persistAnalyticsCMs(ctx)
	}
	if doOverview {
		e.persistOverviewCM(ctx)
	}
	if doAggr {
		e.persistAggrCM(ctx)
	}
	if doNotEvict {
		e.persistNodeStateCMs(ctx)
	}
	if doCostCache {
		e.persistCostCacheCMs(ctx)
	}
}

// binaryData, plain-base64 of JSON. Restart-survival + instant cost-report
// page loads.
func (e *Engine) persistCostCacheCMs(ctx context.Context) {
	if !e.Cfg.WriteRecommendationCRs {
		return
	}
	nowMs := time.Now().UnixMilli()
	stamp := time.Now().UTC().Format("2006-01-02T15:04:05Z")
	for _, days := range []int{3, 7, 14, 30} {
		frm := strconv.FormatInt(nowMs-int64(days)*86400000, 10)
		to := strconv.FormatInt(nowMs, 10)
		cr, err := e.CostReportData(ctx, &frm, &to)
		if err != nil {
			continue
		}
		w := strconv.Itoa(days) + "d"
		// aggregation: per-workload cost rows.
		agg := pyjson.NewObj().
			Set("aggregatedWorkloads", cr.GetD("workloads", []any{}))
		e.upsertCM(ctx, "coolscaler-aggregation-"+w, nil, nil, pyjson.NewObj().
			Set("aggregatedWorkloadCostReport", b64(string(pyjson.Marshal(agg)))).
			Set("lastUpdateTime", b64(strconv.Quote(stamp))))
		series := []any{}
		for _, sv := range getList(cr, "costOverTime") {
			s := obj(sv)
			inner := []any{}
			for _, cv := range getList(s, "costs") {
				c := obj(cv)
				inner = append(inner, pyjson.NewObj().
					Set("id", c.GetD("id", "")).
					Set("value", c.GetD("value", 0)).
					Set("isGpuEnabledWorkload", false))
			}
			series = append(series, pyjson.NewObj().
				Set("timestamp", s.GetD("timestamp", "")).
				Set("costs", inner))
		}
		brk := pyjson.NewObj().Set("costs", series)
		e.upsertCM(ctx, "coolscaler-breakdown-"+w, nil, nil, pyjson.NewObj().
			Set("costBreakdownResponse", b64(string(pyjson.Marshal(brk)))).
			Set("lastUpdateTime", b64(strconv.Quote(stamp))))
	}
}

// WRITE-gated. Plain-JSON-per-key.
func (e *Engine) persistNodeStateCMs(ctx context.Context) {
	if !e.Cfg.WriteRecommendationCRs {
		return
	}
	pd, err := e.placementData(ctx)
	if err != nil {
		return
	}
	t := getObj(pd, "totals")
	br := getObj(t, "blockedByReason")
	unevict := i64(t.GetD("unevictablePods", int64(0)))
	kubeSys := i64(br.GetD("kube-system", int64(0)))
	localSt := i64(br.GetD("localstorage", int64(0)))
	unready := i64(br.GetD("unready", int64(0)))
	nodeBlocked := i64(t.GetD("blockedNodes", int64(0)))
	saving := f64d(t.GetD("savings", 0), 0)
	monthly := f64d(t.GetD("monthlyCost", 0), 0)
	ratio := 0.0
	if monthly > 0 {
		ratio = saving / monthly
	}
	// {"total","optimized","unoptimized"} triples — nothing is bin-packed away
	// yet, so optimized=0 / unoptimized=total.
	triple := func(n int64) string {
		return string(pyjson.Marshal(pyjson.NewObj().
			Set("total", n).Set("optimized", int64(0)).Set("unoptimized", n)))
	}
	jstr := func(v any) string { return string(pyjson.Marshal(v)) }
	data := pyjson.NewObj().
		Set("activeSavings", jstr(pyjson.NewObj().Set("byMaxRatio", ratio).Set("bySumRatio", ratio))).
		Set("kubeSystemPods", triple(kubeSys)).
		Set("lastRunTime", jstr(isoNow())).
		Set("localStoragePods", triple(localSt)).
		Set("nodeBlocked", jstr(nodeBlocked)).
		Set("notEvictableNotAutomatedAvailableSavings", "[]").
		Set("notEvictablesRunningOnNodes", jstr(pyjson.NewObj().Set("nodesData", pyjson.NewObj()))).
		Set("notSupportingBinPackingPolicies", "[]").
		Set("optimizedNodeBlocked", jstr(int64(0))).
		Set("ratio", jstr(ratio)).
		Set("savingAvailable", jstr(saving)).
		Set("unevictableNotHealthyWorkloadsCount", jstr(unready)).
		Set("unevictablePods", triple(unevict)).
		Set("unhealthyPods", triple(unready))
	e.upsertCM(ctx, "coolscaler-not-evictable", nil, data, nil)

	// coolscaler-node-details --- blockingPodsByNode is gzb64, the rest are plain
	// base64. Feeds the node drawer + blocked-node dropdowns.
	blockedRows := getList(pd, "blockedNodes")
	blockingPodsByNode := pyjson.NewObj()
	nodeDetailsByNode := pyjson.NewObj()
	for _, rv := range blockedRows {
		r := obj(rv)
		node := getStr(r, "node")
		if node == "" {
			continue
		}
		blockingPodsByNode.Set(node, r.GetD("pods", int64(0)))
		nodeDetailsByNode.Set(node, pyjson.NewObj().
			Set("pods", r.GetD("pods", int64(0))).
			Set("savings", r.GetD("savings", 0)))
	}
	nowStamp := time.Now().UTC().Format("02 Jan 06 15:04 MST")
	nd := pyjson.NewObj().
		Set("blockingPodsByNode", gzb64(blockingPodsByNode)).
		Set("nodeDetailsByNode", b64(string(pyjson.Marshal(nodeDetailsByNode)))).
		Set("nodePoolByNode", b64("{}")).
		Set("provisionerByNode", b64("{}")).
		Set("skarpenterAutomation", "").
		Set("totalBlockedNodes", b64(strconv.Itoa(len(blockedRows)))).
		Set("lastUpdateTime", b64(nowStamp))
	e.upsertCM(ctx, "coolscaler-node-details", nil, nil, nd)

	optSpec := jstr(pyjson.NewObj().Set("maxInProgress", "10%").Set("gracePeriod", int64(1800)))
	optStatus := jstr(pyjson.NewObj().Set("lastUpdateTime", isoNow()))
	e.upsertCM(ctx, "coolscaler-node-optimization", nil, pyjson.NewObj().
		Set("spec", optSpec).
		Set("status", optStatus).
		Set("schedule", "{}").
		Set("allCompletedNodes", "{}").
		Set("lastScheduleRun", "null").
		Set("regenerateDisqualifiedNodes", "[]"), nil)
	e.upsertCM(ctx, "coolscaler-node-optimization-status", nil, pyjson.NewObj().
		Set("karpenter", jstr(pyjson.NewObj().Set("podsCount", int64(0)).Set("podsExist", false).Set("version", ""))).
		Set("preferencePolicyFeatureHealth", jstr(pyjson.NewObj().Set("healthy", true))), nil)
}

func (e *Engine) persistAuditCM(ctx context.Context) {
	e.mu.Lock()
	entries := append([]*pyjson.Obj(nil), e.auditLog...) // newest first
	e.mu.Unlock()
	build := func(ents []*pyjson.Obj) *pyjson.Obj {
		m := pyjson.NewObj()
		id := 0
		for i := len(ents) - 1; i >= 0; i-- { // oldest first
			r := ents[i]
			id++
			ts := str(r.GetD("timestamp", ""))
			key := auditKeyFromISO(ts, id)
			msg := str(r.GetD("target", ""))
			if nv := str(r.GetD("newValue", "")); nv != "" {
				msg += " -> " + nv
			}
			if m2 := str(r.GetD("message", "")); m2 != "" {
				msg = m2
			}
			op := r.GetD("actionType", "")
			if o := str(r.GetD("operation", "")); o != "" {
				op = r.GetD("operation", "")
			}
			m.Set(key, pyjson.NewObj().
				Set("startTimestamp", key).
				Set("endTimestamp", key).
				Set("operation", op).
				Set("message", msg).
				Set("status", "Success").
				Set("user", r.GetD("user", "")).
				Set("id", id).
				// native fields for lossless restore
				Set("timestamp", ts).
				Set("actionType", r.GetD("actionType", "")).
				Set("target", r.GetD("target", "")).
				Set("oldValue", r.GetD("oldValue", "")).
				Set("newValue", r.GetD("newValue", "")).
				Set("kind", r.GetD("kind", "")).
				Set("namespace", r.GetD("namespace", "")).
				Set("workloadType", r.GetD("workloadType", "")).
				Set("workloadName", r.GetD("workloadName", "")))
		}
		return m
	}
	payload := gzb64(build(entries))
	for len(payload) > cmPayloadBudget && len(entries) > 8 {
		entries = entries[:len(entries)/2] // keep the newest half
		payload = gzb64(build(entries))
	}
	e.upsertCM(ctx, auditCMName, nil, nil, pyjson.NewObj().
		Set("auditByTimestamp", payload).
		Set("retentionInDays", b64("30")))
}

// the fractional part disambiguates same-second entries.
func auditKeyFromISO(iso string, id int) string {
	t, err := time.Parse("2006-01-02T15:04:05Z", iso)
	if err != nil {
		return fmt.Sprintf("%s.%09d", iso, id)
	}
	return fmt.Sprintf("%s.%09d", t.UTC().Format("01-02-2006 15:04:05"), id)
}

func (e *Engine) persistAnalyticsCMs(ctx context.Context) {
	e.mu.Lock()
	snaps := append([]*pyjson.Obj(nil), e.analytics...)
	e.mu.Unlock()
	if len(snaps) == 0 {
		return
	}
	for _, kv := range analyticsCMKeys {
		key, field := kv[0], kv[1]
		bucketVals := map[int64]float64{}
		var order []int64
		for _, s := range snaps {
			v, okV := f64(s.GetD(field, nil))
			if !okV {
				continue
			}
			b := i64(s.GetD("t", int64(0))) / 900 * 900
			if b == 0 {
				continue
			}
			if _, seen := bucketVals[b]; !seen {
				order = append(order, b)
			}
			bucketVals[b] = v // last sample in the bucket wins
		}
		if len(order) == 0 {
			continue
		}
		sort.Slice(order, func(i, j int) bool { return order[i] < order[j] })
		build := func(buckets []int64) string {
			pts := make([]any, 0, len(buckets))
			for _, b := range buckets {
				pts = append(pts, pyjson.NewObj().
					Set("Value", bucketVals[b]).
					Set("Timestamp", b))
			}
			return gzb64(pts)
		}
		payload := build(order)
		for len(payload) > cmPayloadBudget && len(order) > 8 {
			order = order[len(order)/2:] // rotate oldest out
			payload = build(order)
		}
		rfc := func(ts int64) string { return time.Unix(ts, 0).UTC().Format("2006-01-02T15:04:05Z") }
		e.upsertCM(ctx, analyticsCMPrefix+key,
			pyjson.NewObj().Set("labels", pyjson.NewObj().Set(analyticsCMLabel, key)),
			pyjson.NewObj().
				Set("end", rfc(order[len(order)-1])).
				Set("start", rfc(order[0])).
				Set("zip64", payload),
			nil)
	}
}

// persistOverviewCM appends the current 5-min rollup entry and writes the
// coolscaler-overview-metrics CM.
func (e *Engine) persistOverviewCM(ctx context.Context) {
	e.mu.Lock()
	if len(e.analytics) == 0 {
		e.mu.Unlock()
		return
	}
	snap := e.analytics[len(e.analytics)-1]
	nodeCost := f64d(snap.GetD("nodeCost", 0.0), 0)
	currentCost := f64d(snap.GetD("totalWorkloadCostMonthly", 0.0), 0)
	unalloc := nodeCost - currentCost
	if unalloc < 0 {
		unalloc = 0
	}
	entry := pyjson.NewObj().
		Set("timestamp", i64(snap.GetD("t", int64(0)))).
		Set("potentialCost", pyjson.Round(f64d(snap.GetD("recommendedCostMonthly", 0.0), 0), 2)).
		Set("currentCost", pyjson.Round(currentCost, 2)).
		Set("savingsAvailable", pyjson.Round(f64d(snap.GetD("availableSavings", 0.0), 0), 2)).
		Set("savingsAvailableWithReplicas", pyjson.Round(f64d(snap.GetD("availableSavings", 0.0), 0), 2)).
		Set("unAllocatedCost", pyjson.Round(unalloc, 2)).
		Set("hasResourceRequests", true).
		Set("originalCpuRequestMilli", int(f64d(snap.GetD("cpuRequestsOrigin", 0.0), 0)*1000)).
		Set("currentCpuRequestMilli", int(f64d(snap.GetD("cpuRequests", 0.0), 0)*1000)).
		Set("originalMemoryRequestBytes", int64(f64d(snap.GetD("memoryRequestsOrigin", 0.0), 0))).
		Set("currentMemoryRequestBytes", int64(f64d(snap.GetD("memoryRequests", 0.0), 0)))
	e.overviewMetrics = append(e.overviewMetrics, entry)
	if len(e.overviewMetrics) > 8640 { // 30d at 5-min cadence
		e.overviewMetrics = e.overviewMetrics[len(e.overviewMetrics)-8640:]
	}
	if e.overviewCreatedAt == "" {
		e.overviewCreatedAt = isoNow()
	}
	metrics := append([]any(nil), e.overviewMetrics...)
	createdAt := e.overviewCreatedAt
	curCpuMilli := int(f64d(snap.GetD("cpuRequests", 0.0), 0) * 1000)
	curMemBytes := int64(f64d(snap.GetD("memoryRequests", 0.0), 0))
	e.mu.Unlock()

	payload := gzb64(metrics)
	for len(payload) > cmPayloadBudget && len(metrics) > 8 {
		metrics = metrics[len(metrics)/2:]
		payload = gzb64(metrics)
	}
	e.upsertCM(ctx, overviewCMName, nil, nil, pyjson.NewObj().
		Set("createdAt", gzb64(createdAt)).
		Set("lastUpdated", gzb64(time.Now().UTC().Format(time.RFC3339Nano))).
		Set("metrics", payload).
		Set("onDemandCpuRequestMilli", gzb64(curCpuMilli)).
		Set("onDemandMemoryRequestBytes", gzb64(curMemBytes)))
}

// persistAggrCM upserts this hour's "summarized" row into the hourly
// resources-over-time rollup and writes coolscaler-resources-over-time-aggr.
func (e *Engine) persistAggrCM(ctx context.Context) {
	e.mu.Lock()
	if len(e.analytics) == 0 {
		e.mu.Unlock()
		return
	}
	snap := e.analytics[len(e.analytics)-1]
	milli := func(field string) string {
		return strconv.Itoa(int(f64d(snap.GetD(field, 0.0), 0)*1000)) + "m"
	}
	bytesStr := func(field string) string {
		return strconv.FormatInt(int64(f64d(snap.GetD(field, 0.0), 0)), 10)
	}
	row := pyjson.NewObj().
		Set("name", "summarized").
		Set("requests", pyjson.NewObj().
			Set("cpu", milli("cpuRequests")).
			Set("memory", bytesStr("memoryRequests"))).
		Set("usages", pyjson.NewObj().
			Set("cpu", milli("cpuUsageTotal")).
			Set("memory", bytesStr("memoryUsageTotal"))).
		Set("recommendation", pyjson.NewObj().
			Set("cpu", milli("cpuRecommendation")).
			Set("memory", bytesStr("memoryRecommendation"))).
		Set("nodeAllocatable", pyjson.NewObj().
			Set("cpu", milli("cpuAllocatable")).
			Set("memory", bytesStr("memoryAllocatable"))).
		Set("originalRequests", pyjson.NewObj().
			Set("cpu", milli("cpuRequestsOrigin")).
			Set("memory", bytesStr("memoryRequestsOrigin")))
	hour := time.Unix(i64(snap.GetD("t", int64(0))), 0).UTC().Truncate(time.Hour)
	tsKey := hour.Format("2006-01-02 15:04:05 +0000 UTC")
	if e.aggrDetails == nil {
		e.aggrDetails = pyjson.NewObj()
	}
	e.aggrDetails.Set(tsKey, []any{row})
	// prune beyond the 720h window
	cutoff := hour.Add(-aggrWindowHours * time.Hour)
	for _, k := range e.aggrDetails.Keys() {
		if kt, err := time.Parse("2006-01-02 15:04:05 +0000 UTC", k); err == nil && kt.Before(cutoff) {
			e.aggrDetails.Del(k)
		}
	}
	details := e.aggrDetails.Clone()
	e.mu.Unlock()

	payload := gzb64(pyjson.NewObj().Set("namespaceDetailsByTimestamp", details))
	for len(payload) > cmPayloadBudget && details.Len() > 8 {
		keys := details.Keys()
		sort.Strings(keys)
		for _, k := range keys[:details.Len()/2] {
			details.Del(k)
		}
		payload = gzb64(pyjson.NewObj().Set("namespaceDetailsByTimestamp", details))
	}
	e.upsertCM(ctx, aggrCMName, nil, nil, pyjson.NewObj().
		Set("aggregation", b64("1h")).
		Set("details", payload).
		Set("ignoredNodes", b64("{}")).
		Set("lastUpdateTime", b64(time.Now().UTC().Format("02 Jan 06 15:04 MST"))).
		Set("window", b64(fmt.Sprintf("%dh", aggrWindowHours))))
}
