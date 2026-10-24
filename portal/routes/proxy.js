"use strict";

const express = require("express");
const { AppError, sendOk } = require("../utils");

function createProxyRouter(service) {
  const router = express.Router();
  router.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  router.get("/", (_req, res) => sendOk(res, service.status()));
  router.get("/discovery", async (_req, res, next) => {
    try { return sendOk(res, await service.discovery()); } catch (error) { return next(error); }
  });
  // 브라우저가 교차 출처의 단순 폼으로 관리자 작업을 실행하지 못하게 한다.
  router.use((req, _res, next) => {
    if (req.get("X-Paas-Admin") !== "proxy" || !req.is("application/json")) return next(new AppError(403, "Use the authenticated proxy settings page."));
    const origin = req.get("Origin");
    if (origin && origin !== `${req.protocol}://${req.get("host")}`) return next(new AppError(403, "Cross-origin proxy settings requests are not allowed."));
    return next();
  });
  router.post("/check", async (req, res, next) => {
    try { return sendOk(res, await service.check(req.body?.settings)); } catch (error) { return next(error); }
  });
  router.post("/preview", async (req, res, next) => {
    try { return sendOk(res, await service.preview(req.body?.settings)); } catch (error) { return next(error); }
  });
  router.put("/", async (req, res, next) => {
    try { return sendOk(res, await service.save(req.body?.settings, req.body?.revision)); } catch (error) { return next(error); }
  });
  return router;
}

module.exports = createProxyRouter;
