#!/usr/bin/env bash
# =============================================================================
# delete.sh - PaaS 앱 삭제 스크립트
# =============================================================================
# 역할:
#   사용자 앱의 컨테이너를 중지하고 관련 파일을 삭제한다.
#   1) docker compose down 으로 컨테이너 종료 및 제거
#   2) --keep-data 옵션 시 data/ 디렉토리만 보존하고 나머지 삭제
#   3) 옵션 없으면 앱 디렉토리 전체 삭제
#   4) 해당 유저의 앱이 더 이상 없으면 유저 디렉토리도 정리
#
# 사용법:
#   delete.sh <userid> <appname> [--keep-data]
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PAAS_ROOT_DEFAULT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${PAAS_ENV_FILE:-${PAAS_ROOT_DEFAULT}/.env}"

if [[ -z "${PAAS_ENV_FILE:-}" && -f "/paas/.env" ]]; then
  ENV_FILE="/paas/.env"
fi

if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "${ENV_FILE}"
  set +a
fi

PAAS_ROOT="${PAAS_ROOT:-${PAAS_ROOT_DEFAULT}}"
PAAS_APPS_DIR="${PAAS_APPS_DIR:-${PAAS_ROOT}/apps}"

usage() {
  echo "Usage: delete.sh <userid> <appname> [--keep-data]" >&2
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

if [[ ! "${USER_ID}" =~ ^[a-z][a-z0-9]{2,19}$ ]]; then
  echo "Invalid userid. Expected /^[a-z][a-z0-9]{2,19}$/" >&2
  exit 1
fi
if [[ ! "${APP_NAME}" =~ ^[a-z][a-z0-9-]{2,29}$ ]]; then
  echo "Invalid appname. Expected /^[a-z][a-z0-9-]{2,29}$/" >&2
  exit 1
fi

APP_DIR="${PAAS_APPS_DIR}/${USER_ID}/${APP_NAME}"
COMPOSE_FILE="${APP_DIR}/docker-compose.yml"

if [[ ! -d "${APP_DIR}" ]]; then
  echo "App not found: ${USER_ID}/${APP_NAME}" >&2
  exit 1
fi

if [[ -f "${COMPOSE_FILE}" ]]; then
  docker compose -f "${COMPOSE_FILE}" down --remove-orphans || true
fi

if [[ "${KEEP_DATA}" == "true" ]]; then
  TEMP_DATA_DIR="${APP_DIR}.data.keep.$$"
  if [[ -d "${APP_DIR}/data" ]]; then
    mv "${APP_DIR}/data" "${TEMP_DATA_DIR}"
  fi
  rm -rf "${APP_DIR}"
  mkdir -p "${APP_DIR}"
  if [[ -d "${TEMP_DATA_DIR}" ]]; then
    mv "${TEMP_DATA_DIR}" "${APP_DIR}/data"
  else
    mkdir -p "${APP_DIR}/data"
  fi
else
  rm -rf "${APP_DIR}"
fi

USER_DIR="${PAAS_APPS_DIR}/${USER_ID}"
if [[ -d "${USER_DIR}" ]] && [[ -z "$(ls -A "${USER_DIR}")" ]]; then
  rmdir "${USER_DIR}" || true
fi

echo "deleted: ${USER_ID}/${APP_NAME} keepData=${KEEP_DATA}"
