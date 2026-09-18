package server

import (
	"context"
	"log/slog"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"coolscaler.sh/coolscaler/internal/api"
	"coolscaler.sh/coolscaler/internal/config"
	"coolscaler.sh/coolscaler/internal/kube"
)

// DashboardOptions configures the dashboard-api component.
type DashboardOptions struct {
	Addr         string // API/UI bind address (:8080)
	InternalAddr string // --internal-bind-address (:18080), the pod's `internal` port
	StaticDir    string // --static (default /build), the SPA bundle
}

// RunDashboardAPI serves the SPA and reverse-proxies /api/* to the recommender.
func RunDashboardAPI(ctx context.Context, log *slog.Logger, opts DashboardOptions) error {
	cfg := config.Load()

	target, err := url.Parse(cfg.RecommenderURL)
	if err != nil {
		return err
	}
	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		log.Warn("api proxy error", "path", r.URL.Path, "err", err)
		jsonError(w, http.StatusBadGateway, "recommender unreachable")
	}

	r := newGin(log, "dashboard-api")
	r.GET("/ping", api.Ping)
	r.GET("/metrics", gin.WrapH(newMetricsHandler("dashboards", nil)))
	r.Any("/api/*any", gin.WrapH(proxy))
	r.NoRoute(spaHandler(opts.StaticDir))

	// Both loops are WRITE_ENABLED-gated inside runLeaseLoop.
	kc := kube.New()
	pod := podName()
	go runLeaseLoop(ctx, log, kc, config.Namespace(), "coolscaler-dashboards-lease",
		time.Duration(cfg.LeaseDurationSeconds)*time.Second, pod+"_"+processUUID())
	go runLeaseLoop(ctx, log, kc, config.Namespace(), "coolscaler-dashboards-lease",
		60*time.Second, pod)

	// Second listener on the pod's `internal` port (:18080)
	internalAddr := opts.InternalAddr
	if internalAddr == "" {
		internalAddr = ":18080"
	}
	log.Info("dashboard-api", "static", opts.StaticDir, "recommender", cfg.RecommenderURL,
		"internal", internalAddr)
	return serveAll(ctx, log,
		&http.Server{Addr: opts.Addr, Handler: r},
		&http.Server{Addr: internalAddr, Handler: r})
}

// spaHandler serves files from dir; any non-/api path without a file
// extension falls back to index.html (client-side routing). Unknown /api
// paths (unreachable here in practice
func spaHandler(dir string) gin.HandlerFunc {
	return func(c *gin.Context) {
		reqPath := path.Clean("/" + c.Request.URL.Path)
		if strings.HasPrefix(reqPath, "/api") {
			api.NotFound(c)
			return
		}
		if c.Request.Method != http.MethodGet && c.Request.Method != http.MethodHead {
			api.NotFound(c)
			return
		}
		full := filepath.Join(dir, filepath.FromSlash(reqPath))
		if st, err := os.Stat(full); err == nil && !st.IsDir() {
			c.File(full)
			return
		}
		if filepath.Ext(reqPath) != "" {
			api.NotFound(c)
			return
		}
		c.File(filepath.Join(dir, "index.html"))
	}
}
