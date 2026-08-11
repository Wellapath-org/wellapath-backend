/**
 * `POST /v1/telemetry/events` — the only write surface on this backend.
 *
 * Existing endpoints (`/health`, `/version`, `/config`) stay unversioned and unchanged. New
 * API surface is versioned from the start so the contract can evolve without breaking a
 * shipped mobile build.
 *
 * The route is registered inside its own encapsulated plugin scope so that its body limit and
 * its JSON parser apply here and nowhere else.
 */
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { LIMITS } from '../telemetry/contract';
import { metrics } from '../telemetry/metrics';
import { REJECTION_REASONS } from '../telemetry/reason-codes';
import { buildIngestError, TelemetryService } from '../telemetry/service';

export const TELEMETRY_ROUTE = '/v1/telemetry/events';

/** Error thrown by the scoped JSON parser. Carries no fragment of the body. */
class MalformedTelemetryBodyError extends Error {
  readonly statusCode = 400;
  readonly code = 'TELEMETRY_MALFORMED_JSON';

  constructor() {
    super('Request body could not be parsed');
  }
}

export interface TelemetryRouteOptions {
  service: TelemetryService;
  /** Requests per minute per client. */
  rateLimitMax: number;
}

export const telemetryRoutes = async (
  server: FastifyInstance,
  options: TelemetryRouteOptions,
): Promise<void> => {
  await server.register(async (scope: FastifyInstance): Promise<void> => {
    /**
     * Scoped JSON parser.
     *
     * Fastify's default parser raises an error whose message quotes the offending input — that
     * message would then reach both the error log and the 400 response. Parsing here lets a
     * malformed body be refused with a fixed message and no trace of its content.
     */
    // Drop the inherited parsers (including `text/plain`) so anything that is not JSON is
    // refused with 415 rather than being coerced into a body this route then has to reason
    // about.
    scope.removeAllContentTypeParsers();

    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'string', bodyLimit: LIMITS.maxBodyBytes },
      (_request, body: string, done) => {
        try {
          done(null, JSON.parse(body));
        } catch {
          done(new MalformedTelemetryBodyError(), undefined);
        }
      },
    );

    scope.post(
      TELEMETRY_ROUTE,
      {
        bodyLimit: LIMITS.maxBodyBytes,
        config: {
          rateLimit: {
            max: options.rateLimitMax,
            timeWindow: '1 minute',
          },
        },
      },
      async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
        const startedAt = process.hrtime.bigint();

        const result = options.service.ingest(request.body);

        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
        metrics.observeTelemetryDuration(durationMs);

        return reply.status(result.statusCode).send(result.body);
      },
    );
  });
};

/** Shared by the error handler so a shed/parse failure is reported in the same shape. */
export const malformedBodyResponse = (): ReturnType<typeof buildIngestError> =>
  buildIngestError(400, REJECTION_REASONS.MALFORMED_JSON);
