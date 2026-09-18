package api

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"

	"coolscaler.sh/coolscaler/internal/engine"
	"coolscaler.sh/coolscaler/internal/pyjson"
)

func drawerQ(c *gin.Context, key, def string) string {
	if v := c.Query(key); v != "" {
		return v
	}
	return def
}

func drawerQOpt(c *gin.Context, key string) *string {
	if v := c.Query(key); v != "" {
		return &v
	}
	return nil
}

// RegisterDrawer mounts the per-workload drawer family.
func RegisterDrawer(r gin.IRouter, e *engine.Engine) {
	// GET /api/workload?ns=&kind=&name= — workload_diag.
	r.GET("/api/workload", func(c *gin.Context) {
		d := e.WorkloadDiag(c.Request.Context(),
			drawerQ(c, "ns", ""), drawerQ(c, "kind", ""), drawerQ(c, "name", ""))
		if d == nil {
			sendPy(c, http.StatusNotFound, pyjson.NewObj().
				Set("found", false).Set("message", "workload not found"))
			return
		}
		sendPy(c, http.StatusOK, d)
	})

	// GET /api/recommendation-whatif?ns=&kind=&name=&policy= — what-if preview.
	r.GET("/api/recommendation-whatif", func(c *gin.Context) {
		d, err, found := e.RecommendationWhatif(c.Request.Context(),
			drawerQ(c, "ns", ""), drawerQ(c, "kind", ""), drawerQ(c, "name", ""),
			drawerQ(c, "policy", "production"))
		if err != nil {
			sendPy(c, http.StatusOK, pyjson.NewObj().
				Set("containers", []any{}).Set("error", err.Error()))
			return
		}
		if !found {
			sendPy(c, http.StatusNotFound, pyjson.NewObj().
				Set("message", "workload not found"))
			return
		}
		sendPy(c, http.StatusOK, d)
	})

	// GET /api/diagnostics — policyTuning diagnostics event timeline.
	r.GET("/api/diagnostics", func(c *gin.Context) {
		d, err := e.DiagnosticsData(c.Request.Context(),
			drawerQ(c, "namespace", ""), drawerQ(c, "kind", ""), drawerQ(c, "name", ""),
			drawerQOpt(c, "from"), drawerQOpt(c, "to"))
		if err != nil {
			sendPy(c, http.StatusOK, pyjson.NewObj().
				Set("diagnosticEventsSeries", []any{}).Set("error", err.Error()))
			return
		}
		sendPy(c, http.StatusOK, d)
	})

	// GET /api/timeseries/<ns>/<kind>/<name>?container=&res=&policy=&period=
	r.GET("/api/timeseries/:ns/:kind/:name", func(c *gin.Context) {
		d, err := e.TimeseriesData(c.Request.Context(),
			c.Param("ns"), c.Param("kind"), c.Param("name"),
			drawerQ(c, "container", ""), drawerQ(c, "res", "cpu"),
			drawerQ(c, "policy", "production"), drawerQ(c, "period", "1d"))
		if err != nil {
			sendPy(c, http.StatusOK, pyjson.NewObj().
				Set("found", false).Set("error", err.Error()))
			return
		}
		sendPy(c, http.StatusOK, d)
	})

	// GET /api/troubleshoot/<ns>/<kind>/<name>?period=
	r.GET("/api/troubleshoot/:ns/:kind/:name", func(c *gin.Context) {
		d, err := e.TroubleshootData(c.Request.Context(),
			c.Param("ns"), c.Param("kind"), c.Param("name"), drawerQ(c, "period", "1d"))
		if err != nil {
			sendPy(c, http.StatusOK, pyjson.NewObj().
				Set("found", false).Set("error", err.Error()))
			return
		}
		sendPy(c, http.StatusOK, d)
	})

	// GET /api/apis/<ns>/<kind>/<name>
	r.GET("/api/apis/:ns/:kind/:name", func(c *gin.Context) {
		d, err := e.ApisData(c.Request.Context(),
			c.Param("ns"), c.Param("kind"), c.Param("name"))
		if err != nil {
			sendPy(c, http.StatusOK, pyjson.NewObj().
				Set("found", false).Set("error", err.Error()))
			return
		}
		sendPy(c, http.StatusOK, d)
	})

	// GET /api/network/*
	r.GET("/api/network/*rest", func(c *gin.Context) {
		rest := c.Param("rest")
		if rest == "/cost" {
			topN, _ := strconv.Atoi(drawerQ(c, "top", "10"))
			d, err := e.NetworkCostData(c.Request.Context(), drawerQ(c, "window", "5m"), topN)
			if err != nil {
				sendPy(c, http.StatusOK, pyjson.NewObj().
					Set("totals", pyjson.NewObj()).
					Set("namespaces", []any{}).
					Set("map", pyjson.NewObj().
						Set("nodes", []any{}).Set("edges", []any{})).
					Set("error", err.Error()))
				return
			}
			sendPy(c, http.StatusOK, d)
			return
		}
		parts := strings.Split(strings.Trim(rest, "/"), "/")
		if len(parts) == 3 && rest == "/"+parts[0]+"/"+parts[1]+"/"+parts[2] {
			d, err := e.NetworkData(c.Request.Context(), parts[0], parts[1], parts[2])
			if err != nil {
				sendPy(c, http.StatusOK, pyjson.NewObj().
					Set("found", false).Set("error", err.Error()))
				return
			}
			sendPy(c, http.StatusOK, d)
			return
		}
		sendPy(c, http.StatusOK, pyjson.NewObj().Set("found", false))
	})

	// GET /api/workload/<ns>/<kind>/<name>/<what>
	r.GET("/api/workload/:ns/:kind/:name/:what", func(c *gin.Context) {
		what := c.Param("what")
		if strings.HasSuffix(what, "-yaml") || what == "yaml" {
			sendPy(c, http.StatusOK, e.WorkloadObjYaml(c.Request.Context(),
				c.Param("ns"), c.Param("kind"), c.Param("name"), what))
			return
		}
		// drawer helper aliases
		switch what {
		case "pods":
			sendPy(c, http.StatusOK, e.WorkloadPodsAlias(c.Param("ns"), c.Param("kind"), c.Param("name")))
			return
		case "autoIndication":
			sendPy(c, http.StatusOK, e.WorkloadAutoIndication(c.Param("ns"), c.Param("kind"), c.Param("name")))
			return
		case "additional-info":
			sendPy(c, http.StatusOK, pyjson.NewObj())
			return
		}
		sendPy(c, http.StatusNotFound, pyjson.NewObj().Set("error", "not found"))
	})

	// GET /api/workload-yaml/<ns>/<kind>/<name> — drawer YAMLs tab data.
	r.GET("/api/workload-yaml/:ns/:kind/:name", func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.WorkloadYamlData(c.Request.Context(),
			c.Param("ns"), c.Param("kind"), c.Param("name")))
	})

	// GET /api/recommendation/<ns>/<kind>/<name> — composite drawer detail
	// straight from the Recommendation CR (source of truth).
	r.GET("/api/recommendation/:ns/:kind/:name", func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.RecommendationDetail(c.Request.Context(),
			c.Param("ns"), c.Param("kind"), c.Param("name")))
	})

	// GET /api/recommend/<ns>/<kind>/<name> — webhook/agent recommendation read.
	r.GET("/api/recommend/:ns/:kind/:name", func(c *gin.Context) {
		d := e.RecommendFor(c.Request.Context(),
			c.Param("ns"), c.Param("kind"), c.Param("name"))
		if d == nil {
			sendPy(c, http.StatusOK, pyjson.NewObj().Set("found", false))
			return
		}
		sendPy(c, http.StatusOK, d)
	})
}
