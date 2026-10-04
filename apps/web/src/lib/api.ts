/**
 * The one way the app talks to the API.
 *
 * Browser: the session is an HttpOnly cookie the page cannot read; every
 * request carries `X-Minions-Client`, which the API requires as its CSRF
 * defence. Desktop (Tauri): a bearer token held in memory only.
 *
 * Request bodies may hold ciphertext; nothing here logs them.
 */

const BASE = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ?? "";

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
export const clientKind = isTauri ? "desktop" : "web";

let bearerToken: string | null = null;
export function setBearerToken(token: string | null) {
  bearerToken = token;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type Listener = (error: ApiError) => void;
const listeners = new Set<Listener>();
/** The session store listens here for 401 (signed out) and VAULT_LOCKED. */
export function onApiError(listener: Listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function api<T = unknown>(
  path: string,
  init: {
    method?: string;
    body?: unknown;
    query?: Record<string, string | number | boolean | undefined | null>;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const url = new URL(`${BASE}${path}`, window.location.origin);
  for (const [k, v] of Object.entries(init.query ?? {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const headers: Record<string, string> = { "x-minions-client": clientKind };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (bearerToken) headers.authorization = `Bearer ${bearerToken}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      credentials: "include",
      cache: "no-store",
      signal: init.signal,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError(0, "Can't reach the Minions server. Check your connection.");
  }

  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => null)) as {
    message?: string | string[];
    code?: string;
  } | null;
  if (!res.ok) {
    const message = Array.isArray(data?.message)
      ? data.message[0]!
      : (data?.message ?? res.statusText);
    const error = new ApiError(res.status, message, data?.code);
    for (const l of listeners) l(error);
    throw error;
  }
  return data as T;
}

export const get = <T>(
  path: string,
  query?: Record<string, string | number | boolean | undefined | null>,
) => api<T>(path, { query });
export const post = <T>(path: string, body: unknown = {}) => api<T>(path, { method: "POST", body });
export const put = <T>(path: string, body: unknown) => api<T>(path, { method: "PUT", body });
export const patch = <T>(path: string, body: unknown) => api<T>(path, { method: "PATCH", body });
export const del = <T = void>(path: string, query?: Record<string, string | undefined>) =>
  api<T>(path, { method: "DELETE", query });

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error && e.name === "DecryptionError")
    return "This data could not be decrypted.";
  return "Something went wrong.";
}
