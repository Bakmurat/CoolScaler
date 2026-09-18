package server

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"

	"coolscaler.sh/coolscaler/internal/pyjson"
)

var dryRunSeq atomic.Int64

func recordDryRun(method, target, ctype string, body any) {
	seq := dryRunSeq.Add(1)
	dir := os.Getenv("DRYRUN_DIR")
	if dir == "" {
		return
	}
	rec := pyjson.NewObj().
		Set("seq", int(seq)).
		Set("method", method).
		Set("path", target).
		Set("contentType", ctype).
		Set("body", body)
	san := strings.Trim(target, "/")
	san = strings.NewReplacer("/", "_", ":", "_").Replace(san)
	if len(san) > 160 {
		san = san[len(san)-160:]
	}
	name := fmt.Sprintf("%05d-%s-%s.json", seq, method, san)
	_ = os.MkdirAll(dir, 0o755)
	_ = os.WriteFile(filepath.Join(dir, name), pyjson.Marshal(rec), 0o644)
}
