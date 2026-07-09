import { NextRequest } from "next/server";
import { ok, handleRoute, requireAuth } from "@/lib/portal/http";

export const GET = handleRoute(async (req: NextRequest) => {
  const auth = await requireAuth(req);
  return ok({ user: auth.user, sessionExpiresAt: auth.sessionExpiresAt });
});
