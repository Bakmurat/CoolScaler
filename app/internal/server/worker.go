package server

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"coolscaler.sh/coolscaler/internal/config"
	"coolscaler.sh/coolscaler/internal/pyjson"
)

// NetmonOptions configures the network-monitor DaemonSet component.
type NetmonOptions struct {
	HealthProbeAddr string
	MetricsAddr     string
}

// hostProcDir resolves the host /proc mount (chart hostPath /proc →
// /host/proc, read-only). HOST_PROC overrides for local testing.
func hostProcDir() string {
	if d := os.Getenv("HOST_PROC"); d != "" {
		return d
	}
	return "/host/proc"
}

// hostProcMetrics renders node loadavg + PSI pressure metrics from the host
// /proc mount as Prometheus text (with HELP/TYPE). HONEST-ABSENT: anything
// missing or unreadable (no /host/proc mount, kernel without PSI, cpu "full"
// line absent) is simply omitted — no zeros, no fabrication.
func hostProcMetrics(dir string) []byte {
	var b strings.Builder

	// /proc/loadavg → coolscaler_node_load{1,5,15}.
	if raw, err := os.ReadFile(filepath.Join(dir, "loadavg")); err == nil {
		f := strings.Fields(string(raw))
		if len(f) >= 3 {
			names := []string{"1", "5", "15"}
			for i, n := range names {
				v, err := strconv.ParseFloat(f[i], 64)
				if err != nil {
					continue
				}
				fmt.Fprintf(&b, "# HELP coolscaler_node_load%s Node %s-minute load average (host /proc/loadavg).\n", n, n)
				fmt.Fprintf(&b, "# TYPE coolscaler_node_load%s gauge\n", n)
				fmt.Fprintf(&b, "coolscaler_node_load%s %s\n", n, formatMetricFloat(v))
			}
		}
	}

	// /proc/pressure/{cpu,memory,io} → PSI counters. "some" = time at least
	// one task waited on the resource; "full" = all non-idle tasks stalled
	// (cpu usually has no full line — omitted). total= is cumulative usec.
	for _, res := range []string{"cpu", "memory", "io"} {
		raw, err := os.ReadFile(filepath.Join(dir, "pressure", res))
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(raw), "\n") {
			var metric, help string
			switch {
			case strings.HasPrefix(line, "some "):
				metric = "waiting"
				help = fmt.Sprintf("Total seconds at least some tasks stalled on %s (PSI \"some\" total).", res)
			case strings.HasPrefix(line, "full "):
				metric = "stalled"
				help = fmt.Sprintf("Total seconds all non-idle tasks stalled on %s (PSI \"full\" total).", res)
			default:
				continue
			}
			usec, ok := psiTotalMicros(line)
			if !ok {
				continue
			}
			name := fmt.Sprintf("coolscaler_node_pressure_%s_%s_seconds_total", res, metric)
			fmt.Fprintf(&b, "# HELP %s %s\n", name, help)
			fmt.Fprintf(&b, "# TYPE %s counter\n", name)
			fmt.Fprintf(&b, "%s %s\n", name, formatMetricFloat(float64(usec)/1e6))
		}
	}
	return []byte(b.String())
}

// psiTotalMicros extracts the total=<usec> field from a PSI line
// ("some avg10=0.00 avg60=0.00 avg300=0.00 total=12345").
func psiTotalMicros(line string) (uint64, bool) {
	for _, f := range strings.Fields(line) {
		if v, ok := strings.CutPrefix(f, "total="); ok {
			n, err := strconv.ParseUint(v, 10, 64)
			return n, err == nil
		}
	}
	return 0, false
}

// formatMetricFloat renders a float in Prometheus text-format style.
func formatMetricFloat(v float64) string {
	return strconv.FormatFloat(v, 'g', -1, 64)
}

// The same body is also served at /coolscaler_network_metrics — the path the
// DaemonSet's coolscaler.prometheus.io/* scrape annotations advertise (analog
// of /coolscaler_network_metrics).
func RunNetworkMonitor(ctx context.Context, log *slog.Logger, opts NetmonOptions) error {
	cfg := config.Load()
	hostProc := hostProcDir()

	pythonHandler := func() *http.ServeMux {
		mux := http.NewServeMux()
		metricsFn := func(w http.ResponseWriter, _ *http.Request) {
			body := pythonComponentMetrics("netmon", true)
			body = append(body, hostProcMetrics(hostProc)...)
			w.Header().Set("Content-Type", "text/plain")
			w.Header().Set("Content-Length", strconv.Itoa(len(body)))
			w.WriteHeader(200)
			_, _ = w.Write(body)
		}
		mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
			sendPyJSON(w, 200, pyjson.NewObj().Set("ok", true).Set("role", "netmon"))
		})
		mux.HandleFunc("GET /metrics", metricsFn)
		mux.HandleFunc("GET /coolscaler_network_metrics", metricsFn)
		mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
			sendPyJSON(w, 404, pyjson.NewObj().Set("error", "not found"))
		})
		return mux
	}

	// Probe endpoints on the health-probe address.
	probeMux := newProbeMux()

	servers := []*http.Server{
		{Addr: opts.MetricsAddr, Handler: pythonHandler()},
		{Addr: opts.HealthProbeAddr, Handler: probeMux},
	}
	// PORT compatibility: the current chart probes/scrapes:8080. Serve
	// the same handler there too unless it collides.
	portAddr := fmt.Sprintf(":%d", cfg.Port)
	if portAddr != opts.MetricsAddr && portAddr != opts.HealthProbeAddr {
		servers = append(servers, &http.Server{Addr: portAddr, Handler: pythonHandler()})
	}
	log.Info("starting network-monitor", "metrics", opts.MetricsAddr,
		"probes", opts.HealthProbeAddr, "port", portAddr, "hostProc", hostProc)
	return serveAll(ctx, log, servers...)
}
