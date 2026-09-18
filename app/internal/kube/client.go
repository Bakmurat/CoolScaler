// Package kube wraps client-go with lazy construction: in-cluster config
// first, falling back to the standard kubeconfig loading rules
// ($KUBECONFIG / ~/.kube/config). The out-of-cluster path honors the
// KUBE_CONTEXT env var so a local run can target a chosen cluster without
// switching the user's current kubectl context. Nothing dials the API server
// until a caller actually asks for a client, so components start fine
// off-cluster.
package kube

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"

	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"

	"coolscaler.sh/coolscaler/internal/config"
	"coolscaler.sh/coolscaler/internal/pyjson"
)

// GroupVersion of the CoolScaler CRDs .
var GroupVersion = schema.GroupVersion{Group: "analysis.coolscaler.sh", Version: "v1alpha1"}

// Client lazily builds a clientset + dynamic client on first use.
type Client struct {
	once      sync.Once
	err       error
	restCfg   *rest.Config
	clientset kubernetes.Interface
	dyn       dynamic.Interface
	httpc     *http.Client
	namespace string
}

// New returns an unconnected Client; no network or file I/O happens yet.
func New() *Client {
	return &Client{namespace: config.Namespace()}
}

func (c *Client) init() {
	c.once.Do(func() {
		cfg, err := rest.InClusterConfig()
		if err != nil {
			rules := clientcmd.NewDefaultClientConfigLoadingRules()
			overrides := &clientcmd.ConfigOverrides{}
			// KUBE_CONTEXT selects a kubeconfig context for out-of-cluster
			// runs WITHOUT touching the user's current-context.
			if kc := os.Getenv("KUBE_CONTEXT"); kc != "" {
				overrides.CurrentContext = kc
			}
			cfg, err = clientcmd.NewNonInteractiveDeferredLoadingClientConfig(
				rules, overrides).ClientConfig()
			if err != nil {
				c.err = fmt.Errorf("kube: no in-cluster or kubeconfig config: %w", err)
				return
			}
		}
		c.restCfg = cfg
		if c.clientset, err = kubernetes.NewForConfig(cfg); err != nil {
			c.err = fmt.Errorf("kube: build clientset: %w", err)
			return
		}
		if c.dyn, err = dynamic.NewForConfig(cfg); err != nil {
			c.err = fmt.Errorf("kube: build dynamic client: %w", err)
			return
		}
		if c.httpc, err = rest.HTTPClientFor(cfg); err != nil {
			c.err = fmt.Errorf("kube: build http client: %w", err)
		}
	})
}

// Clientset returns the typed clientset, building the config on first call.
func (c *Client) Clientset() (kubernetes.Interface, error) {
	c.init()
	return c.clientset, c.err
}

// Dynamic returns the dynamic client, building the config on first call.
func (c *Client) Dynamic() (dynamic.Interface, error) {
	c.init()
	return c.dyn, c.err
}

// RESTConfig returns the resolved *rest.Config.
func (c *Client) RESTConfig() (*rest.Config, error) {
	c.init()
	return c.restCfg, c.err
}

// Namespace is the namespace CRD helpers operate in.
func (c *Client) Namespace() string { return c.namespace }

// AnalysisResource returns a namespaced dynamic interface for a CoolScaler
// CRD plural (e.g. "recommendations", "policies") in the component namespace.
func (c *Client) AnalysisResource(plural string) (dynamic.ResourceInterface, error) {
	dyn, err := c.Dynamic()
	if err != nil {
		return nil, err
	}
	return dyn.Resource(GroupVersion.WithResource(plural)).Namespace(c.namespace), nil
}

// ClusterAnalysisResource is AnalysisResource without a namespace scope, for
// cluster-scoped listing across namespaces.
func (c *Client) ClusterAnalysisResource(plural string) (dynamic.NamespaceableResourceInterface, error) {
	dyn, err := c.Dynamic()
	if err != nil {
		return nil, err
	}
	return dyn.Resource(GroupVersion.WithResource(plural)), nil
}

// APIError is a non-2xx response from the API server.
type APIError struct {
	Code int
	Body string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("kube: HTTP %d: %s", e.Code, e.Body)
}

// IsNotFound reports whether err is an APIError with code 404.
func IsNotFound(err error) bool {
	ae, ok := err.(*APIError)
	return ok && ae.Code == 404
}

// GetJSON GETs an absolute API path (e.g. "/api/v1/pods") and decodes the
// response into order-preserving pyjson structures
func (c *Client) GetJSON(ctx context.Context, path string) (*pyjson.Obj, error) {
	c.init()
	if c.err != nil {
		return nil, c.err
	}
	u := strings.TrimRight(c.restCfg.Host, "/") + path
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	resp, err := c.httpc.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 256<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode/100 != 2 {
		msg := string(body)
		if len(msg) > 300 {
			msg = msg[:300]
		}
		return nil, &APIError{Code: resp.StatusCode, Body: msg}
	}
	v, err := pyjson.Decode(body)
	if err != nil {
		return nil, fmt.Errorf("kube: decode %s: %w", path, err)
	}
	obj, ok := v.(*pyjson.Obj)
	if !ok {
		return nil, fmt.Errorf("kube: %s: unexpected non-object response", path)
	}
	return obj, nil
}
