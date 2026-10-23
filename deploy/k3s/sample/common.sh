#!/usr/bin/env bash

# 호출한 스크립트의 엄격 모드와 명시적 context를 함께 사용한다.
sample_context() {
  if [[ $# -ne 2 || "$1" != "--context" || -z "$2" ]]; then
    printf 'Usage: %s --context <lab-context>\n' "$0" >&2
    return 2
  fi
  command -v kubectl >/dev/null || { printf 'kubectl is required.\n' >&2; return 1; }
  SAMPLE_CONTEXT=$2
  SAMPLE_NAMESPACE=paas-sample
  SAMPLE_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
  kubectl --context="$SAMPLE_CONTEXT" cluster-info >/dev/null
}

kube() {
  kubectl --context="$SAMPLE_CONTEXT" "$@"
}

# 같은 이름의 다른 Namespace를 덮어쓰거나 삭제하지 않는다.
owned_namespace() {
  local ownership
  ownership=$(kube get namespace "$SAMPLE_NAMESPACE" --ignore-not-found \
    -o 'jsonpath={.metadata.labels.app\.kubernetes\.io/part-of}:{.metadata.labels.app\.kubernetes\.io/managed-by}')
  if [[ -n "$ownership" && "$ownership" != "paas-k3s-sample:paas-sample-script" ]]; then
    printf 'Refusing to modify namespace %s: sample ownership labels do not match.\n' "$SAMPLE_NAMESPACE" >&2
    return 1
  fi
}
