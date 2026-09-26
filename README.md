# Hyunbbai PaaS

Hyunbbai PaaS is a self-hosted platform for deploying GitHub repositories as Docker containers on a single server. It brings source builds, application lifecycle management, HTTPS routing, logs, and an interactive container terminal into one web portal.

## Features

- Deploy a public GitHub repository by providing its URL, application name, and branch; the default branch is `main`.
- Build compatible projects automatically with Railpack, or use a `Dockerfile` from the repository root.
- Start, stop, redeploy, and delete applications from the dashboard.
- Inspect container logs with automatic refresh and open an interactive browser terminal.
- Edit application environment variables and recreate the container to apply them.
- Assign each application a subdomain and attach custom domains with CNAME verification.
- Manage users, application ownership, administrator access, and application count limits.
- Track background operations with job status, streamed build/deployment output, and retry controls.
- Deploy private repositories through an optional GitHub App integration.

## Core ideas

### Containerize each user's application

Each application runs in its own Docker container, with a separate filesystem and process namespace, a persistent `/data` mount, and configurable CPU and memory limits. Application containers do not receive the host Docker socket. The portal manages them through Docker Compose and Docker labels identifying their owner, name, domain, and internal port.

This provides container-level isolation. Applications currently share the `paas-app` network with the portal and proxy, so network isolation between users is incomplete. BuildKit runs on a separate network and exposes only a Unix socket shared with the portal. See the existing [security review](docs/security-threats.md) for the current boundaries and remaining work.

### Bring Portainer-inspired logs and exec into the portal

The management experience takes inspiration from Portainer: users can inspect application output and execute commands inside a running container without leaving the dashboard. Logs use Docker's container output with periodic refresh. The exec view uses xterm.js, WebSockets, and Docker's TTY exec API to relay keyboard input, terminal output, and resize events. Access is checked against the session and application owner; administrators can access other users' applications.

### Turn repository source into an image with Railpack

When a repository has no root-level `Dockerfile`, the platform runs `railpack build . --name <image>` against the cloned source. Railpack detects supported projects and produces a container image, removing the need to write platform-specific build configuration for conventional applications. A repository-provided `Dockerfile` takes precedence and is built with `docker build`.

The portal's runtime detector provides Node.js framework and dependency badges for the UI; Railpack performs the actual automatic build detection. Successful deployment still requires a supported project with a working startup command and an HTTP server listening on `0.0.0.0:5000` (the platform supplies `PORT=5000`).

### Route applications through one shared proxy

Traefik discovers application containers through Docker labels. Applications do not publish individual host ports; traffic reaches them through the proxy. Platform subdomains share a wildcard certificate issued through Cloudflare DNS-01, while custom domains use HTTP-01 after CNAME verification.

```text
GitHub repository -> clone -> Railpack / Dockerfile -> image -> app container
Browser -> Traefik -> portal or application
Portal -> Docker API / Compose -> lifecycle, logs, and exec
```

## Technology stack

| Layer | Technologies |
| --- | --- |
| Portal backend | Node.js 22 in the Compose image, Express 4, JavaScript |
| Dashboard | HTML, CSS, vanilla JavaScript, xterm.js |
| Persistence and authentication | SQLite via `better-sqlite3`, bcrypt password hashes, session cookies |
| Container management | Docker Engine, Docker Compose, `dockerode`, Bash scripts |
| Application builds | Railpack, BuildKit, repository-provided Dockerfiles |
| Routing and TLS | Traefik 3.6, Let's Encrypt, Cloudflare DNS-01, HTTP-01 |
| Live communication | WebSockets for exec, Server-Sent Events for job output |
| Private repository access | GitHub App OAuth, app JWTs, installation access tokens |

## System requirements

These are practical starting estimates for a host running both the platform and application builds, rather than measured capacity guarantees. Build size, application traffic, and concurrent deployments determine the actual requirements.

| Resource | Minimum for a small deployment | Recommended for routine operation |
| --- | --- | --- |
| CPU | 2 vCPUs | 4 or more vCPUs |
| Memory | 4 GiB RAM | 8 GiB RAM; 16 GiB for larger builds or more applications |
| Storage | 40 GB SSD | 80 GB or more SSD |
| Operating system | 64-bit Linux supporting Docker Engine | A maintained Linux server distribution |
| Network | Internet access for GitHub, image registries, package downloads, and certificate issuance | Stable connection and a publicly reachable server for HTTPS |

By default, each application is limited to `256m` of memory and `0.5` CPU, with at most 5 applications per user and 20 overall. Twenty containers at their memory limit can use about 5 GiB before accounting for the OS, portal, proxy, or builds. The count limits are administrative limits, not a promise that the minimum host can run that many applications. Application resource limits do not cap the resources consumed by image builds.

