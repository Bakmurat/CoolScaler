package server

import (
	"context"
	"log/slog"
	"os"
	"sync"
	"time"

	"github.com/google/uuid"
	coordv1 "k8s.io/api/coordination/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	coordclient "k8s.io/client-go/kubernetes/typed/coordination/v1"
	"k8s.io/utils/ptr"

	"coolscaler.sh/coolscaler/internal/kube"
)


// processUUID is the once-per-process uuid suffix used by the dashboards
// lease holder identity.
var processUUID = sync.OnceValue(func() string { return uuid.NewString() })

// podName resolves the pod's own name: HOSTNAME env (set by the kubelet),
// falling back to os.Hostname for local runs.
func podName() string {
	if h := os.Getenv("HOSTNAME"); h != "" {
		return h
	}
	h, err := os.Hostname()
	if err != nil {
		return "coolscaler-unknown"
	}
	return h
}

// leaseAction is the decision the loop takes on each tick.
type leaseAction int

const (
	leaseActionCreate   leaseAction = iota // lease missing → create + acquire
	leaseActionRenew                       // we hold it → bump renewTime
	leaseActionTakeover                    // held by other but expired → adopt
	leaseActionWait                        // validly held by someone else
)

// classifyLease is the pure adopt/renew decision: renew when we already hold
// the lease, take over when the current holder's renewTime is older than the
// lease duration (or the spec is empty), otherwise wait.
func classifyLease(spec *coordv1.LeaseSpec, holder string, duration time.Duration, now time.Time) leaseAction {
	if spec == nil {
		return leaseActionTakeover
	}
	if spec.HolderIdentity != nil && *spec.HolderIdentity == holder {
		return leaseActionRenew
	}
	renew := time.Time{}
	if spec.RenewTime != nil {
		renew = spec.RenewTime.Time
	}
	if now.Sub(renew) > duration {
		return leaseActionTakeover
	}
	return leaseActionWait
}

// runLeaseLoop ensures + renews a single Lease until ctx is cancelled,
// renewing every duration/3. All cluster writes are gated on WRITE_ENABLED
// (same writeEnabled() gate as the controller managers): when false it logs
// once and returns without touching the cluster.
func runLeaseLoop(ctx context.Context, log *slog.Logger, kc *kube.Client,
	namespace, name string, duration time.Duration, holder string) {
	log = log.With("lease", name)
	if !writeEnabled() {
		log.Info("lease disabled (WRITE_ENABLED=false)")
		return
	}
	cs, err := kc.Clientset()
	if err != nil {
		log.Warn("lease: no kube client", "err", err)
		return
	}
	leases := cs.CoordinationV1().Leases(namespace)

	interval := duration / 3
	if interval <= 0 {
		interval = time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		if err := ensureLease(ctx, leases, name, duration, holder); err != nil && ctx.Err() == nil {
			log.Warn("lease ensure/renew failed", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// ensureLease performs one create/adopt/renew step.
func ensureLease(ctx context.Context, leases coordclient.LeaseInterface,
	name string, duration time.Duration, holder string) error {
	now := metav1.NewMicroTime(time.Now())
	secs := int32(duration / time.Second)

	cur, err := leases.Get(ctx, name, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		_, err = leases.Create(ctx, &coordv1.Lease{
			ObjectMeta: metav1.ObjectMeta{Name: name},
			Spec: coordv1.LeaseSpec{
				HolderIdentity:       ptr.To(holder),
				LeaseDurationSeconds: ptr.To(secs),
				AcquireTime:          &now,
				RenewTime:            &now,
				LeaseTransitions:     ptr.To(int32(0)),
			},
		}, metav1.CreateOptions{})
		return err
	}
	if err != nil {
		return err
	}

	switch classifyLease(&cur.Spec, holder, duration, now.Time) {
	case leaseActionRenew:
		cur.Spec.RenewTime = &now
		cur.Spec.LeaseDurationSeconds = ptr.To(secs)
	case leaseActionTakeover:
		transitions := int32(0)
		if cur.Spec.LeaseTransitions != nil {
			transitions = *cur.Spec.LeaseTransitions
		}
		cur.Spec.HolderIdentity = ptr.To(holder)
		cur.Spec.LeaseDurationSeconds = ptr.To(secs)
		cur.Spec.AcquireTime = &now
		cur.Spec.RenewTime = &now
		cur.Spec.LeaseTransitions = ptr.To(transitions + 1)
	default: // leaseActionWait — validly held by another identity
		return nil
	}
	_, err = leases.Update(ctx, cur, metav1.UpdateOptions{})
	return err
}
