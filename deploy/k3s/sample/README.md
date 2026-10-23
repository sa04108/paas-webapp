# k3s 앱 배포 샘플

하나의 앱에 속한 웹, 워커, 일회성 준비 작업을 Kubernetes에서 함께 관리하는 실습입니다. 현재 포털의 Docker Compose 런타임은 변경하지 않습니다. 계정·앱 메타데이터 공유, 포털의 Kubernetes API 연동, 실제 DB 마이그레이션은 후속 구현입니다.

## 구성

| 리소스 | 역할 |
| --- | --- |
| Namespace `paas-sample` | 이 샘플 앱의 리소스와 삭제 범위 |
| Job `prepare-*` | 배포 전 준비 작업. 성공한 뒤에만 웹·워커 배포 진행 |
| Deployment `web` | HTTP 웹 서버 2개. readiness probe와 rolling update 사용 |
| Service `web` | 웹 Pod 앞의 내부 주소 `http://web:5000` |
| Deployment `worker` | 내부 웹 주소를 주기적으로 호출하는 워커 1개 |
| ConfigMap `app-config` | 앱 이름, 워커 실행 간격 |
| Secret `app-secrets` | 최초 배포 시 생성하는 데모 토큰 |
| ServiceAccount / ResourceQuota | API 토큰 자동 마운트 차단 / 앱 리소스 사용량 제한 |

Job은 환경변수가 있는지 확인하고 종료하는 모의 작업입니다. 테이블을 생성하거나 실제 DB에 접속하지 않습니다. 웹·워커·Job은 모두 공개 이미지 `busybox:1.37.0`을 사용하며 각 manifest의 `image`는 독립적으로 변경할 수 있습니다. Dockerfile 빌드와 레지스트리 push는 이 샘플에 포함하지 않습니다.

```text
sample/
├── bootstrap/          # Namespace, 설정, ServiceAccount, 할당량
├── migration.yaml      # 매 실행마다 새 이름을 받는 Job
├── runtime/            # 웹·워커 Deployment와 웹 Service
├── ingress.example.yaml
├── common.sh
├── deploy.sh
└── delete.sh
```

## 준비

- 실습용 k3s 클러스터와 해당 클러스터에 접근하는 kubeconfig
- `kubectl`, Bash, OpenSSL
- 모든 노드에서 Docker Hub의 BusyBox 이미지를 가져올 수 있는 네트워크

두 Linux 머신에 설치하는 절차는 [k3s 실습 가이드](../../../docs/k3s-lab.md)를 참고하세요. 가이드의 기준 버전은 `v1.37.1+k3s1`이며, kubectl도 같은 Kubernetes minor 버전을 권장합니다. 기본 k3s 런타임은 containerd이므로 호스트 Docker에만 존재하는 이미지는 그대로 사용할 수 없습니다.

아래 명령은 **저장소 루트**에서 실행합니다. kubeconfig를 별도 파일에 보관했다면 먼저 지정하세요.

```bash
export KUBECONFIG="$HOME/.kube/k3s-lab.yaml"
kubectl config get-contexts
```

예시 context 이름은 `k3s-lab`입니다. 실제 이름으로 바꿔 사용하세요. 스크립트는 현재 기본 context에 의존하지 않고 `--context`를 반드시 받습니다. 같은 이름의 `paas-sample` Namespace에 이 샘플의 소유권 라벨이 없으면 배포와 삭제를 거부합니다. 이 라벨은 실수 방지를 위한 장치이며 권한 제어 수단은 아닙니다.

## 배포와 확인

```bash
./deploy/k3s/sample/deploy.sh --context k3s-lab
kubectl --context=k3s-lab -n paas-sample get pods -o wide
kubectl --context=k3s-lab -n paas-sample get jobs
kubectl --context=k3s-lab -n paas-sample logs deployment/worker --tail=10
```

스크립트는 기본 리소스와 데모 Secret을 준비하고 새 Job의 완료를 최대 90초 기다립니다. Job이 실패하거나 시간이 초과되면 웹·워커 rollout을 시작하지 않습니다. Job 성공 후 Deployment를 적용하고, `envFrom` 설정을 새 프로세스에 반영하도록 재시작한 뒤 readiness를 기다립니다. Job 로그에는 비밀값을 출력하지 않습니다.

웹 서버는 외부 포트를 열지 않는 `ClusterIP` Service로 제공됩니다. 별도 터미널에서도 같은 `KUBECONFIG`를 지정하고 loopback으로만 연결하세요.

```bash
kubectl --context=k3s-lab -n paas-sample port-forward \
  --address=127.0.0.1 service/web 15000:5000
```

```bash
curl --fail --include http://127.0.0.1:15000/health
curl --fail http://127.0.0.1:15000/
```

`/health`에서 HTTP `200`과 `ok`, 루트 경로에서 앱 이름과 Pod 이름을 확인합니다. 워커 로그의 `web=ok`는 클러스터 내부 Service 이름으로 웹에 접속했다는 의미입니다. `port-forward`는 선택된 Pod 하나에 연결하므로 로드밸런싱이나 노드 장애 복구 검증을 대신하지 않습니다. 해당 Pod가 교체되면 연결을 다시 열어야 합니다.

## 설정 변경과 재배포

