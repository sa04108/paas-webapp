# Hyunbbai PaaS

Hyunbbai PaaS is a self-hosted platform for deploying GitHub repositories as Docker containers on a single server. It brings source builds, application lifecycle management, HTTPS routing, logs, and an interactive container terminal into one web portal.

## Features

- Deploy a public GitHub repository by providing its URL, application name, and branch; the default branch is `main`.
- Build automatically, select a root-level Dockerfile from GitHub, or write a custom Dockerfile in the app creation form.
- Deploy multiple services from Compose YAML, with registry images, service Dockerfiles, or a shared Railpack image.
- Start, stop, redeploy, and delete whole application projects from the dashboard.
- Stream container logs, filter by service, and open an interactive browser terminal.
- Edit application environment variables and recreate the app's services to apply them.
- Assign each application a subdomain and attach custom domains with CNAME verification.
- Manage users, application ownership, administrator access, and application count limits.
- Track background operations with job status, streamed build/deployment output, and retry controls.
- Deploy private repositories through an optional GitHub App integration.

## Core ideas

### Containerize each user's application

Each application is one Docker Compose project containing its web service, workers, and initialization jobs. Services have separate filesystems and process namespaces; application data stays under that application's data directory. CPU and memory limits apply to the combined services. Application containers do not receive the host Docker socket. The portal owns project names, container identities, routing, networks, and ownership labels. See [Compose application configuration](docs/compose-apps.md) for the supported YAML fields and KTX example.

Workers and databases use an app-private network; only the web service also joins the shared application proxy network (`paas-app` by default). The portal uses `infra-proxy`, declared directly in Compose. An existing Traefik serving both the portal and apps joins both shared networks; the dedicated application proxy joins only the app proxy network. Web services share that network with other web services, so isolation between users is incomplete. The Docker daemon and host remain shared. BuildKit runs on a separate network and exposes only a Unix socket shared with the portal.

Generated services have PID limits, `no-new-privileges`, and `NET_RAW`/`MKNOD` capability drops. Non-root execution is not enforced, and application storage has no per-app disk quota. The portal controls the host Docker socket and BuildKit runs privileged; this deployment is not a separate host or VM security boundary for each tenant.

### Bring Portainer-inspired logs and exec into the portal

Users can inspect application output and execute commands inside a running container without leaving the dashboard. The backend merges each service container's logs by Docker timestamp and streams them through Server-Sent Events. Service toggles select which logs to display; timestamps are optional, and the Auto/Refresh button controls live updates. The exec view uses xterm.js, WebSockets, and Docker's TTY exec API to relay keyboard input, terminal output, and resize events. Access is checked against the session and application owner; administrators can access other users' applications.

### Turn repository source into an image with Railpack

The app creation form and each deployed app's **Settings** offer four build modes:

| Mode | Behavior |
| --- | --- |
| Detect Dockerfile automatically (default) | Prefer `Dockerfile`, then the first root-level regular file containing the case-sensitive string `Dockerfile` in bytewise filename order, including hidden files. Use Railpack if no file matches. |
| Choose a root Dockerfile | Query the selected GitHub repository and branch over the web, then select a matching root file from the dropdown. Private repositories use the signed-in user's GitHub App connection. Subdirectories are excluded. |
| Write a Dockerfile | Enter Dockerfile contents in the form, up to 64 KiB of UTF-8 text. The repository root remains the build context. |
| Railpack | Always use Railpack, even when Dockerfiles exist. Optionally enter a JSON configuration object, up to 64 KiB of UTF-8 text, for the server to supply at build time. |

Dockerfile builds use `docker build -f <file>`. A failed Docker build is reported without falling back to Railpack. Explicitly selected files must still exist in the repository root when the build starts; a missing file fails the build instead of selecting another file.

In automatic mode, when no matching file exists, the platform runs `railpack build . --name <image>` against the cloned source. Railpack detects supported projects and produces a container image, removing the need to write platform-specific build configuration for conventional applications.

In Railpack mode, a blank configuration runs the same plain `railpack build` command without injecting a server configuration. Any repository-provided `railpack.json` follows Railpack's normal behavior. A nonblank configuration is validated as a JSON object, written outside the cloned source, and passed through `--config-file` without modifying repository files.

