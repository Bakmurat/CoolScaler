// Plus the --gen-cert self-signed CA machinery (cert.go).
package webhook

import (
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"coolscaler.sh/coolscaler/internal/config"
	"coolscaler.sh/coolscaler/internal/engine"
	"coolscaler.sh/coolscaler/internal/kube"
	"coolscaler.sh/coolscaler/internal/pyjson"
)

// Mutator implements the admissions HTTP handlers.
type Mutator struct {
	Cfg  config.Config
	Kube *kube.Client
	Log  *slog.Logger

	// Java Optimization env knobs.
	javaEnabled   bool
	jmxAgentImage string
	jmxAgentJar   string
	jmxAgentPort  int

	// coolscaler-cluster-operations ConfigMap cache.
	opsMu   sync.Mutex
	opsAt   time.Time
	opsData *pyjson.Obj
}

func NewMutator(cfg config.Config, kc *kube.Client, log *slog.Logger) *Mutator {
	port := 9404
	if v := os.Getenv("JMX_AGENT_PORT"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			port = n
		}
	}
	return &Mutator{
		Cfg:           cfg,
		Kube:          kc,
		Log:           log,
		javaEnabled:   strings.EqualFold(os.Getenv("JAVA_OPTIMIZATION_ENABLED"), "true"),
		jmxAgentImage: envOr("JMX_AGENT_IMAGE", "registry.example.com/coolscaler/coolscaler:latest"),
		jmxAgentJar:   envOr("JMX_AGENT_JAR", "/opt/jmx/agent.jar"),
		jmxAgentPort:  port,
	}
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func (m *Mutator) clusterOps(ctx context.Context) *pyjson.Obj {
	m.opsMu.Lock()
	defer m.opsMu.Unlock()
	if m.opsData != nil && time.Since(m.opsAt) < 15*time.Second {
		return m.opsData
	}
	data := pyjson.NewObj()
	cm, err := m.Kube.GetJSON(ctx,
		"/api/v1/namespaces/"+m.Cfg.Namespace+"/configmaps/coolscaler-cluster-operations")
	if err == nil {
		if d, ok := cm.GetD("data", nil).(*pyjson.Obj); ok && d != nil {
			data = d
		}
	}
	m.opsAt, m.opsData = time.Now(), data
	return data
}

// javaObservabilityOn: Helm java.enabled OR the runtime ConfigMap toggle.
func (m *Mutator) javaObservabilityOn(ctx context.Context) bool {
	if m.javaEnabled {
		return true
	}
	return getStr(m.clusterOps(ctx), "java-observability") == "true"
}

// javaMemOptimizationOn reads the java-memory-aware policy's
// automation.memoryOptimization toggle from the cluster-operations CM key
// java-policy-config (JSON); absent/undecodable means the default: on.
func (m *Mutator) javaMemOptimizationOn(ctx context.Context) bool {
	raw := getStr(m.clusterOps(ctx), "java-policy-config")
	if raw == "" {
		return true
	}
	v, err := pyjson.Decode([]byte(raw))
	if err != nil {
		return true
	}
	o, ok := v.(*pyjson.Obj)
	if !ok {
		return true
	}
	if b, okB := o.Get("memoryOptimization"); okB {
		return truthy(b)
	}
	return true
}

