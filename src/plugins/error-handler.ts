import { FastifyInstance, FastifyError, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { REJECTION_REASONS, RejectionReason } from '../telemetry/reason-codes';

/**
 * Framework errors whose own message quotes the offending input back at you.
 *
 * Fastify's JSON parse failure, for example, produces a message containing a fragment of the
 * request body. The existing handler surfaced 4xx messages verbatim to the caller *and* logged
 * them, which was harmless while every route was a bodyless `GET` — with a body-accepting
 * endpoint it would become a route for rejected payload content to reach both the response and
 * the log. Each of these codes is therefore answered with a fixed message, and the original
 * message is neither logged nor returned.
 */
const SANITIZED_ERROR_CODES: Record<string, { message: string; reason: RejectionReason }> = {
  FST_ERR_CTP_INVALID_JSON: {
    message: 'Request body could not be parsed',
    reason: REJECTION_REASONS.MALFORMED_JSON,
  },
  FST_ERR_CTP_EMPTY_JSON_BODY: {
    message: 'Request body could not be parsed',
    reason: REJECTION_REASONS.MALFORMED_JSON,
  },
  TELEMETRY_MALFORMED_JSON: {
    message: 'Request body could not be parsed',
    reason: REJECTION_REASONS.MALFORMED_JSON,
  },
  FST_ERR_CTP_BODY_TOO_LARGE: {
    message: 'Request body exceeds the permitted size',
    reason: REJECTION_REASONS.PAYLOAD_TOO_LARGE,
  },
  FST_ERR_CTP_INVALID_MEDIA_TYPE: {
    message: 'Unsupported content type',
    reason: REJECTION_REASONS.UNSUPPORTED_CONTENT_TYPE,
  },
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: {
    message: 'Request body could not be parsed',
    reason: REJECTION_REASONS.MALFORMED_JSON,
  },
  FST_ERR_VALIDATION: {
    message: 'Request failed validation',
    reason: REJECTION_REASONS.INVALID_ENVELOPE,
  },
};

/** Strips the query string. Nothing this service accepts belongs in a log line. */
const safePath = (url: string): string => url.split('?')[0];

async function errorHandlerPlugin(server: FastifyInstance): Promise<void> {
  server.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply): void => {
    server.log.warn(
      {
        requestId: request.id,
        method: request.method,
        path: safePath(request.url),
      },
      'Route not found',
    );

    reply.status(404).send({
      error: {
        statusCode: 404,
        message: 'Route not found',
      },
    });
  });

  server.setErrorHandler(
    (error: FastifyError, request: FastifyRequest, reply: FastifyReply): void => {
      const sanitized = error.code ? SANITIZED_ERROR_CODES[error.code] : undefined;
      const statusCode = error.statusCode ?? (sanitized ? 400 : 500);

      // Log the error server-side — never expose internals to the caller, and never log the
      // message of an error that may contain request content.
      server.log.error({
        err: {
          message: sanitized ? sanitized.message : error.message,
          code: error.code,
          statusCode,
        },
        requestId: request.id,
        method: request.method,
        path: safePath(request.url),
      });

      if (sanitized) {
        reply.status(statusCode).send({
          error: {
            statusCode,
            message: sanitized.message,
            reason_code: sanitized.reason,
          },
        });
        return;
      }

      // 4xx: safe to surface the message (input/validation errors)
      // 5xx: return a generic message — never leak stack traces or DB details
      const clientMessage = statusCode >= 500 ? 'An internal server error occurred' : error.message;

      reply.status(statusCode).send({
        error: {
          statusCode,
          message: clientMessage,
        },
      });
    },
  );
}

export default fp(errorHandlerPlugin, { name: 'error-handler' });
