package api

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"coolscaler.sh/coolscaler/internal/engine"
	"coolscaler.sh/coolscaler/internal/pyjson"
)

func sendPy(c *gin.Context, code int, body any) {
	data := pyjson.Marshal(body)
	c.Writer.Header().Set("Content-Type", "application/json")
	c.Writer.Header().Set("Content-Length", strconv.Itoa(len(data)))
	c.Status(code)
	_, _ = c.Writer.Write(data)
}

func readBody(c *gin.Context) *pyjson.Obj {
	raw, err := c.GetRawData()
	if err != nil || len(raw) == 0 {
		return pyjson.NewObj()
	}
	v, err := pyjson.Decode(raw)
	if err != nil {
		return pyjson.NewObj()
	}
	if o, ok := v.(*pyjson.Obj); ok {
		return o
	}
	return pyjson.NewObj()
}

func Register(r *gin.Engine, e *engine.Engine) {
	r.GET("/api/overview", func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.OverviewData())
	})
	r.GET("/api/workloads", func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.WorkloadsData())
	})
	r.GET("/api/version", func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.VersionData())
	})
	r.GET("/api/health", func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.HealthData(c.Request.Context()))
	})
	r.GET("/api/cost/config", func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.CostConfigData())
	})

	r.GET("/api/analytics/summary", func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.AnalyticsSummary())
	})
	r.GET("/api/analytics/single", func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.AnalyticsSingle(
			c.DefaultQuery("range", "7d"), c.DefaultQuery("type", "")))
	})
	r.GET("/api/analytics/graph", func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.AnalyticsGraph(
			c.DefaultQuery("range", "7d"), c.DefaultQuery("groupBy", "15m"),
			c.QueryArray("types")))
	})
	r.GET("/api/analytics/automation", func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.AnalyticsAutomation(c.DefaultQuery("range", "7d")))
	})
	r.GET("/api/billing", func(c *gin.Context) {
		d, err := e.BillingData(c.Request.Context(), c.DefaultQuery("range", "30d"))
		if err != nil {
			sendPy(c, http.StatusOK, pyjson.NewObj().Set("error", err.Error()))
			return
		}
		sendPy(c, http.StatusOK, d)
	})
	r.GET("/api/analytics/vcpu-cost", func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.VcpuCostData())
	})
	r.GET("/api/nodes/graph", func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.NodesGraph(c.Request.Context(),
			c.DefaultQuery("range", "7d"), c.DefaultQuery("groupBy", "hour")))
	})
	r.GET("/api/java/graph", func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.JavaGraph(c.Request.Context(),
			c.DefaultQuery("range", "7d"), c.DefaultQuery("groupBy", "hour")))
	})
	r.GET("/api/custom-rules-attributes", func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.CustomRulesAttributes())
	})
	r.GET("/api/cog/group-by-options", func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.CogGroupByOptions())
	})
	r.GET("/api/cog/policy", func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.CogPolicyGet(c.Query("name")))
	})
	r.GET("/api/alerts", func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.AlertsData())
	})
	r.GET("/api/alert-settings", func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.AlertSettingsData())
	})
	r.GET("/api/headroom", func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.HeadroomData())
	})
	// Cluster Headroom (v2) page — /cluster-headroom under Node Management.
	r.GET("/api/headroom/overview", func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.HeadroomOverview(c.Request.Context()))
	})
	r.GET("/api/headroom/graph", func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.HeadroomGraph(c.Request.Context(),
			c.DefaultQuery("range", "7d")))
	})
	r.GET("/api/headroom/configurations", func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.HeadroomConfigurations(c.Request.Context()))
	})
	r.GET("/api/automation-config", func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.AutomationConfigData())
	})
	r.GET("/api/audits", func(c *gin.Context) {
		// 3d/7d) OR explicit from/to epoch-ms.
		var fromMs, toMs int64
		if v := c.Query("from"); v != "" {
			fromMs, _ = strconv.ParseInt(v, 10, 64)
		}
		if v := c.Query("to"); v != "" {
			toMs, _ = strconv.ParseInt(v, 10, 64)
		}
		if rg := c.Query("range"); rg != "" && fromMs == 0 {
			if n, err := strconv.Atoi(strings.TrimSuffix(rg, "d")); err == nil && n > 0 {
				fromMs = time.Now().Add(-time.Duration(n) * 24 * time.Hour).UnixMilli()
			}
		}
		sendPy(c, http.StatusOK, e.AuditsData(fromMs, toMs))
	})
	r.GET("/api/schedule-policies", func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.SchedulePoliciesData())
	})
	r.GET("/api/policy", func(c *gin.Context) {
		d := e.PolicyDetail(c.Request.Context(), c.Query("name"))
		if d == nil {
			sendPy(c, 404, pyjson.NewObj().Set("ok", false).Set("message", "policy not found"))
			return
		}
		sendPy(c, http.StatusOK, d)
	})
	r.GET("/api/policy-yaml", func(c *gin.Context) {
		y, ok := e.PolicyYaml(c.Request.Context(), c.Query("name"))
		if !ok {
			sendPy(c, http.StatusNotFound, pyjson.NewObj().Set("message", "Page not found"))
			return
		}
		c.Data(http.StatusOK, "text/plain; charset=utf-8", []byte(y))
	})
	r.GET("/api/workload-events", func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.WorkloadEvents(c.Request.Context(),
			c.Query("namespace"), c.Query("kind"), c.Query("name")))
	})
	r.GET("/api/hpa-policy", func(c *gin.Context) {
		d := e.HpaPolicyDetail(c.Query("name"))
		if d == nil {
			d = pyjson.NewObj().Set("error", "not found")
		}
		sendPy(c, http.StatusOK, d)
	})
	r.GET("/api/placement", func(c *gin.Context) {
		d, err := e.PlacementData(c.Request.Context())
		if err != nil {
			sendPy(c, http.StatusOK, pyjson.NewObj().
				Set("categories", []any{}).Set("blockedNodes", []any{}).
				Set("totals", pyjson.NewObj()).Set("error", err.Error()))
			return
		}
		sendPy(c, http.StatusOK, d)
	})
	r.GET("/api/scheduling", func(c *gin.Context) {
		d, err := e.SchedulingData(c.Request.Context())
		if err != nil {
			sendPy(c, http.StatusOK, pyjson.NewObj().
				Set("workloads", []any{}).Set("totals", pyjson.NewObj()).
				Set("error", err.Error()))
			return
		}
		sendPy(c, http.StatusOK, d)
	})
	r.GET("/api/scheduling-policies", func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.SchedulingPoliciesData(c.Request.Context()))
	})
	r.GET("/api/java", func(c *gin.Context) {
		d, err := e.JavaData(c.Request.Context())
		if err != nil {
			sendPy(c, http.StatusOK, pyjson.NewObj().
				Set("workloads", []any{}).Set("totals", pyjson.NewObj()).
				Set("error", err.Error()))
			return
		}
		sendPy(c, http.StatusOK, d)
	})
	r.GET("/api/java/config", func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.JavaConfigData(c.Request.Context()))
	})
	r.GET("/api/java/policies", func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.JavaPoliciesData(c.Request.Context()))
	})

	post := func(path string, fn func(c *gin.Context, body *pyjson.Obj) (int, *pyjson.Obj)) {
		r.POST(path, func(c *gin.Context) {
			code, resp := fn(c, readBody(c))
			sendPy(c, code, resp)
		})
	}
	post("/api/alert-settings", func(c *gin.Context, b *pyjson.Obj) (int, *pyjson.Obj) {
		return e.PostAlertSettings(b)
	})
	post("/api/automation-config", func(c *gin.Context, b *pyjson.Obj) (int, *pyjson.Obj) {
		return e.PostAutomationConfig(c.Request.Context(), b)
	})
	post("/api/cost/config", func(c *gin.Context, b *pyjson.Obj) (int, *pyjson.Obj) {
		return e.PostCostConfig(c.Request.Context(), b)
	})
	post("/api/java/config", func(c *gin.Context, b *pyjson.Obj) (int, *pyjson.Obj) {
		return e.PostJavaConfig(c.Request.Context(), b)
	})
	post("/api/java/action", func(c *gin.Context, b *pyjson.Obj) (int, *pyjson.Obj) {
		return e.PostJavaAction(c.Request.Context(), b)
	})
	post("/api/java/policy/save", func(c *gin.Context, b *pyjson.Obj) (int, *pyjson.Obj) {
		return e.PostJavaPolicySave(c.Request.Context(), b)
	})
	post("/api/headroom", func(c *gin.Context, b *pyjson.Obj) (int, *pyjson.Obj) {
		return e.PostHeadroom(b)
	})
	post("/api/headroom/configurations", func(c *gin.Context, b *pyjson.Obj) (int, *pyjson.Obj) {
		return e.PostHeadroomConfigurations(c.Request.Context(), b)
	})
	post("/api/automate", func(c *gin.Context, b *pyjson.Obj) (int, *pyjson.Obj) {
		return e.PostAutomate(b)
	})
	post("/api/automate-bulk", func(c *gin.Context, b *pyjson.Obj) (int, *pyjson.Obj) {
		return e.PostAutomateBulk(c.Request.Context(), b)
	})
	post("/api/exclude", func(c *gin.Context, b *pyjson.Obj) (int, *pyjson.Obj) {
		return e.PostExclude(b)
	})
	post("/api/cog/simulate", func(c *gin.Context, b *pyjson.Obj) (int, *pyjson.Obj) {
		return e.CogSimulatePost(c.Request.Context(), b)
	})
	post("/api/cog/save", func(c *gin.Context, b *pyjson.Obj) (int, *pyjson.Obj) {
		return e.CogSave(c.Request.Context(), b)
	})
	post("/api/cog/delete", func(c *gin.Context, b *pyjson.Obj) (int, *pyjson.Obj) {
		return e.CogDelete(c.Request.Context(), b)
	})
	post("/api/cog/toggle", func(c *gin.Context, b *pyjson.Obj) (int, *pyjson.Obj) {
		return e.CogToggle(c.Request.Context(), b)
	})
	post("/api/cog/policy", func(c *gin.Context, b *pyjson.Obj) (int, *pyjson.Obj) {
		return e.CogPolicy(c.Request.Context(), b)
	})
	post("/api/cog/duplicate", func(c *gin.Context, b *pyjson.Obj) (int, *pyjson.Obj) {
		return e.CogDuplicate(c.Request.Context(), b)
	})
	post("/api/policy/save", func(c *gin.Context, b *pyjson.Obj) (int, *pyjson.Obj) {
		return e.PolicySave(c.Request.Context(), b)
	})
	post("/api/policy/duplicate", func(c *gin.Context, b *pyjson.Obj) (int, *pyjson.Obj) {
		return e.PolicyDuplicate(c.Request.Context(), b)
	})
	post("/api/policy/delete", func(c *gin.Context, b *pyjson.Obj) (int, *pyjson.Obj) {
		return e.PolicyDelete(c.Request.Context(), b)
	})
	post("/api/hpa-policy/save", func(c *gin.Context, b *pyjson.Obj) (int, *pyjson.Obj) {
		return e.HpaPolicySave(c.Request.Context(), b)
	})
	post("/api/hpa-policy/duplicate", func(c *gin.Context, b *pyjson.Obj) (int, *pyjson.Obj) {
		return e.HpaPolicyDuplicate(c.Request.Context(), b)
	})
	post("/api/hpa-policy/delete", func(c *gin.Context, b *pyjson.Obj) (int, *pyjson.Obj) {
		return e.HpaPolicyDelete(c.Request.Context(), b)
	})
	post("/api/policy/simulate", func(c *gin.Context, b *pyjson.Obj) (int, *pyjson.Obj) {
		return 200, e.PolicySimulate(b)
	})
	post("/api/schedule-policy/save", func(c *gin.Context, b *pyjson.Obj) (int, *pyjson.Obj) {
		return e.SchedulePolicySave(c.Request.Context(), b)
	})
	post("/api/schedule-policy/delete", func(c *gin.Context, b *pyjson.Obj) (int, *pyjson.Obj) {
		return e.SchedulePolicyDelete(c.Request.Context(), b)
	})
	post("/api/policy-rules/save", func(c *gin.Context, b *pyjson.Obj) (int, *pyjson.Obj) {
		return e.PolicyRulesSave(c.Request.Context(), b)
	})
	post("/api/attach-policy", func(c *gin.Context, b *pyjson.Obj) (int, *pyjson.Obj) {
		return e.PostAttachPolicy(c.Request.Context(), b)
	})
	post("/api/restore-policy", func(c *gin.Context, b *pyjson.Obj) (int, *pyjson.Obj) {
		return e.PostRestorePolicy(c.Request.Context(), b)
	})
	post("/api/rollout", func(c *gin.Context, b *pyjson.Obj) (int, *pyjson.Obj) {
		return e.PostRollout(c.Request.Context(), b)
	})
	post("/api/replicas-automate", func(c *gin.Context, b *pyjson.Obj) (int, *pyjson.Obj) {
		return e.PostReplicasAutomate(b)
	})
	post("/api/replicas-automate-all", func(c *gin.Context, b *pyjson.Obj) (int, *pyjson.Obj) {
		return e.PostReplicasAutomateAll(b)
	})
	post("/api/replicas-apply", func(c *gin.Context, b *pyjson.Obj) (int, *pyjson.Obj) {
		return e.PostReplicasApply(c.Request.Context(), b)
	})
	post("/api/replicas-bulk", func(c *gin.Context, b *pyjson.Obj) (int, *pyjson.Obj) {
		return e.PostReplicasBulk(c.Request.Context(), b)
	})
	post("/api/replicas-attach-policy", func(c *gin.Context, b *pyjson.Obj) (int, *pyjson.Obj) {
		return e.PostReplicasAttachPolicy(b)
	})
	post("/api/placement-automate", func(c *gin.Context, b *pyjson.Obj) (int, *pyjson.Obj) {
		return e.PostPlacementAutomate(b)
	})
	post("/api/placement-automate-all", func(c *gin.Context, b *pyjson.Obj) (int, *pyjson.Obj) {
		return e.PostPlacementAutomateAll(c.Request.Context(), b)
	})
	post("/api/placement-optimize", func(c *gin.Context, b *pyjson.Obj) (int, *pyjson.Obj) {
		return e.PostPlacementOptimize(c.Request.Context(), b)
	})
	post("/api/placement-bulk", func(c *gin.Context, b *pyjson.Obj) (int, *pyjson.Obj) {
		return e.PostPlacementBulk(c.Request.Context(), b)
	})
	post("/api/scheduling-automate", func(c *gin.Context, b *pyjson.Obj) (int, *pyjson.Obj) {
		return e.PostSchedulingAutomate(b)
	})
	post("/api/scheduling-automate-all", func(c *gin.Context, b *pyjson.Obj) (int, *pyjson.Obj) {
		return e.PostSchedulingAutomateAll(c.Request.Context(), b)
	})
	post("/api/scheduling-apply", func(c *gin.Context, b *pyjson.Obj) (int, *pyjson.Obj) {
		return e.PostSchedulingApply(c.Request.Context(), b)
	})
	post("/api/scheduling-bulk", func(c *gin.Context, b *pyjson.Obj) (int, *pyjson.Obj) {
		return e.PostSchedulingBulk(c.Request.Context(), b)
	})
	post("/api/scheduling-attach-policy", func(c *gin.Context, b *pyjson.Obj) (int, *pyjson.Obj) {
		return e.PostSchedulingAttachPolicy(b)
	})
	post("/api/downscale-policy/save", func(c *gin.Context, b *pyjson.Obj) (int, *pyjson.Obj) {
		return e.DownscalePolicySave(c.Request.Context(), b)
	})
	post("/api/downscale-policy/delete", func(c *gin.Context, b *pyjson.Obj) (int, *pyjson.Obj) {
		return e.DownscalePolicyDelete(c.Request.Context(), b)
	})
	post("/api/scheduling-policy/save", func(c *gin.Context, b *pyjson.Obj) (int, *pyjson.Obj) {
		return e.SchedulingPolicySave(c.Request.Context(), b)
	})
	post("/api/scheduling-policy/delete", func(c *gin.Context, b *pyjson.Obj) (int, *pyjson.Obj) {
		return e.SchedulingPolicyDelete(c.Request.Context(), b)
	})
	post("/api/downscale-attach", func(c *gin.Context, b *pyjson.Obj) (int, *pyjson.Obj) {
		return e.PostDownscaleAttach(b)
	})
	post("/api/downscale-automate", func(c *gin.Context, b *pyjson.Obj) (int, *pyjson.Obj) {
		return e.PostDownscaleAutomate(b)
	})
	post("/api/downscale-automate-ns", func(c *gin.Context, b *pyjson.Obj) (int, *pyjson.Obj) {
		return e.PostDownscaleAutomateNs(c.Request.Context(), b)
	})
	post("/api/downscale-bulk", func(c *gin.Context, b *pyjson.Obj) (int, *pyjson.Obj) {
		return e.PostDownscaleBulk(b)
	})
	post("/api/apply", func(c *gin.Context, b *pyjson.Obj) (int, *pyjson.Obj) {
		return e.PostApply(c.Request.Context(), b)
	})
	post("/api/resize", func(c *gin.Context, b *pyjson.Obj) (int, *pyjson.Obj) {
		return e.PostResize(c.Request.Context(), b)
	})
	post("/api/notify", func(c *gin.Context, b *pyjson.Obj) (int, *pyjson.Obj) {
		e.KickRefresh()
		return 200, pyjson.NewObj().Set("ok", true)
	})
}
