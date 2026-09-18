package engine

import (
	"context"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"coolscaler.sh/coolscaler/internal/pyjson"
)

type sigT struct {
	throttle  float64
	oom       int64
	oomNode   int64
	restarts  int64
	crashloop int64
	liveness  int64
	burst     bool
	boot      bool
	heal      bool   // CPU auto-healing boost active
	healReason string // "CPUStress" | "BurstReaction"
	diskEvict int64
	psiCpu    float64
	psiMem    float64
}

func (s *sigT) toObj() *pyjson.Obj {
	return pyjson.NewObj().
		Set("throttle", s.throttle).
		Set("oom", s.oom).
		Set("oomNode", s.oomNode).
		Set("restarts", s.restarts).
		Set("crashloop", s.crashloop).
		Set("liveness", s.liveness).
		Set("burst", s.burst).
		Set("boot", s.boot).
		Set("heal", s.heal).
		Set("healReason", s.healReason).
		Set("diskEvict", s.diskEvict).
		Set("psiCpu", s.psiCpu).
		Set("psiMem", s.psiMem)
}

type cinfo struct {
	reqCpu, reqMem, reqEph float64
	reqGpu                 float64
	limCpu, limMem, limEph float64
	java                   bool
	xmx                    int64
}

type iinfo struct {
	reqCpu, reqMem float64
}

type group struct {
	ns, kind, name string
	policyAnn      string
	pods           map[string]bool
	podnames       map[string]bool
	containerKeys  []string
	containers     map[string]*cinfo
	initKeys       []string
	initContainers map[string]*iinfo
	images         map[string]bool
	nodeSizes      map[string]bool
	privileged     bool
	unevictable    map[string]bool
	nodeSelKeys    map[string]bool
	tolKeys        map[string]bool
	priorityClass  string
	labels         *pyjson.Obj
	annotations    *pyjson.Obj
	env            map[string]string // container env: name → value (presence = key exists)
	podInfo        []any
	sig            sigT
	live           map[string]*[2]float64
}

func newGroup() *group {
	return &group{
		pods: map[string]bool{}, podnames: map[string]bool{},
		containers: map[string]*cinfo{}, initContainers: map[string]*iinfo{},
		images: map[string]bool{}, nodeSizes: map[string]bool{},
		unevictable: map[string]bool{}, nodeSelKeys: map[string]bool{}, tolKeys: map[string]bool{},
		labels: pyjson.NewObj(), annotations: pyjson.NewObj(),
		env: map[string]string{}, live: map[string]*[2]float64{},
	}
}

// wlRow is a workload table row: the rendered object plus the fields the
// overview aggregation reads back.
type wlRow struct {
	obj                        *pyjson.Obj
	key, namespace, kind, name string
	replicas                   int
	reqCpu, recCpu             float64
	monthlyCost, savings       float64
	initSavings, activeSavings float64
	sizable, automated         bool
	hpaManaged, java, agentic  bool
}

// capInfo builds the reference-style capStatuses entry; cap() analog.
func capValue(value, lo, hi float64, format func(float64) string) (float64, *pyjson.Obj) {
	if value < lo {
		return lo, pyjson.NewObj().
			Set("isCapped", true).
			Set("cappedSource", "policyBoundary").
			Set("cappedType", "min").
			Set("originalCappedValue", format(value)).
			Set("message", "Recommendation is constrained by minimum resource boundaries set by the policy")
	}
	if value > hi {
		return hi, pyjson.NewObj().
			Set("isCapped", true).
			Set("cappedSource", "policyBoundary").
			Set("cappedType", "max").
			Set("originalCappedValue", format(value)).
			Set("message", "Recommendation limit is constrained by the workload's preserved limit (configured in the policy)")
	}
	return value, pyjson.NewObj().Set("isCapped", false)
}

// computeLimit applies a policy's per-resource limit strategy + dynamic caps
// to produce the recommended LIMIT for one container/resource.
// origLimit/origReq are the current spec values; recReq is the new recommended
// request. With lc.has=false (keepOriginal — the default) it returns origLimit
// unchanged, so limits are only ever mutated when a policy explicitly sets a
// limit strategy.
func computeLimit(lc limitCfg, origLimit, origReq, recReq float64) float64 {
	if !lc.has {
		return origLimit
	}
	var lim float64
	switch lc.strategy {
	case "noLimit":
		return 0 // 0 == "no limit" downstream
	case "equalsToRequest":
		lim = recReq
	case "setLimit":
		lim = lc.setLimit
	case "ratio":
		r := lc.ratio
		if r <= 0 {
			r = 1
		}
		lim = recReq * r
	case "keepLimitRequestRatio":
		r := 1.0
		if origReq > 0 && origLimit > 0 {
			r = origLimit / origReq
		}
		lim = recReq * r
	default:
		lim = origLimit
	}
	// Dynamic caps — "smaller wins" ceilings, floor last.
	if lc.maxIncrease > 0 && origLimit > 0 {
		if c := origLimit * lc.maxIncrease; lim > c {
			lim = c
		}
	}
	if lc.maxLimit > 0 && lim > lc.maxLimit {
		lim = lc.maxLimit
	}
	if lc.minLimit > 0 && lim < lc.minLimit {
		lim = lc.minLimit
	}
	if lim < 0 {
		lim = 0
	}
	return lim
}

// healBoost is a decaying CPU auto-healing multiplier.
type healBoost struct {
	mult   float64
	expiry int64
	reason string // "CPUStress" | "BurstReaction"
}

// cpuHealBoost maintains + returns the decaying CPU boost for one container.
// Active distress (stress) sets/refreshes a boost that persists (refreshing its
// expiry) until distress clears, then decays away when it expires; a burst is a
// shorter-lived boost. Returns the multiplier (>=1) to apply to rCpu + reason.
func (e *Engine) cpuHealBoost(key string, now int64, stress, burst bool,
	stressMult, burstMult float64, stressWin, burstWin int64) (float64, string) {
	e.healMu.Lock()
	defer e.healMu.Unlock()
	b, ok := e.cpuHeal[key]
	if ok && b.expiry <= now {
		ok = false // expired
	}
	switch {
	case stress:
		if !ok || stressMult >= b.mult {
			b = healBoost{mult: stressMult, expiry: now + stressWin, reason: "CPUStress"}
		} else {
			b.expiry = now + stressWin // sustained distress keeps the boost alive
		}
		ok = true
	case burst:
		if !ok || burstMult >= b.mult {
			b = healBoost{mult: burstMult, expiry: now + burstWin, reason: "BurstReaction"}
		} else if b.expiry < now+burstWin {
			b.expiry = now + burstWin
		}
		ok = true
	}
	if !ok {
		delete(e.cpuHeal, key)
		return 1, ""
	}
	e.cpuHeal[key] = b
	return b.mult, b.reason
}

var agenticImageHints = []string{"vllm", "llm", "triton", "tgi", "ollama", "ray",
	"langchain", "langgraph", "agent", "inference", "sglang", "transformers", "huggingface"}
var agenticNameHints = []string{"agent", "llm", "inference", "vllm", "rag"}
var javaBlobHints = []string{"java", "jdk", "jre", "temurin", "openjdk", "spring",
	"tomcat", "elasticsearch", "kafka", "cassandra", "logstash"}

