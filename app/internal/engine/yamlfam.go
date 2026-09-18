package engine

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"unicode"

	"coolscaler.sh/coolscaler/internal/pyjson"
)


func yamlScalar(v any) string {
	switch x := v.(type) {
	case nil:
		return "null"
	case bool:
		if x {
			return "true"
		}
		return "false"
	case int:
		return strconv.Itoa(x)
	case int64:
		return strconv.FormatInt(x, 10)
	case float64:
		// FloatRepr matches for all finite values.
		return pyjson.FloatRepr(x)
	case string:
		return yamlStringScalar(x)
	}
	return yamlStringScalar(fmt.Sprint(v))
}

func yamlStringScalar(s string) string {
	quote := s == "" || s != strings.TrimSpace(s)
	if !quote {
		switch strings.ToLower(s) {
		case "null", "true", "false", "yes", "no", "on", "off":
			quote = true
		}
	}
	if !quote && strings.ContainsAny(s, ":#{}[],&*!|>'\"%@`") {
		quote = true
	}
	if !quote {
		switch s[0] {
		case '-', '?', ' ':
			quote = true
		}
	}
	if !quote {
		t := strings.Replace(s, ".", "", 1)
		t = strings.TrimLeft(t, "-")
		if t != "" {
			allDigits := true
			for _, r := range t {
				if !unicode.IsDigit(r) {
					allDigits = false
					break
				}
			}
			quote = allDigits
		}
	}
	if quote {
		return string(pyjson.Marshal(s)) // json.dumps(s)
	}
	return s
}

func yamlNonEmptyContainer(v any) bool {
	switch x := v.(type) {
	case *pyjson.Obj:
		return x.Len() > 0
	case []any:
		return len(x) > 0
	}
	return false
}

// yamlInline renders a leaf value on the "key: " line.
func yamlInline(v any) string {
	switch x := v.(type) {
	case *pyjson.Obj:
		_ = x
		return "{}"
	case []any:
		return "[]"
	}
	return yamlScalar(v)
}

func yamlDump(v any, indent int) string {
	pad := strings.Repeat("  ", indent)
	switch x := v.(type) {
	case *pyjson.Obj:
		if x.Len() == 0 {
			return pad + "{}"
		}
		var lines []string
		for _, k := range x.Keys() {
			val := x.GetD(k, nil)
			key := yamlScalar(k)
			if yamlNonEmptyContainer(val) {
				lines = append(lines, pad+key+":")
				lines = append(lines, yamlDump(val, indent+1))
			} else {
				lines = append(lines, pad+key+": "+yamlInline(val))
			}
		}
		return strings.Join(lines, "\n")
	case []any:
		if len(x) == 0 {
			return pad + "[]"
		}
		var lines []string
		for _, it := range x {
			if yamlNonEmptyContainer(it) {
				sub := yamlDump(it, indent+1)
				// continuation lines keep it.
				lines = append(lines, pad+"- "+sub[len(pad)+2:])
			} else {
				lines = append(lines, pad+"- "+yamlScalar(it))
			}
		}
		return strings.Join(lines, "\n")
	}
	return pad + yamlScalar(v)
}

