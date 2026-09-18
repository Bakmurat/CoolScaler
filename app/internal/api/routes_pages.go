package api

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"coolscaler.sh/coolscaler/internal/engine"
	"coolscaler.sh/coolscaler/internal/pyjson"
)

func RegisterPages(r gin.IRouter, e *engine.Engine) {
	r.GET("/api/policies", func(c *gin.Context) {
		d, err := e.PoliciesData(c.Request.Context())
		if err != nil {
			sendPy(c, http.StatusOK, pyjson.NewObj().
				Set("policies", []any{}).
				Set("totals", pyjson.NewObj()).
				Set("error", err.Error()))
			return
		}
		sendPy(c, http.StatusOK, d)
	})
	r.GET("/api/policy-rules", func(c *gin.Context) {
		d, err := e.PolicyRulesData()
		if err != nil {
			sendPy(c, http.StatusOK, pyjson.NewObj().
				Set("rules", []any{}).
				Set("error", err.Error()))
			return
		}
		sendPy(c, http.StatusOK, d)
	})
	r.GET("/api/custom-workloads", func(c *gin.Context) {
		d, err := e.CustomWorkloadsData(c.Request.Context())
		if err != nil {
			sendPy(c, http.StatusOK, pyjson.NewObj().
				Set("builtins", []any{}).
				Set("unrecognized", []any{}).
				Set("totals", pyjson.NewObj()).
				Set("error", err.Error()))
			return
		}
		sendPy(c, http.StatusOK, d)
	})
	r.GET("/api/custom-workloads/overtime", func(c *gin.Context) {
		d, err := e.CustomOvertimeData(c.Request.Context(), c.DefaultQuery("range", "7d"))
		if err != nil {
			sendPy(c, http.StatusOK, pyjson.NewObj().
				Set("range", "7d").
				Set("values", []any{}).
				Set("error", err.Error()))
			return
		}
		sendPy(c, http.StatusOK, d)
	})
	r.GET("/api/replicas", func(c *gin.Context) {
		d, err := e.ReplicasData(c.Request.Context(), c.DefaultQuery("range", "7d"))
		if err != nil {
			sendPy(c, http.StatusOK, pyjson.NewObj().
				Set("workloads", []any{}).
				Set("totals", pyjson.NewObj()).
				Set("error", err.Error()))
			return
		}
		sendPy(c, http.StatusOK, d)
	})
	r.GET("/api/replicas-policies", func(c *gin.Context) {
		d, err := e.ReplicasPoliciesData()
		if err != nil {
			sendPy(c, http.StatusOK, pyjson.NewObj().
				Set("policies", []any{}).
				Set("totals", pyjson.NewObj()).
				Set("error", err.Error()))
			return
		}
		sendPy(c, http.StatusOK, d)
	})
	r.GET("/api/downscale", func(c *gin.Context) {
		d, err := e.DownscaleData(c.Request.Context())
		if err != nil {
			sendPy(c, http.StatusOK, pyjson.NewObj().
				Set("schedules", []any{}).
				Set("workloads", []any{}).
				Set("totals", pyjson.NewObj()).
				Set("error", err.Error()))
			return
		}
		sendPy(c, http.StatusOK, d)
	})
}
