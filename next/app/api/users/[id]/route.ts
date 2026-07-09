import { NextRequest } from "next/server";
import { getRuntime } from "@/lib/portal/runtime";
import { ok, handleRoute, readJsonBody, requireAuth, requireAdmin, requirePasswordUpdated } from "@/lib/portal/http";

type Params = { id: string };
type Ctx = { params: Promise<Params> };

export const DELETE = handleRoute<Ctx>(async (req: NextRequest, { params }) => {
  const auth = await requireAuth(req);
  requireAdmin(auth);
  requirePasswordUpdated(auth);
  const runtime = await getRuntime();
  const body = await readJsonBody(req);

  const data = runtime.usersHandlers.deleteUser({ auth, params: await params, body });
  return ok(data);
});
