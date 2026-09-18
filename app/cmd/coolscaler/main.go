package main

import (
	"context"
	goflag "flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/go-logr/zapr"
	"github.com/spf13/cobra"
	"go.uber.org/zap/zapcore"
	"k8s.io/component-base/featuregate"
	"k8s.io/klog/v2"
	ctrl "sigs.k8s.io/controller-runtime"

	"coolscaler.sh/coolscaler/internal/server"
	"coolscaler.sh/coolscaler/internal/slogger"
	"coolscaler.sh/coolscaler/internal/version"
)

var (
	zapOpts  = slogger.DefaultZapOptions() // --zap-devel/--zap-encoder/--zap-log-level/--zap-stacktrace-level/--zap-time-encoding
	logLevel string                        // --log_level (coolscaler dashboard-api spelling)
	gates    featuregate.MutableFeatureGate
	logger   *slog.Logger
)

// Feature gates accepted for compatibility with kubebuilder-style tooling. Behavior is
// currently a no-op flag surface; they must parse and log.
const (
	gateAllowInPlace    featuregate.Feature = "AllowInPlace"
	gateAutoHealing     featuregate.Feature = "AutoHealing"
	gateCheckArmSupport featuregate.Feature = "CheckArmSupport"
	gateNewPolicyTuning featuregate.Feature = "NewPolicyTuning"
)

