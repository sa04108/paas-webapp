# Hyunbbai Portal

Express 기반 Portal API + 관리 대시보드입니다.

## 로컬 실행

```bash
cd portal
npm install
npm start
```

- 기본 주소: `http://localhost:3000`
- 기본 관리자 계정: `admin / admin` (첫 로그인 후 비밀번호 변경 필수)
- `.env`가 있으면 루트(`../.env`) 값을 우선 로드합니다.
- UI 라우트: `/auth`(로그인), `/`(대시보드, 미로그인 시 `/auth`로 리다이렉트)
- 호스트 분기: 루트 도메인(`{PAAS_DOMAIN}`)은 랜딩 페이지(`public/landing/`), 포털 UI는 `portal.{PAAS_DOMAIN}`에서 서빙됩니다.
  dev에서도 동일합니다 — 랜딩: `http://localhost:3000`, 포털: `http://portal.localhost:3000`

## 컨테이너 실행

- Portal을 컨테이너로 띄우는 경우 `bash`, `docker`, `curl` CLI가 이미지에 있어야 앱 생성/배포 및 도메인 준비 상태 검사가 동작합니다.
- 이 저장소의 루트 `docker-compose.yml`은 `dockerfile_inline`으로 해당 도구를 함께 설치합니다.
- 앱 컨테이너 제어를 위해 `/var/run/docker.sock` 마운트가 필요합니다.

## 인증/권한

- 인증은 세션 쿠키를 사용합니다.
- `/apps`, `/users`는 로그인 + admin 권한 + 비밀번호 변경 완료 상태가 필요합니다.

## API

### 공용
- `GET /health`
- `GET /config`

### 인증
- `POST /auth/login`
- `GET /auth/me`
- `POST /auth/logout`
- `POST /auth/change-password`

### 앱 관리

- `POST /apps`
  - body: `{ appname, repoUrl, branch?, usePrivate?, build?, runtime?, env? }`
  - `branch` 기본값: `main`
  - `env`: 선택 입력인 `.env` 형식 문자열. 한 줄에 `KEY=VALUE` 하나씩, UTF-8 기준 최대 64 KiB (빈 줄·주석·인용부호 지원)
  - 환경변수는 최초 컨테이너 실행부터 적용되고 재배포에도 유지됩니다. 빌드 인자로 전달하지 않으며 `PORT`, `APP_ID`, `NODE_ENV`는 플랫폼 값이 우선합니다.
  - 입력의 `$`는 호스트 환경변수로 치환하지 않고 리터럴로 저장합니다. 작업 조회 응답에는 포함하지 않으며, 실패·중단 작업의 재시도에도 사용합니다.
  - `build` 생략 또는 `{ mode: "auto" }`: 기존 루트 Dockerfile 자동 탐지 후, 후보가 없으면 Railpack 사용
  - `{ mode: "repository", dockerfile: "Dockerfile.web" }`: 이름에 `Dockerfile`이 포함된 루트 파일을 명시적으로 선택
  - `{ mode: "custom", content: "FROM ..." }`: UTF-8 기준 최대 64 KiB의 Dockerfile 본문 사용
  - `{ mode: "railpack", config: "" }`: Dockerfile 존재 여부와 관계없이 별도 설정 주입 없이 Railpack 실행
  - `{ mode: "railpack", config: "{\"provider\":\"python\"}" }`: 최대 64 KiB의 JSON 객체를 서버 설정 파일로 전달
  - 빌드 설정은 소스 밖의 `.paas-meta.json`에 저장소 정보와 함께 저장되며 재배포 때도 유지
- `POST /apps/dockerfiles`
  - body: `{ repoUrl, branch?, usePrivate? }`
  - 선택한 브랜치의 GitHub 루트에서 이름에 `Dockerfile`이 포함된 파일만 조회
  - 응답: `{ files: ["Dockerfile", "Dockerfile.web"], branch: "main" }` (`data` 안에 포함)
  - 비공개 저장소는 로그인 사용자의 GitHub App 설치 권한 사용
- `GET /apps`
- `GET /apps/:userid/:appname`
- `GET/PUT /apps/:userid/:appname/runtime`: Compose 서비스 설정 조회·저장. 다음 재배포부터 적용
- 서비스별 이미지·Dockerfile·공용 Railpack 이미지, 초기화 작업, 소유권·삭제 정책은 [Compose 앱 배포](../docs/compose-apps.md) 참고
- `GET /apps/:userid/:appname/build`
  - 응답: `{ build, repoUrl, branch, redeployRequired, pendingConfigChanges }`, 기존 빌드 설정이 없으면 `auto`
- `PUT /apps/:userid/:appname/build`
  - body: `{ build }`, 생성과 동일한 네 가지 모드 지원
  - 현재 컨테이너를 재시작하지 않고 설정만 저장하며 다음 재배포부터 적용
  - 앱 소유자 또는 관리자만 사용 가능하며 배포 작업과 같은 앱 단위 큐에서 저장
