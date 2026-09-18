package webhook

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"log/slog"
	"math/big"
	"os"
	"path/filepath"
	"time"

	"coolscaler.sh/coolscaler/internal/kube"
	"coolscaler.sh/coolscaler/internal/pyjson"
)

// CertConfig describes the --gen-cert targets.
type CertConfig struct {
	ServiceName       string // --webhooks-service-name (default coolscaler-admissions)
	Namespace         string
	SecretName        string // --coolscaler-admissions-certs-secret (default coolscaler-admissions-tls)
	WebhookConfigName string // MutatingWebhookConfiguration name (chart: coolscaler-mutating-webhook)
}

// CertPaths are the resolved serving-cert files.
type CertPaths struct {
	CertFile string
	KeyFile  string
	CAFile   string
}

// All cluster writes honor the WRITE_ENABLED gate (dry-run records the would-be secret +
// patch). The PEMs are always materialized under outDir for the HTTPS listener.
func EnsureCerts(ctx context.Context, kc *kube.Client, log *slog.Logger, cc CertConfig, outDir string, writeEnabled bool) (CertPaths, error) {
	paths := CertPaths{
		CertFile: filepath.Join(outDir, "tls.crt"),
		KeyFile:  filepath.Join(outDir, "tls.key"),
		CAFile:   filepath.Join(outDir, "ca.crt"),
	}
	if err := os.MkdirAll(outDir, 0o700); err != nil {
		return paths, err
	}
	svcDNS := cc.ServiceName + "." + cc.Namespace + ".svc"

	// 1. Reuse the existing secret when its chain is still valid.
	secretPath := "/api/v1/namespaces/" + cc.Namespace + "/secrets/" + cc.SecretName
	if sec, err := kc.GetJSON(ctx, secretPath); err == nil {
		if ca, crt, key, ok := secretChain(sec); ok && chainValid(crt, ca, svcDNS) {
			log.Info("reusing valid webhook certs from secret", "secret", cc.SecretName)
			if err := writePEMs(paths, ca, crt, key); err != nil {
				return paths, err
			}
			ensureCABundle(ctx, kc, log, cc, ca, writeEnabled)
			return paths, nil
		}
		log.Info("webhook cert secret exists but is invalid/expiring; regenerating",
			"secret", cc.SecretName)
	}

	// 2. Generate CA + serving cert.
	caPEM, crtPEM, keyPEM, err := generateChain(cc.ServiceName, cc.Namespace)
	if err != nil {
		return paths, err
	}
	if err := writePEMs(paths, caPEM, crtPEM, keyPEM); err != nil {
		return paths, err
	}
	log.Info("generated self-signed webhook CA + serving cert",
		"ca", "CN=coolscaler-ca,O=coolscaler", "dns", svcDNS, "dir", outDir)

	// 3. Store in the TLS secret (idempotent PUT-or-POST), gated.
	secret := map[string]any{
		"apiVersion": "v1",
		"kind":       "Secret",
		"metadata": map[string]any{
			"name":      cc.SecretName,
			"namespace": cc.Namespace,
			"labels":    map[string]any{"app.kubernetes.io/part-of": "coolscaler"},
		},
		"type": "kubernetes.io/tls",
		"data": map[string]any{
			"ca.crt":  base64.StdEncoding.EncodeToString(caPEM),
			"tls.crt": base64.StdEncoding.EncodeToString(crtPEM),
			"tls.key": base64.StdEncoding.EncodeToString(keyPEM),
		},
	}
	if !writeEnabled {
		log.Info("dry-run: would store webhook certs", "secret", cc.SecretName)
		recordCertDryRun("PUT", secretPath, secret)
	} else {
		body, _ := json.Marshal(secret)
		if _, err := kc.Do(ctx, "PUT", secretPath, body, "application/json"); err != nil {
			if kube.IsNotFound(err) {
				_, err = kc.Do(ctx, "POST",
					"/api/v1/namespaces/"+cc.Namespace+"/secrets", body, "application/json")
			}
			if err != nil {
				log.Error("storing webhook cert secret failed", "err", err)
			}
		}
	}

	// 4. Patch the caBundle into the webhook configuration, gated.
	ensureCABundle(ctx, kc, log, cc, caPEM, writeEnabled)
	return paths, nil
}

// ensureCABundle patches /webhooks/0/clientConfig/caBundle when it differs.
func ensureCABundle(ctx context.Context, kc *kube.Client, log *slog.Logger, cc CertConfig, caPEM []byte, writeEnabled bool) {
	want := base64.StdEncoding.EncodeToString(caPEM)
	cfgPath := "/apis/admissionregistration.k8s.io/v1/mutatingwebhookconfigurations/" + cc.WebhookConfigName
	if live, err := kc.GetJSON(ctx, cfgPath); err == nil {
		if whs, ok := live.GetD("webhooks", nil).([]any); ok && len(whs) > 0 {
			if wh, ok := whs[0].(*pyjson.Obj); ok {
				clientCfg, _ := wh.GetD("clientConfig", nil).(*pyjson.Obj)
				if cur, _ := clientCfg.GetD("caBundle", "").(string); cur == want {
					return // already in sync
				}
			}
		}
	} else if !kube.IsNotFound(err) {
		log.Info("caBundle check skipped (webhook config unreadable)", "err", err)
	}
	patch := []any{map[string]any{
		"op":    "replace",
		"path":  "/webhooks/0/clientConfig/caBundle",
		"value": want,
	}}
	if !writeEnabled {
		log.Info("dry-run: would patch caBundle", "webhookConfiguration", cc.WebhookConfigName)
		recordCertDryRun("PATCH", cfgPath, patch)
		return
	}
	body, _ := json.Marshal(patch)
	if _, err := kc.Do(ctx, "PATCH", cfgPath, body, "application/json-patch+json"); err != nil {
		log.Error("caBundle patch failed", "webhookConfiguration", cc.WebhookConfigName, "err", err)
	} else {
		log.Info("patched caBundle", "webhookConfiguration", cc.WebhookConfigName)
	}
}