func main() {
	root := &cobra.Command{
		Use:           "coolscaler",
		Short:         "CoolScaler — Kubernetes rightsizing & cost optimization",
		Version:       version.Version,
		SilenceUsage:  true,
		SilenceErrors: true,
		PersistentPreRun: func(*cobra.Command, []string) {
			setupLogging()
		},
	}

	// controller-runtime zap flags (full --zap-* set, kubebuilder standard).
	gfs := goflag.NewFlagSet("zap", goflag.ContinueOnError)
	zapOpts.BindFlags(gfs)
	root.PersistentFlags().AddGoFlagSet(gfs)
	// either sets the level.
	root.PersistentFlags().StringVar(&logLevel, "log_level", "",
		"log level (trace|debug|info|warn|error|fatal|panic)")

	// --feature-gates (k8s component-base mapStringBool).
	gates = featuregate.NewFeatureGate()
	if err := gates.Add(map[featuregate.Feature]featuregate.FeatureSpec{
		gateAllowInPlace:    {Default: false, PreRelease: featuregate.Beta},
		gateAutoHealing:     {Default: true, PreRelease: featuregate.Beta},
		gateCheckArmSupport: {Default: false, PreRelease: featuregate.Beta},
		gateNewPolicyTuning: {Default: false, PreRelease: featuregate.Beta},
	}); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
	gates.AddFlag(root.PersistentFlags())

	root.AddCommand(
		newRecommendationCmd(),
		newDashboardAPICmd(),
		newAgentCmd(),
		newUpdaterCmd(),
		newAdmissionsControllerCmd(),
		newNetworkMonitorCmd(),
	)

	if err := root.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

// setupLogging builds the process zap logger and routes EVERYTHING through it:
// slog, controller-runtime, klog.
func setupLogging() {
	if logLevel != "" && zapOpts.Level == nil {
		spec := strings.ToLower(logLevel)
		if spec == "trace" {
			spec = "debug"
		}
		if lvl, err := zapcore.ParseLevel(spec); err == nil {
			zapOpts.Level = lvl
		}
	}
	zl := slogger.NewZap(zapOpts)
	logger = slog.New(slogger.NewZapHandler(zl))
	slog.SetDefault(logger)
	zlr := zapr.NewLogger(zl)
	ctrl.SetLogger(zlr)
	klog.SetLogger(zlr)
	logger.Info("feature gates", "AllowInPlace", gates.Enabled(gateAllowInPlace),
		"AutoHealing", gates.Enabled(gateAutoHealing),
		"CheckArmSupport", gates.Enabled(gateCheckArmSupport),
		"NewPolicyTuning", gates.Enabled(gateNewPolicyTuning))
}

// signalContext is the run context for every subcommand.
func signalContext() (context.Context, context.CancelFunc) {
	return signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
}

// addManagerFlags registers the shared controller-manager flags. Defaults
// are the kubebuilder manager defaults (:18081/:18080); the chart overrides
// them per component (recommender:9999/:8080, updater:8081, netmon:8743/:8742).
func addManagerFlags(cmd *cobra.Command, probeAddr, metricsAddr *string, leaderElect *bool, maxReconciles *int, probeDef, metricsDef string) {
	cmd.Flags().StringVar(probeAddr, "health-probe-bind-address", probeDef,
		"The address the probe endpoint binds to.")
	cmd.Flags().StringVar(metricsAddr, "metrics-bind-address", metricsDef,
		"The address the metric endpoint binds to.")
	if leaderElect != nil {
		cmd.Flags().BoolVar(leaderElect, "leader-elect", false,
			"Enable leader election for controller manager.")
	}
	if maxReconciles != nil {
		cmd.Flags().IntVar(maxReconciles, "max-concurrent-reconciles", 1,
			"Maximum number of concurrent reconciles.")
	}
}

func newRecommendationCmd() *cobra.Command {
	opts := server.RecommendationOptions{}
	cmd := &cobra.Command{
		Use:   "recommendation",
		Short: "Recommender: usage sampling, rightsizing engine, Recommendation CRs, /api",
		RunE: func(*cobra.Command, []string) error {
			ctx, cancel := signalContext()
			defer cancel()
			return server.RunRecommendation(ctx, logger.With("component", "recommendation"), opts)
		},
	}
	addManagerFlags(cmd, &opts.HealthProbeAddr, &opts.MetricsAddr,
		&opts.LeaderElect, &opts.MaxReconciles, ":18081", ":18080")
	return cmd
}

func newDashboardAPICmd() *cobra.Command {
	opts := server.DashboardOptions{Addr: ":8080"}
	cmd := &cobra.Command{
		Use:   "dashboard-api",
		Short: "Dashboard: serves the SPA and proxies /api/* to the recommender",
		RunE: func(*cobra.Command, []string) error {
			ctx, cancel := signalContext()
			defer cancel()
			return server.RunDashboardAPI(ctx, logger.With("component", "dashboard-api"), opts)
		},
	}
	cmd.Flags().StringVarP(&opts.StaticDir, "static", "s", "/build", "directory with the built SPA")
	internalDef := os.Getenv("INTERNAL_BIND_ADDRESS")
	if internalDef == "" {
		internalDef = ":18080"
	}
	cmd.Flags().StringVar(&opts.InternalAddr, "internal-bind-address", internalDef,
		"The address the internal listener binds to (pod port `internal`).")
	return cmd
}

func newAgentCmd() *cobra.Command {
	opts := server.AgentOptions{}
	cmd := &cobra.Command{
		Use:   "agent",
		Short: "Agent: watches new pods, warms the recommender, installs/updates CRDs",
		RunE: func(*cobra.Command, []string) error {
			ctx, cancel := signalContext()
			defer cancel()
			return server.RunAgent(ctx, logger.With("component", "agent"), opts)
		},
	}
	addManagerFlags(cmd, &opts.HealthProbeAddr, &opts.MetricsAddr,
		&opts.LeaderElect, &opts.MaxReconciles, ":18081", ":18080")
	cmd.Flags().BoolVar(&opts.UpdateCRD, "update-crd", true,
		"install/update the CoolScaler CRDs on startup")
	cmd.Flags().BoolVar(&opts.PrometheusEnabled, "prometheus-enabled", true, "enable Prometheus integration")
	cmd.Flags().StringVar(&opts.PrometheusAddress, "prometheus_address", "", "Prometheus base URL override")
	return cmd
}

func newUpdaterCmd() *cobra.Command {
	opts := server.UpdaterOptions{}
	cmd := &cobra.Command{
		Use:   "updater",
		Short: "Updater: reconciles automated workloads when not read-only",
		RunE: func(*cobra.Command, []string) error {
			ctx, cancel := signalContext()
			defer cancel()
			return server.RunUpdater(ctx, logger.With("component", "updater"), opts)
		},
	}
	addManagerFlags(cmd, &opts.HealthProbeAddr, &opts.MetricsAddr,
		&opts.LeaderElect, &opts.MaxReconciles, ":8081", ":18080")
	cmd.Flags().StringVar(&opts.HealthcheckImage, "healthcheck-container-image", "",
		"healthcheck container image (accepted for compatibility; informational)")
	return cmd
}

func newAdmissionsControllerCmd() *cobra.Command {
	opts := server.AdmissionsOptions{}
	cmd := &cobra.Command{
		Use:   "admissions-controller",
		Short: "Admissions: mutating webhook injecting recommendations at pod CREATE",
		RunE: func(*cobra.Command, []string) error {
			ctx, cancel := signalContext()
			defer cancel()
			return server.RunAdmissions(ctx, logger.With("component", "admissions-controller"), opts)
		},
	}
	addManagerFlags(cmd, &opts.HealthProbeAddr, &opts.MetricsAddr,
		&opts.LeaderElect, nil, ":18081", ":18080")
	cmd.Flags().IntVar(&opts.AdmissionsBindPort, "admissions-bind-port", 10250, "webhook HTTPS port")
	cmd.Flags().BoolVar(&opts.GenCert, "gen-cert", true,
		"self-sign the webhook CA + serving cert when none are mounted")
	cmd.Flags().StringVar(&opts.WebhooksServiceName, "webhooks-service-name", "coolscaler-admissions",
		"webhook Service name (cert SANs)")
	cmd.Flags().StringVar(&opts.CertsSecretName, "coolscaler-admissions-certs-secret", "coolscaler-admissions-tls",
		"Secret holding the webhook certs")
	return cmd
}

func newNetworkMonitorCmd() *cobra.Command {
	opts := server.NetmonOptions{}
	cmd := &cobra.Command{
		Use:   "network-monitor",
		Short: "Network monitor: per-node DaemonSet exposing /metrics",
		RunE: func(*cobra.Command, []string) error {
			ctx, cancel := signalContext()
			defer cancel()
			return server.RunNetworkMonitor(ctx, logger.With("component", "network-monitor"), opts)
		},
	}
	addManagerFlags(cmd, &opts.HealthProbeAddr, &opts.MetricsAddr, nil, nil, ":8743", ":8742")
	return cmd
}
