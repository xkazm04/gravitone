{{- define "gravitone.fullname" -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "gravitone.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "gravitone.selectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "gravitone.secretName" -}}
{{- if .Values.apiKey.existingSecret -}}
{{ .Values.apiKey.existingSecret }}
{{- else -}}
{{ include "gravitone.fullname" . }}-key
{{- end -}}
{{- end -}}
