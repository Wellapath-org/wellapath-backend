/**
 * Contract plumbing shared by every Community and auth route (COMMUNITY_API_CONTRACT §1, §5):
 * the error envelope, request ids, `Cache-Control: no-store`, the prohibited-key check, Ajv
 * error mapping, opaque-id checks, keyset cursors and RFC 3339 UTC timestamps.
 */
import { randomUUID } from 'crypto';
import { FastifyError, FastifyReply, FastifyRequest } from 'fastify';

export type ErrorCode =
  | 'validation_failed'
  | 'invalid_code'
  | 'token_expired'
  | 'unauthenticated'
  | 'forbidden'
  | 'community_not_allowed'
  | 'account_restricted'
  | 'account_suspended'
  | 'mfa_enrollment_required'
  | 'mfa_step_up_required'
  | 'self_action_forbidden'
  | 'not_found'
  | 'conflict'
  | 'invalid_state'
  | 'idempotency_key_reused'
  | 'rate_limited'
  | 'internal_error'
  | 'community_unavailable';

export type ErrorDetails = Record<string, string | number | null>;

const DEFAULT_MESSAGES: Record<ErrorCode, string> = {
  validation_failed: 'The request failed validation',
  invalid_code: 'The code is invalid or has expired',
  token_expired: 'The access token has expired',
  unauthenticated: 'Authentication is required',
  forbidden: 'This action is not permitted',
  community_not_allowed: 'Community is not enabled for this account',
  account_restricted: 'This account is read-only',
  account_suspended: 'This account is suspended',
  mfa_enrollment_required: 'Two-factor authentication must be enrolled first',
  mfa_step_up_required: 'Verify a two-factor code for this session first',
  self_action_forbidden: 'You cannot act on your own content, account, role or claim',
  not_found: 'Not found',
  conflict: 'The request conflicts with the current state',
  invalid_state: 'That transition is not allowed from the current state',
  idempotency_key_reused: 'This Idempotency-Key was used with a different request',
  rate_limited: 'Too many requests',
  internal_error: 'An internal error occurred',
  community_unavailable: 'Community is temporarily unavailable',
};

const STATUS: Record<ErrorCode, number> = {
  validation_failed: 400,
  invalid_code: 400,
  token_expired: 401,
  unauthenticated: 401,
  forbidden: 403,
  community_not_allowed: 403,
  account_restricted: 403,
  account_suspended: 403,
  mfa_enrollment_required: 403,
  mfa_step_up_required: 403,
  self_action_forbidden: 403,
  not_found: 404,
  conflict: 409,
  invalid_state: 422,
  idempotency_key_reused: 422,
  rate_limited: 429,
  internal_error: 500,
  community_unavailable: 503,
};

/** Every non-2xx Community/auth response is thrown as one of these. */
export class ApiError extends Error {
  readonly statusCode: number;
  constructor(
    readonly code: ErrorCode,
    readonly details?: ErrorDetails,
    message?: string,
    /** Extra response headers (e.g. Retry-After). */
    readonly headers?: Record<string, string>,
  ) {
    super(message ?? DEFAULT_MESSAGES[code]);
    this.statusCode = STATUS[code];
  }
}

export const notFound = (): ApiError => new ApiError('not_found');
export const invalidState = (reason: string): ApiError => new ApiError('invalid_state', { reason });
export const conflict = (reason: string): ApiError => new ApiError('conflict', { reason });
export const validation = (field: string, rule: string): ApiError =>
  new ApiError('validation_failed', { field, rule });

export interface ErrorEnvelope {
  error: { code: ErrorCode; message: string; request_id: string; details?: ErrorDetails };
}

declare module 'fastify' {
  interface FastifyRequest {
    communityRequestId?: string;
  }
}

const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** Accepts a client `X-Request-Id` only if it matches the contract pattern. */
export const resolveRequestId = (request: FastifyRequest): string => {
  if (request.communityRequestId) return request.communityRequestId;
  const sent = request.headers['x-request-id'];
  const id = typeof sent === 'string' && REQUEST_ID.test(sent) ? sent : randomUUID();
  request.communityRequestId = id;
  return id;
};

/** Headers every Community, auth and features response carries (contract §1). */
export const applyContractHeaders = (request: FastifyRequest, reply: FastifyReply): void => {
  reply.header('cache-control', 'no-store');
  reply.header('x-request-id', resolveRequestId(request));
};

export const envelope = (request: FastifyRequest, error: ApiError): ErrorEnvelope => ({
  error: {
    code: error.code,
    message: error.message,
    request_id: resolveRequestId(request),
    ...(error.details ? { details: error.details } : {}),
  },
});

export const sendApiError = (
  request: FastifyRequest,
  reply: FastifyReply,
  error: ApiError,
): FastifyReply => {
  applyContractHeaders(request, reply);
  if (error.headers) {
    for (const [k, v] of Object.entries(error.headers)) reply.header(k, v);
  }
  return reply.status(error.statusCode).send(envelope(request, error));
};

// ------------------------------------------------------------------ prohibited keys (§5)

/** Contract §5. Case-insensitive; applies at any nesting depth of the body and to query keys. */
export const PROHIBITED_KEY =
  /(symptom|triage|assessment|urgency|red_?flag|diagnos|differential|condition_id|care_recommendation|engine_version|artifact_version|answers?$)/i;

