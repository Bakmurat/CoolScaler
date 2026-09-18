package engine

import (
	"context"
	"strings"

	"coolscaler.sh/coolscaler/internal/pyjson"
)

const hoursPerMonth = 730.0

var instanceHourly = map[string]float64{
	"t3.medium": 0.0416, "t3.large": 0.0832, "t3.xlarge": 0.1664, "t3.2xlarge": 0.3328,
	"t3a.large": 0.0752, "t3a.xlarge": 0.1504,
	"m5.large": 0.096, "m5.xlarge": 0.192, "m5.2xlarge": 0.384, "m5.4xlarge": 0.768,
	"m6i.large": 0.096, "m6i.xlarge": 0.192, "m6i.2xlarge": 0.384,
	"c5.large": 0.085, "c5.xlarge": 0.17, "c5.2xlarge": 0.34, "c5.4xlarge": 0.68,
	"c6i.large": 0.085, "c6i.xlarge": 0.17,
	"r5.large": 0.126, "r5.xlarge": 0.252, "r5.2xlarge": 0.504,
	"r6i.large": 0.126, "r6i.xlarge": 0.252,
}

func (e *Engine) monthlyCost(cpuCores, memBytes float64) float64 {
	return cpuCores*e.costCPUCoreMonth + (memBytes/(1<<30))*e.costMemGBMonth
}

func (e *Engine) nodeMonthlyCost(instanceType string, isSpot bool, allocCPU, allocMem float64, gpus float64) (float64, string) {
	spotMul := 1.0
	if isSpot {
		spotMul = e.spotFraction
	}
	gpuCost := gpus * e.costGPUHourly * hoursPerMonth * spotMul
	hourly, ok := instanceHourly[strings.ToLower(instanceType)]
	if ok && hourly != 0 {
		if isSpot {
			hourly *= e.spotFraction
		}
		if isSpot {
			return hourly*hoursPerMonth + gpuCost, "spot"
		}
		return hourly*hoursPerMonth + gpuCost, "on-demand"
	}
	pricedBy := "resource-model"
	if gpus != 0 {
		pricedBy = "gpu-resource-model"
	}
	return e.monthlyCost(allocCPU, allocMem) + gpuCost, pricedBy
}

func (e *Engine) CostConfigData() *pyjson.Obj {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.costConfigDataLocked()
}

func (e *Engine) costConfigDataLocked() *pyjson.Obj {
	manual := pyjson.NewObj().
		Set("cpu", pyjson.Round(e.costCPUCoreMonth/hoursPerMonth, 6)).
		Set("memory", pyjson.Round(e.costMemGBMonth/hoursPerMonth, 6)).
		Set("gpu", pyjson.Round(e.costGPUHourly, 6))
	var spot *pyjson.Obj
	if e.costSpotHourly != nil {
		spot = e.costSpotHourly.Clone()
	} else {
		spot = pyjson.NewObj().
			Set("cpu", pyjson.Round(f64d(manual.GetD("cpu", 0.0), 0)*e.spotFraction, 6)).
			Set("memory", pyjson.Round(f64d(manual.GetD("memory", 0.0), 0)*e.spotFraction, 6)).
			Set("gpu", pyjson.Round(f64d(manual.GetD("gpu", 0.0), 0)*e.spotFraction, 6))
	}
	return pyjson.NewObj().
		Set("costConfig", pyjson.NewObj().
			Set("includeUnallocatedCost", e.includeUnallocatedCost).
			Set("customResourcesPricing", pyjson.NewObj().
				Set("manual", manual).
				Set("manual-spot", spot))).
		Set("isParent", false)
}

func (e *Engine) applyCostConfig(cfg *pyjson.Obj) {
	if cfg == nil {
		return
	}
	crp := getObj(cfg, "customResourcesPricing")
	man := getObj(crp, "manual")
	if v := man.GetD("cpu", nil); truthy(v) {
		if f, ok := toFloatLoose(v); ok {
			e.costCPUCoreMonth = f * hoursPerMonth
		}
	}
	if v := man.GetD("memory", nil); truthy(v) {
		if f, ok := toFloatLoose(v); ok {
			e.costMemGBMonth = f * hoursPerMonth
		}
	}
	if v := man.GetD("gpu", nil); truthy(v) {
		if f, ok := toFloatLoose(v); ok {
			e.costGPUHourly = f
		}
	}
	sp := getObj(crp, "manual-spot")
	if sp.Len() > 0 {
		saved := pyjson.NewObj()
		for _, k := range sp.Keys() {
			v := sp.GetD(k, nil)
			if v == nil || v == "" {
				continue
			}
			if f, ok := toFloatLoose(v); ok {
				saved.Set(k, f)
			}
		}
		e.costSpotHourly = saved
		spCPU := f64d(saved.GetD("cpu", nil), 0)
		manCPU, okMan := toFloatLoose(man.GetD("cpu", nil))
		if spCPU != 0 && truthy(man.GetD("cpu", nil)) && okMan && manCPU > 0 {
			e.spotFraction = spCPU / manCPU
		}
	}
	if v, ok := cfg.Get("includeUnallocatedCost"); ok {
		e.includeUnallocatedCost = truthy(v)
	}
}

// Read-only, errors swallowed.
func (e *Engine) loadCostCM(ctx context.Context) {
	cm, err := e.Kube.GetJSON(ctx, "/api/v1/namespaces/"+e.Cfg.Namespace+"/configmaps/coolscaler-cost-config")
	if err != nil {
		return
	}
	raw := getStr(getObj(cm, "data"), "config.json")
	if raw == "" {
		raw = "{}"
	}
	v, err := pyjson.Decode([]byte(raw))
	if err != nil {
		return
	}
	data, ok := v.(*pyjson.Obj)
	if !ok || data.Len() == 0 {
		return
	}
	e.mu.Lock()
	e.applyCostConfig(data)
	e.mu.Unlock()
	e.Log.Info("loaded cost-config from ConfigMap")
}

// numeric strings.
func toFloatLoose(v any) (float64, bool) {
	if f, ok := f64(v); ok {
		return f, true
	}
	if s, ok := v.(string); ok {
		return parseFloatPy(s)
	}
	return 0, false
}
