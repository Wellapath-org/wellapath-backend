import { FastifyInstance } from 'fastify';
import { healthRoutes } from './health';
import { versionRoutes } from './version';
import { configRoutes } from './config';

export const registerRoutes = (server: FastifyInstance): void => {
  healthRoutes(server);
  versionRoutes(server);
  configRoutes(server);
};
