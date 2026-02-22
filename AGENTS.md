# Mini PaaS Agent Spec

## 1. 문서 목적
- 이 문서는 `paas-webapp`의 동작 규칙을 코드 기준으로 정의한다.
- 에이전트는 코드 수정 전에 이 문서를 읽고 동일한 계약을 유지한다.

## 2. 서비스 개요
- 앱 생성 입력은 Git 저장소 정보다.
- 생성 파라미터는 `appname`, `repoUrl`, `branch`를 사용한다.
- 앱 실행 단위는 `apps/<userid>/<appname>` 디렉토리와 app별 `docker-compose.yml` 1개다.

## 3. 식별자 규칙
- `userid`: `/^[a-z][a-z0-9]{2,19}$/`
- `appname`: `/^[a-z][a-z0-9-]{2,29}$/`
- 앱 도메인: `<userid>-<appname>.<PAAS_DOMAIN>`

## 4. Core Stack
- Portal API: Node.js + Express (진입점 `portal/server.js`, 모듈 분리)
  - `portal/utils.js` — AppError, sendOk/sendError 등 공유 유틸
  - `portal/config.js` — 환경변수 로드, 상수 (USER_ID_REGEX, APP_NAME_REGEX 등)
  - `portal/appManager.js` — 앱/Docker/파일시스템 도메인 로직 전체
  - `portal/jobStore.js` — 백그라운드 Job 상태 관리 (in-memory + SQLite 영속화)
  - `portal/routes/apps.js` — `/apps` 라우터 (Express.Router)
  - `portal/routes/jobs.js` — `/jobs` 라우터 (job 조회, SSE, 재시도)
  - `portal/routes/users.js` — `/users` 라우터 (factory: `createUsersRouter(authService)`)
- 인증/세션/사용자 관리: SQLite + `portal/authService.js`
- 앱 생명주기: `scripts/create.sh`, `scripts/deploy.sh`, `scripts/delete.sh`
- 런타임/파일 생성:
  - `scripts/detect-runtime.js`
  - `scripts/generate-dockerfile.js`
  - `scripts/generate-compose.js`
  - `scripts/lib/common.sh`
- 프론트엔드: 번들러 없는 다중 스크립트 (전역 스코프 공유, 순서 의존성 있음)
  - `portal/public/app-state.js` — 전역 상수·상태·DOM 참조 (최우선 로드), `jobs`, `jobPollers` 포함
  - `portal/public/app-utils.js` — 순수 헬퍼, 폼 검증, 인증 상태 확인
  - `portal/public/app-render.js` — renderApps, renderUsers
  - `portal/public/app-ui.js` — 뷰/탭 전환, 모달, updateAuthUi, navigateToApp, renderJobIndicator
  - `portal/public/app-exec.js` — Exec 터미널 (히스토리, 탭 완성, cwd 추적)
  - `portal/public/app-api.js` — API 통신, 데이터 로딩, 앱 액션, job 폴링/복원
  - `portal/public/app.js` — 이벤트 바인딩 + 부트스트랩

## 5. 인증과 권한
- 인증은 세션 쿠키(`SESSION_COOKIE_NAME`, 기본 `portal_session`)를 사용한다.
- `/apps`, `/users`는 다음 조건을 모두 만족해야 접근 가능하다.
  - 로그인 세션 유효
  - admin 권한
  - `mustChangePassword=false`
- 부트스트랩 계정은 `admin / admin`이며 로그인 후 비밀번호 변경 절차를 따른다.
- 세션 `last_used_at` 갱신은 5분 쓰로틀을 적용한다.

## 6. API 명세

### 6.1 공용/세션
- `GET /health`
- `GET /config`
- `POST /auth/login`
- `GET /auth/me`
- `POST /auth/logout`
- `POST /auth/change-password`

### 6.2 앱 관리
- `POST /apps`
  - body: `{ appname, repoUrl, branch? }`
  - `branch` 기본값: `main`
  - `repoUrl`은 `http://` 또는 `https://`로 시작해야 한다.
  - **응답: `202 { jobId }` — 비동기 실행** (이전에는 블로킹 200)
- `GET /apps`
- `GET /apps/:userid/:appname`
- `POST /apps/:userid/:appname/start` → `202 { jobId }`
- `POST /apps/:userid/:appname/stop` → `202 { jobId }`
- `POST /apps/:userid/:appname/deploy` → `202 { jobId }`
- `DELETE /apps/:userid/:appname` → `202 { jobId }`
  - body: `{ keepData?: boolean }`
- `GET /apps/:userid/:appname/logs?lines=<n>`
  - `n` 범위: `1..1000`
  - 기본값: `120`

