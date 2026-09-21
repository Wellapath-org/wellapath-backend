import { FastifyInstance } from 'fastify';

export interface HealthRouteOptions {
  /**
   * Whether the database plugin was actually registered on this instance. When it was not —
   * `DATABASE_ENABLED=false`, or a test built the app without it — the health check reports
   * `database: "disabled"` and stays 200: the check never ran, and the response must not
   * pretend it did. Overall health then rests on the dependencies the app really has.
   */
  databaseRegistered: boolean;
}

export const healthRoutes = (server: FastifyInstance, options: HealthRouteOptions): void => {
  server.get('/health', async (_request, reply) => {
    if (!options.databaseRegistered) {
      return reply.status(200).send({
        status: 'ok',
        timestamp: new Date().toISOString(),
        checks: {
          database: 'disabled',
        },
      });
    }

    let dbStatus: 'ok' | 'error' = 'ok';

    try {
      const client = await server.db.connect();
      await client.query('SELECT 1');
      client.release();
    } catch (err) {
      dbStatus = 'error';
      server.log.error({ err: (err as Error).message }, 'Database health check failed');
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
