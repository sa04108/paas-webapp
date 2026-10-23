# Hyunbbai PaaS

Hyunbbai PaaS is a self-hosted platform for deploying GitHub repositories as Docker containers on a single server. It brings source builds, application lifecycle management, HTTPS routing, logs, and an interactive container terminal into one web portal.

## Features

- Deploy a public GitHub repository by providing its URL, application name, and branch; the default branch is `main`.
- Build automatically, select a root-level Dockerfile from GitHub, or write a custom Dockerfile in the app creation form.
- Deploy multiple services from Compose YAML, with registry images, service Dockerfiles, or a shared Railpack image.
- Start, stop, redeploy, and delete whole application projects from the dashboard.
- Inspect container logs with automatic refresh and open an interactive browser terminal.
- Edit application environment variables and recreate the container to apply them.
- Assign each application a subdomain and attach custom domains with CNAME verification.
- Manage users, application ownership, administrator access, and application count limits.
- Track background operations with job status, streamed build/deployment output, and retry controls.
- Deploy private repositories through an optional GitHub App integration.

## Core ideas

### Containerize each user's application

Each application is one Docker Compose project containing its web service, workers, and initialization jobs. Services have separate filesystems and process namespaces; application data stays under that application's data directory. CPU and memory limits apply to the combined services. Application containers do not receive the host Docker socket. The portal owns project names, container identities, routing, networks, and ownership labels. See [Compose application configuration](docs/compose-apps.md) for the supported YAML fields and KTX example.

Workers use a private application network; only the web service also joins `paas-app` for proxy routing. Web services still share this network with other web services, the portal, and proxy, so isolation between users is incomplete. The Docker daemon and host remain shared. BuildKit runs on a separate network and exposes only a Unix socket shared with the portal. See the [security review](docs/security-threats.md) for remaining work.

### Bring Portainer-inspired logs and exec into the portal

The management experience takes inspiration from Portainer: users can inspect application output and execute commands inside a running container without leaving the dashboard. Logs use Docker's container output with periodic refresh. The exec view uses xterm.js, WebSockets, and Docker's TTY exec API to relay keyboard input, terminal output, and resize events. Access is checked against the session and application owner; administrators can access other users' applications.

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

Build and runtime choices are saved with repository metadata in the application's `.paas-meta.json` outside its cloned source before building, so failed applications remain manageable. Custom Dockerfiles are materialized outside the cloned source. Services without `image`/`build`, or using `${PAAS_APP_IMAGE}`, share this build; services with their own registry image or Dockerfile are prepared separately. Operations on the same app run in order. This release does not migrate existing application layouts.

For an existing app, open **Settings**, load or edit its build configuration, and choose **Save build settings**. Saving preserves the running container; changes apply on the next **Redeploy**. Dockerfile lookup uses the app's stored repository and branch, including the owner's GitHub App connection when an administrator edits another user's app.

The portal's runtime detector provides Node.js framework and dependency badges for the UI; Railpack performs the actual automatic build detection. Successful deployment still requires a supported project with a working startup command and an HTTP server listening on `0.0.0.0:5000` (the platform supplies `PORT=5000`).

### Route applications through a reverse proxy

Application containers do not publish individual host ports. The portal stack (`docker-compose.yml`) does not bind public ports; attach a Traefik proxy to the external `APP_NETWORK` and configure it to route application and portal traffic. The supplied Traefik stack is a separate Compose project (`docker-compose.proxy.yml`), so it can be started or managed independently. The admin-only Proxy setup screen explains the managed Traefik and existing Traefik profiles. Nginx Proxy Manager is not currently supported as a direct integration.

