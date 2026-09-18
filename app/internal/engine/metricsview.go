package engine

import "coolscaler.sh/coolscaler/internal/pyjson"

// Typed views over NodeTable output for the /metrics node-cost gauges.

// NodeCostRow is one coolscaler_node_cost_usd_monthly sample.
type NodeCostRow struct {
	Name         string
	InstanceType string
	Lifecycle    string // "spot" | "on-demand"
	PricedBy     string
	Cost         float64
}

// NodeCostTotalsView are the cluster-total gauges.
type NodeCostTotalsView struct {
	MonthlyCost  float64
	Nodes        int
	BlockedNodes int
}

func JavaDetect(c *pyjson.Obj) (bool, int64) { return javaDetect(c) }

func NodeCostRows(nt *pyjson.Obj) []NodeCostRow {
	var out []NodeCostRow
	for _, nv := range getList(nt, "nodes") {
		n := obj(nv)
		it := getStr(n, "instanceType")
		if it == "" {
			it = "unknown"
		}
		lifecycle := "on-demand"
		if truthy(n.GetD("isSpot", false)) {
			lifecycle = "spot"
		}
		pb := str(n.GetD("pricedBy", "resource-model"))
		if pb == "" {
			pb = "resource-model"
		}
		out = append(out, NodeCostRow{
			Name:         getStr(n, "name"),
			InstanceType: it,
			Lifecycle:    lifecycle,
			PricedBy:     pb,
			Cost:         f64d(n.GetD("cost", 0.0), 0),
		})
	}
	return out
}

// NodeCostTotals extracts the cluster-total gauges from a NodeTable result.
func NodeCostTotals(nt *pyjson.Obj) NodeCostTotalsView {
	tot := getObj(nt, "totals")
	return NodeCostTotalsView{
		MonthlyCost:  f64d(tot.GetD("monthlyCost", 0.0), 0),
		Nodes:        int(i64(tot.GetD("nodes", 0))),
		BlockedNodes: int(i64(tot.GetD("blockedNodes", 0))),
	}
}
