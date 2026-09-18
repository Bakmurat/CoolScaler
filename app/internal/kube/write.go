package kube

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"

	"coolscaler.sh/coolscaler/internal/pyjson"
)

// Do issues an arbitrary-method request against the API server
func (c *Client) Do(ctx context.Context, method, path string, body []byte, contentType string) (*pyjson.Obj, error) {
	c.init()
	if c.err != nil {
		return nil, c.err
	}
	u := strings.TrimRight(c.restCfg.Host, "/") + path
	var rd io.Reader
	if body != nil {
		rd = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, u, rd)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	if contentType == "" {
		contentType = "application/json"
	}
	req.Header.Set("Content-Type", contentType)
	resp, err := c.httpc.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 256<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode/100 != 2 {
		msg := string(data)
		if len(msg) > 300 {
			msg = msg[:300]
		}
		return nil, &APIError{Code: resp.StatusCode, Body: msg}
	}
	v, err := pyjson.Decode(data)
	if err != nil {
		return nil, fmt.Errorf("kube: decode %s %s: %w", method, path, err)
	}
	obj, ok := v.(*pyjson.Obj)
	if !ok {
		return nil, fmt.Errorf("kube: %s %s: unexpected non-object response", method, path)
	}
	return obj, nil
}
