package engine

// alertsettings.go

import (
	"context"

	"coolscaler.sh/coolscaler/internal/pyjson"
)

const alertSettingsCM = "coolscaler-alert-settings"

type alertSeed struct {
	name, description, severity      string
	interval, window, threshold, step string
}

func alertSettingsSeed() []alertSeed {
	rows := []alertSeed{
		{"Node Utilization", "Node CPU or memory utilization above threshold", "High", "10m", "15m", "95", ""},
		{"Out Of Memory", "OOM events observed for a workload", "High", "10m", "1h", "5", ""},
		{"Under Provisioned", "Workloads whose requests are below the recommendation", "Medium", "10m", "1d", "40", ""},
		{"Over Provisioned", "Workloads whose requests are far above the recommendation", "Low", "10m", "1d", "70", ""},
		{"Pod Failed Create Event", "FailedCreate events for workload pods", "High", "10m", "5m", "5", ""},
		{"CPU Throttling", "Containers throttled above threshold of CPU time", "Medium", "10m", "15m", "90", ""},
		{"Workload Request Increase", "Workload request grew beyond threshold", "Low", "10m", "1d", "300", ""},
	}
	for _, res := range []string{
		"count/replicasets.apps", "limits.cpu", "limits.memory", "pods",
		"replicationcontrollers", "requests.cpu", "requests.memory", "services",
	} {
		rows = append(rows, alertSeed{
			"Resource Quota: " + res, "Namespace usage above threshold of the hard quota",
			"Low", "10m", "15m", "95", ""})
	}
	return rows
}

func alertSeedObj(a alertSeed) *pyjson.Obj {
	params := pyjson.NewObj().
		Set("interval", a.interval).
		Set("window", a.window).
		Set("threshold", a.threshold)
	if a.step != "" {
		params.Set("step", a.step)
	}
	return pyjson.NewObj().
		Set("name", a.name).
		Set("description", a.description).
		Set("slackFrequency", 10).
		Set("isSystemAlert", true).
		Set("alertSettings", pyjson.NewObj().
			Set("enabled", true).
			Set("severity", a.severity).
			Set("parameters", params))
}

func (e *Engine) alertSettingsLoad(ctx context.Context) []any {
	cm := e.getCM(ctx, alertSettingsCM)
	if cm != nil {
		raw := getStr(getObj(cm, "data"), "alerts")
		if raw != "" {
			if v, err := pyjson.Decode([]byte(raw)); err == nil {
				if l, ok := v.([]any); ok && len(l) > 0 {
					return l
				}
			}
		}
	}
	seed := []any{}
	for _, a := range alertSettingsSeed() {
		seed = append(seed, alertSeedObj(a))
	}
	e.alertSettingsPersist(ctx, seed)
	return seed
}

func (e *Engine) alertSettingsPersist(ctx context.Context, list []any) {
	e.upsertCM(ctx, alertSettingsCM, nil, pyjson.NewObj().
		Set("alerts", string(pyjson.Marshal(list))), nil)
}

// AlertSettingsTable is GET /api/alerts/settings.
func (e *Engine) AlertSettingsTable(ctx context.Context) *pyjson.Obj {
	return pyjson.NewObj().Set("alerts", e.alertSettingsLoad(ctx))
}

// key ∈
// interval|step|threshold|window|enabled|severity|slackFrequency.
func (e *Engine) AlertSettingsModify(ctx context.Context, body *pyjson.Obj) *pyjson.Obj {
	list := e.alertSettingsLoad(ctx)
	for _, mv := range getList(body, "modifications") {
		m := obj(mv)
		name := getStr(m, "name")
		if name == "" {
			name = getStr(m, "type")
		}
		key := getStr(m, "key")
		raw := str(getObj(m, "value").GetD("raw", ""))
		if name == "" || key == "" {
			continue
		}
		for _, av := range list {
			a := obj(av)
			if getStr(a, "name") != name {
				continue
			}
			st := getObj(a, "alertSettings")
			switch key {
			case "enabled":
				st.Set("enabled", raw == "true")
			case "severity":
				st.Set("severity", raw)
			case "slackFrequency":
				if n, err := pyInt(raw); err == nil {
					a.Set("slackFrequency", n)
				}
			case "interval", "window", "threshold", "step":
				getObj(st, "parameters").Set(key, raw)
			}
		}
	}
	e.alertSettingsPersist(ctx, list)
	e.audit("UpdateAlertSettings", "alerts", "", "", "user")
	return pyjson.NewObj().Set("alerts", list)
}
