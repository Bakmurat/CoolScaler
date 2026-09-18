package server

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"sync/atomic"
	"time"

	"coolscaler.sh/coolscaler/internal/config"
	"coolscaler.sh/coolscaler/internal/kube"
	"coolscaler.sh/coolscaler/internal/pyjson"
)

// UpdaterOptions configures the updater component.
type UpdaterOptions struct {
	HealthProbeAddr  string
	MetricsAddr      string // --metrics-bind-address
	LeaderElect      bool   // --leader-elect
	MaxReconciles    int
	HealthcheckImage string
}

func RunUpdater(ctx context.Context, log *slog.Logger, opts UpdaterOptions) error {
	cfg := config.Load()
	kc := kube.New()
	log.Info("starting updater", "readOnly", cfg.ReadOnly,
		"interval", cfg.UpdaterIntervalSeconds, "minApplySavings", cfg.MinApplySavings,
		"healthcheckImage", opts.HealthcheckImage)

	// Leadership: fail-open true
	var isLeader atomic.Bool
	isLeader.Store(true)

	kick := make(chan struct{}, 1)
	loop := func(c context.Context) error {
		updaterLoop(c, log, cfg, &isLeader, kick)
		return nil
	}

	mgr, mgrErr := newManager(log, kc, managerOptions{
		Component:       "updater",
		HealthProbeAddr: opts.HealthProbeAddr,
		MetricsAddr:     opts.MetricsAddr,
		LeaderElect:     opts.LeaderElect,
		Namespace:       cfg.Namespace,
	})
	if mgrErr == nil {
		if opts.LeaderElect && writeEnabled() {
			isLeader.Store(false)
			if err := mgr.Add(plainRunnable{run: func(c context.Context) error {
				select {
				case <-mgr.Elected():
					isLeader.Store(true)
				case <-c.Done():
				}
				return nil
			}}); err != nil {
				log.Error("elected tracker setup failed", "err", err)
			}
		}
		// The reconcile loop only runs on the leader.
		if err := mgr.Add(leaderRunnable{run: loop}); err != nil {
			log.Error("updater loop setup failed", "err", err)
		}
		go func() {
			if err := mgr.Start(ctx); err != nil {
				log.Error("manager exited", "err", err)
			}
		}()
	} else {
		log.Error("controller-runtime manager unavailable; running loop + API only", "err", mgrErr)
		go func() { _ = loop(ctx) }()
		go func() {
			_ = serveAll(ctx, log,
				&http.Server{Addr: opts.HealthProbeAddr, Handler: newProbeMux()})
		}()
	}

	// The updater HTTP API on PORT (chart service coolscaler-updater maps
	// 8082 -> this port)
	mux := http.NewServeMux()
	metrics := newMetricsHandler("updater", isLeader.Load)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		sendPyJSON(w, 200, pyjson.NewObj().
			Set("ok", true).Set("role", "updater").Set("leader", isLeader.Load()))
	})
	mux.Handle("GET /metrics", metrics)
	post := func(w http.ResponseWriter, r *http.Request) {
		updaterPost(w, r, log, cfg, &isLeader, kick)
	}
	mux.HandleFunc("POST /apply", post)
	mux.HandleFunc("POST /reconcile", post)
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		sendPyJSON(w, 404, pyjson.NewObj().Set("error", "not found"))
	})
	return serveAll(ctx, log,
		&http.Server{Addr: fmt.Sprintf(":%d", cfg.Port), Handler: mux})
}

