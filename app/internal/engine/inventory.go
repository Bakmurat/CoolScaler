package engine

import (
	"context"
	"fmt"
	"math"
	"regexp"
	"strings"
	"time"

	"coolscaler.sh/coolscaler/internal/pyjson"
)

// ---------------------------------------------------------------------------
// Owner resolution
// ---------------------------------------------------------------------------

// ownerRef is the resolved (kind, name) of a ReplicaSet's controller.
type ownerRef struct{ kind, name string }

func buildOwnerIndex(replicasets *pyjson.Obj) map[string]*ownerRef {
	rs := map[string]*ownerRef{}
	for _, it := range items(replicasets) {
		o := obj(it)
		md := getObj(o, "metadata")
		uid := getStr(md, "uid")
		var top *ownerRef
		for _, ov := range getList(md, "ownerReferences") {
			or := obj(ov)
			if truthy(or.GetD("controller", nil)) {
				top = &ownerRef{getStr(or, "kind"), getStr(or, "name")}
			}
		}
		rs[uid] = top
	}
	return rs
}

func topOwner(pod *pyjson.Obj, rsIndex map[string]*ownerRef) (ns, kind, name string) {
	md := getObj(pod, "metadata")
	ns = getStr(md, "namespace")
	var ctrl *pyjson.Obj
	for _, ov := range getList(md, "ownerReferences") {
		or := obj(ov)
		if truthy(or.GetD("controller", nil)) {
			ctrl = or
			break
		}
	}
	if ctrl == nil {
		return ns, "Pod", getStr(md, "name")
	}
	kind, name = getStr(ctrl, "kind"), getStr(ctrl, "name")
	if kind == "ReplicaSet" {
		if dep := rsIndex[getStr(ctrl, "uid")]; dep != nil {
			return ns, dep.kind, dep.name
		}
		return ns, "ReplicaSet", name
	}
	return ns, kind, name
}

// ---------------------------------------------------------------------------
// HPA / KEDA autoscaler index
// ---------------------------------------------------------------------------

type hpaTrigger struct {
	source      string
	resource    string
	utilization any // int64 (HPA) or float64/nil (KEDA)
}

type hpaEntry struct {
	metrics     map[string]bool
	triggers    []hpaTrigger
	hpa, keda   any // string or nil
	minReplicas any // int64 or nil
	maxReplicas any // int64 or nil
	cpuTarget   any // int64/float64 or nil
}

func newHpaEntry() *hpaEntry {
	return &hpaEntry{metrics: map[string]bool{}}
}

// we capture the inputs here.
func (e *Engine) buildAutoscalerIndex(ctx context.Context) map[string]*hpaEntry {
	idx := map[string]*hpaEntry{}
	get := func(key string) *hpaEntry {
		if h, ok := idx[key]; ok {
			return h
		}
		h := newHpaEntry()
		idx[key] = h
		return h
	}
	if resp, err := e.Kube.GetJSON(ctx, "/apis/autoscaling/v2/horizontalpodautoscalers"); err == nil {
		for _, it := range items(resp) {
			h := obj(it)
			spec := getObj(h, "spec")
			ref := getObj(spec, "scaleTargetRef")
			key := wlkey(getStr(getObj(h, "metadata"), "namespace"), getStr(ref, "kind"), getStr(ref, "name"))
			en := get(key)
			en.hpa = getStr(getObj(h, "metadata"), "name")
			en.minReplicas = spec.GetD("minReplicas", int64(1))
			en.maxReplicas = spec.GetD("maxReplicas", nil)
			for _, mv := range getList(spec, "metrics") {
				m := obj(mv)
				res := getObj(m, "resource")
				if res.Len() == 0 {
					res = getObj(m, "containerResource")
				}
				if res.Len() > 0 && getStr(getObj(res, "target"), "type") == "Utilization" {
					rname := str(res.GetD("name", "resource"))
					util := getObj(res, "target").GetD("averageUtilization", nil)
					en.metrics[rname+"-utilization"] = true
					en.triggers = append(en.triggers, hpaTrigger{"HPA", rname, util})
					if rname == "cpu" {
						en.cpuTarget = util
					}
				} else {
					en.metrics[strings.ToLower(str(m.GetD("type", "custom")))] = true
				}
			}
		}
	}
	if resp, err := e.Kube.GetJSON(ctx, "/apis/keda.sh/v1alpha1/scaledobjects"); err == nil {
		for _, it := range items(resp) {
			s := obj(it)
			spec := getObj(s, "spec")
			ref := getObj(spec, "scaleTargetRef")
			key := wlkey(getStr(getObj(s, "metadata"), "namespace"), str(ref.GetD("kind", "Deployment")), getStr(ref, "name"))
			en := get(key)
			en.keda = getStr(getObj(s, "metadata"), "name")
			en.metrics["keda"] = true
			if en.minReplicas == nil {
				en.minReplicas = spec.GetD("minReplicaCount", int64(1))
			}
			if en.maxReplicas == nil {
				en.maxReplicas = spec.GetD("maxReplicaCount", nil)
			}
			for _, tv := range getList(spec, "triggers") {
				t := obj(tv)
				tt := getStr(t, "type")
				if tt != "cpu" && tt != "memory" {
					continue
				}
				md := getObj(t, "metadata")
				mt := str(md.GetD("type", nil))
				if mt == "" {
					mt = "Utilization"
				}
				if mt == "Utilization" {
					var util any
					if f, ok := toFloatLoose(md.GetD("value", nil)); ok {
						util = f
					}
					en.triggers = append(en.triggers, hpaTrigger{"KEDA", tt, util})
					if tt == "cpu" {
						en.cpuTarget = util
					}
				}
			}
		}
	}
	return idx
}

