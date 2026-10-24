# Application proxy setup

The server operator manages the portal as an ordinary web service: its public hostname, reverse proxy and HTTPS are configured outside PaaS. Proxy Setup manages **user application routing only**. It adds the application-network connection while preserving the existing Traefik container, infrastructure networks, certificates and domain rules. The portal route remains server-managed.

## Networks

| Network | Members |
| --- | --- |
| Infrastructure (`infra-proxy`) | Existing Traefik, PaaS portal, existing infrastructure services |
| Application (`paas-app` by default) | Traefik and application web services |
| Each app's private network | That app's web service, workers and databases |

The portal's infrastructure attachment is declared directly in `docker-compose.yml` under `networks.infra.name`. This external network must already exist. Edit that Compose value if the server uses a different name; a separate portal-network environment variable is not required. BuildKit keeps its private network and Unix socket.

Proxy Setup reads the initial application network name from `networks.paas-app.name` in `docker-compose.proxy.yml` (or `docker-compose.dev.yml` in development). These Compose files declare `paas-app`; there is no environment-variable or JavaScript fallback. After saving, the profile supplies the network name for generated app and proxy Compose files. Web services join that network and their own private app network, never the infrastructure network. Workers/databases join only their private app network.

Existing apps must be redeployed when migrating from the infrastructure network or changing their app network. PaaS does not silently restart or disconnect running application containers. Shared app-network membership is not full isolation between untrusted web services; all containers still share the host.

## Portal access and server configuration

The base Compose publishes no host ports. The existing server proxy can reach `paas-portal:3000` through `infra-proxy` (use the configured internal `PORTAL_PORT` if different). The server operator supplies the portal route and certificate. For local administration or a host reverse proxy upstream, optionally expose the portal on loopback:

```bash
docker compose --env-file .env -f docker-compose.yml -f docker-compose.admin.yml up -d
```

This maps `127.0.0.1:PORTAL_ADMIN_PORT` (default `3000`) to the internal `PORTAL_PORT`. A reverse proxy running on the host can forward the portal hostname to this upstream. A containerized server proxy can use the portal container on the shared infrastructure network; its `localhost` refers to itself, not the Docker host. Keep web applications on the separate application network.

For remote administration, run this on your workstation and visit `http://localhost:13000`:

```bash
ssh -N -L 13000:127.0.0.1:3000 user@server
```

Sign in as administrator, change the initial password, and open **Admin Dashboard → Proxy Setup**. Configure the public portal reverse proxy and TLS on the server independently. Preserve the existing portal hostname used by authentication callbacks. If the host reverse proxy uses the loopback mapping, keep the admin override applied; removing it removes that upstream.

## Use an existing Traefik

1. Discover and select the running Traefik. The page shows its running state, without requiring its launch method.
2. Choose a separate **Application-only network**, normally `paas-app`. Do not select `infra-proxy` or another infrastructure network already used by the proxy.
3. Enter the existing entrypoint and certificate resolver names. PaaS references these settings without changing them.
4. Use **Save and connect**. PaaS creates the application bridge network if needed, labels it as PaaS-owned, and attaches the existing Traefik using its container ID. Docker Engine 28+ (API 1.48+) is required for a new attachment so a lower gateway priority preserves the proxy's existing default route.
5. Deploy or redeploy apps. Their generated Compose connects only web services to the application network and includes the matching `traefik.docker.network` label.

The proxy's existing networks, name, image, ports, mounts, domain rules and certificate configuration are retained. PaaS neither recreates the proxy nor rewrites its Compose/YAML source. New attachment is refused for incompatible network modes, networks owned by another PaaS instance, or networks containing unrelated services. A failed save may leave an empty application network or a completed attachment; retrying is idempotent and does not remove existing connections.

The proxy's Docker provider must allow PaaS web-service labels. An operator-defined constraint that excludes them must be adjusted by that operator. Do not run the dedicated proxy Compose when reusing an existing proxy.

For custom application domains, the existing file provider must watch the PaaS dynamic directory (`portal-data/traefik-dynamic`). Mount the whole directory at the watched root, not a nested directory or an individual file. Traefik v3.6 does not reliably watch nested directories, and PaaS replaces its file atomically. Preserve all pre-existing route files when configuring a shared watched directory. PaaS owns `custom-domains.yml` in its own dynamic directory; do not replace an unrelated file with that name. This file now contains application domains only, never portal routes.

