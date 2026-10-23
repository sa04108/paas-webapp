#!/usr/bin/env bash
set -euo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"
sample_context "$@"
owned_namespace

# 샘플 전용 Namespace 안의 모든 리소스를 삭제하고 실제 종료를 기다린다.
# finalizer를 강제로 제거하거나 Namespace 밖의 리소스를 삭제하지 않는다.
printf 'Deleting ALL resources in context=%s namespace=%s\n' "$SAMPLE_CONTEXT" "$SAMPLE_NAMESPACE"
kube delete namespace "$SAMPLE_NAMESPACE" --ignore-not-found --wait=true --timeout=120s
