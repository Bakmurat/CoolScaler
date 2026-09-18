package engine

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	"coolscaler.sh/coolscaler/internal/pyjson"
)

// Recommendation / AutoHealing CR writers.

// wlAPIVersions is the writer's kind -> apiVersion map.
var wlAPIVersions = map[string]string{
	"Deployment": "apps/v1", "StatefulSet": "apps/v1", "DaemonSet": "apps/v1",
	"ReplicaSet": "apps/v1", "Job": "batch/v1", "CronJob": "batch/v1",
	"Rollout": "argoproj.io/v1alpha1",
}

var autoByMap = map[string]string{
	"user": "UI", "cluster": "UI-Cluster", "namespace": "ANS-Namespace", "excluded": "",
}

var autoIndicationMap = map[string]string{
	"namespace": "ANS-Namespace", "cluster": "Cluster", "user": "UI",
}

type selfOverride struct {
	cpuMin, memMin string // minAllowed quantities; "" emits an explicit {} config
	minReplicas0   bool   // additionally emit updatePolicy: {minReplicas: 0}
}

// selfOverrides is keyed by workload name in the component namespace.
var selfOverrides = map[string]selfOverride{
	"coolscaler-admissions":         {cpuMin: "10m", memMin: "50Mi"},
	"coolscaler-agent":              {cpuMin: "100m", memMin: "200Mi", minReplicas0: true},
	"coolscaler-dashboards":         {cpuMin: "50m", memMin: "100Mi"},
	"coolscaler-kube-state-metrics": {cpuMin: "20m", memMin: "150Mi"},
	"coolscaler-prometheus-server":  {cpuMin: "100m", memMin: "950Mi", minReplicas0: true},
	"coolscaler-recommender":        {cpuMin: "100m", memMin: "200Mi"},
	"coolscaler-updater":            {cpuMin: "50m", memMin: "200Mi", minReplicas0: true},
	"coolscaler-network-monitor":    {},
}

// selfOverridePolicies renders the spec.overridePolicies block, or nil when
// the workload is not one of our own components.
func selfOverridePolicies(ns, name, componentNS string) *pyjson.Obj {
	if ns != componentNS {
		return nil
	}
	ov, ok := selfOverrides[name]
	if !ok {
		return nil
	}
	cpuCfg := pyjson.NewObj()
	if ov.cpuMin != "" {
		cpuCfg.Set("minAllowed", ov.cpuMin)
	}
	memCfg := pyjson.NewObj()
	if ov.memMin != "" {
		memCfg.Set("minAllowed", ov.memMin)
	}
	out := pyjson.NewObj().Set("rightSizePolicy", pyjson.NewObj().
		Set("requestsConfigs", pyjson.NewObj().
			Set("cpu", cpuCfg).
			Set("memory", memCfg)))
	if ov.minReplicas0 {
		out.Set("updatePolicy", pyjson.NewObj().Set("minReplicas", 0))
	}
	return out
}

func (e *Engine) initialReplicasLocked(w *wlRow) int {
	if rh := e.replicaHistory[w.key]; len(rh) > 0 {
		return int(rh[0].replicas)
	}
	return w.replicas // w.get("pods", w.get("replicas", 0)) — rows carry "replicas"
}

// Returns "" for None.
func (e *Engine) javaMemoryTracking(ctx context.Context, w *wlRow) string {
	if !w.java {
		return ""
	}
	jvm := e.promJVM(ctx)
	used, samples := 0.0, 0
	for _, pv := range getList(w.obj, "podNames") {
		d := jvm[ppKey{w.namespace, str(pv)}]
		if d != nil && d["heapP90"] != 0 {
			if d["heapP90"] > used {
				used = d["heapP90"]
			}
			samples++
		}
	}
	if used <= 0 {
		return ""
	}
	origin := 0.0
	for _, cv := range getList(w.obj, "containers") {
		origin += f64d(obj(cv).GetD("recMem", 0), 0)
	}
	return string(pyjson.Marshal(pyjson.NewObj().
		Set("memoryUsage", int(used)).
		Set("originRecommendation", int(origin)).
		Set("sampleCount", samples)))
}

