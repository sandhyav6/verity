const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? "http://localhost:8000";

export class ApiError extends Error {
  constructor(public status: number, public detail: string) {
    super(detail);
  }
}

type Params = Record<string, string | number | boolean | undefined | null>;

function url(path: string, params?: Params): string {
  // BASE may be absolute ("http://localhost:8000") or same-origin with a prefix ("/api", proxied by the host).
  const base = new URL(BASE.endsWith("/") ? BASE : BASE + "/", window.location.origin);
  const u = new URL(path.replace(/^\//, ""), base);
  for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
  return u.toString();
}

async function request<T>(input: string, init: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(input, { credentials: "include", ...init });
  } catch {
    throw new ApiError(0, "Cannot reach the Verity API. Check your connection and that the backend is running.");
  }
  if (res.ok) return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
  let detail = res.statusText;
  try {
    const body = await res.json();
    detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
  } catch {
    /* non-JSON error body */
  }
  throw new ApiError(res.status, detail);
}

export const api = {
  /** Cookies are sent so the SIWE session works across localhost ports. */
  get: <T>(path: string, params?: Params) => request<T>(url(path, params), {}),
  post: <T>(path: string, body?: unknown) =>
    request<T>(url(path), { method: "POST", headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }),
  /** multipart upload; the browser sets the boundary header itself */
  upload: <T>(path: string, form: FormData) => request<T>(url(path), { method: "POST", body: form }),
  fileUrl: (path: string) => url(path),
};
