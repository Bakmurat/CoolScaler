package engine

import (
	"context"
	"fmt"
	"time"

	"coolscaler.sh/coolscaler/internal/prom"
)

// timeZero is the "now" sentinel for instant queries.
func timeZero() time.Time { return time.Time{} }

// pcKey is the (namespace, pod, container) series key.
type pcKey struct {
	ns, pod, container string
}

// ppKey is the (namespace, pod) series key (JVM metrics).
type ppKey struct {
	ns, pod string
}

func (e *Engine) promQuery(ctx context.Context, promql string) []prom.Sample {
	if e.Prom == nil {
		return nil
	}
	samples, err := e.Prom.Query(ctx, promql, timeZero())
	if err != nil {
		e.Log.Info("prometheus query failed", "err", err)
		return nil
	}
	return samples
}

func (e *Engine) collectPC(ctx context.Context, promql string, into map[pcKey]float64) {
	for _, r := range e.promQuery(ctx, promql) {
		k := pcKey{r.Metric["namespace"], r.Metric["pod"], r.Metric["container"]}
		into[k] = r.Value
	}
}

// image!="" excludes the pause/sandbox container's accounting. CoolScaler's cAdvisor
// lacks it, so it's omitted.
func (e *Engine) promPercentiles(ctx context.Context) (map[pcKey]float64, map[pcKey]float64) {
	cpuQ := fmt.Sprintf(`quantile_over_time(%.2f, rate(container_cpu_usage_seconds_total{container!="",container!="POD",image!=""}[5m])[%s:%s])`,
		e.Cfg.CPUPercentile/100.0, e.Cfg.PromWindow, e.Cfg.PromStep)
	memQ := fmt.Sprintf(`quantile_over_time(%.2f, container_memory_working_set_bytes{container!="",container!="POD",image!=""}[%s:%s])`,
		e.Cfg.MemPercentile/100.0, e.Cfg.PromWindow, e.Cfg.PromStep)
	cpu, mem := map[pcKey]float64{}, map[pcKey]float64{}
	e.collectPC(ctx, cpuQ, cpu)
	e.collectPC(ctx, memQ, mem)
	return cpu, mem
}

// promDayFiltered returns per-(ns,pod,container) CPU/mem percentiles for ONE
// workload restricted to weekday vs weekend samples (Weekly-Optimization
// currentPeriods split). Uses PromQL day_of_week() to keep only the current
// period's range samples; empty maps when the period has no data (caller falls
// back to the full-window samples). CPU rate = milliless cores.
func (e *Engine) promDayFiltered(ctx context.Context, ns, name string, weekend bool) (map[pcKey]float64, map[pcKey]float64) {
	dayf := `(day_of_week() >= 1 and day_of_week() <= 5)` // weekday (Mon–Fri)
	if weekend {
		dayf = `(day_of_week() == 0 or day_of_week() == 6)` // Sun/Sat
	}
	sel := fmt.Sprintf(`container!="",container!="POD",image!="",namespace="%s",pod=~"%s-.*"`, ns, name)
	cpuQ := fmt.Sprintf(`quantile_over_time(%.2f, (rate(container_cpu_usage_seconds_total{%s}[5m]) and on() %s)[%s:%s])`,
		e.Cfg.CPUPercentile/100.0, sel, dayf, e.Cfg.PromWindow, e.Cfg.PromStep)
	memQ := fmt.Sprintf(`quantile_over_time(%.2f, (container_memory_working_set_bytes{%s} and on() %s)[%s:%s])`,
		e.Cfg.MemPercentile/100.0, sel, dayf, e.Cfg.PromWindow, e.Cfg.PromStep)
	cpu, mem := map[pcKey]float64{}, map[pcKey]float64{}
	e.collectPC(ctx, cpuQ, cpu)
	e.collectPC(ctx, memQ, mem)
	return cpu, mem
}

func (e *Engine) promEphemeral(ctx context.Context) map[pcKey]float64 {
	q := fmt.Sprintf(`quantile_over_time(%.2f, container_fs_usage_bytes{container!="",container!="POD",image!=""}[%s:%s])`,
		e.Cfg.EphPercentile/100.0, e.Cfg.EphWindow, e.Cfg.PromStep)
	out := map[pcKey]float64{}
	e.collectPC(ctx, q, out)
	return out
}

