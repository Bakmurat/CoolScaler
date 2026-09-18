// Package crds embeds the CoolScaler CustomResourceDefinitions (generated
// from charts/coolscaler/templates/crds.yaml, Helm templating stripped) and
// installs/updates them on startup when the agent runs with --update-crd=true
package crds

import (
	"context"
	"embed"
	"fmt"
	"log/slog"
	"reflect"
	"sort"
	"strings"

	"encoding/json"

	"sigs.k8s.io/yaml"

	"coolscaler.sh/coolscaler/internal/kube"
)

//go:embed *.yaml
var crdFS embed.FS

// CRD is one embedded manifest, decoded generically.
type CRD struct {
	Name string         // metadata.name, e.g. policies.analysis.coolscaler.sh
	Obj  map[string]any // full manifest
	Raw  []byte         // original YAML
}

// Load parses every embedded CRD, sorted by filename.
func Load() ([]CRD, error) {
	entries, err := crdFS.ReadDir(".")
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".yaml") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	out := make([]CRD, 0, len(names))
	for _, fn := range names {
		raw, err := crdFS.ReadFile(fn)
		if err != nil {
			return nil, err
		}
		var obj map[string]any
		if err := yaml.Unmarshal(raw, &obj); err != nil {
			return nil, fmt.Errorf("crds: parse %s: %w", fn, err)
		}
		md, _ := obj["metadata"].(map[string]any)
		name, _ := md["name"].(string)
		if name == "" {
			return nil, fmt.Errorf("crds: %s: missing metadata.name", fn)
		}
		out = append(out, CRD{Name: name, Obj: obj, Raw: raw})
	}
	return out, nil
}

const crdBase = "/apis/apiextensions.k8s.io/v1/customresourcedefinitions"

// Result summarizes one CRD's reconciliation.
type Result struct {
	Name   string
	Action string // "in-sync" | "created" | "updated" | "would-create" | "would-update" | "error"
	Drift  []string
	Err    error
}

// Ensure installs/updates the embedded CRDs (agent --update-crd=true).
// writeEnabled=false performs a dry-run diff only.
func Ensure(ctx context.Context, kc *kube.Client, log *slog.Logger, writeEnabled bool) []Result {
	list, err := Load()
	if err != nil {
		log.Error("crds: load embedded manifests failed", "err", err)
		return []Result{{Name: "(embed)", Action: "error", Err: err}}
	}
	var out []Result
	for _, crd := range list {
		res := ensureOne(ctx, kc, log, crd, writeEnabled)
		out = append(out, res)
		switch res.Action {
		case "in-sync":
			log.Debug("crd in sync", "name", res.Name)
		case "error":
			log.Error("crd reconcile failed", "name", res.Name, "err", res.Err)
		default:
			log.Info("crd "+res.Action, "name", res.Name, "drift", strings.Join(res.Drift, "; "))
		}
	}
	return out
}

func ensureOne(ctx context.Context, kc *kube.Client, log *slog.Logger, crd CRD, writeEnabled bool) Result {
	res := Result{Name: crd.Name}
	live, err := kc.GetJSON(ctx, crdBase+"/"+crd.Name)
	if err != nil {
		if kube.IsNotFound(err) {
			if !writeEnabled {
				res.Action = "would-create"
				return res
			}
			body, _ := json.Marshal(crd.Obj)
			if _, err := kc.Do(ctx, "POST", crdBase, body, "application/json"); err != nil {
				res.Action, res.Err = "error", err
				return res
			}
			res.Action = "created"
			return res
		}
		res.Action, res.Err = "error", err
		return res
	}

	// Compare desired vs live spec semantically (JSON round-trip both sides;
	// the API server adds defaults, so compare only fields the manifest sets).
	liveJSON := live.GetD("spec", nil)
	liveSpec := toPlain(liveJSON)
	wantSpec, _ := crd.Obj["spec"].(map[string]any)
	drift := diffSubset("spec", wantSpec, liveSpec)
	if len(drift) == 0 {
		res.Action = "in-sync"
		return res
	}
	res.Drift = drift
	if !writeEnabled {
		res.Action = "would-update"
		return res
	}
	// PUT with the live resourceVersion, desired spec, live metadata kept.
	md, _ := toPlain(live.GetD("metadata", nil)).(map[string]any)
	upd := map[string]any{
		"apiVersion": crd.Obj["apiVersion"],
		"kind":       crd.Obj["kind"],
		"metadata":   md,
		"spec":       wantSpec,
	}
	body, _ := json.Marshal(upd)
	if _, err := kc.Do(ctx, "PUT", crdBase+"/"+crd.Name, body, "application/json"); err != nil {
		res.Action, res.Err = "error", err
		return res
	}
	res.Action = "updated"
	return res
}

// diffSubset reports paths where `want` differs from `have`, only descending
// into keys `want` sets (server-side defaults in `have` are not drift).
func diffSubset(path string, want, have any) []string {
	switch w := want.(type) {
	case map[string]any:
		h, ok := have.(map[string]any)
		if !ok {
			return []string{path + ": type differs"}
		}
		var out []string
		keys := make([]string, 0, len(w))
		for k := range w {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			hv, exists := h[k]
			if !exists {
				out = append(out, path+"."+k+": missing in live")
				continue
			}
			out = append(out, diffSubset(path+"."+k, w[k], hv)...)
		}
		return out
	case []any:
		h, ok := have.([]any)
		if !ok {
			return []string{path + ": type differs"}
		}
		if len(w) != len(h) {
			return []string{fmt.Sprintf("%s: length %d != live %d", path, len(w), len(h))}
		}
		var out []string
		for i := range w {
			out = append(out, diffSubset(fmt.Sprintf("%s[%d]", path, i), w[i], h[i])...)
		}
		return out
	default:
		if !plainEqual(want, have) {
			return []string{fmt.Sprintf("%s: %v != live %v", path, want, have)}
		}
		return nil
	}
}

// plainEqual compares scalars with numeric tolerance for int/float encodings.
func plainEqual(a, b any) bool {
	if na, aok := toFloat(a); aok {
		if nb, bok := toFloat(b); bok {
			return na == nb
		}
		return false
	}
	return reflect.DeepEqual(a, b)
}

func toFloat(v any) (float64, bool) {
	switch t := v.(type) {
	case float64:
		return t, true
	case int:
		return float64(t), true
	case int64:
		return float64(t), true
	case json.Number:
		f, err := t.Float64()
		return f, err == nil
	}
	return 0, false
}

// toPlain converts pyjson values (ordered Obj / lists) into plain Go maps so
// they can be compared against the YAML-decoded manifests.
func toPlain(v any) any {
	type keyser interface {
		Keys() []string
		GetD(string, any) any
	}
	switch t := v.(type) {
	case keyser:
		m := map[string]any{}
		for _, k := range t.Keys() {
			m[k] = toPlain(t.GetD(k, nil))
		}
		return m
	case []any:
		out := make([]any, len(t))
		for i, x := range t {
			out[i] = toPlain(x)
		}
		return out
	default:
		return v
	}
}
