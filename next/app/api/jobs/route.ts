import { NextRequest } from "next/server";
import { getRuntime } from "@/lib/portal/runtime";
import { ok, handleRoute, requireAuth, requirePasswordUpdated } from "@/lib/portal/http";

export const GET = handleRoute(async (req: NextRequest) => {
  const auth = await requireAuth(req);
  requirePasswordUpdated(auth);
  const runtime = await getRuntime();

  const data = runtime.jobsHandlers.listJobs({ auth });
  return ok(data);
});

export const DELETE = handleRoute(async (req: NextRequest) => {
  const auth = await requireAuth(req);
  requirePasswordUpdated(auth);
  const runtime = await getRuntime();

  const data = runtime.jobsHandlers.deleteCompletedJobs({ auth });
  return ok(data);
});
