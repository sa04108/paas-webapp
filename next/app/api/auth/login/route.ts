import { NextRequest } from "next/server";
import { getRuntime } from "@/lib/portal/runtime";
import { ok, handleRoute, readJsonBody, setSessionCookie } from "@/lib/portal/http";

export const POST = handleRoute(async (req: NextRequest) => {
  const runtime = await getRuntime();
  const body = await readJsonBody(req);

  const { user, session } = runtime.authService.login({
    username: body.username,
    password: body.password,
  });

  const response = ok({ user, sessionExpiresAt: session.expiresAt });
  await setSessionCookie(response, session.token, session.expiresAt);
  return response;
});
