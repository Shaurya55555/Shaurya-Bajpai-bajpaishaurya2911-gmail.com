// Thin fetch wrapper. The access token lives only in the caller's memory (passed in per
// call) — this module never stores it, and nothing here ever touches localStorage or
// sessionStorage (AUTH-DATA-MODEL.md §2, D13).

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message ?? 'request failed');
    this.status = status;
    this.code = body?.error?.code ?? null;
    this.reason = body?.error?.reason ?? null;
  }
}

export async function api(method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';

  const res = await fetch(`/v1${path}`, {
    method,
    headers,
    credentials: 'include', // send/receive the httpOnly refresh cookie
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  const json = text ? JSON.parse(text) : null;

  if (!res.ok) throw new ApiError(res.status, json);
  return json;
}

export const get = (path, token) => api('GET', path, { token });
export const post = (path, token, body) => api('POST', path, { token, body: body ?? {} });
export const patch = (path, token, body) => api('PATCH', path, { token, body: body ?? {} });
export const del = (path, token, body) => api('DELETE', path, { token, body });