```text
GitHub repository -> clone -> Compose validation -> Railpack / Dockerfile / image pull -> app services
Browser -> reverse proxy -> portal or application
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
| Routing and TLS | Traefik 3.6 (optional supplied stack), Let's Encrypt, Cloudflare DNS-01, HTTP-01 |
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

Node.js and Railpack do not need to be installed on the host for the Compose workflow: the portal image installs its own tools. For direct portal development, use Node.js 22.12 or later.

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
| `example.com` | A | Optional CNAME target for the portal DNS record |
| `portal.example.com` | A, or CNAME to `example.com` | Management portal |
| `*.apps.example.com` | A, or CNAME to `example.com` | Application subdomains |

For the supplied Traefik stack, start with DNS-only records so requests reach the proxy directly. Create a Cloudflare API token with **Zone / Zone / Read** and **Zone / DNS / Edit** permissions for the relevant zone and assign it to `CF_DNS_API_TOKEN`. These are the permissions documented by the [Cloudflare ACME provider](https://go-acme.github.io/lego/dns/cloudflare/#api-tokens).

The production portal is served at `portal.example.com`. The root domain has no portal router or redirect to the portal; its DNS record is only needed if another record uses it as a CNAME target.

If using the supplied Traefik stack, allow inbound TCP ports **80** and **443** through the host firewall and any router/NAT. Port 80 is needed for custom-domain HTTP-01 challenges and HTTP-to-HTTPS redirects. The portal listens on `PORTAL_PORT` (default **3000**) inside Docker. The base portal Compose file publishes no host ports; the proxy reaches the portal over `APP_NETWORK`.

If you use custom domains, their generated CNAME targets have the form `<app>-<random>.example.com`. Make those target names resolve to this server by adding individual DNS records or an additional `*.example.com` wildcard record. The `*.apps.example.com` record alone does not cover these targets.

### 3. Create the shared Docker network

The application network is declared external, so it must exist before starting the stack. Use the same name as `APP_NETWORK` in `.env`:

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

The first start builds the portal image, installs dependencies with `npm ci`, and starts `paas-portal` and `paas-buildkit`. Set up ingress after signing in through the loopback admin access described in [proxy setup](docs/proxy-setup.md). For the supplied Traefik, start its separate project with:

```bash
docker compose --env-file .env -f docker-compose.proxy.yml up -d
```

Do not combine `docker-compose.proxy.yml` with the base file: it has its own `paas-edge` project lifecycle. After DNS and certificate issuance are ready, verify the public portal:

```bash
curl --fail https://portal.example.com/health
```

Replace `portal.example.com` with your configured portal hostname. `PORTAL_PORT` changes the portal's internal listener and proxy target; it is not a published host port. Certificate issuance can take additional time; inspect the relevant proxy logs if HTTPS is not yet available. The selected proxy profile and connection settings are stored in `portal-data/proxy-settings.json`.

To configure ingress, sign in as the bootstrap administrator, change the default password, then open **Admin Dashboard → Proxy Setup**. The setup page is available again at `/admin/proxy`; its connection check is read-only. Saved portal and custom-domain routes update immediately through the dynamic file provider, while changes to application entrypoints or certificate resolvers require redeploying those applications. Details and SSH access steps are in [proxy setup](docs/proxy-setup.md).

When upgrading an older deployment, recreate the portal to remove its previous proxy labels or port binding. If the old Compose definition includes a `traefik` service, stop and remove only that PaaS proxy before starting the new `paas-edge` project; preserve `portal-data/letsencrypt/acme.json`. Do not run `docker compose down` against a shared external network or stop/remove an unrelated proxy. Follow the [migration instructions](docs/proxy-setup.md#migrating-an-existing-deployment).

### 5. Sign in and deploy the first application

Open `https://portal.example.com` and sign in with **`admin` / `admin`**. On a new database, the bootstrap account is created automatically. Production mode requires changing its password before protected operations become available. Administrators can then create additional users.

Create an application using a repository URL and branch, then choose automatic detection, an existing root Dockerfile, a custom Dockerfile, or Railpack. The dropdown lookup supports GitHub repositories; automatic and custom builds also retain support for other repository URLs accepted by the platform. A repository that follows Railpack's supported build conventions does not need a custom Dockerfile or platform-specific build configuration. Its HTTP server must bind to `0.0.0.0` and use `PORT=5000`; this also applies when supplying your own Dockerfile. Persistent application files belong in `/data`.

An application named `demo` owned by `admin` is served at:

```text
https://admin-demo.apps.example.com
```

Open **Jobs** and select **Live logs** on a pending or running job to watch build and deployment output as it arrives. The log window reconnects after temporary connection loss and displays the final result or error when the job ends. Scroll up to read earlier lines without following new output; completed jobs remain available through **View logs**.

Use the theme button to the right of **Settings** to switch between light and dark mode. The portal remembers the choice in your browser and also applies it to the login page.

Use the application's **Logs**, **Exec**, environment-variable, and domain controls to manage it. Redeployment pulls the repository's latest code, rebuilds the image, and replaces the container; the current implementation has a brief interruption while the container is recreated.

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

