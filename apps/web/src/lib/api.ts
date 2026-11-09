/** Cliente HTTP: token de acceso en memoria, refresh token en cookie httpOnly con rotación. */

const BASE = '/api/v1';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;
let onSessionLost: (() => void) | null = null;

export function setAccessToken(token: string | null) {
  accessToken = token;
}

export const getAccessToken = () => accessToken;

export function setOnSessionLost(fn: () => void) {
  onSessionLost = fn;
}

export async function refreshSession(): Promise<{ accessToken: string; user: SessionUser } | null> {
  const res = await fetch(`${BASE}/auth/refresh`, { method: 'POST', credentials: 'same-origin' });
  if (!res.ok) return null;
  const data = await res.json();
  accessToken = data.accessToken;
  return data;
}

async function tryRefresh(): Promise<boolean> {
  refreshing ??= refreshSession()
    .then((r) => r !== null)
    .finally(() => (refreshing = null));
  return refreshing;
}

export interface SessionUser {
  id: string;
  role: 'PLAYER' | 'ADMIN' | 'CASHIER' | 'LOTTERY_OPERATOR' | 'AUDITOR' | 'COMPLIANCE' | 'SPORTS_TRADER';
  kind: 'PLAYER' | 'STAFF';
}

export async function api<T = any>(
  method: string,
  path: string,
  opts: { body?: unknown; headers?: Record<string, string>; retry?: boolean; raw?: boolean } = {},
): Promise<T> {
  const form = opts.body instanceof FormData;
  const res = await fetch(BASE + path, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(opts.body !== undefined && !form ? { 'content-type': 'application/json' } : {}),
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...opts.headers,
    },
    body: opts.body === undefined ? undefined : form ? (opts.body as FormData) : JSON.stringify(opts.body),
  });
  if (res.status === 401 && opts.retry !== false && !path.startsWith('/auth/')) {
    if (await tryRefresh()) return api(method, path, { ...opts, retry: false });
    onSessionLost?.();
  }
  if (opts.raw && res.ok) return (await res.blob()) as T;
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { message: text };
  }
  if (!res.ok) {
    const message = Array.isArray(data?.message) ? data.message[0] : data?.message;
    throw new ApiError(res.status, data?.code ?? 'ERROR', message ?? 'Error inesperado', data?.details);
  }
  return data as T;
}

export const get = <T = any>(path: string) => api<T>('GET', path);
export const put = <T = any>(path: string, body?: unknown) => api<T>('PUT', path, { body: body ?? {} });
export const post = <T = any>(path: string, body?: unknown, headers?: Record<string, string>) =>
  api<T>('POST', path, { body: body ?? {}, headers });
export const del = <T = any>(path: string) => api<T>('DELETE', path);
/** Descarga autenticada (p. ej. documentos KYC) como Blob. */
export const getBlob = (path: string) => api<Blob>('GET', path, { raw: true });