- 앱 조회와 빌드·런타임 설정 조회/저장 응답의 `redeployRequired`는 마지막 성공 배포와 저장된 설정이 다른지 나타냅니다. `pendingConfigChanges`의 `build`·`runtime`으로 항목별 변경 여부를 제공하며 비교 해시는 응답에 포함하지 않습니다.
- 설정 화면의 저장 버튼 아래와 앱 카드에 재배포 안내가 표시됩니다. 같은 값 저장·배포한 값으로 되돌리기는 불필요한 안내를 만들지 않고, 새로고침·중지/시작·환경변수 재시작 후에도 미적용 변경을 유지합니다. 포털의 생성·재배포에서 서비스 준비 및 도메인 HTTP 200 확인이 끝나야 적용 완료로 기록합니다.
- `GET /apps/:userid/:appname/dockerfiles`
  - 앱에 저장된 저장소·브랜치와 소유자의 설치 권한으로 루트 파일 조회
- `POST /apps/:userid/:appname/start`
- `POST /apps/:userid/:appname/stop`
- `POST /apps/:userid/:appname/deploy`
- `DELETE /apps/:userid/:appname`
- `GET /apps/:userid/:appname/logs?lines=<n>&services=app,worker` (`1..1000`, 기본 120, 병합된 전체 로그의 줄 수)
  - `entries`에 `{id, timestamp, service, stream, message}`, `services`에 서비스 이름 목록, `warnings`에 수집 오류를 반환합니다.
  - `services` 생략 시 전체, 빈 값이면 선택 없음입니다. 한 서비스 조회에는 기존 `service=<name>`도 사용할 수 있습니다.
- `GET /apps/:userid/:appname/logs/stream` (같은 쿼리, SSE)
  - 최초 `snapshot`, 이후 `entries`, 서비스 목록 변경 시 `services`, 오류 시 `warning` 또는 종료를 알리는 `end` 이벤트를 JSON `data`로 전송합니다.
  - 앱 로그 화면은 서비스 토글로 여러 서비스를 선택하고 Live/Pause로 실시간 수신을 제어합니다. 타임스탬프 표시는 기본으로 꺼져 있습니다.
- Exec HTTP 본문과 WebSocket 쿼리의 `service`로 앱 내부 서비스를 선택하며 생략하면 웹 서비스

### 앱 준비 상태

- Portal의 생성·재배포·시작·환경변수 변경 후 재시작 작업은 초기화 서비스의 종료 코드 0, 장기 실행 서비스의 정상 상태, 할당 도메인의 `/`에서 HTTP **200**을 모두 확인한 뒤 완료됩니다. 프로덕션은 HTTPS 인증서를 검증하고, 개발 모드는 HTTP와 `TRAEFIK_HOST_PORT`를 사용합니다. 다른 도메인으로의 리다이렉트는 따라가지 않습니다.
- Docker 컨테이너가 실행 중이어도 검사 전에는 `starting`, 확인 제한 시간 이후에는 `unhealthy`, HTTP 200 확인 후에는 `running`으로 표시합니다. 컨테이너의 `stopped`·`restarting` 상태가 우선합니다.
- 기본 제한 시간은 120초(`APP_HEALTH_TIMEOUT_SECS`), 검사 간격은 2초(`APP_HEALTH_INTERVAL_MS=2000`), 요청별 제한 시간은 5초(`APP_HEALTH_REQUEST_TIMEOUT_MS=5000`)입니다. 빌드 시간은 준비 상태 제한 시간에 포함하지 않습니다.
- 제한 시간 초과는 작업 실패로 기록되며 Jobs 로그에서 검사 결과를 볼 수 있습니다. 이후에도 앱 목록을 조회하면 `unhealthy` 앱을 재검사하므로 늦게 HTTP 200이 반환되어도 `running`으로 전환됩니다. 대시보드와 관리자 목록은 준비 중이거나 비정상인 앱의 상태를 자동 갱신합니다.
- HTTP 준비 상태는 SQLite에 저장됩니다. Portal이 검사 중 재시작되면 성공으로 간주하지 않고 재검사하며, 새 배포는 이전 검사 결과를 초기화합니다. HTTP 검사는 배포 직후에 수행합니다. 서비스 컨테이너 상태는 앱 조회마다 갱신하고, 다중 서비스 앱은 화면이 활성 상태일 때 주기적으로 조회합니다. 워커 장애는 웹의 HTTP 200과 별개로 `degraded`로 표시합니다.
- `docker-compose.dev.yml`은 `APP_HEALTH_DEV_ORIGIN=http://traefik:80`을 지정합니다. Portal 컨테이너 내부에서도 앱 도메인의 Host 헤더를 유지한 채 개발용 Traefik에 접속합니다.

### 사용자 관리

- `GET /users`
- `POST /users`
- `DELETE /users/:id`
