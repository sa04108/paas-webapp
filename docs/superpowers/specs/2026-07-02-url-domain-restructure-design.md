# URL/도메인 체계 개편 설계

**날짜:** 2026-07-02
**상태:** 사용자 승인됨 (설계 단계)
**호환성 방침:** 클린 브레이크 — 구 경로/구 도메인 호환 레이어 없음

## 배경과 목표

포털이 URL 고정(`/`)형 SPA라서 사용자가 앱 관리 화면에 있는지 유저 관리 화면에
있는지 URL로 구분할 수 없다. 또한 포털이 루트 도메인을 직접 점유하고 유저 앱이
루트 와일드카드(`{user}-{app}.hyunbbai.com`)를 사용해, 루트 도메인 네임스페이스가
유저 콘텐츠에 점유되고 피싱성 서브도메인 생성 여지가 있다.

목표:

1. 화면별로 구분되는 URL (path 기반, History API)
2. JSON API를 `/api/*`로 격리
3. 포털을 `portal.{루트도메인}`으로 이동, 루트 접속은 포털로 301 리다이렉트
4. 유저 앱 도메인을 `*.apps.{루트도메인}`으로 격리

## 1. 도메인 토폴로지

```
hyunbbai.com                        → 301 → portal.hyunbbai.com (경로 보존)
portal.hyunbbai.com                 → 포털 (UI + API)
{user}-{app}.apps.hyunbbai.com      → 유저 앱
커스텀 도메인                        → 기존 custom_domains 메커니즘 그대로 (변경 없음)
```

- `.env`의 `PAAS_DOMAIN=hyunbbai.com`은 루트 도메인 의미로 유지한다.
  포털/앱 도메인은 `portal.${PAAS_DOMAIN}` / `apps.${PAAS_DOMAIN}`으로 파생한다.
  새 env 변수는 추가하지 않는다.
- **루트 리다이렉트는 Traefik 라벨만으로 구현한다** (포털 코드 변경 없음):
  - portal 컨테이너에 라우터 2개:
    - `portal`: ``Host(`portal.${PAAS_DOMAIN}`)`` → 포털 서빙
    - `portal-root`: ``Host(`${PAAS_DOMAIN}`)`` + `redirectregex` 미들웨어
      → `https://portal.${PAAS_DOMAIN}/$1` (301, 경로 보존)
- `scripts/generate-compose.js`: 앱 도메인 생성식을
  `${userid}-${appname}.apps.${PAAS_DOMAIN}`으로 변경 (1줄).
- dev 환경(`PAAS_DOMAIN=localhost`): `*.apps.localhost`도 브라우저가 loopback
  처리하므로 동일 스킴을 유지한다. `TLS_ENABLED`의 `endsWith('localhost')`
  판정도 그대로 성립한다.
- TLS: 기존 Cloudflare DNS-01 라우터별 발급이라 변경 없음.
- DNS 등록(운영자 수행): 루트 A, `portal` A/CNAME, `*.apps` 와일드카드.

## 2. API → `/api/*` 이동

이동 대상 (모든 JSON API + WebSocket):

| 구 경로 | 신 경로 |
|---|---|
| `/auth/login` 등 auth JSON API | `/api/auth/*` |
| `/apps/*` (exec WS 포함) | `/api/apps/*` |
| `/jobs/*` | `/api/jobs/*` |
| `/users/*` | `/api/users/*` |
| `/admin/portal-logs` | `/api/admin/portal-logs` |
| `/github/*` | `/api/github/*` |
| `/config` | `/api/config` |

루트에 유지:

- `/health` — 인프라 관례 (docker healthcheck 등)
- `/auth` — 로그인 HTML 페이지 (JSON API `/api/auth/*`와 분리)
- 정적 파일 서빙

부수 정리:

- 404 catch-all을 열거식(`["/apps","/users","/admin","/github"]`)에서
  `/api/*` 미매칭 전체 → 404 JSON으로 단순화한다.
