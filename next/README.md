# PaaS Portal (Next.js)

Hyunbbai PaaS의 **관리 포털**입니다.  
기존 Express 기반 `portal/` 을 대체하는 **Next.js 풀스택** 앱으로, UI·REST API·백그라운드 잡·WebSocket exec 터미널을 한 프로세스에서 제공합니다.

> **런타임 진입점:** `docker-compose.yml` 의 `portal` 서비스는 이 디렉터리(`next/`)를 기준으로 동작합니다.  
> `../portal/` 은 레거시 참조용이며, 신규 변경은 여기에 적용합니다.

---

## 한눈에 보기

| 구분 | 위치 | 설명 |
|------|------|------|
| **UI** | `app/auth`, `app/[[...slug]]`, `public/*` | 대시보드 SPA (기존 HTML/JS 자산 서빙) |
| **API** | `app/api/**` | Route Handlers — `/api/*` JSON API |
| **비즈니스 로직** | `lib/portal/**` | 인증·앱·잡·도메인·GitHub (프레임워크 독립) |
| **HTTP 서버** | `server.mjs` | Next.js + exec WebSocket 업그레이드 |
| **호스트 분기** | `proxy.ts` | 루트 도메인 랜딩 / portal 서브도메인 리다이렉트 |

---

## 아키텍처

```
브라우저
   │
   ▼
server.mjs (Node HTTP)
   ├── Next.js App Router
   │     ├── app/api/**     → lib/portal/routes/*.js (비즈니스 로직)
   │     ├── app/auth       → 로그인 HTML
   │     ├── app/[[...slug]] → 대시보드 SPA HTML
   │     └── proxy.ts       → 랜딩/포털 호스트 분기
   │
   └── WebSocket upgrade
         └── /api/apps/:u/:a/exec/ws → lib/portal/routes/exec-ws.js
                                           ↓
                                      dockerode (컨테이너 TTY)

lib/portal/runtime.js  ──► SQLite, jobStore, domainManager, githubService 초기화
```

**왜 `server.mjs`가 필요한가?**  
Next.js 기본 서버(`next start`)만으로는 HTTP → WebSocket 업그레이드(exec 터미널)를 처리할 수 없습니다.  
exec 경로만 가로채고, 나머지 요청·HMR 업그레이드는 Next.js에 위임합니다.

---

## 디렉터리 구조

```
next/
├── app/
│   ├── api/                    # REST API (Route Handlers)
│   │   ├── auth/               # 로그인·세션·비밀번호 변경
│   │   ├── apps/               # 앱 CRUD·배포·로그·exec·env·domains
│   │   ├── jobs/               # 비동기 작업 조회·SSE·재시도·취소
│   │   ├── users/              # 사용자 관리 (admin)
│   │   ├── github/             # GitHub App 연동
│   │   ├── admin/              # 포털 컨테이너 로그
│   │   └── config/             # 공개 설정
│   ├── auth/route.ts           # GET /auth — 로그인 페이지 HTML
│   ├── [[...slug]]/route.ts    # GET /* — 대시보드 SPA HTML (인증 필요)
│   ├── health/route.ts         # GET /health — 인프라 헬스체크
│   └── layout.tsx              # 루트 레이아웃
│
├── lib/portal/                 # 포털 핵심 로직 (CommonJS, Express 무관)
│   ├── runtime.js              # 싱글턴 부트스트랩 (DB·잡·훅 조립)
│   ├── http.ts                 # Next ↔ 서비스 어댑터 (쿠키·인증·응답 envelope)
│   ├── config.js               # 환경 변수 로딩 (../.env)
│   ├── authService.js          # 세션·사용자·SQLite
│   ├── appManager.js           # 앱 FS·Docker·셸 스크립트
│   ├── jobStore.js             # 비동기 잡 큐·SSE
│   ├── domainManager.js        # 커스텀 도메인·Traefik YAML
│   ├── githubService.js        # GitHub App OAuth·토큰
│   ├── routes/                 # API 핸들러 (프레임워크 독립 함수)
│   │   ├── apps.js
│   │   ├── jobs.js
│   │   ├── users.js
│   │   ├── domains.js
│   │   ├── github.js
│   │   └── exec-ws.js          # WebSocket TTY (server.mjs에서 직접 사용)
│   └── pages/                  # 서버가 내려주는 HTML 셸
│       ├── auth.html
│       └── dashboard.html
│
├── public/                     # 정적 자산 (브라우저에서 직접 로드)
│   ├── app.js, app-*.js        # 대시보드 SPA ES modules
│   ├── auth.js                 # 로그인 폼 스크립트
│   ├── styles.css
│   └── landing/                # 루트 도메인 마케팅 페이지
│
├── server.mjs                  # 커스텀 Node 서버 (진입점)
├── proxy.ts                    # 호스트 기반 랜딩/포털 분기
├── next.config.ts
└── package.json
```

