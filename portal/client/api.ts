export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !headers.has("Content-Type"))
    headers.set("Content-Type", "application/json");
  const response = await fetch(`/api${path}`, {
    ...options,
    headers,
    credentials: "same-origin",
    cache: "no-store",
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.ok !== true) {
    if (
      response.status === 401 &&
      payload?.error === "Unauthorized" &&
      path !== "/auth/me"
    )
      window.location.assign("/auth");
    throw new ApiError(
      payload?.error || `Request failed (${response.status})`,
      response.status,
    );
  }
  return payload.data as T;
}
export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Request failed.";
export const json = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