// Empty map when Java observability isn't collecting — callers fall back to
// the -Xmx estimate, never fabricate.
func (e *Engine) promJVM(ctx context.Context) map[ppKey]map[string]float64 {
	out := map[ppKey]map[string]float64{}
	if e.Prom == nil {
		return out
	}
	w := e.Cfg.PromWindow

	maxAgg := func(a, b float64) float64 {
		if a > b {
			return a
		}
		return b
	}
	replaceAgg := func(_, b float64) float64 { return b }

	collect := func(q, field string, agg func(a, b float64) float64) {
		for _, r := range e.promQuery(ctx, q) {
			ns, pod := r.Metric["namespace"], r.Metric["pod"]
			if ns == "" || pod == "" {
				continue
			}
			key := ppKey{ns, pod}
			cur, ok := out[key]
			if !ok {
				cur = map[string]float64{}
				out[key] = cur
			}
			if prev, ok := cur[field]; ok {
				cur[field] = agg(prev, r.Value)
			} else {
				cur[field] = r.Value
			}
		}
	}

	// Instant values first, then windowed refinements.
	collect(`java_lang_Memory_HeapMemoryUsage_used`, "heapP90", maxAgg)
	collect(`java_lang_Memory_HeapMemoryUsage_used`, "heapMax", maxAgg)
	collect(`java_lang_Memory_HeapMemoryUsage_committed`, "heapCommitted", maxAgg)
	collect(`java_lang_Memory_HeapMemoryUsage_max`, "heapCeiling", maxAgg)
	collect(`java_lang_Memory_NonHeapMemoryUsage_used`, "nonHeapUsed", maxAgg)
	collect(fmt.Sprintf(`quantile_over_time(0.90, java_lang_Memory_HeapMemoryUsage_used[%s:1m])`, w), "heapP90", replaceAgg)
	collect(fmt.Sprintf(`max_over_time(java_lang_Memory_HeapMemoryUsage_used[%s:1m])`, w), "heapMax", maxAgg)
	collect(fmt.Sprintf(`quantile_over_time(0.90, java_lang_Memory_NonHeapMemoryUsage_used[%s:1m])`, w), "nonHeapUsed", replaceAgg)
	collect(`sum by (namespace,pod) (rate(jvm_gc_collection_seconds_sum[5m]))`, "gcSecondsRate", maxAgg)
	return out
}

func (e *Engine) promSignals(ctx context.Context) map[string]map[pcKey]float64 {
	out := map[string]map[pcKey]float64{
		"throttle": {}, "maxcpu": {}, "psiCpu": {}, "psiMem": {},
	}
	if e.Prom == nil {
		return out
	}
	// Divide only over series with a positive CFS period rate (`... > 0`) so
	// idle/unlimited containers drop out cleanly.
	tq := `sum by (namespace,pod,container) ` +
		`(rate(container_cpu_cfs_throttled_periods_total{container!="",container!="POD",image!=""}[5m])) ` +
		`/ (sum by (namespace,pod,container) ` +
		`(rate(container_cpu_cfs_periods_total{container!="",container!="POD",image!=""}[5m])) > 0)`
	e.collectPC(ctx, tq, out["throttle"])
	mq := fmt.Sprintf(`max_over_time(rate(container_cpu_usage_seconds_total{container!="",container!="POD",image!=""}[1m])[%s:%s])`,
		e.Cfg.PromWindow, e.Cfg.PromStep)
	e.collectPC(ctx, mq, out["maxcpu"])
	for _, sig := range []struct{ res, metric string }{
		{"psiCpu", "container_pressure_cpu_waiting_seconds_total"},
		{"psiMem", "container_pressure_memory_waiting_seconds_total"},
	} {
		pq := fmt.Sprintf(`max by (namespace,pod,container) (rate(%s{container!="",container!="POD",image!=""}[5m]))`, sig.metric)
		e.collectPC(ctx, pq, out[sig.res])
	}
	return out
}