- 프론트 `apiFetch()` 한 곳에서 `/api` prefix를 부여한다.
  개별 호출부는 수정하지 않는다.
- GitHub App Callback URL은
  `https://portal.hyunbbai.com/api/github/callback`으로 변경한다.
  `docs/github-app-setup.md`, `.env.example` 주석을 갱신한다.

## 3. 프론트 라우팅 (History API)

경로 맵:

| URL | 뷰 |
|---|---|
| `/` | `/dashboard`로 replace |
| `/dashboard` | dashboard |
| `/create` | create |
| `/users` | users |
| `/admin` | admin-dashboard |
| `/apps/{userid}/{appname}` | app-detail |

- 앱 상세의 서브탭(logs/exec/settings/domains)과 admin 서브탭은 URL에
  반영하지 않는다 (합의된 범위).
- `portal/public/app-router.js` 신설:
  - `parsePath(pathname)` → `{ view, params }` — 순수 함수, 단위 테스트 대상
  - `buildPath(view, params)` → 경로 문자열 — 순수 함수
  - `navigate(path)` — `history.pushState` + 뷰 렌더
  - `popstate` 리스너 — 뒤로/앞으로가기 처리
- 기존 `switchView()` 직접 호출부는 라우터를 경유하도록 변경한다.
  `switchView()` 자체는 DOM 토글 함수로 유지한다 (라우터가 호출).
- 딥링크: 부트스트랩에서 세션 확인 후 URL을 파싱해 해당 뷰로 진입한다.
  `/apps/{u}/{a}`는 앱 목록 로드 후 진입하고, 없는 앱이면 dashboard로
  replace + 토스트를 표시한다.
- 권한: 비관리자가 `/users`, `/admin` 접근 시 dashboard로 fallback
  (기존 switchView의 뷰 검증 로직 재사용).
- **localStorage 뷰 복원(`portal.uiState`)은 제거한다** — URL이 대체한다.
- 알 수 없는 UI 경로는 dashboard로 replace한다.
- GitHub 콜백 복귀 경로: `/?github=connected#create` → `/create?github=connected`.
  배너 표시 후 쿼리 제거(replaceState) 로직은 유지한다.
- 서버 SPA fallback: UI 경로 패턴(GET, HTML accept)에 index.html을 서빙한다.
  미인증이면 기존 `canAccessDashboardUi` 판정으로 `/auth`로 리다이렉트한다.

## 4. 검증

- `parsePath`/`buildPath` 순수 로직 node:test 단위 테스트
  (`portal/test/appRouter.test.js`)
- 수동 체크리스트:
  1. 각 뷰 진입 시 URL 변경 확인
  2. 새로고침 시 같은 화면 복원
  3. 뒤로/앞으로가기 동작
  4. `/apps/{u}/{a}` URL 직접 접속(딥링크) 동작
  5. 루트 도메인 접속 → `portal.` 301 리다이렉트 (경로 보존)
  6. 재배포한 앱이 `{u}-{a}.apps.{도메인}`으로 서빙
  7. 비관리자 `/users` 접근 → dashboard fallback
  8. GitHub 연결 플로우 전체 (새 callback 경로)

## 5. 마이그레이션 (클린 브레이크)

- 기존 배포 앱: 일괄 재배포(또는 compose 재생성)로 새 도메인 적용
- GitHub App 설정에서 Callback URL 변경
- DNS 3건 등록 (운영자)
- 구 앱 도메인/구 API 경로에 대한 리다이렉트·호환 레이어는 만들지 않는다

## 범위 밖 (명시)

- 앱 상세/admin 서브탭의 URL 반영
- 별도 도메인(Vercel식 `hyunbbai.app`)을 통한 완전한 쿠키/피싱 격리
- 구 도메인 → 신 도메인 리다이렉트 서비스
