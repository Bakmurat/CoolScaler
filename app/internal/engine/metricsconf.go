package engine

// metricsconf.go

import (
	"context"

	"coolscaler.sh/coolscaler/internal/pyjson"
)

const metricsConfCM = "coolscaler-metrics-conf"

func metricsConfSeed() []any {
	return []any{
		pyjson.NewObj().
			Set("name", "Total HTTP Req/m").
			Set("promQuery", `sum(rate(http_requests_total{<<SELECTOR>>}[1m]))*60`).
			Set("Labels", []any{"job"}),
		pyjson.NewObj().
			Set("name", "HTTP Latency p99").
			Set("promQuery", `histogram_quantile(0.99,sum(rate(http_latency_ms_bucket{<<SELECTOR>>}[5m])) by (le))`).
			Set("Labels", []any{"job"}),
	}
}

// metricsConfLoad reads the CM list (seeding the CM on first access).
func (e *Engine) metricsConfLoad(ctx context.Context) []any {
	cm := e.getCM(ctx, metricsConfCM)
	if cm == nil {
		seed := metricsConfSeed()
		e.metricsConfPersist(ctx, seed)
		return seed
	}
	raw := getStr(getObj(cm, "data"), "metricsConfiguration")
	if raw == "" {
		return []any{}
	}
	v, err := pyjson.Decode([]byte(raw))
	if err != nil {
		return []any{}
	}
	if l, ok := v.([]any); ok {
		return l
	}
	return []any{}
}

func (e *Engine) metricsConfPersist(ctx context.Context, list []any) {
	e.upsertCM(ctx, metricsConfCM, nil, pyjson.NewObj().
		Set("metricsConfiguration", string(pyjson.Marshal(list))).
		Set("promEndpoint", ""), nil)
}

// MetricsConfList is GET /api/metricsConf/.
func (e *Engine) MetricsConfList(ctx context.Context) *pyjson.Obj {
	return pyjson.NewObj().Set("metricsConf", e.metricsConfLoad(ctx))
}

// MetricsConfUpdate is PUT /api/metricsConf/update — upsert by name.
func (e *Engine) MetricsConfUpdate(ctx context.Context, mc *pyjson.Obj) *pyjson.Obj {
	name := getStr(mc, "name")
	if name == "" {
		return e.MetricsConfList(ctx)
	}
	entry := pyjson.NewObj().
		Set("name", name).
		Set("promQuery", mc.GetD("promQuery", "")).
		Set("Labels", mc.GetD("Labels", []any{}))
	list := e.metricsConfLoad(ctx)
	replaced := false
	for i, v := range list {
		if getStr(obj(v), "name") == name {
			list[i] = entry
			replaced = true
			break
		}
	}
	if !replaced {
		list = append(list, entry)
	}
	e.metricsConfPersist(ctx, list)
	e.audit("UpdateMetricConf", name, "", "", "user")
	return pyjson.NewObj().Set("metricsConf", list)
}

// MetricsConfRemove is PUT /api/metricsConf/remove.
func (e *Engine) MetricsConfRemove(ctx context.Context, name string) *pyjson.Obj {
	list := e.metricsConfLoad(ctx)
	out := make([]any, 0, len(list))
	for _, v := range list {
		if getStr(obj(v), "name") != name {
			out = append(out, v)
		}
	}
	e.metricsConfPersist(ctx, out)
	e.audit("RemoveMetricConf", name, "", "", "user")
	return pyjson.NewObj().Set("metricsConf", out)
}

func (e *Engine) DashboardAggregatedOverview() *pyjson.Obj {
	e.mu.Lock()
	defer e.mu.Unlock()
	type agg struct {
		cost, sav, cpu, mem float64
		n, auto             int
	}
	byNs := map[string]*agg{}
	var order []string
	for _, w := range e.workloads {
		if w.kind == "Node" {
			continue
		}
		a := byNs[w.namespace]
		if a == nil {
			a = &agg{}
			byNs[w.namespace] = a
			order = append(order, w.namespace)
		}
		reps := float64(w.replicas)
		if reps < 1 {
			reps = 1
		}
		a.cost += f64d(w.obj.GetD("monthlyCost", 0.0), 0)
		a.sav += f64d(w.obj.GetD("savings", 0.0), 0)
		a.cpu += f64d(w.obj.GetD("reqCpu", 0.0), 0) * reps
		a.mem += f64d(w.obj.GetD("reqMem", 0.0), 0) * reps
		a.n++
		if w.automated {
			a.auto++
		}
	}
	sortStrings(order)
	rows := []any{}
	for _, ns := range order {
		a := byNs[ns]
		pct := 0
		if a.n > 0 {
			pct = int(float64(a.auto)/float64(a.n)*100 + 0.5)
		}
		rows = append(rows, pyjson.NewObj().
			Set("name", ns).
			Set("totalCost", pyjson.Round(a.cost, 2)).
			Set("savingsAvailable", pyjson.Round(a.sav, 2)).
			Set("cpuRequest", pyjson.Round(a.cpu, 2)).
			Set("memoryRequest", a.mem).
			Set("workloads", a.n).
			Set("automationPercent", pct))
	}
	return pyjson.NewObj().Set("aggregations", rows)
}
