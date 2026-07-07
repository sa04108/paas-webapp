# PaaS 보안 위협 정리

- **작성일**: 2026-07-07
- **검토 계기**: "App Exec(= `docker exec`) 기능으로 다른 사용자 앱 접근·변조 또는 서버 자원 침투가 가능한가?" 라는 질문에서 출발한 아키텍처 보안 검토.
- **범위**: 앱 컨테이너 격리, App Exec(WS) 권한 경계, 컨테이너 간/컨트롤 플레인 네트워크 토폴로지, BuildKit 노출.
- **상태 범례**: ✅ 조치 완료 · 🟡 부분 조치 · ⬜ 미조치

> 이 문서는 살아있는(living) 문서다. 조치가 진행되면 각 위협의 **상태**와 6·7절 로드맵을 갱신한다.

---

## 1. 요약

| ID | 위협 | 심각도 | 상태 |
|----|------|:---:|:---:|
| [T-01](#t-01--무인증-privileged-buildkit-노출) | 무인증 privileged BuildKit이 테넌트 네트워크에 노출 | 🔴 Critical | ✅ 조치 완료 |
| [T-02](#t-02--평면-공유-네트워크-테넌트-격리-부재) | 평면 공유 네트워크(`paas-app`) — 테넌트/컨트롤 플레인 미격리 | 🟠 High | 🟡 부분 조치 |
| [T-03](#t-03--앱-컨테이너-root--full-caps--권한상승-허용) | 앱 컨테이너 root 실행 + full capabilities + no-new-privileges 미적용 | 🟡 Medium | ⬜ 미조치 |
| [T-04](#t-04--자원-고갈-dos) | 자원 고갈 DoS (pids/디스크 쿼터 부재) | 🟡 Medium | ⬜ 미조치 |
| [T-05](#t-05--사용자명-대소문자-불일치) | 소유권 게이트(대소문자 구분) vs 앱 조회(대소문자 무시) 불일치 | ⚪ Low | ⬜ 미조치 |
| [T-06](#t-06--세션-타임아웃--감사-로깅-공백) | exec 세션 idle 타임아웃 부재 + 명령 감사 로깅 공백 | ⚪ Low | ⬜ 미조치 |

**핵심 결론**: App Exec 자체의 네임스페이스 격리(파일시스템·프로세스)와 소유권 게이트는 유효하다. 그러나 문제는 컨테이너 *바깥*의 네트워크 토폴로지와 BuildKit 노출에 있었다. 가장 치명적이던 T-01은 이번에 폐쇄했고, 나머지는 "선(先) 침해 후 피벗" 또는 "테넌트 간 직접 접근" 형태로 남아 있다.

---

## 2. 신뢰 경계와 현재 아키텍처

- **테넌트(사용자 앱) 컨테이너**: `paas-app-{userid}-{appname}`. 사용자 소스로 빌드된 이미지가 도는, **신뢰할 수 없는(untrusted)** 실행 환경.
- **컨트롤 플레인**: `paas-portal`(관제·Docker 제어·시크릿 보유), `paas-proxy`(Traefik), `paas-buildkit`(빌드 데몬).
- **App Exec**: 포털이 `dockerode`로 대상 컨테이너에 TTY exec을 생성하고 WebSocket으로 relay. WS 업그레이드 + 소유권 검증을 포털이 수행.

신뢰 경계의 원칙: **테넌트 컨테이너에서 컨트롤 플레인이나 다른 테넌트로 가는 경로는 모두 차단**되어야 한다. 아래 위협들은 이 원칙이 깨지는 지점들이다.

---

## 3. 잘 보호되고 있는 부분 (회귀 방지 목적으로 명시)

- **App Exec 소유권 게이트**: [`portal/routes/exec-ws.js`](../portal/routes/exec-ws.js) — URL의 `userid`가 세션 사용자명과 일치하거나 admin이어야만 세션 생성. IDOR로 타인 앱 셸을 여는 경로 없음.
- **이중 인증**: HTTP 업그레이드 단계([`portal/server.js`](../portal/server.js))와 WS 핸들러 단계 양쪽에서 세션 검증.
- **앱 컨테이너에 docker.sock 미마운트**: [`scripts/generate-compose.js`](../scripts/generate-compose.js)는 `./data:/data`만 마운트. 컨테이너에서 Docker를 직접 조종하는 정공법은 차단됨.
- **입력 검증**: userid/appname 정규식 검증, repoUrl 스킴 검증([`scripts/lib/common.sh`](../scripts/lib/common.sh)).
- **기본 seccomp**: Docker 기본 seccomp 프로파일이 위험 syscall을 차단 중(다만 추가 강화는 없음 → T-03).

---

## 4. 위협 상세

### T-01 · 무인증 privileged BuildKit 노출
- **심각도**: 🔴 Critical · **상태**: ✅ 조치 완료 (2026-07-07)
- **설명**: BuildKit 데몬이 `privileged: true`로 실행되면서 `--addr=tcp://0.0.0.0:1234`로 **인증·TLS 없이** 테넌트와 공유하는 `paas-app` 네트워크에 리슨하고 있었다.
- **공격 시나리오**: 앱을 가진 임의 사용자가 자기 App Exec 셸에서 `paas-buildkit:1234`에 직접 접속 → (1) 모든 테넌트가 공유하는 빌드 캐시 오염(다른 사용자 이미지에 악성 레이어 주입, 공급망식 침해), (2) 리소스 남용/캐시 삭제 DoS, (3) privileged 데몬 특성상 호스트 경계 침해로 확장 가능.
- **영향**: 앱 하나만 있으면 누구나 도달 → 크로스 테넌트 침해 및 호스트 장악 가능성.
- **조치**: TCP 리스너 제거(unix 소켓만 유지), BuildKit을 `paas-app`에서 분리해 egress 전용 `paas-buildkit-net`으로 이동, 포털은 공유 볼륨(`buildkit-sock`)의 unix 소켓으로만 접속. 상세는 [5절](#5-적용된-조치-t-01).
- **관련 파일**: [`docker-compose.yml`](../docker-compose.yml)

### T-02 · 평면 공유 네트워크 (테넌트 격리 부재)
- **심각도**: 🟠 High · **상태**: 🟡 부분 조치
- **설명**: 모든 사용자 앱 + 포털 + Traefik이 단일 `paas-app` 네트워크에 있고 ICC(컨테이너 간 통신)가 켜져 있다. 컨테이너명은 `paas-app-{userid}-{appname}`으로 **예측·열거 가능**.
- **공격 시나리오**:
  - **테넌트 → 테넌트**: `curl http://paas-app-<타인id>-<앱>:5000/` 로 Traefik의 Host 라우팅을 우회해 **다른 사용자 앱 컨테이너에 직접 접근**. "내 도메인으로만 들어온다"고 가정한 내부 엔드포인트·DB 노출.
  - **테넌트 → 컨트롤 플레인**: `paas-portal:3000` 직접 도달 → 포털 공격 표면이 인터넷이 아닌 테넌트 컨테이너 안에서 열림(T-03·잔여위험 B의 전제).
- **영향**: 사용자가 최초 우려한 "다른 사용자 앱 접근"의 실제 경로. 여전히 열려 있음.
- **현재까지 조치**: BuildKit만 `paas-app`에서 분리(T-01). **테넌트↔테넌트, 테넌트→포털 경로는 미해결.**
- **주의**: 단순히 `paas-app`에 `enable_icc=false`를 걸면 Traefik→앱 통신까지 끊겨 라우팅이 깨진다. 올바른 해법은 **앱별 개별 네트워크 + Traefik만 각 네트워크의 공유 노드**로 두는 구조.
- **관련 파일**: [`docker-compose.yml`](../docker-compose.yml), [`scripts/generate-compose.js`](../scripts/generate-compose.js)

### T-03 · 앱 컨테이너 root + full caps + 권한상승 허용
- **심각도**: 🟡 Medium · **상태**: ⬜ 미조치
- **설명**: 생성되는 앱 컨테이너에 `user:`(비-root), `cap_drop`, `security_opt: no-new-privileges`, `read_only`가 전혀 없다. 게다가 App Exec은 명시적으로 `User: "root"`로 셸을 연다.
- **공격 시나리오**: 컨테이너 내 root + 풀 capability(CAP_NET_RAW 등)는 커널/런타임 취약점(예: runc CVE-2019-5736, CVE-2024-21626, 각종 커널 LPE) 익스플로잇의 전제 조건을 충족시켜 **컨테이너 탈출 표면을 크게 넓힌다**. no-new-privileges 미적용으로 컨테이너 내부 setuid 권한상승도 허용.
- **영향**: 탈출 성공 시 호스트 root(userns-remap 없으므로 컨테이너 root = 호스트 uid 0) → 전체 장악. 잔여 위험 A의 뿌리.
- **완화 방안**: `cap_drop: [ALL]` + 최소 `cap_add`, `security_opt: [no-new-privileges:true]`, 비-root `user:`, `read_only: true` + tmpfs, 데몬 레벨 userns-remap.
- **관련 파일**: [`scripts/generate-compose.js`](../scripts/generate-compose.js), [`portal/routes/exec-ws.js`](../portal/routes/exec-ws.js)

### T-04 · 자원 고갈 DoS
- **심각도**: 🟡 Medium · **상태**: ⬜ 미조치
- **설명**: `mem_limit`(256m)·`cpus`(0.5)는 있으나 `pids_limit`(포크 폭탄)과 `/data`·쓰기 레이어의 **디스크 쿼터**가 없다.
- **공격 시나리오**: 한 테넌트가 포크 폭탄으로 PID를 고갈시키거나 디스크를 가득 채워 **호스트 전체와 다른 테넌트를 마비**시킴.
- **완화 방안**: `pids_limit` 설정, `/data` 볼륨 디스크 쿼터(또는 별도 볼륨 + quota), `ulimits` 지정.
- **관련 파일**: [`scripts/generate-compose.js`](../scripts/generate-compose.js)

### T-05 · 사용자명 대소문자 불일치
- **심각도**: ⚪ Low · **상태**: ⬜ 미조치
- **설명**: 소유권 게이트는 대소문자 구분 정확 비교(`user.username !== userid`)인데, 앱 조회 [`findDockerApp`](../portal/appManager.js)는 `toLowerCase()`로 비교한다.
- **공격 시나리오**: 회원가입이 대소문자만 다른 중복 아이디(`alice`/`Alice`)를 허용한다면 교차 접근 여지가 생김.
- **완화 방안**: 사용자명 유일성을 **case-insensitive**로 강제(가입 시 정규화), 또는 게이트/조회의 대소문자 정책을 일치시킴.
- **관련 파일**: [`portal/authService.js`](../portal/authService.js), [`portal/appManager.js`](../portal/appManager.js), [`portal/routes/exec-ws.js`](../portal/routes/exec-ws.js)

### T-06 · 세션 타임아웃 · 감사 로깅 공백
- **심각도**: ⚪ Low · **상태**: ⬜ 미조치
- **설명**: exec WS는 죽은 연결 정리용 heartbeat만 있고 **살아있는 셸의 idle 타임아웃이 없다.** 세션 시작/종료만 `console.log`로 남고 명령 감사 기록은 없다(raw PTY라 명령 로깅 난이도는 있음).
- **완화 방안**: idle 타임아웃 도입, 세션 메타(사용자·앱·시각) 구조화 로깅, 필요 시 세션 녹화/입력 감사 검토.
- **관련 파일**: [`portal/routes/exec-ws.js`](../portal/routes/exec-ws.js)

---

## 5. 적용된 조치 (T-01)

BuildKit을 테넌트로부터 완전히 분리했다. TCP 리스너를 방화벽으로 덮는 땜질이 아니라 **리스너 자체를 제거**하고 통신을 호스트 내부 unix 소켓으로 좁힌 구조적 해결이다.

| 항목 | 변경 전 | 변경 후 |
|---|---|---|
| BuildKit 리스너 | `tcp://0.0.0.0:1234` + unix | **unix 소켓만** |
| BuildKit 네트워크 | `paas-app` (테넌트와 공유) | **`paas-buildkit-net`** (egress 전용, 격리) |
| portal→BuildKit 접속 | `BUILDKIT_HOST=tcp://buildkit:1234` | `unix:///run/buildkit/buildkitd.sock` (공유 볼륨) |
| 신규 자원 | — | 볼륨 `buildkit-sock`, 네트워크 `paas-buildkit-net`, portal `depends_on: buildkit` |

- **효과**: 앱 컨테이너 입장에서 BuildKit으로 가는 네트워크 경로(리스너 자체 소멸)와 파일시스템 경로(소켓 볼륨은 buildkit·portal에만 마운트)가 **동시에 사라졌다.** 정상 exec으로는 직접 도달 불가.
- **검증 상태**:
  - ✅ `docker compose config` (prod / dev 병합) 문법 검증 통과.
  - ⬜ **E2E 미검증**: railpack가 `unix://` `BUILDKIT_HOST`로 실제 빌드에 성공하는지는 Linux 호스트에서 앱 생성으로 확인 필요(개발 머신이 Windows라 이 자리에서 불가).
- **참고 가정**: BuildKit 소켓은 `root:root 0660`, 포털이 root라 접근 가능. 포털을 비-root로 전환 시 buildkitd에 `--group` 부여 필요.

---

## 6. 잔여 위험 (T-01 조치 이후에도 남는 것)

이번 수정은 "exec → BuildKit 직접 경로"를 닫았다. 남는 위험은 모두 **다른 것을 먼저 침해한 뒤** 도달하는 간접 경로이거나, T-02의 미해결분이다.

### A. 컨테이너 탈출 → 호스트 → 전부
- 앱 컨테이너가 root + full caps + no-new-privileges 미적용(T-03)이라 커널/런타임 익스플로잇으로 호스트 탈출 표면이 넓다.
- 탈출 성공 시: 호스트의 BuildKit 소켓(`/var/lib/docker/volumes/<project>_buildkit-sock/_data/buildkitd.sock`), 호스트 `docker.sock`(→ `--privileged -v /:/host`로 전체 FS), 모든 테넌트 볼륨, 포털 `.env` 시크릿 접근. **사실상 게임 오버.**
- → **T-03 조치가 이 위험의 직접적 완화책.**

### B. 포털 침해 → 피벗 (탈출 없이 성립)
- 포털은 여전히 `paas-app`에 있어 테넌트가 `paas-portal:3000`에 네트워크로 도달 가능(T-02).
- 포털이 쥔 것: `docker.sock`(rw, = 호스트 장악), `buildkit-sock`, 리포+`.env` 시크릿, 인증 DB.
- **테넌트는 이미 인증된 사용자** → pre-auth뿐 아니라 **모든 인증된 엔드포인트가 공격 표면**. 특히 exec/env 기록/create·deploy 러너(예: `create.sh`의 `BRANCH`는 검증 없이 `git clone --branch`로 전달 — 인자 인젝션 표면) 감사 필요.
- → 완화: **포털을 테넌트 네트워크에서 분리**(Traefik 전용 네트워크), `docker.sock` 프록시화, 시크릿 범위 축소.

### C. 평면 네트워크 잔재 (T-02 미해결분)
- BuildKit만 빠졌을 뿐 `paas-app`의 ICC는 그대로 → **테넌트↔테넌트 직접 접근**과 **테넌트→포털** 경로가 아직 열려 있음.
- → 완화: 앱별 개별 네트워크 격리(Traefik만 공유 노드).

---

## 7. 개선 로드맵 (우선순위)

1. ⬜ **앱 컨테이너 하드닝** (T-03, 잔여위험 A) — `cap_drop`/`no-new-privileges`/비-root/`pids_limit`를 [`generate-compose.js`](../scripts/generate-compose.js) 기본값으로. 탈출 표면 축소로 효과 범위가 가장 넓음. (여력 시 userns-remap)
2. ⬜ **포털 네트워크 분리** (잔여위험 B·C의 공통 뿌리) — 포털을 `paas-app`에서 빼 Traefik 전용 네트워크로.
3. ⬜ **앱별 네트워크 격리** (T-02) — 테넌트↔테넌트 차단. 손이 많이 가지만 "다른 사용자 앱 접근"을 근본 차단.
4. ⬜ **자원 쿼터** (T-04) — pids/디스크.
5. ⬜ **`docker.sock` 최소권한화** — `docker-socket-proxy` 등으로 포털의 Docker API 화이트리스트.
6. ⬜ **부차 항목** (T-05 사용자명 정규화, T-06 세션 타임아웃/감사).
7. ✅ ~~BuildKit 격리 (T-01)~~ — 완료, E2E 검증만 남음.

---

## 8. 검증 체크리스트

- [ ] Linux 호스트에서 `docker compose up -d` 후 테스트 앱(Dockerfile 없는 repo → railpack 경로) 생성 → **unix 소켓 빌드 성공 확인** (T-01 E2E).
- [ ] 테넌트 App Exec 셸에서 `nc -zv paas-buildkit 1234` **실패** 확인 (T-01 회귀 방지).
- [ ] 테넌트 셸에서 다른 앱(`paas-app-<타인id>-<앱>:<port>`) 접근 시도 → 조치 후 **차단** 확인 (T-02).
- [ ] 테넌트 셸에서 `paas-portal:3000` 접근 시도 → 조치 후 **차단** 확인 (잔여위험 B/C).
- [ ] 앱 컨테이너 `capsh --print` / `id`로 비-root·최소 capability 확인 (T-03).
- [ ] 회원가입에서 대소문자만 다른 중복 아이디 생성 시도 → **거부** 확인 (T-05).
