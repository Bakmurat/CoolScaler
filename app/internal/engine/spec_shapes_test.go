package engine

import (
	"strings"
	"testing"

	"coolscaler.sh/coolscaler/internal/pyjson"
)

// --- HpaPolicy spec shape -----------------------------------------------

func TestHpapolicySpecShape(t *testing.T) {
	kb := pyjson.NewObj().
		Set("capByOrigin", true).Set("minAllowed", 1).
		Set("setMin", 3).Set("setMax", 9).Set("keepMin", true).
		Set("genEnabled", true).Set("genPct", 80).Set("genWindow", "168h").
		Set("predEnabled", true).Set("predPct", 80).Set("predWindow", "168h").
		Set("predictionEnabled", true).Set("lookAhead", "20m").
		Set("thresholdEnabled", false).Set("maxDeviation", 50).
		Set("requiredHistory", 4).Set("thHistoryWindow", "168h").
		Set("coverage", "24h").Set("headroom", 0)
	spec := hpapolicySpec(kb)
	po := getObj(spec, "policyOptimize")
	mr := getObj(po, "minReplicas")
	if mr.Has("setMaxReplicas") || mr.Has("keepMinReplicas") || mr.Has("keepMaxReplicas") {
		t.Fatalf("legacy invented keys still under minReplicas: %s", pyjson.Marshal(mr))
	}
	if got := i64(getObj(po, "maxReplicas").GetD("setMaxReplicas", int64(0))); got != 9 {
		t.Fatalf("maxReplicas.setMaxReplicas = %d, want 9", got)
	}
	for _, class := range []string{"generalWorkloads", "predictableWorkloads"} {
		if !truthy(getObj(mr, class).GetD("keepMinReplicas", nil)) {
			t.Fatalf("%s.keepMinReplicas not set", class)
		}
	}
}

func TestHpapolicyKnobsFromSpecAndLegacy(t *testing.T) {
	spec := pyjson.NewObj().Set("policyOptimize", pyjson.NewObj().
		Set("minReplicas", pyjson.NewObj().
			Set("minAllowed", 2).
			Set("generalWorkloads", pyjson.NewObj().Set("enabled", true).Set("keepMinReplicas", true)).
			Set("predictableWorkloads", pyjson.NewObj().Set("enabled", true))).
		Set("maxReplicas", pyjson.NewObj().Set("setMaxReplicas", 7)))
	kb := hpapolicyKnobsFromSpec(spec)
	if i64(kb.GetD("setMax", int64(0))) != 7 {
		t.Fatalf("spec shape: setMax = %v, want 7", kb.GetD("setMax", nil))
	}
	if !truthy(kb.GetD("keepMin", nil)) {
		t.Fatal("spec shape: keepMin not read from generalWorkloads")
	}
	// legacy invented shape (older CRs must stay readable)
	legacy := pyjson.NewObj().Set("policyOptimize", pyjson.NewObj().
		Set("minReplicas", pyjson.NewObj().
			Set("minAllowed", 2).
			Set("setMaxReplicas", 5).
			Set("keepMinReplicas", true).
			Set("generalWorkloads", pyjson.NewObj().Set("enabled", true)).
			Set("predictableWorkloads", pyjson.NewObj().Set("enabled", true))))
	kb = hpapolicyKnobsFromSpec(legacy)
	if i64(kb.GetD("setMax", int64(0))) != 5 {
		t.Fatalf("legacy shape: setMax = %v, want 5", kb.GetD("setMax", nil))
	}
	if !truthy(kb.GetD("keepMin", nil)) {
		t.Fatal("legacy shape: keepMin not read")
	}
}

func TestHpaScheduleFromSpec(t *testing.T) {
	spec := pyjson.NewObj().Set("schedulePolicy", pyjson.NewObj().
		Set("schedulePolicyConfig", pyjson.NewObj().
			Set("defaultPolicy", "cost").
			Set("rules", []any{pyjson.NewObj().
				Set("policyName", "performance").
				Set("periods", []any{pyjson.NewObj().
					Set("weeklyConfig", pyjson.NewObj().
						Set("days", []any{int64(0), int64(1)}).
						Set("beginTime", "09:00").
						Set("endTime", "17:00"))})})))
	s := hpaScheduleFromSpec(spec)
	if s == nil {
		t.Fatal("spec shape not detected")
	}
	if got := str(s.GetD("defaultPolicy", "")); got != "cost" {
		t.Fatalf("defaultPolicy = %q", got)
	}
	r0 := obj(getList(s, "rules")[0])
	if str(r0.GetD("policyName", "")) != "performance" ||
		str(r0.GetD("beginTime", "")) != "09:00" || len(getList(r0, "days")) != 2 {
		t.Fatalf("rule not flattened: %s", pyjson.Marshal(r0))
	}
	// legacy flat shape
	legacy := pyjson.NewObj().Set("schedule", pyjson.NewObj().
		Set("defaultPolicy", "production").Set("rules", []any{}))
	if s := hpaScheduleFromSpec(legacy); s == nil || str(s.GetD("defaultPolicy", "")) != "production" {
		t.Fatal("legacy spec.schedule not readable")
	}
	// knob policy: no schedule at all
	if hpaScheduleFromSpec(pyjson.NewObj()) != nil {
		t.Fatal("knob spec misdetected as schedule")
	}
}