### 6.3 Job 관리 (신규)
- `GET /jobs` — 현재 사용자의 active + 최근 24h job 목록
- `GET /jobs/:id` — job 단건 조회 `{ id, type, status, meta, error, logs[] }`
- `GET /jobs/:id/stream` — SSE 실시간 로그 스트리밍
- `POST /jobs/:id/retry` — `interrupted`/`failed` job 재시도

### 6.4 사용자 관리
- `GET /users`
- `POST /users`
  - body: `{ username, password, isAdmin }`
- `DELETE /users/:id`
  - body: `{ currentPassword }`

### 6.5 응답 형식
- 성공 (동기): `{ ok: true, data: ... }`
- 성공 (비동기 job): `{ ok: true, data: { jobId } }` — HTTP 202
- 실패: `{ ok: false, error: "message" }`

## 7. 앱 생명주기 스크립트

### 7.1 `scripts/create.sh`
- 입력: `<userid> <appname> <repoUrl> [branch]`
- 처리:
1. 파라미터 검증
2. `git clone --depth 1 --branch <branch> <repoUrl>`
3. 런타임 감지
4. Dockerfile 결정(사용자 `Dockerfile` 우선, 없으면 `.paas.Dockerfile` 생성)
5. compose 생성
6. `.paas-meta.json` 기록
7. `docker compose up -d --build`
- 실패 시 생성 중 앱 디렉토리를 정리한다.

### 7.2 `scripts/deploy.sh`
- 입력: `<userid> <appname>`
- 처리:
1. `git pull`
2. 런타임 재감지
3. Dockerfile 처리(사용자 `Dockerfile` 우선, 없으면 `.paas.Dockerfile` 갱신)
4. `docker compose down` + `docker compose up -d --build`
5. 최대 `DEPLOY_TIMEOUT_SECS`(기본 30초) running 상태 확인
- 로그 파일: `logs/deploy.log`

### 7.3 `scripts/delete.sh`
- 입력: `<userid> <appname> [--keep-data]`
- 처리:
1. `docker compose down --remove-orphans --rmi local`
2. 앱 디렉토리 삭제
3. `--keep-data` 사용 시 `data/`만 보존

## 8. 런타임 감지와 산출 파일
- 감지 우선순위:
  - `next`
  - `@nestjs/core`
  - `nuxt`
  - `vite`
  - `express`
  - `fastify`
  - `koa`
  - fallback `node`
- Node major 버전은 `package.json > engines.node`에서 추출한다. 기본값은 `22`.
- 산출 파일:
  - `apps/<userid>/<appname>/<APP_COMPOSE_FILE>` (기본 `docker-compose.yml`)
  - `apps/<userid>/<appname>/.paas-meta.json`
- 조건부 산출 파일(저장소 루트에 `Dockerfile`이 없을 때):
  - `apps/<userid>/<appname>/<APP_SOURCE_SUBDIR>/.paas.Dockerfile`
  - `apps/<userid>/<appname>/<APP_SOURCE_SUBDIR>/.paas.dockerignore`

## 9. Compose/Container 정책
- 컨테이너 이름: `{APP_CONTAINER_PREFIX}-{userid}-{appname}` (기본 `paas-app`)
- 라벨:
  - `paas.type=user-app`
  - `paas.userid=<userid>`
  - `paas.appname=<appname>`
  - `paas.domain=<userid>-<appname>.<PAAS_DOMAIN>`
- 기본 리소스 제한:
  - `mem_limit=DEFAULT_MEM_LIMIT` (기본 `256m`)
  - `cpus=DEFAULT_CPU_LIMIT` (기본 `0.5`)
- 로그 로테이션:
  - `max-size=10m`
  - `max-file=3`
- 네트워크: external network `APP_NETWORK`(기본 `paas-app`)

## 10. 운영 제한과 최적화
- 앱 개수 제한:
  - 유저당 `MAX_APPS_PER_USER` (기본 5)
  - 전체 `MAX_TOTAL_APPS` (기본 20)
- Docker 상태 조회 캐시: 5초(`listDockerStatuses`)
- 프론트 자동 갱신 주기: 30초(`AUTO_REFRESH_MS`)

## 11. 환경 변수 핵심

### 11.1 `.env.example` — 사용자가 설정해야 하는 값
- 도메인: `PAAS_DOMAIN`
- 포털: `PORTAL_PORT`, `SESSION_COOKIE_NAME`, `SESSION_TTL_HOURS`, `PORTAL_COOKIE_SECURE`, `BCRYPT_ROUNDS`, `PORTAL_TRUST_PROXY`
- 컨테이너 기본값: `DEFAULT_MEM_LIMIT`, `DEFAULT_CPU_LIMIT`, `DEFAULT_RESTART_POLICY`
- 네트워크: `APP_NETWORK`
- 앱 제한: `MAX_APPS_PER_USER`, `MAX_TOTAL_APPS`