Build and runtime choices are saved with repository metadata in the application's `.paas-meta.json` outside its cloned source before building, so failed applications remain manageable. Custom Dockerfiles are materialized outside the cloned source. Services without `image`/`build`, or using `${PAAS_APP_IMAGE}`, share this build; services with their own registry image or Dockerfile are prepared separately. Operations on the same app run in order.

For an existing app, open **Settings**, load or edit its build configuration, and choose **Save build settings**. Saving preserves the running container; changes apply on the next **Redeploy**. Dockerfile lookup uses the app's stored repository and branch, including the owner's GitHub App connection when an administrator edits another user's app.

The portal's runtime detector provides Node.js framework and dependency badges for the UI; Railpack performs the actual automatic build detection. Successful deployment still requires a supported project with a working startup command and an HTTP server listening on `0.0.0.0:5000` (the platform supplies `PORT=5000`).

### Route applications through a reverse proxy

Application containers do not publish individual host ports. The portal stack (`docker-compose.yml`) does not bind public ports; configure portal ingress separately on the server, then select an existing Traefik and a separate application network in Proxy Setup. Saving the existing-Traefik profile creates the app network if needed and connects Traefik to it. The new-Traefik profile generates `portal-data/proxy-compose.yml` from the `docker-compose.proxy.yml` template and the saved settings. That proxy runs as a separate Compose project. The setup screen requires administrator access. Nginx Proxy Manager is not currently supported as a direct application-proxy integration.

```text
GitHub repository -> clone -> Compose validation -> Railpack / Dockerfile / image pull -> app services
Browser -> server-managed reverse proxy -> portal
Browser -> application Traefik -> application web service
Portal -> Docker API / Compose -> lifecycle, logs, and exec
```

## Technology stack

| Layer | Technologies |
| --- | --- |
| Portal backend | Node.js 24.22.1 LTS in the Compose image, Express 4, JavaScript |
| Dashboard | React, TypeScript, React Router, Vite, CSS, xterm.js |
| Persistence and authentication | SQLite via `better-sqlite3`, bcrypt password hashes, session cookies |
| Container management | Docker Engine, Docker Compose, `dockerode`, Bash scripts |
| Application builds | Railpack, BuildKit, repository-provided Dockerfiles |
| Routing and TLS | Existing or dedicated Traefik; configurable ACME CA, Cloudflare DNS-01 for app wildcards, HTTP-01 for custom domains |
| Live communication | WebSockets for exec, Server-Sent Events for app and job logs, API polling for status |
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

By default, each application's services share a budget of `256m` of memory and `0.5` CPU, with at most 5 applications per user and 20 overall. Each app supports up to 8 services, with a default upper bound of 128 PIDs per service. Twenty apps at their memory budget can use about 5 GiB before accounting for the OS, portal, proxy, or builds. The count limits are administrative limits, not a promise that the minimum host can run that many applications. Application resource limits do not cap the resources consumed by image builds.

