import { NextRequest } from "next/server";
import { getRuntime } from "@/lib/portal/runtime";
import { ok, handleRoute, requireAuth, requireAdmin, requirePasswordUpdated } from "@/lib/portal/http";

type Params = { id: string };
type Ctx = { params: Promise<Params> };

export const PATCH = handleRoute<Ctx>(async (req: NextRequest, { params }) => {
  const auth = await requireAuth(req);
  requireAdmin(auth);
  requirePasswordUpdated(auth);
  const runtime = await getRuntime();

  const data = runtime.usersHandlers.updateUserRole({ auth, params: await params });
  return ok(data);
});
