// Minimal typed fetch client for the CoolScaler backend. In dev, vite proxies
// /api → http://localhost:8088 (a port-forwarded backend).

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    message?: string,
  ) {
    super(message ?? `API ${status} on ${url}`);
    this.name = 'ApiError';
  }
}

export async function fetchJson<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(path, {
    headers: { Accept: 'application/json', ...(init?.headers ?? {}) },
    ...init,
  });
  if (!res.ok) {
    throw new ApiError(res.status, path, await res.text().catch(() => undefined));
  }
  return (await res.json()) as T;
}

export const getJson = <T>(path: string) => fetchJson<T>(path);

/* POST JSON body → JSON response. */
export const postJson = <T>(path: string, body?: unknown) =>
  fetchJson<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });

/* PUT JSON body → JSON response. */
export const putJson = <T>(path: string, body?: unknown) =>
  fetchJson<T>(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