// the recommender falls back to a rolling update). WRITE_ENABLED=false
// records the would-be POST bodies instead.
func updaterLoop(ctx context.Context, log *slog.Logger, cfg config.Config, isLeader *atomic.Bool, kick <-chan struct{}) {
	interval := time.Duration(cfg.UpdaterIntervalSeconds) * time.Second
	for {
		if !cfg.ReadOnly && isLeader.Load() {
			if applied, err := updaterReconcileOnce(ctx, log, cfg); err != nil {
				log.Error("updater error", "err", err)
			} else if applied > 0 {
				log.Info(fmt.Sprintf("reconciled %d automated workloads in place", applied))
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(interval):
		case <-kick: // POST /reconcile schedules an immediate pass
		}
	}
}

func updaterReconcileOnce(ctx context.Context, log *slog.Logger, cfg config.Config) (int, error) {
	raw, _, err := httpGet(ctx, cfg.RecommenderURL+"/api/workloads", 15*time.Second)
	if err != nil {
		return 0, err
	}
	v, err := pyjson.Decode(raw)
	if err != nil {
		return 0, err
	}
	d, _ := v.(*pyjson.Obj)
	if d == nil {
		return 0, nil
	}
	applied := 0
	wls, _ := d.Get("workloads")
	list, _ := wls.([]any)
	for _, wv := range list {
		w, _ := wv.(*pyjson.Obj)
		if w == nil {
			continue
		}
		automated, _ := w.GetD("automated", false).(bool)
		sizable, _ := w.GetD("sizable", false).(bool)
		// Gate on the savings a resize can actually reclaim (main containers
		// only). The headline `savings` includes init-container overhead that a
		// resize can never realize — gating on it re-"optimized" the same
		// workload every cycle forever.
		savings := pyFloat(w.GetD("resizableSavings", w.GetD("savings", 0.0)))
		if !(automated && sizable && savings > cfg.MinApplySavings) {
			continue
		}
		body := pyjson.NewObj().
			Set("namespace", w.GetD("namespace", cfg.Namespace)).
			Set("kind", w.GetD("kind", "Deployment")).
			Set("name", w.GetD("name", "")).
			Set("source", "automation")

		if !writeEnabled() {
			log.Info("dry-run: would POST /api/resize",
				"namespace", str(body.GetD("namespace", "")),
				"kind", str(body.GetD("kind", "")),
				"name", str(body.GetD("name", "")))
			recordDryRun("POST", cfg.RecommenderURL+"/api/resize", "application/json", body)
			continue
		}
		if _, _, err := httpPost(ctx, cfg.RecommenderURL+"/api/resize",
			pyjson.Marshal(body), 20*time.Second); err == nil {
			applied++
		}
	}
	return applied, nil
}

func updaterPost(w http.ResponseWriter, r *http.Request, log *slog.Logger, cfg config.Config, isLeader *atomic.Bool, kick chan<- struct{}) {
	holder := holderID()
	if cfg.ReadOnly {
		sendPyJSON(w, 400, pyjson.NewObj().Set("error", "read-only"))
		return
	}
	if !isLeader.Load() {
		sendPyJSON(w, 409, pyjson.NewObj().Set("error", "not leader").Set("holder", holder))
		return
	}
	var req *pyjson.Obj
	if raw, err := io.ReadAll(io.LimitReader(r.Body, 1<<20)); err == nil && len(raw) > 0 {
		if v, err := pyjson.Decode(raw); err == nil {
			req, _ = v.(*pyjson.Obj)
		}
	}
	if req == nil {
		req = pyjson.NewObj()
	}
	// /apply: resize one workload now; /reconcile: kick the full loop.
	if r.URL.Path == "/apply" && str(req.GetD("name", "")) != "" {
		body := pyjson.NewObj().
			Set("namespace", req.GetD("namespace", cfg.Namespace)).
			Set("kind", req.GetD("kind", "Deployment")).
			Set("name", req.GetD("name", nil))
		if !writeEnabled() {
			log.Info("dry-run: would POST /api/resize (apply)", "name", str(req.GetD("name", "")))
			recordDryRun("POST", cfg.RecommenderURL+"/api/resize", "application/json", body)
			sendPyJSON(w, 200, pyjson.NewObj().
				Set("applied", req.GetD("name", nil)).Set("by", holder))
			return
		}
		if _, _, err := httpPost(r.Context(), cfg.RecommenderURL+"/api/resize",
			pyjson.Marshal(body), 20*time.Second); err != nil {
			sendPyJSON(w, 502, pyjson.NewObj().Set("error", err.Error()))
			return
		}
		sendPyJSON(w, 200, pyjson.NewObj().
			Set("applied", req.GetD("name", nil)).Set("by", holder))
		return
	}
	select {
	case kick <- struct{}{}:
	default:
	}
	sendPyJSON(w, 200, pyjson.NewObj().Set("reconcile", "scheduled").Set("by", holder))
}

// small shared helpers

func sendPyJSON(w http.ResponseWriter, code int, body any) {
	data := pyjson.Marshal(body)
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.WriteHeader(code)
	_, _ = w.Write(data)
}

func httpGet(ctx context.Context, url string, timeout time.Duration) ([]byte, int, error) {
	return httpDo(ctx, http.MethodGet, url, nil, timeout)
}

func httpPost(ctx context.Context, url string, body []byte, timeout time.Duration) ([]byte, int, error) {
	return httpDo(ctx, http.MethodPost, url, body, timeout)
}

func httpDo(ctx context.Context, method, url string, body []byte, timeout time.Duration) ([]byte, int, error) {
	c, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var rd io.Reader
	if body != nil {
		rd = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(c, method, url, rd)
	if err != nil {
		return nil, 0, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if err != nil {
		return nil, resp.StatusCode, err
	}
	if resp.StatusCode/100 != 2 {
		return data, resp.StatusCode, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return data, resp.StatusCode, nil
}

func str(v any) string {
	s, _ := v.(string)
	return s
}

func pyFloat(v any) float64 {
	switch t := v.(type) {
	case float64:
		return t
	case int64:
		return float64(t)
	case int:
		return float64(t)
	}
	return 0
}
