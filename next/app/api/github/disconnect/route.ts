import { NextRequest } from "next/server";
import { getRuntime } from "@/lib/portal/runtime";
import { ok, handleRoute, requireAuth, requirePasswordUpdated } from "@/lib/portal/http";

export const POST = handleRoute(async (req: NextRequest) => {
  const auth = await requireAuth(req);
  requirePasswordUpdated(auth);
  const runtime = await getRuntime();

  const data = runtime.githubHandlers.disconnect({ auth });
  return ok(data);
});
