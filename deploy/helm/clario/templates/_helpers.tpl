{{- define "clario.name" -}}{{ .Release.Name }}-clario{{- end -}}
{{- define "clario.labels" -}}
app: {{ include "clario.name" . }}
app.kubernetes.io/name: clario
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end -}}
