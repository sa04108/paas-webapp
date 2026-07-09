// =============================================================================
// app/auth/route.ts - 포털 로그인 페이지
// =============================================================================
// 역할:
//   portal/public/auth.html을 그대로 서빙한다. 로그인 스크립트(auth.js)는
//   next/public/auth.js에서 정적으로 서빙되며 fetch("/api/auth/...")를 그대로 호출한다.
//   이미 로그인된 세션이면 대시보드로 리다이렉트한다 (portal/server.js의 GET /auth와 동일).
// =============================================================================
import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { handleRoute, resolveAuthOrNull } from "@/lib/portal/http";

const authHtmlPath = path.join(process.cwd(), "lib", "portal", "pages", "auth.html");

export const GET = handleRoute(async (req: NextRequest) => {
  const auth = await resolveAuthOrNull(req);
  if (auth) {
    return NextResponse.redirect(new URL("/", req.url));
  }

  const html = fs.readFileSync(authHtmlPath, "utf-8");
  return new NextResponse(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
});
