package api

import (
	"encoding/json"
	"net/http"
	"runtime"
	"strconv"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"coolscaler.sh/coolscaler/internal/version"
)

// VersionHeader renders the x-coolscaler-version header value.
func VersionHeader(component string) string {
	b, _ := json.Marshal(struct {
		ImageVersion string `json:"imageVersion"`
		GoVersion    string `json:"goVersion"`
		Component    string `json:"component"`
	}{version.Version, runtime.Version(), component})
	return string(b)
}

// rateLimiter is a per-minute fixed-window counter. It only EMITS the x-rate-
// limit-* headers; it never rejects — enforcement is deliberately out of scope
// for now.
type rateLimiter struct {
	mu          sync.Mutex
	limit       int
	windowStart int64
	count       int
}

func newRateLimiter(limit int) *rateLimiter {
	return &rateLimiter{limit: limit}
}

// take counts a request and returns (limit, remaining, secondsUntilReset).
func (r *rateLimiter) take() (int, int, int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := time.Now().Unix()
	window := now - now%60
	if window != r.windowStart {
		r.windowStart = window
		r.count = 0
	}
	r.count++
	remaining := r.limit - r.count
	if remaining < 0 {
		remaining = 0
	}
	reset := int(r.windowStart + 60 - now)
	return r.limit, remaining, reset
}

func Middleware(component string) gin.HandlerFunc {
	verHeader := VersionHeader(component)
	rl := newRateLimiter(60)
	return func(c *gin.Context) {
		h := c.Writer.Header()
		h.Set("x-coolscaler-version", verHeader)
		reqID := c.GetHeader("x-request-id")
		if reqID == "" {
			reqID = uuid.NewString()
		}
		h.Set("x-request-id", reqID)
		limit, remaining, reset := rl.take()
		h.Set("x-rate-limit-limit", strconv.Itoa(limit))
		h.Set("x-rate-limit-remaining", strconv.Itoa(remaining))
		h.Set("x-rate-limit-reset", strconv.Itoa(reset))
		c.Next()
	}
}

// Ping is the Gin-envelope /ping handler ({"message":"pong"}).
func Ping(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"message": "pong"})
}

// NotFound is the Gin-envelope 404 for unknown /api/* paths.
func NotFound(c *gin.Context) {
	c.JSON(http.StatusNotFound, gin.H{"message": "Page not found"})
}
