package engine

import (
	"context"
	"log/slog"
	"os"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"coolscaler.sh/coolscaler/internal/config"
	"coolscaler.sh/coolscaler/internal/kube"
	"coolscaler.sh/coolscaler/internal/prom"
	"coolscaler.sh/coolscaler/internal/pyjson"
)

// histPoint is one in-memory usage sample.
type histPoint struct {
	cpu, mem float64
}

type origReq struct {
	cpu, mem float64
}

type Engine struct {
	Cfg  config.Config
	Kube *kube.Client
	Prom *prom.Client
	Log  *slog.Logger

	mu sync.Mutex

	// STATE
	overview   *pyjson.Obj
	workloads  []*wlRow
	namespaces []*nsSaving
	byKey      map[string]*wlRow
	lastUpdate int64
	ready      bool
	dataSource string
	minNodeCpu float64

	// rolling in-memory usage history: key -> container -> ring buffer
	history map[string]map[string][]histPoint

	// replica-optimization history
	replicaHistory map[string][]replicaPoint

	// automation state (rebuilt from Recommendation CRs at startup)
	automated           map[string]bool
	excluded            map[string]bool
	automationSource    map[string]string
	replicasAutomated   map[string]bool
	placementAutomated  map[string]bool
	schedulingAutomated map[string]bool

	// ORIGIN_REQ — original (pre-optimization) per-replica request totals,
	// re-seeded from the Recommendation CRs' preserved originRequests.
	originReq map[string]*origReq

	// GLOBAL_AUTO (automation scoping), loaded from the
	// coolscaler-automation-config ConfigMap at startup.
	globalAuto *pyjson.Obj

	// Custom namespace labels (coolscaler-custom-namespace-labels CM)
	customNsLabels map[string][]string

	// CLUSTER_HEADROOM
	headroomEnabled bool
	headroomCpuPct  float64
	headroomMemPct  float64

	// cost model "globals" (mutated by the coolscaler-cost-config ConfigMap)
	costCPUCoreMonth       float64
	costMemGBMonth         float64
	costGPUHourly          float64
	spotFraction           float64
	includeUnallocatedCost bool
	costSpotHourly         *pyjson.Obj // explicit user-saved spot rates or nil

	// policy-rules model (detection rules), possibly replaced from the
	// coolscaler-policy-rules ConfigMap.
	policyRules []any

	// schedule-policy registry (built-ins + user type:Schedule Policy CRs)
	schedulePolicies []*schedulePolicy
	scheduleByName   map[string]*schedulePolicy


	// ANALYTICS / COST_OVERTIME / ATTR_CATALOG snapshots (refresh output).
	analytics     []*pyjson.Obj
	costOvertime  []*pyjson.Obj
	costOvertimeN int
	attrCatalog   *pyjson.Obj

	// AUDIT (bounded, newest first) + ALERT_RULES (ordered, mutable).
	auditLog   []*pyjson.Obj
	alertRules *pyjson.Obj

	// CLUSTER_HEADROOM extra flag (enabled/cpu/mem already above) + the raw
	// POSTed values.
	headroomScheduled bool
	headroomRaw       *pyjson.Obj

	// product automation registries.
	replicasPolicyAssign map[string]string // REPLICAS_POLICY_ASSIGN
	schedulingPolAssign  map[string]string // SCHEDULING_POLICY_ASSIGN
	downscaleAssign      map[string]string // DOWNSCALE_ASSIGN
	downscaleAutomated   map[string]bool   // DOWNSCALE_AUTOMATED
	javaAutomated        map[string]bool   // JAVA_AUTOMATED
	javaUnautomated      map[string]bool   // JAVA_UNAUTOMATED
	javaHealing          map[string]*pyjson.Obj

	// Auto-healing CPU-stress / burst-reaction decaying boosts, keyed by
	// "<wlkey>/<container>" → {multiplier, expiry}. Applied to rCpu under
	// distress and decayed by expiry. Refresh-goroutine-owned; healMu guards
	// it.
	healMu  sync.Mutex
	cpuHeal map[string]healBoost

	// HPA policy catalog overrides (user CRs) + schedules.
	hpaPolicyOverrides map[string]*pyjson.Obj // name -> knobs (dict shape)
	hpaPolicyDescOv    map[string]string
	hpaSched           map[string]*pyjson.Obj // name -> {defaultPolicy, rules}

	// Pod-scheduling policy catalog (builtins + user).
	schedulingPolicyKnobs map[string]*pyjson.Obj
	schedulingUser        map[string]*pyjson.Obj // name -> {knobs, desc}

	// Custom Owner Groupings.
	customOwnerGroupings []*pyjson.Obj          // user COG entries (dict shape)
	builtinCogState      map[string]*pyjson.Obj // name -> {enabled, defaultPolicy, defaultAuto}

	// cluster-operations ConfigMap cache (java toggles).
	clusterOpsAt   float64
	clusterOpsData *pyjson.Obj

	// daemonset-<name> rec CRs already cleaned up after the
	// daemonsetnodesize split took over (once per process).
	dsLegacyCleaned map[string]bool

	// durable ConfigMap state layer (state.go).
	auditDirty           bool        // audit deque changed since last persist
	overviewMetrics      []any
	overviewCreatedAt    string      // preserved createdAt of the overview CM
	aggrDetails          *pyjson.Obj // hourly namespaceDetailsByTimestamp rollup
	lastAuditPersist     time.Time
	lastAnalyticsPersist time.Time
	lastOverviewPersist  time.Time
	lastAggrPersist      time.Time
	lastNotEvictPersist  time.Time
	lastCostCachePersist time.Time

	overrideKubeSystemIgnored bool // configParams.overrideUserKubeSystemIgnoredNamespace

	// leader election (fail-open): leadership comes from the
	// controller-runtime manager via SetLeader.
	isLeader atomic.Bool

	// refreshKick wakes the sampler loop early (Recommendation reconciler /
	// POST /api/notify). Buffered(1): coalesces bursts.
	refreshKick chan struct{}
}

