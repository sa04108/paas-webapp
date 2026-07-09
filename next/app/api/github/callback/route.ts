import { NextRequest, NextResponse } from "next/server";
import { getRuntime } from "@/lib/portal/runtime";
import { handleRoute, requireAuth, requirePasswordUpdated, getQuery } from "@/lib/portal/http";

export const GET = handleRoute(async (req: NextRequest) => {
  const auth = await requireAuth(req);
  requirePasswordUpdated(auth);
  const runtime = await getRuntime();

  const redirectPath = await runtime.githubHandlers.callback({ auth, query: getQuery(req) });
  return NextResponse.redirect(new URL(redirectPath, req.url));
});
