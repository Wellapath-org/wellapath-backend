/**
 * Application factory.
 *
 * Previously the Fastify instance was built and started in one pass inside `server.ts`, which
 * meant importing the app also bound a port. Splitting construction from listening is what lets
 * the integration and privacy tests drive the real stack through `app.inject()` — including the
 * real error handler, the real rate limiter and the real log pipeline — instead of testing a
 * reassembled imitation of it.
 *
 * `server.ts` keeps exactly the same runtime behaviour: build, then listen.
 */
import Fastify, { FastifyInstance, FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { config } from './config/env';
import { corsDelegator, parseWebsiteOrigin } from './config/cors';
import { parseTrustProxyHops } from './config/trust-proxy';
import {
  ClientIpSource,
  isUnattributedKey,
  parseClientIpSource,
  securityClientIp,
  SecurityClientIp,
} from './config/client-ip';
import { loadCommunityConfig } from './community/config';
import { registerCommunity, RegisterCommunityOptions } from './community';
import { scrubbingStream, scrubLogArgs, scrubLogValue } from './community/log-safety';
import dbPlugin from './plugins/db';
import errorHandlerPlugin from './plugins/error-handler';
import metricsPlugin from './plugins/metrics';
import securityHeadersPlugin from './plugins/security-headers';
import { registerRoutes } from './routes';
import { TELEMETRY_CONTRACT_VERSION } from './telemetry/contract';
import { DedupeStore } from './telemetry/dedupe';
import { TelemetryDispatcher } from './telemetry/dispatcher';
import { metrics } from './telemetry/metrics';
import { buildLogRedactionPaths } from './telemetry/prohibited';
import { TelemetryService } from './telemetry/service';
import { createSink, TelemetrySink } from './telemetry/sinks';

export interface BuildAppOptions {
  /** Pino destination. Tests pass a capture stream to assert on what is and is not logged. */
  logDestination?: NodeJS.WritableStream;
  /** Overrides `config.telemetry.enabled`. */
  telemetryEnabled?: boolean;
  /** Injects a sink directly, bypassing the name-based factory. */
  telemetrySink?: TelemetrySink;
  /** Overrides the global rate limit. */
  rateLimitMax?: number;
  /** Overrides the telemetry endpoint rate limit. */
  telemetryRateLimitMax?: number;
  /** Registers the PostgreSQL pool. Off for tests that do not exercise `/health`. */
  registerDatabase?: boolean;
  /** Injectable clock for the telemetry pipeline. */
  now?: () => number;
  /**
   * Community PoC wiring. Omitted → configuration is read from `COMMUNITY_MODE` (default
   * `disabled`, which registers only the constant `GET /v1/features`).
   */
  community?: Partial<RegisterCommunityOptions>;
  /**
   * Trusted proxy hop count. Omitted → `TRUST_PROXY_HOPS` (unset ⇒ no proxy trusted, so
   * `request.ip` is the socket peer). Never `true` (ADR-001 A3).
   */
  trustProxyHops?: number;
  /**
   * Where the security client IP comes from (SEC-001/SEC-002). Omitted → `CLIENT_IP_SOURCE`
   * (unset ⇒ `socket`, i.e. `request.ip`). `cf-connecting-ip` is for Render only.
   */
  clientIpSource?: ClientIpSource;
  /**
   * The website origin granted CORS on `/v1/community/*` and `/v1/auth/*` (C8). Omitted →
   * `COMMUNITY_WEBSITE_ORIGIN`; `null` → none.
   */
  websiteOrigin?: string | null;
}

export interface BuiltApp {
  server: FastifyInstance;
  dispatcher: TelemetryDispatcher;
  dedupe: DedupeStore;
  service: TelemetryService;
}

/**
 * Production CORS allowlist. The API's only production client is the native mobile app, which
 * does not send an Origin header and needs no CORS grant at all; the single entry is the
 * first-party site, kept so a future page on it can call the API without a config change.
 * The superseded `api-staging.wellapath.org` entry was removed — it was a staging marker in
 * production configuration and the hostname has no DNS record. Every other browser origin
 * gets no `access-control-allow-origin` and is refused by the browser.
 */
const ALLOWED_ORIGINS = config.nodeEnv === 'production' ? ['https://wellapath.org'] : true;

export const buildApp = async (options: BuildAppOptions = {}): Promise<BuiltApp> => {
  const trustProxyHops =
    'trustProxyHops' in options
      ? options.trustProxyHops
      : parseTrustProxyHops(process.env.TRUST_PROXY_HOPS);
  const clientIpSource =
    options.clientIpSource ?? parseClientIpSource(process.env.CLIENT_IP_SOURCE);
  if (clientIpSource === 'cf-connecting-ip' && trustProxyHops !== undefined) {
    // Two IP sources at once would make `request.ip` and the security IP disagree.
    throw new Error(
      'CLIENT_IP_SOURCE=cf-connecting-ip and TRUST_PROXY_HOPS are mutually exclusive: unset TRUST_PROXY_HOPS',
    );
  }
  const server = Fastify({
    // An explicit integer hop count, or nothing. With a hop count, Fastify takes the address that
    // many positions from the right of X-Forwarded-For; client-written values on the left cannot
    // change it. Applies to the app-wide limiter too (contract §15 F3).
    // Expressed as proxy-addr's hop-count predicate (the integer form) so the type is explicit.
    ...(trustProxyHops !== undefined
      ? { trustProxy: (_address: string, hop: number): boolean => hop < trustProxyHops }
      : {}),
    logger: {
      level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
      transport:
        process.env.NODE_ENV !== 'production' && !options.logDestination
          ? { target: 'pino-pretty', options: { colorize: true } }
          : undefined,
      // Centralized redaction — built from the same prohibited-key list the telemetry
      // validator uses, so the two cannot drift apart.
      redact: [...buildLogRedactionPaths(), 'email', '*.email', 'recipient', '*.recipient'],
      // No full email address in any log line (sign-in retention rule): every merged log object
      // and every message string is scrubbed (`j***@example.com`). See community/log-safety.ts.
      formatters: {
        log: (object: Record<string, unknown>): Record<string, unknown> =>
          scrubLogValue(object) as Record<string, unknown>,
      },
      hooks: { logMethod: scrubLogArgs },
      serializers: {
        /**
         * Fastify's default request serializer logs `req.url` in full. No endpoint on this
         * service reads a query parameter, so a query string can only ever be noise or a
         * leak — it is dropped here rather than sanitised downstream. `remoteAddress` is
         * dropped too: an IP is a personal identifier, and the brief keeps personal
         * identifiers out of routine logs. Rate limiting still uses the address at runtime;
         * it just never reaches the log.
         */
        req: (request: { method: string; url: string }) => ({
          method: request.method,
          path: request.url.split('?')[0],
        }),
        res: (reply: { statusCode: number }) => ({ statusCode: reply.statusCode }),
      },
      // Every serialized line passes the email scrubber (the pino-pretty transport, used only
      // in local development, gets the object/message scrubbing above).
      ...(options.logDestination
        ? { stream: scrubbingStream(options.logDestination) }
        : process.env.NODE_ENV === 'production'
          ? { stream: scrubbingStream(process.stdout) }
          : {}),
    },
  });

  const communityConfig = options.community?.config ?? loadCommunityConfig();
  const websiteOrigin =
    options.websiteOrigin === null
      ? undefined
      : (options.websiteOrigin ??
        parseWebsiteOrigin(process.env.COMMUNITY_WEBSITE_ORIGIN, config.nodeEnv));

  // Two policies (src/config/cors.ts, contract §1 C8). App-wide: the allowlist above with
  // GET/POST/OPTIONS (POST is required for telemetry intake), unchanged for /config and every
  // other route. /v1/community/* and /v1/auth/*: only the configured website origin, which may
  // also use PUT and DELETE, never with credentials.
  await server.register(cors, {
    delegator: corsDelegator({
      appOrigin: ALLOWED_ORIGINS,
      websiteOrigin,
      communityEnabled: communityConfig.mode !== 'disabled',
    }),
  });

  // SEC-001/SEC-027: derive the security client IP ONCE per request, before any limiter runs.
  // Unattributed requests (cf-connecting-ip source, edge header missing or malformed) are counted
  // and, at most once a minute, logged as counts only (never an IP): the production alert signal,
  // because /internal/metrics is off in production.
  const securityIps = new WeakMap<FastifyRequest, SecurityClientIp>();
  const securityIpOf = (request: FastifyRequest): SecurityClientIp => {
    let found = securityIps.get(request);
    if (!found) {
      found = securityClientIp(request, clientIpSource);
      securityIps.set(request, found);
    }
    return found;
  };
  let unattributedWindow = { missing: 0, malformed: 0, attributed: 0, since: Date.now() };
  server.addHook('onRequest', async request => {
    if (clientIpSource !== 'cf-connecting-ip') return;
    const derived = securityIpOf(request);
    if (derived.via === 'unattributed' && derived.reason) {
      metrics.securityClientIpUnattributed.increment(derived.reason);
      unattributedWindow[derived.reason] += 1;
    } else {
      metrics.securityClientIpAttributed.increment();
      unattributedWindow.attributed += 1;
    }
    const now = Date.now();
    if (now - unattributedWindow.since >= 60_000) {
      const w = unattributedWindow;
      if (w.missing + w.malformed > 0) {
        server.log.warn(
          {
            event: 'security_client_ip_unattributed',
            window_seconds: Math.round((now - w.since) / 1000),
            missing: w.missing,
            malformed: w.malformed,
            attributed: w.attributed,
          },
          'unattributed security client IP requests (edge header missing or malformed)',
        );
      }
      unattributedWindow = { missing: 0, malformed: 0, attributed: 0, since: now };
    }
  });

  await server.register(rateLimit, {
    max: options.rateLimitMax ?? 100,
    timeWindow: '1 minute',
    // SEC-001: the canonical security client IP, never a client-chosen header. Route-level
    // limits (telemetry) inherit this key.
    keyGenerator: request => securityIpOf(request).ip,
    /**
     * `@fastify/rate-limit` *throws* whatever this builder returns. The previous version
     * returned a plain `{ error: { statusCode: 429 } }` object, which has no top-level
     * `statusCode`, so the global error handler fell through to its 500 branch: every
     * rate-limited request answered `500 An internal server error occurred` instead of 429.
     * Returning a real Error with `statusCode` restores the documented envelope — the error
     * handler renders `{ error: { statusCode: 429, message } }` from it.
     */
    errorResponseBuilder: (_request, context) => {
      const error = new Error(`Rate limit exceeded. Try again in ${context.after}.`) as Error & {
        statusCode: number;
      };
      error.statusCode = context.statusCode ?? 429;
      return error;
    },
  });

  // The database is registered only when it is both enabled by configuration and not
  // excluded by the caller. `/health` is told the outcome so it reports `disabled` truthfully
  // instead of failing a check that was never going to run.
  const databaseRegistered = config.db.enabled && options.registerDatabase !== false;
  if (databaseRegistered) {
    await server.register(dbPlugin);
  }

  await server.register(errorHandlerPlugin);
  await server.register(securityHeadersPlugin);
  await server.register(metricsPlugin);

  const sink =
    options.telemetrySink ??
    createSink({
      name: config.telemetry.sink,
      logger: server.log,
      onUnknown: name =>
        server.log.warn({ requested_sink: name }, 'Unknown telemetry sink — falling back to none'),
    });

  const dedupe = new DedupeStore({
    ttlMs: config.telemetry.dedupeTtlSeconds * 1000,
    maxEntries: config.telemetry.dedupeMaxEntries,
  });

  const dispatcher = new TelemetryDispatcher({
    sink,
    maxRetries: config.telemetry.sinkMaxRetries,
    retryBaseDelayMs: config.telemetry.sinkRetryDelayMs,
    maxInFlight: config.telemetry.sinkMaxInFlight,
    onRetry: (): void => metrics.telemetrySinkRetries.increment(),
    onFailure: (): void => metrics.telemetrySinkFailures.increment(),
    onDrop: (count: number): void => metrics.telemetryEventsDropped.increment(count),
    logWarning: (message: string, detail: Record<string, unknown>): void =>
      server.log.warn(detail, message),
  });

  const telemetryEnabled = options.telemetryEnabled ?? config.telemetry.enabled;

  const service = new TelemetryService({
    enabled: telemetryEnabled,
    dispatcher,
    dedupe,
    now: options.now,
  });

  await registerRoutes(server, {
    health: {
      databaseRegistered,
    },
    telemetry: {
      service,
      rateLimitMax: options.telemetryRateLimitMax ?? config.telemetry.rateLimitMax,
    },
    metrics: {
      enabled: config.metricsEndpointEnabled,
      telemetryEnabled,
      sink: sink.name,
      contractVersion: TELEMETRY_CONTRACT_VERSION,
    },
  });

  // Community (ADR-001 PoC). Registered after the core routes and independent of them: its own
  // config, its own pool, no effect on /config, /health or /version.
  await registerCommunity(server, {
    ...options.community,
    config: communityConfig,
    clientIp: (request): string => securityIpOf(request).ip,
    isUnattributedKey,
    clientIpAttributed: trustProxyHops !== undefined || clientIpSource === 'cf-connecting-ip',
  });

  server.addHook('onClose', async () => {
    dedupe.clear();
  });

  return { server, dispatcher, dedupe, service };
};