### 레이어 역할

| 레이어 | 파일 | 역할 |
|--------|------|------|
| **Route Handler** | `app/api/**/route.ts` | HTTP 입출력, 인증 가드, `{ ok, data }` envelope |
| **어댑터** | `lib/portal/http.ts` | 쿠키·`requireAuth`·에러 → HTTP 상태 |
| **핸들러** | `lib/portal/routes/*.js` | 요청 검증 + 비즈니스 호출 (Express Router 없음) |
| **서비스** | `lib/portal/*Service.js`, `appManager.js` | DB·Docker·스크립트·외부 API |

새 API를 추가할 때는 **`routes/`에 로직 → `app/api/`에 얇은 Route Handler** 순서로 작성합니다.

---

## 도메인·URL

| 호스트 | 경로 | 동작 |
|--------|------|------|
| `{PAAS_DOMAIN}` | `/` | 랜딩 (`public/landing/`) |
| `{PAAS_DOMAIN}` | `/dashboard`, `/auth`, `/apps/...` | `portal.{PAAS_DOMAIN}` 으로 301 |
| `portal.{PAAS_DOMAIN}` | `/auth` | 로그인 |
| `portal.{PAAS_DOMAIN}` | `/`, `/dashboard`, `/create`, `/users`, `/admin`, `/apps/{u}/{a}` | 대시보드 SPA |

**로컬 개발** (`PAAS_DOMAIN=localhost`):

- 랜딩: `http://localhost:3000`
- 포털: `http://portal.localhost:3000`

---

## 실행

### 로컬

```bash
cd next
npm install
npm run dev          # server.mjs (개발 모드, HMR + WS)
```

프로덕션:

```bash
npm run build
npm run start        # NODE_ENV=production + server.mjs
```

### Docker Compose (레포 루트)

```bash
docker compose up portal
```

`docker-compose.yml` 이 `next/` 에서 `npm ci` → `npm run dev`(개발) 또는 `npm run build && npm run start`(프로덕션) 를 실행합니다.

### 기본 계정

- `admin / admin` (최초 부트스트랩, 로그인 후 비밀번호 변경 권장)

---

## 환경 변수

루트 `../.env` (또는 `PAAS_ENV_FILE`) 를 읽습니다. 주요 항목:

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `PAAS_DOMAIN` | `my.domain.com` | 루트 도메인 |
| `PORTAL_PORT` | `3000` | 리슨 포트 |
| `PORTAL_DB_PATH` | `../portal-data/portal.sqlite3` | SQLite (세션·사용자·잡·도메인) |
| `PAAS_APPS_DIR` | `../apps` | 배포된 유저 앱 디렉터리 |
| `PAAS_SCRIPTS_DIR` | `../scripts` | create/deploy/delete.sh |
| `SESSION_COOKIE_NAME` | `portal_session` | httpOnly 세션 쿠키 |
| `RUN_MODE` | — | `development` 시 dev 모드·호스트 포트 노출 |

전체 목록은 레포 루트 `.env.example` 을 참고하세요.

---

## API 개요

