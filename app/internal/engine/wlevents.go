package engine

import (
	"context"
	"sort"
	"strings"

	"coolscaler.sh/coolscaler/internal/pyjson"
)

// WorkloadEvents returns the workload's NATIVE Kubernetes events — events
// involving the workload object itself, its pods and its replicasets
func (e *Engine) WorkloadEvents(ctx context.Context, ns, kind, name string) *pyjson.Obj {
	events := []any{}
	if ns != "" && name != "" {
		if ev, err := e.Kube.GetJSON(ctx, "/api/v1/namespaces/"+ns+"/events"); err == nil {
			prefix := name + "-"
			for _, iv := range items(ev) {
				it := obj(iv)
				io := getObj(it, "involvedObject")
				ik, in := getStr(io, "kind"), getStr(io, "name")
				match := (ik == kind && in == name) ||
					// pods / replicasets / jobs spawned by the workload share
					// its name prefix (k8s generated-name convention).
					((ik == "Pod" || ik == "ReplicaSet" || ik == "Job") &&
						strings.HasPrefix(in, prefix))
				if !match {
					continue
				}
				first := it.GetD("firstTimestamp", nil)
				if !truthy(first) {
					first = it.GetD("eventTime", nil)
				}
				last := it.GetD("lastTimestamp", nil)
				if !truthy(last) {
					last = firstTruthy(it.GetD("eventTime", nil), first)
				}
				src := getStr(getObj(it, "source"), "component")
				if src == "" {
					src = getStr(it, "reportingComponent")
				}
				events = append(events, pyjson.NewObj().
					Set("type", it.GetD("type", "")).
					Set("reason", it.GetD("reason", "")).
					Set("message", it.GetD("message", "")).
					Set("object", ik+"/"+in).
					Set("count", it.GetD("count", 1)).
					Set("firstSeen", first).
					Set("lastSeen", last).
					Set("source", src))
			}
			sort.SliceStable(events, func(i, j int) bool {
				// newest first (k8s timestamps sort lexicographically)
				return str(obj(events[i]).GetD("lastSeen", nil)) >
					str(obj(events[j]).GetD("lastSeen", nil))
			})
		}
	}
	return pyjson.NewObj().Set("events", events)
}
