{{- define "coolscaler.serviceAccountName" -}}
{{- default "coolscaler" .Values.serviceAccount.name -}}
{{- end -}}

{{/* Common labels. Call with the root context. */}}
{{- define "coolscaler.labels" -}}
app.kubernetes.io/name: coolscaler
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: coolscaler
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{/* Selector labels for a component. Call: (dict "ctx". "component" "recommender") */}}
{{- define "coolscaler.selector" -}}
app.kubernetes.io/name: coolscaler
app.kubernetes.io/instance: {{ .ctx.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "coolscaler.image" -}}
{{ .Values.image.repository }}:{{ .Values.image.tag }}
{{- end -}}

{{/* Shared env block for every coolscaler-image component. Call with root ctx. */}}
{{- define "coolscaler.commonEnv" -}}
- name: POD_NAME
  valueFrom:
    fieldRef:
      fieldPath: metadata.name
- name: NODE_NAME
  valueFrom:
    fieldRef:
      fieldPath: spec.nodeName
- name: READ_ONLY
  value: {{ .Values.readOnly | quote }}
# Go engine write gate: cluster mutations (CR/seed writers, webhook cert mgmt,
# applies, leader-election leases) engage exactly when the release is not read-only.
- name: WRITE_ENABLED
  value: {{ not .Values.readOnly | quote }}
- name: CLUSTER_NAME
  value: {{ .Values.clusterName | quote }}
- name: RECOMMENDER_URL
  value: "http://coolscaler-recommender:8080"
- name: PROMETHEUS_URL
  value: {{ .Values.prometheus.enabled | ternary "http://coolscaler-prometheus-server" "" | quote }}
- name: PROM_WINDOW
  value: {{ .Values.engine.promWindow | quote }}
- name: PROM_STEP
  value: {{ .Values.engine.promStep | quote }}
- name: SAMPLE_INTERVAL_SECONDS
  value: {{ .Values.engine.sampleIntervalSeconds | quote }}
- name: HISTORY_POINTS
  value: {{ .Values.engine.historyPoints | quote }}
- name: CPU_PERCENTILE
  value: {{ .Values.engine.cpuPercentile | quote }}
- name: MEM_PERCENTILE
  value: {{ .Values.engine.memPercentile | quote }}
- name: CPU_HEADROOM
  value: {{ .Values.engine.cpuHeadroom | quote }}
- name: MEM_HEADROOM
  value: {{ .Values.engine.memHeadroom | quote }}
- name: COST_CPU_CORE_MONTH
  value: {{ .Values.costModel.cpuCoreMonth | quote }}
- name: COST_MEM_GB_MONTH
  value: {{ .Values.costModel.memGbMonth | quote }}
- name: COST_GPU_HOURLY
  value: {{ .Values.costModel.gpuHourly | quote }}
- name: SPOT_FRACTION
  value: {{ .Values.costModel.spotFraction | quote }}
- name: JAVA_OPTIMIZATION_ENABLED
  value: {{ .Values.java.enabled | quote }}
# The JMX injector init container reuses the CoolScaler image (jar bundled at build).
- name: JMX_AGENT_IMAGE
  value: {{ include "coolscaler.image" . | quote }}
{{- if .Values.configParams.overrideUserKubeSystemIgnoredNamespace }}
# docs "Ignored Namespaces": allow kube-system to be removed from the ignore list.
- name: OVERRIDE_USER_KUBE_SYSTEM_IGNORED
  value: {{ .Values.configParams.overrideUserKubeSystemIgnoredNamespace | quote }}
{{- end }}
{{- with .Values.workloadAutomation }}
{{- if or .excludeTypes .excludeLabels .includeLabels .excludeAnnotations .includeAnnotations }}
# GitOps workload-operations seed (Settings/API CM edits override after save).
- name: WORKLOAD_AUTOMATION
  value: {{ toJson . | quote }}
{{- end }}
{{- end }}
{{- end -}}

{{/* priorityClassName line for CoolScaler's own pods (empty -> nothing). Call with root ctx. */}}
{{- define "coolscaler.priorityClassName" -}}
{{- with .Values.priorityClasses.componentClass }}
priorityClassName: {{ . }}
{{- end }}
{{- end -}}

