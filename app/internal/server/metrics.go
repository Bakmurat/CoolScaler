package server

import (
	"context"
	"net/http"
	"os"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"coolscaler.sh/coolscaler/internal/engine"
)

func holderID() string {
	if p := os.Getenv("POD_NAME"); p != "" {
		return p
	}
	host, _ := os.Hostname()
	return host
}

type componentCollector struct {
	role     string
	leader   func() bool
	upDesc   *prometheus.Desc
	leadDesc *prometheus.Desc
}

func newComponentCollector(role string, leader func() bool) *componentCollector {
	return &componentCollector{
		role:   role,
		leader: leader,
		upDesc: prometheus.NewDesc("coolscaler_up", "Component up.",
			[]string{"role", "node"}, nil),
		leadDesc: prometheus.NewDesc("coolscaler_leader",
			"Whether this replica currently holds the role's Lease.",
			[]string{"role", "holder"}, nil),
	}
}

func (c *componentCollector) Describe(ch chan<- *prometheus.Desc) {
	ch <- c.upDesc
	ch <- c.leadDesc
}

func (c *componentCollector) Collect(ch chan<- prometheus.Metric) {
	ch <- prometheus.MustNewConstMetric(c.upDesc, prometheus.GaugeValue, 1,
		c.role, os.Getenv("NODE_NAME"))
	lead := 0.0
	if c.leader == nil || c.leader() {
		lead = 1
	}
	ch <- prometheus.MustNewConstMetric(c.leadDesc, prometheus.GaugeValue, lead,
		c.role, holderID())
}

// It also emits coolscaler_node_hourly_cost{node,resource} from the same
// NodeTable call, and embeds the engine.PromExporter so the recommender
// exposes the coolscaler_recommendation_* recording-rule input gauges without
// touching the subcommand registration path.
type nodeCostCollector struct {
	eng        *engine.Engine
	exporter   *engine.PromExporter
	nodeDesc   *prometheus.Desc
	hourlyDesc *prometheus.Desc
	costDesc   *prometheus.Desc
	cntDesc    *prometheus.Desc
	blkDesc    *prometheus.Desc
}

func newNodeCostCollector(e *engine.Engine) *nodeCostCollector {
	return &nodeCostCollector{
		eng:      e,
		exporter: engine.NewPromExporter(e),
		nodeDesc: prometheus.NewDesc("coolscaler_node_cost_usd_monthly",
			"Estimated monthly USD cost of a node.",
			[]string{"node", "instance_type", "lifecycle", "priced_by"}, nil),
		hourlyDesc: prometheus.NewDesc("coolscaler_node_hourly_cost",
			"Hourly node price: resource=total ($/h for the node), cpu ($/core-hour), memory ($/GiB-hour).",
			[]string{"node", "resource"}, nil),
		costDesc: prometheus.NewDesc("coolscaler_cluster_cost_usd_monthly",
			"Estimated monthly cluster node cost.", nil, nil),
		cntDesc: prometheus.NewDesc("coolscaler_cluster_nodes",
			"Cluster node count.", nil, nil),
		blkDesc: prometheus.NewDesc("coolscaler_cluster_blocked_nodes",
			"Nodes with scale-down blockers.", nil, nil),
	}
}

func (c *nodeCostCollector) Describe(ch chan<- *prometheus.Desc) {
	ch <- c.nodeDesc
	ch <- c.hourlyDesc
	ch <- c.costDesc
	ch <- c.cntDesc
	ch <- c.blkDesc
	c.exporter.Describe(ch)
}

func (c *nodeCostCollector) Collect(ch chan<- prometheus.Metric) {
	// Engine-state input gauges first — these never hit the API server.
	c.exporter.Collect(ch)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	nt, err := c.eng.NodeTable(ctx)
	if err != nil {
		ch <- prometheus.MustNewConstMetric(c.costDesc, prometheus.GaugeValue, 0)
		ch <- prometheus.MustNewConstMetric(c.cntDesc, prometheus.GaugeValue, 0)
		ch <- prometheus.MustNewConstMetric(c.blkDesc, prometheus.GaugeValue, 0)
		return
	}
	for _, n := range engine.NodeCostRows(nt) {
		ch <- prometheus.MustNewConstMetric(c.nodeDesc, prometheus.GaugeValue,
			n.Cost, n.Name, n.InstanceType, n.Lifecycle, n.PricedBy)
	}
	for _, r := range c.eng.NodeHourlyCostRows(nt) {
		ch <- prometheus.MustNewConstMetric(c.hourlyDesc, prometheus.GaugeValue,
			r.Rate, r.Node, r.Resource)
	}
	tot := engine.NodeCostTotals(nt)
	ch <- prometheus.MustNewConstMetric(c.costDesc, prometheus.GaugeValue, tot.MonthlyCost)
	ch <- prometheus.MustNewConstMetric(c.cntDesc, prometheus.GaugeValue, float64(tot.Nodes))
	ch <- prometheus.MustNewConstMetric(c.blkDesc, prometheus.GaugeValue, float64(tot.BlockedNodes))
}

// healthCheckCollector emits coolscaler_health_check_<component> gauges (1=healthy)
type healthCheckCollector struct {
	eng   *engine.Engine
	order []string
	descs map[string]*prometheus.Desc
}

func newHealthCheckCollector(e *engine.Engine) *healthCheckCollector {
	order := []string{"admissions", "agent", "dashboards", "recommender", "updater",
		"prometheus_server", "kube_state_metrics", "network_monitor",
		"workload_recommendations_update"}
	descs := map[string]*prometheus.Desc{}
	for _, n := range order {
		descs[n] = prometheus.NewDesc("coolscaler_health_check_"+n,
			"CoolScaler "+n+" health (1=healthy).", nil, nil)
	}
	return &healthCheckCollector{eng: e, order: order, descs: descs}
}

func (c *healthCheckCollector) Describe(ch chan<- *prometheus.Desc) {
	for _, n := range c.order {
		ch <- c.descs[n]
	}
}

func (c *healthCheckCollector) Collect(ch chan<- prometheus.Metric) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	g := c.eng.HealthCheckGauges(ctx)
	for _, n := range c.order {
		ch <- prometheus.MustNewConstMetric(c.descs[n], prometheus.GaugeValue, g[n])
	}
}

// newMetricsHandler builds a standalone /metrics handler (Go + process
// collectors + the component gauges) for subcommands that do not run a
// controller-runtime manager (dashboard-api, network-monitor fallback).
func newMetricsHandler(role string, leader func() bool, extra ...prometheus.Collector) http.Handler {
	reg := prometheus.NewRegistry()
	reg.MustRegister(
		collectors.NewGoCollector(),
		collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
		newComponentCollector(role, leader),
	)
	reg.MustRegister(extra...)
	return promhttp.HandlerFor(reg, promhttp.HandlerOpts{})
}

func pythonComponentMetrics(role string, leader bool) []byte {
	lead := "0"
	if leader {
		lead = "1"
	}
	return []byte("# HELP coolscaler_up Component up.\n" +
		"# TYPE coolscaler_up gauge\n" +
		`coolscaler_up{role="` + role + `",node="` + os.Getenv("NODE_NAME") + `"} 1` + "\n" +
		"# HELP coolscaler_leader Whether this replica currently holds the role's Lease.\n" +
		"# TYPE coolscaler_leader gauge\n" +
		`coolscaler_leader{role="` + role + `",holder="` + holderID() + `"} ` + lead + "\n")
}
