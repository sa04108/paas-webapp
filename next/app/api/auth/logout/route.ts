import { NextRequest } from "next/server";
import { getRuntime } from "@/lib/portal/runtime";
import { ok, handleRoute, clearSessionCookie, getRawSessionToken } from "@/lib/portal/http";

export const POST = handleRoute(async (req: NextRequest) => {
  const runtime = await getRuntime();
  const token = await getRawSessionToken(req);
  if (token) {
    runtime.authService.logout(token);
  }

  const response = ok({ loggedOut: true });
  await clearSessionCookie(response);
  return response;
});
