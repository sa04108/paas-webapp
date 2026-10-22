#!/usr/bin/env bash
# =============================================================================
# lib/build.sh - 앱 이미지 빌드 및 compose 생성 공통 함수
# =============================================================================
# create.sh / deploy.sh 양쪽에서 source하여 사용한다.

# app_image_name <userid> <appname>
# → 이미지 태그 문자열을 출력한다.
app_image_name() {
  local user_id="$1"
  local app_name="$2"
  echo "paas-app-${user_id}-${app_name}:latest"
}

# build_app_image <src_dir> <image_name> [config_path]
# → 저장된 명시적 설정을 우선하고, 자동 모드에서는 기존 루트 파일 탐지를 사용한다.
# → 자동 모드의 후보는 바이트순으로 선택하며, 후보가 없을 때만 railpack build를 사용한다.
build_app_image() {
  local src_dir="$1"
  local image_name="$2"
  local config_path="${3:-}"
  local dockerfile_path=""
  local candidate_path=""
  local candidate_name=""

  if [[ -n "${config_path}" ]]; then
    dockerfile_path="$(node "$(dirname "${BASH_SOURCE[0]}")/build-config.js" resolve "${src_dir}" "${config_path}")" || return $?
  fi

  if [[ -n "${dockerfile_path}" ]]; then
    echo "[build] Using configured Dockerfile"
  elif [[ -f "${src_dir}/Dockerfile" ]]; then
    dockerfile_path="${src_dir}/Dockerfile"
  else
    while IFS= read -r -d '' candidate_path; do
      candidate_name="${candidate_path##*/}"
      if [[ "${candidate_name}" =~ Dockerfile ]]; then
        dockerfile_path="${candidate_path}"
        break
      fi
    done < <(find "${src_dir}" -mindepth 1 -maxdepth 1 -type f -print0 | LC_ALL=C sort -z)
  fi

  if [[ -n "${dockerfile_path}" ]]; then
    echo "[build] User Dockerfile detected at ${dockerfile_path}; using docker build"
    docker build \
      -t "${image_name}" \
      -f "${dockerfile_path}" \
      "${src_dir}"
  else
    echo "[build] Using railpack build"
    (cd "${src_dir}" && railpack build . --name "${image_name}")
  fi
}

# generate_app_compose <userid> <appname> <image_name>
# → generate-compose.js를 호출해 docker-compose.yml을 생성한다.
generate_app_compose() {
  local user_id="$1"
  local app_name="$2"
  local image_name="$3"
  APP_IMAGE="${image_name}" node "${GENERATE_COMPOSE_TOOL}" "${user_id}" "${app_name}"
}
