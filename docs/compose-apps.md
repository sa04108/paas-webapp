# Compose 앱 배포

앱 하나는 Compose 프로젝트 하나다. 웹·워커·초기화 작업은 같은 앱에 속하고 생성·시작·중지·재배포·삭제를 함께 처리한다. 기존 앱의 자동 이관은 제공하지 않는다.

## 설정

앱 생성 및 Settings의 Runtime configuration에서 Single service 또는 Compose를 고른다. Compose는 직접 입력한 YAML 또는 저장소 루트의 YAML 파일을 사용하며 최대 64 KiB다. 저장한 설정은 다음 재배포부터 적용된다. Web service는 도메인으로 연결할 서비스 이름이며 해당 서비스는 `0.0.0.0:5000`에서 응답해야 한다.

API의 `runtime` 형식은 다음과 같다.

```json
{"mode":"compose","source":"repository","file":"compose.yaml","webService":"app"}
```

직접 입력은 `source: "inline"`과 `content: "services: ..."`를 사용한다. `GET/PUT /api/apps/:userid/:appname/runtime`으로 조회·저장한다. 앱 생성의 `runtime` 생략은 단일 `app` 서비스다.

## 서비스별 이미지와 빌드

- `image`: 레지스트리 이미지를 pull해 사용한다.
- `build`: 저장소 안의 `context`, `dockerfile`, 명시적인 `args`, `target`으로 Docker 이미지를 빌드한다. 원격 컨텍스트나 저장소 밖의 파일은 허용하지 않는다. 이미지 태그는 플랫폼이 생성하므로 `image`와 `build`를 동시에 지정하지 않는다.
- 둘 다 생략하거나 `image: ${PAAS_APP_IMAGE}`를 지정하면 앱의 Build settings로 만든 이미지를 공유한다. Railpack 설정은 여기에 적용된다. 모든 서비스가 자체 `image`/`build`를 지정하면 공용 이미지 빌드는 생략한다.

공용 이미지의 Railpack 시작 명령을 서비스의 `command`로 교체하면 Railpack의 `bash -c` 진입점도 함께 해제한다. 따라서 워커의 실행 파일과 인자가 그대로 전달된다. 명시적인 `entrypoint`는 사용자 설정을 따른다.

한 릴리스의 서비스 이미지는 기동 전에 모두 준비한다. 검증·빌드·pull 실패 시 기존 컨테이너는 유지한다. 기동 단계에서는 기존 프로젝트를 내린 뒤 새 구성을 실행하므로 무중단 배포는 제공하지 않는다.

## KTX 구성 예시

웹은 기존 Railpack 설정으로 빌드하고 워커는 저장소의 `Dockerfile.ktx-worker`를 사용한다. 기존 Railpack `startCommand`에서는 마이그레이션을 분리하고 Gunicorn 실행만 남긴다. 필요한 환경변수는 앱의 Environment variables에 등록한다.

```yaml
services:
  migrate:
    image: ${PAAS_APP_IMAGE}
    restart: "no"
    command:
      - sh
      - -ec
      - ': "${SUPABASE_DB_URL:?Set SUPABASE_DB_URL}"; /app/.migration-cli/node_modules/.bin/supabase --workdir /app/.migration-project db push --db-url "$SUPABASE_DB_URL" --yes'
  app:
    image: ${PAAS_APP_IMAGE}
    depends_on:
      migrate:
        condition: service_completed_successfully
  ktx-worker:
    build:
      context: .
      dockerfile: Dockerfile.ktx-worker
    depends_on:
      migrate:
        condition: service_completed_successfully
```

`restart: "no"`는 초기화 작업이다. 종료 코드 0으로 완료해야 배포가 성공하며, 장기 실행 워커에는 사용하지 않는다. 마이그레이션 실패는 의존 서비스의 기동을 막는다. `service_started`는 준비 완료를 뜻하지 않으며 준비 상태가 필요하면 `healthcheck`와 `service_healthy`를 사용한다.

## 허용되는 Compose 범위

서비스의 `image`, `build`, `command`, `entrypoint`, `environment`, `depends_on`, `healthcheck`, `working_dir`, `user`, `restart`, `volumes`, `expose`, `stop_grace_period`, `init`, `mem_limit`, `cpus`, `pids_limit`, `read_only`를 지원한다. 지원하지 않는 키는 무시하지 않고 오류로 반환한다. `environment`와 빌드 인자는 명시적인 값이 있는 매핑만 허용한다. 명령·환경변수의 `$`는 호스트 환경변수로 치환하지 않는다. 셸 명령의 컨테이너 환경변수 확장은 유지한다.

