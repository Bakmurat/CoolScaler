package server

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"time"
)

// newProbeMux is the controller health-probe endpoint set (:9999).
func newProbeMux() *http.ServeMux {
	mux := http.NewServeMux()
	ok := func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	}
	mux.HandleFunc("GET /healthz", ok)
	mux.HandleFunc("GET /readyz", ok)
	return mux
}

// serveAll runs the given HTTP servers until ctx is cancelled or one of them
// fails, then gracefully shuts all of them down.
func serveAll(ctx context.Context, log *slog.Logger, servers ...*http.Server) error {
	errCh := make(chan error, len(servers))
	for _, srv := range servers {
		srv := srv
		go func() {
			log.Info("listening", "addr", srv.Addr)
			if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
				errCh <- err
			}
		}()
	}

	var err error
	select {
	case <-ctx.Done():
	case err = <-errCh:
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for _, srv := range servers {
		_ = srv.Shutdown(shutdownCtx)
	}
	return err
}

func jsonError(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_, _ = w.Write([]byte(`{"error":"` + msg + `"}`))
}
