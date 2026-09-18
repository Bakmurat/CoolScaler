package api

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"

	"coolscaler.sh/coolscaler/internal/engine"
	"coolscaler.sh/coolscaler/internal/pyjson"
)

// str / getListAny — tiny local coercers for pyjson.Obj values.
func str(v any) string {
	s, _ := v.(string)
	return s
}

func getListAny(o *pyjson.Obj, key string) []any {
	l, _ := o.GetD(key, nil).([]any)
	return l
}

// RegisterDashboards mounts the Analytics-Dashboards family: dashboard
// registry (builtin Performance + ConfigMap-persisted customs), chart
// catalog, save/delete, and the per-chart series data endpoint.
func RegisterDashboards(r gin.IRouter, e *engine.Engine) {
	r.GET("/api/dashboards", func(c *gin.Context) {
		sendPy(c, http.StatusOK, e.DashboardsData(c.Request.Context()))
	})
	r.POST("/api/dashboards/save", func(c *gin.Context) {
		code, body := e.SaveDashboard(c.Request.Context(), readBody(c))
		sendPy(c, code, body)
	})
	r.POST("/api/dashboards/delete", func(c *gin.Context) {
		code, body := e.DeleteDashboard(c.Request.Context(), readBody(c))
		sendPy(c, code, body)
	})
	const dashIDPrefix = "grid-layout-workload_troubleshoot_dashboard_category-"
	stripID := func(id string) string {
		if i := strings.LastIndex(id, "_category-"); i >= 0 {
			return id[i+len("_category-"):]
		}
		return strings.TrimPrefix(id, "grid-layout-")
	}
	customByName := func(c *gin.Context, name string) *pyjson.Obj {
		d := e.DashboardsData(c.Request.Context())
		for _, dv := range getListAny(d, "dashboards") {
			o, _ := dv.(*pyjson.Obj)
			if o == nil {
				continue
			}
			if b, _ := o.GetD("builtin", false).(bool); b {
				continue
			}
			if s, _ := o.GetD("name", "").(string); s == name {
				return o
			}
		}
		return nil
	}
	layoutOf := func(o *pyjson.Obj) string {
		items := []any{}
		for i, cv := range getListAny(o, "charts") {
			items = append(items, pyjson.NewObj().
				Set("i", cv).Set("x", i%2).Set("y", i/2).Set("w", 1).Set("h", 1))
		}
		return string(pyjson.Marshal(items))
	}
	r.GET("/api/analytics/all-custom-dashboards", func(c *gin.Context) {
		names := []any{}
		d := e.DashboardsData(c.Request.Context())
		for _, dv := range getListAny(d, "dashboards") {
			o, _ := dv.(*pyjson.Obj)
			if o == nil {
				continue
			}
			if b, _ := o.GetD("builtin", false).(bool); b {
				continue
			}
			if s, _ := o.GetD("name", "").(string); s != "" {
				names = append(names, dashIDPrefix+s)
			}
		}
		sendPy(c, http.StatusOK, pyjson.NewObj().Set("dashboards", names))
	})
	r.GET("/api/analytics/custom-dashboard", func(c *gin.Context) {
		name := stripID(c.Query("dashboardId"))
		o := customByName(c, name)
		if o == nil {
			sendPy(c, http.StatusOK, pyjson.NewObj().Set("error", "dashboardId  not found"))
			return
		}
		sendPy(c, http.StatusOK, pyjson.NewObj().Set("layout", layoutOf(o)))
	})
	r.POST("/api/analytics/custom-dashboard", func(c *gin.Context) {
		body := readBody(c)
		name := stripID(str(body.GetD("dashboardId", "")))
		var charts []any
		if v, err := pyjson.Decode([]byte(str(body.GetD("layout", "")))); err == nil {
			if l, ok := v.([]any); ok {
				for _, iv := range l {
					if o, ok := iv.(*pyjson.Obj); ok {
						if id := str(o.GetD("i", "")); id != "" {
							charts = append(charts, id)
						}
					}
				}
			}
		}
		code, resp := e.SaveDashboard(c.Request.Context(), pyjson.NewObj().
			Set("name", name).Set("charts", charts).Set("aggregation", "workloads"))
		sendPy(c, code, resp)
	})
	r.DELETE("/api/analytics/custom-dashboard", func(c *gin.Context) {
		body := readBody(c)
		name := stripID(str(body.GetD("dashboardId", "")))
		code, resp := e.DeleteDashboard(c.Request.Context(), pyjson.NewObj().Set("name", name))
		sendPy(c, code, resp)
	})

	r.GET("/api/dashboards/data", func(c *gin.Context) {
		csv := func(name string) []string {
			var out []string
			for _, v := range strings.Split(c.Query(name), ",") {
				if v = strings.TrimSpace(v); v != "" {
					out = append(out, v)
				}
			}
			return out
		}
		epoch := func(name string) *int64 {
			s := c.Query(name)
			if s == "" {
				return nil
			}
			n, err := strconv.ParseInt(s, 10, 64)
			if err != nil {
				return nil
			}
			if n > 1e12 { // ms epoch -> seconds
				n /= 1000
			}
			return &n
		}
		filters := engine.DashFilters{
			Namespaces: csv("namespaces"),
			Types:      csv("types"),
			Workloads:  csv("workloads"),
		}
		sendPy(c, http.StatusOK, e.DashboardsChartData(
			c.Request.Context(), csv("charts"),
			c.DefaultQuery("range", "24h"), epoch("from"), epoch("to"),
			c.Query("aggregation"), filters))
	})
}
