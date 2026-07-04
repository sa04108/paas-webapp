# CI/CD 배포 구축 계획 — GitHub Actions + Self-hosted Runner

> 2026-07-04 기준 논의 정리. 현재 범위는 **배포(CD)만** 다룬다.

## 1. 결정 사항

| 항목 | 결정 | 비고 |
|---|---|---|
| CI/CD 도구 | GitHub Actions + **self-hosted runner** | 러너를 서버 PC에 직접 설치 |
| 배포 트리거 | `workflow_dispatch` (수동 버튼) | 자동화 필요 시 `push: branches: [main]` 추가 |
| 환경변수 관리 | GitHub Actions **Secrets/Variables** | 배포 시점에 서버의 `.env` 를 덮어씀 |
| sudo 문제 해결 | 러너 계정을 `docker` 그룹에 추가 | 아래 3절 참고 |

### 선택 이유

- Jenkins는 JVM 서버 + 플러그인 생태계를 통째로 띄워야 해서 서버 PC 자원으로 감당이 어려움. self-hosted runner는 단일 에이전트로 유휴 시 메모리 100~150MB 수준.
- 러너가 GitHub 쪽으로 **outbound long-polling** 하므로 서버에 인바운드 포트를 열 필요가 없음 (webhook 방식은 GitHub → 서버 인바운드 노출이 필요).
- 배포 명령이 서버 로컬에서 실행되므로 SSH 키 배포·시크릿 전달 경로가 불필요.
- 배포 로그/이력/수동 실행 버튼을 GitHub UI에서 그대로 사용.

### 전제 조건

- **repo는 반드시 private** 이어야 한다. public repo에 self-hosted runner를 붙이면 fork PR이 서버에서 임의 코드를 실행할 수 있음 (GitHub 공식 경고 사항).

## 2. Private repo 제한 관련 확인 결과

- GitHub Free 플랜의 private repo 제한(월 2,000분 + 스토리지 500MB)은 **GitHub-hosted runner에만 적용**된다. self-hosted runner에서 실행되는 잡은 분 단위 과금·쿼터 소진이 **없음**.
- 스토리지 500MB 쿼터는 artifacts/캐시에만 적용 — 이 배포 플로우는 둘 다 사용하지 않음.
- Repo 단위 **Secrets/Variables는 Free 플랜 private repo에서 제한 없이 사용 가능** (secret당 48KB, repo당 100개 한도).
- Free 플랜 private repo에서 막혀 있는 것은 **Environment protection rules**(배포 승인자, wait timer)뿐 — 현재 플로우에는 불필요.

## 3. sudo 문제 해결

docker compose 실행에 sudo가 요구되는 문제는 CI 도구와 무관하게 서버 쪽에서 해결한다.

**방법 1 — docker 그룹 추가 (채택):**

```bash
sudo usermod -aG docker <러너를 돌릴 계정>
# 재로그인 또는 러너 서비스 재시작 후 적용
```

> docker 그룹은 사실상 root 동등 권한이지만, 어차피 `sudo docker` 를 쓰는 것과 권한 수준이 동일하므로 이 시나리오에서 잃는 것은 없음.

**방법 2 — 범위 제한 NOPASSWD sudoers (대안):**

```
# /etc/sudoers.d/deploy
runner ALL=(root) NOPASSWD: /usr/bin/docker compose *
```

docker CLI 경로가 바뀌면 깨질 수 있어 방법 1을 우선한다.

## 4. 구성 절차

1. 서버 PC에서 러너 설치: repo **Settings → Actions → Runners → New self-hosted runner** 안내대로 진행
2. 재부팅 생존을 위해 서비스 등록:
   ```bash
   sudo ./svc.sh install && sudo ./svc.sh start
   ```
3. 러너 계정을 `docker` 그룹에 추가 (3절)
4. GitHub repo **Settings → Secrets and variables → Actions** 에 환경변수 등록
5. 워크플로 파일 추가 (5절)

## 5. 워크플로 파일

```yaml
# .github/workflows/deploy.yml
name: deploy

on:
  workflow_dispatch:   # 수동 배포 버튼

jobs:
  deploy:
    runs-on: self-hosted
    steps:
      - name: Deploy
        run: |
          cd /path/to/app        # 서버에 이미 clone된 경로 (TODO: 실제 경로로 교체)
          git fetch origin && git reset --hard origin/main

          cat > .env <<EOF
          DB_PASSWORD=${{ secrets.DB_PASSWORD }}
          API_KEY=${{ secrets.API_KEY }}
          EOF

          docker compose up -d --build
```

설계 노트:

- **`actions/checkout` 을 쓰지 않는다.** 러너 작업 디렉토리에 새로 checkout하는 대신, 볼륨 경로 등이 걸려 있는 기존 clone 위치에서 배포한다.
- **`git pull --rebase` 대신 `git fetch && git reset --hard origin/main`.** 서버 clone은 사람이 수정할 일이 없으므로, 로컬 변경으로 rebase가 충돌·중단되는 경로를 없애고 무조건 원격 상태로 수렴시킨다.
- **`docker compose down` 을 생략하고 `up -d --build` 만 실행.** down은 전체 다운타임을 만들고 네트워크까지 지우므로, 같은 네트워크에 붙어 있는 Traefik 등 다른 컨테이너에 영향을 줄 수 있음. `up -d` 는 변경된 서비스만 재생성한다.
- **`.env` 는 배포 때마다 GitHub 기준으로 덮어써진다.** 환경변수의 원본은 GitHub Secrets에만 존재. 서버 디스크에 남기기 싫다면 워크플로 `env:` 블록 + compose `environment:` 직주입 방식도 가능하나, 파일 방식이 디버깅에 유리.

## 6. 운영 시 주의사항

- Self-hosted runner는 **14일 이상 오프라인이면 GitHub에서 자동 제거**된다. 서비스 등록 상태면 상시 연결이라 문제없으나, 서버를 장기간 꺼둘 경우 재등록이 필요할 수 있음.
- repo에 **write 권한이 있는 사람은 워크플로 수정으로 secrets를 읽어낼 수 있다.** 협업자 추가 = 서버 배포 권한 부여와 동일하다는 점을 인지할 것.