// --- self-protection overridePolicies -----------------------------------

func TestSelfOverridePolicies(t *testing.T) {
	op := selfOverridePolicies("coolscaler-system", "coolscaler-updater", "coolscaler-system")
	if op == nil {
		t.Fatal("updater override missing")
	}
	rc := getObj(getObj(op, "rightSizePolicy"), "requestsConfigs")
	if str(getObj(rc, "cpu").GetD("minAllowed", "")) != "50m" ||
		str(getObj(rc, "memory").GetD("minAllowed", "")) != "200Mi" {
		t.Fatalf("updater minAllowed wrong: %s", pyjson.Marshal(op))
	}
	if i64(getObj(op, "updatePolicy").GetD("minReplicas", int64(-1))) != 0 {
		t.Fatal("updater updatePolicy.minReplicas != 0")
	}
	// netmon: explicit empty configs, no updatePolicy
	op = selfOverridePolicies("coolscaler-system", "coolscaler-network-monitor", "coolscaler-system")
	rc = getObj(getObj(op, "rightSizePolicy"), "requestsConfigs")
	if getObj(rc, "cpu").Len() != 0 || getObj(rc, "memory").Len() != 0 || op.Has("updatePolicy") {
		t.Fatalf("netmon override wrong: %s", pyjson.Marshal(op))
	}
	// foreign namespace/workload: nil
	if selfOverridePolicies("default", "coolscaler-updater", "coolscaler-system") != nil ||
		selfOverridePolicies("coolscaler-system", "some-app", "coolscaler-system") != nil {
		t.Fatal("override leaked outside own components")
	}
}

// --- daemonsetnodesize naming -------------------------------------------

func TestDsNodeSizeNameRoundTrip(t *testing.T) {
	full := dsNodeSizeName("coolscaler-network-monitor", "4core8gib")
	if !strings.HasPrefix(full, "coolscaler-network-monitor-4core8gib-") {
		t.Fatalf("name = %q", full)
	}
	hash := full[strings.LastIndex(full, "-")+1:]
	if len(hash) != 10 {
		t.Fatalf("hash %q not 10 hex chars", hash)
	}
	if got := dsNameFromNodeSizeRef(full); got != "coolscaler-network-monitor" {
		t.Fatalf("reverse parse = %q", got)
	}
	// dashed instance-type buckets must collapse to one dash-free token
	full = dsNodeSizeName("kube-proxy", "t3.medium")
	if got := dsNameFromNodeSizeRef(full); got != "kube-proxy" {
		t.Fatalf("dashed bucket reverse parse = %q (full %q)", got, full)
	}
}

// --- encoders ------------------------------------------------------------

func TestGzb64RoundTrip(t *testing.T) {
	pts := []any{pyjson.NewObj().Set("Value", 1.5).Set("Timestamp", int64(1781730900))}
	raw, err := gunzipB64(gzb64(pts))
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != `[{"Value": 1.5, "Timestamp": 1781730900}]` {
		t.Fatalf("round trip = %s", raw)
	}
}

func TestAuditKeyFromISO(t *testing.T) {
	k := auditKeyFromISO("2026-06-17T20:16:16Z", 3)
	if k != "06-17-2026 20:16:16.000000003" {
		t.Fatalf("audit key = %q", k)
	}
}


func TestNsEntryMatches(t *testing.T) {
	cases := []struct {
		entry, ns string
		want      bool
	}{
		{"kube-system", "kube-system", true},
		{"kube-system", "kube-system2", false},
		{"openshift.*", "openshift-monitoring", true},
		{"openshift.*", "openshift", true},
		{"openshift.*", "my-openshift", false}, // anchored
		{"trident", "trident", true},
		{"cluster-autoscaler", "cluster-autoscaler", true},
	}
	for _, c := range cases {
		if got := nsEntryMatches(c.entry, c.ns); got != c.want {
			t.Errorf("nsEntryMatches(%q,%q) = %v, want %v", c.entry, c.ns, got, c.want)
		}
	}
}
