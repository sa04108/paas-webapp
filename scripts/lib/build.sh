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
  local config_tool="$(dirname "${BASH_SOURCE[0]}")/build-config.js"
  local build_mode="auto"

  if [[ -n "${config_path}" ]]; then
    build_mode="$(node "${config_tool}" mode "${config_path}")" || return $?
    if [[ "${build_mode}" == "railpack" ]]; then
      local railpack_config_path=""
      local railpack_args=(build . --name "${image_name}")
      railpack_config_path="$(node "${config_tool}" railpack "${src_dir}" "${config_path}")" || return $?
      if [[ -n "${railpack_config_path}" ]]; then
        railpack_args+=(--config-file "${railpack_config_path}")
        echo "[build] Using Railpack with server-provided configuration"
      else
        echo "[build] Using Railpack with default configuration"
      fi
      (cd "${src_dir}" && railpack "${railpack_args[@]}")
      return $?
    fi
    dockerfile_path="$(node "${config_tool}" resolve "${src_dir}" "${config_path}")" || return $?
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
    if [[ "${build_mode}" == "auto" ]]; then
      dockerfile_path="$(node "${config_tool}" auto "${src_dir}" "${dockerfile_path##*/}")" || return $?
    fi
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
