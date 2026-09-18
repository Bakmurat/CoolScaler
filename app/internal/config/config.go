package config

import (
	"os"
	"strconv"
	"strings"

	"coolscaler.sh/coolscaler/internal/version"
)

type Config struct {
	Role     string
	Port     int    // PORT
	TLSPort  int    // TLS_PORT
	ReadOnly bool   // READ_ONLY (default true; anything but "false" is true)

	ClusterName string // CLUSTER_NAME
	Namespace   string // NAMESPACE / POD_NAMESPACE (default coolscaler-system)
	Version     string // COOLSCALER_VERSION

	SampleIntervalSeconds int // SAMPLE_INTERVAL_SECONDS
	HistoryPoints         int // HISTORY_POINTS
	AnalyticsPoints       int // ANALYTICS_POINTS

	// Cost model.
	CostCPUCoreMonth float64 // COST_CPU_CORE_MONTH
	CostMemGBMonth   float64 // COST_MEM_GB_MONTH
	CostGPUHourly    float64 // COST_GPU_HOURLY

	// Rightsizing engine.
	CPUPercentile   float64 // CPU_PERCENTILE
	MemPercentile   float64 // MEM_PERCENTILE
	CPUHeadroom     float64 // CPU_HEADROOM
	MemHeadroom     float64 // MEM_HEADROOM
	CPUFloorCores   float64 // CPU_FLOOR_CORES
	MemFloorBytes   float64 // MEM_FLOOR_BYTES
	EphPercentile   float64 // EPH_PERCENTILE
	EphHeadroom     float64 // EPH_HEADROOM
	EphWindow       string  // EPH_WINDOW
	EphFloorBytes   float64 // EPH_FLOOR_BYTES
	LowerboundPct   float64 // LOWERBOUND_PERCENTILE
	UpperboundPct   float64 // UPPERBOUND_PERCENTILE
	UpperboundMargn float64 // UPPERBOUND_MARGIN

	ExcludeContainers map[string]bool // EXCLUDE_CONTAINERS (comma-separated)

	// Inter-component wiring.
	RecommenderURL string // RECOMMENDER_URL
	PrometheusURL  string
	PromWindow     string // PROM_WINDOW
	PromStep       string // PROM_STEP

	UpdaterIntervalSeconds int     // UPDATER_INTERVAL_SECONDS
	AgentIntervalSeconds   int     // AGENT_INTERVAL_SECONDS
	MinApplySavings        float64 // MIN_APPLY_SAVINGS
	TLSDir                 string  // TLS_DIR (admissions serving cert)
	WriteRecommendationCRs bool    // WRITE_RECOMMENDATION_CRS
	LeaseDurationSeconds   int     // LEASE_DURATION_SECONDS
}

// Load builds a Config from the process environment.
func Load() Config {
	excl := map[string]bool{}
	for _, c := range strings.Split(getEnv("EXCLUDE_CONTAINERS", "istio-proxy,linkerd-proxy"), ",") {
		if c = strings.TrimSpace(c); c != "" {
			excl[c] = true
		}
	}
	return Config{
		Role:     strings.ToLower(getEnv("ROLE", "recommender")),
		Port:     getInt("PORT", 8080),
		TLSPort:  getInt("TLS_PORT", 8443),
		ReadOnly: !strings.EqualFold(getEnv("READ_ONLY", "true"), "false"),

		ClusterName: getEnv("CLUSTER_NAME", "my-cluster"),
		Namespace:   Namespace(),
		Version:     getEnv("COOLSCALER_VERSION", version.Version),

		SampleIntervalSeconds: getInt("SAMPLE_INTERVAL_SECONDS", 30),
		HistoryPoints:         getInt("HISTORY_POINTS", 1440),
		AnalyticsPoints:       getInt("ANALYTICS_POINTS", 23040),

		CostCPUCoreMonth: getFloat("COST_CPU_CORE_MONTH", 23.08),
		CostMemGBMonth:   getFloat("COST_MEM_GB_MONTH", 3.09),
		CostGPUHourly:    getFloat("COST_GPU_HOURLY", 0.505),

		CPUPercentile:   getFloat("CPU_PERCENTILE", 93),
		MemPercentile:   getFloat("MEM_PERCENTILE", 93),
		CPUHeadroom:     getFloat("CPU_HEADROOM", 1.10),
		MemHeadroom:     getFloat("MEM_HEADROOM", 1.05),
		CPUFloorCores:   getFloat("CPU_FLOOR_CORES", 0.010),
		MemFloorBytes:   getFloat("MEM_FLOOR_BYTES", 16*1<<20),
		EphPercentile:   getFloat("EPH_PERCENTILE", 90),
		EphHeadroom:     getFloat("EPH_HEADROOM", 1.05),
		EphWindow:       getEnv("EPH_WINDOW", "48h"),
		EphFloorBytes:   getFloat("EPH_FLOOR_BYTES", 50*1<<20),
		LowerboundPct:   getFloat("LOWERBOUND_PERCENTILE", 50),
		UpperboundPct:   getFloat("UPPERBOUND_PERCENTILE", 97),
		UpperboundMargn: getFloat("UPPERBOUND_MARGIN", 1.15),

		ExcludeContainers: excl,

		RecommenderURL: getEnv("RECOMMENDER_URL", "http://coolscaler-recommender.coolscaler-system.svc:8080"),
		PrometheusURL:  strings.TrimRight(os.Getenv("PROMETHEUS_URL"), "/"),
		PromWindow:     getEnv("PROM_WINDOW", "24h"),
		PromStep:       getEnv("PROM_STEP", "5m"),

		UpdaterIntervalSeconds: getInt("UPDATER_INTERVAL_SECONDS", 120),
		AgentIntervalSeconds:   getInt("AGENT_INTERVAL_SECONDS", 60),
		MinApplySavings:        getFloat("MIN_APPLY_SAVINGS", 0.5),
		TLSDir:                 getEnv("TLS_DIR", "/tls"),
		WriteRecommendationCRs: !strings.EqualFold(getEnv("WRITE_RECOMMENDATION_CRS", "true"), "false"),
		LeaseDurationSeconds:   getInt("LEASE_DURATION_SECONDS", 15),
	}
}

func Namespace() string {
	if b, err := os.ReadFile("/var/run/secrets/kubernetes.io/serviceaccount/namespace"); err == nil {
		if ns := strings.TrimSpace(string(b)); ns != "" {
			return ns
		}
	}
	if ns := os.Getenv("NAMESPACE"); ns != "" {
		return ns
	}
	return getEnv("POD_NAMESPACE", "coolscaler-system")
}

func getEnv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func getInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func getFloat(key string, def float64) float64 {
	if v := os.Getenv(key); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			return f
		}
	}
	return def
}
