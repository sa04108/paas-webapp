// =============================================================================
// http.ts - Next.js Route Handler ↔ 포털 서비스 어댑터
// =============================================================================
// 역할:
//   portal/server.js가 Express 미들웨어로 하던 일(JSON 응답 포맷, 세션 쿠키,
//   인증/권한 가드, 에러 → HTTP 상태 매핑)을 Next.js Route Handler에서
//   재사용 가능한 순수 함수로 제공한다.
//   비즈니스 로직(authService, appsHandlers 등)은 그대로 lib/portal/*.js에 있고,
//   이 파일은 그 결과를 NextResponse로 감싸는 얇은 계층이다.
// =============================================================================
import { NextRequest, NextResponse } from "next/server";
import { getRuntime } from "./runtime";

// authService.js / utils.js는 CommonJS 모듈이지만 allowJs로 타입 추론이 가능하다.
import { AppError } from "./utils";
import { ROLE_ADMIN } from "./authService";

export type SessionAuth = {
  method: "session";
  user: {
    id: number;
    username: string;
    role: string;
    mustChangePassword: boolean;
  };
  sessionId: number;
  sessionExpiresAt: string;
};

// ── 응답 헬퍼 ─────────────────────────────────────────────────────────────────

export function ok<T>(data: T, status = 200): NextResponse {
  return NextResponse.json({ ok: true, data }, { status });
}

export function fail(status: number, message: string): NextResponse {
  return NextResponse.json({ ok: false, error: message }, { status });
}

type RouteHandler<Ctx = unknown> = (req: NextRequest, ctx: Ctx) => Promise<NextResponse>;

/**
 * Route Handler를 감싸 AppError → HTTP 상태 매핑과 예기치 못한 에러 로깅을 담당한다.
 * portal/server.js의 글로벌 에러 핸들러에 대응한다.
 */
export function handleRoute<Ctx = unknown>(fn: RouteHandler<Ctx>): RouteHandler<Ctx> {
  return async (req, ctx) => {
    try {
      return await fn(req, ctx);
    } catch (error) {
      if (error instanceof AppError) {
        const response = fail(error.statusCode, error.message);
        if (error.statusCode === 401) {
          await clearSessionCookie(response);
        }
        return response;
      }
      console.error("[portal] unexpected error:", error);
      return fail(500, "Internal server error");
    }
  };
}

// ── 요청 파싱 헬퍼 ────────────────────────────────────────────────────────────

/**
 * express.json()과 동일하게: 본문이 없으면 {}, 파싱 실패 시 AppError(400)를 던진다.
 */
export async function readJsonBody(req: NextRequest): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError(400, "Invalid JSON body");
  }
}

export function getQuery(req: NextRequest): Record<string, string> {
  return Object.fromEntries(req.nextUrl.searchParams.entries());
}

/**
 * 세션 쿠키의 원본 토큰 문자열을 읽는다 (로그아웃처럼 인증 실패를 허용해야 하는
 * 엔드포인트에서 사용). 인증이 필요한 대부분의 경우는 requireAuth()를 사용한다.
 */
export async function getRawSessionToken(req: NextRequest): Promise<string | null> {
  const runtime = await getRuntime();
  const { name } = runtime.authService.getSessionCookieOptions();
  const cookieHeader = req.headers.get("cookie") || "";
  for (const chunk of cookieHeader.split(";")) {
    const [key, ...valueParts] = chunk.trim().split("=");
    if (key === name) {
      try {
        return decodeURIComponent(valueParts.join("="));
      } catch {
        return valueParts.join("=");
      }
    }
  }
  return null;
}

// ── 세션 쿠키 ─────────────────────────────────────────────────────────────────

export async function setSessionCookie(
  response: NextResponse,
  token: string,
  expiresAt: string
): Promise<void> {
  const runtime = await getRuntime();
  const { name, secure } = runtime.authService.getSessionCookieOptions();
  response.cookies.set(name, token, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    expires: new Date(expiresAt),
  });
}

export async function clearSessionCookie(response: NextResponse): Promise<void> {
  const runtime = await getRuntime();
  const { name, secure } = runtime.authService.getSessionCookieOptions();
  response.cookies.set(name, "", {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: 0,
  });
}

// ── 인증/권한 가드 ────────────────────────────────────────────────────────────
// portal/authService.js의 requireSessionAuth/requirePaasAdmin/requirePasswordUpdated
// Express 미들웨어를 대체한다. throw된 AppError는 handleRoute()가 응답으로 변환한다.

/**
 * 세션 쿠키를 검증해 인증 정보를 반환하거나, 없으면 null을 반환한다.
 * (HTML 셸을 서빙하는 라우트처럼 401을 던지지 않고 자체 리다이렉트가 필요한 경우 사용)
 */
export async function resolveAuthOrNull(req: NextRequest): Promise<SessionAuth | null> {
  const runtime = await getRuntime();
  const cookieHeader = req.headers.get("cookie") || "";
  const auth = runtime.authService.resolveSessionAuth({ headers: { cookie: cookieHeader } });
  return (auth as SessionAuth) ?? null;
}

/**
 * 세션 쿠키를 검증하고 인증 정보를 반환한다. 실패 시 AppError(401)를 던진다.
 */
export async function requireAuth(req: NextRequest): Promise<SessionAuth> {
  const auth = await resolveAuthOrNull(req);
  if (!auth) {
    throw new AppError(401, "Unauthorized");
  }
  return auth;
}

export function requireAdmin(auth: SessionAuth): void {
  if (auth?.user?.role !== ROLE_ADMIN) {
    throw new AppError(403, "Forbidden");
  }
}

export function requirePasswordUpdated(auth: SessionAuth): void {
  if (auth?.method === "session" && auth?.user?.mustChangePassword) {
    throw new AppError(403, "Password change required");
  }
}
