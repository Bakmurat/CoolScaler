package engine

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"fmt"
	"hash/crc32"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"

	"coolscaler.sh/coolscaler/internal/kube"
	"coolscaler.sh/coolscaler/internal/pyjson"
)

// Cluster-mutation gate

type dryRunOp struct {
	Seq         int64
	Method      string
	Path        string
	ContentType string
	Body        any // pyjson value or nil
}

var dryRunSeq atomic.Int64

// writeEnabled reports whether cluster mutations are allowed this run.
func (e *Engine) writeEnabled() bool {
	return strings.EqualFold(os.Getenv("WRITE_ENABLED"), "true")
}

// GETs always pass through; other methods honor the write gate. Dry-run
// records the op and returns an empty object.
func (e *Engine) k8sReq(ctx context.Context, method, path string, body any, ctype string) (*pyjson.Obj, error) {
	if method == "GET" {
		return e.Kube.GetJSON(ctx, path)
	}
	if !e.writeEnabled() {
		e.recordDryRun(method, path, ctype, body)
		return pyjson.NewObj(), nil
	}
	var enc []byte
	if body != nil {
		enc = pyjson.Marshal(body)
	}
	return e.Kube.Do(ctx, method, path, enc, ctype)
}

func (e *Engine) k8sPatch(ctx context.Context, path string, body any) (*pyjson.Obj, error) {
	return e.k8sReq(ctx, "PATCH", path, body, "application/strategic-merge-patch+json")
}

func (e *Engine) recordDryRun(method, path, ctype string, body any) {
	seq := dryRunSeq.Add(1)
	dir := os.Getenv("DRYRUN_DIR")
	if dir == "" {
		return
	}
	rec := pyjson.NewObj().
		Set("seq", int(seq)).
		Set("method", method).
		Set("path", path).
		Set("contentType", ctype).
		Set("body", body)
	name := fmt.Sprintf("%05d-%s-%s.json", seq, method, sanitizePath(path))
	_ = os.MkdirAll(dir, 0o755)
	_ = os.WriteFile(filepath.Join(dir, name), pyjson.Marshal(rec), 0o644)
}

func sanitizePath(p string) string {
	s := strings.Trim(p, "/")
	s = strings.ReplaceAll(s, "/", "_")
	if len(s) > 160 {
		s = s[len(s)-160:]
	}
	return s
}

func isHTTPNotFound(err error) bool { return kube.IsNotFound(err) }

// isHTTPError reports any non-2xx API response.
func isHTTPError(err error) (int, bool) {
	if ae, ok := err.(*kube.APIError); ok {
		return ae.Code, true
	}
	return 0, false
}

// Small helpers shared by the CR writers.

func crName(kind, name string) string {
	s := strings.ToLower(kind + "-" + name)
	var b strings.Builder
	for _, c := range s {
		if (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' {
			b.WriteRune(c)
		} else {
			b.WriteByte('-')
		}
	}
	out := b.String()
	if len(out) > 253 {
		out = out[:253]
	}
	return strings.Trim(out, "-")
}

func isoNow() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05Z")
}

func stableHash(s string) uint32 {
	return crc32.ChecksumIEEE([]byte(s))
}

// NOTE: CPython's zlib (level 9) and Go's flate produce different
// COMPRESSED bytes for the same input; the decoded JSON is identical, which
// is what consumers see.
func gzb64(v any) string {
	var buf bytes.Buffer
	zw, _ := gzip.NewWriterLevel(&buf, gzip.BestCompression)
	_, _ = zw.Write(pyjson.Marshal(v))
	_ = zw.Close()
	return base64.StdEncoding.EncodeToString(buf.Bytes())
}

// Callers hold e.mu OR call via auditLocked-free paths; this takes the lock.
func (e *Engine) audit(actionType, target, oldValue, newValue, source string) {
	rec := pyjson.NewObj().
		Set("timestamp", isoNow()).
		Set("actionType", actionType).
		Set("target", target).
		Set("oldValue", oldValue).
		Set("newValue", newValue).
		Set("user", source)
	e.mu.Lock()
	e.auditLog = append([]*pyjson.Obj{rec}, e.auditLog...)
	if len(e.auditLog) > 1000 {
		e.auditLog = e.auditLog[:1000]
	}
	e.auditDirty = true // write-behind persistence (state.go)
	e.mu.Unlock()
}

var sysEventLabel = map[string]string{
	"podOptimized":  "Workload Optimized",
	"inPlaceResize": "Workload in-place Optimized",
	"podEviction":   "Eviction Optimization Triggered",
}
var sysEventVerb = map[string]string{
	"podOptimized":  "was optimized",
	"inPlaceResize": "was optimized in-place",
	"podEviction":   "triggered eviction for optimization",
}

// These rows carry `kind` + workload identity and NO `user` — the Events page renders them under
// the "System Events" tab, while user-attributed rows (from audit()) render under "User Events".
// actionType / target are also set so the legacy audit table + Troubleshoot feed keep rendering
// them nicely.
func (e *Engine) sysEvent(kind, ns, wlType, name string) {
	op := sysEventLabel[kind]
	if op == "" {
		op = kind
	}
	verb := sysEventVerb[kind]
	if verb == "" {
		verb = "was optimized"
	}
	rec := pyjson.NewObj().
		Set("timestamp", isoNow()).
		Set("kind", kind).
		Set("operation", op).
		Set("actionType", op).
		Set("target", ns+"/"+wlType+"/"+name).
		Set("newValue", "").
		Set("message", fmt.Sprintf("1 workload %s: [%s/%s/%s]", verb, ns, wlType, name)).
		Set("namespace", ns).
		Set("workloadType", wlType).
		Set("workloadName", name)
	e.mu.Lock()
	e.auditLog = append([]*pyjson.Obj{rec}, e.auditLog...)
	if len(e.auditLog) > 1000 {
		e.auditLog = e.auditLog[:1000]
	}
	e.auditDirty = true
	e.mu.Unlock()
}
