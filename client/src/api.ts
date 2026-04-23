// API client tres leger avec gestion du token JWT

const TOKEN_KEY = 'tlpe_token';

export function getToken(): string | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(token: string) {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(TOKEN_KEY, token);
}
export function clearToken() {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(TOKEN_KEY);
}

export function shouldSendJsonContentType(options: RequestInit = {}): boolean {
  const body = options.body;
  if (body === undefined || body === null) return false;
  return !(body instanceof FormData || body instanceof URLSearchParams || body instanceof Blob || body instanceof ArrayBuffer);
}

export function buildHeaders(options: RequestInit = {}, contentType = true): Record<string, string> {
  const token = getToken();
  const headers: Record<string, string> = {
    ...((options.headers as Record<string, string>) || {}),
  };
  if (contentType && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function throwApiError(res: Response): Promise<never> {
  if (res.status === 401) {
    clearToken();
    window.location.href = '/login';
  }

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const body = await res.json();
    throw new Error(
      typeof body.error === 'string' ? body.error : JSON.stringify(body.error),
    );
  }

  throw new Error(`HTTP ${res.status}`);
}

export async function api<T = unknown>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const res = await fetch(path, { ...options, headers: buildHeaders(options) });
  const contentType = res.headers.get('content-type') || '';
  if (!res.ok) {
    await throwApiError(res);
  }
  if (res.status === 204) return undefined as T;
  if (contentType.includes('application/json')) return res.json() as Promise<T>;
  return (await res.text()) as unknown as T;
}

export function extractFilenameFromDisposition(contentDisposition: string | null): string | null {
  if (!contentDisposition) return null;
  const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match) {
    return decodeURIComponent(utf8Match[1]);
  }
  const asciiMatch = contentDisposition.match(/filename="?([^";]+)"?/i);
  return asciiMatch ? asciiMatch[1] : null;
}

export async function apiBlob(path: string, options: RequestInit = {}): Promise<Blob> {
  const res = await fetch(path, { ...options, headers: buildHeaders(options, shouldSendJsonContentType(options)) });
  if (!res.ok) {
    await throwApiError(res);
  }
  return res.blob();
}

export async function apiBlobWithMetadata(
  path: string,
  options: RequestInit = {},
): Promise<{ blob: Blob; filename: string | null }> {
  const res = await fetch(path, { ...options, headers: buildHeaders(options, shouldSendJsonContentType(options)) });
  if (!res.ok) {
    await throwApiError(res);
  }
  return {
    blob: await res.blob(),
    filename: extractFilenameFromDisposition(res.headers.get('content-disposition')),
  };
}
