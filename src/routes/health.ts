import { FastifyInstance } from 'fastify';

export const healthRoutes = (server: FastifyInstance): void => {
  server.get('/health', async (_request, reply) => {
    return reply.status(200).send({
      status: 'ok',
      timestamp: new Date().toISOString(),
    });
  });
};
