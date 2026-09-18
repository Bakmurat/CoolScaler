#!/usr/bin/env bash
# Build and publish the CoolScaler image WITHOUT a Docker daemon. usage:
# REGISTRY=registry.example.com/coolscaler bash scripts/build.sh <version>
# Pipeline: vite build -> go cross-compile -> layer tar -> crane append + push.
# Prereqs: go, node/npm, crane, and `crane auth login <registry>`. If you have
# Docker, the Dockerfile at the repository root does the same in a multi-stage
# build.
set -euo pipefail

VER="${1:?usage: build.sh <version>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REGISTRY="${REGISTRY:-registry.example.com/coolscaler}"
IMG="${REGISTRY}/coolscaler:${VER}"
# busybox base (not distroless): a shell and coreutils sit next to the Go binary,
# which keeps in-pod debugging possible.
BASE="${BASE_IMAGE:-busybox:stable-glibc}"
KSM_IMAGE="${KSM_IMAGE:-registry.k8s.io/kube-state-metrics/kube-state-metrics:v2.10.1}"
PROM_IMAGE="${PROM_IMAGE:-quay.io/prometheus/prometheus:v2.48.1}"
RELOADER_IMAGE="${RELOADER_IMAGE:-quay.io/prometheus-operator/prometheus-config-reloader:v0.71.2}"
STAGE="${ROOT}/app/dist/stage"
VENDOR="${ROOT}/app/dist/vendor"

echo "==> [1/5] React SPA (web/ -> web/build)"
(cd "${ROOT}/app/web" && npm run --silent build)

echo "==> [2/5] Go binary (linux/amd64, static)"
(cd "${ROOT}/app" && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 \
  go build -trimpath \
    -ldflags "-s -w -X coolscaler.sh/coolscaler/internal/version.Version=${VER}" \
    -o dist/coolscaler ./cmd/coolscaler)

echo "==> [3/5] Vendor binaries (extracted once from upstream images)"
mkdir -p "${VENDOR}/bin"
extract() { # image, path-in-image, dest
  local tmp; tmp="$(mktemp -d)"
  crane export --platform linux/amd64 "$1" - | tar -x -C "${tmp}" "./${2#/}" 2>/dev/null || tar -x -C "${tmp}" "${2#/}" < <(crane export --platform linux/amd64 "$1" -)
  cp "${tmp}/${2#/}" "$3"; chmod +x "$3"; rm -rf "${tmp}"
}
[ -x "${VENDOR}/kube-state-metrics" ]            || extract "${KSM_IMAGE}"      /kube-state-metrics                 "${VENDOR}/kube-state-metrics"
[ -x "${VENDOR}/bin/prometheus" ]                || extract "${PROM_IMAGE}"     /bin/prometheus                     "${VENDOR}/bin/prometheus"
[ -x "${VENDOR}/bin/prometheus-config-reloader" ] || extract "${RELOADER_IMAGE}" /bin/prometheus-config-reloader     "${VENDOR}/bin/prometheus-config-reloader"

echo "==> [4/5] Stage image layer"
rm -rf "${STAGE}"
mkdir -p "${STAGE}/build" "${STAGE}/bin"
cp "${ROOT}/app/dist/coolscaler"                     "${STAGE}/coolscaler"
cp -R "${ROOT}/app/web/build/."                      "${STAGE}/build/"
cp "${VENDOR}/kube-state-metrics"                    "${STAGE}/kube-state-metrics"
cp "${VENDOR}/bin/prometheus-config-reloader"        "${STAGE}/bin/prometheus-config-reloader"
cp "${VENDOR}/bin/prometheus"                        "${STAGE}/bin/prometheus"
LAYER="${ROOT}/app/dist/layer-${VER}.tar.gz"
(cd "${STAGE}" && tar --format=ustar --uid 0 --gid 0 --numeric-owner \
  --no-xattrs -czf "${LAYER}" coolscaler build kube-state-metrics bin)

echo "==> [5/5] crane append -> ${IMG}"
crane append --platform linux/amd64 -b "${BASE}" -f "${LAYER}" -t "${IMG}"
crane mutate --entrypoint /coolscaler "${IMG}" -t "${IMG}" >/dev/null
echo "==> published ${IMG}"
crane digest "${IMG}"
