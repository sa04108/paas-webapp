import { NextRequest } from "next/server";
import { getRuntime } from "@/lib/portal/runtime";
import { ok, handleRoute, readJsonBody, requireAuth, setSessionCookie } from "@/lib/portal/http";

export const POST = handleRoute(async (req: NextRequest) => {
  const auth = await requireAuth(req);
  const runtime = await getRuntime();
  const body = await readJsonBody(req);

  const { user, session } = runtime.authService.changePassword({
    userId: auth.user.id,
    currentPassword: body.currentPassword,
    newPassword: body.newPassword,
  });

  const response = ok({ user, sessionExpiresAt: session.expiresAt });
  await setSessionCookie(response, session.token, session.expiresAt);
  return response;
});
