import { getRuntime } from "@/lib/portal/runtime";
import { ok, handleRoute } from "@/lib/portal/http";

export const GET = handleRoute(async () => {
  const runtime = await getRuntime();
  const { config, IS_DEV } = runtime;

  return ok({
    domain: config.PAAS_DOMAIN,
    appsDomain: `apps.${config.PAAS_DOMAIN}`,
    devMode: IS_DEV,
    traefikPort: IS_DEV ? config.TRAEFIK_HOST_PORT : null,
    limits: {
      maxAppsPerUser: config.MAX_APPS_PER_USER,
      maxTotalApps: config.MAX_TOTAL_APPS,
    },
    auth: runtime.authService.getPublicConfig(),
  });
});