The host needs Git, Docker Engine, and Docker Compose 2.17.0 or later with build support because the portal image uses [`dockerfile_inline`](https://docs.docker.com/reference/compose-file/build/#dockerfile_inline). Use the `docker compose` command. The bundled setup expects a rootful Docker daemon at `/var/run/docker.sock` and supports a privileged BuildKit container. Your shell user must be able to run Docker commands.

Node.js and Railpack do not need to be installed on the host for the Compose workflow: the portal image installs its own tools. For direct portal development, `portal/package.json` requires Node.js 20 or later.

## Initial bootstrap

Run the following steps from the repository root. The production setup uses a domain hosted in Cloudflare and exposes HTTP/HTTPS through Traefik.

### 1. Clone and prepare local configuration

```bash
git clone https://github.com/sa04108/paas-webapp.git
cd paas-webapp
cp .env.example .env
chmod 600 .env
mkdir -p apps portal-data/traefik-dynamic portal-data/letsencrypt
touch portal-data/letsencrypt/acme.json
chmod 600 portal-data/letsencrypt/acme.json
```

Edit `.env` and replace its sample values. The following is a starting configuration for public repository deployment; use your own domain, email, and token:

```dotenv
PAAS_DOMAIN=example.com
ACME_EMAIL=operator@example.com
CF_DNS_API_TOKEN=replace-with-your-cloudflare-token

PORTAL_PORT=3000
PORTAL_COOKIE_SECURE=true
PORTAL_TRUST_PROXY=true
SESSION_COOKIE_NAME=portal_session
SESSION_TTL_HOURS=168
BCRYPT_ROUNDS=10

APP_NETWORK=paas-app
DEFAULT_MEM_LIMIT=256m
DEFAULT_CPU_LIMIT=0.5
DEFAULT_RESTART_POLICY=unless-stopped
MAX_APPS_PER_USER=5
MAX_TOTAL_APPS=20

# Leave the optional GitHub App integration disabled until configured.
GITHUB_APP_ID=
GITHUB_APP_SLUG=
GITHUB_APP_CLIENT_ID=
GITHUB_APP_CLIENT_SECRET=
GITHUB_APP_PRIVATE_KEY_PATH=
GITHUB_APP_PRIVATE_KEY=
GITHUB_STATE_SECRET=
```

In particular, clear `GITHUB_APP_PRIVATE_KEY_PATH` from the copied example when you have not installed a GitHub App key. The portal reads any configured key file during startup, and a missing file prevents startup.

The root `.env` is used both for Compose interpolation and by the portal and lifecycle scripts. Editing it is the simplest way to keep their configuration consistent. Keep the default container root `/paas` unless you also adjust the corresponding mounts and paths.

### 2. Configure DNS and TLS credentials

For `PAAS_DOMAIN=example.com`, create the following records pointing to your server's public IP:

| DNS name | Record | Purpose |
| --- | --- | --- |
| `example.com` | A | Landing page |
| `portal.example.com` | A, or CNAME to `example.com` | Management portal |
| `*.apps.example.com` | A, or CNAME to `example.com` | Application subdomains |

Start with DNS-only records so requests reach Traefik directly. Create a Cloudflare API token with **Zone / Zone / Read** and **Zone / DNS / Edit** permissions for the relevant zone and assign it to `CF_DNS_API_TOKEN`. These are the permissions documented by the [Cloudflare ACME provider](https://go-acme.github.io/lego/dns/cloudflare/#api-tokens).

Allow inbound TCP ports **80** and **443** through the host firewall and any router/NAT. Port 80 is needed for the custom-domain HTTP-01 challenge and HTTP-to-HTTPS redirects. The Compose file also publishes the portal on `PORTAL_PORT` (default **3000**); restrict public access to that port and use the HTTPS portal URL for production.

If you use custom domains, their generated CNAME targets have the form `<app>-<random>.example.com`. Make those target names resolve to this server by adding individual DNS records or an additional `*.example.com` wildcard record. The `*.apps.example.com` record alone does not cover these targets.

### 3. Create the shared Docker network

The application network is declared external, so it must exist before starting the stack. Use the same name as `APP_NETWORK` in `.env`:

```bash
docker network inspect paas-app >/dev/null 2>&1 || docker network create paas-app
```

### 4. Build and start the platform

```bash
docker compose --env-file .env -f docker-compose.yml config --quiet
docker compose --env-file .env -f docker-compose.yml up -d --build
docker compose --env-file .env -f docker-compose.yml ps
docker compose --env-file .env -f docker-compose.yml logs --tail=100 portal traefik buildkit
curl --fail http://127.0.0.1:3000/health
```

Adjust the health-check port if you changed `PORTAL_PORT`. The first start builds the portal image, installs portal dependencies with `npm ci`, and starts `paas-portal`, `paas-proxy`, and `paas-buildkit`. Certificate issuance can take additional time; inspect the Traefik logs if HTTPS is not yet available.

### 5. Sign in and deploy the first application

Open `https://portal.example.com` and sign in with **`admin` / `admin`**. On a new database, the bootstrap account is created automatically. Production mode requires changing its password before protected operations become available. Administrators can then create additional users.

Create an application using a repository URL and branch. A repository that follows Railpack's supported build conventions does not need a custom Dockerfile or platform-specific build configuration. Its HTTP server must bind to `0.0.0.0` and use `PORT=5000`; this also applies when supplying your own Dockerfile. Persistent application files belong in `/data`.

An application named `demo` owned by `admin` is served at:

```text
https://admin-demo.apps.example.com
```

Use the job view to inspect build progress, then the application's **Logs**, **Exec**, environment-variable, and domain controls to manage it. Redeployment pulls the repository's latest code, rebuilds the image, and replaces the container; the current implementation has a brief interruption while the container is recreated.

## Optional: private GitHub repositories

Create a GitHub App with repository **Contents: Read-only** permission, enable **Request user authorization (OAuth) during installation**, and set its callback URL to:

```text
https://portal.example.com/api/github/callback
```

Place the downloaded private key in `portal-data/github-app-private-key.pem`, then configure:

```dotenv
GITHUB_APP_ID=your-app-id
GITHUB_APP_SLUG=your-app-slug
GITHUB_APP_CLIENT_ID=your-client-id
GITHUB_APP_CLIENT_SECRET=your-client-secret
GITHUB_APP_PRIVATE_KEY_PATH=/paas/portal-data/github-app-private-key.pem
GITHUB_STATE_SECRET=replace-with-a-long-random-secret
```

Generate a state secret and prepare the Git credential helper:

```bash
openssl rand -base64 32
chmod 600 portal-data/github-app-private-key.pem
chmod +x scripts/lib/git-askpass.sh
docker compose --env-file .env -f docker-compose.yml restart portal
```

Copy the generated secret into `GITHUB_STATE_SECRET` before restarting. The key path is the path **inside the portal container**. Users can then connect GitHub in the portal, select repositories during installation, and deploy them using short-lived installation tokens. See [GitHub App setup](docs/github-app-setup.md) for further details.

## Local development with Docker

Complete the directory and network preparation above, then use a local `.env` with `PAAS_DOMAIN=localhost`, `PORTAL_COOKIE_SECURE=false`, and all optional GitHub App variables empty. Cloudflare credentials and an ACME email are unnecessary for the HTTP development proxy.

```bash
docker compose --env-file .env -f docker-compose.yml -f docker-compose.dev.yml config --quiet
docker compose --env-file .env -f docker-compose.yml -f docker-compose.dev.yml up -d --build
docker compose --env-file .env -f docker-compose.yml -f docker-compose.dev.yml logs --tail=100 portal traefik
```

The override sets `RUN_MODE=development`, starts Node.js in watch mode, and routes applications over HTTP. Open the landing page at `http://localhost:3000`, the portal at `http://portal.localhost:3000`, and an application at `http://<user>-<app>.apps.localhost:18080`. If your browser does not resolve these names to loopback, add the individual names to your local hosts file.

The shared application network still needs to exist. The current override also retains the base Compose port mappings for 80 and 443 while adding 18080, so those host ports must be available even in development. Development mode bypasses the mandatory password-change gate.

## Operations and persistent data

The host checkout stores the following runtime files:

| Path | Contents |
| --- | --- |
| `portal-data/portal.sqlite3` | Users, sessions, jobs, GitHub installation links, and custom-domain metadata |
| `portal-data/letsencrypt/acme.json` | ACME account and certificates |
| `portal-data/traefik-dynamic/` | Generated custom-domain routing configuration |
| `apps/<user>/<app>/app/` | Cloned repository source |
| `apps/<user>/<app>/data/` | Application files mounted at `/data` |
| `apps/<user>/<app>/logs/` | Lifecycle script logs |
| `apps/<user>/<app>/docker-compose.yml` | Generated application container configuration |
| `apps/<user>/<app>/.env.paas` | User-defined application environment variables, when saved |

Back up `.env`, `portal-data/`, and application data with a consistent SQLite backup. These runtime paths are excluded from Git. Application logs use Docker's `json-file` driver with rotation at 10 MB per file and 3 files per container.

For the production stack:

```bash
# Follow platform logs.
docker compose --env-file .env -f docker-compose.yml logs -f --tail=100 portal traefik

# Apply platform configuration or image changes.
docker compose --env-file .env -f docker-compose.yml up -d --build

# Stop platform services.
docker compose --env-file .env -f docker-compose.yml down
```

User applications have separate Compose projects and keep running when the platform stack is stopped; manage them through the portal before shutdown if needed. The portal has access to the host Docker socket and BuildKit is privileged, so the platform's administrators control the Docker host.

To run the existing portal test suite with dependencies installed:

```bash
cd portal
npm ci
npm test
```

Additional documentation: [GitHub App setup](docs/github-app-setup.md), [security review](docs/security-threats.md), and [GitHub Actions deployment design notes](docs/github-actions-deploy.md).