type replicaPoint struct {
	replicas int64
	desired  int64
}

type nsSaving struct {
	namespace string
	savings   float64
}

func New(cfg config.Config, kc *kube.Client, log *slog.Logger) *Engine {
	var pc *prom.Client
	if cfg.PrometheusURL != "" {
		pc = prom.New(cfg.PrometheusURL)
	}
	e := &Engine{
		Cfg:  cfg,
		Kube: kc,
		Prom: pc,
		Log:  log,

		byKey:               map[string]*wlRow{},
		history:             map[string]map[string][]histPoint{},
		replicaHistory:      map[string][]replicaPoint{},
		automated:           map[string]bool{},
		excluded:            map[string]bool{},
		automationSource:    map[string]string{},
		replicasAutomated:   map[string]bool{},
		placementAutomated:  map[string]bool{},
		schedulingAutomated: map[string]bool{},
		originReq:           map[string]*origReq{},
		dataSource:          "metrics-server",

		headroomEnabled: true,
		headroomCpuPct:  envFloat("HEADROOM_CPU_PCT", 10),
		headroomMemPct:  envFloat("HEADROOM_MEM_PCT", 10),

		costCPUCoreMonth:       cfg.CostCPUCoreMonth,
		costMemGBMonth:         cfg.CostMemGBMonth,
		costGPUHourly:          cfg.CostGPUHourly,
		spotFraction:           envFloat("SPOT_FRACTION", 0.30),
		includeUnallocatedCost: true,
	}
	e.globalAuto = defaultGlobalAuto()
	e.customNsLabels = emptyCustomNsLabels()
	// WORKLOAD_AUTOMATION (chart values workloadAutomation, JSON): seeds the
	// exclude/include workload-operations lists; CM-persisted edits still win
	// because loadAutomationCM runs after this and Update() replaces the keys.
	if raw := os.Getenv("WORKLOAD_AUTOMATION"); raw != "" {
		if v, err := pyjson.Decode([]byte(raw)); err == nil {
			if o, ok := v.(*pyjson.Obj); ok {
				if l, okL := o.GetD("excludeTypes", nil).([]any); okL && len(l) > 0 {
					e.globalAuto.Set("excludedWorkloadTypes", l)
				}
				wa, _ := e.globalAuto.GetD("workloadAutomation", nil).(*pyjson.Obj)
				if wa != nil {
					for _, k := range []string{"excludeLabels", "includeLabels",
						"excludeAnnotations", "includeAnnotations"} {
						if l, okL := o.GetD(k, nil).([]any); okL && len(l) > 0 {
							wa.Set(k, l)
						}
					}
				}
			}
		}
	}
	// configParams.overrideUserKubeSystemIgnoredNamespace (docs "Ignored
	// Namespaces"): without it, kube-system stays ignored even if omitted from
	// the user list. When "true", kube-system is dropped from the forced static
	// ignore set (only ignored if the user explicitly lists it).
	if v := os.Getenv("OVERRIDE_USER_KUBE_SYSTEM_IGNORED"); v == "true" || v == "True" || v == "TRUE" {
		e.overrideKubeSystemIgnored = true
	}
	e.policyRules = defaultPolicyRules()
	e.schedulePolicies = builtinSchedulePolicies()
	e.scheduleByName = map[string]*schedulePolicy{}
	for _, s := range e.schedulePolicies {
		e.scheduleByName[s.name] = s
	}

	e.headroomRaw = pyjson.NewObj()
	e.costOvertimeN = int(envFloat("COST_OVERTIME_POINTS", 4032))
	e.attrCatalog = pyjson.NewObj()
	e.alertRules = defaultAlertRules()
	e.replicasPolicyAssign = map[string]string{}
	e.schedulingPolAssign = map[string]string{}
	e.downscaleAssign = map[string]string{}
	e.downscaleAutomated = map[string]bool{}
	e.javaAutomated = map[string]bool{}
	e.javaUnautomated = map[string]bool{}
	e.javaHealing = map[string]*pyjson.Obj{}
	e.cpuHeal = map[string]healBoost{}
	e.hpaPolicyOverrides = map[string]*pyjson.Obj{}
	e.hpaPolicyDescOv = map[string]string{}
	e.hpaSched = map[string]*pyjson.Obj{}
	e.schedulingPolicyKnobs = map[string]*pyjson.Obj{}
	for _, sp := range schedulingPoliciesBuiltin {
		e.schedulingPolicyKnobs[sp.name] = sp.knobs()
	}
	e.schedulingUser = map[string]*pyjson.Obj{}
	e.builtinCogState = map[string]*pyjson.Obj{}
	e.dsLegacyCleaned = map[string]bool{}
	e.aggrDetails = pyjson.NewObj()
	e.isLeader.Store(true) // fail-open: single replica never stalls
	e.refreshKick = make(chan struct{}, 1)
	return e
}