### 11.2 코드 기본값 — override 가능하나 `.env`에 기재 불필요
경로는 모두 `PAAS_ROOT`(= 스크립트/모듈 위치 기준으로 자동 계산)에서 파생된다.

| 변수 | 기본값 계산 위치 | 기본값 |
|---|---|---|
| `PAAS_ROOT` | `common.sh`(스크립트 위치), `config.js`(`repoRoot`), `generate-compose.js`(`/paas`) | 자동 계산 |
| `PAAS_APPS_DIR` | `common.sh`, `config.js` | `${PAAS_ROOT}/apps` |
| `PAAS_SCRIPTS_DIR` | `config.js` | `${PAAS_ROOT}/scripts` |
| `PORTAL_DB_PATH` | `config.js` | `${PAAS_ROOT}/portal-data/portal.sqlite3` |
| `PAAS_HOST_ROOT` | `docker-compose.yml` (`${PWD}`) | 호스트 현재 디렉토리 |
| `APP_CONTAINER_PREFIX` | `common.sh` | `paas-app` |
| `APP_COMPOSE_FILE` | `common.sh`, `generate-compose.js` | `docker-compose.yml` |
| `APP_SOURCE_SUBDIR` | `common.sh`, `generate-compose.js` | `app` |
| `APP_DATA_SUBDIR` | `common.sh`, `generate-compose.js` | `data` |
| `APP_LOGS_SUBDIR` | `common.sh` | `logs` |
| `DEPLOY_TIMEOUT_SECS` | `common.sh` | `30` |
| `DEPLOY_LOG_TAIL_LINES` | `common.sh` | `120` |

## 12. 디렉토리 구조
```
paas-webapp/
├── portal/
│   ├── server.js          # Express 진입점 + 미들웨어 조립
│   ├── utils.js           # AppError, sendOk/sendError 등 공유 유틸
│   ├── config.js          # 환경변수 로드 + 전역 상수
│   ├── appManager.js      # 앱/Docker/파일시스템 도메인 로직
│   ├── authService.js     # 세션/사용자 인증 (SQLite)
│   ├── package.json
│   ├── README.md
│   ├── routes/
│   │   ├── apps.js        # /apps 라우터
│   │   └── users.js       # /users 라우터 (factory)
│   └── public/
│       ├── index.html
│       ├── app-state.js   # 전역 상수·상태·DOM 참조 (1번 로드)
│       ├── app-utils.js   # 순수 헬퍼, 폼 검증
│       ├── app-render.js  # DOM 렌더링
│       ├── app-ui.js      # 뷰/모달/인증 UI
│       ├── app-exec.js    # Exec 터미널
│       ├── app-api.js     # API 통신·데이터 로딩
│       ├── app.js         # 이벤트 바인딩 + 부트스트랩
│       ├── auth.html
│       ├── auth.js
│       └── styles.css
├── scripts/
│   ├── create.sh
│   ├── deploy.sh
│   ├── delete.sh
│   ├── detect-runtime.js
│   ├── generate-dockerfile.js
│   ├── generate-compose.js
│   └── lib/common.sh
├── apps/            # runtime 데이터
├── portal-data/     # sqlite 데이터
├── docker-compose.yml
├── docker-compose.dev.yml
└── .env.example
```

## 13. Agent 작업 규칙
- API 계약 변경 시 `portal/routes/apps.js`(또는 `routes/users.js`)와 `scripts/*` 인자/검증 규칙을 함께 맞춘다.
- 앱 도메인 로직(파일시스템·Docker)은 `portal/appManager.js`에서만 수정한다. 라우트 핸들러에 인프라 코드를 추가하지 않는다.
- 앱 생성 계약(`appname`, `repoUrl`, `branch`)을 유지한다.
- UI 변경 시 `portal/public/index.html`과 해당 역할의 `app-*.js` 파일을 함께 수정한다.
  - 상태·상수: `app-state.js` / 헬퍼: `app-utils.js` / 렌더링: `app-render.js`
  - 뷰·모달: `app-ui.js` / Exec: `app-exec.js` / API: `app-api.js` / 이벤트: `app.js`
- 프론트엔드 스크립트 로드 순서를 변경하거나 새 파일을 추가할 때는 `index.html`의 `<script>` 순서와 `app-state.js` 상단의 의존성 주석을 함께 갱신한다.
- 컨테이너 실행 변경 시 `scripts/*`, `scripts/generate-compose.js`, `docker-compose.yml`을 함께 검토한다.
- 새로운 경로 상수 추가 시 `.env.example`에 기재하지 않는다. 코드(11.2 표)에서 기본값을 선언하고, 동일한 변수명을 `common.sh` / `generate-compose.js` / `config.js` 중 해당 계층에서 통일한다.
