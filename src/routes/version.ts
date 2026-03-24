import { FastifyInstance } from 'fastify';
import { config } from '../config/env';

export const versionRoutes = (server: FastifyInstance): void => {
  server.get('/version', async (_request, reply) => {
    return reply.status(200).send({
      version: config.appVersion,
      environment: config.nodeEnv,
    });
  });
};