func recordCertDryRun(method, path string, body any) {
	dir := os.Getenv("DRYRUN_DIR")
	if dir == "" {
		return
	}
	_ = os.MkdirAll(dir, 0o755)
	enc, _ := json.MarshalIndent(map[string]any{
		"method": method, "path": path, "body": body,
	}, "", "  ")
	name := fmt.Sprintf("gencert-%s-%d.json", method, time.Now().UnixNano())
	_ = os.WriteFile(filepath.Join(dir, name), enc, 0o644)
}

// generateChain self-signs a CA (CN=coolscaler-ca, O=coolscaler) and a
// serving cert for the webhook service DNS names.
func generateChain(service, namespace string) (caPEM, crtPEM, keyPEM []byte, err error) {
	caKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return nil, nil, nil, err
	}
	now := time.Now()
	caTmpl := &x509.Certificate{
		SerialNumber:          randomSerial(),
		Subject:               pkix.Name{CommonName: "coolscaler-ca", Organization: []string{"coolscaler"}},
		NotBefore:             now.Add(-5 * time.Minute),
		NotAfter:              now.AddDate(10, 0, 0),
		IsCA:                  true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
		BasicConstraintsValid: true,
	}
	caDER, err := x509.CreateCertificate(rand.Reader, caTmpl, caTmpl, &caKey.PublicKey, caKey)
	if err != nil {
		return nil, nil, nil, err
	}
	caCert, err := x509.ParseCertificate(caDER)
	if err != nil {
		return nil, nil, nil, err
	}

	srvKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return nil, nil, nil, err
	}
	dns := []string{
		service,
		service + "." + namespace,
		service + "." + namespace + ".svc",
		service + "." + namespace + ".svc.cluster.local",
	}
	srvTmpl := &x509.Certificate{
		SerialNumber: randomSerial(),
		Subject:      pkix.Name{CommonName: dns[2], Organization: []string{"coolscaler"}},
		NotBefore:    now.Add(-5 * time.Minute),
		NotAfter:     now.AddDate(10, 0, 0),
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:     dns,
	}
	srvDER, err := x509.CreateCertificate(rand.Reader, srvTmpl, caCert, &srvKey.PublicKey, caKey)
	if err != nil {
		return nil, nil, nil, err
	}

	caPEM = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER})
	crtPEM = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srvDER})
	keyPEM = pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(srvKey)})
	return caPEM, crtPEM, keyPEM, nil
}

func randomSerial() *big.Int {
	limit := new(big.Int).Lsh(big.NewInt(1), 128)
	n, err := rand.Int(rand.Reader, limit)
	if err != nil {
		return big.NewInt(time.Now().UnixNano())
	}
	return n
}

// secretChain extracts ca.crt / tls.crt / tls.key from a Secret object.
func secretChain(sec *pyjson.Obj) (ca, crt, key []byte, ok bool) {
	data, _ := sec.GetD("data", nil).(*pyjson.Obj)
	if data == nil {
		return nil, nil, nil, false
	}
	dec := func(k string) []byte {
		s, _ := data.GetD(k, "").(string)
		if s == "" {
			return nil
		}
		b, err := base64.StdEncoding.DecodeString(s)
		if err != nil {
			return nil
		}
		return b
	}
	ca, crt, key = dec("ca.crt"), dec("tls.crt"), dec("tls.key")
	return ca, crt, key, len(ca) > 0 && len(crt) > 0 && len(key) > 0
}

// chainValid checks the serving cert parses, covers the service DNS name,
// chains to the CA, and does not expire within 30 days.
func chainValid(crtPEM, caPEM []byte, dnsName string) bool {
	block, _ := pem.Decode(crtPEM)
	if block == nil {
		return false
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return false
	}
	if time.Until(cert.NotAfter) < 30*24*time.Hour {
		return false
	}
	if err := cert.VerifyHostname(dnsName); err != nil {
		return false
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(caPEM) {
		return false
	}
	_, err = cert.Verify(x509.VerifyOptions{
		Roots:     roots,
		KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	})
	return err == nil
}

func writePEMs(p CertPaths, ca, crt, key []byte) error {
	if err := os.WriteFile(p.CAFile, ca, 0o600); err != nil {
		return err
	}
	if err := os.WriteFile(p.CertFile, crt, 0o600); err != nil {
		return err
	}
	return os.WriteFile(p.KeyFile, key, 0o600)
}
