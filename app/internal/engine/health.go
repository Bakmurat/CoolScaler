package engine

import (
	"context"
	"fmt"
	"time"

	"coolscaler.sh/coolscaler/internal/pyjson"
)

// NOTE: the "prometheus" boolean key gets OVERWRITTEN (in place, position 3) by the
// prometheus-server keyed entry
func (e *Engine) HealthData(ctx context.Context) *pyjson.Obj {
	comps := []struct{ name, kind string }{
		{"recommender", "deploy"}, {"dashboards", "deploy"}, {"agent", "deploy"},
		{"updater", "deploy"}, {"admissions", "deploy"}, {"kube-state-metrics", "deploy"},
		{"prometheus-server", "deploy"}, {"network-monitor", "ds"},
	}
	out := []any{}
	type compHealth struct {
		component    string
		ready, total int64
		healthy      bool
	}
	var checks []compHealth
	for _, c := range comps {
		name := "coolscaler-" + c.name
		var ready, total int64
		if c.kind == "deploy" {
			if d, err := e.Kube.GetJSON(ctx, "/apis/apps/v1/namespaces/"+e.Cfg.Namespace+"/deployments/"+name); err == nil {
				st := getObj(d, "status")
				ready, total = i64(st.GetD("readyReplicas", int64(0))), i64(st.GetD("replicas", int64(0)))
			}
		} else {
			if d, err := e.Kube.GetJSON(ctx, "/apis/apps/v1/namespaces/"+e.Cfg.Namespace+"/daemonsets/"+name); err == nil {
				st := getObj(d, "status")
				ready, total = i64(st.GetD("numberReady", int64(0))), i64(st.GetD("desiredNumberScheduled", int64(0)))
			}
		}
		healthy := total > 0 && ready >= total
		checks = append(checks, compHealth{c.name, ready, total, healthy})
		out = append(out, pyjson.NewObj().
			Set("component", c.name).
			Set("ready", ready).
			Set("total", total).
			Set("healthy", healthy))
	}
	allHealthy := len(checks) > 0
	for _, x := range checks {
		if !x.healthy {
			allHealthy = false
			break
		}
	}
	ret := pyjson.NewObj().
		Set("healthy", allHealthy).
		Set("components", out).
		Set("prometheus", e.Cfg.PrometheusURL != "").
		Set("clusterName", e.Cfg.ClusterName)
	keyed := map[string]string{
		"recommender": "recommender", "dashboards": "dashboard", "agent": "agentController",
		"updater": "updater", "admissions": "admissionController",
		"kube-state-metrics": "kubeStateMetrics", "prometheus-server": "prometheus",
		"network-monitor": "networkDaemon",
	}
	for _, x := range checks {
		k, ok := keyed[x.component]
		if !ok {
			k = x.component
		}
		reason := ""
		if !x.healthy {
			reason = fmt.Sprintf("%d/%d ready", x.ready, x.total)
		}
		ret.Set(k, pyjson.NewObj().
			Set("healthy", x.healthy).
			Set("reason", reason).
			Set("type", pyjson.NewObj().
				Set("ID", 0).
				Set("Status", "").
				Set("Immediate", false).
				Set("Message", "")))
	}
	return ret
}

// HealthCheckGauges returns the coolscaler_health_check_* gauge values (metric-name suffix →
// 1 healthy / 0 unhealthy).
func (e *Engine) HealthCheckGauges(ctx context.Context) map[string]float64 {
	suffix := map[string]string{
		"recommender": "recommender", "dashboards": "dashboards", "agent": "agent",
		"updater": "updater", "admissions": "admissions",
		"kube-state-metrics": "kube_state_metrics", "prometheus-server": "prometheus_server",
		"network-monitor": "network_monitor",
	}
	h := e.HealthData(ctx)
	out := map[string]float64{}
	comps, _ := h.GetD("components", nil).([]any)
	for _, cv := range comps {
		c := obj(cv)
		s, ok := suffix[str(c.GetD("component", ""))]
		if !ok {
			continue
		}
		if b, _ := c.GetD("healthy", false).(bool); b {
			out[s] = 1
		} else {
			out[s] = 0
		}
	}
	// Recommendation-freshness health: 1 when the recommender refreshed all
	// workloads recently, 0 when stale.
	e.mu.Lock()
	lu := e.lastUpdate
	e.mu.Unlock()
	fresh := 0.0
	if lu > 0 && time.Now().Unix()-lu < 300 {
		fresh = 1
	}
	out["workload_recommendations_update"] = fresh
	return out
}

// OverviewData is the /api/overview payload:
// {**STATE["overview"], "lastUpdate":..., "ready":..., "namespaces": [:12]}.
func (e *Engine) OverviewData() *pyjson.Obj {
	e.mu.Lock()
	defer e.mu.Unlock()
	out := pyjson.NewObj()
	if e.overview != nil {
		out = e.overview.Clone()
	}
	out.Set("lastUpdate", e.lastUpdate)
	out.Set("ready", e.ready)
	nss := []any{}
	for i, ns := range e.namespaces {
		if i >= 12 {
			break
		}
		nss = append(nss, pyjson.NewObj().
			Set("namespace", ns.namespace).
			Set("savings", ns.savings))
	}
	out.Set("namespaces", nss)
	return out
}

// WorkloadsData is the /api/workloads payload.
func (e *Engine) WorkloadsData() *pyjson.Obj {
	e.mu.Lock()
	defer e.mu.Unlock()
	rows := []any{}
	for _, w := range e.workloads {
		rows = append(rows, w.obj)
	}
	return pyjson.NewObj().
		Set("workloads", rows).
		Set("readOnly", e.Cfg.ReadOnly).
		Set("lastUpdate", e.lastUpdate).
		Set("dataSource", e.dataSource)
}

// VersionData is the /api/version payload.
func (e *Engine) VersionData() *pyjson.Obj {
	return pyjson.NewObj().
		Set("currentVersion", "v"+e.Cfg.Version).
		Set("namespace", e.Cfg.Namespace).
		Set("nextVersion", "v"+e.Cfg.Version).
		Set("shouldUpdate", false).
		Set("cloudProvider", "")
}