// SetLeader records manager-driven leadership (controller-runtime Elected()).
func (e *Engine) SetLeader(v bool) { e.isLeader.Store(v) }

// IsLeader reports whether this replica currently holds leadership.
func (e *Engine) IsLeader() bool { return e.isLeader.Load() }

// KickRefresh asks the sampler loop to refresh soon (non-blocking; coalesced).
func (e *Engine) KickRefresh() {
	select {
	case e.refreshKick <- struct{}{}:
	default:
	}
}

// Seed writers honor the WRITE_ENABLED gate: with it off they record dry-
// run ops instead of mutating the cluster.
func (e *Engine) Start(ctx context.Context) {
	// Leader election lives in the controller-runtime manager
	// (lease coolscaler-recommender-lease, holder <pod>_<uuid>).
	e.ensureBuiltinPolicies(ctx)
	e.ensureSchedulePolicies(ctx)
	e.ensureHpaPolicies(ctx)
	e.loadHpaOverrides(ctx)
	e.ensureSchedulingPolicies(ctx)
	e.ensureDownscalerPolicies(ctx)
	e.loadSchedulingCRs(ctx)
	e.loadPolicyRulesCM(ctx)
	e.loadScheduleCRs(ctx)
	e.loadCogCRs(ctx)
	e.ensureBuiltinCogs(ctx)
	e.loadAutomationCM(ctx)
	e.loadIgnoredNamespaceCMs(ctx)
	e.loadCustomNsLabelsCM(ctx)
	e.loadCostCM(ctx)
	e.loadAutomationStateFromRecs(ctx)
	go e.samplerLoop(ctx)
}

func (e *Engine) samplerLoop(ctx context.Context) {
	e.loadAnalytics()
	// restore durable CM state (audit deque, analytics series, overview
	// rollup, hourly aggr) — after the legacy ANALYTICS_FILE load so CM
	// points only fill timestamps the file did not cover.
	e.loadStateCMs(ctx)
	n := 0
	interval := time.Duration(e.Cfg.SampleIntervalSeconds) * time.Second
	// minimum gap between refreshes when kicked (Recommendation-reconciler
	// events must not turn refresh->CR-write->reconcile into a tight loop).
	const minGap = 10 * time.Second
	for {
		start := time.Now()
		if err := e.Refresh(ctx); err != nil {
			e.Log.Error("sampler error", "err", err)
		} else {
			n++
			if analyticsFile != "" && n%10 == 0 { // persist every ~10 samples
				e.saveAnalytics()
			}
			// cadence-gated write-behind of the durable state CMs.
			e.persistStateCMs(ctx)
		}
		// drain any kicks accumulated during the refresh itself
		select {
		case <-e.refreshKick:
		default:
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(interval):
		case <-e.refreshKick:
			if since := time.Since(start); since < minGap {
				select {
				case <-ctx.Done():
					return
				case <-time.After(minGap - since):
				}
			}
		}
	}
}

func envFloat(key string, def float64) float64 {
	if v := os.Getenv(key); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			return f
		}
	}
	return def
}

func wlkey(ns, kind, name string) string {
	return ns + "/" + kind + "/" + name
}
