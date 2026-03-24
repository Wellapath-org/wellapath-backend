import { FastifyInstance } from 'fastify';

export const healthRoutes = (server: FastifyInstance): void => {
  server.get('/health', async (_request, reply) => {
    let dbStatus: 'ok' | 'error' = 'ok';

    try {
      const client = await server.db.connect();
      await client.query('SELECT 1');
      client.release();
    } catch (_err) {
      dbStatus = 'error';
    }

    const status = dbStatus === 'ok' ? 'ok' : 'degraded';
    const httpStatus = dbStatus === 'ok' ? 200 : 503;

    return reply.status(httpStatus).send({
      status,
      timestamp: new Date().toISOString(),
      checks: {
        database: dbStatus,
      },
    });
  });
};
