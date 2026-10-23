# 2대 Linux k3s 앱 샘플 실습

이 문서는 사설망 또는 VPN으로 연결된 Linux 서버 두 대에서 PaaS의 Kubernetes 앱 샘플을 실행하기 위한 실습 안내입니다. 아래 명령으로 클러스터를 준비한 다음 샘플을 배포합니다. 샘플 배포 명령과 정리는 [`deploy/k3s/sample/README.md`](../deploy/k3s/sample/README.md)를 따르세요.

## 실습 구성

| 머신 | 역할 | 예시 사설 IP |
| --- | --- | --- |
| A | k3s server/control plane이며 앱 워크로드도 실행 | `10.20.0.10` |
| B | k3s agent, 추가 워크로드 실행 노드 | `10.20.0.11` |

두 노드는 서로의 안정적인 사설/VPN 주소로 통신해야 합니다. 설치 버전은 두 노드 모두 `v1.37.1+k3s1`로 고정합니다. 기존 PaaS 프록시와 80/443 포트가 겹치지 않도록 k3s가 함께 설치하는 Traefik과 ServiceLB를 끕니다. A는 단일 control plane이자 workload 노드이므로 고가용성이 아닙니다. 장애 허용을 위한 embedded etcd 구성은 별도 실습에서 server 세 대와 quorum을 구성해야 합니다.

## 네트워크와 방화벽

OS 방화벽 및 클라우드 방화벽에서는 필요한 트래픽만 A, B, 신뢰된 관리자 주소 사이에 허용합니다. k3s 기본 Flannel VXLAN을 사용할 때 두 노드 사이에 UDP `8472`를 허용하고, B와 원격 kubectl을 실행하는 신뢰된 관리자만 A의 TCP `6443` Kubernetes API에 접속하게 하세요. 노드 kubelet 통신용 TCP `10250`도 필요한 노드 간 경로로 제한하세요. API `6443`를 인터넷 전체에 공개하지 마세요. 기본 Pod CIDR `10.42.0.0/16`과 Service CIDR `10.43.0.0/16`이 호스트, VPN, Docker 네트워크와 겹치지 않는지도 설치 전에 확인하세요.

이 샘플의 웹 Service는 `ClusterIP`이므로 외부 NodePort 트래픽은 필요하지 않습니다. 별도로 NodePort를 시험할 때만 실제 할당된 단일 포트와 프로토콜을 신뢰된 클라이언트에 한해 허용하세요. 기본 범위 전체(`30000-32767`)를 방화벽에 열지 마세요. 이 실습은 ingress controller와 LoadBalancer를 설치하지 않으며 80/443을 열 필요도 없습니다.

## A에서 k3s server 설치

A에 접속해 예시 주소가 실제 A의 사설/VPN 주소와 일치하는지 확인한 뒤 설치합니다.

```bash
curl -sfL https://get.k3s.io | sudo INSTALL_K3S_VERSION='v1.37.1+k3s1' sh -s - server \
  --node-ip=10.20.0.10 \
  --advertise-address=10.20.0.10 \
  --tls-san=10.20.0.10 \
  --disable=traefik \
  --disable=servicelb
```

VPN 인터페이스를 노드 간 Flannel 경로로 사용할 경우 A에서 해당 인터페이스 이름을 확인하고 `--flannel-iface=<A의-VPN-인터페이스>`도 지정하세요. B에는 별도로 해당 노드의 값을 지정합니다.

`kubectl`로 노드 상태를 확인합니다.

```bash
sudo k3s kubectl get nodes -o wide
```

## Agent token을 안전하게 전달

노드 등록 토큰은 비밀로 취급하세요. 토큰 문자열을 터미널에 출력하거나 명령행, 셸 기록, 티켓, 공개 로그에 넣지 마세요. A에서 토큰 파일을 권한 `0600`으로 복사해 SSH/SCP 등 승인된 보안 채널로 B에 전달합니다. 아래 명령의 `operator`는 두 머신에 SSH로 접속할 수 있는 신뢰된 계정으로 바꾸세요.

```bash
# A에서 실행: 소유 계정만 읽을 수 있는 전송 파일을 만든다.
sudo install -o "$USER" -g "$(id -gn)" -m 600 \
  /var/lib/rancher/k3s/server/agent-token "$HOME/k3s-agent-token"
ssh operator@10.20.0.11 'install -d -m 700 "$HOME/.k3s-token-transfer"'
scp "$HOME/k3s-agent-token" operator@10.20.0.11:.k3s-token-transfer/agent-token
rm -f "$HOME/k3s-agent-token"
```

B에서 받은 파일을 root 전용 위치에 설치하고 임시 사본을 지웁니다.

```bash
sudo install -d -o root -g root -m 700 /etc/rancher/k3s
sudo install -o root -g root -m 600 "$HOME/.k3s-token-transfer/agent-token" \
  /etc/rancher/k3s/agent-token
rm -f "$HOME/.k3s-token-transfer/agent-token"
rmdir "$HOME/.k3s-token-transfer"
```

