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
  - body: `{ appname, repoUrl, branch? }`
  - `branch` 기본값: `main`
- `GET /apps`
- `GET /apps/:userid/:appname`
- `POST /apps/:userid/:appname/start`
- `POST /apps/:userid/:appname/stop`
- `POST /apps/:userid/:appname/deploy`
- `DELETE /apps/:userid/:appname`
- `GET /apps/:userid/:appname/logs?lines=<n>` (`1..1000`, 기본 120)

### 사용자 관리

- `GET /users`
- `POST /users`
- `DELETE /users/:id`