모든 JSON API는 **`/api/*`** 아래에 있으며, 응답 형식은 통일됩니다.

```json
// 성공
{ "ok": true, "data": { ... } }

// 실패
{ "ok": false, "error": "메시지" }
```

| 그룹 | 경로 | 인증 |
|------|------|------|
| 공개 | `GET /health`, `GET /api/config` | 없음 |
| 인증 | `POST /api/auth/login`, `GET /me`, `POST /logout`, `POST /change-password` | login만 공개 |
| 앱 | `GET|POST /api/apps`, `.../start|stop|deploy|logs|exec|env|domains` | 세션 + 비밀번호 변경 완료 |
| 잡 | `GET /api/jobs`, `.../stream` (SSE), `.../retry|cancel` | 세션 |
| 사용자 | `GET|POST /api/users`, `PATCH|DELETE /api/users/:id` | admin |
| GitHub | `GET /api/github/status|connect|repos`, `POST /disconnect` | 세션 |
| 관리 | `GET /api/admin/portal-logs` | admin |

장시간 작업(create/deploy/delete/start/stop)은 **202 + `{ jobId }`** 로 즉시 반환하고, `jobStore` 가 백그라운드에서 실행합니다.

---

## 인증

- **방식:** httpOnly 쿠키 세션 (`portal_session`)
- **토큰 형식:** `sess.<sessionId>.<secret>` (DB에는 secret 해시만 저장)
- **가드:** Route Handler에서 `requireAuth` → `requirePasswordUpdated` → (admin) `requireAdmin`
- **UI 라우트:** `app/[[...slug]]` 가 세션 없으면 `/auth` 로 리다이렉트

---

## UI 마이그레이션 상태

현재 UI는 **기존 바닐라 JS SPA를 그대로 서빙**하는 단계입니다.

| 구성요소 | 상태 |
|----------|------|
| API | Next.js Route Handlers로 이전 완료 |
| exec WebSocket | `server.mjs` + `exec-ws.js` |
| 대시보드·로그인 | HTML 셸 + `public/*.js` (React 미이전) |
| 랜딩 | `public/landing/` 정적 파일 |

향후 `app/(portal)/**/page.tsx` 로 React 컴포넌트화할 예정입니다.

---

## 개발 시 주의사항

1. **`npm run dev` / `npm run start` 는 반드시 `server.mjs` 를 사용** — `next dev` 단독 실행 시 WebSocket exec가 동작하지 않습니다.
2. **네이티브 모듈** (`better-sqlite3`, `dockerode`) — `next.config.ts` 의 `serverExternalPackages` 에 등록됨. Edge Runtime 사용 불가.
3. **런타임 싱글턴** — `lib/portal/runtime.js` 는 `globalThis` 에 캐시됩니다. custom server와 Route Handler가 동일 인스턴스를 공유합니다.
4. **경로 해석** — `lib/portal/config.js` 는 `process.cwd()` 기준으로 레포 루트를 찾습니다. `next/` 디렉터리에서 npm script를 실행하세요.
5. **Docker 소켓** — 앱 생성·배포·exec는 `/var/run/docker.sock` 마운트가 필요합니다 (`docker-compose.yml` 참고).

---

## Express `portal/` 과의 대응

| Express (`portal/`) | Next (`next/`) |
|-------------------|----------------|
| `server.js` | `server.mjs` + `app/**` + `proxy.ts` |
| `routes/*.js` (Express Router) | `lib/portal/routes/*.js` (순수 함수) + `app/api/**/route.ts` |
| `public/index.html`, `auth.html` | `lib/portal/pages/*.html` + `public/*.js` |
| `authService.attachRoutes` | `app/api/auth/**` + `authService.login()` 등 |

---

## 스크립트

| 명령 | 설명 |
|------|------|
| `npm run dev` | `node server.mjs` (개발) |
| `npm run build` | `next build` |
| `npm run start` | 프로덕션 `node server.mjs` |
| `npm run lint` | ESLint |
