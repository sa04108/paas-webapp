#!/usr/bin/env bash
# =============================================================================
# delete.sh - 앱 삭제 스크립트
# =============================================================================
# 역할:
#   1) 앱 프로젝트의 컨테이너·네트워크·자체 이미지 정리와 잔류 리소스 확인
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

if [[ $# -lt 2 || $# -gt 3 ]]; then
  usage
  exit 1
fi

USER_ID="$1"
APP_NAME="$2"
KEEP_DATA="false"
if [[ "${3:-}" == "--keep-data" ]]; then
  KEEP_DATA="true"
elif [[ $# -eq 3 ]]; then
  usage
  exit 1
fi

validate_user_id "${USER_ID}"
validate_app_name "${APP_NAME}"

APP_DIR="$(app_dir_for "${USER_ID}" "${APP_NAME}")"
# 정리 실패 시 여기서 종료해 Compose와 메타데이터를 보존한다.
node "${SCRIPT_DIR}/lib/compose-project.js" down "${USER_ID}" "${APP_NAME}"

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