func (e *Engine) writeRecommendationCR(ctx context.Context, w *wlRow) {
	if !e.Cfg.WriteRecommendationCRs || !w.sizable {
		return
	}
	ns := w.namespace
	name := crName(w.kind, w.name)
	path := crdBase("recommendations", ns)
	key := w.key
	nowStamp := isoNow()

	// Registry snapshot.
	e.mu.Lock()
	hpaPolDefault := ""
	if w.kind == "Deployment" {
		hpaPolDefault = "production"
	}
	hpaPolicyName := hpaPolDefault
	if v, ok := e.replicasPolicyAssign[key]; ok {
		hpaPolicyName = v
	}
	appliedHpaPolicyName := hpaPolicyName
	schedPolicyName := "high-availability"
	if v, ok := e.schedulingPolAssign[key]; ok {
		schedPolicyName = v
	}
	dsName := "nights"
	if v, ok := e.downscaleAssign[key]; ok {
		dsName = v
	}
	replicasAuto := e.replicasAutomated[key]
	placementAuto := e.placementAutomated[key]
	schedulingAuto := e.schedulingAutomated[key]
	excluded := e.excluded[key]
	dsAutomated := e.downscaleAutomated[key]
	initialReplicas := e.initialReplicasLocked(w)
	var rhReplicas []int64
	for _, p := range e.replicaHistory[key] {
		rhReplicas = append(rhReplicas, p.replicas)
	}
	minNodeCpu := e.minNodeCpu
	dataSource := e.dataSource
	if dataSource == "" {
		dataSource = "metrics-server"
	}
	// DaemonSet recs split per node-size bucket when the builtin
	// DaemonSetNodeSize COG is enabled (builtin default: enabled).
	dsSplit := false
	if w.kind == "DaemonSet" {
		st := e.builtinCogState["DaemonSetNodeSize"]
		dsSplit = st == nil || truthy(st.GetD("enabled", true))
	}
	dsLegacyCleaned := false
	if dsSplit {
		dsLegacyCleaned = e.dsLegacyCleaned[key]
		e.dsLegacyCleaned[key] = true
	}
	e.mu.Unlock()

	tref := pyjson.NewObj().Set("kind", w.kind).Set("name", w.name).Set("namespace", ns)
	if apiVer := wlAPIVersions[w.kind]; apiVer != "" {
		tref.Set("apiVersion", apiVer)
	}
	autoSrc := str(w.obj.GetD("automationSource", nil)) // nil -> ""
	autoBy, okBy := autoByMap[autoSrc]
	if !okBy {
		autoBy = autoSrc
	}
	replAutoBy := ""
	if replicasAuto {
		replAutoBy = autoBy
	}
	javaAutoBy := ""
	if w.java && w.automated {
		javaAutoBy = autoBy
	}
	attachBy := autoBy
	if attachBy == "" {
		attachBy = "UI"
	}
	spec := pyjson.NewObj().
		Set("targetRef", tref).
		Set("policyName", w.obj.GetD("policyName", "production")).
		Set("optimize", w.automated).
		Set("hpaPolicyName", hpaPolicyName).
		Set("podSchedulingPolicyName", schedPolicyName).
		Set("spotOptimizationPolicy", "keep-original").
		Set("gpuPolicyName", "real-time").
		Set("gpuMemoryPolicyName", "").
		Set("downscalerPolicyName", dsName).
		Set("rightSizeOptimize", w.automated).
		Set("replicasOptimize", replicasAuto).
		Set("scaleOutOptimize", replicasAuto).
		Set("podPlacementOptimize", placementAuto).
		Set("podSchedulingOptimize", schedulingAuto).
		Set("automationExcluded", excluded).
		Set("gpuOptimize", false).
		Set("vllmOptimize", false).
		Set("spotOptimizationOptimize", false).
		Set("javaOptimize", w.java && w.automated).
		Set("overridden", false).
		Set("optimizeUpdateVersion", nowStamp).
		Set("policyUpdateVersion", nowStamp).
		Set("Automation", pyjson.NewObj().
			Set("attachPolicyBy", attachBy).
			Set("automatedBy", autoBy).
			Set("replicasAutomatedBy", replAutoBy).
			Set("javaAutomatedBy", javaAutoBy).
			Set("vllmAttachPolicyBy", "")).
		Set("automation", pyjson.NewObj().
			Set("attachPolicyBy", "name").
			Set("automatedBy", autoSrc))
	if op := selfOverridePolicies(ns, w.name, e.Cfg.Namespace); op != nil {
		spec.Set("overridePolicies", op)
		spec.Set("overridden", true)
	}

	containersList := getList(w.obj, "containers")
	recC, reqC := 0.0, 0.0
	for _, cv := range containersList {
		c := obj(cv)
		recC += f64d(c.GetD("recCpu", 0), 0)
		reqC += f64d(c.GetD("reqCpu", 0), 0)
	}
	updReason := "InSync"
	if recC > reqC*1.02 {
		updReason = "ResourceDiffScaleUp"
	} else if recC < reqC*0.98 {
		updReason = "ResourceDiffScaleDown"
	}
	zdtRecreate := str(getObj(w.obj, "annotations").GetD("coolscaler.sh/strategy", nil)) == "Recreate" ||
		truthy(w.obj.GetD("recreateStrategy", nil))
	updMsg := "Recommendation is ready."
	if zdtRecreate {
		updMsg = "Owner \"strategy.type\" is set to \"Recreate\" for this workload."
	}
	var readySecs []float64
	for _, pv := range getList(w.obj, "podInfo") {
		if rs := f64d(obj(pv).GetD("readySeconds", 0), 0); rs > 0 {
			readySecs = append(readySecs, rs)
		}
	}
	avgReady := 0
	if len(readySecs) > 0 {
		sum := 0.0
		for _, v := range readySecs {
			sum += v
		}
		avgReady = pyjson.RoundInt(sum / float64(len(readySecs)))
	}
	requiredAction := ""
	if zdtRecreate {
		requiredAction = "Use the \"Rollout workload\" action to optimize now."
	}
	healthCheck := "not-automated"
	if w.automated {
		healthCheck = "passed for h-hour " + isoNow()
	}
	bootEligible := "false"
	if truthy(w.obj.GetD("bootCpu", 0)) {
		bootEligible = "true"
	}
	imagesJoined := ""
	for _, iv := range getList(w.obj, "images") {
		imagesJoined += str(iv)
	}
	fingerprint := pyjson.NewObj()
	lang := "unknown"
	if w.java {
		lang = "java"
	}
	for _, cv := range containersList {
		c := obj(cv)
		fingerprint.Set(getStr(c, "name"), pyjson.NewObj().
			Set("language", lang).
			Set("framework", "").
			Set("servedProtocols", []any{}).
			Set("dependencies", []any{}).
			Set("gpu", truthy(c.GetD("req_gpu", 0))).
			Set("detectedAt", isoNow()))
	}
	ann := pyjson.NewObj().
		Set("coolscaler.sh/smart-policy", str(w.obj.GetD("smartPolicyName", ""))).
		Set("coolscaler.sh/smart-policy-workload-type", str(w.obj.GetD("smartPolicyWorkloadType", ""))).
		Set("coolscaler.sh/auto-indication", autoIndicationMap[autoSrc]).
		Set("coolscaler/update-event", string(pyjson.Marshal(pyjson.NewObj().
			Set("reason", updReason).
			Set("message", updMsg).
			Set("requiredAction", requiredAction).
			Set("shouldOverride", updReason == "ResourceDiffScaleUp").
			Set("additionalInfo", pyjson.NewObj())))).
		Set("coolscaler.sh/automation-health-check", healthCheck).
		Set("coolscaler.sh/boot-time-eligible", bootEligible).
		Set("coolscaler.sh/has-api-observability", "false").
		Set("coolscaler.sh/images-hash", strconv.FormatUint(uint64(stableHash(imagesJoined)), 10)).
		Set("coolscaler.sh/initial-observed-replicas", strconv.Itoa(initialReplicas)).
		Set("coolscaler.sh/minimal-historic-node-cpu-capacity", fmt.Sprintf("%.2f", minNodeCpu)).
		Set("coolscaler.sh/original-spot-ratio", "0").
		Set("coolscaler.sh/replicas-smart-policy", "").
		Set("coolscaler.sh/spot-optimization-pre-auto-ran-on-spot", "false").
		Set("coolscaler.sh/spot-optimization-smart-policy", "keep-original").
		Set("coolscaler.sh/liveness-failure-boot-time-on-small-nodes-count", "0").
		Set("coolscaler.sh/workload-trend-metadata", string(pyjson.Marshal(pyjson.NewObj().
			Set("avgPodReadyTimeSeconds", avgReady)))).
		Set("coolscaler.sh/workload-fingerprint", string(pyjson.Marshal(fingerprint)))
	if jvmAnn := e.javaMemoryTracking(ctx, w); jvmAnn != "" {
		ann.Set("coolscaler.sh/java-memory-usage-tracking", jvmAnn)
	}
	if zdtRecreate {
		ann.Set("coolscaler.sh/zdt-event", string(pyjson.Marshal(pyjson.NewObj().
			Set("reason", "ZdtFailure").
			Set("message", updMsg).
			Set("requiredAction", "New pods will be optimized. Use the \"Rollout workload\" action to optimize the workload now.").
			Set("additionalInfo", pyjson.NewObj()))))
	}
	// resolve the CR target list — one CR per node-size bucket for
	// daemonsets under the DaemonSetNodeSize COG, else the single
	// <kind>-<name> CR.
	type recTarget struct {
		crNm string
		spec *pyjson.Obj
	}
	targets := []recTarget{{name, spec}}
	if dsSplit {
		if buckets := getList(w.obj, "nodeSizes"); len(buckets) > 0 {
			targets = targets[:0]
			for _, bv := range buckets {
				full := dsNodeSizeName(w.name, str(bv))
				targets = append(targets, recTarget{
					"daemonsetnodesize-" + full,
					spec.Clone().Set("targetRef", pyjson.NewObj().
						Set("kind", "daemonsetnodesize").
						Set("name", full).
						Set("namespace", ns)),
				})
			}
			// The pre-split daemonset-<name> CR is superseded — delete it
			// once per process run (best-effort, write-gated).
			if !dsLegacyCleaned {
				if _, gerr := e.Kube.GetJSON(ctx, path+"/"+name); gerr == nil {
					_, _ = e.k8sReq(ctx, "DELETE", path+"/"+name, nil, "application/json")
				}
			}
		}
	}
	for _, tgt := range targets {
		name := tgt.crNm // shadow: the tail below is target-scoped
		spec := tgt.spec

		body := pyjson.NewObj().
			Set("apiVersion", crdGroup+"/"+crdVer).
			Set("kind", "Recommendation").
			Set("metadata", pyjson.NewObj().
				Set("name", name).
				Set("namespace", ns).
				Set("annotations", ann).
				Set("labels", pyjson.NewObj().
					Set("app.kubernetes.io/part-of", "coolscaler").
					Set("coolscaler", "coolscaler").
					Set("coolscaler.sh/workload-kind", w.kind))).
			Set("spec", spec)

		// create-if-missing / patch-if-exists (preserving originRequests).
		prevOrig := map[string]*pyjson.Obj{}
		cur, err := e.Kube.GetJSON(ctx, path+"/"+name)
		switch {
		case err == nil:
			for _, pcv := range getList(getObj(getObj(cur, "status"), "rightSize"), "containers") {
				pc := obj(pcv)
				po := obj(pc.GetD("originRequestsResources", nil))
				if po.Len() == 0 {
					po = obj(pc.GetD("originRequests", nil))
				}
				if truthy(po.GetD("cpu", nil)) || truthy(po.GetD("memory", nil)) {
					cn := str(pc.GetD("containerName", pc.GetD("name", nil)))
					prevOrig[cn] = po
				}
			}
			patchSpec := spec.Clone()
			if truthy(getObj(cur, "spec").GetD("optimizeUpdateVersion", nil)) {
				patchSpec.Del("optimizeUpdateVersion")
				patchSpec.Del("policyUpdateVersion")
			}
			patchAnn := ann.Clone()
			patchAnn.Set("coolscaler.sh/update-event", nil) // merge-patch null deletes the legacy key
			_, _ = e.k8sReq(ctx, "PATCH", path+"/"+name, pyjson.NewObj().
				Set("metadata", pyjson.NewObj().
					Set("annotations", patchAnn).
					Set("labels", pyjson.NewObj().Set("coolscaler", "coolscaler"))).
				Set("spec", patchSpec),
				"application/merge-patch+json")
		case isHTTPNotFound(err):
			_, _ = e.k8sReq(ctx, "POST", path, body, "application/json")
		default:
			if _, ok := isHTTPError(err); !ok {
				continue
			}
			continue
		}

		// ---- status subresource patch ----
		nowISO := time.Now().UTC().Format("2006-01-02T15:04:05Z")
		oom24 := int(i64(getObj(w.obj, "signals").GetD("oom", int64(0))))
		containers := []any{}
		minCov := 100
		var originCpuSum, originMemSum float64
		for _, cv := range containersList {
			c := obj(cv)
			samples := int(i64(c.GetD("samples", int64(0))))
			hp := e.Cfg.HistoryPoints
			if hp < 1 {
				hp = 1
			}
			cov := pyjson.RoundInt(100.0 * float64(samples) / float64(hp))
			if cov > 100 {
				cov = 100
			}
			if cov < minCov {
				minCov = cov
			}
			req := pyjson.NewObj().
				Set("cpu", FmtCPU(f64d(c.GetD("recCpu", 0), 0))).
				Set("memory", FmtMem(f64d(c.GetD("recMem", 0), 0)))
			orig := pyjson.NewObj().
				Set("cpu", FmtCPU(f64d(c.GetD("reqCpu", 0), 0))).
				Set("memory", FmtMem(f64d(c.GetD("reqMem", 0), 0))).
				Set("nvidia.com/gpu", strconv.Itoa(int(f64d(c.GetD("req_gpu", 0), 0))))
			if po := prevOrig[getStr(c, "name")]; po != nil {
				for _, k := range []string{"cpu", "memory"} {
					if v, ok := po.Get(k); ok && truthy(v) {
						orig.Set(k, v)
					}
				}
			}
			lim := pyjson.NewObj().
				Set("cpu", FmtCPU(f64d(c.GetD("limCpu", 0), 0))).
				Set("memory", FmtMem(f64d(c.GetD("limMem", 0), 0)))
			origlim := lim.Clone()
			rstat := pyjson.NewObj().
				Set("cpu", pyjson.NewObj().
					Set("maxObserved", FmtCPU(f64d(c.GetD("useCpu", 0), 0))).
					Set("readyWindowCoveragePercentage", cov)).
				Set("memory", pyjson.NewObj().
					Set("maxObserved", FmtMem(f64d(c.GetD("useMem", 0), 0))).
					Set("readyWindowCoveragePercentage", cov))
			caps := obj(c.GetD("capStatuses", nil)).Clone()
			limcaps := pyjson.NewObj().
				Set("cpu", pyjson.NewObj().Set("isCapped", false)).
				Set("memory", pyjson.NewObj().Set("isCapped", false))
			recEph := f64d(c.GetD("recEph", 0), 0)
			reqEph := f64d(c.GetD("reqEph", 0), 0)
			limEph := f64d(c.GetD("limEph", 0), 0)
			ephForReq := recEph
			if ephForReq == 0 {
				ephForReq = reqEph
			}
			req.Set("ephemeral-storage", FmtMem(ephForReq))
			orig.Set("ephemeral-storage", FmtMem(reqEph))
			lim.Set("ephemeral-storage", FmtMem(limEph))
			origlim.Set("ephemeral-storage", FmtMem(limEph))
			if !caps.Has("ephemeral-storage") {
				caps.Set("ephemeral-storage", pyjson.NewObj().Set("isCapped", false))
			}
			limcaps.Set("ephemeral-storage", pyjson.NewObj().Set("isCapped", false))
			if recEph != 0 {
				rstat.Set("ephemeral-storage", pyjson.NewObj().
					Set("maxObserved", FmtMem(f64d(c.GetD("useEph", 0), 0))).
					Set("readyWindowCoveragePercentage", cov))
			}
			origLimRes := origlim.Clone().
				Set("nvidia.com/gpu", strconv.Itoa(int(f64d(c.GetD("req_gpu", 0), 0))))
			entry := pyjson.NewObj().
				Set("name", c.GetD("name", nil)).
				Set("containerName", c.GetD("name", nil)).
				Set("requests", req).
				Set("limits", lim).
				Set("originRequests", orig).
				Set("originRequestsResources", orig).
				Set("originLimitResources", origLimRes).
				Set("originResources", pyjson.NewObj().
					Set("cpu", orig.GetD("cpu", nil)).
					Set("memory", orig.GetD("memory", nil))).
				Set("resourceStatuses", rstat).
				Set("capStatuses", caps).
				Set("limitCapStatuses", limcaps).
				Set("oomsInLast24h", oom24).
				Set("maxDailyUsageOvertime", pyjson.NewObj().
					Set("cpu", gzb64([]any{})).
					Set("memory", gzb64([]any{})))
			bc := f64d(c.GetD("bootCpu", 0), 0)
			if bc != 0 {
				entry.Set("bootTime", pyjson.NewObj().
					Set("requests", pyjson.NewObj().
						Set("cpu", FmtCPU(bc)).
						Set("memory", FmtMem(f64d(c.GetD("recMem", 0), 0)))).
					Set("average", pyjson.NewObj().
						Set("cpu", pyjson.NewObj().
							Set("lastUpdate", nowISO).
							Set("totalWeight", 1).
							Set("weightedSum", pyjson.Round(bc, 4))).
						Set("memory", pyjson.NewObj().Set("lastUpdate", nil))).
					Set("capStatuses", pyjson.NewObj().
						Set("cpu", pyjson.NewObj().Set("isCapped", false)).
						Set("memory", pyjson.NewObj().Set("isCapped", false))).
					Set("lastUpdated", nowISO))
			} else {
				entry.Set("bootTime", pyjson.NewObj().
					Set("average", pyjson.NewObj().
						Set("cpu", pyjson.NewObj().Set("lastUpdate", nil)).
						Set("memory", pyjson.NewObj().Set("lastUpdate", nil))))
			}
			containers = append(containers, entry)
			originCpuSum += ParseCPU(orig.GetD("cpu", nil))
			originMemSum += ParseMem(orig.GetD("memory", nil))
		}
		// Re-seed the in-memory origin store from the (preserved) CR origin.
		e.mu.Lock()
		e.originReq[key] = &origReq{cpu: originCpuSum, mem: originMemSum}
		maxObservedReplicas := int64(w.replicas)
		for _, r := range rhReplicas {
			if r > maxObservedReplicas {
				maxObservedReplicas = r
			}
		}
		e.mu.Unlock()

		dsActive := false
		if dsAutomated {
			grid := gridFromSchedule(builtinDownscalerSchedule(dsName))
			t := time.Now().UTC()
			wday := (int(t.Weekday()) + 6) % 7
			dsActive = grid[wday][t.Hour()]
		}
		trendVals := []any{}
		start := 0
		if len(rhReplicas) > 48 {
			start = len(rhReplicas) - 48
		}
		for _, r := range rhReplicas[start:] {
			trendVals = append(trendVals, float64(r))
		}
		hpaName := w.obj.GetD("hpaName", nil)
		hasUnsupportedHpa := truthy(hpaName) &&
			w.kind != "Deployment" && w.kind != "StatefulSet" && w.kind != "ReplicaSet"
		var hpaTrigTime any
		if w.hpaManaged {
			hpaTrigTime = nowISO
		}
		unevictable := map[string]bool{}
		for _, rv := range getList(w.obj, "unevictableReasons") {
			unevictable[str(rv)] = true
		}
		status := pyjson.NewObj().Set("status", pyjson.NewObj().
			Set("rightSize", pyjson.NewObj().
				Set("containers", containers).
				Set("hasUnsupportedHpaOwner", hasUnsupportedHpa).
				Set("hpaTriggerLastUpdateTime", hpaTrigTime)).
			Set("monthlySavings", fmt.Sprintf("$%.2f", math.Max(w.savings, 0.0))).
			Set("source", dataSource).
			Set("policyName", w.obj.GetD("policyName", "production")).
			Set("appliedPolicyName", w.obj.GetD("policyName", "production")).
			Set("appliedHpaPolicyName", appliedHpaPolicyName).
			Set("appliedGpuPolicyName", "real-time").
			Set("readyWindowCoveragePercentage", minCov).
			Set("conditions", []any{pyjson.NewObj().
				Set("type", "Ready").
				Set("status", "True").
				Set("reason", "RecommendationReady").
				Set("message", "Recommendation is ready").
				Set("lastTransitionTime", nowISO)}).
			Set("node", pyjson.NewObj()).
			Set("lastUpdateTime", nowISO).
			Set("maxObservedReplicas", maxObservedReplicas).
			Set("isOwnerless", w.kind == "Pod").
			Set("downscaler", pyjson.NewObj().
				Set("active", dsActive).
				Set("targetReplicas", 1).
				Set("targetMinReplicas", 1).
				Set("lastUpdateTime", nowISO)).
			Set("scaleout", pyjson.NewObj().
				Set("trend0", pyjson.NewObj().
					Set("lastUpdateDate", nowISO).
					Set("values", gzb64(trendVals)))).
			Set("binPacking", pyjson.NewObj().
				Set("pdbLimitation", unevictable["pdb"]).
				Set("safeToEvictLimitation", unevictable["annotation"]).
				Set("isOwnerlessLimitation", w.kind == "Pod").
				Set("isKubeSystemLimitation", ns == "kube-system").
				Set("binPackLabelsWeight", pyjson.NewObj().
					Set("affinityKey", "coolscaler.sh/managed-unevictable").
					Set("affinityWeight", 100))).
			Set("lastUpdated", nowISO))
		_, _ = e.k8sReq(ctx, "PATCH", path+"/"+name, status, "application/merge-patch+json")
	}
}

