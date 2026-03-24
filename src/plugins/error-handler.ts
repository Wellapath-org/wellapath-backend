import { FastifyInstance, FastifyError, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';

async function errorHandlerPlugin(server: FastifyInstance): Promise<void> {
  server.setErrorHandler(
    (error: FastifyError, request: FastifyRequest, reply: FastifyReply): void => {
      const statusCode = error.statusCode ?? 500;

      // Log the full error server-side — never expose internals to the caller
      server.log.error({
        err: {
          message: error.message,
          code: error.code,
          statusCode,
        },
        requestId: request.id,
        method: request.method,
        url: request.url,
      });

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