// When the CR is not materialized yet (read-only / dry-run) a builtin's CR
// shape is synthesized from the seeds; unknown names return ok=false.
func (e *Engine) PolicyYaml(ctx context.Context, name string) (string, bool) {
	if name == "" {
		return "", false
	}
	if cr, err := e.Kube.GetJSON(ctx, crdBase("policies", e.Cfg.Namespace)+"/"+name); err == nil {
		o := cr.Clone()
		if md, ok := o.GetD("metadata", nil).(*pyjson.Obj); ok {
			md.Del("managedFields")
		}
		return yamlDump(o, 0) + "\n", true
	}
	synth := func(labels, ann, spec *pyjson.Obj) string {
		cr := pyjson.NewObj().
			Set("apiVersion", crdGroup+"/"+crdVer).
			Set("kind", "Policy").
			Set("metadata", pyjson.NewObj().
				Set("name", name).
				Set("namespace", e.Cfg.Namespace).
				Set("labels", labels).
				Set("annotations", ann)).
			Set("spec", spec)
		return yamlDump(cr, 0) + "\n"
	}
	for _, d := range e.builtinPolicies() {
		if d.name == name {
			labels, ann := builtinPolicyMeta(name, d.desc)
			return synth(labels, ann, e.policySpec(d.args)), true
		}
	}
	for _, s := range builtinSchedulePolicies() {
		if s.name == name {
			labels := pyjson.NewObj().
				Set("app.kubernetes.io/part-of", "coolscaler").
				Set("coolscaler.sh/schedule-policy", "true").
				Set("coolscaler.sh/builtin-policy", "true")
			ann := pyjson.NewObj().Set("coolscaler.sh/description", s.desc)
			return synth(labels, ann, e.schedulePolicySpec(s)), true
		}
	}
	return "", false
}

func (e *Engine) WorkloadYamlData(ctx context.Context, ns, kind, name string) *pyjson.Obj {
	out := pyjson.NewObj().
		Set("found", false).
		Set("workload", nil).
		Set("hpa", nil)
	if api, ok := wlAPI[kind]; ok {
		if o, err := e.Kube.GetJSON(ctx, fmt.Sprintf(api, ns, name)); err == nil {
			out.Set("workload", o)
			out.Set("found", true)
		}
	}
	e.mu.Lock()
	row := e.byKey[wlkey(ns, kind, name)]
	e.mu.Unlock()
	ro := pyjson.NewObj()
	if row != nil {
		ro = row.obj
	}
	if hpa := ro.GetD("hpaName", nil); truthy(hpa) {
		if o, err := e.Kube.GetJSON(ctx,
			"/apis/autoscaling/v2/namespaces/"+ns+"/horizontalpodautoscalers/"+str(hpa)); err == nil {
			out.Set("hpa", o)
		}
	}
	// KEDA ScaledObject (if this workload is KEDA-managed)
	if keda := ro.GetD("kedaName", nil); truthy(keda) {
		if o, err := e.Kube.GetJSON(ctx,
			"/apis/keda.sh/v1alpha1/namespaces/"+ns+"/scaledobjects/"+str(keda)); err == nil {
			out.Set("scaledObject", o)
		}
	}
	// PodDisruptionBudget selecting this workload (matchLabels ⊆ workload labels)
	wlLabels := obj(ro.GetD("labels", nil))
	if wlLabels.Len() > 0 {
		if pdbs, err := e.Kube.GetJSON(ctx, "/apis/policy/v1/namespaces/"+ns+"/poddisruptionbudgets"); err == nil {
			for _, pv := range items(pdbs) {
				pdb := obj(pv)
				sel := obj(obj(obj(pdb.GetD("spec", nil)).GetD("selector", nil)).GetD("matchLabels", nil))
				if sel.Len() > 0 && labelsMatchSubset(wlLabels, sel) {
					out.Set("pdb", pdb)
					break
				}
			}
		}
	}
	// Namespace LimitRange + ResourceQuota.
	if lrs, err := e.Kube.GetJSON(ctx, "/api/v1/namespaces/"+ns+"/limitranges"); err == nil {
		if l := items(lrs); len(l) > 0 {
			out.Set("limitRange", l[0])
		}
	}
	if rqs, err := e.Kube.GetJSON(ctx, "/api/v1/namespaces/"+ns+"/resourcequotas"); err == nil {
		if l := items(rqs); len(l) > 0 {
			out.Set("resourceQuota", l[0])
		}
	}
	return out
}

func labelsMatchSubset(lbls, sel *pyjson.Obj) bool {
	for _, k := range sel.Keys() {
		if !yamlScalarEq(lbls.GetD(k, nil), sel.GetD(k, nil)) {
			return false
		}
	}
	return true
}