// dsNodeSizeBucketToken sanitizes a node-size bucket into a single dash-free
// lowercase token so that daemonsetnodesize CR names parse back unambiguously
// (name-<bucket>-<hash>).
func dsNodeSizeBucketToken(bucket string) string {
	var b []byte
	for _, c := range strings.ToLower(bucket) {
		if (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') {
			b = append(b, byte(c))
		}
	}
	if len(b) == 0 {
		return "node"
	}
	return string(b)
}

func dsNodeSizeName(dsName, bucket string) string {
	tok := dsNodeSizeBucketToken(bucket)
	sum := sha256.Sum256([]byte(dsName + "/" + tok))
	return crName(dsName, tok+"-"+hex.EncodeToString(sum[:5]))
}

// getRecommendationCR fetches a workload's Recommendation CR by canonical
// name, falling back to its first daemonsetnodesize-<name>-<bucket>-<hash>
// split CR for daemonsets under the DaemonSetNodeSize COG.
func (e *Engine) getRecommendationCR(ctx context.Context, ns, kind, name string) (*pyjson.Obj, error) {
	cr, err := e.Kube.GetJSON(ctx, crdBase("recommendations", ns)+"/"+crName(kind, name))
	if err == nil || kind != "DaemonSet" || !isHTTPNotFound(err) {
		return cr, err
	}
	list, lerr := e.Kube.GetJSON(ctx, crdBase("recommendations", ns))
	if lerr != nil {
		return nil, err
	}
	prefix := crName("daemonsetnodesize", name) + "-"
	for _, it := range items(list) {
		o := obj(it)
		if strings.HasPrefix(getStr(getObj(o, "metadata"), "name"), prefix) {
			return o, nil
		}
	}
	return nil, err
}

