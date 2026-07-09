import { NextRequest, NextResponse } from "next/server";
import { getRuntime } from "@/lib/portal/runtime";
import { handleRoute, requireAuth, requirePasswordUpdated } from "@/lib/portal/http";

type Params = { id: string };
type Ctx = { params: Promise<Params> };

const encoder = new TextEncoder();

/**
 * jobStore.subscribeSse()는 Express res 객체(write()/on("close", cb)) 모양을 기대한다.
 * ReadableStream controller를 그 최소 형태로 감싸 기존 jobStore 로직을 그대로 재사용한다.
 */
function createResLikeAdapter(controller: ReadableStreamDefaultController) {
  let closed = false;
  let closeCallback: (() => void) | null = null;

  return {
    write(chunk: string) {
      if (closed) return;
      try {
        controller.enqueue(encoder.encode(chunk));
      } catch {
        closed = true;
      }
    },
    on(event: string, cb: () => void) {
      if (event === "close") closeCallback = cb;
    },
    isClosed: () => closed,
    triggerClose() {
      if (closed) return;
      closed = true;
      closeCallback?.();
    },
  };
}

export const GET = handleRoute<Ctx>(async (req: NextRequest, { params }) => {
  const auth = await requireAuth(req);
  requirePasswordUpdated(auth);
  const runtime = await getRuntime();
  const { id } = await params;

  // 접근 제어 + job 조회 (없거나 권한 없으면 AppError → handleRoute가 JSON 에러로 변환)
  const job = runtime.jobsHandlers.resolveJobForStream({ auth, params: { id } });
  const { jobStore } = runtime;

  const stream = new ReadableStream({
    start(controller) {
      const writeEvent = (payload: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          /* 클라이언트가 이미 연결을 끊음 */
        }
      };

      // 이미 완료된 job은 SSE가 필요 없음 — 즉시 상태 전송 후 종료
      if (jobStore.TERMINAL_STATUSES.has(job.status)) {
        for (const line of job.logs) writeEvent({ type: "log", line });
        writeEvent({ type: "status", status: job.status });
        controller.close();
        return;
      }

      const resLike = createResLikeAdapter(controller);

      // 연결 시점까지 쌓인 로그 리플레이
      for (const line of jobStore.getLogs(id)) {
        resLike.write(`data: ${JSON.stringify({ type: "log", line })}\n\n`);
      }

      // 이후 로그는 구독을 통해 실시간 수신
      jobStore.subscribeSse(id, resLike);

      // keepalive: 30초 간격 comment 전송
      const keepalive = setInterval(() => {
        if (resLike.isClosed()) {
          clearInterval(keepalive);
          return;
        }
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          resLike.triggerClose();
          clearInterval(keepalive);
        }
      }, 30000);

      req.signal.addEventListener("abort", () => {
        resLike.triggerClose();
        clearInterval(keepalive);
        try {
          controller.close();
        } catch {
          /* 이미 닫힘 */
        }
      });
    },
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
});
