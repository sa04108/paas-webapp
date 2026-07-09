// =============================================================================
// proxy.ts - 호스트 기반 랜딩/포털 분기 (구 middleware)
// =============================================================================
// 역할:
//   루트 도메인({PAAS_DOMAIN})은 랜딩을 서빙하고, 포털 UI 딥링크는
//   portal.{PAAS_DOMAIN}으로 301한다. portal 서브도메인 요청은 그대로 통과한다.
//   (portal/server.js의 landingRouter / isRootDomainRequest 에 대응)
//
//   API·정적·인증 응답 형식에는 관여하지 않는다.
// =============================================================================
import { NextRequest, NextResponse } from "next/server";

const PORTAL_DEEP_PATHS = ["/dashboard", "/create", "/users", "/admin", "/auth"];

function isPortalDeepPath(pathname: string): boolean {
  if (PORTAL_DEEP_PATHS.includes(pathname)) return true;
  if (pathname.startsWith("/apps/")) return true;
  return false;
}

function portalOrigin(req: NextRequest, paasDomain: string): string {
  const hostHeader = req.headers.get("host") || "";
  const portSuffix = hostHeader.includes(":") ? `:${hostHeader.split(":")[1]}` : "";
  return `${req.nextUrl.protocol}//portal.${paasDomain}${portSuffix}`;
}

export function proxy(request: NextRequest) {
  const paasDomain = process.env.PAAS_DOMAIN || "my.domain.com";
  const hostname = request.nextUrl.hostname;

  if (hostname !== paasDomain) {
    return NextResponse.next();
  }

  const { pathname, search } = request.nextUrl;

  if (pathname === "/" || pathname === "/index.html") {
    return NextResponse.rewrite(new URL("/landing/index.html", request.url));
  }

  if (isPortalDeepPath(pathname)) {
    return NextResponse.redirect(
      `${portalOrigin(request, paasDomain)}${pathname}${search}`,
      301,
    );
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|health|_next/static|_next/image|favicon.ico|landing).*)"],
};
