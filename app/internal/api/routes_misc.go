package api

import (
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"

	"coolscaler.sh/coolscaler/internal/engine"
	"coolscaler.sh/coolscaler/internal/pyjson"
)

func RegisterMisc(r gin.IRouter, e *engine.Engine) {
	// Settings / feature-flag / capability endpoints
	r.GET("/api/settings/ui-features", func(c *gin.Context) {
		sendPy(c, http.StatusOK, pyjson.NewObj().
			Set("uiFeatures", pyjson.NewObj().
				Set("hpaOptimization", true).Set("nodeConsolidation", false)).
			Set("inPlaceSupport", pyjson.NewObj().
				Set("supported", true).Set("memoryLimitDecreaseSupported", true).
				Set("reasonClusterVersion", false).Set("reasonDisabled", false)))
	})
	r.GET("/api/settings/beta-features", func(c *gin.Context) {
		sendPy(c, http.StatusOK, pyjson.NewObj().
			Set("enabled", true).
			Set("betaFeatures", pyjson.NewObj().
				Set("hpaOptimization", true).Set("nodeConsolidation", false).
				Set("podScheduling", true)))
	})
	r.GET("/api/conf/ui-read-only", func(c *gin.Context) {
		sendPy(c, http.StatusOK, pyjson.NewObj().Set("readOnly", e.Cfg.ReadOnly))
	})
	// Custom metrics
	metricsConfList := func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.MetricsConfList(c.Request.Context()))
	}
	r.GET("/api/metricsConf", metricsConfList)
	r.GET("/api/metricsConf/", metricsConfList)
	r.PUT("/api/metricsConf/update", func(c *gin.Context) {
		body := readBody(c)
		mc, _ := body.GetD("metricConf", nil).(*pyjson.Obj)
		if mc == nil {
			sendPy(c, http.StatusBadRequest, pyjson.NewObj().Set("error", "metricConf required"))
			return
		}
		sendPy(c, http.StatusOK, e.MetricsConfUpdate(c.Request.Context(), mc))
	})
	r.PUT("/api/metricsConf/remove", func(c *gin.Context) {
		body := readBody(c)
		name, _ := body.GetD("metricName", "").(string)
		sendPy(c, http.StatusOK, e.MetricsConfRemove(c.Request.Context(), name))
	})
	r.POST("/api/dashboard/byNamespace", func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.WorkloadsData())
	})
	r.POST("/api/dashboard/aggregatedOverview", func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.DashboardAggregatedOverview())
	})
	r.POST("/api/dashboard/aggregationWorkloads", func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.WorkloadsData())
	})
	// ---- Route-diff tail: reports / export / discovery / rebalance / topk ----
	r.GET("/api/reports/graph", func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.ReportsGraph(drawerQ(c, "range", "7d")))
	})
	r.POST("/api/reports/new", func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.ReportsNew(readBody(c)))
	})
	r.GET("/api/troubleshoot/export", func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.TroubleshootExportState())
	})
	r.POST("/api/troubleshoot/export", func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.TroubleshootExportState())
	})
	r.GET("/api/troubleshoot/export/download", func(c *gin.Context) {
		data, err := e.TroubleshootExportBundle(c.Request.Context())
		if err != nil {
			sendPy(c, http.StatusOK, pyjson.NewObj().Set("error", err.Error()))
			return
		}
		c.Header("Content-Disposition", "attachment; filename=coolscaler-cluster-export.tar.gz")
		c.Data(http.StatusOK, "application/gzip", data)
	})
	r.GET("/api/custom-workloads/owners/unknown", func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.CogUnknownOwners(c.Request.Context()))
	})
	r.GET("/api/custom-workloads/pod-templates", func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.CogPodTemplates(c.Request.Context()))
	})
	r.POST("/api/nodes/rebalance-once", func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.RebalanceOnce(c.Request.Context()))
	})
	r.GET("/api/nodes/rebalance-status", func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.RebalanceStatus(c.Request.Context()))
	})
	r.GET("/api/node-analytics", func(c *gin.Context) {
		var frm, to int64
		if v := c.Query("from"); v != "" {
			if n, err := strconv.ParseInt(v, 10, 64); err == nil {
				frm = n
				if frm > 1e12 {
					frm /= 1000
				}
			}
		}
		if v := c.Query("to"); v != "" {
			if n, err := strconv.ParseInt(v, 10, 64); err == nil {
				to = n
				if to > 1e12 {
					to /= 1000
				}
			}
		}
		types := []string{}
		for _, t := range c.QueryArray("types") {
			if t != "" {
				types = append(types, t)
			}
		}
		sendPy(c, http.StatusOK, e.NodeAnalytics(c.Request.Context(), c.Query("name"), types, frm, to))
	})
	topk := func(c *gin.Context) {
		qk := c.Query("queryKey")
		if qk == "" {
			qk = str(readBody(c).GetD("queryKey", ""))
		}
		sendPy(c, http.StatusOK, e.AnalyticsTopk(c.Request.Context(), qk, drawerQ(c, "range", "3d")))
	}
	r.GET("/api/analytics/topk", topk)
	r.POST("/api/analytics/topk", topk)
	r.GET("/api/init-containers/", func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.InitContainersData())
	})

	// ---- Settings-family + hub contracts (July-12 route diff) ----
	r.GET("/api/settings/cluster-settings", func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.ClusterSettingsData(c.Request.Context()))
	})
	r.PUT("/api/settings/cluster-settings", func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.ClusterSettingsSave(c.Request.Context(), readBody(c)))
	})
	r.GET("/api/settings/user-ignored-namespaces", func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.UserIgnoredNamespacesData())
	})
	r.PUT("/api/settings/user-ignored-namespaces", func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.UserIgnoredNamespacesSave(c.Request.Context(), readBody(c)))
	})
	r.GET("/api/admission/settings", func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.AdmissionSettingsData(c.Request.Context()))
	})
	r.POST("/api/admission/settings", func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.AdmissionSettingsSave(c.Request.Context(), readBody(c)))
	})
	r.GET("/api/analytics/resourcequota/exists", func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.ResourceQuotaExists(c.Request.Context()))
	})
	r.GET("/api/nodeOptimization/graph", func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.NodeOptimizationGraph(drawerQ(c, "range", "7d")))
	})
	r.POST("/api/dashboard/timeseries", func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.DashboardTimeseries())
	})
	r.GET("/api/cluster-actions/multi-cluster", func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.ClusterActionsMultiCluster())
	})
	// Ingress settings
	r.GET("/api/settings/ingresses", func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.IngressSettingsData(c.Request.Context()))
	})
	r.POST("/api/settings/ingresses", func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.IngressSettingsCreate(c.Request.Context(), readBody(c)))
	})
	r.DELETE("/api/settings/ingresses", func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.IngressSettingsDelete(c.Request.Context()))
	})
	// Slack integration
	r.GET("/api/slack/conf", func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.SlackConfData(c.Request.Context()))
	})
	r.GET("/api/slack/verify/token", func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.SlackVerifyToken(c.Query("token")))
	})
	r.GET("/api/slack/verify/channel", func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.SlackVerifyChannel(c.Query("token"), c.Query("channel")))
	})
	r.GET("/api/alerts/slack/multicluster/settings/slackenabled", func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.SlackEnabledData(c.Request.Context()))
	})
	r.POST("/api/alerts/slack/multicluster/settings", func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.SlackSettingsSave(c.Request.Context(), readBody(c)))
	})
	r.POST("/api/alerts/slack/test", func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.SlackSendTest(c.Request.Context()))
	})
	// Alert settings
	r.GET("/api/alerts/settings", func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.AlertSettingsTable(c.Request.Context()))
	})
	r.POST("/api/alerts/multicluster/settings", func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.AlertSettingsModify(c.Request.Context(), readBody(c)))
	})
	r.GET("/api/overview-metrics-enabled", func(c *gin.Context) {
		sendPy(c, http.StatusOK, pyjson.NewObj().Set("isEnabled", true))
	})
	r.GET("/api/observability/enabled", func(c *gin.Context) {
		sendPy(c, http.StatusOK, pyjson.NewObj().
			Set("networkObservabilityEnabled", true).
			Set("networkObservabilityAvailable", true))
	})
	// Integration-status / enablement probes
	r.GET("/api/spot/status", func(c *gin.Context) {
		sendPy(c, http.StatusOK, pyjson.NewObj().
			Set("cloudProvider", "").Set("enabled", false).
			Set("spotLabels", []any{"node.kubernetes.io/lifecycle"}).
			Set("available", true))
	})
	r.GET("/api/karpenter/version", func(c *gin.Context) {
		sendPy(c, http.StatusOK, pyjson.NewObj().
			Set("installed", false).Set("version", ""))
	})
	r.GET("/api/gpu/dcgm", func(c *gin.Context) {
		sendPy(c, http.StatusOK, pyjson.NewObj().
			Set("available", false).Set("dcgms", []any{}))
	})
	r.GET("/api/cluster/permissions", func(c *gin.Context) {
		sendPy(c, http.StatusOK, pyjson.NewObj().
			Set("canAutomateCluster", !e.Cfg.ReadOnly).Set("userRole", "Admin"))
	})
	r.GET("/api/user-enabled-features", func(c *gin.Context) {
		sendPy(c, http.StatusOK, pyjson.NewObj().Set("features", []any{}))
	})
	r.GET("/api/active-issues", func(c *gin.Context) {
		sendPy(c, http.StatusOK, pyjson.NewObj().
			Set("missingNodeGroups", pyjson.NewObj()).
			Set("nodeLifecycleTypeUnknown", pyjson.NewObj()))
	})
	r.GET("/api/insights", func(c *gin.Context) {
		sendPy(c, http.StatusOK, pyjson.NewObj().
			Set("clusters", []any{e.Cfg.ClusterName}).
			Set("insights", nil).
			Set("lastUpdated", time.Now().UTC().Format("2006-01-02T15:04:05Z")).
			Set("clusterName", e.Cfg.ClusterName))
	})

	// ---- Data-function GETs ----
	r.GET("/api/cur/settings", func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.CurSettingsData())
	})
	r.GET("/api/cost-report", func(c *gin.Context) {
		var frm, to *string
		if v := c.Query("from"); v != "" {
			frm = &v
		}
		if v := c.Query("to"); v != "" {
			to = &v
		}
		d, err := e.CostReportData(c.Request.Context(), frm, to)
		if err != nil {
			sendPy(c, http.StatusOK, pyjson.NewObj().
				Set("totals", pyjson.NewObj()).
				Set("byNamespace", []any{}).
				Set("byNode", []any{}).
				Set("error", err.Error()))
			return
		}
		sendPy(c, http.StatusOK, d)
	})
	r.GET("/api/auth/rbac", func(c *gin.Context) {
		d, err := e.AuthRbacData(c.Request.Context())
		if err != nil {
			sendPy(c, http.StatusOK, pyjson.NewObj().
				Set("authMode", "none").Set("rules", []any{}).
				Set("error", err.Error()))
			return
		}
		sendPy(c, http.StatusOK, d)
	})
	r.GET("/api/labels", func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.LabelsData())
	})
	r.GET("/api/namespaces", func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.NamespacesData())
	})
	r.GET("/api/auto-detected-policies", func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.AutoDetectedPolicies())
	})
	r.GET("/api/available-actions", func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.AvailableActionsData())
	})
	r.GET("/api/comparison", func(c *gin.Context) {
		hs := c.Query("windowHours")
		if hs == "" {
			hs = "24"
		}
		hours, err := strconv.Atoi(hs)
		if err != nil {
			c.Status(http.StatusInternalServerError)
			return
		}
		sendPy(c, http.StatusOK, e.ClusterComparison(c.Request.Context(), hours))
	})
	r.GET("/api/capped-statuses", func(c *gin.Context) {
		d, err := e.CappedStatusesData()
		if err != nil {
			sendPy(c, http.StatusOK, pyjson.NewObj().
				Set("cappedStatusFilterValues", []any{}).
				Set("clusters", []any{e.Cfg.ClusterName}).
				Set("error", err.Error()))
			return
		}
		sendPy(c, http.StatusOK, d)
	})
	r.GET("/api/available-savings", func(c *gin.Context) {
		d, err := e.AvailableSavingsData()
		if err != nil {
			sendPy(c, http.StatusOK, pyjson.NewObj().Set("error", err.Error()))
			return
		}
		sendPy(c, http.StatusOK, d)
	})
	r.GET("/api/clusters", func(c *gin.Context) { // truthful single-entry cluster registry
		d, err := e.ClustersRegistryData(c.Request.Context())
		if err != nil {
			sendPy(c, http.StatusOK, []any{pyjson.NewObj().
				Set("name", e.Cfg.ClusterName).
				Set("error", err.Error())})
			return
		}
		sendPy(c, http.StatusOK, d)
	})
	r.GET("/api/multicluster", func(c *gin.Context) { // launcher grid (single truthful cluster)
		d, err := e.MulticlusterData(c.Request.Context(), c.Query("product"))
		if err != nil {
			sendPy(c, http.StatusOK, pyjson.NewObj().
				Set("clusters", []any{}).
				Set("error", err.Error()))
			return
		}
		sendPy(c, http.StatusOK, d)
	})
	r.GET("/api/priority-classes", func(c *gin.Context) {
		d, err := e.PriorityClassesData(c.Request.Context())
		if err != nil {
			sendPy(c, http.StatusOK, pyjson.NewObj().
				Set("priorityClasses", []any{}).
				Set("error", err.Error()))
			return
		}
		sendPy(c, http.StatusOK, d)
	})
}
