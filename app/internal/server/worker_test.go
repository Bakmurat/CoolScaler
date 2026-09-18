package server

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestHostProcMetrics(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "loadavg"),
		[]byte("0.52 1.25 2.00 2/1234 56789\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "pressure"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "pressure", "cpu"),
		[]byte("some avg10=0.00 avg60=0.05 avg300=0.10 total=1500000\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "pressure", "memory"),
		[]byte("some avg10=0.00 avg60=0.00 avg300=0.00 total=2000000\n"+
			"full avg10=0.00 avg60=0.00 avg300=0.00 total=500000\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// io intentionally absent → must emit nothing for io.

	out := string(hostProcMetrics(dir))

	for _, want := range []string{
		"coolscaler_node_load1 0.52\n",
		"coolscaler_node_load5 1.25\n",
		"coolscaler_node_load15 2\n",
		"# TYPE coolscaler_node_load1 gauge\n",
		"coolscaler_node_pressure_cpu_waiting_seconds_total 1.5\n",
		"# TYPE coolscaler_node_pressure_cpu_waiting_seconds_total counter\n",
		"coolscaler_node_pressure_memory_waiting_seconds_total 2\n",
		"coolscaler_node_pressure_memory_stalled_seconds_total 0.5\n",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("output missing %q\n--- got:\n%s", want, out)
		}
	}
	for _, absent := range []string{
		"coolscaler_node_pressure_cpu_stalled", // cpu has no full line
		"coolscaler_node_pressure_io_",         // io file missing
	} {
		if strings.Contains(out, absent) {
			t.Errorf("output must not contain %q (honest-absent)\n--- got:\n%s", absent, out)
		}
	}
}

func TestHostProcMetricsHonestAbsent(t *testing.T) {
	// Entirely missing host proc dir → empty output, no fabrication.
	if out := hostProcMetrics(filepath.Join(t.TempDir(), "nope")); len(out) != 0 {
		t.Errorf("expected empty output for missing dir, got:\n%s", out)
	}
}

func TestHostProcDirEnvOverride(t *testing.T) {
	t.Setenv("HOST_PROC", "/custom/proc")
	if got := hostProcDir(); got != "/custom/proc" {
		t.Errorf("hostProcDir = %q, want /custom/proc", got)
	}
	t.Setenv("HOST_PROC", "")
	if got := hostProcDir(); got != "/host/proc" {
		t.Errorf("hostProcDir default = %q, want /host/proc", got)
	}
}