토큰 파일이 `/etc/rancher/k3s/agent-token`에 있고 root만 읽을 수 있는지 확인한 후 agent를 설치합니다.

## B에서 k3s agent 설치

`K3S_URL`에는 A의 사설/VPN 주소를 지정합니다. 토큰 값은 환경변수나 명령 인자로 복사하지 않고 앞서 만든 파일 경로를 전달합니다.

```bash
curl -sfL https://get.k3s.io | sudo env \
  INSTALL_K3S_VERSION='v1.37.1+k3s1' \
  K3S_URL='https://10.20.0.10:6443' \
  K3S_TOKEN_FILE='/etc/rancher/k3s/agent-token' \
  sh -s - agent --node-ip=10.20.0.11
```

VPN 인터페이스를 Flannel에 사용할 경우 위 agent 옵션에 `--flannel-iface=<B의-VPN-인터페이스>`도 추가하세요. server의 `agent-token`은 기본 설정에서 초기 node token과 같은 값이며 노드 등록 권한을 가진 비밀 정보입니다. 출력하거나 공개하지 말고 안전하게 보관하세요.

A에서 노드 등록을 확인합니다.

```bash
sudo k3s kubectl get nodes -o wide
```

먼저 A에서 kubeconfig 사본을 만들고 권한을 `0600`으로 제한합니다. 기본 context 이름 `default`를 실습용 이름으로 바꾸세요.

```bash
install -d -m 700 "$HOME/.kube"
sudo install -o "$USER" -g "$(id -gn)" -m 600 \
  /etc/rancher/k3s/k3s.yaml "$HOME/.kube/k3s-lab.yaml"
kubectl --kubeconfig "$HOME/.kube/k3s-lab.yaml" config rename-context default k3s-lab
```

원격 kubectl을 쓸 경우 이 파일을 신뢰된 관리자의 로컬 경로로 보안 채널을 통해 복사하고 권한을 `0600`으로 유지하세요. A의 기본 kubeconfig는 server 주소가 loopback이므로, A의 사설/VPN IP가 위 `--tls-san`에 포함된 상태에서 로컬 복사본의 `server: https://127.0.0.1:6443`을 `server: https://10.20.0.10:6443`으로 바꾸세요. 자격 증명이 포함된 파일 내용을 터미널이나 로그에 출력하지 마세요.

관리자 머신에서 파일 경로를 지정해 context 이름을 확인하고 변경합니다.

```bash
KUBECONFIG_FILE="$HOME/.kube/k3s-lab.yaml"
chmod 600 "$KUBECONFIG_FILE"
kubectl --kubeconfig "$KUBECONFIG_FILE" config get-contexts
export KUBECONFIG="$KUBECONFIG_FILE"
```

샘플 검증·배포·정리 스크립트는 반드시 `--context k3s-lab`처럼 context를 명시해 실행하세요. 예를 들어 저장소 루트에서 `./deploy/k3s/sample/deploy.sh --context k3s-lab` 및 `./deploy/k3s/sample/delete.sh --context k3s-lab`을 사용합니다.

## 샘플의 범위와 한계

샘플은 `paas-sample` namespace에 웹 Deployment와 port `5000`의 `ClusterIP` Service, worker Deployment, 그리고 일회성 준비 Job을 만듭니다. Job은 배포 전 작업의 실행 순서만 시연하며 실제 데이터베이스나 마이그레이션을 실행하지 않습니다. 이 샘플은 현재 PaaS 앱을 k3s로 실행하지 않으며 기존 PaaS 런타임 동작도 바꾸지 않습니다.

k3s는 Docker Engine과 별도로 `containerd`를 사용합니다. 이 샘플은 공개 이미지 `busybox:1.37.0`을 직접 사용하므로 registry push가 필요하지 않습니다. 실제 PaaS 앱처럼 직접 빌드한 이미지를 배포할 때는 두 노드가 접근 가능한 컨테이너 레지스트리에 이미지를 push하고 manifest가 해당 이미지 경로를 가리키게 해야 합니다. 이미지 pull 권한이 필요한 비공개 registry라면 namespace의 image pull secret도 구성하세요.

샘플은 PVC를 만들지 않습니다. 임시 작업 공간은 컨테이너의 `emptyDir`로 제공되며 Pod가 제거되면 데이터도 사라집니다. 영속 데이터가 필요한 실제 앱에는 별도의 스토리지 설계가 필요합니다.

## 공식 참고자료

- [k3s v1.37.1+k3s1 release](https://github.com/k3s-io/k3s/releases/tag/v1.37.1%2Bk3s1)
- [k3s 설치 및 네트워크 요구사항](https://docs.k3s.io/installation/requirements)
- [k3s server 옵션](https://docs.k3s.io/cli/server)
- [k3s token 관리](https://docs.k3s.io/cli/token)
- [k3s cluster access와 kubeconfig](https://docs.k3s.io/cluster-access)
- [k3s storage](https://docs.k3s.io/storage)