The development override sets `RUN_MODE=development`, watches both the Express server and React frontend, and starts its own HTTP Traefik on port **18080**. React source edits rebuild browser assets automatically; reload after the build finishes. The portal's `PORTAL_PORT` (default **3000**) is published on loopback only, so open it at `http://localhost:3000` or `http://portal.localhost:3000`; both addresses serve the same UI without redirecting between hosts, and login sessions belong to the host where you sign in. Applications are available at `http://<user>-<app>.apps.localhost:18080`. If your browser does not resolve these names to loopback, add the individual names to your local hosts file.

The shared application network still needs to exist. Development does not bind ports 80 or 443. Development mode bypasses the mandatory password-change gate. Do not combine the production admin port override with the development override.

## Operations and persistent data

The host checkout stores the following runtime files:

| Path | Contents |
| --- | --- |
| `portal-data/portal.sqlite3` | Users, sessions, jobs, GitHub installation links, and custom-domain metadata |
| `portal-data/proxy-settings.json` | Selected proxy profile and connection settings |
| `portal-data/letsencrypt/acme.json` | ACME account and certificates |
| `portal-data/traefik-dynamic/` | Generated portal and custom-domain routing configuration |
| `apps/<user>/<app>/app/` | Cloned repository source |
| `apps/<user>/<app>/data/` | Application files mounted at `/data` |
| `apps/<user>/<app>/logs/` | Lifecycle script logs |
| `apps/<user>/<app>/docker-compose.yml` | Generated application container configuration |
| `apps/<user>/<app>/.paas-project.json` | Atomic active Compose definition, service manifest, and lifecycle state |
| `apps/<user>/<app>/.env.paas` | User-defined application environment variables, when saved |

Back up `.env`, `portal-data/`, and application data with a consistent SQLite backup. These runtime paths are excluded from Git. Application logs use Docker's `json-file` driver with rotation at 10 MB per file and 3 files per container.

For the production stack:

```bash
# 포털과 BuildKit 로그를 확인한다.
docker compose --env-file .env -f docker-compose.yml logs -f --tail=100 portal buildkit

# 별도 프록시 프로젝트의 로그를 확인한다.
docker compose --env-file .env -f docker-compose.proxy.yml logs -f --tail=100 traefik

# Apply platform configuration or image changes.
docker compose --env-file .env -f docker-compose.yml up -d --build

# 포털과 BuildKit을 종료한다. 프록시는 별도 프로젝트로 유지된다.
docker compose --env-file .env -f docker-compose.yml down
```

Stop the supplied proxy separately with `docker compose --env-file .env -f docker-compose.proxy.yml down`. Do not remove the external `APP_NETWORK`; it may still be used by running applications or another proxy.

User applications have separate Compose projects and keep running when the platform stack is stopped; manage them through the portal before shutdown if needed. The portal has access to the host Docker socket and BuildKit is privileged, so the platform's administrators control the Docker host.

To run the existing portal test suite with dependencies installed:

```bash
cd portal
npm ci
npm test
```

Additional documentation: [GitHub App setup](docs/github-app-setup.md), [security review](docs/security-threats.md), and [GitHub Actions deployment design notes](docs/github-actions-deploy.md).

## UI tooling

Layout MCP is configured per project: Claude Code reads the root `.mcp.json`, while Codex reads `.codex/config.toml`. Both configurations use the same stdio command, `npx --yes @layoutdesign/context@0.19.0 serve`. Open the MCP client from the repository root so Layout can load `.layout/layout.md`; trust the project and enable its MCP server when the client requests it, then reload the client's MCP configuration. A root JSON file is only auto-loaded by clients that support that filename.

The upstream [Layout CLI](https://github.com/uselayout/cli) currently publishes as `@layoutdesign/context`; this project pins version `0.19.0`. No global package installation or credentials are required for this project's local design context; Node.js and npm must be available.

In the managed cloud environment, global Codex configuration is read-only. Use the prepared `/workspace/.tools/codex-with-layout` launcher to enable Layout for a Codex CLI session without changing the managed configuration. Reload the MCP client after changing its project configuration.

## Portal frontend development

The portal uses React, TypeScript and Vite. Express owns authentication, APIs and the page URLs. Unauthenticated visitors go to `/auth` on the same host, and authenticated visitors see the dashboard. There is no public landing page or redirect between the root domain and the portal. Use `portal.<domain>` in production, matching the GitHub App callback host. See [the migration design](docs/react-portal.md) and [UI/UX audit](docs/ui-ux-audit.md).

The portal has an original neutral light/dark theme with system fonts and the existing Hyunbbai branding. Browser dependency license notices are generated during the build and available through the footer's **Open source licenses** link.

Use Node.js 22.12+ (the Compose image uses Node 22):

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