/** Returns the dotted path of the first prohibited key, or undefined. Values are never read. */
export const findProhibitedKey = (value: unknown, path = ''): string | undefined => {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const found = findProhibitedKey(value[i], `${path}[${i}]`);
      if (found) return found;
    }
    return undefined;
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      const keyPath = path ? `${path}.${key}` : key;
      if (PROHIBITED_KEY.test(key)) return keyPath;
      const found = findProhibitedKey((value as Record<string, unknown>)[key], keyPath);
      if (found) return found;
    }
  }
  return undefined;
};

// ------------------------------------------------------------------ Ajv error mapping (§1.3)

const RULES: Record<string, string> = {
  required: 'required',
  type: 'type',
  minLength: 'min_length',
  maxLength: 'max_length',
  pattern: 'pattern',
  enum: 'enum',
  const: 'enum',
  format: 'format',
  additionalProperties: 'unknown_field',
  minimum: 'type',
  maximum: 'type',
  oneOf: 'required',
};

interface AjvIssue {
  keyword: string;
  instancePath?: string;
  params?: Record<string, unknown>;
}

/** Maps a Fastify schema-validation error to `validation_failed` with field/rule details. */
export const mapValidationError = (error: FastifyError): ApiError => {
  const issue = (error.validation as AjvIssue[] | undefined)?.[0];
  if (!issue) return validation('body', 'type');
  const base = (issue.instancePath ?? '').replace(/^\//, '').replace(/\//g, '.');
  let field = base || 'body';
  if (issue.keyword === 'required' && typeof issue.params?.missingProperty === 'string') {
    field = base ? `${base}.${issue.params.missingProperty}` : issue.params.missingProperty;
  }
  if (
    issue.keyword === 'additionalProperties' &&
    typeof issue.params?.additionalProperty === 'string'
  ) {
    field = base ? `${base}.${issue.params.additionalProperty}` : issue.params.additionalProperty;
  }
  return validation(field, RULES[issue.keyword] ?? 'type');
};

// ------------------------------------------------------------------ ids, time, cursors

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** A malformed id in a path is a 404, never a 400, so the error is not a format oracle. */
export const requireUuid = (value: string | undefined): string => {
  if (!value || !UUID.test(value)) throw notFound();
  return value;
};
export const requireAccountId = (value: string | undefined): string => {
  if (!value || !ACCOUNT_ID.test(value)) throw notFound();
  return value;
};

/** RFC 3339 UTC with a `Z` suffix, from the server clock. */
export const ts = (value: Date | string | null | undefined): string | null => {
  if (value === null || value === undefined) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
};
export const tsRequired = (value: Date | string): string => ts(value) as string;

export interface PageQuery {
  limit: number;
  cursor?: Record<string, string | number>;
}

/**
 * Keyset cursor: base64url JSON with the list it was issued for, so a cursor for one list is
 * rejected by another. Clients treat it as opaque.
 */
export const encodeCursor = (list: string, key: Record<string, string | number>): string =>
  Buffer.from(JSON.stringify({ l: list, k: key })).toString('base64url');

export const parsePage = (
  query: Record<string, unknown> | undefined,
  list: string,
  cursorKeys: string[],
): PageQuery => {
  const q = query ?? {};
  let limit = 20;
  if (q.limit !== undefined) {
    if (typeof q.limit !== 'string' || !/^\d{1,3}$/.test(q.limit))
      throw validation('limit', 'type');
    limit = Number.parseInt(q.limit, 10);
    if (limit < 1 || limit > 50) throw validation('limit', 'type');
  }
  if (q.cursor === undefined) return { limit };
  if (typeof q.cursor !== 'string' || q.cursor.length > 512) throw validation('cursor', 'format');
  try {
    const decoded = JSON.parse(Buffer.from(q.cursor, 'base64url').toString('utf8')) as {
      l?: unknown;
      k?: Record<string, unknown>;
    };
    if (decoded.l !== list || !decoded.k || typeof decoded.k !== 'object') throw new Error('list');
    for (const key of cursorKeys) {
      const v = decoded.k[key];
      if (typeof v !== 'string' && typeof v !== 'number') throw new Error('key');
    }
    return { limit, cursor: decoded.k as Record<string, string | number> };
  } catch {
    throw validation('cursor', 'format');
  }
};

/** SQL fragment rendering a timestamptz with microseconds, for exact keyset cursors. */
export const cursorTs = (column: string): string =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** Builds `{items, next_cursor}` from `limit + 1` fetched rows. */
export const page = <Row, Item>(
  rows: Row[],
  limit: number,
  map: (row: Row) => Item,
  nextKey: (row: Row) => Record<string, string | number>,
  list: string,
): { items: Item[]; next_cursor: string | null } => {
  const more = rows.length > limit;
  const slice = more ? rows.slice(0, limit) : rows;
  return {
    items: slice.map(map),
    next_cursor: more ? encodeCursor(list, nextKey(slice[slice.length - 1])) : null,
  };
};

/** pg / network errors that mean "the Community database is unreachable". */
export const isDatabaseUnavailable = (error: unknown): boolean => {
  const e = error as { code?: string; message?: string };
  return (
    [
      'ECONNREFUSED',
      'ENOTFOUND',
      'EAI_AGAIN',
      'ETIMEDOUT',
      'ECONNRESET',
      'EHOSTUNREACH',
      '57P01',
      '57P03',
      '08006',
      '08001',
      '08004',
      '53300',
    ].includes(e.code ?? '') ||
    /timeout exceeded when trying to connect|Connection terminated|connect ECONNREFUSED/i.test(
      e.message ?? '',
    )
  );
};
