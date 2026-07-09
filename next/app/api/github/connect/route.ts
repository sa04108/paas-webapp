import { NextRequest, NextResponse } from "next/server";
import { getRuntime } from "@/lib/portal/runtime";
import { handleRoute, requireAuth, requirePasswordUpdated } from "@/lib/portal/http";

export const GET = handleRoute(async (req: NextRequest) => {
  const auth = await requireAuth(req);
  requirePasswordUpdated(auth);
  const runtime = await getRuntime();

  const url = runtime.githubHandlers.connectUrl({ auth });
  return NextResponse.redirect(url);
});
