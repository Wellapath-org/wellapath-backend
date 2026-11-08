/**
 * CORS policy (contract §1, C8 approved and scoped by the founder 2026-11-08).
 *
 * Two policies, chosen per request by path:
 *
 * - `/v1/community/*` and `/v1/auth/*` (only while Community is enabled): a browser grant exists
 *   for exactly ONE origin, the configured website (`COMMUNITY_WEBSITE_ORIGIN`). For it: methods
 *   GET, POST, PUT, DELETE (+ the OPTIONS preflight), the request headers the API reads, the
 *   response headers a client needs, a 10-minute preflight cache, and never
 *   `Access-Control-Allow-Credentials` (the API authenticates with bearer tokens, not cookies).
 *   Every other origin gets no CORS header on these paths and its preflight is refused.
 * - Every other route (`/config`, `/v1/features`, telemetry, …) keeps the app-wide policy
 *   unchanged: the production allowlist, GET/POST/OPTIONS, no PUT or DELETE.
 *
 * No wildcard is accepted anywhere: the website origin must be one exact origin.
 */
import type { FastifyRequest } from 'fastify';
import type { FastifyCorsOptions } from '@fastify/cors';

export const COMMUNITY_CORS_PREFIXES = ['/v1/community/', '/v1/auth/'] as const;
export const COMMUNITY_CORS_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'];
export const COMMUNITY_CORS_ALLOWED_HEADERS = [
  'Authorization',
  'Content-Type',
  'Idempotency-Key',
  'X-Request-Id',
];
export const COMMUNITY_CORS_EXPOSED_HEADERS = ['Retry-After', 'X-Request-Id'];
export const COMMUNITY_CORS_MAX_AGE_SECONDS = 600;
export const APP_CORS_METHODS = ['GET', 'POST', 'OPTIONS'];

/**
 * Parses `COMMUNITY_WEBSITE_ORIGIN`. Unset ⇒ no grant. Otherwise exactly one `https://` origin
 * (scheme + host + optional port, no path, no wildcard); `http://localhost` / `127.0.0.1` only
 * outside production. A bad value refuses to boot rather than silently widening anything.
 */
export const parseWebsiteOrigin = (
  raw: string | undefined,
  nodeEnv: string | undefined,
): string | undefined => {
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = raw.trim();
  const invalid = new Error(
    'Invalid value for COMMUNITY_WEBSITE_ORIGIN: expected one exact origin such as https://wellapath.org',
  );
  if (value.includes('*') || value.includes(',') || /\s/.test(value)) throw invalid;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid;
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  const schemeOk =
    url.protocol === 'https:' || (url.protocol === 'http:' && local && nodeEnv !== 'production');
  if (!schemeOk || url.username || url.password || url.search || url.hash) throw invalid;
  if (url.origin !== value.replace(/\/$/, '') || (url.pathname !== '/' && url.pathname !== '')) {
    throw invalid;
  }
  return url.origin;
};

const hasCommunityPrefix = (path: string): boolean =>
  COMMUNITY_CORS_PREFIXES.some(prefix => path.startsWith(prefix));

/**
 * Classifies a request for the two policies (SEC-005). The router matches the percent-DECODED
 * path (`/v1/%61uth/otp/request` reaches the `/v1/auth/otp/request` route), so the scope is
 * decided on the decoded path too, not on the raw URL. Ambiguity resolves to the restrictive
 * Community policy: the path is in scope if either its raw or its decoded form has a Community
 * prefix, and a path that cannot be decoded (malformed `%`) is treated as in scope.
 */
export const isCommunityCorsPath = (url: string): boolean => {
  const raw = url.split(/[?#]/, 1)[0];
  if (hasCommunityPrefix(raw)) return true;
  if (!raw.includes('%')) return false;
  try {
    return hasCommunityPrefix(decodeURIComponent(raw));
  } catch {
    return true;
  }
};

export interface CorsPolicyOptions {
  /** The app-wide origin option (production allowlist, or reflect-any outside production). */
  appOrigin: FastifyCorsOptions['origin'];
  /** The website origin, when Community is enabled and one is configured. */
  websiteOrigin?: string;
  /** False when `COMMUNITY_MODE=disabled`: the Community paths then get no grant at all. */
  communityEnabled: boolean;
}

/** The `@fastify/cors` delegator implementing the two policies above. */
export const corsDelegator =
  (policy: CorsPolicyOptions) =>
  (
    request: FastifyRequest,
    callback: (error: Error | null, options: FastifyCorsOptions) => void,
  ): void => {
    if (!isCommunityCorsPath(request.url)) {
      callback(null, { origin: policy.appOrigin, methods: APP_CORS_METHODS });
      return;
    }
    const origin = request.headers.origin;
    if (!policy.communityEnabled || !policy.websiteOrigin || origin !== policy.websiteOrigin) {
      callback(null, { origin: false });
      return;
    }
    callback(null, {
      origin: policy.websiteOrigin,
      methods: COMMUNITY_CORS_METHODS,
      allowedHeaders: COMMUNITY_CORS_ALLOWED_HEADERS,
      exposedHeaders: COMMUNITY_CORS_EXPOSED_HEADERS,
      credentials: false,
      maxAge: COMMUNITY_CORS_MAX_AGE_SECONDS,
    });
  };
