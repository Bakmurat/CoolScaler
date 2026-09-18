// Package prom is a minimal Prometheus HTTP API client (stdlib only).
package prom

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// DefaultURL matches the bundled Prometheus service.
const DefaultURL = "http://coolscaler-prometheus-server.coolscaler-system.svc:9090"

// Sample is one instant-vector result.
type Sample struct {
	Metric    map[string]string
	Timestamp time.Time
	Value     float64
}

// Series is one range-vector (matrix) result.
type Series struct {
	Metric map[string]string
	Points []Point
}

// Point is a single (timestamp, value) pair in a matrix.
type Point struct {
	Timestamp time.Time
	Value     float64
}

// Client talks to the Prometheus HTTP API.
type Client struct {
	baseURL string
	http    *http.Client
}

// New builds a client for the given base URL ("" -> $PROMETHEUS_URL -> DefaultURL).
func New(baseURL string) *Client {
	if baseURL == "" {
		baseURL = os.Getenv("PROMETHEUS_URL")
	}
	if baseURL == "" {
		baseURL = DefaultURL
	}
	return &Client{
		baseURL: strings.TrimRight(baseURL, "/"),
		http:    &http.Client{Timeout: 30 * time.Second},
	}
}

// Query runs an instant query at ts (zero ts = server "now").
func (c *Client) Query(ctx context.Context, promql string, ts time.Time) ([]Sample, error) {
	params := url.Values{"query": {promql}}
	if !ts.IsZero() {
		params.Set("time", formatTime(ts))
	}
	data, err := c.call(ctx, "/api/v1/query", params)
	if err != nil {
		return nil, err
	}
	if data.ResultType != "vector" {
		return nil, fmt.Errorf("prom: unexpected resultType %q for instant query", data.ResultType)
	}
	var raw []rawSample
	if err := json.Unmarshal(data.Result, &raw); err != nil {
		return nil, fmt.Errorf("prom: decode vector: %w", err)
	}
	out := make([]Sample, 0, len(raw))
	for _, r := range raw {
		p, err := r.Value.point()
		if err != nil {
			return nil, err
		}
		out = append(out, Sample{Metric: r.Metric, Timestamp: p.Timestamp, Value: p.Value})
	}
	return out, nil
}

// QueryRange runs a range query.
func (c *Client) QueryRange(ctx context.Context, promql string, start, end time.Time, step time.Duration) ([]Series, error) {
	params := url.Values{
		"query": {promql},
		"start": {formatTime(start)},
		"end":   {formatTime(end)},
		"step":  {strconv.FormatFloat(step.Seconds(), 'f', -1, 64)},
	}
	data, err := c.call(ctx, "/api/v1/query_range", params)
	if err != nil {
		return nil, err
	}
	if data.ResultType != "matrix" {
		return nil, fmt.Errorf("prom: unexpected resultType %q for range query", data.ResultType)
	}
	var raw []rawSeries
	if err := json.Unmarshal(data.Result, &raw); err != nil {
		return nil, fmt.Errorf("prom: decode matrix: %w", err)
	}
	out := make([]Series, 0, len(raw))
	for _, r := range raw {
		s := Series{Metric: r.Metric, Points: make([]Point, 0, len(r.Values))}
		for _, v := range r.Values {
			p, err := v.point()
			if err != nil {
				return nil, err
			}
			s.Points = append(s.Points, p)
		}
		out = append(out, s)
	}
	return out, nil
}

type apiResponse struct {
	Status    string  `json:"status"`
	ErrorType string  `json:"errorType"`
	Error     string  `json:"error"`
	Data      apiData `json:"data"`
}

type apiData struct {
	ResultType string          `json:"resultType"`
	Result     json.RawMessage `json:"result"`
}

type rawSample struct {
	Metric map[string]string `json:"metric"`
	Value  rawPoint          `json:"value"`
}

type rawSeries struct {
	Metric map[string]string `json:"metric"`
	Values []rawPoint        `json:"values"`
}

// rawPoint is Prometheus's [unixSeconds, "value"] pair.
type rawPoint []json.RawMessage

func (p rawPoint) point() (Point, error) {
	if len(p) != 2 {
		return Point{}, fmt.Errorf("prom: malformed value pair (len %d)", len(p))
	}
	var ts float64
	if err := json.Unmarshal(p[0], &ts); err != nil {
		return Point{}, fmt.Errorf("prom: decode timestamp: %w", err)
	}
	var vs string
	if err := json.Unmarshal(p[1], &vs); err != nil {
		return Point{}, fmt.Errorf("prom: decode value: %w", err)
	}
	v, err := strconv.ParseFloat(vs, 64)
	if err != nil {
		return Point{}, fmt.Errorf("prom: parse value %q: %w", vs, err)
	}
	sec, frac := int64(ts), ts-float64(int64(ts))
	return Point{Timestamp: time.Unix(sec, int64(frac*1e9)), Value: v}, nil
}

func (c *Client) call(ctx context.Context, path string, params url.Values) (*apiData, error) {
	u := c.baseURL + path + "?" + params.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, fmt.Errorf("prom: build request: %w", err)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("prom: %s: %w", path, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if err != nil {
		return nil, fmt.Errorf("prom: read response: %w", err)
	}
	var ar apiResponse
	if jerr := json.Unmarshal(body, &ar); jerr != nil {
		if resp.StatusCode/100 != 2 {
			return nil, fmt.Errorf("prom: %s: HTTP %d: %s", path, resp.StatusCode, truncate(body, 300))
		}
		return nil, fmt.Errorf("prom: decode response: %w", jerr)
	}
	if resp.StatusCode/100 != 2 || ar.Status != "success" {
		// Surface Prometheus's own error field (e.g. RE2 parse errors, 400s).
		return nil, fmt.Errorf("prom: %s: HTTP %d %s: %s", path, resp.StatusCode, ar.ErrorType, ar.Error)
	}
	return &ar.Data, nil
}

func formatTime(t time.Time) string {
	return strconv.FormatFloat(float64(t.UnixNano())/1e9, 'f', 3, 64)
}

func truncate(b []byte, n int) string {
	if len(b) > n {
		return string(b[:n]) + "..."
	}
	return string(b)
}
