package server

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"coolscaler.sh/coolscaler/internal/config"
	"coolscaler.sh/coolscaler/internal/crds"
	"coolscaler.sh/coolscaler/internal/kube"
	"coolscaler.sh/coolscaler/internal/pyjson"
)

// AgentOptions configures the agent component.
type AgentOptions struct {
	HealthProbeAddr   string // --health-probe-bind-address
	MetricsAddr       string // --metrics-bind-address
	LeaderElect       bool   // --leader-elect
	MaxReconciles     int
	UpdateCRD         bool
	PrometheusEnabled bool
	PrometheusAddress string
}

func RunAgent(ctx context.Context, log *slog.Logger, opts AgentOptions) error {
	cfg := config.Load()
	kc := kube.New()
	log.Info("starting agent", "interval", cfg.AgentIntervalSeconds,
		"updateCRD", opts.UpdateCRD, "prometheusEnabled", opts.PrometheusEnabled)

	if opts.UpdateCRD {
		results := crds.Ensure(ctx, kc, log, writeEnabled())
		inSync, pending := 0, 0
		for _, r := range results {
			switch r.Action {
			case "in-sync", "created", "updated":
				inSync++
			default:
				pending++
			}
		}
		log.Info("crd reconcile finished", "total", len(results),
			"applied", inSync, "pending", pending, "writeEnabled", writeEnabled())
	}

	mgr, mgrErr := newManager(log, kc, managerOptions{
		Component:       "agent",
		HealthProbeAddr: opts.HealthProbeAddr,
		MetricsAddr:     opts.MetricsAddr,
		LeaderElect:     opts.LeaderElect,
		Namespace:       cfg.Namespace,
	})
	loop := func(c context.Context) error {
		agentLoop(c, log, cfg, kc)
		return nil
	}
	if mgrErr == nil {
		if err := mgr.Add(plainRunnable{run: loop}); err != nil {
			log.Error("agent loop setup failed", "err", err)
		}
		go func() {
			if err := mgr.Start(ctx); err != nil {
				log.Error("manager exited", "err", err)
			}
		}()
	} else {
		log.Error("controller-runtime manager unavailable; running loop only", "err", mgrErr)
		go func() { _ = loop(ctx) }()
		go func() {
			_ = serveAll(ctx, log,
				&http.Server{Addr: opts.HealthProbeAddr, Handler: newProbeMux()})
		}()
	}

	// Health/metrics HTTP on PORT.
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		sendPyJSON(w, 200, pyjson.NewObj().Set("ok", true).Set("role", "agent"))
	})
	mux.Handle("GET /metrics", newMetricsHandler("agent", nil))
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		sendPyJSON(w, 404, pyjson.NewObj().Set("error", "not found"))
	})
	return serveAll(ctx, log,
		&http.Server{Addr: fmt.Sprintf(":%d", cfg.Port), Handler: mux})
}

func agentLoop(ctx context.Context, log *slog.Logger, cfg config.Config, kc *kube.Client) {
	seen := map[string]bool{}
	interval := time.Duration(cfg.AgentIntervalSeconds) * time.Second
	for {
		pods, err := kc.GetJSON(ctx, "/api/v1/pods")
		if err != nil {
			log.Error("agent error", "err", err)
		} else {
			newPods := 0
			items, _ := pods.GetD("items", nil).([]any)
			for _, pv := range items {
				p, _ := pv.(*pyjson.Obj)
				if p == nil {
					continue
				}
				md, _ := p.GetD("metadata", nil).(*pyjson.Obj)
				uid := str(md.GetD("uid", ""))
				if uid != "" && !seen[uid] {
					seen[uid] = true
					newPods++
				}
			}
			if newPods > 0 {
				log.Info(fmt.Sprintf("observed %d new pods; warming recommender", newPods))
				_, _, _ = httpPost(ctx, cfg.RecommenderURL+"/api/notify", []byte("{}"), 8*time.Second)
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(interval):
		}
	}
}