`env_file`, `container_name`, `ports`, `networks`, `labels`, `privileged`, `network_mode`, `devices`, `cap_add`, Compose include/extends 및 임의 호스트 마운트는 사용자 입력으로 받지 않는다. 저장소의 기존 Compose에 해당 설정이 있으면 제거하고 PaaS 설정을 사용해야 한다. 모든 서비스에 앱 환경변수를 주입하며 플랫폼의 앱/서비스 식별자와 웹의 `PORT`가 우선한다. 시크릿을 YAML·Dockerfile·빌드 인자에 직접 기록하지 않는다.

볼륨은 다음처럼 빈 옵션으로 선언한 논리 이름만 허용한다. 실제 데이터는 해당 앱의 `data/<volume>` 안에 저장되고 `--keep-data` 삭제 시 보존된다. 웹의 기본 `/data`는 `data/app`에 연결된다.

```yaml
services:
  app: {}
  worker:
    command: ["python", "worker.py"]
    volumes: ["cache:/cache"]
volumes:
  cache: {}
```

서비스 수는 `MAX_SERVICES_PER_APP`(기본 8)로 제한한다. `DEFAULT_MEM_LIMIT`(기본 256m)과 `DEFAULT_CPU_LIMIT`(기본 0.5)은 **앱 전체 예산**이며 서비스별 제한 합계가 이를 초과하면 거부한다. 미지정 서비스는 남은 예산을 균등하게 나눈다. CPU는 서비스당 최소 0.01이며 PID 상한은 `DEFAULT_PIDS_LIMIT`(기본 128)이다. 초기화 작업도 예산에 포함되므로 KTX처럼 여러 Python/Node 프로세스를 실행하면 관리자가 충분한 앱 예산을 설정해야 한다. 종료 대기 시간은 최대 60초다.

## 소유권과 상태

프로젝트와 컨테이너 이름은 사용자/앱 식별자의 해시로 생성한다. 워커는 앱 전용 네트워크에, 웹은 앱 전용 네트워크와 기존 프록시 네트워크에 연결한다. 외부 도메인은 웹에만 부여한다. 이 구성은 앱 단위 소유권을 제공하며, 웹 컨테이너의 공유 네트워크와 공유 Docker 데몬·호스트 격리 문제는 남아 있다.

앱 목록과 할당량은 컨테이너 수가 아니라 앱 수로 계산하며 실패·중지된 앱도 포함한다. 응답의 `services[]`에 이름·종류·상태·health·종료 코드를 포함한다. 필수 장기 실행 서비스가 정상이고 초기화 작업이 성공했으며 할당 도메인의 `/`가 HTTP 200일 때 `running`이 된다. 웹이 응답해도 워커가 실패하면 `degraded`로 표시한다.

Logs의 기본값은 전체 서비스이며 `?service=<name>`으로 한 서비스를 선택한다. Exec HTTP 본문과 WebSocket 쿼리에 `service`를 전달하며 생략하면 웹 서비스가 기본이다. 서버가 해당 앱의 서비스인지 검증한 뒤 연결하므로 컨테이너 이름을 직접 지정할 수 없다.

## 삭제와 재시도

소스 밖의 `.paas-meta.json`은 저장 설정과 앱 생성 세대를, `.paas-project.json`은 실행 Compose·서비스 목록·현재 상태를 원자적으로 보관한다. `docker-compose.yml`은 실행 상태로부터 복원 가능한 생성 파일이다. 같은 앱의 작업은 순서대로 실행한다. 이전 생성 세대의 작업은 재생성된 앱에 적용하지 않으며, 복구된 앱에서 오래된 생성 작업을 취소해도 앱을 지우지 않는다.

삭제 시 프로젝트의 컨테이너·익명 볼륨·네트워크와 자체 빌드 이미지 태그를 정리한 뒤 잔류 컨테이너·네트워크를 확인한다. 공용 레지스트리 이미지는 지우지 않는다. 정리가 실패하면 `delete-failed`로 표시하고 관리 정보·데이터·작업을 보존한다. Jobs에서 삭제를 재시도할 수 있으며 삭제 완료 전에는 다른 기동 작업을 거부한다. `keepData`는 앱 데이터만 보존한다.
