// =============================================================================
// app/[[...slug]]/route.ts - 포털 대시보드 SPA 셸
// =============================================================================
// 역할:
//   portal/public/index.html(대시보드 SPA 셸)을 "/", "/dashboard", "/create",
//   "/users", "/admin", "/apps/:userid/:appname" 등 모든 UI 경로에 대해 그대로
//   서빙한다. 실제 화면 전환은 클라이언트 스크립트(app-router.js)가 pathname을
//   해석해 수행하므로, 서버는 인증 여부만 확인하고 동일한 셸을 내려주면 된다.
//   (portal/server.js의 `app.get(UI_PATHS, ...)`에 대응)
//
//   /api/**, /health, /auth 는 더 구체적인 세그먼트이므로 이 catch-all보다
//   우선 매칭되고, next/public 정적 자산(app.js, styles.css 등)도 Next.js의
//   기본 정적 파일 서빙이 이 라우트보다 우선한다.
// =============================================================================
import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { handleRoute, resolveAuthOrNull } from "@/lib/portal/http";

const dashboardHtmlPath = path.join(process.cwd(), "lib", "portal", "pages", "dashboard.html");

export const GET = handleRoute(async (req: NextRequest) => {
  const auth = await resolveAuthOrNull(req);
  if (!auth) {
    return NextResponse.redirect(new URL("/auth", req.url));
  }

  const html = fs.readFileSync(dashboardHtmlPath, "utf-8");
  return new NextResponse(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
});