// ---------------------------------------------------------------------------
// Unevictable-pod detection (Pod Placement blockers)
// ---------------------------------------------------------------------------

func podDSOrStatic(pod *pyjson.Obj) bool {
	md := getObj(pod, "metadata")
	for _, ov := range getList(md, "ownerReferences") {
		if getStr(obj(ov), "kind") == "DaemonSet" {
			return true
		}
	}
	// Static pods are owned by their Node and are not created through the API.
	for _, ov := range getList(md, "ownerReferences") {
		if getStr(obj(ov), "kind") == "Node" {
			return true
		}
	}
	ann := getObj(md, "annotations")
	if str(ann.GetD("kubernetes.io/config.source", "api")) != "api" {
		return true
	}
	return false
}

func podUnevictable(pod *pyjson.Obj) string {
	md := getObj(pod, "metadata")
	if podDSOrStatic(pod) {
		return ""
	}
	ann := getObj(md, "annotations")
	if str(ann.GetD("cluster-autoscaler.kubernetes.io/safe-to-evict", nil)) == "false" {
		return "annotation"
	}
	if ann.Has("karpenter.sh/do-not-evict") || ann.Has("karpenter.sh/do-not-disrupt") {
		return "annotation"
	}
	if getStr(md, "namespace") == "kube-system" {
		return "kube-system"
	}
	if len(getList(md, "ownerReferences")) == 0 {
		return "ownerless"
	}
	return ""
}

// emptyDir deliberately excluded).
func podLocalStorage(pod *pyjson.Obj) bool {
	for _, vv := range getList(getObj(pod, "spec"), "volumes") {
		v := obj(vv)
		if truthy(v.GetD("hostPath", nil)) || truthy(v.GetD("local", nil)) {
			return true
		}
	}
	return false
}

func (e *Engine) buildPDBIndex(ctx context.Context) map[string][]*pyjson.Obj {
	idx := map[string][]*pyjson.Obj{}
	resp, err := e.Kube.GetJSON(ctx, "/apis/policy/v1/poddisruptionbudgets")
	if err != nil {
		return idx
	}
	for _, it := range items(resp) {
		p := obj(it)
		sel := getObj(obj(getObj(p, "spec").GetD("selector", nil)), "matchLabels")
		if sel.Len() > 0 {
			ns := getStr(getObj(p, "metadata"), "namespace")
			idx[ns] = append(idx[ns], sel)
		}
	}
	return idx
}

func unevictableReasons(pod *pyjson.Obj, pdbIndex map[string][]*pyjson.Obj) []string {
	md := getObj(pod, "metadata")
	ns := getStr(md, "namespace")
	if podDSOrStatic(pod) {
		return nil
	}
	ann := getObj(md, "annotations")
	labels := getObj(md, "labels")
	var reasons []string
	if str(ann.GetD("cluster-autoscaler.kubernetes.io/safe-to-evict", nil)) == "false" ||
		ann.Has("karpenter.sh/do-not-evict") || ann.Has("karpenter.sh/do-not-disrupt") {
		reasons = append(reasons, "annotation")
	}
	for _, sel := range pdbIndex[ns] {
		if sel.Len() == 0 {
			continue
		}
		all := true
		for _, k := range sel.Keys() {
			if labels.GetD(k, nil) != sel.GetD(k, nil) {
				all = false
				break
			}
		}
		if all {
			reasons = append(reasons, "pdb")
			break
		}
	}
	if ns == "kube-system" {
		reasons = append(reasons, "kube-system")
	}
	if len(getList(md, "ownerReferences")) == 0 {
		reasons = append(reasons, "ownerless")
	}
	if podLocalStorage(pod) {
		reasons = append(reasons, "localstorage")
	}
	return reasons
}

// ---------------------------------------------------------------------------
// Java detection + JVM-aware sizing
// ---------------------------------------------------------------------------

var javaImageHints = []string{"java", "jdk", "jre", "openjdk", "tomcat", "jetty", "wildfly",
	"spark", "kafka", "cassandra", "elasticsearch", "logstash",
	"zookeeper", "flink", "spring", "solr", "keycloak"}