`bootstrap/configuration.yaml`의 `APP_LABEL` 또는 `WORKER_INTERVAL_SECONDS`를 바꾸고 같은 배포 명령을 실행하세요. 기존 Secret은 유지되고, 준비 Job은 매번 새로 생성됩니다. 완료한 Job은 600초 후 자동 정리되므로 필요한 로그는 그 전에 확인하세요.

이 스크립트는 한 클러스터에서 **한 번에 하나만 실행**하는 실습 도구입니다. 여러 배포의 잠금, 자동 rollback, 설정과 런타임의 원자적 변경은 구현하지 않습니다. Job이 실패해도 이미 적용된 ConfigMap은 남으며, 기존 Pod가 다른 이유로 재생성되면 변경된 값을 읽을 수 있습니다.

실제 마이그레이션으로 바꿀 때는 중복 실행에 안전한 도구와 DB 잠금이 필요합니다. 마이그레이션 중에도 기존 웹·워커가 실행되므로 스키마 변경은 이전 버전과 호환되어야 합니다. 워커의 `Recreate` 전략은 배포 중 두 버전의 중첩을 줄이지만 작업의 정확히 한 번 처리를 보장하지 않습니다.

Job이나 rollout이 실패하면 스크립트가 출력한 Job 이름과 다음 정보를 확인하세요.

```bash
kubectl --context=k3s-lab -n paas-sample get pods,jobs,deployments
kubectl --context=k3s-lab -n paas-sample get events --sort-by=.metadata.creationTimestamp
kubectl --context=k3s-lab -n paas-sample describe job <Job-이름>
```

## 선택 사항: 도메인 연결

`ingress.example.yaml`은 자동 배포하지 않습니다. 다음을 준비한 뒤 도메인, ingress class, TLS Secret 이름을 수정해 적용하세요.

1. 클러스터에 연결된 ingress controller
2. 해당 controller의 외부 주소를 가리키는 DNS
3. `paas-sample` Namespace의 유효한 TLS Secret 또는 별도로 구성한 인증서 발급기

```bash
kubectl --context=k3s-lab apply -f deploy/k3s/sample/ingress.example.yaml
```

기존 Docker용 Traefik이 Kubernetes Ingress를 자동으로 읽지는 않습니다. Kubernetes provider와 API 접근 권한 등을 별도로 설정하거나 클러스터용 controller를 준비해야 합니다. 이 파일은 Traefik 설치나 ACME 발급을 수행하지 않습니다.

## 앱 전체 삭제

```bash
./deploy/k3s/sample/delete.sh --context k3s-lab
kubectl --context=k3s-lab get namespace paas-sample --ignore-not-found
```

소유권 라벨을 확인한 뒤 `paas-sample` Namespace와 **그 안의 모든 리소스**를 삭제합니다. 웹·워커·준비 Job·설정·Secret을 앱과 함께 정리하는 예시입니다. 이 Namespace에 다른 리소스를 추가했다면 그것도 삭제됩니다. finalizer를 강제로 지우지 않으며, 다른 Namespace나 클러스터는 삭제하지 않습니다.

샘플은 PVC를 만들지 않습니다. `emptyDir` 데이터는 Pod 삭제 시 사라집니다. 실제 앱의 외부 DB·클러스터 범위 PV·레지스트리 이미지까지 Namespace 삭제로 정리되는 것은 아니므로 별도 보존·삭제 정책이 필요합니다.

## 운영 전 추가할 부분

- 계정·앱 메타데이터를 공유할 PostgreSQL과 포털의 Kubernetes 배포 어댑터
- 앱별 권한과 NetworkPolicy, Secret 암호화·관리, 이미지 digest 고정
- 노드 장애 시에도 접근할 수 있는 영속 스토리지와 외부 진입점
- 고가용성이 필요하면 3대 이상의 server와 control plane quorum

웹 Pod는 가능한 한 서로 다른 노드에 배치하지만 한 노드에서도 실행할 수 있습니다. Namespace, 비루트 실행, 제한된 Pod 보안 설정은 서로 다른 사용자의 커널 격리를 제공하지 않습니다. 신뢰할 수 없는 사용자 코드를 운영하려면 런타임 격리 수준도 별도로 결정해야 합니다.

## 검증 범위

k3d `v5.9.0`에서 k3s `v1.37.1+k3s1` server 1개와 agent 1개를 실행해 다음을 확인했습니다.

- 두 노드에 웹 Pod 분산, HTTP 200, 워커의 내부 Service 접속
- 새 Job 생성, 환경변수 변경 후 재배포, 기존 Secret 유지
- 준비 Job 실패 시 웹·워커 rollout 중단과 기존 웹의 HTTP 200 유지
- Namespace 삭제 시 앱 전체 정리와 외부 Namespace 보존
- 소유권 라벨이 없는 동일 이름의 Namespace에 대한 배포·삭제 거부
- Kubernetes API 서버의 런타임·Job·선택적 Ingress manifest 검증

검증용 Docker 환경의 제약으로 `native` snapshotter와 Flannel `host-gw`를 사용하고 `/dev/kmsg`에는 `/dev/null`을 연결했습니다. 이 검증은 실제 머신 두 대의 설치, 기본 VXLAN 경로, 커널 OOM 감지, 노드 장애 복구, 외부 도메인/TLS, 실제 DB 마이그레이션을 포함하지 않습니다. 검증용 코드와 클러스터 설정은 저장소에 포함하지 않습니다.
