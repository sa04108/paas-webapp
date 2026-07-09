// =============================================================================
// routes/jobs.js - job 관련 비즈니스 로직 핸들러
// =============================================================================
// 역할:
//   백그라운드 job 상태 조회, SSE 스트리밍용 job 해석, 재시도/취소 로직을
//   프레임워크 독립적인 함수로 제공한다.
//   인증/권한 확인은 HTTP 어댑터(Next.js Route Handler)가 담당한다.
// =============================================================================
"use strict";

const { ROLE_ADMIN } = require("../authService");
const { AppError } = require("../utils");
const { RUNNER_SCRIPTS } = require("../config");
const { runRunnerScript } = require("../appManager");
const jobStore = require("../jobStore");

// ── 접근 제어 헬퍼 ────────────────────────────────────────────────────────────

// job 소유자 또는 admin만 접근 가능
function assertJobAccess(auth, job) {
  const user = auth?.user;
  if (!user) throw new AppError(401, "Unauthorized");
  if (user.role === ROLE_ADMIN) return; // admin은 전체 접근
  if (job.userid !== user.username) throw new AppError(403, "Forbidden");
}

// job을 조회하고 접근 권한을 확인한다.
function resolveJob(auth, jobId) {
  const job = jobStore.getJob(jobId);
  if (!job) throw new AppError(404, "Job not found");
  assertJobAccess(auth, job);
  return job;
}

// ── 목록 ──────────────────────────────────────────────────────────────────────

// 현재 사용자의 job 목록 반환 (active + 최근 24h 완료)
function listJobs({ auth }) {
  const user = auth?.user;
  if (!user) throw new AppError(401, "Unauthorized");
  const jobs = jobStore.listJobsByUser(user.username);
  return { jobs };
}

function deleteCompletedJobs({ auth }) {
  const user = auth?.user;
  if (!user) throw new AppError(401, "Unauthorized");
  jobStore.deleteCompletedJobs(user.username);
  return { message: "Completed jobs removed" };
}

// ── 단건 조회 ─────────────────────────────────────────────────────────────────

function getJob({ auth, params }) {
  const job = resolveJob(auth, params.id);
  return { job };
}

// SSE 스트리밍 라우트가 사용할 job 해석 (접근 제어만 수행하고 job 자체를 반환)
function resolveJobForStream({ auth, params }) {
  return resolveJob(auth, params.id);
}

// ── 재시도 / 취소 ─────────────────────────────────────────────────────────────

// interrupted 또는 failed 상태의 job을 재시도한다.
// 실행 함수는 runtime.js에서 setExecuteJobFn()으로 주입받는다.
let _executeJobFn = null;

function setExecuteJobFn(fn) {
  _executeJobFn = fn;
}

async function retryJob({ auth, params }) {
  const job = resolveJob(auth, params.id);
  if (!_executeJobFn) throw new AppError(500, "Job executor not initialized");

  if (!jobStore.RETRYABLE_STATUSES.has(job.status)) {
    throw new AppError(409, `Job is in '${job.status}' status and cannot be retried`);
  }

  // pending으로 되돌리고 재실행
  jobStore.requeueJob(job.id);
  const updatedJob = jobStore.getJob(job.id);

  setImmediate(() =>
    _executeJobFn(updatedJob).catch((err) =>
      console.error(`[jobs] retry execution failed for ${job.id}:`, err)
    )
  );

  return { jobId: job.id, status: "pending" };
}

// interrupted 또는 failed 상태의 job을 취소하고 DB에서 완전히 제거한다.
// create 작업의 경우 생성 중이던 잔류 파일과 컨테이너를 함께 정리(delete.sh)한다.
async function cancelJob({ auth, params }) {
  const job = resolveJob(auth, params.id);

  if (!jobStore.CANCELABLE_STATUSES.has(job.status)) {
    throw new AppError(409, `Job is in '${job.status}' status and cannot be canceled`);
  }

  if (job.type === "create" && job.status !== "done" && job.status !== "warn") {
    const { userid, appname } = job.meta;
    try {
      await runRunnerScript(RUNNER_SCRIPTS.delete, [userid, appname]);
    } catch (err) {
      console.error(`[jobs] cleanup failed during cancel for ${job.id}:`, err);
      // 클린업 중 오류가 발생해도 job 삭제는 진행한다.
    }
  }

  jobStore.deleteJob(job.id);
  return { jobId: job.id, status: "canceled" };
}

module.exports = {
  listJobs,
  deleteCompletedJobs,
  getJob,
  resolveJobForStream,
  retryJob,
  cancelJob,
  setExecuteJobFn,
};
