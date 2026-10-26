# GitHub App 셋업 (Private repo 배포)

## 1. GitHub App 생성
1. GitHub → Settings → Developer settings → GitHub Apps → New GitHub App
2. **Repository permissions → Contents: Read-only** (clone에 필요한 최소 권한)
3. **Callback URL**: `https://portal.<루트도메인>/api/github/callback` (이 값은 GitHub App 측 설정이며, 포털 env로는 주입하지 않는다)
4. **"Request user authorization (OAuth) during installation" 체크** (설치 후 포털 복귀를 위한 설정이며, 기존 설치 연결은 별도의 사용자 OAuth 인증으로 시작한다)
5. **Webhook**: 본 버전은 미사용 (체크 해제 가능)
6. Where can this app be installed: 필요에 따라 Only on this account / Any account
7. 생성 후: **App ID**, **App slug**(URL의 이름), **Client ID**, **Client secret(생성)**, **Private key(.pem)** 다운로드

## 2. 포털 환경변수
- `GITHUB_APP_ID` = App ID
- `GITHUB_APP_SLUG` = App slug
- `GITHUB_APP_CLIENT_ID` = Client ID
- `GITHUB_APP_CLIENT_SECRET` = Client secret
- `GITHUB_APP_PRIVATE_KEY_PATH` = 마운트한 .pem 경로 (권장: docker secret)
- `GITHUB_STATE_SECRET` = `openssl rand -base64 32`

## 3. 동작
- 사용자가 포털에서 **Connect GitHub** → 현재 탭에서 GitHub 사용자 OAuth 인증 → 포털 복귀 후 접근 가능한 해당 App의 설치 목록 조회
- 기존 설치가 하나면 바로 연결하고, 여러 개면 개인·조직 계정을 선택한다. OAuth 콜백에 `installation_id`가 없어도 연결할 수 있다.
- 설치가 없으면 포털에 설치 안내를 표시한다. 이때 **Install GitHub App**만 새 탭으로 열리며 **Connect GitHub**와 **Restart GitHub connection**은 현재 탭을 사용한다. 설치 후 원래 포털 탭으로 돌아오면 자동 재조회하며 **Check connection**으로 다시 확인할 수도 있다. 조직 관리자 승인이 필요한 설치 요청은 승인된 뒤 다시 확인한다.
- 현재 탭에서 인증하기 전에 앱 생성 폼을 서버 메모리에 임시 보관하고, 인증 후 일회성으로 복원한다. 환경변수·빌드·런타임 설정도 함께 복원하며 브라우저 localStorage/sessionStorage나 DB에 초안을 저장하지 않는다. 초안은 허용 필드만 보관하고 최대 256 KiB로 제한한다.
- **Disconnect**는 포털 연결만 해제하며 GitHub App 설치를 삭제하지 않는다. 이후 **Connect GitHub**로 재설치 없이 다시 연결할 수 있다.
- 앱 생성 화면의 드롭다운에서 private repo 선택 → 생성/재배포 시 1시간 만료 토큰으로 clone

인증 중 임시 연결 정보와 사용자 OAuth 토큰은 10분 만료 정책으로 포털 프로세스 메모리에만 유지하고, 브라우저에는 HttpOnly 쿠키로 임시 연결을 식별한다. 사용자 토큰은 연결 완료·해제·만료 시 제거하고, 완료된 연결의 초안만 복원 또는 만료될 때까지 유지한다. 초안 복원 API도 현재 포털의 출처·사용자·임시 쿠키를 확인한다. 인증 도중 포털이 재시작되거나 임시 연결이 만료되면 초안도 사라지므로 **Restart GitHub connection** 또는 **Connect GitHub**로 다시 시작한다. 동시 인증을 여러 포털 프로세스가 처리하는 구성에는 임시 연결 저장소 공유가 추가로 필요하다.

기존 환경변수와 Callback URL은 그대로 사용한다. OAuth `state`, 임시 쿠키, 현재 포털 사용자, GitHub API가 확인한 설치 접근 권한을 검증한 뒤 연결 정보를 저장한다. 계정 선택 시에도 설치 접근 권한을 다시 확인한다.

공식 참고: [GitHub App 사용자 토큰 발급](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app), [사용자 인증 Callback URL](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-user-authorization-callback-url).

## 보안 노트
- PAT를 저장하지 않는다. 토큰은 메모리 캐시(만료 5분 전 갱신)만 한다.
- PEM이 유출되면 모든 설치 토큰 발급이 가능하므로, PEM은 파일/secret로 관리하고 사고 시 GitHub App 설정에서 키를 회전한다.
- (후속) PEM을 KMS로 옮겨 서명 위임 시 env/디스크 유출로도 키 추출 불가.