// dsNameFromNodeSizeRef maps a daemonsetnodesize targetRef name back to its
// DaemonSet name by stripping the trailing "-<bucket>-<hash10>" (both tokens
// are dash-free by construction). Returns "" when the name does not parse.
func dsNameFromNodeSizeRef(refName string) string {
	parts := strings.Split(refName, "-")
	if len(parts) < 3 {
		return ""
	}
	return strings.Join(parts[:len(parts)-2], "-")
}

// autohealStepMultiplier is AUTOHEAL_STEP_MULTIPLIER.
var autohealStepMultiplier = envFloat("AUTOHEAL_STEP_MULTIPLIER", 1.2)

func (e *Engine) writeAutoHealingCR(ctx context.Context, w *wlRow) {
	if !e.Cfg.WriteRecommendationCRs {
		return
	}
	sig := getObj(w.obj, "signals")
	oom := i64(sig.GetD("oom", int64(0)))
	if oom == 0 {
		return
	}
	// java-memory-aware policy: automation.oomAutoHealing=false disables the
	// OOM step-up for Java workloads (persisted in cluster-ops java-policy-config).
	if w.java && !truthy(e.javaPolicyConfig(ctx).GetD("oomAutoHealing", true)) {
		return
	}
	ns := w.namespace
	name := crName("oom-"+w.kind, w.name)
	path := crdBase("autohealings", ns)
	now := time.Now().UTC().Format("2006-01-02T15:04:05Z")
	validUntil := time.Now().UTC().Add(24 * time.Hour).Format("2006-01-02T15:04:05Z")
	step := int(oom)
	if step > 5 {
		step = 5
	}
	recMem := f64d(w.obj.GetD("recMem", 0), 0)
	healedMem := int(recMem * math.Pow(autohealStepMultiplier, float64(step)))
	spec := pyjson.NewObj().
		Set("type", "OutOfMemory").
		Set("stepUpMultiplier", autohealStepMultiplier).
		Set("targetRef", pyjson.NewObj().Set("kind", w.kind).Set("name", w.name))
	body := pyjson.NewObj().
		Set("apiVersion", crdGroup+"/"+crdVer).
		Set("kind", "AutoHealing").
		Set("metadata", pyjson.NewObj().
			Set("name", name).
			Set("namespace", ns).
			Set("labels", pyjson.NewObj().Set("app.kubernetes.io/part-of", "coolscaler"))).
		Set("spec", spec)
	_, err := e.Kube.GetJSON(ctx, path+"/"+name)
	switch {
	case err == nil:
		_, _ = e.k8sReq(ctx, "PATCH", path+"/"+name,
			pyjson.NewObj().Set("spec", spec), "application/merge-patch+json")
	case isHTTPNotFound(err):
		_, _ = e.k8sReq(ctx, "POST", path, body, "application/json")
	default:
		return
	}
	remediation := []any{}
	for i, cv := range getList(w.obj, "containers") {
		if i >= 1 {
			break
		}
		c := obj(cv)
		remediation = append(remediation, pyjson.NewObj().
			Set("name", c.GetD("name", nil)).
			Set("requests", pyjson.NewObj().Set("memory", FmtMem(float64(healedMem)))))
	}
	status := pyjson.NewObj().Set("status", pyjson.NewObj().
		Set("type", "OutOfMemory").
		Set("stepNumber", step).
		Set("validUntil", validUntil).
		Set("policyUsed", w.obj.GetD("policyName", "production")).
		Set("lastUpdated", now).
		Set("rightSizeRemediation", remediation).
		Set("conditions", []any{pyjson.NewObj().
			Set("type", "Healed").
			Set("status", "True").
			Set("reason", "MemoryStepUp").
			Set("lastTransitionTime", now)}))
	_, _ = e.k8sReq(ctx, "PATCH", path+"/"+name, status, "application/merge-patch+json")
}

func gridFromSchedule(schedule []any) [7][24]bool {
	return pagesGridFromSchedule(schedule)
}

func hourOf(s string, def int) int {
	for i := 0; i < len(s); i++ {
		if s[i] == ':' {
			s = s[:i]
			break
		}
	}
	if n, ok := parseIntPy(s); ok {
		return n
	}
	return def
}
