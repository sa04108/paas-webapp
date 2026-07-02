#!/usr/bin/env bash
# =============================================================================
# git-askpass.sh - git HTTPS 자격증명 공급 헬퍼 (GIT_ASKPASS)
# =============================================================================
# git이 HTTPS 인증 정보를 물어볼 때 호출된다.
#   - username 질문 → 토큰 인증용 고정값(x-access-token)
#   - password 질문 → GIT_TOKEN 환경변수(평문 토큰)
# 토큰을 명령 인자나 .git/config의 remote URL에 남기지 않고 env로만 주입하기 위한 방식이다.
# 호출 규약: git은 프롬프트 문구를 첫 번째 인자($1)로 전달한다. (예: "Password for 'https://...'")
# =============================================================================
case "$1" in
  Username*) echo "x-access-token" ;;
  *)         echo "${GIT_TOKEN:-}" ;;
esac
