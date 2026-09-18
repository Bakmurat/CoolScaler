package webhook

import (
	"crypto/x509"
	"encoding/pem"
	"testing"
)

// TestGenerateChain checks the --gen-cert output: CA subject, serving-cert
// SANs, and that the serving cert verifies against the CA.
func TestGenerateChain(t *testing.T) {
	caPEM, crtPEM, keyPEM, err := generateChain("coolscaler-admissions", "coolscaler-system")
	if err != nil {
		t.Fatalf("generateChain: %v", err)
	}
	caBlock, _ := pem.Decode(caPEM)
	ca, err := x509.ParseCertificate(caBlock.Bytes)
	if err != nil {
		t.Fatalf("parse CA: %v", err)
	}
	if ca.Subject.CommonName != "coolscaler-ca" || len(ca.Subject.Organization) == 0 ||
		ca.Subject.Organization[0] != "coolscaler" {
		t.Errorf("CA subject = %v, want CN=coolscaler-ca O=coolscaler", ca.Subject)
	}
	if !ca.IsCA {
		t.Error("CA cert is not marked CA")
	}
	if !chainValid(crtPEM, caPEM, "coolscaler-admissions.coolscaler-system.svc") {
		t.Error("serving cert does not verify against CA / DNS name")
	}
	if b, _ := pem.Decode(keyPEM); b == nil || b.Type != "RSA PRIVATE KEY" {
		t.Error("key PEM invalid")
	}
	crtBlock, _ := pem.Decode(crtPEM)
	crt, _ := x509.ParseCertificate(crtBlock.Bytes)
	wantSANs := map[string]bool{
		"coolscaler-admissions":                                     false,
		"coolscaler-admissions.coolscaler-system":                   false,
		"coolscaler-admissions.coolscaler-system.svc":               false,
		"coolscaler-admissions.coolscaler-system.svc.cluster.local": false,
	}
	for _, d := range crt.DNSNames {
		wantSANs[d] = true
	}
	for san, ok := range wantSANs {
		if !ok {
			t.Errorf("missing SAN %s", san)
		}
	}
}
