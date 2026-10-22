#!/usr/bin/env bash
# =============================================================================
# create.sh - GitHub repo 기반 앱 생성 스크립트
# =============================================================================
# 역할:
#   1) userid / appname / repoUrl 유효성 검증
#   2) git clone으로 사용자 repo를 앱 디렉토리에 복제
#   3) detect-runtime.js로 런타임 메타데이터 감지 (UI 표시용)
#   4) Compose 검증 후 Railpack·서비스 Dockerfile·레지스트리 이미지 준비
#   5) 실행 정의와 서비스 목록을 원자적으로 저장
#   6) 앱 프로젝트 전체 기동과 초기화 작업 완료 확인
#
# 사용법:
#   create.sh <userid> <appname> <repoUrl> [branch]
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/lib/common.sh"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/lib/build.sh"

usage() {
  echo "Usage: create.sh <userid> <appname> <repoUrl> [branch]" >&2
}

if [[ $# -lt 3 || $# -gt 4 ]]; then
  usage
  exit 1
fi

USER_ID="$1"
APP_NAME="$2"
REPO_URL="$3"
BRANCH="${4:-main}"

validate_user_id "${USER_ID}"
validate_app_name "${APP_NAME}"
validate_repo_url "${REPO_URL}"

ensure_base_directories

APP_DIR="$(app_dir_for "${USER_ID}" "${APP_NAME}")"

if [[ -e "${APP_DIR}" ]]; then
  echo "[create] [info] App directory already exists. Replacing existing source: ${USER_ID}/${APP_NAME}"
  rm -rf "${APP_DIR}/${APP_SOURCE_SUBDIR}"
fi

# 실패한 빌드와 일부 기동도 같은 프로젝트로 재시도하거나 삭제할 수 있게 보존한다.

mkdir -p "${APP_DIR}/${APP_DATA_SUBDIR}" "${APP_DIR}/${APP_LOGS_SUBDIR}"

setup_git_auth  # GIT_TOKEN이 있으면 private repo 인증 설정 (없으면 무동작)
echo "[create] Cloning repository: ${REPO_URL} (branch: ${BRANCH})"
git clone --depth 1 --branch "${BRANCH}" "${REPO_URL}" "${APP_DIR}/${APP_SOURCE_SUBDIR}"

require_node

echo "[create] Detecting runtime..."
RUNTIME_JSON="$(node "${DETECT_RUNTIME_TOOL}" "${APP_DIR}/${APP_SOURCE_SUBDIR}")"
DISPLAY_NAME="$(node -e "console.log(JSON.parse(process.argv[1]).displayName)" "${RUNTIME_JSON}")"
echo "[create] Detected runtime: ${DISPLAY_NAME}"

# 빌드 전에 저장해 실패한 앱도 관리 대상에 남긴다.
echo "[create] Writing app metadata..."
REPO_URL="${REPO_URL}" \
BRANCH="${BRANCH}" \
RUNTIME_JSON="${RUNTIME_JSON}" \
INSTALLATION_ID="${PAAS_INSTALLATION_ID:-}" \
node "${SCRIPT_DIR}/lib/build-config.js" save-metadata "${APP_DIR}/.paas-meta.json" "${PAAS_BUILD_CONFIG_PATH:-}"

node "${SCRIPT_DIR}/lib/compose-project.js" deploy "${USER_ID}" "${APP_NAME}" "${PAAS_RUNTIME_CONFIG_PATH:-}"

echo "[create] Complete: ${USER_ID}/${APP_NAME} repo=${REPO_URL} runtime=${DISPLAY_NAME}"