// Read-only
func (e *Engine) Refresh(ctx context.Context) error {
	cfg := e.Cfg

	nodes, err := e.Kube.GetJSON(ctx, "/api/v1/nodes")
	if err != nil {
		return err
	}
	pods, err := e.Kube.GetJSON(ctx, "/api/v1/pods")
	if err != nil {
		return err
	}
	replicasets, err := e.Kube.GetJSON(ctx, "/apis/apps/v1/replicasets")
	if err != nil {
		return err
	}
	metrics, err := e.Kube.GetJSON(ctx, "/apis/metrics.k8s.io/v1beta1/pods")
	if err != nil {
		metrics = pyjson.NewObj().Set("items", []any{})
	}
	rsIndex := buildOwnerIndex(replicasets)
	hpaMap := e.buildAutoscalerIndex(ctx)
	pdbIndex := e.buildPDBIndex(ctx)
	autoNs := e.loadAutomatedNamespaces(ctx)

	// Workload annotation controls + namespace metadata + custom-ns labels +
	// cluster-operations general keys (all read BEFORE the big e.mu section —
	// clusterOps / loadCustomNsLabelsCM take the lock themselves).
	nsAnnIdx, nsLblIdx := e.loadNamespaceMeta(ctx)
	e.loadCustomNsLabelsCM(ctx)
	cnl := e.customNsMatchers()
	ops := e.clusterOps(ctx, false)
	opsRightsize := str(ops.GetD("rightsize-optimize", nil)) == "true"
	opsReplicas := str(ops.GetD("replicas-optimize", nil)) == "true"
	opsPlacement := str(ops.GetD("pod-placement-optimize", nil)) == "true"
	opsDefaultPolicy := str(ops.GetD("default-rightsize-policy", nil))
	javaAutoPolicy := e.javaAutoPolicyOn(ctx)
	jpcRealUsage := truthy(e.javaPolicyConfig(ctx).GetD("realUsageCalculation", true))
	resetRequested := e.controlResetRequested(ctx)
	resetN := 0
	var resetPolicyTargets [][3]string
	promCPU, promMem := e.promPercentiles(ctx)
	promEph := e.promEphemeral(ctx)
	promJvmData := e.promJVM(ctx)
	usingProm := len(promCPU) > 0 || len(promMem) > 0

	// the read-only port reads the same preserved values back.
	e.loadOriginFromRecs(ctx)

	var capCpuTotal, capMemTotal, allocCpu, allocMem float64
	var allocCpuSpot, allocMemSpot, allocCpuOD, allocMemOD float64
	var nodeCostTotal float64
	spotNodeCount := 0
	var allocEph float64
	minNodeCpu := 0.0
	nodeItems := items(nodes)
	nodeAlloc := map[string][2]float64{} // node name → {allocatable cpu, mem}
	for _, nv := range nodeItems {
		n := obj(nv)
		st := getObj(n, "status")
		lbl := getObj(getObj(n, "metadata"), "labels")
		aCpu := ParseCPU(getObj(st, "allocatable").GetD("cpu", nil))
		nCpu := ParseCPU(getObj(st, "capacity").GetD("cpu", nil))
		if nCpu > 0 {
			if minNodeCpu == 0.0 || nCpu < minNodeCpu {
				minNodeCpu = nCpu
			}
		}
		aMem := ParseMem(getObj(st, "allocatable").GetD("memory", nil))
		capCpuTotal += ParseCPU(getObj(st, "capacity").GetD("cpu", nil))
		capMemTotal += ParseMem(getObj(st, "capacity").GetD("memory", nil))
		allocCpu += aCpu
		allocMem += aMem
		nodeAlloc[getStr(getObj(n, "metadata"), "name")] = [2]float64{aCpu, aMem}
		allocEph += ParseMem(getObj(st, "allocatable").GetD("ephemeral-storage", nil))
		captype := getStr(lbl, "karpenter.sh/capacity-type")
		if captype == "" {
			captype = getStr(lbl, "eks.amazonaws.com/capacityType")
		}
		if captype == "" {
			captype = getStr(lbl, "node.kubernetes.io/capacity-type")
		}
		if captype == "" {
			captype = getStr(lbl, "cloud.google.com/gke-spot")
		}
		captype = strings.ToLower(captype)
		isSpot := captype == "spot" || captype == "true"
		if isSpot {
			allocCpuSpot += aCpu
			allocMemSpot += aMem
			spotNodeCount++
		} else {
			allocCpuOD += aCpu
			allocMemOD += aMem
		}
		itype := getStr(lbl, "node.kubernetes.io/instance-type")
		if itype == "" {
			itype = getStr(lbl, "beta.kubernetes.io/instance-type")
		}
		cost, _ := e.nodeMonthlyCost(itype, isSpot, aCpu, aMem, 0)
		nodeCostTotal += cost
	}
	// capCpu/capMem intentionally get REBOUND to the last container's cap-
	// status dict inside the workload loop below
	var capCpuOut any = capCpuTotal
	var capMemOut any = capMemTotal

	// usage: "ns/pod" -> container -> (cpu, mem)
	usage := map[string]map[string][2]float64{}
	for _, mv := range items(metrics) {
		m := obj(mv)
		md := getObj(m, "metadata")
		podKey := getStr(md, "namespace") + "/" + getStr(md, "name")
		for _, cv := range getList(m, "containers") {
			c := obj(cv)
			u := getObj(c, "usage")
			if usage[podKey] == nil {
				usage[podKey] = map[string][2]float64{}
			}
			usage[podKey][getStr(c, "name")] = [2]float64{ParseCPU(u.GetD("cpu", nil)), ParseMem(u.GetD("memory", nil))}
		}
	}

	signals := e.promSignals(ctx)
	policies := e.loadPolicies(ctx)

	rolloutStrategy := map[string]string{}
	ctrlAnn := map[string]*pyjson.Obj{}
	for _, src := range []struct{ api, kind, fld string }{
		{"/apis/apps/v1/deployments", "Deployment", "strategy"},
		{"/apis/apps/v1/statefulsets", "StatefulSet", "updateStrategy"},
		{"/apis/apps/v1/daemonsets", "DaemonSet", "updateStrategy"},
	} {
		resp, err := e.Kube.GetJSON(ctx, src.api)
		if err != nil {
			break
		}
		for _, ov := range items(resp) {
			o := obj(ov)
			m := getObj(o, "metadata")
			t := getStr(getObj(getObj(o, "spec"), src.fld), "type")
			k := wlkey(getStr(m, "namespace"), src.kind, getStr(m, "name"))
			rolloutStrategy[k] = t
			ctrlAnn[k] = getObj(m, "annotations")
		}
	}

	// ---- group pods by top owner ----
	groups := map[string]*group{}
	var groupOrder []string
	nodeLbls := map[string]*pyjson.Obj{}
	nodeBuckets := map[string]string{} // capacity-derived node-size buckets
	for _, nv := range nodeItems {
		n := obj(nv)
		nn := getStr(getObj(n, "metadata"), "name")
		nodeLbls[nn] = getObj(getObj(n, "metadata"), "labels")
		nodeBuckets[nn] = nodeCapacityBucket(n)
	}

	podItems := items(pods)
	e.mu.Lock() // guards history / originReq / automation sets during the pass
	for _, pv := range podItems {
		p := obj(pv)
		md := getObj(p, "metadata")
		ns, kind, name := topOwner(p, rsIndex)
		key := wlkey(ns, kind, name)
		g, ok := groups[key]
		if !ok {
			g = newGroup()
			groups[key] = g
			groupOrder = append(groupOrder, key)
		}
		g.ns, g.kind, g.name = ns, kind, name
		podAnn := getObj(md, "annotations")
		podLbl := getObj(md, "labels")
		if ann := getStr(podAnn, "coolscaler.sh/policy"); ann != "" {
			g.policyAnn = ann
		}
		g.labels.Update(podLbl)
		g.annotations.Update(podAnn)
		podname := getStr(md, "name")
		g.pods[ns+"/"+podname] = true
		g.podnames[podname] = true
		for _, r := range unevictableReasons(p, pdbIndex) {
			g.unevictable[r] = true
		}
		spec := getObj(p, "spec")
		for _, k := range getObj(spec, "nodeSelector").Keys() {
			g.nodeSelKeys[k] = true
		}
		for _, tv := range getList(spec, "tolerations") {
			if tk := getStr(obj(tv), "key"); tk != "" {
				g.tolKeys[tk] = true
			}
		}
		if pc := getStr(spec, "priorityClassName"); pc != "" {
			g.priorityClass = pc
		}
		node := getStr(spec, "nodeName")
		if node != "" {
			if b, ok := nodeBuckets[node]; ok {
				g.nodeSizes[b] = true
			}
		}
		status := getObj(p, "status")
		if getStr(status, "reason") == "Evicted" {
			msg := strings.ToLower(getStr(status, "message"))
			if strings.Contains(msg, "ephemeral") || strings.Contains(msg, "disk") || strings.Contains(msg, "storage") {
				g.sig.diskEvict++
			} else if strings.Contains(msg, "memory") || strings.Contains(msg, "oom") {
				g.sig.oomNode++
			}
		}
		for _, cv := range getList(spec, "containers") {
			c := obj(cv)
			res := getObj(c, "resources")
			req := getObj(res, "requests")
			if img := getStr(c, "image"); img != "" {
				g.images[img] = true
			}
			if truthy(getObj(c, "securityContext").GetD("privileged", nil)) {
				g.privileged = true
			}
			for _, ev := range getList(c, "env") {
				if en := getStr(obj(ev), "name"); en != "" {
					// literal value only; the key presence still enables envKeys
					// matching either way.
					g.env[en] = getStr(obj(ev), "value")
				}
			}
			lim := getObj(res, "limits")
			isJava, xmx := javaDetect(c)
			cname := getStr(c, "name")
			ci, ok := g.containers[cname]
			if !ok {
				ci = &cinfo{
					reqCpu: ParseCPU(req.GetD("cpu", nil)), reqMem: ParseMem(req.GetD("memory", nil)),
					reqEph: ParseMem(req.GetD("ephemeral-storage", nil)),
					reqGpu: gpuReq(req),
					limCpu: ParseCPU(lim.GetD("cpu", nil)), limMem: ParseMem(lim.GetD("memory", nil)),
					limEph: ParseMem(lim.GetD("ephemeral-storage", nil)),
				}
				g.containers[cname] = ci
				g.containerKeys = append(g.containerKeys, cname)
			}
			if isJava {
				ci.java = true
				if xmx > ci.xmx {
					ci.xmx = xmx
				}
			}
		}
		for _, cv := range getList(spec, "initContainers") {
			c := obj(cv)
			req := getObj(getObj(c, "resources"), "requests")
			cname := getStr(c, "name")
			if _, ok := g.initContainers[cname]; !ok {
				g.initContainers[cname] = &iinfo{
					reqCpu: ParseCPU(req.GetD("cpu", nil)), reqMem: ParseMem(req.GetD("memory", nil)),
				}
				g.initKeys = append(g.initKeys, cname)
			}
		}
		// Pod-status signals: OOMKills, restarts, crashloop.
		var pRestarts, pOom int64
		pCrashloop, pLiveness := false, false
		for _, csv := range getList(status, "containerStatuses") {
			cs := obj(csv)
			rc := i64(cs.GetD("restartCount", int64(0)))
			pRestarts += rc
			last := getObj(obj(cs.GetD("lastState", nil)), "terminated")
			if getStr(last, "reason") == "OOMKilled" {
				pOom++
			}
			wr := getObj(obj(cs.GetD("state", nil)), "waiting")
			if getStr(wr, "reason") == "CrashLoopBackOff" {
				pCrashloop = true
				if rc > 5 {
					pLiveness = true
				}
			}
			ck := pcKey{ns, podname, getStr(cs, "name")}
			if thr := signals["throttle"][ck]; thr > g.sig.throttle {
				g.sig.throttle = thr
			}
			if pcpu := signals["psiCpu"][ck]; pcpu > g.sig.psiCpu {
				g.sig.psiCpu = pcpu
			}
			if pmem := signals["psiMem"][ck]; pmem > g.sig.psiMem {
				g.sig.psiMem = pmem
			}
		}
		g.sig.restarts += pRestarts
		g.sig.oom += pOom
		if pCrashloop {
			g.sig.crashloop++
		}
		if pLiveness {
			g.sig.liveness++
		}
		// per-pod request (spec) + usage (metrics.k8s.io) for the Pods tab.
		var preqC, preqM float64
		for _, cv := range getList(spec, "containers") {
			rq := getObj(getObj(obj(cv), "resources"), "requests")
			preqC += ParseCPU(rq.GetD("cpu", nil))
			preqM += ParseMem(rq.GetD("memory", nil))
		}
		pu := usage[ns+"/"+podname]
		var useCpuVal, useMemVal any
		if len(pu) > 0 {
			var uc, um float64
			for _, v := range pu {
				uc += v[0]
				um += v[1]
			}
			useCpuVal, useMemVal = uc, um
		} else {
			useCpuVal, useMemVal = nil, nil // UI shows ??? until metrics-server has a sample
		}
		startTime := getStr(status, "startTime")
		if startTime == "" {
			startTime = getStr(md, "creationTimestamp")
		}
		// Preserved as-is.
		ready := true
		for _, csv := range getList(status, "containerStatuses") {
			if !truthy(obj(csv).GetD("ready", nil)) {
				ready = false
				break
			}
		}
		g.podInfo = append(g.podInfo, pyjson.NewObj().
			Set("name", podname).
			Set("node", node).
			Set("restarts", pRestarts).
			Set("oom", pOom).
			Set("crashloop", pCrashloop).
			Set("reqCpu", preqC).
			Set("reqMem", preqM).
			Set("useCpu", useCpuVal).
			Set("useMem", useMemVal).
			Set("phase", getStr(status, "phase")).
			Set("qos", getStr(status, "qosClass")).
			Set("startTime", startTime).
			Set("readySeconds", podReadySeconds(p)).
			Set("ready", ready))
		for cname, uv := range pu {
			lv, ok := g.live[cname]
			if !ok {
				lv = &[2]float64{}
				g.live[cname] = lv
			}
			lv[0] += uv[0]
			lv[1] += uv[1]
		}
	}

	// Attribute catalogs for the Policy-Rules + COG editors' autocomplete
	attrLabels, attrAnn, attrEnvs := map[string]map[string]bool{}, map[string]map[string]bool{}, map[string]map[string]bool{}
	attrImages, attrNamespaces := map[string]bool{}, map[string]bool{}
	ensureSet := func(m map[string]map[string]bool, k string) map[string]bool {
		s, ok := m[k]
		if !ok {
			s = map[string]bool{}
			m[k] = s
		}
		return s
	}
	for _, pv := range podItems {
		p := obj(pv)
		md := getObj(p, "metadata")
		attrNamespaces[getStr(md, "namespace")] = true
		for _, k := range getObj(md, "labels").Keys() {
			v := str(getObj(md, "labels").GetD(k, nil))
			s := ensureSet(attrLabels, k)
			if len(s) < 50 && len([]rune(v)) <= 200 {
				s[v] = true
			}
		}
		for _, k := range getObj(md, "annotations").Keys() {
			v := str(getObj(md, "annotations").GetD(k, nil))
			s := ensureSet(attrAnn, k)
			if len(s) < 50 && len([]rune(v)) <= 200 {
				s[v] = true
			}
		}
		for _, cv := range getList(getObj(p, "spec"), "containers") {
			c := obj(cv)
			if img := getStr(c, "image"); img != "" {
				attrImages[img] = true
			}
			for _, ev := range getList(c, "env") {
				en := obj(ev)
				nm := getStr(en, "name")
				if nm == "" {
					continue
				}
				s := ensureSet(attrEnvs, nm)
				if len(s) < 50 {
					v := str(en.GetD("value", ""))
					r := []rune(v)
					if len(r) > 200 {
						v = string(r[:200])
					}
					s[v] = true
				}
			}
		}
	}
	attrMap := func(m map[string]map[string]bool) *pyjson.Obj {
		out := pyjson.NewObj()
		keys := make([]string, 0, len(m))
		for k := range m {
			keys = append(keys, k)
		}
		sortStrings(keys)
		for _, k := range keys {
			out.Set(k, strList(sortedKeys(m[k])))
		}
		return out
	}
	ownersSet, ownerIdentSet := map[string]bool{}, map[string]bool{}
	for _, g := range groups {
		if g.kind != "" {
			ownersSet[g.kind] = true
		}
		if g.name != "" {
			ownerIdentSet[g.name] = true
		}
	}
	nsNames := []string{}
	for ns := range attrNamespaces {
		if ns != "" {
			nsNames = append(nsNames, ns)
		}
	}
	sortStrings(nsNames)
	attrCatalog := pyjson.NewObj().
		Set("labels", attrMap(attrLabels)).
		Set("annotations", attrMap(attrAnn)).
		Set("envs", attrMap(attrEnvs)).
		Set("images", strList(sortedKeys(attrImages))).
		Set("namespaces", strList(nsNames)).
		Set("owners", strList(sortedKeys(ownersSet))).
		Set("ownerIdentifier", strList(sortedKeys(ownerIdentSet)))

	// ---- score each workload ----
	var workloads []*wlRow
	byKey := map[string]*wlRow{}
	nsSavingsOrder := []string{}
	nsSavings := map[string]float64{}
	var totReqCpu, totReqMem, totUseCpu, totUseMem, totRecCpu, totRecMem float64
	var sizReqCpu, sizReqMem, sizUseCpu, sizUseMem float64
	var sizRecCpu, sizRecMem float64
	var sizReclaimCpu, sizReclaimMem float64
	var sizOrigCpu, sizOrigMem float64
	var sizReqEph, sizUseEph, sizRecEph float64
	totalReplicas := 0
	var hpaReqCpu float64
	// Automated-resources-progress accumulators:
	// request/recommendation/origin sums over AUTOMATED sizable workloads and
	// over HPA-managed (replicas-optimization) workloads.
	var autoReqCpu, autoReqMem, autoRecCpu, autoRecMem, autoOrigCpu, autoOrigMem float64
	var hpaReqMem, hpaRecCpu, hpaRecMem, hpaOrigCpu, hpaOrigMem float64
	automatedCount := 0
	var wlThrottling, wlOom, wlUnder, wlBoot, wlBurst, wlInitopt int
	skipKinds := map[string]bool{"Pod": true, "Job": true, "Node": true}

	rules := e.policyRules
	globalAutoOn := truthy(e.globalAuto.GetD("automateAllNamespaces", nil)) ||
		truthy(getObj(e.globalAuto, "automate").GetD("rightsize", false)) ||
		opsRightsize // cluster-ops CM rightsize-optimize acts as cluster-wide automation

	// Workload-operations matchers (GLOBAL_AUTO.workloadAutomation).
	wlOps := getObj(e.globalAuto, "workloadAutomation")
	wlOpsExcludeL := parseKVMatchers(getList(wlOps, "excludeLabels"))
	wlOpsIncludeL := parseKVMatchers(getList(wlOps, "includeLabels"))
	wlOpsExcludeA := parseKVMatchers(getList(wlOps, "excludeAnnotations"))
	wlOpsIncludeA := parseKVMatchers(getList(wlOps, "includeAnnotations"))
	defaultReplicasAuto := map[string]bool{}

	for _, key := range groupOrder {
		g := groups[key]
		replicas := len(g.pods)
		if replicas < 1 {
			replicas = 1
		}
		if len(g.containers) == 0 {
			continue
		}
		// Workload annotation controls (controller annotations first, pod
		// annotations as fallback) + Namespace-object annotations.
		wlc := parseWorkloadControls([]*pyjson.Obj{ctrlAnn[key], g.annotations}, nsAnnIdx[g.ns])
		if resetRequested && !wlc.skipReset {
			// one-time cluster reset: clear UI-recorded automation + policy
			// state so annotations/defaults take over (skip list honored).
			if e.automated[key] || e.excluded[key] || e.automationSource[key] != "" {
				delete(e.automated, key)
				delete(e.excluded, key)
				delete(e.automationSource, key)
				resetN++
			}
			if g.policyAnn != "" {
				resetPolicyTargets = append(resetPolicyTargets, [3]string{g.ns, g.kind, g.name})
				g.policyAnn = ""
			}
		}
		// Policy precedence: force annotation > UI attachment (pod annotation)
		// > detection rules > default annotations > cluster default policy.
		annPolicy := wlc.forcePolicy
		if annPolicy == "" {
			annPolicy = g.policyAnn
		}
		polName, polSpec := e.resolvePolicy(policies, g.ns, annPolicy)
		var detectedTag any
		if annPolicy == "" {
			rulePol, ruleTag := e.matchPolicyRules(rules, g.labels, g.annotations, g.env)
			if rulePol != "" {
				rspec, ok := policies[polKey{g.ns, rulePol}]
				if !ok {
					rspec, ok = policies[polKey{cfg.Namespace, rulePol}]
				}
				if ok {
					polName, polSpec, detectedTag = rulePol, rspec, ruleTag
				}
			} else {
				dp := wlc.defaultPolicy
				if dp == "" { // AutomatedNamespace defaultRightsizePolicy
					dp = str(autoNs[g.ns].policy)
				}
				if dp == "" {
					dp = opsDefaultPolicy
				}
				if dp != "" {
					dspec, ok := policies[polKey{g.ns, dp}]
					if !ok {
						dspec, ok = policies[polKey{cfg.Namespace, dp}]
					}
					if ok {
						polName, polSpec = dp, dspec
					}
				}
			}
		}
		var polActive any
		weeklySplit, weeklyWeekend := false, false
		if getStr(polSpec, "type") == "Schedule" {
			if sched, ok := e.scheduleByName[polName]; ok {
				active := scheduleActivePolicy(sched, time.Now())
				polActive = active
				actSpec, ok := policies[polKey{g.ns, active}]
				if !ok {
					actSpec, ok = policies[polKey{cfg.Namespace, active}]
				}
				if ok {
					polSpec = actSpec
				}
				if scheduleCurrentPeriods(sched) {
					weeklySplit = true
					weeklyWeekend = isWeekendUTC(time.Now())
				}
			}
		}
		// Override this workload's samples with the current-period (weekday /
		// weekend) day-filtered percentile. Gated on a currentPeriods schedule →
		// a no-op for every other workload; falls back to the full-window
		// samples when the current period has no data yet.
		if weeklySplit {
			if fc, fm := e.promDayFiltered(ctx, g.ns, g.name, weeklyWeekend); len(fc)+len(fm) > 0 {
				for k, v := range fc {
					promCPU[k] = v
				}
				for k, v := range fm {
					promMem[k] = v
				}
			}
		}
		kb := e.policyKnobs(polSpec)
		// Self-protection floors: our own components honor the
		// same minAllowed the rec CR advertises in spec.overridePolicies.
		if g.ns == cfg.Namespace {
			if ov, okOv := selfOverrides[g.name]; okOv {
				if ov.cpuMin != "" {
					kb.cpuMin = math.Max(kb.cpuMin, ParseCPU(ov.cpuMin))
				}
				if ov.memMin != "" {
					kb.memMin = math.Max(kb.memMin, ParseMem(ov.memMin))
				}
			}
		}

		gJvm := map[string]float64{}
		for pn := range g.podnames {
			if d := promJvmData[ppKey{g.ns, pn}]; d != nil {
				for kf, v := range d {
					if v > gJvm[kf] {
						gJvm[kf] = v
					} else if !hasKey(gJvm, kf) {
						gJvm[kf] = 0.0
					}
				}
			}
		}

		var rowContainers []any
		var curCpu, curMem, recCpu, recMem float64
		var curEph, useEphTot, recEphTot float64
		hist := e.history[key]
		if hist == nil {
			hist = map[string][]histPoint{}
			e.history[key] = hist
		}
		for _, cname := range g.containerKeys {
			ci := g.containers[cname]
			var liveCpuPer, liveMemPer float64
			if lv := g.live[cname]; lv != nil {
				liveCpuPer, liveMemPer = lv[0]/float64(replicas), lv[1]/float64(replicas)
			}
			h := append(hist[cname], histPoint{liveCpuPer, liveMemPer})
			if len(h) > cfg.HistoryPoints {
				h = h[len(h)-cfg.HistoryPoints:]
			}
			hist[cname] = h
			// Prefer Prometheus history (per-replica = busiest pod), else in-memory.
			var promC, promM []float64
			for pn := range g.podnames {
				if v, ok := promCPU[pcKey{g.ns, pn, cname}]; ok {
					promC = append(promC, v)
				}
				if v, ok := promMem[pcKey{g.ns, pn, cname}]; ok {
					promM = append(promM, v)
				}
			}
			cpuSamples := promC
			if len(cpuSamples) == 0 {
				for _, hp := range h {
					if hp.cpu > 0 {
						cpuSamples = append(cpuSamples, hp.cpu)
					}
				}
			}
			memSamples := promM
			if len(memSamples) == 0 {
				for _, hp := range h {
					if hp.mem > 0 {
						memSamples = append(memSamples, hp.mem)
					}
				}
			}
			peakCpu, cThrottle := 0.0, 0.0
			for pn := range g.podnames {
				if v := signals["maxcpu"][pcKey{g.ns, pn, cname}]; v > peakCpu {
					peakCpu = v
				}
				if v := signals["throttle"][pcKey{g.ns, pn, cname}]; v > cThrottle {
					cThrottle = v
				}
			}
			bootCpu := 0.0
			cpuHealed := false
			cpuHealReason := ""
			var javaXmx int64
			excludedC := cfg.ExcludeContainers[cname] // Goldilocks --exclude-containers (sidecars)
			var rCpu, rMem float64
			var capCpu, capMem *pyjson.Obj
			var lbCpu, ubCpu, lbMem, ubMem float64
			if excludedC {
				// injected sidecars are not right-sized; keep current requests.
				// (Never patch them into the owner template either — HTTP 422.)
				rCpu, rMem = ci.reqCpu, ci.reqMem
				capCpu = pyjson.NewObj().Set("isCapped", false)
				capMem = capCpu
				lbCpu, ubCpu = rCpu, rCpu
				lbMem, ubMem = rMem, rMem
			} else {
				if len(promC) > 0 {
					rCpu = maxFloat(promC) * kb.cpuHead
				} else if len(cpuSamples) > 0 {
					rCpu = Percentile(cpuSamples, kb.cpuPct) * kb.cpuHead
				} else {
					rCpu = ci.reqCpu
				}
				if len(promM) > 0 {
					rMem = maxFloat(promM) * kb.memHead
				} else if len(memSamples) > 0 {
					rMem = Percentile(memSamples, kb.memPct) * kb.memHead
				} else {
					rMem = ci.reqMem
				}
				// jpcRealUsage: the java-memory-aware policy's
				// recommendation.realUsageCalculation toggle — off means the java
				// path falls back to plain container memory.
				if ci.java && kb.jvmRealUsage && jpcRealUsage {
					if jm, jx, ok := e.javaMemFromJVM(gJvm, kb.memHead); ok {
						rMem, javaXmx = jm, jx
					}
				}
				rCpu, capCpu = capValue(rCpu, kb.cpuMin, kb.cpuMax, FmtCPU)
				rMem, capMem = capValue(rMem, kb.memMin, kb.memMax, FmtMem)
				// Stress = genuine CFS throttling (>25%) or sustained usage
				// at/above the recommendation with a peak ≥1.2×; burst = a sudden
				// spike ≥1.25×. Only reacts when the policy enables healing/burst
				// — a no-op otherwise.
				if !excludedC && rCpu > 0 {
					// Absolute floors keep trivially-small workloads from
					// constantly "healing" on relative noise; genuine CFS
					// throttling (>25%) is always meaningful.
					stress := kb.autoHeal && (cThrottle > 0.25 ||
						(liveCpuPer >= rCpu && peakCpu >= rCpu*1.5 && liveCpuPer >= 0.03))
					burstNow := kb.burst && liveCpuPer > rCpu*1.5 && liveCpuPer >= 0.05
					if mult, reason := e.cpuHealBoost(
						wlkey(g.ns, g.kind, g.name)+"/"+cname, time.Now().Unix(),
						stress, burstNow, 1.25, 1.20, 3600, 1200); mult > 1.0 {
						boosted := rCpu * mult
						if kb.cpuMax > 0 {
							boosted = math.Min(boosted, kb.cpuMax)
						}
						if boosted > rCpu {
							rCpu = boosted
							cpuHealed, cpuHealReason = true, reason
							g.sig.heal = true
							g.sig.healReason = reason
							if reason == "BurstReaction" {
								g.sig.burst = true
							}
						}
					}
				}
				// Goldilocks Burstable band (VPA-style lower/upper bounds).
				if len(cpuSamples) > 0 {
					lbCpu = math.Max(kb.cpuMin, Percentile(cpuSamples, cfg.LowerboundPct))
					ubCpu = math.Max(rCpu, Percentile(cpuSamples, cfg.UpperboundPct)*cfg.UpperboundMargn)
				} else {
					lbCpu, ubCpu = rCpu, rCpu*1.5
				}
				if len(memSamples) > 0 {
					lbMem = math.Max(kb.memMin, Percentile(memSamples, cfg.LowerboundPct))
					ubMem = math.Max(rMem, Percentile(memSamples, cfg.UpperboundPct)*cfg.UpperboundMargn)
				} else {
					lbMem, ubMem = rMem, rMem*1.5
				}
				// Boot-time optimization: startup spike well above steady state.
				if kb.bootTime && peakCpu > math.Max(rCpu, kb.cpuMin)*2.0 {
					bootCpu = math.Min(kb.cpuMax, peakCpu*1.10)
					g.sig.boot = true
				}
				// Burst reaction: recent usage consistently above the recommendation.
				if kb.burst && liveCpuPer > rCpu*1.10 && liveCpuPer > kb.cpuMin {
					g.sig.burst = true
				}
			}
			// Ephemeral-storage (disk) recommendation.
			reqEph := ci.reqEph
			var promE []float64
			for pn := range g.podnames {
				if v, ok := promEph[pcKey{g.ns, pn, cname}]; ok {
					promE = append(promE, v)
				}
			}
			useEph := 0.0
			if len(promE) > 0 {
				useEph = maxFloat(promE)
			} else if reqEph != 0 {
				useEph = reqEph * 0.35
			}
			var recEph float64
			if excludedC || !kb.ephOpt || (useEph <= 0 && reqEph <= 0) {
				recEph = reqEph
			} else {
				recEph = math.Max(useEph*kb.ephHead, cfg.EphFloorBytes)
				// allowEphemeralStorageReduction=false -> never below current.
				if !kb.ephReduce && reqEph != 0 {
					recEph = math.Max(recEph, reqEph)
				}
			}
			// Recommended LIMITS via the policy's per-resource limit strategy +
			// dynamic caps. keepOriginal (the default) → unchanged; excluded
			// containers always keep their original limits.
			limCpuOut, limMemOut, limEphOut := ci.limCpu, ci.limMem, ci.limEph
			if !excludedC {
				limCpuOut = computeLimit(kb.limCpu, ci.limCpu, ci.reqCpu, rCpu)
				limMemOut = computeLimit(kb.limMem, ci.limMem, ci.reqMem, rMem)
				limEphOut = computeLimit(kb.limEph, ci.limEph, reqEph, recEph)
			}
			rowContainers = append(rowContainers, pyjson.NewObj().
				Set("name", cname).
				Set("reqCpu", ci.reqCpu).
				Set("reqMem", ci.reqMem).
				Set("limCpu", limCpuOut).
				Set("limMem", limMemOut).
				Set("limEph", limEphOut).
				Set("useCpu", liveCpuPer).
				Set("useMem", liveMemPer).
				Set("recCpu", rCpu).
				Set("recMem", rMem).
				Set("samples", len(h)).
				Set("reqEph", reqEph).
				Set("useEph", useEph).
				Set("recEph", recEph).
				Set("excluded", excludedC).
				Set("bootCpu", bootCpu).
				Set("cpuHealed", cpuHealed).
				Set("cpuHealReason", cpuHealReason).
				Set("javaXmx", javaXmx).
				Set("throttlePct", pyjson.Round(cThrottle*100, 1)).
				Set("peakCpu", peakCpu).
				Set("qos", pyjson.NewObj().
					Set("guaranteed", pyjson.NewObj().
						Set("cpuReq", rCpu).Set("cpuLim", rCpu).
						Set("memReq", rMem).Set("memLim", rMem)).
					Set("burstable", pyjson.NewObj().
						Set("cpuReq", lbCpu).Set("cpuLim", ubCpu).
						Set("memReq", lbMem).Set("memLim", ubMem))).
				Set("capStatuses", pyjson.NewObj().Set("cpu", capCpu).Set("memory", capMem)))
			capCpuOut, capMemOut = capCpu, capMem
			curCpu += ci.reqCpu
			curMem += ci.reqMem
			recCpu += rCpu
			recMem += rMem
			curEph += reqEph
			useEphTot += useEph
			recEphTot += recEph
		}

		kind := g.kind
		// Init-container optimization.
		var initList []any
		initOverCpu, initOverMem := 0.0, 0.0
		if kb.initOpt && len(g.initContainers) > 0 {
			maxInitCpu, maxInitMem := math.Inf(-1), math.Inf(-1)
			for _, ii := range g.initContainers {
				maxInitCpu = math.Max(maxInitCpu, ii.reqCpu)
				maxInitMem = math.Max(maxInitMem, ii.reqMem)
			}
			for _, iname := range g.initKeys {
				ii := g.initContainers[iname]
				recICpu, recIMem := ii.reqCpu, ii.reqMem
				if ii.reqCpu != 0 {
					recICpu = math.Min(ii.reqCpu, recCpu)
				}
				if ii.reqMem != 0 {
					recIMem = math.Min(ii.reqMem, recMem)
				}
				initList = append(initList, pyjson.NewObj().
					Set("name", iname).
					Set("reqCpu", ii.reqCpu).Set("reqMem", ii.reqMem).
					Set("recCpu", recICpu).Set("recMem", recIMem))
			}
			initOverCpu = math.Max(0.0, maxInitCpu-recCpu)
			initOverMem = math.Max(0.0, maxInitMem-recMem)
			if initOverCpu > 1e-6 || initOverMem > 1e-6 {
				wlInitopt++
			}
		}
		if initList == nil {
			initList = []any{}
		}

		// HPA / KEDA conversions (preserve the horizontal scale point).
		hp := hpaMap[key]
		if hp == nil {
			hp = newHpaEntry()
		}
		hpaMetrics := sortedKeys(hp.metrics)
		hpaManaged := len(hpaMetrics) > 0
		hpaConversions := []any{}
		for _, t := range hp.triggers {
			util, okU := toFloatLoose(t.utilization)
			if !okU || util == 0 || t.utilization == nil {
				continue
			}
			orig, newV := curCpu, recCpu
			if t.resource != "cpu" {
				orig, newV = curMem, recMem
			}
			avgval := (util / 100.0) * orig
			fmtFn := FmtCPU
			if t.resource != "cpu" {
				fmtFn = FmtMem
			}
			hpaConversions = append(hpaConversions, pyjson.NewObj().
				Set("source", t.source).
				Set("resource", t.resource).
				Set("fromUtilization", t.utilization).
				Set("averageValue", fmtFn(avgval)).
				Set("origRequest", fmtFn(orig)).
				Set("newRequest", fmtFn(newV)))
		}

		isSizable := !skipKinds[kind]
		curCost := e.monthlyCost(curCpu, curMem) * float64(replicas)
		recCost := e.monthlyCost(recCpu, recMem) * float64(replicas)
		initSavings := e.monthlyCost(initOverCpu, initOverMem) * float64(replicas)
		savings := 0.0
		resizableSavings := 0.0 // reclaimable via a resize alone (excl. init overhead)
		if isSizable {
			savings = curCost - recCost + initSavings
			resizableSavings = curCost - recCost
		}
		nsAuto := autoNs[g.ns].optimize
		blocked := e.autoExcluded(g.ns, kind)
		// Action precedence (exclude > force > general > default):
		// (a) exclude-automation annotation (workload or ns) + the workload-
		// operations exclude matchers — force-excluded, un-automate;
		// (b) force-auto annotation — beats UI/General, loses to exclude;
		// custom-ns-label excludes sit below the annotations (docs), then
		// (c) General: UI state / AutomatedNamespace / cluster automation;
		// (d) Defaults: default-auto annotations + include matchers +
		// custom-ns-label includes — only while the workload is untouched.
		nsLbl := nsLblIdx[g.ns]
		annExcluded := wlc.exclude || wlc.nsExclude ||
			autoNs[g.ns].excludeAutomation || // AutomatedNamespace excludeAutomation
			anyKVMatch(wlOpsExcludeL, g.labels) ||
			anyKVMatch(wlOpsExcludeA, g.annotations, ctrlAnn[key])
		nsLabelExcluded := cnl.excludesNS(g.ns, nsLbl)
		untouched := !e.automated[key] && !e.excluded[key] && e.automationSource[key] == ""
		defaultOn := wlc.defaultAuto ||
			anyKVMatch(wlOpsIncludeL, g.labels) ||
			anyKVMatch(wlOpsIncludeA, g.annotations, ctrlAnn[key]) ||
			cnl.defaultsNS(g.ns, nsLbl)
		annSource := ""
		var keyAutomated bool
		switch {
		case annExcluded:
			keyAutomated = false
			if e.automated[key] { // force-excluded: un-automate recorded state
				delete(e.automated, key)
				delete(e.automationSource, key)
			}
		case wlc.forceAuto != nil:
			keyAutomated = *wlc.forceAuto && !blocked
			annSource = "annotation-force"
		case nsLabelExcluded:
			keyAutomated = false
		default:
			keyAutomated = (e.automated[key] || nsAuto || globalAutoOn) && !e.excluded[key] && !blocked
			if !keyAutomated && untouched && defaultOn && !blocked {
				keyAutomated = true
				annSource = "annotation-default"
			}
		}
		if keyAutomated {
			automatedCount++
		}
		// Java + replicas automation defaults (only-if-untouched semantics).
		if wlc.defaultJavaAuto && !e.javaAutomated[key] && !e.javaUnautomated[key] {
			e.javaAutomated[key] = true
		}
		if wlc.defaultReplicasAuto {
			defaultReplicasAuto[key] = true
		}
		// Replicas / Pod-Scheduling GitOps policy+automation defaults (docs
		// "Workload Actions"): seed only when untouched by UI, so UI wins.
		if wlc.defaultReplicasPol != "" {
			if _, ok := e.replicasPolicyAssign[key]; !ok {
				e.replicasPolicyAssign[key] = wlc.defaultReplicasPol
			}
		}
		if wlc.defaultPodSchedAuto {
			if _, ok := e.schedulingAutomated[key]; !ok {
				e.schedulingAutomated[key] = true
			}
		}
		if wlc.defaultPodSchedPol != "" {
			if _, ok := e.schedulingPolAssign[key]; !ok {
				e.schedulingPolAssign[key] = wlc.defaultPodSchedPol
			}
		}
		// Downscaler GitOps schedule attachment (docs "GitOps Support for
		// Workload Schedule Attachment"): coolscaler.sh/default-downscaler-
		// {auto,schedule} seed the downscaler state as a default. Applied only
		// when the workload has no explicit UI state yet, so UI actions win.
		if wlc.defaultDownscalerSchedule != "" {
			if _, ok := e.downscaleAssign[key]; !ok {
				e.downscaleAssign[key] = wlc.defaultDownscalerSchedule
			}
		}
		if wlc.defaultDownscalerAuto {
			if _, ok := e.downscaleAutomated[key]; !ok {
				e.downscaleAutomated[key] = true
			}
		}
		var liveCpuTotal, liveMemTotal float64
		for cname := range g.containers {
			if lv := g.live[cname]; lv != nil {
				liveCpuTotal += lv[0]
				liveMemTotal += lv[1]
			}
		}
		liveCpuTotal /= float64(replicas)
		liveMemTotal /= float64(replicas)

		// Replicas-Optimization history (HPA desired-by-CPU).
		if hpaManaged {
			cpuTarget, okT := toFloatLoose(hp.cpuTarget)
			var desired int64
			if okT && cpuTarget != 0 && curCpu > 0 {
				utilNow := (liveCpuTotal / curCpu) * 100.0
				desired = int64(math.Ceil(float64(replicas) * utilNow / cpuTarget))
				if desired < 1 {
					desired = 1
				}
			} else {
				desired = int64(replicas)
			}
			if mx, ok := toFloatLoose(hp.maxReplicas); ok && mx != 0 && float64(desired) > mx {
				desired = int64(mx)
			}
			rh := append(e.replicaHistory[key], replicaPoint{int64(replicas), desired})
			if len(rh) > cfg.HistoryPoints {
				rh = rh[len(rh)-cfg.HistoryPoints:]
			}
			e.replicaHistory[key] = rh
		}

		// Health + event timeline.
		sig := &g.sig
		under := isSizable && recCpu > curCpu*1.02
		bootTotal := 0.0
		for _, cv := range rowContainers {
			bootTotal += f64d(obj(cv).GetD("bootCpu", 0.0), 0)
		}
		if sig.throttle > 0.05 {
			wlThrottling++
		}
		if sig.oom > 0 {
			wlOom++
		}
		if under {
			wlUnder++
		}
		if sig.boot || bootTotal > 0 {
			wlBoot++
		}
		if sig.burst {
			wlBurst++
		}
		chronicRestarts := sig.restarts > 20
		var health string
		switch {
		case sig.oom > 0 || sig.crashloop > 0 || chronicRestarts || sig.psiMem > 0.05:
			health = "critical"
		case sig.throttle > 0.25 || sig.liveness > 0 || sig.psiCpu > 0.10:
			health = "throttled"
		case under || sig.burst:
			health = "underprovisioned"
		default:
			health = "healthy"
		}
		events := []any{}
		addEvent := func(typ, level, message string) {
			events = append(events, pyjson.NewObj().
				Set("type", typ).Set("level", level).Set("message", message))
		}
		if keyAutomated {
			addEvent("Automated", "info", "Continuously right-sized by CoolScaler")
		}
		if sig.oom > 0 {
			addEvent("Out-of-Memory", "critical",
				fmt.Sprintf("%d OOMKilled event(s) (container limit); auto-healing raises the memory request", sig.oom))
		}
		if sig.oomNode > 0 {
			addEvent("Node memory pressure", "critical",
				fmt.Sprintf("%d pod(s) evicted under node memory pressure (not a container-limit OOM) — node is overcommitted", sig.oomNode))
		}
		if sig.crashloop > 0 {
			addEvent("CrashLoopBackOff", "critical",
				fmt.Sprintf("%d pod(s) crash-looping (%d restarts)", sig.crashloop, sig.restarts))
		} else if chronicRestarts {
			addEvent("Frequent restarts", "critical",
				fmt.Sprintf("%d cumulative restarts — likely OOM / probe pressure; auto-healing would raise resources", sig.restarts))
		}
		if sig.throttle > 0.05 {
			addEvent("CPU throttling", "warn",
				fmt.Sprintf("%.0f%% of CFS periods throttled; auto-healing raises the CPU request", sig.throttle*100))
		}
		if sig.liveness > 0 {
			addEvent("Restart/probe pressure", "warn",
				"heuristic from CrashLoopBackOff + high restart count (no liveness-probe metric in KSM)")
		}
		if sig.psiCpu > 0.10 {
			addEvent("CPU pressure (PSI)", "warn",
				fmt.Sprintf("%.0f%% of time tasks stalled waiting for CPU (Linux PSI) — workload is CPU-starved", sig.psiCpu*100))
		}
		if sig.psiMem > 0.05 {
			addEvent("Memory pressure (PSI)", "critical",
				fmt.Sprintf("%.0f%% of time tasks stalled on memory (Linux PSI) — reclaim/thrash; raise the memory request", sig.psiMem*100))
		}
		if sig.burst {
			addEvent("Burst reaction", "info",
				"usage spiked above the recommendation; request temporarily raised")
		}
		if sig.boot || bootTotal > 0 {
			addEvent("Boot-time optimization", "info",
				fmt.Sprintf("startup CPU spike detected; CPU raised for the boot window (%s)", FmtCPU(bootTotal)))
		}
		if sig.diskEvict > 0 {
			addEvent("Disk eviction", "critical",
				fmt.Sprintf("%d ephemeral-storage eviction(s); auto-healing raises the disk request", sig.diskEvict))
		}
		if under {
			addEvent("Under-provisioned", "warn",
				"recommendation raises requests above current (performance fix)")
		}
		for _, ev := range events {
			obj(ev).Set("ageMin", 0).Set("active", true)
		}

		totReqCpu += curCpu * float64(replicas)
		totReqMem += curMem * float64(replicas)
		totUseCpu += liveCpuTotal * float64(replicas)
		totUseMem += liveMemTotal * float64(replicas)
		if isSizable {
			totRecCpu += recCpu * float64(replicas)
			totRecMem += recMem * float64(replicas)
			if _, ok := nsSavings[g.ns]; !ok {
				nsSavingsOrder = append(nsSavingsOrder, g.ns)
			}
			nsSavings[g.ns] += math.Max(savings, 0.0)
			sizReqCpu += curCpu * float64(replicas)
			sizReqMem += curMem * float64(replicas)
			sizUseCpu += liveCpuTotal * float64(replicas)
			sizUseMem += liveMemTotal * float64(replicas)
			sizRecCpu += recCpu * float64(replicas)
			sizRecMem += recMem * float64(replicas)
			sizReclaimCpu += math.Max(0.0, curCpu-recCpu) * float64(replicas)
			sizReclaimMem += math.Max(0.0, curMem-recMem) * float64(replicas)
			sizReqEph += curEph * float64(replicas)
			sizUseEph += useEphTot * float64(replicas)
			sizRecEph += recEphTot * float64(replicas)
			oc, om := curCpu, curMem
			if o := e.originReq[key]; o != nil {
				oc, om = o.cpu, o.mem
			}
			if keyAutomated {
				autoReqCpu += curCpu * float64(replicas)
				autoReqMem += curMem * float64(replicas)
				autoRecCpu += recCpu * float64(replicas)
				autoRecMem += recMem * float64(replicas)
				autoOrigCpu += oc * float64(replicas)
				autoOrigMem += om * float64(replicas)
			}
			if hpaManaged {
				hpaReqCpu += curCpu * float64(replicas)
				hpaReqMem += curMem * float64(replicas)
				hpaRecCpu += recCpu * float64(replicas)
				hpaRecMem += recMem * float64(replicas)
				hpaOrigCpu += oc * float64(replicas)
				hpaOrigMem += om * float64(replicas)
			}
		} else {
			totRecCpu += curCpu * float64(replicas)
			totRecMem += curMem * float64(replicas)
		}
		totalReplicas += replicas

		images := sortedKeys(g.images)
		isJava := false
		for img := range g.images {
			li := strings.ToLower(img)
			for _, j := range javaBlobHints {
				if strings.Contains(li, j) {
					isJava = true
					break
				}
			}
			if isJava {
				break
			}
		}
		// java-auto-policy=false (cluster-ops) stops auto-assigning the `java`
		// builtin policy to detected Java workloads.
		polSuggested := autodetectPolicy(g.ns, kind, g.name, isJava && javaAutoPolicy, replicas, images)
		isAgentic := false
		for img := range g.images {
			li := strings.ToLower(img)
			for _, a := range agenticImageHints {
				if strings.Contains(li, a) {
					isAgentic = true
					break
				}
			}
			if isAgentic {
				break
			}
		}
		if !isAgentic {
			ln := strings.ToLower(g.name)
			for _, a := range agenticNameHints {
				if strings.Contains(ln, a) {
					isAgentic = true
					break
				}
			}
		}
		excludedW := e.excluded[key] || annExcluded || nsLabelExcluded
		exclReason := ""
		switch {
		case e.excluded[key]:
			exclReason = "user-excluded"
		case annExcluded:
			exclReason = "annotation-excluded"
		case nsLabelExcluded:
			exclReason = "namespace-label-excluded"
		}
		var autoSource any
		if excludedW {
			autoSource = "excluded"
		} else if annSource != "" {
			autoSource = annSource // "annotation-force" / "annotation-default"
		} else if keyAutomated {
			if src, ok := e.automationSource[key]; ok && src != "" {
				autoSource = src
			} else if nsAuto {
				autoSource = "namespace"
			} else if globalAutoOn {
				autoSource = "cluster"
			} else {
				autoSource = "user"
			}
		} else {
			autoSource = nil
		}
		orig, ok := e.originReq[key]
		if !ok {
			orig = &origReq{cpu: curCpu, mem: curMem}
			e.originReq[key] = orig
		}
		origCpuPr := orig.cpu
		if origCpuPr == 0 {
			origCpuPr = curCpu
		}
		origMemPr := orig.mem
		if origMemPr == 0 {
			origMemPr = curMem
		}
		wlActiveSavings := 0.0
		if isSizable {
			wlActiveSavings = math.Max(0.0, e.monthlyCost(origCpuPr, origMemPr)-e.monthlyCost(curCpu, curMem)) * float64(replicas)
			sizOrigCpu += origCpuPr * float64(replicas)
			sizOrigMem += origMemPr * float64(replicas)
		}

		workloadErrors := []any{}
		if sig.oom > 0 {
			workloadErrors = append(workloadErrors, fmt.Sprintf("OOMKilled x%d", sig.oom))
		}
		if sig.crashloop > 0 {
			workloadErrors = append(workloadErrors, fmt.Sprintf("CrashLoopBackOff x%d", sig.crashloop))
		}

		var gpuTotal float64
		for _, ci := range g.containers {
			gpuTotal += ci.reqGpu
		}

		rowObj := pyjson.NewObj().
			Set("key", key).
			Set("namespace", g.ns).
			Set("kind", kind).
			Set("name", g.name).
			Set("replicas", replicas).
			Set("reqCpu", curCpu).
			Set("reqMem", curMem).
			Set("useCpu", liveCpuTotal).
			Set("useMem", liveMemTotal).
			Set("recCpu", recCpu).
			Set("recMem", recMem).
			Set("monthlyCost", curCost).
			Set("savings", savings).
			Set("resizableSavings", pyjson.Round(resizableSavings, 4)).
			Set("sizable", isSizable).
			Set("automated", keyAutomated).
			Set("excluded", excludedW).
			Set("automationSource", autoSource).
			Set("origCpu", origCpuPr).
			Set("origMem", origMemPr).
			Set("activeSavings", wlActiveSavings).
			Set("priorityClass", g.priorityClass).
			Set("rolloutStrategy", rolloutStrategy[key]).
			Set("hpaManaged", hpaManaged).
			Set("hpaMetrics", strList(hpaMetrics)).
			Set("hpaName", hp.hpa).
			Set("kedaName", hp.keda).
			Set("hpaMin", hp.minReplicas).
			Set("hpaMax", hp.maxReplicas).
			Set("cpuTarget", hp.cpuTarget).
			Set("hpaConversions", hpaConversions).
			Set("policyName", polName).
			Set("policySuggested", polSuggested).
			Set("agentic", isAgentic).
			Set("java", isJava).
			Set("usingSmartPolicy", polSuggested != "production" && polSuggested != "default").
			Set("smartPolicyName", polSuggested).
			Set("smartPolicyWorkloadType", detectWorkloadType(g.name, images, kind, g.ns, e.Cfg.Namespace)).
			Set("isPrivileged", g.privileged).
			Set("isSleeping", replicas == 0).
			Set("isReadyRecommendation", isSizable).
			Set("isEditable", isSizable && !excludedW).
			Set("unevictableReasons", strList(sortedKeys(g.unevictable))).
			Set("nodeSelectorKeys", strList(sortedKeys(g.nodeSelKeys))).
			Set("tolerationKeys", strList(sortedKeys(g.tolKeys))).
			Set("isAutomationExcludedReason", exclReason).
			Set("workloadErrors", workloadErrors).
			Set("policyActive", polActive).
			Set("detectedTag", detectedTag).
			Set("health", health).
			Set("signals", sig.toObj()).
			Set("events", events).
			Set("initOptimization", initList).
			Set("initSavings", initSavings).
			Set("initOverCpu", initOverCpu).
			Set("initOverMem", initOverMem).
			Set("bootCpu", bootTotal).
			Set("podInfo", g.podInfo).
			Set("labels", g.labels.Clone()).
			Set("annotations", g.annotations.Clone()).
			Set("gpuReq", gpuTotal).
			Set("spotEligible", len(g.unevictable) == 0).
			Set("reqEph", curEph).
			Set("useEph", useEphTot).
			Set("recEph", recEphTot).
			Set("nodeSizes", strList(sortedKeys(g.nodeSizes))).
			Set("images", strList(images)).
			Set("podNames", strList(sortedKeys(g.podnames))).
			Set("containers", rowContainers)
		row := &wlRow{
			obj: rowObj, key: key, namespace: g.ns, kind: kind, name: g.name,
			replicas: replicas, reqCpu: curCpu, recCpu: recCpu,
			monthlyCost: curCost, savings: savings, initSavings: initSavings,
			activeSavings: wlActiveSavings, sizable: isSizable, automated: keyAutomated,
			hpaManaged: hpaManaged, java: isJava, agentic: isAgentic,
		}
		workloads = append(workloads, row)
		byKey[key] = row
	}

	sort.SliceStable(workloads, func(i, j int) bool {
		return workloads[i].savings > workloads[j].savings
	})

	var totalSavings, totalCost, activeSavings, availableSavings float64
	for _, w := range workloads {
		totalSavings += math.Max(w.savings, 0.0)
		totalCost += w.monthlyCost
		if w.automated {
			activeSavings += math.Max(w.savings, 0.0)
		} else {
			availableSavings += math.Max(w.savings, 0.0)
		}
	}
	requestsCostMonthly := e.monthlyCost(sizReqCpu, sizReqMem)
	recommendedCostMonthly := e.monthlyCost(sizRecCpu, sizRecMem)
	sizableTotal, autoEligible, autoEligibleOn, optimized, increased := 0, 0, 0, 0, 0
	sizPods, automatedPods := 0, 0
	var realizedSavings, initSavingsSum, unrecognizedSavings float64
	rsActionable := 0
	replicasWorkloads, replicasAutomated, javaWorkloads, spotEligible, agenticCount := 0, 0, 0, 0, 0
	for _, w := range workloads {
		if w.sizable {
			sizableTotal++
			sizPods += w.replicas
			if !e.autoExcluded(w.namespace, w.kind) {
				autoEligible++
				if w.automated {
					autoEligibleOn++
				}
			}
			if w.savings <= cfg.MinApplySavings {
				optimized++
			}
			if w.recCpu > w.reqCpu*1.001 {
				increased++
			}
			spotEligible++
			if !w.automated && w.savings > cfg.MinApplySavings {
				rsActionable++
			}
		} else {
			unrecognizedSavings += math.Max(w.savings, 0.0)
		}
		if w.automated {
			automatedPods += w.replicas
		}
		if w.hpaManaged {
			replicasWorkloads++
			// UI state, or the cluster-ops replicas-optimize switch, or the
			// coolscaler.sh/default-replicas-auto annotation.
			if e.replicasAutomated[w.key] || opsReplicas || defaultReplicasAuto[w.key] ||
				autoNs[w.namespace].replicasOptimize { // AutomatedNamespace replicasOptimize
				replicasAutomated++
			}
		}
		if w.java {
			javaWorkloads++
		}
		if w.agentic {
			agenticCount++
		}
		realizedSavings += w.activeSavings
		initSavingsSum += w.initSavings
	}
	totalPods := len(podItems)

	unevictablePods := 0
	blockedNodeSet := map[string]bool{}
	for _, pv := range podItems {
		p := obj(pv)
		if podUnevictable(p) != "" {
			unevictablePods++
			if nn := getStr(getObj(p, "spec"), "nodeName"); nn != "" {
				blockedNodeSet[nn] = true
			}
		}
	}
	// Allocatable CPU/mem "blocked" by unevictable pods = the allocatable of the
	// nodes pinned by unevictable pods (can't be consolidated).
	var cpuBlockedUnev, memBlockedUnev float64
	for nn := range blockedNodeSet {
		if a, ok := nodeAlloc[nn]; ok {
			cpuBlockedUnev += a[0]
			memBlockedUnev += a[1]
		}
	}
	// pod-placement-optimize (cluster-ops CM) acts as cluster-wide placement
	// automation for the counters below.
	placementAutoN := len(e.placementAutomated)
	// cluster-ops pod-placement-optimize OR any AutomatedNamespace with
	// podPlacementOptimize acts as cluster-wide placement automation.
	nsPlacement := opsPlacement
	if !nsPlacement {
		for _, a := range autoNs {
			if a.placementOptimize {
				nsPlacement = true
				break
			}
		}
	}
	if nsPlacement && unevictablePods > placementAutoN {
		placementAutoN = unevictablePods
	}
	spotPct := 0.0
	if allocCpu != 0 {
		spotPct = allocCpuSpot / allocCpu * 100.0
	}
	rsWastePct := 0.0
	if sizReqCpu != 0 {
		rsWastePct = (sizReclaimCpu / sizReqCpu) * 100
	}
	products := pyjson.NewObj().
		Set("rightsizing", pyjson.NewObj().
			Set("workloads", sizableTotal).Set("eligible", autoEligible).Set("automated", autoEligibleOn).
			Set("wastePct", ifFloat(sizReqCpu != 0, rsWastePct, 0))).
		Set("podPlacement", pyjson.NewObj().
			Set("workloads", unevictablePods).Set("automated", placementAutoN).
			Set("blockedNodes", len(blockedNodeSet))).
		Set("replicas", pyjson.NewObj().
			Set("workloads", replicasWorkloads).Set("automated", replicasAutomated)).
		Set("spot", pyjson.NewObj().
			Set("workloads", spotEligible).Set("automated", 0).Set("spotNodes", spotNodeCount).
			Set("spotPct", spotPct)).
		Set("java", pyjson.NewObj().Set("workloads", javaWorkloads).Set("automated", 0)).
		Set("vllm", pyjson.NewObj().Set("workloads", agenticCount).Set("automated", 0))

	automation := func(total, auto, excludedN, actionable int) *pyjson.Obj {
		pct := 0.0
		if total != 0 {
			pct = float64(auto) / float64(total) * 100.0
		}
		unAuto := total - auto
		if unAuto < 0 {
			unAuto = 0
		}
		return pyjson.NewObj().
			Set("percentage", pct).
			Set("autoAmount", auto).
			Set("unAutoAmount", unAuto).
			Set("totalAmount", total).
			Set("excludedAmount", excludedN).
			Set("actionableUnautomated", actionable).
			Set("isClusterAutomated", total != 0 && auto >= total)
	}
	avgNodeCost := 0.0
	if len(nodeItems) > 0 {
		avgNodeCost = nodeCostTotal / float64(len(nodeItems))
	}
	blockedNodesCost := float64(len(blockedNodeSet)) * avgNodeCost
	pct := func(v float64) float64 {
		if totalCost != 0 {
			return v / totalCost * 100.0
		}
		return 0.0
	}
	zeroSavings := func() (*pyjson.Obj, *pyjson.Obj, *pyjson.Obj) {
		return pyjson.NewObj().Set("percentage", 0).Set("total", 0),
			pyjson.NewObj().Set("percentage", 0).Set("total", 0),
			pyjson.NewObj().Set("total", 0)
	}
	features := pyjson.NewObj()
	{
		f := pyjson.NewObj().
			Set("availableSavings", pyjson.NewObj().Set("percentage", pct(totalSavings)).Set("total", pyjson.Round(totalSavings, 2))).
			Set("automatedSavings", pyjson.NewObj().Set("percentage", pct(activeSavings)).Set("total", pyjson.Round(activeSavings, 2))).
			Set("activeSavings", pyjson.NewObj().Set("total", pyjson.Round(activeSavings, 2))).
			Set("cpu", pyjson.NewObj().Set("request", int(sizReqCpu*1000)).Set("recommended", int(sizRecCpu*1000))).
			Set("memory", pyjson.NewObj().Set("request", int(sizReqMem)).Set("recommended", int(sizRecMem))).
			Set("automation", automation(autoEligible, autoEligibleOn, len(e.excluded), rsActionable))
		features.Set("rightsize", f)
	}
	{
		av, au, ac := zeroSavings()
		features.Set("hpa", pyjson.NewObj().
			Set("availableSavings", av).Set("automatedSavings", au).Set("activeSavings", ac).
			Set("automation", automation(replicasWorkloads, replicasAutomated, 0, 0)).
			Set("predictiveStats", pyjson.NewObj().
				Set("predictiveWorkloadsCount", 0).Set("unPredictiveWorkloadsCount", replicasWorkloads)))
	}
	{
		av, au, ac := zeroSavings()
		features.Set("unevictable", pyjson.NewObj().
			Set("availableSavings", av).Set("automatedSavings", au).Set("activeSavings", ac).
			Set("automation", automation(unevictablePods, placementAutoN, 0, 0)))
	}
	{
		av, au, ac := zeroSavings()
		features.Set("spotOptimization", pyjson.NewObj().
			Set("availableSavings", av).Set("automatedSavings", au).Set("activeSavings", ac).
			Set("automation", automation(spotEligible, 0, 0, 0)))
	}
	{
		av, au, ac := zeroSavings()
		features.Set("javaOptimization", pyjson.NewObj().
			Set("availableSavings", av).Set("automatedSavings", au).Set("activeSavings", ac).
			Set("automation", automation(javaWorkloads, 0, 0, 0)))
	}
	{
		av, au, ac := zeroSavings()
		features.Set("vllmOptimization", pyjson.NewObj().
			Set("availableSavings", av).Set("automatedSavings", au).Set("activeSavings", ac).
			Set("automation", automation(0, 0, 0, 0)))
	}
	// isClusterAutomated reflects the CLUSTER-LEVEL switch, not a coincidental 100%.
	isClusterAutomated := truthy(getObj(e.globalAuto, "automate").GetD("rightsize", nil)) ||
		truthy(e.globalAuto.GetD("automateAllNamespaces", nil))
	getObj(getObj(features, "rightsize"), "automation").Set("isClusterAutomated", isClusterAutomated)

	hrCpuPct, hrMemPct := 0.0, 0.0
	if e.headroomEnabled {
		hrCpuPct = e.headroomCpuPct / 100.0
		hrMemPct = e.headroomMemPct / 100.0
	}
	savingsPct := 0.0
	if totalCost != 0 {
		savingsPct = totalSavings / totalCost * 100.0
	}
	cpuWaste, memWaste := 0.0, 0.0
	if sizReqCpu != 0 {
		cpuWaste = (sizReclaimCpu / sizReqCpu) * 100
	}
	if sizReqMem != 0 {
		memWaste = (sizReclaimMem / sizReqMem) * 100
	}
	dataSource := "metrics-server"
	if usingProm {
		dataSource = "prometheus"
	}
	overview := pyjson.NewObj().
		Set("clusterName", cfg.ClusterName).
		Set("readOnly", cfg.ReadOnly).
		Set("nodes", len(nodeItems)).
		Set("capCpu", capCpuOut).
		Set("capMem", capMemOut).
		Set("allocCpu", allocCpu).
		Set("allocMem", allocMem).
		Set("headroom", pyjson.NewObj().
			Set("enabled", e.headroomEnabled).
			Set("cpuProportion", e.headroomCpuPct).
			Set("memoryProportion", e.headroomMemPct).
			Set("headroomCpu", allocCpu*hrCpuPct).
			Set("headroomMem", allocMem*hrMemPct).
			Set("targetAllocatableCpu", allocCpu*(1-hrCpuPct)).
			Set("targetAllocatableMem", allocMem*(1-hrMemPct)).
			Set("estimatedAllocatableCpu", sizRecCpu*(1+hrCpuPct)+(totReqCpu-sizReqCpu)).
			Set("estimatedAllocatableMem", sizRecMem*(1+hrMemPct)+(totReqMem-sizReqMem))).
		Set("reqCpu", sizReqCpu).
		Set("reqMem", sizReqMem).
		Set("useCpu", sizUseCpu).
		Set("useMem", sizUseMem).
		Set("recCpu", sizRecCpu).
		Set("recMem", sizRecMem).
		Set("clusterReqCpu", totReqCpu).
		Set("clusterReqMem", totReqMem).
		Set("clusterUseCpu", totUseCpu).
		Set("clusterUseMem", totUseMem).
		Set("monthlyCost", totalCost).
		Set("potentialSavings", totalSavings).
		Set("savingsPct", savingsPct).
		Set("activeSavings", activeSavings).
		Set("availableSavings", availableSavings).
		Set("requestsCostMonthly", requestsCostMonthly).
		Set("recommendedCostMonthly", recommendedCostMonthly).
		Set("workloads", len(workloads)).
		Set("sizable", sizableTotal).
		Set("automated", automatedCount).
		Set("optimized", optimized).
		Set("autoEligible", autoEligible).
		Set("isClusterAutomated", isClusterAutomated).
		Set("origCpu", sizOrigCpu).
		Set("origMem", sizOrigMem).
		Set("realizedSavings", pyjson.Round(realizedSavings, 2)).
		Set("cpuWastePct", ifFloat(sizReqCpu != 0, cpuWaste, 0)).
		Set("memWastePct", ifFloat(sizReqMem != 0, memWaste, 0)).
		Set("cpuReclaim", sizReclaimCpu).
		Set("memReclaim", sizReclaimMem).
		Set("costCpuCoreMonth", e.costCPUCoreMonth).
		Set("costMemGbMonth", e.costMemGBMonth).
		Set("nodeCost", nodeCostTotal).
		Set("products", products).
		Set("features", features).
		Set("predictiveStats", pyjson.NewObj().
			Set("predictiveWorkloadsCount", 0).Set("unPredictiveWorkloadsCount", replicasWorkloads)).
		Set("totalStats", pyjson.NewObj().
			Set("totalPodsRecommended", sizPods).Set("blockedNodesCost", pyjson.Round(blockedNodesCost, 2))).
		Set("liveAnalytics", pyjson.NewObj().
			Set("waste", pyjson.Round(totalSavings, 2)).
			Set("activeSavings", pyjson.Round(activeSavings, 2)).
			Set("availableSavingsWithReplicas", pyjson.Round(availableSavings, 2)).
			Set("availableSavingsAllFeatures", pyjson.Round(availableSavings, 2))).
		Set("savingsBreakdown", pyjson.NewObj().
			Set("rightsizing", pyjson.Round(availableSavings, 2)).
			Set("initContainers", pyjson.Round(initSavingsSum, 2)).
			Set("unrecognized", pyjson.Round(unrecognizedSavings, 2))).
		Set("increased", increased).
		Set("excluded", len(e.excluded)).
		Set("signals", pyjson.NewObj().
			Set("throttling", wlThrottling).
			Set("oom", wlOom).
			Set("underProvisioned", wlUnder).
			Set("bootTime", wlBoot).
			Set("burst", wlBurst).
			Set("initOpt", wlInitopt)).
		Set("dataSource", dataSource)

	namespaces := make([]*nsSaving, 0, len(nsSavingsOrder))
	for _, ns := range nsSavingsOrder {
		namespaces = append(namespaces, &nsSaving{ns, nsSavings[ns]})
	}
	sort.SliceStable(namespaces, func(i, j int) bool {
		return namespaces[i].savings > namespaces[j].savings
	})

	// Timestamped cluster snapshot for the analytics view.
	wastedSpendPct := 0.0
	if totalCost != 0 {
		wastedSpendPct = totalSavings / totalCost * 100.0
	}
	snap := pyjson.NewObj().
		Set("t", int(time.Now().Unix())).
		Set("cpuAllocatable", allocCpu).
		Set("memoryAllocatable", allocMem).
		Set("cpuAllocatableOnDemand", allocCpuOD).
		Set("cpuAllocatableSpot", allocCpuSpot).
		Set("memoryAllocatableOnDemand", allocMemOD).
		Set("memoryAllocatableSpot", allocMemSpot).
		Set("cpuUsageTotal", sizUseCpu).
		Set("memoryUsageTotal", sizUseMem).
		Set("cpuRequests", sizReqCpu).
		Set("memoryRequests", sizReqMem).
		Set("cpuRequestsOrigin", sizOrigCpu).
		Set("memoryRequestsOrigin", sizOrigMem).
		Set("cpuRecommendation", sizRecCpu).
		Set("memoryRecommendation", sizRecMem).
		Set("totalNumberOfWorkloads", len(workloads)).
		Set("totalNumberOfPods", totalPods).
		Set("numberOfAutomatedPods", automatedPods).
		Set("performanceOptimizedWorkloads", increased).
		Set("totalCpuRequestsOrigin", totReqCpu).
		Set("totalMemoryRequestsOrigin", totReqMem).
		Set("wastedSpend", totalSavings).
		Set("wastedSpendPct", ifFloat(totalCost != 0, wastedSpendPct, 0)).
		Set("activeSavings", activeSavings).
		Set("availableSavings", availableSavings).
		Set("requestsCostMonthly", requestsCostMonthly).
		Set("recommendedCostMonthly", recommendedCostMonthly).
		Set("totalWorkloadCostMonthly", totalCost).
		Set("wasteCpuDollar", sizReclaimCpu*e.costCPUCoreMonth).
		Set("wasteMemDollar", (sizReclaimMem/(1<<30))*e.costMemGBMonth).
		Set("rightsizingAutomated", automatedCount).
		Set("rightsizingTotal", sizableTotal).
		Set("podPlacementAutomated", placementAutoN).
		Set("podPlacementTotal", unevictablePods).
		Set("unevictableBlockedCpu", cpuBlockedUnev).
		Set("unevictableBlockedMemory", memBlockedUnev).
		Set("replicasAutomated", replicasAutomated).
		Set("replicasTotal", replicasWorkloads).
		Set("spotAutomated", 0).
		Set("spotTotal", spotEligible).
		Set("javaAutomated", 0).
		Set("javaTotal", javaWorkloads).
		Set("nodeCost", nodeCostTotal).
		Set("blockedNodes", len(blockedNodeSet)).
		Set("nodes", len(nodeItems)).
		Set("autoCpuRequests", autoReqCpu).
		Set("autoMemoryRequests", autoReqMem).
		Set("autoCpuRecommendation", autoRecCpu).
		Set("autoMemoryRecommendation", autoRecMem).
		Set("autoCpuRequestsOrigin", autoOrigCpu).
		Set("autoMemoryRequestsOrigin", autoOrigMem).
		Set("hpaCpuRequests", hpaReqCpu).
		Set("hpaMemoryRequests", hpaReqMem).
		Set("hpaCpuRecommendation", hpaRecCpu).
		Set("hpaMemoryRecommendation", hpaRecMem).
		Set("hpaCpuRequestsOrigin", hpaOrigCpu).
		Set("hpaMemoryRequestsOrigin", hpaOrigMem).
		Set("schedulingAutomatedPods", len(e.schedulingAutomated)).
		// Estimated ORIGINAL allocatable: the allocatable the cluster would
		// need if all workloads still ran their ORIGINAL requests — derived
		// as allocatable scaled by the origin/current request ratio.
		Set("cpuEstimatedAllocatable", estAllocatable(allocCpu, totReqCpu, sizReqCpu)).
		Set("memoryEstimatedAllocatable", estAllocatable(allocMem, totReqMem, sizReqMem)).
		Set("workloadsThrottling", wlThrottling).
		Set("workloadsOOM", wlOom).
		Set("workloadsUnderProvisioned", wlUnder).
		Set("ephemeralRequests", sizReqEph).
		Set("ephemeralUsage", sizUseEph).
		Set("ephemeralRecommendation", sizRecEph).
		Set("ephemeralAllocatable", allocEph).
		Set("currentReplicas", totalReplicas).
		Set("numberOfUnevictablePods", unevictablePods).
		Set("totalHpaRequests", hpaReqCpu)

	e.analytics = append(e.analytics, snap)
	if max := e.Cfg.AnalyticsPoints; max > 0 && len(e.analytics) > max {
		e.analytics = e.analytics[len(e.analytics)-max:]
	}
	// Per-workload cost sample for the Cost Report's stacked cost-over-time.
	costs := pyjson.NewObj()
	for _, w := range workloads {
		if w.monthlyCost > 0 && w.kind != "Node" {
			costs.Set(cfg.ClusterName+"/"+w.namespace+"/"+strings.ToLower(w.kind)+"/"+w.name,
				pyjson.Round(w.monthlyCost, 4))
		}
	}
	e.costOvertime = append(e.costOvertime, pyjson.NewObj().
		Set("t", snap.GetD("t", 0)).Set("costs", costs))
	if e.costOvertimeN > 0 && len(e.costOvertime) > e.costOvertimeN {
		e.costOvertime = e.costOvertime[len(e.costOvertime)-e.costOvertimeN:]
	}
	e.attrCatalog = attrCatalog

	e.overview = overview
	e.workloads = workloads
	e.namespaces = namespaces
	e.byKey = byKey
	e.lastUpdate = time.Now().Unix()
	e.ready = true
	e.dataSource = dataSource
	e.minNodeCpu = minNodeCpu
	e.mu.Unlock()

	// One-time cluster workload-control reset (coolscaler-control-actions CM):
	// the in-memory state was cleared in the loop above; now remove the UI
	// policy annotations, delete the CM, and write the audit event.
	if resetRequested {
		e.finishControlReset(ctx, resetN, resetPolicyTargets)
	}

	// Publish per-workload Recommendation CRs. WRITE_ENABLED=false records
	// dry-run ops.
	if cfg.WriteRecommendationCRs {
		for _, w := range workloads {
			if w.sizable {
				e.writeRecommendationCR(ctx, w)
				e.writeAutoHealingCR(ctx, w)
			}
		}
	}
	// detection-gated builtin Policy seeds (prometheus / high-replica)
	e.ensureConditionalBuiltinPolicies(ctx)
	// Slack alert delivery (interval-gated inside; no-op without a token).
	// Run async so a slow slack.com round-trip never stalls the refresh loop.
	go e.SlackDeliverAlerts(context.WithoutCancel(ctx))
	return nil
}

func maxFloat(vals []float64) float64 {
	m := vals[0]
	for _, v := range vals[1:] {
		if v > m {
			m = v
		}
	}
	return m
}

func hasKey(m map[string]float64, k string) bool {
	_, ok := m[k]
	return ok
}

func ifStr(cond bool, a, b string) string {
	if cond {
		return a
	}
	return b
}

// estAllocatable scales allocatable by the origin/current request ratio — the
// "Estimated original allocatable" series.
func estAllocatable(alloc, origReq, curReq float64) float64 {
	if curReq <= 0 {
		return alloc
	}
	return alloc * math.Max(1, origReq/curReq)
}

func ifFloat(cond bool, v float64, zero int) any {
	if cond {
		return v
	}
	return zero
}
