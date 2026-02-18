#!/usr/bin/env bash
# =============================================================================
# delete.sh - 앱 삭제 스크립트
# =============================================================================
# 역할:
#   1) docker compose down --rmi local 로 컨테이너 및 빌드 이미지 제거
#   2) --keep-data 옵션 시 data/ 디렉토리만 보존하고 나머지 삭제
#   3) 옵션 없으면 앱 디렉토리 전체 삭제
#   4) 해당 유저의 앱이 더 이상 없으면 유저 디렉토리도 정리
#
# 사용법:
#   delete.sh <userid> <appname> [--keep-data]
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/lib/common.sh"

usage() {
  echo "Usage: delete.sh <userid> <appname> [--keep-data]" >&2
}

warn() {
  echo "[delete] WARN: $*" >&2
}

if [[ $# -lt 2 || $# -gt 3 ]]; then
  usage
  exit 1
fi

USER_ID="$1"
APP_NAME="$2"
KEEP_DATA="false"
if [[ "${3:-}" == "--keep-data" ]]; then
  KEEP_DATA="true"
fi

validate_user_id "${USER_ID}"
validate_app_name "${APP_NAME}"

APP_DIR="$(app_dir_for "${USER_ID}" "${APP_NAME}")"
COMPOSE_FILE="$(app_compose_file_path "${APP_DIR}")"
TARGET_CONTAINER="$(app_container_name "${USER_ID}" "${APP_NAME}")"

if [[ ! -d "${APP_DIR}" ]]; then
  echo "deleted: ${USER_ID}/${APP_NAME} keepData=${KEEP_DATA} alreadyMissing=true"
  exit 0
fi

if [[ -f "${COMPOSE_FILE}" ]]; then
  # --rmi local: build: 지시자로 생성된 이미지도 함께 제거
  if ! docker compose -f "${COMPOSE_FILE}" down --remove-orphans --rmi local; then
    warn "docker compose down failed, continue cleanup: ${USER_ID}/${APP_NAME}"
  fi
fi

if command -v docker >/dev/null 2>&1; then
  docker rm -f "${TARGET_CONTAINER}" >/dev/null 2>&1 || true
fi

if [[ "${KEEP_DATA}" == "true" ]]; then
  TEMP_DATA_DIR="${APP_DIR}.data.keep.$$"
  if [[ -d "${APP_DIR}/${APP_DATA_SUBDIR}" ]]; then
    mv "${APP_DIR}/${APP_DATA_SUBDIR}" "${TEMP_DATA_DIR}"
  fi
  rm -rf "${APP_DIR}"
  mkdir -p "${APP_DIR}"
  if [[ -d "${TEMP_DATA_DIR}" ]]; then
    mv "${TEMP_DATA_DIR}" "${APP_DIR}/${APP_DATA_SUBDIR}"
  else
    mkdir -p "${APP_DIR}/${APP_DATA_SUBDIR}"
  fi
else
  rm -rf "${APP_DIR}"
fi

USER_DIR="${PAAS_APPS_DIR}/${USER_ID}"
if [[ -d "${USER_DIR}" ]] && [[ -z "$(ls -A "${USER_DIR}")" ]]; then
  rmdir "${USER_DIR}" || true
fi

echo "deleted: ${USER_ID}/${APP_NAME} keepData=${KEEP_DATA}"
