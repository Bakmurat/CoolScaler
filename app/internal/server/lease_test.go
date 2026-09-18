package server

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"testing"
	"time"

	coordv1 "k8s.io/api/coordination/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/utils/ptr"

	"coolscaler.sh/coolscaler/internal/kube"
)

func TestClassifyLease(t *testing.T) {
	now := time.Now()
	dur := 15 * time.Second
	fresh := metav1.NewMicroTime(now.Add(-2 * time.Second))
	stale := metav1.NewMicroTime(now.Add(-30 * time.Second))

	cases := []struct {
		name string
		spec *coordv1.LeaseSpec
		want leaseAction
	}{
		{"nil spec", nil, leaseActionTakeover},
		{"held by self", &coordv1.LeaseSpec{HolderIdentity: ptr.To("me"), RenewTime: &fresh}, leaseActionRenew},
		{"held by other, fresh", &coordv1.LeaseSpec{HolderIdentity: ptr.To("them"), RenewTime: &fresh}, leaseActionWait},
		{"held by other, expired", &coordv1.LeaseSpec{HolderIdentity: ptr.To("them"), RenewTime: &stale}, leaseActionTakeover},
		{"no holder, no renewTime", &coordv1.LeaseSpec{}, leaseActionTakeover},
	}
	for _, tc := range cases {
		if got := classifyLease(tc.spec, "me", dur, now); got != tc.want {
			t.Errorf("%s: classifyLease = %v, want %v", tc.name, got, tc.want)
		}
	}
}

// Gated on LEASE_LIVE_TEST=1 (and WRITE_ENABLED=true, KUBE_CONTEXT) so
// `go test` stays cluster-free by default. It only ever creates/deletes
// a lease named coolscaler-go-test-*.
func TestLeaseLive(t *testing.T) {
	if os.Getenv("LEASE_LIVE_TEST") != "1" {
		t.Skip("set LEASE_LIVE_TEST=1 (plus WRITE_ENABLED=true KUBE_CONTEXT=<context>) to run")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	kc := kube.New()
	cs, err := kc.Clientset()
	if err != nil {
		t.Fatalf("clientset: %v", err)
	}
	ns := kc.Namespace()
	name := fmt.Sprintf("coolscaler-go-test-%d", time.Now().UnixNano())
	leases := cs.CoordinationV1().Leases(ns)
	defer func() {
		if err := leases.Delete(context.Background(), name, metav1.DeleteOptions{}); err != nil {
			t.Errorf("cleanup delete %s: %v", name, err)
		}
	}()

	holder := podName() + "_" + processUUID()
	// 1. Create (lease missing).
	if err := ensureLease(ctx, leases, name, 15*time.Second, holder); err != nil {
		t.Fatalf("create: %v", err)
	}
	got, err := leases.Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.Spec.HolderIdentity == nil || *got.Spec.HolderIdentity != holder {
		t.Fatalf("holder = %v, want %q", got.Spec.HolderIdentity, holder)
	}
	if !strings.Contains(holder, "_") {
		t.Fatalf("dashboards-style holder %q missing _uuid suffix", holder)
	}
	if got.Spec.LeaseDurationSeconds == nil || *got.Spec.LeaseDurationSeconds != 15 {
		t.Fatalf("duration = %v, want 15", got.Spec.LeaseDurationSeconds)
	}
	if got.Spec.LeaseTransitions == nil || *got.Spec.LeaseTransitions != 0 {
		t.Fatalf("transitions = %v, want 0", got.Spec.LeaseTransitions)
	}

	// 2. Renew (held by self): renewTime advances, transitions unchanged.
	firstRenew := got.Spec.RenewTime.Time
	time.Sleep(1100 * time.Millisecond)
	if err := ensureLease(ctx, leases, name, 15*time.Second, holder); err != nil {
		t.Fatalf("renew: %v", err)
	}
	got, _ = leases.Get(ctx, name, metav1.GetOptions{})
	if !got.Spec.RenewTime.Time.After(firstRenew) {
		t.Fatalf("renewTime did not advance: %v -> %v", firstRenew, got.Spec.RenewTime.Time)
	}
	if *got.Spec.LeaseTransitions != 0 {
		t.Fatalf("renew bumped transitions: %d", *got.Spec.LeaseTransitions)
	}

	// 3. Takeover: expire the lease under another holder, then adopt.
	stale := metav1.NewMicroTime(time.Now().Add(-2 * time.Minute))
	got.Spec.HolderIdentity = ptr.To("someone-else")
	got.Spec.RenewTime = &stale
	if _, err := leases.Update(ctx, got, metav1.UpdateOptions{}); err != nil {
		t.Fatalf("stage stale holder: %v", err)
	}
	if err := ensureLease(ctx, leases, name, 15*time.Second, holder); err != nil {
		t.Fatalf("takeover: %v", err)
	}
	got, _ = leases.Get(ctx, name, metav1.GetOptions{})
	if *got.Spec.HolderIdentity != holder {
		t.Fatalf("takeover holder = %q, want %q", *got.Spec.HolderIdentity, holder)
	}
	if *got.Spec.LeaseTransitions != 1 {
		t.Fatalf("takeover transitions = %d, want 1", *got.Spec.LeaseTransitions)
	}

	// 4. WRITE_ENABLED=false path: runLeaseLoop must return without writes.
	t.Setenv("WRITE_ENABLED", "false")
	before, _ := leases.Get(ctx, name, metav1.GetOptions{})
	loopCtx, loopCancel := context.WithTimeout(ctx, 2*time.Second)
	runLeaseLoop(loopCtx, slog.Default(), kc, ns, name, 15*time.Second, "gated-holder")
	loopCancel()
	after, _ := leases.Get(ctx, name, metav1.GetOptions{})
	if before.ResourceVersion != after.ResourceVersion {
		t.Fatalf("runLeaseLoop wrote despite WRITE_ENABLED=false")
	}
}
