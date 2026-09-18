package server

import (
	"context"
	"log/slog"
	"os"
	"strings"

	"github.com/prometheus/client_golang/prometheus"
	"k8s.io/apimachinery/pkg/runtime"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/cache"
	"sigs.k8s.io/controller-runtime/pkg/healthz"
	"sigs.k8s.io/controller-runtime/pkg/manager"
	metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"

	"coolscaler.sh/coolscaler/internal/config"
	"coolscaler.sh/coolscaler/internal/kube"
)

// writeEnabled reports the WRITE_ENABLED cluster-mutation gate.
func writeEnabled() bool {
	return strings.EqualFold(os.Getenv("WRITE_ENABLED"), "true")
}

// managerOptions configures the controller-runtime manager every controller
// subcommand (recommendation / updater / admissions-controller / agent) runs.
type managerOptions struct {
	Component       string // lease/component name: recommender|updater|agent|admissions
	HealthProbeAddr string // --health-probe-bind-address
	MetricsAddr     string // --metrics-bind-address ("0" disables)
	LeaderElect     bool   // --leader-elect (kubebuilder standard)
	Namespace       string // cache + leader-election namespace
}

var scheme = runtime.NewScheme()

func init() {
	_ = clientgoscheme.AddToScheme(scheme)
}

// Leader election only engages when WRITE_ENABLED=true
func newManager(log *slog.Logger, kc *kube.Client, mo managerOptions) (manager.Manager, error) {
	restCfg, err := kc.RESTConfig()
	if err != nil {
		return nil, err
	}
	le := mo.LeaderElect
	if le && !writeEnabled() {
		log.Info("leader election requested but WRITE_ENABLED=false; running without leases")
		le = false
	}
	ns := mo.Namespace
	if ns == "" {
		ns = config.Namespace()
	}
	mgr, err := ctrl.NewManager(restCfg, ctrl.Options{
		Scheme:                     scheme,
		HealthProbeBindAddress:     mo.HealthProbeAddr,
		Metrics:                    metricsserver.Options{BindAddress: mo.MetricsAddr},
		LeaderElection:             le,
		LeaderElectionID:           "coolscaler-" + mo.Component + "-lease",
		LeaderElectionNamespace:    ns,
		LeaderElectionResourceLock: "leases",
		Cache: cache.Options{
			// CoolScaler CRs live in the component namespace only.
			DefaultNamespaces: map[string]cache.Config{ns: {}},
		},
	})
	if err != nil {
		return nil, err
	}
	if err := mgr.AddHealthzCheck("healthz", healthz.Ping); err != nil {
		return nil, err
	}
	if err := mgr.AddReadyzCheck("readyz", healthz.Ping); err != nil {
		return nil, err
	}
	return mgr, nil
}

// leaderRunnable adapts a loop func into a leader-gated manager Runnable.
type leaderRunnable struct{ run func(context.Context) error }

func (l leaderRunnable) Start(ctx context.Context) error { return l.run(ctx) }
func (l leaderRunnable) NeedLeaderElection() bool        { return true }

// plainRunnable runs regardless of leadership.
type plainRunnable struct{ run func(context.Context) error }

func (p plainRunnable) Start(ctx context.Context) error { return p.run(ctx) }
func (p plainRunnable) NeedLeaderElection() bool        { return false }

// mustRegister registers collectors into a registry, tolerating duplicates.
func mustRegister(reg prometheus.Registerer, cs ...prometheus.Collector) {
	for _, c := range cs {
		if err := reg.Register(c); err != nil {
			if _, ok := err.(prometheus.AlreadyRegisteredError); !ok {
				panic(err)
			}
		}
	}
}
