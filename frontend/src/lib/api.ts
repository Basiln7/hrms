import type { ErrorPayload } from '@delta-hrms/shared';

/** A failed request, carrying the server's own message and any per-field messages. */
export class ApiError extends Error {
  status: number;
  fields?: Record<string, string>;
  /** A machine-readable reason, for the few cases the app reacts to. */
  code?: string;
  /** More about the refusal, for the few cases the app shows it: what confirming would change. */
  details?: unknown;

  constructor(status: number, message: string, fields?: Record<string, string>, code?: string, details?: unknown) {
    super(message);
    this.status = status;
    this.fields = fields;
    this.code = code;
    this.details = details;
  }

  /** The request never got an answer from the API itself (offline, or the API is down or restarting). */
  get unreachable() {
    return this.status === 0 || this.status === UNREACHABLE_STATUS;
  }
}

/** Used when a proxy in front of the API answered for it. */
const UNREACHABLE_STATUS = 503;

const UNREACHABLE = 'The server cannot be reached right now. Check your connection and try again.';

/**
 * Hears about every failed request before the caller does. The sign-in state uses it to
 * notice, wherever it happens, that the session has ended or the server has gone away.
 */
let failureListener: ((error: ApiError) => void) | null = null;
export function setFailureListener(listener: ((error: ApiError) => void) | null) {
  failureListener = listener;
}

interface RequestOptions {
  /** This failure is expected and handled by the caller (signing in, the first look for a session): do not report it. */
  quiet?: boolean;
}

async function request<T>(method: string, path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
  const fail = (error: ApiError): never => {
    if (!options.quiet) failureListener?.(error);
    throw error;
  };

  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      // The session is an httpOnly cookie; the browser sends it for us on same-origin requests.
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    return fail(new ApiError(0, UNREACHABLE));
  }

  if (response.status === 204) return undefined as T;
  const payload = (await response.json().catch(() => null)) as (T & Partial<ErrorPayload>) | null;
  if (!response.ok) {
    // The API always answers errors as JSON. A 5xx without it came from a proxy standing in
    // for an API that is down (Vite in development, a load balancer in production).
    if (response.status >= 500 && !payload?.error) return fail(new ApiError(UNREACHABLE_STATUS, UNREACHABLE));
    return fail(new ApiError(response.status, payload?.error ?? `The server answered with an error (${response.status}).`, payload?.fields, payload?.code, payload?.details));
  }
  return payload as T;
}

export const api = {
  get: <T>(path: string, options?: RequestOptions) => request<T>('GET', path, undefined, options),
  post: <T = void>(path: string, body?: unknown, options?: RequestOptions) => request<T>('POST', path, body, options),
  put: <T = void>(path: string, body?: unknown, options?: RequestOptions) => request<T>('PUT', path, body, options),
  patch: <T = void>(path: string, body?: unknown, options?: RequestOptions) => request<T>('PATCH', path, body, options),
  delete: <T = void>(path: string, options?: RequestOptions) => request<T>('DELETE', path, undefined, options),
};

/**
 * Fetches a file from the API and hands it to the browser to save, under the name the API
 * gave it. A refusal comes back as the API's own message, like any other failed request.
 */
export async function download(path: string): Promise<void> {
  const fail = (error: ApiError): never => {
    failureListener?.(error);
    throw error;
  };
  let response: Response;
  try {
    response = await fetch(`/api${path}`, { credentials: 'same-origin' });
  } catch {
    return fail(new ApiError(0, UNREACHABLE));
  }
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as Partial<ErrorPayload> | null;
    if (response.status >= 500 && !payload?.error) return fail(new ApiError(UNREACHABLE_STATUS, UNREACHABLE));
    return fail(new ApiError(response.status, payload?.error ?? `The server answered with an error (${response.status}).`, payload?.fields, payload?.code));
  }
  const name = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1] ?? 'download.csv';
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  // The browser has the file by now; the address is only a handle on it.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export const messageOf = (error: unknown) => (error instanceof Error ? error.message : 'Something went wrong.');

/** The per-field messages of a failed request, or none. */
export const fieldsOf = (error: unknown): Record<string, string> => (error instanceof ApiError && error.fields ? error.fields : {});

/**
 * How a form should show a failed save: the messages for its own fields, and a message for
 * the whole form only when none of them landed beside a field (so nothing is said twice, and
 * nothing is lost when the problem is with something the form does not show).
 */
export function formFailure(error: unknown, shownFields: readonly string[]): { fields: Record<string, string>; message: string | null } {
  const fields = fieldsOf(error);
  const landed = shownFields.some((name) => fields[name]);
  return { fields, message: landed ? null : messageOf(error) };
}
