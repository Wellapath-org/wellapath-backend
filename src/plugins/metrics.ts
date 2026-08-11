/**
 * Records backend-wide request rate, latency and error rate.
 *
 * Uses the matched *route pattern* rather than the request URL, so no query string, path
 * parameter or identifier can reach a metric label. Unrecognised routes — including 404s —
 * collapse into a single `other` bucket.
 */
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { metrics } from '../telemetry/metrics';

async function metricsPlugin(server: FastifyInstance): Promise<void> {
  server.addHook('onResponse', async (request: FastifyRequest, reply: FastifyReply) => {
    const route = request.routeOptions?.url ?? 'other';
    metrics.observeHttpRequest(route, reply.statusCode, reply.elapsedTime);
  });
}

export default fp(metricsPlugin, { name: 'metrics' });