var javaEnvKeys = map[string]bool{"JAVA_OPTS": true, "JAVA_TOOL_OPTIONS": true, "_JAVA_OPTIONS": true,
	"JDK_JAVA_OPTIONS": true, "CATALINA_OPTS": true, "JAVA_OPTIONS": true, "ES_JAVA_OPTS": true,
	"SPARK_DAEMON_MEMORY": true}

var xmxRe = regexp.MustCompile(`-Xmx(\d+)([kKmMgG]?)`)

// 0 when absent).
func parseXmx(text string) int64 {
	m := xmxRe.FindStringSubmatch(text)
	if m == nil {
		return 0
	}
	unit := int64(1)
	switch strings.ToLower(m[2]) {
	case "k":
		unit = 1 << 10
	case "m":
		unit = 1 << 20
	case "g":
		unit = 1 << 30
	}
	n, ok := parseIntPy(m[1])
	if !ok {
		return 0
	}
	return int64(n) * unit
}

func javaDetect(c *pyjson.Obj) (bool, int64) {
	img := strings.ToLower(getStr(c, "image"))
	isJava := false
	for _, h := range javaImageHints {
		if strings.Contains(img, h) {
			isJava = true
			break
		}
	}
	var blobs []string
	for _, v := range getList(c, "command") {
		blobs = append(blobs, str(v))
	}
	for _, v := range getList(c, "args") {
		blobs = append(blobs, str(v))
	}
	for _, ev := range getList(c, "env") {
		en := obj(ev)
		if javaEnvKeys[getStr(en, "name")] {
			blobs = append(blobs, str(en.GetD("value", "")))
			isJava = true
		}
	}
	blob := strings.Join(blobs, " ")
	xmx := parseXmx(blob)
	if xmx != 0 || strings.Contains(blob, "-Xmx") || strings.Contains(blob, "java ") ||
		strings.HasSuffix(strings.TrimSpace(blob), "java") {
		isJava = true
	}
	return isJava, xmx
}

func (e *Engine) javaMemFromJVM(jv map[string]float64, headroom float64) (float64, int64, bool) {
	heapP90 := jv["heapP90"]
	if heapP90 == 0 {
		return 0, 0, false
	}
	if headroom == 0 {
		headroom = e.Cfg.MemHeadroom
	}
	nonHeap := jv["nonHeapUsed"]
	heapMax := jv["heapMax"]
	memBasis := math.Max(heapP90+nonHeap, heapMax+nonHeap)
	memRec := math.Max(e.Cfg.MemFloorBytes, memBasis*headroom)
	recXmx := int64(math.Ceil(heapP90*1.10/(16*(1<<20)))) * 16 * (1 << 20)
	if recXmx < 64*(1<<20) {
		recXmx = 64 * (1 << 20)
	}
	return memRec, recXmx, true
}

// ---------------------------------------------------------------------------
// Misc small helpers
// ---------------------------------------------------------------------------

func gpuReq(reqs *pyjson.Obj) float64 {
	for _, k := range []string{"nvidia.com/gpu", "amd.com/gpu", "gpu"} {
		v, ok := reqs.Get(k)
		if !ok || v == nil || v == "" {
			continue
		}
		if f, ok := toFloatLoose(v); ok {
			return f
		}
		return 0.0
	}
	return 0.0
}

func nodeSizeBucket(nodeLabels *pyjson.Obj) string {
	it := getStr(nodeLabels, "node.kubernetes.io/instance-type")
	if it == "" {
		it = getStr(nodeLabels, "beta.kubernetes.io/instance-type")
	}
	if it != "" {
		return it
	}
	return "node"
}

func nodeCapacityBucket(node *pyjson.Obj) string {
	if b := nodeSizeBucket(getObj(getObj(node, "metadata"), "labels")); b != "node" {
		return b
	}
	capy := getObj(getObj(node, "status"), "capacity")
	cores := ParseCPU(capy.GetD("cpu", nil))
	gib := ParseMem(capy.GetD("memory", nil)) / float64(1<<30)
	if cores > 0 && gib > 0 {
		return fmt.Sprintf("%dcore%dgib", int(math.Round(cores)), int(math.Round(gib)))
	}
	return "node"
}

func parseK8sTime(s string) int64 {
	if len(s) < 19 {
		return 0
	}
	t, err := time.Parse("2006-01-02T15:04:05", s[:19])
	if err != nil {
		return 0
	}
	return t.Unix()
}

func podReadySeconds(p *pyjson.Obj) int64 {
	status := getObj(p, "status")
	st := getStr(status, "startTime")
	if st == "" {
		st = getStr(getObj(p, "metadata"), "creationTimestamp")
	}
	stSec := parseK8sTime(st)
	for _, cv := range getList(status, "conditions") {
		cond := obj(cv)
		if getStr(cond, "type") == "Ready" && getStr(cond, "status") == "True" {
			rt := parseK8sTime(getStr(cond, "lastTransitionTime"))
			if stSec != 0 && rt >= stSec {
				return rt - stSec
			}
		}
	}
	return 0
}
