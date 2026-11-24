import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import type { ErrorPayload } from '@delta-hrms/shared';
import { isDuplicateKey } from '../db';

/** An error that is safe to show to the person using the app. */
export class HttpError extends Error {
  status: number;
  fields?: Record<string, string>;
  /** A machine-readable reason, for the few cases the web app reacts to. */
  code?: string;
  /** More about the refusal, for the web app to show: what confirming would change. Never anything private. */
  details?: unknown;

  constructor(status: number, message: string, fields?: Record<string, string>, code?: string, details?: unknown) {
    super(message);
    this.status = status;
    this.fields = fields;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, fields?: Record<string, string>) => new HttpError(400, message, fields);
export const unauthorized = (message = 'Please sign in.') => new HttpError(401, message);
export const forbidden = (message = 'Your role cannot do that.', code?: string) => new HttpError(403, message, undefined, code);
export const notFound = (message = 'That no longer exists.') => new HttpError(404, message);
export const conflict = (message: string) => new HttpError(409, message);
/** Not done yet: the caller is told what it would change and must ask again, saying so. */
export const needsConfirmation = (message: string, code: string, details: unknown) => new HttpError(409, message, undefined, code, details);
export const unprocessable = (message: string, fields?: Record<string, string>) => new HttpError(422, message, fields);
export const tooManyRequests = (message: string) => new HttpError(429, message);

/** What to say for the request-reading errors Express's body parser raises (all of them the sender's fault). */
const BODY_ERRORS: Record<string, { status: number; message: string }> = {
  'entity.parse.failed': { status: 400, message: 'That request is not valid JSON.' },
  'entity.too.large': { status: 413, message: 'That request is too large.' },
  'entity.verify.failed': { status: 400, message: 'That request could not be read.' },
  'request.aborted': { status: 400, message: 'The request was cut off before it arrived.' },
  'request.size.invalid': { status: 400, message: 'That request could not be read.' },
  'encoding.unsupported': { status: 415, message: 'That request uses an encoding the server does not accept.' },
  'charset.unsupported': { status: 415, message: 'That request uses a character set the server does not accept.' },
  'parameters.too.many': { status: 413, message: 'That request has too many fields.' },
};

/** Turns anything thrown in a route into one JSON shape. Unknown errors are logged, never leaked. */
export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  let status = 500;
  let payload: ErrorPayload = { error: 'Something went wrong on our side. Please try again.' };

  if (error instanceof HttpError) {
    status = error.status;
    payload = { error: error.message, fields: error.fields, code: error.code, details: error.details };
  } else if (error instanceof ZodError) {
    status = 400;
    const fields: Record<string, string> = {};
    for (const issue of error.issues) fields[issue.path.join('.') || 'body'] ??= issue.message;
    payload = { error: error.issues[0]?.message ?? 'That request is not valid.', fields };
  } else if (isDuplicateKey(error)) {
    status = 409;
    payload = { error: 'That already exists.' };
  } else if (BODY_ERRORS[(error as { type?: string })?.type ?? '']) {
    const known = BODY_ERRORS[(error as { type: string }).type]!;
    status = known.status;
    payload = { error: known.message };
  } else {
    console.error('[api] unexpected error', error);
  }

  res.status(status).json(payload);
};
