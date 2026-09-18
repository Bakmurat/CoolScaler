// Package version holds the build-time version stamp.
package version

// Version is set at build time via:
//
//	-ldflags "-X coolscaler.sh/coolscaler/internal/version.Version=<ver>"
var Version = "1.2.0-dev"
