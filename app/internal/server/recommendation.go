package server

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/controller"
	ctrlmetrics "sigs.k8s.io/controller-runtime/pkg/metrics"

	"coolscaler.sh/coolscaler/internal/api"
	"coolscaler.sh/coolscaler/internal/config"
	"coolscaler.sh/coolscaler/internal/engine"
	"coolscaler.sh/coolscaler/internal/kube"
)

// RecommendationOptions configures the recommendation (recommender) component.
type RecommendationOptions struct {
	HealthProbeAddr string
	MetricsAddr     string
	LeaderElect     bool   // --leader-elect
	MaxReconciles   int    // --max-concurrent-reconciles
}

// recReconciler reconciles Recommendation CRs: any change re-enqueues an
// engine refresh (cheap: the sampler loop is woken early; a full Refresh
// re-reads every workload including the touched one).
type recReconciler struct {
	eng *engine.Engine
	log *slog.Logger
}

func (r *recReconciler) Reconcile(_ context.Context, req ctrl.Request) (ctrl.Result, error) {
	r.log.Debug("recommendation reconcile", "name", req.Name, "namespace", req.Namespace)
	r.eng.KickRefresh()
	return ctrl.Result{}, nil
}

// RunRecommendation starts the recommender: a controller-runtime manager (probes,
// metrics, leader election, Recommendation reconciler) with the Gin /api server
// on PORT (:8080) alongside it
func RunRecommendation(ctx context.Context, log *slog.Logger, opts RecommendationOptions) error {
	cfg := config.Load()
	kc := kube.New()
	eng := engine.New(cfg, kc, log)
	log.Info("starting recommendation engine",
		"cluster", cfg.ClusterName, "readOnly", cfg.ReadOnly, "prom", cfg.PrometheusURL)
	eng.Start(ctx)

	apiAddr := fmt.Sprintf(":%d", cfg.Port)

	// Custom gauges into the shared controller-runtime registry, next to
	// the default Go collectors.
	mustRegister(ctrlmetrics.Registry,
		newComponentCollector("recommender", eng.IsLeader),
		newNodeCostCollector(eng),
		newHealthCheckCollector(eng))

	// The manager's metrics endpoint; when the chart points it at the API port,
	// Gin serves /metrics instead and the manager's own listener is disabled.
	metricsAddr := opts.MetricsAddr
	if metricsAddr == apiAddr {
		metricsAddr = "0"
	}

	mgr, mgrErr := newManager(log, kc, managerOptions{
		Component:       "recommender",
		HealthProbeAddr: opts.HealthProbeAddr,
		MetricsAddr:     metricsAddr,
		LeaderElect:     opts.LeaderElect,
		Namespace:       cfg.Namespace,
	})
	if mgrErr == nil {
		u := &unstructured.Unstructured{}
		u.SetGroupVersionKind(kube.GroupVersion.WithKind("Recommendation"))
		maxRec := opts.MaxReconciles
		if maxRec < 1 {
			maxRec = 1
		}
		if err := ctrl.NewControllerManagedBy(mgr).
			Named("recommendation").
			For(u).
			WithOptions(controller.Options{MaxConcurrentReconciles: maxRec}).
			Complete(&recReconciler{eng: eng, log: log}); err != nil {
			log.Error("recommendation controller setup failed", "err", err)
		}
		// Track leadership for the engine + /metrics coolscaler_leader gauge.
		if err := mgr.Add(plainRunnable{run: func(c context.Context) error {
			select {
			case <-mgr.Elected():
				eng.SetLeader(true)
			case <-c.Done():
			}
			return nil
		}}); err != nil {
			log.Error("elected tracker setup failed", "err", err)
		}
		if opts.LeaderElect && writeEnabled() {
			eng.SetLeader(false)
		}
		go func() {
			if err := mgr.Start(ctx); err != nil {
				log.Error("manager exited", "err", err)
			}
		}()
	} else {
		// Probes fall back to a plain mux.
		log.Error("controller-runtime manager unavailable; running API-only", "err", mgrErr)
		go func() {
			_ = serveAll(ctx, log,
				&http.Server{Addr: opts.HealthProbeAddr, Handler: newProbeMux()})
		}()
	}

	r := newGin(log, "recommendation")
	r.GET("/healthz", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"ok": true, "role": "recommender"})
	})
	r.GET("/ping", api.Ping)
	r.GET("/metrics", gin.WrapH(promhttp.HandlerFor(ctrlmetrics.Registry, promhttp.HandlerOpts{})))
	api.Register(r, eng)
	api.RegisterMisc(r, eng)
	api.RegisterNodes(r, eng)
	api.RegisterPages(r, eng)
	api.RegisterDrawer(r, eng)
	api.RegisterDashboards(r, eng)
	// Unknown paths (incl. unknown /api/*) get the Gin 404 envelope.
	r.NoRoute(api.NotFound)

	return serveAll(ctx, log, &http.Server{Addr: apiAddr, Handler: r})
}

func newGin(log *slog.Logger, component string) *gin.Engine {
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.Recovery(), api.Middleware(component))
	return r
}
