package engine

// promexport.go — the recommender's self-metrics exporter: the coolscaler_*
// input-gauge families the Prometheus recording rules consume.
// These are the CoolScaler analogs of the raw metric series a commercial
// recommender exports from its own /metrics (they are INPUTS to
// recording_rules.yml, not recorded rules themselves):
//
//	coolscaler_recommendation_pod_owner_recommendation_v2{namespace,owner_type,owner_name,pod} == 1
//	coolscaler_recommendation_managed_workload_status{namespace,owner_type,owner_name} 0|1
//	coolscaler_recommendation_container_recommended_cpu_requests_mili_cores{...,container}
//	coolscaler_recommendation_container_recommended_memory_requests_bytes{...,container}
//	coolscaler_recommendation_container_recommended_ephemeral_storage_requests_bytes{...,container}
//	coolscaler_recommendation_origin_cpu_requests_mili_cores{...,container}
//	coolscaler_recommendation_origin_memory_requests_bytes{...,container}
//	coolscaler_recommendation_container_oom_event_count{...,pod,container,cause}
//	coolscaler_replicas_per_recommendation{namespace,owner_type,owner_name}
//	coolscaler_ignored_namespaces{namespace}
//
// Everything is computed from the engine's in-memory refresh state per scrape
// and is error-tolerant like the other collectors: if the state is not ready
// yet the collector simply emits nothing (rules degrade to empty results, no
// fabricated values).

import (
	"strings"

	"github.com/prometheus/client_golang/prometheus"

	"coolscaler.sh/coolscaler/internal/pyjson"
	"coolscaler.sh/coolscaler/internal/version"
)

// PromExporter implements prometheus.Collector over Engine state.
type PromExporter struct {
	eng *Engine

	podOwnerDesc  *prometheus.Desc
	managedDesc   *prometheus.Desc
	recCpuDesc    *prometheus.Desc
	recMemDesc    *prometheus.Desc
	recEphDesc    *prometheus.Desc
	origCpuDesc   *prometheus.Desc
	origMemDesc   *prometheus.Desc
	oomDesc       *prometheus.Desc
	replicasDesc  *prometheus.Desc
	ignoredNsDesc *prometheus.Desc
	attachedPolDesc *prometheus.Desc
	nsAutoDesc      *prometheus.Desc
	alertsDesc      *prometheus.Desc
	evictionsDesc   *prometheus.Desc
	healingDesc     *prometheus.Desc
	downscaledDesc  *prometheus.Desc
	versionDesc     *prometheus.Desc
}

// NewPromExporter builds the recommender self-metrics collector.
func NewPromExporter(e *Engine) *PromExporter {
	wl := []string{"namespace", "owner_type", "owner_name"}
	wlc := append(append([]string{}, wl...), "container")
	return &PromExporter{
		eng: e,
		podOwnerDesc: prometheus.NewDesc(
			"coolscaler_recommendation_pod_owner_recommendation_v2",
			"1 per active pod of each workload that has a recommendation (pod -> owner join table).",
			append(append([]string{}, wl...), "pod"), nil),
		managedDesc: prometheus.NewDesc(
			"coolscaler_recommendation_managed_workload_status",
			"1 when the workload's rightsizing automation is on, else 0.",
			wl, nil),
		recCpuDesc: prometheus.NewDesc(
			"coolscaler_recommendation_container_recommended_cpu_requests_mili_cores",
			"Per-container recommended CPU request in MILLIcores.",
			wlc, nil),
		recMemDesc: prometheus.NewDesc(
			"coolscaler_recommendation_container_recommended_memory_requests_bytes",
			"Per-container recommended memory request in bytes.",
			wlc, nil),
		recEphDesc: prometheus.NewDesc(
			"coolscaler_recommendation_container_recommended_ephemeral_storage_requests_bytes",
			"Per-container recommended ephemeral-storage request in bytes.",
			wlc, nil),
		origCpuDesc: prometheus.NewDesc(
			"coolscaler_recommendation_origin_cpu_requests_mili_cores",
			"Per-container ORIGINAL (pre-optimization) CPU request in millicores.",
			wlc, nil),
		origMemDesc: prometheus.NewDesc(
			"coolscaler_recommendation_origin_memory_requests_bytes",
			"Per-container ORIGINAL (pre-optimization) memory request in bytes.",
			wlc, nil),
		oomDesc: prometheus.NewDesc(
			"coolscaler_recommendation_container_oom_event_count",
			"OOM events observed for the workload's pods, by cause (OOMKilled | NodeMemoryPressure).",
			append(append([]string{}, wl...), "pod", "container", "cause"), nil),
		replicasDesc: prometheus.NewDesc(
			"coolscaler_replicas_per_recommendation",
			"Current live replica count per recommended workload.",
			wl, nil),
		ignoredNsDesc: prometheus.NewDesc(
			"coolscaler_ignored_namespaces",
			"1 per namespace excluded from optimization (GLOBAL_AUTO excludedNamespaces).",
			[]string{"namespace"}, nil),
		// Functional Metrics (doc): the recommender/agent/updater self-metrics.
		attachedPolDesc: prometheus.NewDesc(
			"coolscaler_recommendation_attached_policy",
			"The policy used for a workload .",
			append(append([]string{}, wl...), "policy_name", "desired_policy_name"), nil),
		nsAutoDesc: prometheus.NewDesc(
			"coolscaler_namespace_auto_state",
			"Namespace rightsizing automation state (1=automated) per namespace/mode.",
			[]string{"namespace", "mode"}, nil),
		alertsDesc: prometheus.NewDesc(
			"coolscaler_alerts",
			"Count of workloads matching a predefined alert (CPUThrottling|OOM|UnderProvisioning|OverProvisioning).",
			[]string{"alert_type"}, nil),
		evictionsDesc: prometheus.NewDesc(
			"coolscaler_updater_evictions",
			"Count of workload pod evictions/resizes the updater triggered for ongoing optimization, by type.",
			[]string{"eviction_type"}, nil),
		healingDesc: prometheus.NewDesc(
			"coolscaler_workloads_healing",
			"Count of workloads with an active auto-healing boost, by reason (CPUStress|BurstReaction).",
			[]string{"reason"}, nil),
		downscaledDesc: prometheus.NewDesc(
			"coolscaler_workloads_downscaled",
			"Count of workloads whose resources were reduced (right-sized down) vs their original request.",
			nil, nil),
		versionDesc: prometheus.NewDesc(
			"coolscaler_version_info",
			"Running CoolScaler version (1 per version label).",
			[]string{"version"}, nil),
	}
}

