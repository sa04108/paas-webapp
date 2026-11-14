# Hyunbbai Portal

Express API와 React + TypeScript 관리 화면이다. 설치·운영·백업은 [루트 README](../README.md), 앱 서비스 구성은 [Compose 앱 안내](../docs/compose-apps.md), 네트워크와 TLS는 [프록시 안내](../docs/proxy-setup.md)를 따른다.

## 개발 실행

Node.js 24.22.1 이상 24.x와 루트 `.env` 설정이 필요하다. Docker 기반 개발 환경은 [Docker 개발 안내](../README.md#local-development-with-docker)를 사용한다. 호스트에서 직접 실행하려면 다음을 수행한다.

```bash
cd portal
npm ci --include=dev
npm run dev
```

`npm run dev`는 최초 타입 검사와 프런트엔드 빌드 후 Express와 Vite 빌드 감시를 실행한다. React 파일 변경은 재빌드 후 브라우저를 새로고침하고, 서버 파일 변경은 Node 감시가 서버를 재시작한다. 기본 주소는 `http://localhost:3000`이다. 직접 실행해도 앱 생명주기 작업에는 Docker 소켓과 Compose·Git·Bash·curl·Railpack 및 BuildKit이 필요하다. 단순 UI 확인과 실제 배포 환경을 구분한다.

`npm start`는 타입 검사와 프런트엔드 빌드 후 Express를 실행한다. `portal/dist/`는 생성물이며 커밋하지 않는다. `npm run dev:client`는 프런트엔드 빌드만 감시한다. 명령과 의존성 기준은 [package.json](package.json)과 잠금 파일이다.

```bash
npm run typecheck
npm run build
npm test
```

## 코드 구성

| 경로 | 역할 |
| --- | --- |
| [client/main.tsx](client/main.tsx), [client/Portal.tsx](client/Portal.tsx) | 인증 화면, React 라우팅, 앱·작업 상태 조회 |
| [client/theme.css](client/theme.css) | 중립색 라이트·다크 테마, 시스템 글꼴, 공통 버튼 스타일 |
| [server.js](server.js) | Express, API 마운트, UI 제공, WebSocket 업그레이드 |
| [config.js](config.js) | 루트 `.env` 또는 `PAAS_ENV_FILE` 로딩과 설정 기본값 |
| [authService.js](authService.js) | SQLite 계정·세션, bcrypt 비밀번호 해시, 관리자 권한 |
| [appManager.js](appManager.js), [routes/apps.js](routes/apps.js) | 앱 메타데이터·Docker 상태, 앱 작업 큐와 API |
| [jobStore.js](jobStore.js), [appReadiness.js](appReadiness.js) | 작업 기록과 재시작 복구, 서비스·도메인 준비 상태 |
| [appLogs.js](appLogs.js), [routes/exec-ws.js](routes/exec-ws.js) | 서비스별 로그 병합·SSE, 터미널 WebSocket |
| [githubService.js](githubService.js), [routes/github.js](routes/github.js) | GitHub OAuth, 설치 연결과 저장소 접근 |
| [proxySetup.js](proxySetup.js), [domainManager.js](domainManager.js) | 앱 프록시 연결, 커스텀 도메인 라우팅 |
| [../scripts/lib/compose-project.js](../scripts/lib/compose-project.js) | 앱 서비스 이미지 준비와 Compose 프로젝트 생명주기 |

`dotenv`는 이미 주입된 환경변수를 덮어쓰지 않는다. 화면과 API는 같은 Express 오리진을 사용한다. HTML은 캐시하지 않고 해시가 포함된 `/assets` 번들은 장기 캐시한다.

## 인증과 API 경로

JSON API는 **`/api` 아래**에 있다. `/health`만 루트의 공개 상태 확인 경로다. UI의 `/apps/:userid/:appname`과 API의 `/api/apps/:userid/:appname`을 구분한다. 응답은 성공 시 `{ ok: true, data }`, 오류 시 `{ ok: false, error }` 형식이다.

| 경로 | 동작·접근 조건 |
| --- | --- |
| `GET /health`, `GET /api/config` | 공개 상태·클라이언트 설정 |
| `POST /api/auth/login`, `GET /api/auth/me`, `POST /api/auth/logout`, `POST /api/auth/change-password` | 로그인과 현재 세션·비밀번호 관리 |
| `/api/apps` | 로그인 사용자의 앱 생성·목록; 관리자는 `GET /api/apps?all=true`로 전체 조회 |
| `/api/apps/:userid/:appname` | 앱 소유자 또는 관리자의 조회·삭제 |
| `POST /api/apps/:userid/:appname/start`, `/stop`, `/deploy` | 앱 전체 서비스의 시작·중지·재배포 |
| `GET/PUT /api/apps/:userid/:appname/env`, `/build`, `/runtime` | 앱 설정 조회·저장 |
| `/api/apps/:userid/:appname/domains` | 앱 커스텀 도메인 관리 |
| `GET /api/apps/:userid/:appname/logs`, `/logs/stream` | 로그 조회·SSE; `lines`와 `services`로 선택 |
| `/api/apps/:userid/:appname/exec/ws` | 세션과 앱 소유권을 검증하는 터미널 WebSocket; `service`로 대상 선택 |
| `/api/jobs` | 현재 사용자의 작업 목록·기록 정리; 개별 ID의 조회·로그·재시도·취소는 소유자 또는 관리자 허용 |
| `/api/github` | 로그인 사용자의 GitHub 연결·설치 선택·저장소 조회 |
| `/api/users` | 관리자 전용 사용자 생성·조회·삭제·승격 |
| `/api/admin/proxy`, `GET /api/admin/portal-logs` | 관리자 전용 프록시 설정·포털 로그 |

보호된 API는 세션과 초기 비밀번호 변경 완료 여부를 검사한다. 개발 모드는 비밀번호 변경 의무를 해제한다. 앱 작업은 일반 사용자도 자기 앱에 수행할 수 있으며 사용자·프록시 관리는 관리자만 수행한다. 개별 요청 필드와 HTTP 메서드는 각 `routes/` 구현을 기준으로 한다.

## 상태와 실시간 갱신

- 앱 상태는 5초, Jobs는 5초(활성 작업이 있으면 1.5초) 간격으로 조회한다. 숨겨진 탭에서는 조회를 멈추고 겹치는 요청을 피한다. 전체 문서를 새로고침하지 않고 React 상태를 갱신한다.
- 앱 로그는 컨테이너별 Docker 로그를 기록 시각으로 병합해 SSE로 전달한다. 여러 서비스 토글, 선택적 타임스탬프, Auto/Refresh 버튼을 지원한다. Jobs의 실행 중 로그도 SSE를 사용한다.
- 빌드·런타임 저장은 다음 재배포부터 적용하며 미적용 변경을 설정 화면과 앱 카드에 표시한다. 환경변수 저장은 앱 서비스 재생성을 수행한다.
- 생성·재배포·시작·환경변수 적용 작업은 초기화 서비스의 성공 종료, 장기 실행 서비스 준비, 할당 도메인의 HTTP 200을 확인한다. 기본 도메인 확인 제한은 120초, 간격은 2초, 요청 제한은 5초이며 빌드 시간은 제외한다. 웹이 응답해도 다른 서비스가 실패하면 `degraded`로 표시할 수 있다.
- 개발 Compose의 readiness 요청은 `http://host.docker.internal:18080`으로 연결하면서 앱 도메인의 Host 헤더를 유지한다. 포털과 개발용 Traefik은 서로 다른 네트워크에 있다.
- 작업 기록·완료 출력·오류는 SQLite에 저장하고 실행 중 로그 버퍼는 메모리에 둔다. 재시작 시 `running` 작업은 `interrupted`, `pending` 작업은 재실행 대상으로 처리한다. 단일 포털 프로세스 기준이며 다중 포털 간 작업 조정은 구현되어 있지 않다.

GitHub 연결의 현재 탭 인증·설치용 새 탭·초안 복원은 [GitHub App 안내](../docs/github-app-setup.md)에 설명되어 있다.
