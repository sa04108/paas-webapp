// =============================================================================
// utils.js - 공통 유틸리티
// =============================================================================
// 역할:
//   server.js 전반에서 재사용되는 순수 함수와 공통 타입을 제공한다.
//   외부 모듈 의존성이 없으므로 가장 먼저 로드된다.
// =============================================================================
"use strict";

// 도메인 예외 타입 — HTTP 상태 코드를 함께 전달할 수 있는 에러.
// 라우트 핸들러에서 throw 하면 글로벌 에러 핸들러가 적절한 응답으로 처리한다.
class AppError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
  }
}

// 문자열/미정의 값을 양의 정수로 변환한다. 파싱 실패 시 fallbackValue를 반환한다.
function toPositiveInt(value, fallbackValue) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallbackValue;
  }
  return parsed;
}

// 환경변수 등 문자열 불리언 값을 실제 boolean으로 정규화한다.
// "true"/"1"/"yes"/"on" → true, "false"/"0"/"no"/"off" → false, 나머지 → fallbackValue
function normalizeBoolean(value, fallbackValue = false) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no", "off"].includes(normalized)) {
      return false;
    }
  }
  return fallbackValue;
}

// 성공 응답 헬퍼 — { ok: true, data: ... } 형태로 응답한다.
function sendOk(res, data = {}, statusCode = 200) {
  return res.status(statusCode).json({ ok: true, data });
}

// 실패 응답 헬퍼 — { ok: false, error: ... } 형태로 응답한다.
function sendError(res, statusCode, message) {
  return res.status(statusCode).json({ ok: false, error: message });
}

module.exports = { AppError, toPositiveInt, normalizeBoolean, sendOk, sendError };
