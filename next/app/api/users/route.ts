import { NextRequest } from "next/server";
import { getRuntime } from "@/lib/portal/runtime";
import { ok, handleRoute, readJsonBody, requireAuth, requireAdmin, requirePasswordUpdated } from "@/lib/portal/http";

export const GET = handleRoute(async (req: NextRequest) => {
  const auth = await requireAuth(req);
  requireAdmin(auth);
  requirePasswordUpdated(auth);
  const runtime = await getRuntime();

  const data = runtime.usersHandlers.listUsers();
  return ok(data);
});

export const POST = handleRoute(async (req: NextRequest) => {
  const auth = await requireAuth(req);
  requireAdmin(auth);
  requirePasswordUpdated(auth);
  const runtime = await getRuntime();
  const body = await readJsonBody(req);

  const data = runtime.usersHandlers.createUser({ body });
  return ok(data, 201);
});