{{/*
Node-affinity rules shared by EVERY CoolScaler pod: required NotIn [windows] on kubernetes.io/os
+ preferred (weight 1) avoidance of spot capacity across the four common spot/capacity labels.
*/}}
{{- define "coolscaler.nodeAffinityRules" -}}
requiredDuringSchedulingIgnoredDuringExecution:
  nodeSelectorTerms:
    - matchExpressions:
        - { key: kubernetes.io/os, operator: NotIn, values: [windows] }
preferredDuringSchedulingIgnoredDuringExecution:
  - weight: 1
    preference:
      matchExpressions:
        - { key: eks.amazonaws.com/capacityType, operator: NotIn, values: [SPOT] }
  - weight: 1
    preference:
      matchExpressions:
        - { key: karpenter.sh/capacity-type, operator: NotIn, values: [spot] }
  - weight: 1
    preference:
      matchExpressions:
        - { key: kubernetes.azure.com/scalesetpriority, operator: NotIn, values: [spot] }
  - weight: 1
    preference:
      matchExpressions:
        - { key: node.kubernetes.io/lifecycle, operator: NotIn, values: [spot] }
{{- end -}}

{{/* Baseline pod-safety affinity (all pods). Emits an `affinity:` block. */}}
{{- define "coolscaler.podSafety" -}}
affinity:
  nodeAffinity:
    {{- include "coolscaler.nodeAffinityRules" . | nindent 4 }}
{{- end -}}

{{/*
Self-protection affinity for the managed-unevictable pods: pod-safety nodeAffinity + preferred
co-location with other unevictable pods.
*/}}
{{- define "coolscaler.managedUnevictable" -}}
affinity:
  nodeAffinity:
    {{- include "coolscaler.nodeAffinityRules" . | nindent 4 }}
  podAffinity:
    preferredDuringSchedulingIgnoredDuringExecution:
      - weight: 100
        podAffinityTerm:
          topologyKey: kubernetes.io/hostname
          labelSelector:
            matchLabels:
              coolscaler.sh/managed-unevictable: "true"
{{- end -}}

{{/* Pod-template labels: istio sidecar off (all pods). */}}
{{- define "coolscaler.podSafetyLabels" -}}
sidecar.istio.io/inject: "false"
{{- end -}}

{{/* Pod-template labels for the managed-unevictable pods. */}}
{{- define "coolscaler.managedUnevictableLabels" -}}
sidecar.istio.io/inject: "false"
coolscaler.sh/managed-unevictable: "true"
{{- end -}}

{{/* Pod-template annotations shielding unevictable pods from CA / Karpenter. */}}
{{- define "coolscaler.managedUnevictableAnnotations" -}}
cluster-autoscaler.kubernetes.io/safe-to-evict: "false"
karpenter.sh/do-not-disrupt: "true"
karpenter.sh/do-not-evict: "true"
{{- end -}}

{{/*
Webhook serving cert, cached in the release secret so repeated `helm upgrade`
runs don't rotate it (which would break the live webhook). Returns ca/crt/key.
*/}}
{{- define "coolscaler.webhookCerts" -}}
{{- $ns := .Release.Namespace -}}
{{- $cn := printf "coolscaler-admissions.%s.svc" $ns -}}
{{- $altNames := list $cn (printf "coolscaler-admissions.%s.svc.cluster.local" $ns) -}}
{{- $existing := lookup "v1" "Secret" $ns "coolscaler-admissions-tls" -}}
{{- if and $existing $existing.data (index $existing.data "tls.crt") -}}
ca: {{ index $existing.data "ca.crt" }}
crt: {{ index $existing.data "tls.crt" }}
key: {{ index $existing.data "tls.key" }}
{{- else -}}
{{- $ca := genCA "coolscaler-admissions-ca" 3650 -}}
{{- $cert := genSignedCert $cn nil $altNames 3650 $ca -}}
ca: {{ $ca.Cert | b64enc }}
crt: {{ $cert.Cert | b64enc }}
key: {{ $cert.Key | b64enc }}
{{- end -}}
{{- end -}}
