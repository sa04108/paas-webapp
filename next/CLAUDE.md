@AGENTS.md

# next/ — PaaS Portal

이 디렉터리는 Hyunbbai PaaS 관리 포털의 **Next.js 풀스택** 구현입니다.

- **상세 문서:** [README.md](./README.md) — 아키텍처, 폴더 구조, API, 실행 방법
- **진입점:** `server.mjs` (WebSocket 포함, `next dev` 단독 사용 금지)
- **비즈니스 로직:** `lib/portal/**` (Route Handler는 얇게 유지)
- **레거시:** `../portal/` Express — 참조만, 신규 변경은 여기(`next/`)에 적용
