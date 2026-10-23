{{- define "loremaster.image" -}}
{{- $image := required (printf "Admitted image required: %s" .name) .image -}}
{{- if not (regexMatch "^localhost:5001/loremaster/[a-z-]+@sha256:[a-f0-9]{64}$" $image) -}}
{{- fail (printf "Image must be an admitted local registry digest: %s" .name) -}}
{{- end -}}
{{- $image | quote -}}
{{- end -}}

{{- define "loremaster.security" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: [ALL]
{{- end -}}

{{- define "loremaster.podSecurity" -}}
runAsNonRoot: true
runAsUser: {{ . }}
runAsGroup: {{ . }}
fsGroup: {{ . }}
seccompProfile:
  type: RuntimeDefault
{{- end -}}
