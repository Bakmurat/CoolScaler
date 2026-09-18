package server

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"coolscaler.sh/coolscaler/internal/config"
	"coolscaler.sh/coolscaler/internal/kube"
	"coolscaler.sh/coolscaler/internal/pyjson"
	"coolscaler.sh/coolscaler/internal/webhook"
)

// AdmissionsOptions configures the admissions-controller component.
type AdmissionsOptions struct {
	HealthProbeAddr     string // --health-probe-bind-address
	MetricsAddr         string // --metrics-bind-address
	LeaderElect         bool   // --leader-elect
	AdmissionsBindPort  int
	GenCert             bool   // --gen-cert (self-sign CA + certs when none are mounted)
	WebhooksServiceName string // --webhooks-service-name
	CertsSecretName     string // --coolscaler-admissions-certs-secret
}

func RunAdmissions(ctx context.Context, log *slog.Logger, opts AdmissionsOptions) error {
	cfg := config.Load()
	kc := kube.New()
	mut := webhook.NewMutator(cfg, kc, log)
	log.Info("starting admissions-controller", "readOnly", cfg.ReadOnly,
		"bindPort", opts.AdmissionsBindPort, "genCert", opts.GenCert,
		"service", opts.WebhooksServiceName, "secret", opts.CertsSecretName)

	// Cert resolution: mounted files first (current chart behavior), then --gen-cert
	// self-signing. Fail-open: with neither, the HTTPS listener is skipped —
	// failurePolicy: Ignore keeps pods flowing.
	certFile := filepath.Join(cfg.TLSDir, "tls.crt")
	keyFile := filepath.Join(cfg.TLSDir, "tls.key")
	haveMounted := fileExists(certFile) && fileExists(keyFile)
	if !haveMounted && opts.GenCert {
		outDir := os.Getenv("CERT_DIR")
		if outDir == "" {
			outDir = filepath.Join(os.TempDir(), "coolscaler-admissions-certs")
		}
		cc := webhook.CertConfig{
			ServiceName:       opts.WebhooksServiceName,
			Namespace:         cfg.Namespace,
			SecretName:        opts.CertsSecretName,
			WebhookConfigName: envOr("COOLSCALER_WEBHOOK_CONFIG", "coolscaler-mutating-webhook"),
		}
		paths, err := webhook.EnsureCerts(ctx, kc, log, cc, outDir, writeEnabled())
		if err != nil {
			log.Error("gen-cert failed; webhook listener will be skipped", "err", err)
		} else {
			certFile, keyFile = paths.CertFile, paths.KeyFile
			haveMounted = true
		}
	}

	mgr, mgrErr := newManager(log, kc, managerOptions{
		Component:       "admissions",
		HealthProbeAddr: opts.HealthProbeAddr,
		MetricsAddr:     opts.MetricsAddr,
		LeaderElect:     opts.LeaderElect,
		Namespace:       cfg.Namespace,
	})
	if mgrErr == nil {
		go func() {
			if err := mgr.Start(ctx); err != nil {
				log.Error("manager exited", "err", err)
			}
		}()
	} else {
		log.Error("controller-runtime manager unavailable; running webhook only", "err", mgrErr)
		go func() {
			_ = serveAll(ctx, log,
				&http.Server{Addr: opts.HealthProbeAddr, Handler: newProbeMux()})
		}()
	}

	// Webhook HTTPS listener.
	if haveMounted {
		whMux := http.NewServeMux()
		whMux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodPost {
				mut.ServeMutate(w, r)
				return
			}
			sendPyJSON(w, 200, pyjson.NewObj().Set("ok", true).Set("role", "admissions"))
		})
		srv := &http.Server{
			Addr:      ":" + strconv.Itoa(opts.AdmissionsBindPort),
			Handler:   whMux,
			TLSConfig: &tls.Config{MinVersion: tls.VersionTLS12},
		}
		go func() {
			log.Info("admissions webhook listening", "addr", srv.Addr, "cert", certFile)
			if err := srv.ListenAndServeTLS(certFile, keyFile); err != nil && !errors.Is(err, http.ErrServerClosed) {
				log.Error("admissions webhook server failed", "err", err)
			}
		}()
		defer func() {
			sctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			_ = srv.Shutdown(sctx)
		}()
	} else {
		log.Info("no serving certs (mounted or generated); webhook listener skipped",
			"dir", cfg.TLSDir)
	}

	// Plain-HTTP health/metrics on PORT.
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		sendPyJSON(w, 200, pyjson.NewObj().Set("ok", true).Set("role", "admissions"))
	})
	mux.Handle("GET /metrics", newMetricsHandler("admissions", nil))
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		sendPyJSON(w, 404, pyjson.NewObj().Set("error", "not found"))
	})
	return serveAll(ctx, log,
		&http.Server{Addr: fmt.Sprintf(":%d", cfg.Port), Handler: mux})
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
