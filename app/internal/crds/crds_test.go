package crds

import (
	"os"
	"reflect"
	"strings"
	"testing"

	"sigs.k8s.io/yaml"
)

// TestLoad ensures every embedded CRD manifest parses and looks like a CRD.
func TestLoad(t *testing.T) {
	list, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(list) != 12 {
		t.Fatalf("expected 12 embedded CRDs, got %d", len(list))
	}
	for _, crd := range list {
		if crd.Obj["kind"] != "CustomResourceDefinition" {
			t.Errorf("%s: kind = %v", crd.Name, crd.Obj["kind"])
		}
		if crd.Obj["apiVersion"] != "apiextensions.k8s.io/v1" {
			t.Errorf("%s: apiVersion = %v", crd.Name, crd.Obj["apiVersion"])
		}
		spec, ok := crd.Obj["spec"].(map[string]any)
		if !ok {
			t.Fatalf("%s: no spec", crd.Name)
		}
		if spec["group"] != "analysis.coolscaler.sh" {
			t.Errorf("%s: group = %v", crd.Name, spec["group"])
		}
	}
}

// byPlural indexes the loaded CRDs by their plural (filename base).
func byPlural(t *testing.T) map[string]map[string]any {
	t.Helper()
	list, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	out := map[string]map[string]any{}
	for _, crd := range list {
		out[strings.SplitN(crd.Name, ".", 2)[0]] = crd.Obj
	}
	return out
}

func dig(obj map[string]any, path ...string) any {
	var cur any = obj
	for _, p := range path {
		m, ok := cur.(map[string]any)
		if !ok {
			return nil
		}
		cur = m[p]
	}
	return cur
}

func v0(obj map[string]any) map[string]any {
	vers, _ := dig(obj, "spec", "versions").([]any)
	if len(vers) == 0 {
		return nil
	}
	m, _ := vers[0].(map[string]any)
	return m
}

