/**
 * Response security headers.
 *
 * A handful of static headers set on every response, including error envelopes — an `onSend`
 * hook rather than a per-route concern so no future route can forget them. Kept as a few
 * fixed lines instead of introducing `@fastify/helmet`: this service serves JSON to a native
 * mobile client, so the browser-page parts of a full helmet policy (CSP and friends) have
 * nothing to protect here, and a dependency is a larger surface than four headers.
 *
 * HSTS is production-only: it is a durable, host-scoped browser commitment, and the
 * production hostname is the only one whose TLS lifecycle this project controls end to end.
 */
import { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { config } from '../config/env';

async function securityHeadersPlugin(server: FastifyInstance): Promise<void> {
  const production = config.nodeEnv === 'production';

  server.addHook('onSend', async (_request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    if (production) {
      // 180 days, no preload: long enough to protect real clients, short enough to unwind
      // without a preload-list removal if the hostname ever has to change.
      reply.header('strict-transport-security', 'max-age=15552000; includeSubDomains');
    }
    return payload;
  });
}

export default fp(securityHeadersPlugin, { name: 'security-headers' });
