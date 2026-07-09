import { NextRequest } from "next/server";
import { getRuntime } from "@/lib/portal/runtime";
import { ok, handleRoute, requireAuth, requirePasswordUpdated } from "@/lib/portal/http";

type Params = { id: string };
type Ctx = { params: Promise<Params> };

export const POST = handleRoute<Ctx>(async (req: NextRequest, { params }) => {
  const auth = await requireAuth(req);
  requirePasswordUpdated(auth);
  const runtime = await getRuntime();

  const data = await runtime.jobsHandlers.cancelJob({ auth, params: await params });
  return ok(data);
});
