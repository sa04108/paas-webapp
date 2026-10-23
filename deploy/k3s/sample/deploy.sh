#!/usr/bin/env bash
set -euo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"
sample_context "$@"
owned_namespace

# 매니페스트를 먼저 확인한다. 한 클러스터에서는 이 스크립트를 직렬로 실행한다.
kube kustomize "$SAMPLE_DIR/bootstrap" >/dev/null
kube kustomize "$SAMPLE_DIR/runtime" >/dev/null
kube apply -k "$SAMPLE_DIR/bootstrap"

# 예제 Secret은 저장소나 명령행 인자에 비밀값을 남기지 않고 최초 한 번 만든다.
if [[ -z "$(kube -n "$SAMPLE_NAMESPACE" get secret app-secrets --ignore-not-found -o name)" ]]; then
  command -v openssl >/dev/null || { printf 'openssl is required to create the sample secret.\n' >&2; exit 1; }
  umask 077
  sample_tmp=$(mktemp -d)
  trap 'rm -rf -- "$sample_tmp"' EXIT
  openssl rand -hex 32 > "$sample_tmp/DEMO_TOKEN"
  kube -n "$SAMPLE_NAMESPACE" create secret generic app-secrets \
    --from-file="DEMO_TOKEN=$sample_tmp/DEMO_TOKEN" >/dev/null
fi

# Job마다 이름을 새로 발급해 이전 실행의 완료 상태를 재사용하지 않는다.
job_name=$(kube create -f "$SAMPLE_DIR/migration.yaml" -o 'jsonpath={.metadata.name}')
printf 'Waiting for job/%s in context=%s namespace=%s\n' "$job_name" "$SAMPLE_CONTEXT" "$SAMPLE_NAMESPACE"
if ! kube -n "$SAMPLE_NAMESPACE" wait --for=condition=complete "job/$job_name" --timeout=90s; then
  printf 'Preparation failed or timed out; web and worker rollout was not started.\n' >&2
  kube -n "$SAMPLE_NAMESPACE" logs "job/$job_name" --all-containers=true >&2 || true
  exit 1
fi
kube -n "$SAMPLE_NAMESPACE" logs "job/$job_name" --all-containers=true

kube apply -k "$SAMPLE_DIR/runtime"
# envFrom 값은 실행 중인 프로세스에 갱신되지 않으므로 성공한 배포마다 재시작한다.
kube -n "$SAMPLE_NAMESPACE" rollout restart deployment/web deployment/worker
kube -n "$SAMPLE_NAMESPACE" rollout status deployment/web --timeout=120s
kube -n "$SAMPLE_NAMESPACE" rollout status deployment/worker --timeout=120s
printf 'Workloads are ready. Verify HTTP 200 using the port-forward or ingress guide.\n'