func (x *PromExporter) Describe(ch chan<- *prometheus.Desc) {
	ch <- x.podOwnerDesc
	ch <- x.managedDesc
	ch <- x.recCpuDesc
	ch <- x.recMemDesc
	ch <- x.recEphDesc
	ch <- x.origCpuDesc
	ch <- x.origMemDesc
	ch <- x.oomDesc
	ch <- x.replicasDesc
	ch <- x.ignoredNsDesc
	ch <- x.attachedPolDesc
	ch <- x.nsAutoDesc
	ch <- x.alertsDesc
	ch <- x.evictionsDesc
	ch <- x.healingDesc
	ch <- x.downscaledDesc
	ch <- x.versionDesc
}

// exportContainer is the per-container snapshot used by Collect.
type exportContainer struct {
	name           string
	reqCpu, reqMem float64
	recCpu, recMem float64
	recEph         float64
}

// exportWorkload is a lock-free snapshot of one wlRow.
type exportWorkload struct {
	namespace, ownerType, ownerName string
	replicas                        int
	automated                       bool
	pods                            []string
	podOom                          map[string]int64 // OOMKilled count per pod
	oomNode                         int64            // NodeMemoryPressure evictions (workload level)
	containers                      []exportContainer
	origCpu, origMem                float64 // per-replica origin totals (ORIGIN_REQ)
	policy, desiredPolicy           string
	savings, throttlePct            float64
	oomCount                        int64
	underProv                       bool
	healReason                      string
	downscaled                      bool
}

