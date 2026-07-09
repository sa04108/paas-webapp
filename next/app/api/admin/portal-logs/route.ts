import { exec } from "node:child_process";
import { promisify } from "node:util";
import { NextRequest } from "next/server";
import { ok, handleRoute, requireAuth, requireAdmin, requirePasswordUpdated, getQuery } from "@/lib/portal/http";

const execAsync = promisify(exec);

export const GET = handleRoute(async (req: NextRequest) => {
  const auth = await requireAuth(req);
  requireAdmin(auth);
  requirePasswordUpdated(auth);

  const query = getQuery(req);
  const requestedLines = Number.parseInt(String(query.lines || "120"), 10);
  const lines = Number.isFinite(requestedLines) ? Math.max(1, Math.min(1000, requestedLines)) : 120;

  let logs = "";
  try {
    const { stdout, stderr } = await execAsync(`docker logs paas-portal --tail ${lines}`);
    logs = (stdout || "") + (stderr || "");
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string };
    logs = (err.stdout || "") + (err.stderr || "");
    if (!logs) throw error;
  }

  return ok({ lines, logs: logs || "No logs available." });
});