func yamlScalarEq(a, b any) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	if as, ok := a.(string); ok {
		bs, ok2 := b.(string)
		return ok2 && as == bs
	}
	if ab, ok := a.(bool); ok {
		bb, ok2 := b.(bool)
		return ok2 && ab == bb
	}
	af, aok := f64(a)
	bf, bok := f64(b)
	return aok && bok && af == bf
}

var wlPlurals = map[string]string{
	"Deployment": "deployments", "StatefulSet": "statefulsets",
	"DaemonSet": "daemonsets", "ReplicaSet": "replicasets",
}

// Returns {"yaml": "..."} — empty string when the object doesn't exist.
func (e *Engine) WorkloadObjYaml(ctx context.Context, ns, kind, name, what string) *pyjson.Obj {
	plural, ok := wlPlurals[kind]
	if !ok {
		plural = "deployments"
	}
	var o *pyjson.Obj
	switch what {
	case "yaml":
		if wl, err := e.Kube.GetJSON(ctx, "/apis/apps/v1/namespaces/"+ns+"/"+plural+"/"+name); err == nil {
			o = wl
		}
	case "recommendation-yaml":
		if cr, err := e.getRecommendationCR(ctx, ns, kind, name); err == nil {
			o = cr
		}
	case "hpa-yaml":
		if hl, err := e.Kube.GetJSON(ctx, "/apis/autoscaling/v2/namespaces/"+ns+"/horizontalpodautoscalers"); err == nil {
			for _, hv := range items(hl) {
				h := obj(hv)
				tr := obj(obj(h.GetD("spec", nil)).GetD("scaleTargetRef", nil))
				if getStr(tr, "name") == name && str(tr.GetD("kind", kind)) == kind {
					o = h
					break
				}
			}
		}
	case "pdb-yaml":
		// the PDB whose selector is a subset of the workload template labels
		lbls := pyjson.NewObj()
		if wl, err := e.Kube.GetJSON(ctx, "/apis/apps/v1/namespaces/"+ns+"/"+plural+"/"+name); err == nil {
			lbls = obj(obj(obj(getObj(wl, "spec").GetD("template", nil)).GetD("metadata", nil)).GetD("labels", nil))
		}
		if pl, err := e.Kube.GetJSON(ctx, "/apis/policy/v1/namespaces/"+ns+"/poddisruptionbudgets"); err == nil {
			for _, pv := range items(pl) {
				p := obj(pv)
				sel := obj(obj(obj(p.GetD("spec", nil)).GetD("selector", nil)).GetD("matchLabels", nil))
				if sel.Len() > 0 && labelsMatchSubset(lbls, sel) {
					o = p
					break
				}
			}
		}
	case "limitrange-yaml":
		if lr, err := e.Kube.GetJSON(ctx, "/api/v1/namespaces/"+ns+"/limitranges"); err == nil {
			if its := items(lr); len(its) > 0 {
				o = obj(its[0])
			}
		}
	case "resourcequota-yaml":
		if rq, err := e.Kube.GetJSON(ctx, "/api/v1/namespaces/"+ns+"/resourcequotas"); err == nil {
			if its := items(rq); len(its) > 0 {
				o = obj(its[0])
			}
		}
	case "scaledobject-yaml":
		if sl, err := e.Kube.GetJSON(ctx, "/apis/keda.sh/v1alpha1/namespaces/"+ns+"/scaledobjects"); err == nil {
			for _, sv := range items(sl) {
				s := obj(sv)
				tr := obj(obj(s.GetD("spec", nil)).GetD("scaleTargetRef", nil))
				if getStr(tr, "name") == name {
					o = s
					break
				}
			}
		}
	}
	if o == nil || o.Len() == 0 {
		return pyjson.NewObj().Set("yaml", "")
	}
	o = o.Clone()
	if md, ok := o.GetD("metadata", nil).(*pyjson.Obj); ok {
		md.Del("managedFields")
	}
	return pyjson.NewObj().Set("yaml", yamlDump(o, 0)+"\n")
}