// exportSnapshot copies the fields Collect needs while holding e.mu, so the
// (potentially slow) metric emission happens outside the engine lock.
func (e *Engine) exportSnapshot() ([]exportWorkload, []string, map[string]bool, map[string]int64) {
	e.mu.Lock()
	defer e.mu.Unlock()

	// Per-namespace automation state: automated if ANY of its workloads is.
	nsAuto := map[string]bool{}
	for _, w := range e.workloads {
		if w.kind == "Node" {
			continue
		}
		if w.automated {
			nsAuto[w.namespace] = true
		} else if _, seen := nsAuto[w.namespace]; !seen {
			nsAuto[w.namespace] = false
		}
	}
	evictions := map[string]int64{}
	kindLabel := map[string]string{
		"inPlaceResize": "InPlace", "podEviction": "Eviction", "podOptimized": "Rolling",
	}
	for _, ent := range e.auditLog {
		if lbl, ok := kindLabel[str(ent.GetD("kind", ""))]; ok {
			evictions[lbl]++
		}
	}

	var out []exportWorkload
	for _, w := range e.workloads {
		if !w.sizable {
			continue
		}
		ew := exportWorkload{
			namespace: w.namespace,
			ownerType: strings.ToLower(w.kind),
			ownerName: w.name,
			replicas:  w.replicas,
			automated: w.automated,
			podOom:    map[string]int64{},
		}
		for _, pv := range getList(w.obj, "podNames") {
			ew.pods = append(ew.pods, str(pv))
		}
		for _, pv := range getList(w.obj, "podInfo") {
			p := obj(pv)
			if n := getStr(p, "name"); n != "" {
				if c := i64(p.GetD("oom", int64(0))); c > 0 {
					ew.podOom[n] = c
				}
			}
		}
		sig := getObj(w.obj, "signals")
		ew.oomNode = i64(sig.GetD("oomNode", int64(0)))
		ew.oomCount = i64(sig.GetD("oom", int64(0)))
		ew.throttlePct = f64d(sig.GetD("throttle", 0.0), 0)
		ew.policy = firstNonEmpty(getStr(w.obj, "policyName"), str(w.obj.GetD("policy", "")), "production")
		ew.desiredPolicy = firstNonEmpty(getStr(w.obj, "policySuggested"), ew.policy)
		ew.savings = f64d(w.obj.GetD("savings", 0.0), 0)
		ew.healReason = str(sig.GetD("healReason", ""))
		for _, cv := range getList(w.obj, "containers") {
			c := obj(cv)
			rc, qc := f64d(c.GetD("recCpu", 0.0), 0), f64d(c.GetD("reqCpu", 0.0), 0)
			rm, qm := f64d(c.GetD("recMem", 0.0), 0), f64d(c.GetD("reqMem", 0.0), 0)
			if (qc > 0 && rc > qc*1.03) || (qm > 0 && rm > qm*1.03) {
				ew.underProv = true
			}
			if (qc > 0 && rc > 0 && rc < qc*0.97) || (qm > 0 && rm > 0 && rm < qm*0.97) {
				ew.downscaled = true
			}
			ew.containers = append(ew.containers, exportContainer{
				name: getStr(c, "name"), reqCpu: qc, reqMem: qm,
				recCpu: rc, recMem: rm, recEph: f64d(c.GetD("recEph", 0.0), 0),
			})
		}
		if o := e.originReq[w.key]; o != nil {
			ew.origCpu, ew.origMem = o.cpu, o.mem
		}
		out = append(out, ew)
	}

	var ignored []string
	for _, v := range getList(e.globalAuto, "excludedNamespaces") {
		if s := str(v); s != "" {
			ignored = append(ignored, s)
		}
	}
	return out, ignored, nsAuto, evictions
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

func (x *PromExporter) Collect(ch chan<- prometheus.Metric) {
	wls, ignored, nsAuto, evictions := x.eng.exportSnapshot()

	g := func(d *prometheus.Desc, v float64, labels ...string) {
		if m, err := prometheus.NewConstMetric(d, prometheus.GaugeValue, v, labels...); err == nil {
			ch <- m // error-tolerant: a bad label set drops the sample, never panics the scrape
		}
	}

	// Functional Metrics: alert counts by type, per-ns automation, evictions.
	var nThrottle, nOom, nUnder, nOver, nHealCpu, nHealBurst, nDownscaled int
	for _, w := range wls {
		wl := []string{w.namespace, w.ownerType, w.ownerName}

		g(x.managedDesc, b2f(w.automated), wl...)
		g(x.replicasDesc, float64(w.replicas), wl...)
		g(x.attachedPolDesc, 1, w.namespace, w.ownerType, w.ownerName, w.policy, w.desiredPolicy)
		if w.throttlePct > 75 {
			nThrottle++
		}
		if w.oomCount > 0 {
			nOom++
		}
		if w.underProv {
			nUnder++
		}
		if w.savings > 0.5 {
			nOver++
		}
		switch w.healReason {
		case "CPUStress":
			nHealCpu++
		case "BurstReaction":
			nHealBurst++
		}
		if w.downscaled {
			nDownscaled++
		}

		for _, p := range w.pods {
			g(x.podOwnerDesc, 1, w.namespace, w.ownerType, w.ownerName, p)
		}

		// Per-container recommendation gauges.
		var curCpuTot, curMemTot float64
		for _, c := range w.containers {
			curCpuTot += c.reqCpu
			curMemTot += c.reqMem
		}
		for i, c := range w.containers {
			cl := []string{w.namespace, w.ownerType, w.ownerName, c.name}
			g(x.recCpuDesc, c.recCpu*1000.0, cl...)
			g(x.recMemDesc, c.recMem, cl...)
			if c.recEph > 0 {
				g(x.recEphDesc, c.recEph, cl...)
			}
			// Origin requests: ORIGIN_REQ is tracked per workload (per-replica
			// totals preserved through the rec CR's originRequests). Split it
			// across containers proportionally to their current requests so
			// the per-container series still sum to the true workload origin.
			oc, om := c.reqCpu, c.reqMem
			if w.origCpu > 0 {
				if curCpuTot > 0 {
					oc = w.origCpu * (c.reqCpu / curCpuTot)
				} else if i == 0 {
					oc = w.origCpu
				} else {
					oc = 0
				}
			}
			if w.origMem > 0 {
				if curMemTot > 0 {
					om = w.origMem * (c.reqMem / curMemTot)
				} else if i == 0 {
					om = w.origMem
				} else {
					om = 0
				}
			}
			g(x.origCpuDesc, oc*1000.0, cl...)
			g(x.origMemDesc, om, cl...)
		}

		// OOM events. Container attribution is not tracked per pod status
		// entry in our refresh pass, so the container label is left empty —
		// the rules only ever aggregate over it (max by... sum by cause).
		for pod, n := range w.podOom {
			g(x.oomDesc, float64(n), w.namespace, w.ownerType, w.ownerName, pod, "", "OOMKilled")
		}
		if w.oomNode > 0 {
			g(x.oomDesc, float64(w.oomNode), w.namespace, w.ownerType, w.ownerName, "", "", "NodeMemoryPressure")
		}
	}

	for _, ns := range ignored {
		g(x.ignoredNsDesc, 1, ns)
	}

	// coolscaler_alerts{alert_type} — the predefined-alert workload counts.
	g(x.alertsDesc, float64(nThrottle), "CPUThrottling")
	g(x.alertsDesc, float64(nOom), "OOM")
	g(x.alertsDesc, float64(nUnder), "UnderProvisioning")
	g(x.alertsDesc, float64(nOver), "OverProvisioning")

	// coolscaler_namespace_auto_state{namespace,mode}
	for ns, on := range nsAuto {
		g(x.nsAutoDesc, b2f(on), ns, "rightsize")
	}

	// coolscaler_updater_evictions{eviction_type}
	for typ, n := range evictions {
		g(x.evictionsDesc, float64(n), typ)
	}

	// coolscaler_workloads_healing{reason} + coolscaler_workloads_downscaled
	g(x.healingDesc, float64(nHealCpu), "CPUStress")
	g(x.healingDesc, float64(nHealBurst), "BurstReaction")
	g(x.downscaledDesc, float64(nDownscaled))
	g(x.versionDesc, 1, version.Version)
}

func b2f(b bool) float64 {
	if b {
		return 1
	}
	return 0
}

// ---------------------------------------------------------------------------
// coolscaler_node_hourly_cost{node, resource=cpu|memory|total}
// ---------------------------------------------------------------------------

// NodeHourlyCostRow is one coolscaler_node_hourly_cost sample: the $/hour
// price of the node (resource="total") and its per-unit rates — $ per
// core-hour (resource="cpu") and $ per GiB-hour (resource="memory") — the
// exact join keys the coolscalerCostOverTime rules multiply requests by.
type NodeHourlyCostRow struct {
	Node     string
	Resource string
	Rate     float64
}

// NodeHourlyCostRows derives the hourly-cost rows from a NodeTable result
// (so the /metrics handler reuses the NodeTable call it already makes for
// coolscaler_node_cost_usd_monthly — no extra API round-trips per scrape).
func (e *Engine) NodeHourlyCostRows(nt *pyjson.Obj) []NodeHourlyCostRow {
	e.mu.Lock()
	cpuRate := e.costCPUCoreMonth / hoursPerMonth // $ per core-hour (on-demand)
	memRate:= e.costMemGBMonth / hoursPerMonth   // $ per GiB-hour (on-demand)
	spotFrac := e.spotFraction
	e.mu.Unlock()

	var out []NodeHourlyCostRow
	for _, nv := range getList(nt, "nodes") {
		n := obj(nv)
		name := getStr(n, "name")
		if name == "" {
			continue
		}
		mul := 1.0
		if truthy(n.GetD("isSpot", false)) {
			mul = spotFrac
		}
		out = append(out,
			NodeHourlyCostRow{Node: name, Resource: "cpu", Rate: cpuRate * mul},
			NodeHourlyCostRow{Node: name, Resource: "memory", Rate: memRate * mul},
			NodeHourlyCostRow{Node: name, Resource: "total",
				Rate: f64d(n.GetD("cost", 0.0), 0) / hoursPerMonth})
	}
	return out
}