Application network attachment and routing labels are part of the generated app Compose files. The only change made to the existing Traefik container is adding its application-network connection.

## Status and dependency checks

The portal checks the saved connection at startup and every 30 seconds. The page shows the selected proxy's running state and any required action. After an explicit **Save and connect**, it also restores a lost application-network attachment when it recognizes a recreated proxy. It does not start a stopped proxy.

Recognition uses the saved container name and Compose project/service labels when available. For containers without Compose labels, the original ID or a matching SHA-256 fingerprint of the image and creation settings is used; secret values are not stored in the profile. A replacement with different ownership or different standalone creation settings requires the administrator to select it and save again. Previously saved profiles without this authorization record are checked read-only until saved again.

The recovery interval can leave a short connection gap after proxy recreation, and recovery pauses while the portal is stopped. Operators who need the attachment independently of portal availability can include the application network in their own proxy deployment, using a lower gateway priority. PaaS never edits that deployment file. Switching profiles does not detach a previous proxy's networks.

Checks also report web services still sharing the infrastructure network and app services that need redeployment. **Check connection** remains read-only and examines providers, entrypoints and certificate settings where visible. It does not depend on portal reachability or replace a public application HTTP/TLS test. File-provider setup is required for custom domains; default application domains use Docker labels.

## Install a dedicated application proxy

If there is no existing proxy, the new-Traefik profile generates `portal-data/proxy-compose.yml`. It handles application traffic only. Create its selected external network and follow the generated command in the page. Its separate `paas-edge` project owns host ports 80/443; those ports must be available. Do not combine it with the base portal Compose or start it alongside another proxy using those ports.

## Certificate authorities and identifiers

New proxy profiles offer **Let’s Encrypt**, **ZeroSSL**, or a **custom ACME CA**. Presets select their ACME directory URL; custom CAs require an HTTPS directory URL without credentials or query parameters. The email is stored with the profile; leaving it blank uses `ACME_EMAIL` from the server `.env` when Compose runs. The generated configuration keeps Cloudflare DNS-01 for application domains and HTTP-01 on `web` for custom domains. The chosen CA must support these challenges and wildcard certificates. Development uses HTTP through `docker-compose.dev.yml` and does not generate a production ACME configuration.

ZeroSSL requires EAB. A custom CA can also enable EAB. Supply `ACME_EAB_KID` and `ACME_EAB_HMAC` in the server `.env`; the generated Compose uses environment references, never the credential values. `CF_DNS_API_TOKEN` remains in the server environment too. EAB is passed to both resolvers; if a CA requires separate account credentials, manage its resolvers externally instead.

The **식별자** group contains the routing entrypoint and the two certificate resolver names. In a new profile, these names define identifiers in the generated Traefik configuration and update all matching references; their spelling does not choose the CA or challenge. DNS-01 and HTTP-01 resolvers must have different names. `web` is reserved for port 80, so the HTTPS entrypoint needs another name. Generated identifiers start with a letter and contain letters, numbers, underscores or hyphens, up to 63 characters.

In an existing profile, the same fields reference names already defined by its operator. Renaming only the portal references does not create or rename Traefik configuration. The selected container’s image is displayed for information. Discovery displays public CA directory and challenge information where visible in container flags or environment variables. It never returns DNS tokens or EAB credentials, and configuration defined only in static files is reported as unknown. An absent visible CA URL is reported as unknown; Let’s Encrypt is the Traefik default only when no override exists elsewhere.

## Upgrade from portal-managed ingress

Before updating, configure the portal's public reverse proxy and HTTPS on the server. Deploying this change removes the PaaS-generated portal route from `custom-domains.yml`; without a server-managed replacement, the old portal address will stop working. The loopback admin path remains available.

Recreate the portal with the updated base Compose to place it on `infra-proxy`, after verifying the external infrastructure network exists. Remove obsolete `APP_NETWORK` and `PORTAL_NETWORK` entries from `.env`; neither is read, even as a fallback. Choose the infrastructure network in Compose instead. Select the existing application proxy and network, then redeploy apps whose stored network or proxy labels differ. Existing application data and the external proxy's routing/certificate files are retained. Never use a whole-stack teardown to migrate an unrelated proxy.

Development also attaches the portal to the external infrastructure network, exposes the portal on loopback and the app proxy on host port `18080`. The portal reaches that development proxy via `host.docker.internal:18080`, using the host-gateway mapping; it does not share the proxy network. Create the external `paas-app` network before running the development override.
