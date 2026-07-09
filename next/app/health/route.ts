import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    ok: true,
    data: { service: "portal", status: "ok", now: new Date().toISOString() },
  });
}
