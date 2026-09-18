package engine

// ingresscfg.go

import (
	"context"
	"fmt"

	"coolscaler.sh/coolscaler/internal/pyjson"
)

const managedIngressName = "coolscaler-dashboards-ui"

func (e *Engine) ingressPath() string {
	return "/apis/networking.k8s.io/v1/namespaces/" + e.Cfg.Namespace + "/ingresses"
}

// IngressSettingsData is GET /api/settings/ingresses.
func (e *Engine) IngressSettingsData(ctx context.Context) *pyjson.Obj {
	rows := []any{}
	if resp, err := e.k8sReq(ctx, "GET", e.ingressPath(), nil, ""); err == nil {
		for _, iv := range getList(obj(resp), "items") {
			ing := obj(iv)
			meta := getObj(ing, "metadata")
			spec := getObj(ing, "spec")
			var host string
			if rules := getList(spec, "rules"); len(rules) > 0 {
				host = getStr(obj(rules[0]), "host")
			}
			rows = append(rows, pyjson.NewObj().
				Set("name", getStr(meta, "name")).
				Set("host", host).
				Set("className", spec.GetD("ingressClassName", nil)).
				Set("managed", getStr(meta, "name") == managedIngressName))
		}
	}
	// Istio exposure (how this install is actually reached today).
	istioHost := ""
	vsPath := "/apis/networking.istio.io/v1beta1/namespaces/" + e.Cfg.Namespace + "/virtualservices"
	if resp, err := e.k8sReq(ctx, "GET", vsPath, nil, ""); err == nil {
		for _, vv := range getList(obj(resp), "items") {
			hosts := getList(getObj(obj(vv), "spec"), "hosts")
			if len(hosts) > 0 && istioHost == "" {
				istioHost = str(hosts[0])
			}
		}
	}
	return pyjson.NewObj().
		Set("ingresses", rows).
		Set("istioHost", istioHost)
}

// IngressSettingsCreate is POST /api/settings/ingresses {host, className?}.
func (e *Engine) IngressSettingsCreate(ctx context.Context, body *pyjson.Obj) *pyjson.Obj {
	if e.Cfg.ReadOnly {
		return pyjson.NewObj().Set("ok", false).Set("error", "Cluster is in Read-Only mode")
	}
	host := getStr(body, "host")
	if host == "" {
		return pyjson.NewObj().Set("ok", false).Set("error", "host required")
	}
	spec := pyjson.NewObj().Set("rules", []any{pyjson.NewObj().
		Set("host", host).
		Set("http", pyjson.NewObj().Set("paths", []any{pyjson.NewObj().
			Set("path", "/").
			Set("pathType", "Prefix").
			Set("backend", pyjson.NewObj().Set("service", pyjson.NewObj().
				Set("name", "coolscaler-dashboards").
				Set("port", pyjson.NewObj().Set("number", 8080))))}))})
	if cn := getStr(body, "className"); cn != "" {
		spec.Set("ingressClassName", cn)
	}
	ing := pyjson.NewObj().
		Set("apiVersion", "networking.k8s.io/v1").
		Set("kind", "Ingress").
		Set("metadata", pyjson.NewObj().
			Set("name", managedIngressName).
			Set("namespace", e.Cfg.Namespace).
			Set("labels", pyjson.NewObj().Set("app.kubernetes.io/managed-by", "coolscaler-ui"))).
		Set("spec", spec)
	if _, err := e.k8sReq(ctx, "POST", e.ingressPath(), ing, "application/json"); err != nil {
		if code, ok := isHTTPError(err); ok && code == 409 { // exists — replace spec
			if _, perr := e.k8sPatch(ctx, e.ingressPath()+"/"+managedIngressName,
				pyjson.NewObj().Set("spec", spec)); perr != nil {
				return pyjson.NewObj().Set("ok", false).Set("error", perr.Error())
			}
		} else {
			return pyjson.NewObj().Set("ok", false).Set("error", err.Error())
		}
	}
	e.audit("CreateIngress", host, "", "", "user")
	return pyjson.NewObj().Set("ok", true).Set("name", managedIngressName).Set("host", host)
}

// IngressSettingsDelete is DELETE /api/settings/ingresses.
func (e *Engine) IngressSettingsDelete(ctx context.Context) *pyjson.Obj {
	if e.Cfg.ReadOnly {
		return pyjson.NewObj().Set("ok", false).Set("error", "Cluster is in Read-Only mode")
	}
	if _, err := e.k8sReq(ctx, "DELETE", e.ingressPath()+"/"+managedIngressName, nil, ""); err != nil {
		if code, ok := isHTTPError(err); ok && code == 404 {
			return pyjson.NewObj().Set("ok", true).Set("note", "no managed ingress")
		}
		return pyjson.NewObj().Set("ok", false).Set("error", err.Error())
	}
	e.audit("DeleteIngress", managedIngressName, "", "", "user")
	return pyjson.NewObj().Set("ok", true)
}

var _ = fmt.Sprintf // keep fmt if unused paths compile out
