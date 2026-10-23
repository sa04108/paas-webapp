# Proxy setup

The portal stack and public ingress have separate Compose lifecycles. The base `docker-compose.yml` starts only the portal and BuildKit and publishes no host ports. Create the external `APP_NETWORK` before starting the portal. Choose and configure ingress in the admin-only **Admin Dashboard → Proxy Setup** page after changing the bootstrap administrator password.

## Open the admin setup page safely

On the server, expose the portal only on loopback by applying the admin override:

```bash
docker compose --env-file .env -f docker-compose.yml -f docker-compose.admin.yml up -d
```

The override maps `PORTAL_ADMIN_PORT` (default `3000`) on `127.0.0.1` to the portal's internal `PORTAL_PORT`. From your workstation, open an SSH tunnel:

```bash
ssh -N -L 13000:127.0.0.1:3000 user@server
```

Then visit `http://localhost:13000`. Sign in as the administrator, change the initial password, and open `/admin/proxy`. The loopback mapping is not public; keep SSH access restricted to trusted administrators. Chromium treats `localhost` as a secure context, so the production secure session cookie remains enabled.

When setup is complete, remove the host binding by reconciling with the base Compose file:

```bash
docker compose --env-file .env -f docker-compose.yml up -d
```

This recreates the portal without the admin override's published port. The production portal remains reachable over HTTPS through the configured reverse proxy and returns HTTP 200 from `https://portal.example.com/health` once DNS and certificate issuance are ready.

## Choose an integration

The setup page offers two profiles:

- **Install a new Traefik** uses the supplied `docker-compose.proxy.yml` as a separate Compose project named `paas-edge`. After saving its settings, start or update it independently:

  ```bash
  docker compose --env-file .env -f docker-compose.proxy.yml up -d
  ```

  Do not combine `docker-compose.proxy.yml` with `docker-compose.yml`. The proxy project owns ports 80/443, has its own lifecycle, and joins the same external `APP_NETWORK` as application web containers and the portal. Configure DNS, ACME credentials, firewall, and certificates for your domain before relying on public HTTPS.

- **Use existing Traefik** records the external Traefik container, entrypoint, and certificate resolvers for portal and app routing. The container and portal must share `APP_NETWORK`; the proxy must be able to read the portal's dynamic configuration directory. The generated routes need compatible entrypoint and resolver names. The portal does not modify or restart an external proxy. Apply the network, dynamic-directory mount, provider, and entrypoint changes described by the guide manually, then run **Check connection** to verify the integration.

For a direct existing-Traefik integration, mount the **entire** PaaS routing directory at the root directory configured by Traefik's watched file provider. For example, mount the host `portal-data/traefik-dynamic` directory as `/traefik-dynamic` and set `providers.file.directory=/traefik-dynamic` with file watching enabled. Do not mount it as a nested subdirectory under another provider directory or mount only `custom-domains.yml`: Traefik v3.6 does not watch nested directories, and the portal replaces that file atomically when rebuilding routes.

Before changing an existing proxy's mount, back up its current file-provider directory and preserve or consolidate every existing route file into the one common watched directory. A bind mount can hide files already present at the container mount target. The portal owns the filename `custom-domains.yml`; ensure no existing file with that name contains routes that need to be retained, and merge/rename those routes before connecting the portal. If you cannot arrange a single common watched root without hiding or replacing existing configuration, direct integration is not ready. The portal will not restart the proxy automatically; the proxy owner must apply any configuration or mount changes and manage its lifecycle.

The page displays the base domain, Docker network, portal container and internal port, and dynamic config directory as read-only deployment settings. The portal address is `portal.<base-domain>`; the base domain itself is not redirected to the portal. Change these values in the deployment environment and recreate the portal if they need to change. Saved profile data is stored in `portal-data/proxy-settings.json`; keep this file with the portal data backup. Saving a profile does not automatically start a proxy or run a health check on every Compose start. Use **Check connection** for a read-only check when you make changes.

The **Install a new Traefik** profile means you will run the supplied standalone Compose project yourself; saving does not start or restart it. **Check connection** on unsaved settings checks the container configuration and skips route checks until you save. Routing uses HTTPS in production and HTTP in development; production commonly uses the `websecure` entrypoint, while the development proxy uses `web`.

Application routing settings such as entrypoint and certificate resolvers are copied into newly generated app routes. Portal and custom-domain routes update through the dynamic file provider after saving. Existing application routes keep their current labels until those apps are redeployed. A proxy warning does not block normal portal management, so administrators can return to `/admin/proxy` and repair a degraded integration.

Nginx Proxy Manager does not consume Traefik Docker labels or the portal's Traefik file-provider configuration and is not a direct integration. An NPM deployment needs a compatible Traefik layer or a separate routing integration; do not select an NPM container as if it were Traefik.

## Network and local development

Create the external application network before launching either the portal or proxy. Use the same name configured by `APP_NETWORK` in `.env`:

```bash
docker network inspect paas-app >/dev/null 2>&1 || docker network create paas-app
```

Production base Compose publishes no host ports. The admin override publishes only the portal on loopback. Development uses `docker-compose.dev.yml`, publishes the portal on loopback, and starts a separate HTTP Traefik on port `18080`; it does not bind 80/443. Do not combine the admin override with the development override because both use the portal's loopback host port by default.

## Migrating an existing deployment

Older versions of the base Compose file included a Traefik service named `paas-proxy`, published ports 80/443, and attached routing labels to the portal. The new base file no longer owns that proxy. Before starting the separate `paas-edge` project, stop and remove only the old PaaS Traefik service using the old Compose definition. It reserves the same container name and public ports as the new proxy project. Do not stop or remove a proxy managed by another stack.

Keep `portal-data/letsencrypt/acme.json` and its directory intact so existing certificates and ACME account state are preserved. Do not run `docker compose down` as a shortcut: the application network is external and may be shared with running app containers or another proxy. Recreate the portal with the new base file to remove old Traefik labels and any former direct host binding:

```bash
docker compose --env-file .env -f docker-compose.yml up -d --force-recreate portal
```

Then configure `/admin/proxy` through the loopback override, start the selected proxy project if needed, and verify `https://portal.example.com/health`. Existing app containers may need redeployment if their entrypoint or certificate resolver labels differ from the new settings.