// {"found": false} on any failure.
func (m *Mutator) getRecommendation(ctx context.Context, ns, kind, name string) *pyjson.Obj {
	url := fmt.Sprintf("%s/api/recommend/%s/%s/%s", m.Cfg.RecommenderURL, ns, kind, name)
	c, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(c, http.MethodGet, url, nil)
	if err != nil {
		return pyjson.NewObj().Set("found", false)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		m.Log.Info("recommend lookup failed", "err", err)
		return pyjson.NewObj().Set("found", false)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil || resp.StatusCode/100 != 2 {
		m.Log.Info("recommend lookup failed", "status", resp.StatusCode)
		return pyjson.NewObj().Set("found", false)
	}
	v, err := pyjson.Decode(raw)
	if err != nil {
		return pyjson.NewObj().Set("found", false)
	}
	if o, ok := v.(*pyjson.Obj); ok {
		return o
	}
	return pyjson.NewObj().Set("found", false)
}

// ServeMutate is the POST handler
func (m *Mutator) ServeMutate(w http.ResponseWriter, r *http.Request) {
	raw, err := io.ReadAll(io.LimitReader(r.Body, 32<<20))
	if err != nil {
		sendPy(w, 400, pyjson.NewObj().Set("error", "bad body"))
		return
	}
	var review *pyjson.Obj
	if len(raw) > 0 {
		if v, derr := pyjson.Decode(raw); derr == nil {
			review, _ = v.(*pyjson.Obj)
		} else {
			sendPy(w, 400, pyjson.NewObj().Set("error", "bad body"))
			return
		}
	}
	if review == nil {
		review = pyjson.NewObj()
	}
	req := getObj(review, "request")
	uid := getStr(req, "uid")
	resp := pyjson.NewObj().Set("uid", uid).Set("allowed", true)
	envelope := func() *pyjson.Obj {
		return pyjson.NewObj().
			Set("apiVersion", review.GetD("apiVersion", "admission.k8s.io/v1")).
			Set("kind", "AdmissionReview").
			Set("response", resp)
	}

	// HPA / KEDA ScaledObject UPDATE: only annotate coolscaler.sh/managed
	// (spec rewriting stays in the recommender apply path — a bad patch from
	// an up webhook would apply despite failurePolicy: Ignore).
	reqKind := getStr(getObj(req, "kind"), "kind")
	if reqKind == "HorizontalPodAutoscaler" || reqKind == "ScaledObject" {
		func() {
			defer func() {
				if rec := recover(); rec != nil {
					m.Log.Info("hpa/keda admission error (allowing)", "err", fmt.Sprint(rec))
				}
			}()
			meta := getObj(getObj(req, "object"), "metadata")
			anns := getObj(meta, "annotations")
			var apatch []any
			if !meta.Has("annotations") {
				apatch = append(apatch, pyjson.NewObj().
					Set("op", "add").Set("path", "/metadata/annotations").Set("value", pyjson.NewObj()))
			}
			if getStr(anns, "coolscaler.sh/managed") != "true" {
				apatch = append(apatch, pyjson.NewObj().
					Set("op", "add").Set("path", "/metadata/annotations/coolscaler.sh~1managed").
					Set("value", "true"))
			}
			if len(apatch) > 0 {
				resp.Set("patchType", "JSONPatch")
				resp.Set("patch", base64.StdEncoding.EncodeToString(pyjson.Marshal(apatch)))
				m.Log.Info(fmt.Sprintf("marked %s %s/%s coolscaler-managed",
					reqKind, getStr(req, "namespace"), getStr(meta, "name")))
			}
		}()
		sendPy(w, 200, envelope())
		return
	}

	// Pod CREATE: inject recommended requests + the JMX java agent.
	func() {
		defer func() {
			if rec := recover(); rec != nil {
				m.Log.Info("admission error (allowing)", "err", fmt.Sprint(rec))
			}
		}()
		pod := getObj(req, "object")
		ns := getStr(req, "namespace")
		var ctrl *pyjson.Obj
		for _, ov := range getList(getObj(pod, "metadata"), "ownerReferences") {
			o, _ := ov.(*pyjson.Obj)
			if o != nil && truthy(o.GetD("controller", nil)) {
				ctrl = o
				break
			}
		}
		var patches []any
		if ctrl != nil && !m.Cfg.ReadOnly {
			rec := m.getRecommendation(r.Context(), ns, getStr(ctrl, "kind"), getStr(ctrl, "name"))
			if truthy(rec.GetD("found", false)) && truthy(rec.GetD("sizable", false)) &&
				!truthy(rec.GetD("hpaManaged", false)) {
				recmap := map[string]*pyjson.Obj{}
				for _, cv := range getList(rec, "containers") {
					c, _ := cv.(*pyjson.Obj)
					if c != nil {
						recmap[getStr(c, "name")] = c
					}
				}
				for i, cv := range getList(getObj(pod, "spec"), "containers") {
					c, _ := cv.(*pyjson.Obj)
					if c == nil {
						continue
					}
					rc := recmap[getStr(c, "name")]
					if rc == nil {
						continue
					}
					base := fmt.Sprintf("/spec/containers/%d/resources", i)
					resources := getObj(c, "resources")
					if resources.Len() == 0 {
						patches = append(patches, pyjson.NewObj().
							Set("op", "add").Set("path", base).Set("value", pyjson.NewObj()))
					}
					if getObj(resources, "requests").Len() == 0 {
						patches = append(patches, pyjson.NewObj().
							Set("op", "add").Set("path", base+"/requests").Set("value", pyjson.NewObj()))
					}
					// Boot-Time optimization: on pod CREATE, size the CPU request
					// for the startup spike (bootCpu, when higher) so the pod boots
					// fast; the steady updater later reduces running pods to recCpu.
					cpuReq := pyF(rc.GetD("recCpu", 0.0))
					if bc := pyF(rc.GetD("bootCpu", 0.0)); bc > cpuReq {
						cpuReq = bc
					}
					patches = append(patches, pyjson.NewObj().
						Set("op", "add").Set("path", base+"/requests/cpu").
						Set("value", engine.FmtCPU(cpuReq)))
					patches = append(patches, pyjson.NewObj().
						Set("op", "add").Set("path", base+"/requests/memory").
						Set("value", engine.FmtMem(pyF(rc.GetD("recMem", 0.0)))))
				}
			}
		}
		// Java Optimization: JMX observability agent injection (independent
		// of rightsizing/READ_ONLY — it's observability). With automation on,
		// deliver the optimized -Xmx from the owner's recommendation.
		func() {
			defer func() {
				if rec := recover(); rec != nil {
					m.Log.Info("jmx inject error (skipping)", "err", fmt.Sprint(rec))
				}
			}()
			var xmxOpt int64
			// memoryOptimization=false (java-policy-config) stops appending
			// the optimized -Xmx; observability injection is unaffected.
			if ctrl != nil && m.javaMemOptimizationOn(r.Context()) {
				jrec := m.getRecommendation(r.Context(), ns, getStr(ctrl, "kind"), getStr(ctrl, "name"))
				if truthy(jrec.GetD("javaAuto", false)) {
					jx := getObj(jrec, "javaXmx")
					for _, k := range jx.Keys() {
						if v := int64(pyF(jx.GetD(k, 0))); v > xmxOpt {
							xmxOpt = v
						}
					}
				}
			}
			patches = append(patches, m.javaInjectPatches(r.Context(), pod, xmxOpt)...)
		}()
		if len(patches) > 0 {
			resp.Set("patchType", "JSONPatch")
			resp.Set("patch", base64.StdEncoding.EncodeToString(pyjson.Marshal(patches)))
			owner := "(no controller)"
			if ctrl != nil {
				owner = getStr(ctrl, "kind") + "/" + getStr(ctrl, "name")
			}
			m.Log.Info(fmt.Sprintf("mutated pod in ns=%s owner=%s (%d patches)", ns, owner, len(patches)))
		}
	}()
	sendPy(w, 200, envelope())
}

func (m *Mutator) javaInjectPatches(ctx context.Context, pod *pyjson.Obj, xmxOpt int64) []any {
	if !m.javaObservabilityOn(ctx) {
		return nil
	}
	md := getObj(pod, "metadata")
	spec := getObj(pod, "spec")
	ann := getObj(md, "annotations")
	if getStr(ann, "coolscaler.sh/jmx-injection-disabled") == "true" {
		return nil
	}
	if getStr(ann, "coolscaler.sh/jmx-injected") == "true" {
		return nil // already injected
	}
	// first Java container that doesn't already set JAVA_TOOL_OPTIONS
	// (Flink is unsupported by Java Optimization — skip it).
	jidx := -1
	var jc *pyjson.Obj
	for i, cv := range getList(spec, "containers") {
		c, _ := cv.(*pyjson.Obj)
		if c == nil {
			continue
		}
		isJava, _ := engine.JavaDetect(c)
		if strings.Contains(strings.ToLower(getStr(c, "image")), "flink") {
			continue
		}
		hasJTO := false
		for _, ev := range getList(c, "env") {
			e, _ := ev.(*pyjson.Obj)
			if e != nil && getStr(e, "name") == "JAVA_TOOL_OPTIONS" {
				hasJTO = true
				break
			}
		}
		if isJava && !hasJTO {
			jidx, jc = i, c
			break
		}
	}
	if jidx < 0 {
		return nil
	}
	var p []any
	add := func(path string, value any) {
		p = append(p, pyjson.NewObj().Set("op", "add").Set("path", path).Set("value", value))
	}
	if !spec.Has("volumes") || spec.GetD("volumes", nil) == nil {
		add("/spec/volumes", []any{})
	}
	add("/spec/volumes/-", pyjson.NewObj().
		Set("name", "coolscaler-jmx").Set("emptyDir", pyjson.NewObj()))
	init := pyjson.NewObj().
		Set("name", "coolscaler-jmx-init").
		Set("image", m.jmxAgentImage).
		Set("command", []any{"sh", "-c",
			fmt.Sprintf("cp %s /coolscaler-jmx/agent.jar && "+
				"printf 'rules:\\n- pattern: \".*\"\\n' > /coolscaler-jmx/config.yaml && "+
				"echo staged", m.jmxAgentJar)}).
		Set("resources", pyjson.NewObj().Set("requests", pyjson.NewObj().
			Set("cpu", "10m").Set("memory", "10Mi"))).
		Set("volumeMounts", []any{pyjson.NewObj().
			Set("name", "coolscaler-jmx").Set("mountPath", "/coolscaler-jmx")})
	if !spec.Has("initContainers") || spec.GetD("initContainers", nil) == nil {
		add("/spec/initContainers", []any{init})
	} else {
		add("/spec/initContainers/-", init)
	}
	base := fmt.Sprintf("/spec/containers/%d", jidx)
	if !jc.Has("volumeMounts") || jc.GetD("volumeMounts", nil) == nil {
		add(base+"/volumeMounts", []any{})
	}
	add(base+"/volumeMounts/-", pyjson.NewObj().
		Set("name", "coolscaler-jmx").Set("mountPath", "/coolscaler-jmx"))
	// Named containerPort on the app container — the JMX exporter's scrape
	// port, service-discoverable.
	if !jc.Has("ports") || jc.GetD("ports", nil) == nil {
		add(base+"/ports", []any{})
	}
	add(base+"/ports/-", pyjson.NewObj().
		Set("name", "coolscaler-jmx").Set("containerPort", m.jmxAgentPort))
	if !jc.Has("env") || jc.GetD("env", nil) == nil {
		add(base+"/env", []any{})
	}
	jto := fmt.Sprintf("-javaagent:/coolscaler-jmx/agent.jar=%d:/coolscaler-jmx/config.yaml", m.jmxAgentPort)
	optimized := xmxOpt != 0
	if optimized {
		mb := xmxOpt / (1 << 20)
		if mb < 64 {
			mb = 64
		}
		jto += fmt.Sprintf(" -Xmx%dm", mb)
	}
	add(base+"/env/-", pyjson.NewObj().Set("name", "JAVA_TOOL_OPTIONS").Set("value", jto))
	if !md.Has("annotations") || md.GetD("annotations", nil) == nil {
		add("/metadata/annotations", pyjson.NewObj())
	}
	add("/metadata/annotations/coolscaler.sh~1jmx-injected", "true")
	add("/metadata/annotations/coolscaler.sh~1admission", "true")
	add("/metadata/annotations/prometheus.io~1scrape", "true")
	add("/metadata/annotations/prometheus.io~1port", strconv.Itoa(m.jmxAgentPort))
	// Service-discovery pod label.
	if !md.Has("labels") || md.GetD("labels", nil) == nil {
		add("/metadata/labels", pyjson.NewObj())
	}
	add("/metadata/labels/coolscaler.sh~1jmx-injector", "true")
	if optimized {
		add("/metadata/annotations/coolscaler.sh~1java-optimized", "true")
	}
	return p
}

// pyjson access helpers.

func getObj(o *pyjson.Obj, key string) *pyjson.Obj {
	if o == nil {
		return pyjson.NewObj()
	}
	if v, ok := o.GetD(key, nil).(*pyjson.Obj); ok && v != nil {
		return v
	}
	return pyjson.NewObj()
}

func getList(o *pyjson.Obj, key string) []any {
	if o == nil {
		return nil
	}
	l, _ := o.GetD(key, nil).([]any)
	return l
}

func getStr(o *pyjson.Obj, key string) string {
	if o == nil {
		return ""
	}
	s, _ := o.GetD(key, nil).(string)
	return s
}

func truthy(v any) bool {
	switch t := v.(type) {
	case bool:
		return t
	case string:
		return t != ""
	case float64:
		return t != 0
	case int64:
		return t != 0
	case int:
		return t != 0
	case *pyjson.Obj:
		return t != nil && t.Len() > 0
	case []any:
		return len(t) > 0
	case nil:
		return false
	}
	return true
}

func pyF(v any) float64 {
	switch t := v.(type) {
	case float64:
		return t
	case int64:
		return float64(t)
	case int:
		return float64(t)
	}
	return 0
}

func sendPy(w http.ResponseWriter, code int, body any) {
	data := pyjson.Marshal(body)
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.WriteHeader(code)
	_, _ = w.Write(data)
}
