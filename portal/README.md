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

- Portal을 컨테이너로 띄우는 경우 `bash`와 `docker` CLI가 이미지에 있어야 앱 생성/배포 스크립트가 동작합니다.
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
  - body: `{ appname, repoUrl, branch?, usePrivate?, build? }`
  - `branch` 기본값: `main`
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
- `GET /apps/:userid/:appname/build`
  - 응답: `{ build, repoUrl, branch }`, 기존 빌드 설정이 없으면 `auto`
- `PUT /apps/:userid/:appname/build`
  - body: `{ build }`, 생성과 동일한 네 가지 모드 지원
  - 현재 컨테이너를 재시작하지 않고 설정만 저장하며 다음 재배포부터 적용
  - 앱 소유자 또는 관리자만 사용 가능하며 배포 작업과 같은 앱 단위 큐에서 저장
- `GET /apps/:userid/:appname/dockerfiles`
  - 앱에 저장된 저장소·브랜치와 소유자의 설치 권한으로 루트 파일 조회
- `POST /apps/:userid/:appname/start`
- `POST /apps/:userid/:appname/stop`
- `POST /apps/:userid/:appname/deploy`
- `DELETE /apps/:userid/:appname`
- `GET /apps/:userid/:appname/logs?lines=<n>` (`1..1000`, 기본 120)

### 사용자 관리

- `GET /users`
- `POST /users`
- `DELETE /users/:id`