The host needs Git, Docker Engine, and Docker Compose 2.17.0 or later with build support because the portal image uses [`dockerfile_inline`](https://docs.docker.com/reference/compose-file/build/#dockerfile_inline). Attaching an existing Traefik to a new app network requires Docker Engine 28+ (API 1.48+) for gateway-priority support. Use the `docker compose` command. The bundled setup expects a rootful Docker daemon at `/var/run/docker.sock` and supports a privileged BuildKit container. Your shell user must be able to run Docker commands.

Node.js and Railpack do not need to be installed on the host for the Compose workflow: the portal image installs its own tools. For direct portal development, use Node.js 24.22.1 or a newer 24.x release.

## Initial bootstrap

Run the following steps from the repository root. This guide uses the supplied Traefik stack and a domain hosted in Cloudflare. The portal stack and edge proxy are independent Compose projects; see [proxy setup](docs/proxy-setup.md) to connect an existing Traefik instead.

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
| `example.com` | A | Optional CNAME target for the portal DNS record |
| `portal.example.com` | A, or CNAME to `example.com` | Management portal |
| `*.apps.example.com` | A, or CNAME to `example.com` | Application subdomains |

For the supplied Traefik stack, start with DNS-only records so requests reach the proxy directly. Create a Cloudflare API token with **Zone / Zone / Read** and **Zone / DNS / Edit** permissions for the relevant zone and assign it to `CF_DNS_API_TOKEN`. These are the permissions documented by the [Cloudflare ACME provider](https://go-acme.github.io/lego/dns/cloudflare/#api-tokens).

The production portal is served at `portal.example.com`. The root domain has no portal router or redirect to the portal; its DNS record is only needed if another record uses it as a CNAME target.

If using the supplied Traefik stack, allow inbound TCP ports **80** and **443** through the host firewall and any router/NAT. Port 80 is needed for custom-domain HTTP-01 challenges and HTTP-to-HTTPS redirects. The portal listens on `PORTAL_PORT` (default **3000**) inside Docker. The base portal Compose file publishes no host ports; the server operator configures the portal upstream separately; application web services use the selected proxy network.

If you use custom domains, their generated CNAME targets have the form `<app>-<random>.example.com`. Make those target names resolve to this server by adding individual DNS records or an additional `*.example.com` wildcard record. The `*.apps.example.com` record alone does not cover these targets.

### 3. Prepare Docker networks

The portal joins the `infra-proxy` infrastructure network declared directly in Compose. Reuse the server's existing infrastructure network by changing `networks.infra.name`, or create the default network:

```bash
docker network inspect infra-proxy >/dev/null 2>&1 || docker network create infra-proxy
```

When reusing Traefik, **Save and connect** creates the separate application network if needed. For the standalone/development proxy templates, create their application network before starting them (the template defaults to `paas-app`):

```bash
docker network inspect paas-app >/dev/null 2>&1 || docker network create paas-app
```

### 4. Build and start the portal

```bash
docker compose --env-file .env -f docker-compose.yml config --quiet
docker compose --env-file .env -f docker-compose.yml up -d --build
docker compose --env-file .env -f docker-compose.yml ps
docker compose --env-file .env -f docker-compose.yml logs --tail=100 portal buildkit
```

The first start builds the portal image, installs dependencies with `npm ci`, and starts `paas-portal` and `paas-buildkit`. Configure the portal's public reverse proxy separately, or enable loopback admin access to finish setup:

```bash
docker compose --env-file .env -f docker-compose.yml -f docker-compose.admin.yml up -d
```

From your computer, run `ssh -N -L 13000:127.0.0.1:3000 user@server` and open `http://localhost:13000`. Sign in, change the bootstrap password, and open **Admin Dashboard → Proxy Setup**. If using an existing Traefik, follow [proxy setup](docs/proxy-setup.md). If installing a dedicated application proxy, save its settings first, ensure the selected application network exists, then run the generated command from the repository root. With the default data path:

```bash
docker compose --env-file .env --project-directory . -f portal-data/proxy-compose.yml up -d
```

The generated proxy uses its own `paas-edge` project; do not combine it with the base portal Compose or start it alongside another proxy occupying ports 80/443. Keep the admin override in subsequent portal commands if the host reverse proxy uses that loopback port. Configure the portal reverse proxy and HTTPS independently on the server, then verify its public address:

```bash
curl --fail https://portal.example.com/health
```

Replace `portal.example.com` with your configured portal hostname. `PORTAL_PORT` changes the portal's internal listener and proxy target; it is not a published host port. Certificate issuance can take additional time; inspect the relevant proxy logs if HTTPS is not yet available. The selected proxy profile and connection settings are stored in `portal-data/proxy-settings.json`.

To configure ingress, sign in as the bootstrap administrator, change the default password, then open **Admin Dashboard → Proxy Setup**. The setup page is available again at `/admin/proxy`; its connection check is read-only. Saved custom application domains update through the dynamic file provider. The portal route is managed by the server operator. Changes to an application network, entrypoint or certificate resolver require redeployment; the generated app Compose retains the web-service network attachment after recreation. Details and SSH access steps are in [proxy setup](docs/proxy-setup.md).

### 5. Sign in and deploy the first application

Open `https://portal.example.com` and sign in with **`admin` / `admin`**. On a new database, the bootstrap account is created automatically. Production mode requires changing its password before protected operations become available. Administrators can then create additional users.

Create an application using a repository URL and branch, then choose automatic detection, an existing root Dockerfile, a custom Dockerfile, or Railpack. The dropdown lookup supports GitHub repositories; automatic and custom builds also retain support for other repository URLs accepted by the platform. A repository that follows Railpack's supported build conventions does not need a custom Dockerfile or platform-specific build configuration. Its HTTP server must bind to `0.0.0.0` and use `PORT=5000`; this also applies when supplying your own Dockerfile. Persistent application files belong in `/data`.

An application named `demo` owned by `admin` is served at:

```text
https://admin-demo.apps.example.com
```

Open **Jobs** and select **Live logs** on a pending or running job to watch build and deployment output as it arrives. The log window reconnects after temporary connection loss and displays the final result or error when the job ends. Scroll up to read earlier lines without following new output; completed jobs remain available through **View logs**.

Use the theme button to the right of **Settings** to switch between light and dark mode. The portal remembers the choice in your browser and also applies it to the login page.

Use the application's **Logs**, **Exec**, environment-variable, and domain controls to manage it. Redeployment pulls the repository's latest code, prepares service images, and recreates the app's services. Deployment has an interruption; the app becomes `running` after service readiness and HTTP 200 from its assigned domain.

## Optional: private GitHub repositories

Create a GitHub App with repository **Contents: Read-only** permission and set its callback URL to:

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

Copy the generated secret into `GITHUB_STATE_SECRET` before restarting. The key path is the path **inside the portal container**. **Connect GitHub** authenticates in the current tab and returns to the creation form. An existing installation is connected directly, or selected when several are available. If no installation is found, **Install GitHub App** opens in a new tab. The form draft is restored from temporary server memory after OAuth. See [GitHub App setup](docs/github-app-setup.md) for setup and recovery details.

## Local development with Docker

Complete the directory and network preparation above, then use a local `.env` with `PAAS_DOMAIN=localhost`, `PORTAL_COOKIE_SECURE=false`, and all optional GitHub App variables empty. Cloudflare credentials and an ACME email are unnecessary for the HTTP development proxy.

```bash
docker compose --env-file .env -f docker-compose.yml -f docker-compose.dev.yml config --quiet
docker compose --env-file .env -f docker-compose.yml -f docker-compose.dev.yml up -d --build
docker compose --env-file .env -f docker-compose.yml -f docker-compose.dev.yml logs --tail=100 portal traefik
```

The development override sets `RUN_MODE=development`, watches both the Express server and React frontend, and starts its own HTTP Traefik on port **18080**. React source edits rebuild browser assets automatically; reload after the build finishes. The portal's `PORTAL_PORT` (default **3000**) is published on loopback only, so open it at `http://localhost:3000` or `http://portal.localhost:3000`; both addresses serve the same UI without redirecting between hosts, and login sessions belong to the host where you sign in. Applications are available at `http://<user>-<app>.apps.localhost:18080`. If your browser does not resolve these names to loopback, add the individual names to your local hosts file.

The shared application network still needs to exist. Development does not bind ports 80 or 443. Development mode bypasses the mandatory password-change gate. Do not combine the production admin port override with the development override.

## Operations and persistent data

The host checkout stores the following runtime files:

| Path | Contents |
| --- | --- |
| `portal-data/portal.sqlite3` | Users, sessions, jobs and saved output/errors, GitHub installation links, custom domains, and app readiness |
| `portal-data/proxy-settings.json` | Selected proxy profile and connection settings |
| `portal-data/proxy-compose.yml` | Dedicated application proxy Compose generated from saved settings |
| `portal-data/letsencrypt/acme.json` | ACME account and certificates |
| `portal-data/traefik-dynamic/` | Generated custom application-domain routing configuration |
| `portal-data/github-app-private-key.pem` | GitHub App private key, if stored at the example path |
| `apps/<user>/<app>/app/` | Cloned repository source, including `.git` |
| `apps/<user>/<app>/data/` | Persistent bind mounts: `app/` for the default `/data`, or `<volume>/` for each declared logical volume |
| `apps/<user>/<app>/logs/` | Lifecycle script logs |
| `apps/<user>/<app>/.paas-meta.json` | Repository, branch, app identity, saved build/runtime settings, and deployed configuration baseline |
| `apps/<user>/<app>/docker-compose.yml` | Generated application container configuration |
| `apps/<user>/<app>/.paas-project.json` | Atomic active Compose definition, service manifest, and lifecycle state |
| `apps/<user>/<app>/.env.paas` | User-defined application environment variables, when saved |

Back up `.env`, all of `portal-data/`, and all of `apps/`, including hidden files and file ownership/permissions. Use the actual configured paths when overriding `PAAS_ENV_FILE`, `PORTAL_DB_PATH`, or `PAAS_APPS_DIR`. These runtime paths are excluded from Git. SQLite uses WAL mode: stop the portal cleanly before copying its database directory, or use a SQLite backup operation; copying only a live `.sqlite3` file can omit committed data. Finish deployment jobs and stop app writers or use database-native backups before the final data copy. Stopping the portal does not stop user apps.

For a server move, also preserve custom Compose overrides, externally stored credentials, and the server-managed portal proxy's configuration and certificates. External databases need their own backup if they are moving too. App bind mounts contain absolute host paths in `.paas-project.json` and the generated Compose: retain the original host path or regenerate the runtime configuration. Editing only `docker-compose.yml` is insufficient because the project state can restore it. Re-select the proxy connection on the destination when its identity changes, and update DNS to the new server.

Local app images are not included in a directory backup. Transfer them with `docker save`/`docker load` or a registry to preserve the deployed build; a normal redeploy pulls the branch's latest source and rebuilds. In-memory live job buffers and pending OAuth drafts do not survive a restart. Completed job output/errors remain in SQLite subject to the per-user retention limit. Docker container log history is separate from these files; it uses the `json-file` driver with rotation at 10 MB per file and 3 files per container.

For the production stack, use the same Compose files and options as the running deployment, including the admin override if enabled. The following commands show the base portal stack and the dedicated application proxy with the default data path:

```bash
# 포털과 BuildKit 로그를 확인한다.
docker compose --env-file .env -f docker-compose.yml logs -f --tail=100 portal buildkit

# 별도 프록시 프로젝트의 로그를 확인한다.
docker compose --env-file .env --project-directory . -f portal-data/proxy-compose.yml logs -f --tail=100 traefik

# 포털 이미지·설정 변경을 적용한다.
docker compose --env-file .env -f docker-compose.yml up -d --build

# 포털과 BuildKit을 종료한다. 프록시는 별도 프로젝트로 유지된다.
docker compose --env-file .env -f docker-compose.yml down
```

Stop the dedicated proxy separately with `docker compose --env-file .env --project-directory . -f portal-data/proxy-compose.yml down`. An existing shared proxy is managed through its own deployment. Do not remove the application network while it is still used by applications or another proxy.

The portal image pins Node.js 24.22.1. To apply a portal image change, rebuild it and recreate the container using the same Compose files and options as the running deployment. For the base production stack with BuildKit already running:

```bash
# Node 런타임을 갱신한 이미지로 포털만 교체하고 실제 버전을 확인한다.
docker compose --env-file .env -f docker-compose.yml build --pull portal
docker compose --env-file .env -f docker-compose.yml up -d --no-deps --force-recreate portal
docker compose --env-file .env -f docker-compose.yml exec portal node --version
```

Expect `v24.22.1` for the checked-in image. For source-only updates, restarting the portal runs dependency installation and the frontend build from the mounted checkout; it does not update Node itself. Tenant application images have their own runtimes and are not upgraded by rebuilding the portal.

User applications have separate Compose projects and keep running when the platform stack is stopped; manage them through the portal before shutdown if needed. The portal has access to the host Docker socket and BuildKit is privileged, so the platform's administrators control the Docker host.

To run the existing portal test suite with dependencies installed:

```bash
cd portal
npm ci
npm test
```

## Automatic deployment from main

[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) deploys on every push to `main`, including a merged pull request. It runs on the Mini PC itself and updates the existing server checkout, then runs `docker compose stop portal` followed by `docker compose up -d --no-deps --no-build --force-recreate portal`. Only the portal container is recreated; BuildKit, user app projects, and the separate proxy continue running. This deployment has portal downtime.

Configure the following once:

1. Register a Linux **self-hosted runner** on the Mini PC and give it the custom label **`minipc`**. Run it as a service so it is available after reboot.
2. Under **Settings → Secrets and variables → Actions → Secrets**, add the repository secret **`DEPLOY_PATH`** with the existing checkout's absolute path, for example `/home/hyunbae204/work/paas-webapp`. If the deployment uses an override, add **`COMPOSE_OVERRIDE`** under **Variables** with its path relative to the checkout, such as `docker-compose.admin.yml`. Otherwise leave it empty.
3. Keep that checkout on `main` with no tracked changes or local-only commits. Put local Compose changes in an untracked override selected above. The runner's service account needs Git write access to the checkout, noninteractive `git fetch origin main` access, and permission to run Docker without interactive `sudo`.

BuildKit must already be running. The workflow reuses the existing `paas-portal` Compose project name and requires its recorded working directory to match `DEPLOY_PATH`. It refuses Compose configurations containing services other than `portal` and `buildkit`. It retains `.env`, `portal-data/`, `apps/`, untracked files, and named volumes; it does not run `git clean` or `down -v`. Deployment runs are serialized without canceling an active restart. A superseded main revision is skipped, and success requires the portal's internal `/health` response after startup.

This is a source update and restart workflow. It uses the existing portal image; changes to its base image or installed system tools require a separate image rebuild using the commands above. Configure the runner before merging the workflow into `main`; until then it does not deploy from `devel` or feature branches.

If startup fails before `paas-portal` is recreated, the next run cannot inspect its project labels and stops before deployment. Fix the startup error and start the stack manually from the deployment directory with the same Compose project name printed in the failed run, `.env`, and override files, then rerun the workflow. Existing runtime data and volumes remain available.

## Documentation

- [Compose application configuration](docs/compose-apps.md): services, builds, storage, logs, and lifecycle rules.
- [Application proxy setup](docs/proxy-setup.md): administrator access, Traefik integration, networks, and TLS.
- [GitHub App setup](docs/github-app-setup.md): credentials, installation connection, and OAuth recovery.
- [Portal development and APIs](portal/README.md): source layout, development commands, and access rules.

## UI tooling

Layout MCP is configured per project: Claude Code reads the root `.mcp.json`, while Codex reads `.codex/config.toml`. Both configurations use the same stdio command, `npx --yes @layoutdesign/context@0.19.0 serve`. Open the MCP client from the repository root so Layout can load `.layout/layout.md`; trust the project and enable its MCP server when the client requests it, then reload the client's MCP configuration. A root JSON file is only auto-loaded by clients that support that filename.

The upstream [Layout CLI](https://github.com/uselayout/cli) currently publishes as `@layoutdesign/context`; this project pins version `0.19.0`. No global package installation or credentials are required for this project's local design context; Node.js and npm must be available.

## Portal frontend development

The portal uses React, TypeScript and Vite. Express owns authentication, APIs and the page URLs. Unauthenticated visitors go to `/auth` on the same host, and authenticated visitors see the dashboard. Use `portal.<domain>` in production, matching the GitHub App callback host. There is no public landing page or host-based redirect to the portal.

App status is polled every 5 seconds. Jobs are polled every 5 seconds, or every 1.5 seconds while a job is active; hidden tabs pause those polls. These requests update React state without reloading the document. App and job logs use SSE, and Exec uses WebSockets.

The portal has an original neutral light/dark theme with system fonts and the existing Hyunbbai branding. Browser dependency license notices are generated during the build and available through the footer's **Open source licenses** link.

Use Node.js 24.22.1 or a newer 24.x release (the Compose image pins 24.22.1):

```bash
cd portal
npm ci --include=dev
npm start
```

`npm start` and `npm run dev` run the type check and frontend build before starting Express. Compose installs build dependencies even when `NODE_ENV=production`. Generated files in `portal/dist` are not committed; do not run `node server.js` on a clean checkout until `npm run build` succeeds. HTML is never cached, while Vite's hashed assets are cached for a year.

For local development, `npm run dev` watches Express and rebuilds the frontend when files change; reload the browser after the build finishes. This also runs automatically with the Compose development override. `npm run dev:client` remains available when only the frontend watcher is needed. Both browser requests and APIs use the Express origin, including cookies, SSE and terminal WebSockets. The terminal package is bundled locally and loaded when opening Exec.

```bash
npm run typecheck
npm run build
npm test
```
