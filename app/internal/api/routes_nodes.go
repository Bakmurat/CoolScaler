package api

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"coolscaler.sh/coolscaler/internal/engine"
	"coolscaler.sh/coolscaler/internal/pyjson"
)

func RegisterNodes(r gin.IRouter, e *engine.Engine) {
	r.GET("/api/nodes", func(c *gin.Context) {
		d, err := e.NodeTable(c.Request.Context())
		if err != nil {
			sendPy(c, http.StatusOK, pyjson.NewObj().
				Set("nodes", []any{}).
				Set("totals", pyjson.NewObj()).
				Set("error", err.Error()))
			return
		}
		sendPy(c, http.StatusOK, d)
	})

	r.GET("/api/node", func(c *gin.Context) {
		nm := c.Query("name")
		if nm == "" {
			sendPy(c, http.StatusBadRequest, pyjson.NewObj().Set("error", "name required"))
			return
		}
		d, err := e.NodeDetail(c.Request.Context(), nm)
		if err != nil {
			sendPy(c, http.StatusOK, pyjson.NewObj().
				Set("found", false).
				Set("name", nm).
				Set("error", err.Error()))
			return
		}
		sendPy(c, http.StatusOK, d)
	})

	r.GET("/api/node-optimization", func(c *gin.Context) {
		d, err := e.NodeOptimizationData(c.Request.Context())
		if err != nil {
			sendPy(c, http.StatusOK, pyjson.NewObj().
				Set("instanceTypes", []any{}).
				Set("consolidation", pyjson.NewObj()).
				Set("error", err.Error()))
			return
		}
		sendPy(c, http.StatusOK, d)
	})

	r.GET("/api/volumes", func(c *gin.Context) {
		d, err := e.VolumesData(c.Request.Context())
		if err != nil {
			sendPy(c, http.StatusOK, pyjson.NewObj().
				Set("volumes", []any{}).
				Set("totals", pyjson.NewObj()).
				Set("error", err.Error()))
			return
		}
		sendPy(c, http.StatusOK, d)
	})
}
