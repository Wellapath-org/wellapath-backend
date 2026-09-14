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
import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { config } from './config/env';
import {
  FacilitiesV2Declaration,
  FacilitiesV2Resolution,
  resolveFacilitiesV2,
} from './manifest/facilities-v2';
import dbPlugin from './plugins/db';
import errorHandlerPlugin from './plugins/error-handler';
import metricsPlugin from './plugins/metrics';
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
   * Overrides the Facilities 2.0 declaration (default: parsed from the environment) and the
   * environment name the production gate checks (default: `config.nodeEnv`). Tests use this to
   * exercise the gates without touching process state; the resolution itself always runs
   * through the real `resolveFacilitiesV2`.
   */
  facilitiesV2?: {
    declaration?: FacilitiesV2Declaration;
    environment?: string;
  };
}

export interface BuiltApp {
  server: FastifyInstance;
  dispatcher: TelemetryDispatcher;
  dedupe: DedupeStore;
  service: TelemetryService;
  /** The startup Facilities 2.0 gate decision, exposed so tests can assert on the reasons. */
  facilitiesV2: FacilitiesV2Resolution;
}

const ALLOWED_ORIGINS =
  config.nodeEnv === 'production'
    ? ['https://wellapath.org', 'https://api-staging.wellapath.org']
    : true;

export const buildApp = async (options: BuildAppOptions = {}): Promise<BuiltApp> => {
  const server = Fastify({
    logger: {
      level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
      transport:
        process.env.NODE_ENV !== 'production' && !options.logDestination
          ? { target: 'pino-pretty', options: { colorize: true } }
          : undefined,
      // Centralized redaction — built from the same prohibited-key list the telemetry
      // validator uses, so the two cannot drift apart.
      redact: buildLogRedactionPaths(),
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
      ...(options.logDestination ? { stream: options.logDestination } : {}),
    },
  });

  await server.register(cors, {
    origin: ALLOWED_ORIGINS,
    // POST is required for telemetry intake; it was GET-only while the service had no write
    // surface at all. No other method is permitted.
    methods: ['GET', 'POST', 'OPTIONS'],
  });

  await server.register(rateLimit, {
    max: options.rateLimitMax ?? 100,
    timeWindow: '1 minute',
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

  if (options.registerDatabase !== false) {
    await server.register(dbPlugin);
  }

  await server.register(errorHandlerPlugin);
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

  // Facilities 2.0 gate — resolved exactly once, before any route exists. A refused
  // declaration changes nothing: `/config` keeps serving the frozen v1.1 response, and the
  // refusal is logged as reason codes and field names ONLY. The configured values themselves
  // (URLs, digests, whatever was mistakenly pasted into a variable) never reach the logs.
  const facilitiesV2Declaration = options.facilitiesV2?.declaration ?? config.facilitiesV2;
  const facilitiesV2Environment = options.facilitiesV2?.environment ?? config.nodeEnv;
  const facilitiesV2 = resolveFacilitiesV2(facilitiesV2Declaration, facilitiesV2Environment);
  if (facilitiesV2Declaration.enabled && facilitiesV2.exposure === null) {
    server.log.warn(
      {
        facilities_v2_refused: facilitiesV2.reasons.map(reason => ({
          code: reason.code,
          field: reason.field,
        })),
      },
      'Facilities v2 declaration refused — /config continues to serve facilities v1.1 only',
    );
  } else if (facilitiesV2.exposure !== null) {
    server.log.info(
      {
        facilities_v2_version: facilitiesV2.exposure.artifact.version,
        facilities_v2_schema: facilitiesV2.exposure.schema_version,
      },
      'Facilities v2 manifest entry enabled on /config',
    );
  }

  const service = new TelemetryService({
    enabled: telemetryEnabled,
    dispatcher,
    dedupe,
    now: options.now,
  });

  await registerRoutes(server, {
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
    config: {
      facilitiesV2: facilitiesV2.exposure,
    },
  });

  server.addHook('onClose', async () => {
    dedupe.clear();
  });

  return { server, dispatcher, dedupe, service, facilitiesV2 };
};