func TestCRDPolish(t *testing.T) {
	crds := byPlural(t)

	wantShort := map[string]string{
		"policies":                "policy",
		"recommendations":         "recommend",
		"hpapolicies":             "hpapolicy",
		"downscalerpolicies":      "dspolicy",
		"downscaleconfigurations": "downscaleconfig",
		"podschedulingpolicies":   "podschedulingpolicy",
		"spotpolicies":            "spotpolicy",
		"gpupolicies":             "gpupolicy",
		"gpumemorypolicies":       "gpumemorypolicy",
		"automatednamespaces":     "ans",
		"autohealings":            "ah",
		"customownergroupings":    "cog",
	}
	for plural, short := range wantShort {
		obj, ok := crds[plural]
		if !ok {
			t.Fatalf("missing CRD %s", plural)
		}
		got, _ := dig(obj, "spec", "names", "shortNames").([]any)
		if len(got) != 1 || got[0] != short {
			t.Errorf("%s: shortNames = %v, want [%s]", plural, got, short)
		}
		// controller-gen annotation
		if a := dig(obj, "metadata", "annotations", "controller-gen.kubebuilder.io/version"); a != "v0.17.2" {
			t.Errorf("%s: controller-gen annotation = %v", plural, a)
		}
		// explicit listKind = kind + "List"
		kind, _ := dig(obj, "spec", "names", "kind").(string)
		if lk := dig(obj, "spec", "names", "listKind"); lk != kind+"List" {
			t.Errorf("%s: listKind = %v, want %sList", plural, lk, kind)
		}
		// conversion: {strategy: None}
		if s := dig(obj, "spec", "conversion", "strategy"); s != "None" {
			t.Errorf("%s: conversion.strategy = %v", plural, s)
		}
	}

	// Status subresource ONLY on CustomOwnerGrouping.
	for plural, obj := range crds {
		sub, _ := v0(obj)["subresources"].(map[string]any)
		_, hasStatus := sub["status"]
		if plural == "customownergroupings" && !hasStatus {
			t.Errorf("customownergroupings: missing status subresource")
		}
		if plural != "customownergroupings" && hasStatus {
			t.Errorf("%s: unexpected status subresource", plural)
		}
	}

	wantCols := map[string]int{"recommendations": 9, "autohealings": 2, "automatednamespaces": 8}
	for plural, obj := range crds {
		cols, _ := v0(obj)["additionalPrinterColumns"].([]any)
		want := wantCols[plural]
		if len(cols) != want {
			t.Errorf("%s: %d printer columns, want %d", plural, len(cols), want)
		}
		for _, cv := range cols {
			c, _ := cv.(map[string]any)
			if p, _ := c["priority"].(float64); p != 1 {
				t.Errorf("%s: column %v priority = %v, want 1", plural, c["name"], c["priority"])
			}
		}
	}
	// Recommendation gained the gpuMemoryPolicyName column.
	recCols, _ := v0(crds["recommendations"])["additionalPrinterColumns"].([]any)
	found := false
	for _, cv := range recCols {
		if c, _ := cv.(map[string]any); c["jsonPath"] == ".spec.gpuMemoryPolicyName" {
			found = true
		}
	}
	if !found {
		t.Errorf("recommendations: missing .spec.gpuMemoryPolicyName printer column")
	}

	// CEL rules + required[name] on both downscale kinds.
	for _, plural := range []string{"downscalerpolicies", "downscaleconfigurations"} {
		spec := dig(crds[plural], "spec").(map[string]any)
		_ = spec
		sspec, _ := dig(v0(crds[plural]), "schema", "openAPIV3Schema", "properties", "spec").(map[string]any)
		rules, _ := sspec["x-kubernetes-validations"].([]any)
		if len(rules) != 2 {
			t.Errorf("%s: %d CEL rules, want 2", plural, len(rules))
		} else {
			msgs := []string{}
			for _, rv := range rules {
				r, _ := rv.(map[string]any)
				msgs = append(msgs, r["message"].(string))
			}
			want := []string{"replicas must be 0 when sleep is enabled", "minReplicas must be at least 1"}
			if !reflect.DeepEqual(msgs, want) {
				t.Errorf("%s: CEL messages = %v", plural, msgs)
			}
		}
		req, _ := sspec["required"].([]any)
		if len(req) != 1 || req[0] != "name" {
			t.Errorf("%s: spec.required = %v, want [name]", plural, req)
		}
	}

	// DownscaleConfiguration defaults.
	dcProps, _ := dig(v0(crds["downscaleconfigurations"]), "schema", "openAPIV3Schema", "properties", "spec", "properties").(map[string]any)
	for f, want := range map[string]any{"enabled": true, "hpaEnabled": true, "nonHpaEnabled": true, "minReplicas": float64(1), "replicas": float64(1), "sleep": false} {
		if d := dig(dcProps, f, "default"); !reflect.DeepEqual(d, want) {
			t.Errorf("downscaleconfigurations: spec.%s default = %v, want %v", f, d, want)
		}
	}

	// Policy typed enums/defaults.
	polSpec, _ := dig(v0(crds["policies"]), "schema", "openAPIV3Schema", "properties", "spec").(map[string]any)
	if en, _ := dig(polSpec, "properties", "type", "enum").([]any); !reflect.DeepEqual(en, []any{"Optimize", "Schedule"}) {
		t.Errorf("policies: spec.type enum = %v", en)
	}
	if d := dig(polSpec, "properties", "type", "default"); d != "Optimize" {
		t.Errorf("policies: spec.type default = %v", d)
	}
	if en, _ := dig(polSpec, "properties", "updatePolicy", "properties", "updateMode", "enum").([]any); !reflect.DeepEqual(en, []any{"Ongoing", "OnCreate", "Inplace"}) {
		t.Errorf("policies: updateMode enum = %v", en)
	}
	if d := dig(polSpec, "properties", "policyOptimize", "properties", "rightSizePolicy", "properties", "nodeCappingPolicy", "properties", "nodeCappingAuto", "default"); d != true {
		t.Errorf("policies: nodeCappingAuto default = %v", d)
	}
	if d, _ := dig(polSpec, "properties", "hpa", "default").(map[string]any); d["manageHPA"] != true {
		t.Errorf("policies: hpa default = %v", d)
	}
	// The typed sub-objects must keep preserve-unknown-fields (CRD-pruning gotcha).
	for _, path := range [][]string{
		{"properties", "policyOptimize"},
		{"properties", "policyOptimize", "properties", "rightSizePolicy"},
		{"properties", "policyOptimize", "properties", "rightSizePolicy", "properties", "nodeCappingPolicy"},
		{"properties", "updatePolicy"},
		{"properties", "hpa"},
	} {
		if p := dig(polSpec, append(path, "x-kubernetes-preserve-unknown-fields")...); p != true {
			t.Errorf("policies: %v missing x-kubernetes-preserve-unknown-fields", path)
		}
	}

	// Recommendation spec.required.
	recSpec, _ := dig(v0(crds["recommendations"]), "schema", "openAPIV3Schema", "properties", "spec").(map[string]any)
	if req, _ := recSpec["required"].([]any); !reflect.DeepEqual(req, []any{"automationExcluded", "targetRef"}) {
		t.Errorf("recommendations: spec.required = %v", req)
	}
	if d := dig(recSpec, "properties", "automationExcluded", "default"); d != false {
		t.Errorf("recommendations: automationExcluded default = %v", d)
	}
}

// TestChartSync asserts the embedded copies stay identical to the chart's
// crds.yaml (Helm label include replaced by the static label pair).
func TestChartSync(t *testing.T) {
	raw, err := os.ReadFile("../../../charts/coolscaler/templates/crds.yaml")
	if err != nil {
		t.Skipf("chart crds.yaml not readable: %v", err)
	}
	static := "  labels:\n    app.kubernetes.io/name: coolscaler\n    app.kubernetes.io/part-of: coolscaler"
	helm := "  labels:\n    {{- include \"coolscaler.labels\" . | nindent 4 }}"
	src := strings.ReplaceAll(string(raw), helm, static)
	if strings.Contains(src, "{{") {
		t.Fatalf("chart crds.yaml has unexpected Helm templating beyond the label include")
	}
	chart := map[string]map[string]any{}
	for _, doc := range strings.Split(src, "\n---\n") {
		var obj map[string]any
		if err := yaml.Unmarshal([]byte(doc), &obj); err != nil {
			t.Fatalf("chart doc parse: %v", err)
		}
		md, _ := obj["metadata"].(map[string]any)
		name, _ := md["name"].(string)
		chart[name] = obj
	}
	list, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(chart) != len(list) {
		t.Fatalf("chart has %d CRDs, embedded has %d", len(chart), len(list))
	}
	for _, crd := range list {
		want, ok := chart[crd.Name]
		if !ok {
			t.Errorf("%s: embedded but not in chart", crd.Name)
			continue
		}
		if !reflect.DeepEqual(crd.Obj, want) {
			t.Errorf("%s: embedded copy differs from chart (re-run the sync)", crd.Name)
		}
	}
}
