# GitHub App 셋업 (Private repo 배포)

## 1. GitHub App 생성
1. GitHub → Settings → Developer settings → GitHub Apps → New GitHub App
2. **Repository permissions → Contents: Read-only** (clone에 필요한 최소 권한)
3. **Callback URL**: `https://<포털 외부주소>/github/callback` (이 값은 GitHub App 측 설정이며, 포털 env로는 주입하지 않는다)
4. **"Request user authorization (OAuth) during installation" 체크** (설치 후 code+state를 Callback으로 받기 위함)
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
- 사용자가 포털에서 "GitHub 연결" → App 설치(특정 repo 선택) → 포털로 복귀
- 앱 생성 화면의 드롭다운에서 private repo 선택 → 생성/재배포 시 1시간 만료 토큰으로 clone

## 보안 노트
- PAT를 저장하지 않는다. 토큰은 메모리 캐시(만료 5분 전 갱신)만 한다.
- PEM이 유출되면 모든 설치 토큰 발급이 가능하므로, PEM은 파일/secret로 관리하고 사고 시 GitHub App 설정에서 키를 회전한다.
- (후속) PEM을 KMS로 옮겨 서명 위임 시 env/디스크 유출로도 키 추출 불가.
