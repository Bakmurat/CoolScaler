# CoolScaler image: one static Go binary + the built React SPA + three upstream
# binaries (kube-state-metrics, prometheus, prometheus-config-reloader), on a
# busybox base so a shell is available for in-pod debugging.
#   docker build --build-arg VERSION=1.2.0 -t registry.example.com/coolscaler/coolscaler:1.2.0 .
ARG KSM_IMAGE=registry.k8s.io/kube-state-metrics/kube-state-metrics:v2.10.1
ARG PROM_IMAGE=quay.io/prometheus/prometheus:v2.48.1
ARG RELOADER_IMAGE=quay.io/prometheus-operator/prometheus-config-reloader:v0.71.2

FROM ${KSM_IMAGE} AS ksm
FROM ${PROM_IMAGE} AS prom
FROM ${RELOADER_IMAGE} AS reloader

FROM node:20-alpine AS web
WORKDIR /src/web
COPY app/web/package.json app/web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY app/web/ ./
RUN npm run build

FROM golang:1.26-alpine AS go
ARG VERSION=dev
WORKDIR /src
COPY app/go.mod app/go.sum ./
RUN go mod download
COPY app/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath \
      -ldflags "-s -w -X coolscaler.sh/coolscaler/internal/version.Version=${VERSION}" \
      -o /out/coolscaler ./cmd/coolscaler

FROM busybox:stable-glibc
COPY --from=go /out/coolscaler /coolscaler
COPY --from=web /src/web/build /build
COPY --from=ksm /kube-state-metrics /kube-state-metrics
COPY --from=prom /bin/prometheus /bin/prometheus
COPY --from=reloader /bin/prometheus-config-reloader /bin/prometheus-config-reloader
USER 1000:1000
ENTRYPOINT ["/coolscaler"]
