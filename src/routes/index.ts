import { FastifyInstance } from 'fastify';
import { healthRoutes } from './health';
import { versionRoutes } from './version';
import { configRoutes } from './config';
import { metricsRoutes, MetricsRouteOptions } from './metrics';
import { telemetryRoutes, TelemetryRouteOptions } from './telemetry';

export interface RegisterRoutesOptions {
  telemetry: TelemetryRouteOptions;
  metrics: MetricsRouteOptions;
}

export const registerRoutes = async (
  server: FastifyInstance,
  options: RegisterRoutesOptions,
): Promise<void> => {
  healthRoutes(server);
  versionRoutes(server);
  configRoutes(server);
  metricsRoutes(server, options.metrics);
  await telemetryRoutes(server, options.telemetry);
};
