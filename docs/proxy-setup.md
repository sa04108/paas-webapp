# Application proxy setup

The server operator manages the portal as an ordinary web service: its public hostname, reverse proxy and HTTPS are configured outside PaaS. Proxy Setup manages **user application routing only**. It does not register a portal route, replace an existing Traefik, change its networks or manage its certificates and domain rules.

## Networks

- The portal joins its own `PORTAL_NETWORK` (default `paas-portal`). BuildKit uses its separate network and shared Unix socket.
- Each application has a private network for its web service, workers and databases.
- Only the web service also joins the selected application proxy network, which must already be connected to Traefik. New application Compose files include this attachment and the explicit `traefik.docker.network` label, so recreation preserves the connection.
- Workers and databases do not join the proxy network. The portal does not join it either.

Web services share the proxy network with other web services. This arrangement separates the portal and private app services; it does not provide full isolation between untrusted web containers or from the shared Docker host.

`APP_NETWORK` supplies the initial/default app proxy network name (`paas-app`). The network selected and saved in Proxy Setup takes precedence for generated application deployments. Use a different name from `PORTAL_NETWORK` and the BuildKit network. Existing applications must be redeployed after changing the network; editing a saved profile does not mutate their running containers or labels.

## Portal access and server configuration

The base Compose publishes no host ports. For local administration or a host reverse proxy upstream, expose the portal on loopback:

```bash
docker compose --env-file .env -f docker-compose.yml -f docker-compose.admin.yml up -d
```

This maps `127.0.0.1:PORTAL_ADMIN_PORT` (default `3000`) to the internal `PORTAL_PORT`. A reverse proxy running on the host can forward the portal hostname to this upstream. A containerized server proxy needs its own operator-managed upstream connection; its `localhost` refers to that proxy container, not the Docker host. Keep the application proxy network separate from the portal.

For remote administration, run this on your workstation and visit `http://localhost:13000`:

```bash
ssh -N -L 13000:127.0.0.1:3000 user@server
```

Sign in as administrator, change the initial password, and open **Admin Dashboard → Proxy Setup**. Configure the public portal reverse proxy and TLS on the server independently. Preserve the existing portal hostname used by authentication callbacks. If the host reverse proxy uses the loopback mapping, keep the admin override applied; removing it removes that upstream.

## Use an existing Traefik

1. Discover and select the running Traefik. Its launch method is irrelevant: both Compose and directly created containers work.
2. Select one of its existing, user-defined bridge networks as the **Application connection network**. The page suggests the network when there is one suitable candidate. The selected network must be separate from the portal.
3. Enter the existing entrypoint and certificate resolver names. These reference settings already owned by the proxy operator; saving does not change them.
4. Save, check the connection, and deploy or redeploy applications. PaaS generates Docker labels for their default domains and attaches only their web services to the selected network.

The existing proxy must have a Docker provider whose constraints allow `paas.type=user-app`. An operator-defined constraint that excludes these containers must be adjusted by that operator. Do not run `docker-compose.proxy.yml` when reusing a proxy.

For custom application domains, the existing file provider must watch the PaaS dynamic directory (`portal-data/traefik-dynamic`). Mount the whole directory at the watched root, not a nested directory or an individual file. Traefik v3.6 does not reliably watch nested directories, and PaaS replaces its file atomically. Preserve all pre-existing route files when configuring a shared watched directory. PaaS owns `custom-domains.yml` in its own dynamic directory; do not replace an unrelated file with that name. This file now contains application domains only, never portal routes.

Network attachment and labels are part of the generated application Compose files. The portal never edits an unrelated proxy's Compose/YAML files, stops it, changes its image or joins it to another network.

## Status and dependency checks

The portal checks the selected proxy and app connections at startup and every 30 seconds. The page shows **Running / Stopped / Status unavailable** and whether attention is needed. Checks are read-only. They detect a stopped/missing proxy, missing network, portal network sharing, app web services that need redeployment, and workers incorrectly attached to the proxy network.

Proxy recreation normally needs no PaaS repair because the web services already belong to the network retained by the proxy operator. Keep this shared network outside a proxy-only teardown lifecycle where possible. If the operator changes the network or container name, update the profile and redeploy affected applications. A failure does not stop apps or prevent portal administration.

**Check connection** also examines provider, entrypoint and certificate settings where visible. It does not rely on portal reachability, and does not claim a public application HTTP/TLS probe has passed. Validate each application's public URL after deployment. File-provider setup is required for custom domains; default application domains are discovered through Docker labels.

## Install a dedicated application proxy

If there is no existing proxy, the new-Traefik profile generates `portal-data/proxy-compose.yml`. It handles application traffic only. Create its selected external network and follow the generated command in the page. Its separate `paas-edge` project owns host ports 80/443; those ports must be available. Do not combine it with the base portal Compose or start it alongside another proxy using those ports.

## Certificate authorities and identifiers

New proxy profiles offer **Let’s Encrypt**, **ZeroSSL**, or a **custom ACME CA**. Presets select their ACME directory URL; custom CAs require an HTTPS directory URL without credentials or query parameters. The email is stored with the profile; leaving it blank uses `ACME_EMAIL` from the server `.env` when Compose runs. The generated configuration keeps Cloudflare DNS-01 for application domains and HTTP-01 on `web` for custom domains. The chosen CA must support these challenges and wildcard certificates. Development uses HTTP through `docker-compose.dev.yml` and does not generate a production ACME configuration.

ZeroSSL requires EAB. A custom CA can also enable EAB. Supply `ACME_EAB_KID` and `ACME_EAB_HMAC` in the server `.env`; the generated Compose uses environment references, never the credential values. `CF_DNS_API_TOKEN` remains in the server environment too. EAB is passed to both resolvers; if a CA requires separate account credentials, manage its resolvers externally instead.

The **식별자** group contains the routing entrypoint and the two certificate resolver names. In a new profile, these names define identifiers in the generated Traefik configuration and update all matching references; their spelling does not choose the CA or challenge. DNS-01 and HTTP-01 resolvers must have different names. `web` is reserved for port 80, so the HTTPS entrypoint needs another name. Generated identifiers start with a letter and contain letters, numbers, underscores or hyphens, up to 63 characters.

In an existing profile, the same fields reference names already defined by its operator. Renaming only the portal references does not create or rename Traefik configuration. The selected container’s image is displayed for information. Discovery displays public CA directory and challenge information where visible in container flags or environment variables. It never returns DNS tokens or EAB credentials, and configuration defined only in static files is reported as unknown. An absent visible CA URL is reported as unknown; Let’s Encrypt is the Traefik default only when no override exists elsewhere.

## Upgrade from portal-managed ingress

Before updating, configure the portal's public reverse proxy and HTTPS on the server. Deploying this change removes the PaaS-generated portal route from `custom-domains.yml`; without a server-managed replacement, the old portal address will stop working. The loopback admin path remains available.

Recreate the portal with the updated base Compose to move it off the shared app network. Select the existing application proxy and network, then redeploy apps whose stored network or proxy labels differ. Existing application data and the external proxy's routing/certificate files are retained. Never use a whole-stack teardown to migrate an unrelated proxy.

Development keeps the portal on loopback and the app proxy on host port `18080`. The portal reaches that development proxy via `host.docker.internal:18080`, using the host-gateway mapping; it does not share the proxy network. Create the external `APP_NETWORK` before running the development override.
