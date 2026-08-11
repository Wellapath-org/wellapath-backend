/**
 * `GET /internal/metrics` — operational metrics snapshot.
 *
 * Plain JSON, matching the style of the other endpoints on this service, rather than
 * introducing a Prometheus client library for a handful of counters. The snapshot contains
 * counts and latency histograms only: no symptom, answer, condition, score, red-flag,
 * location, session, event, facility, article, IP or user-agent value can appear in it,
 * because every label set is closed at construction time (see `src/telemetry/metrics.ts`).
 */
import { FastifyInstance } from 'fastify';
import { metrics } from '../telemetry/metrics';

export const METRICS_ROUTE = '/internal/metrics';

export interface MetricsRouteOptions {
  enabled: boolean;
  /** Reported alongside the counters so a snapshot is self-describing. */
  telemetryEnabled: boolean;
  sink: string;
  contractVersion: string;
}

export const metricsRoutes = (server: FastifyInstance, options: MetricsRouteOptions): void => {
  if (!options.enabled) return;

  server.get(METRICS_ROUTE, async (_request, reply) => {
    return reply.status(200).send({
      generated_at: new Date().toISOString(),
      telemetry_contract_version: options.contractVersion,
      telemetry_enabled: options.telemetryEnabled,
      telemetry_sink: options.sink,
      metrics: metrics.snapshot(),
    });
  });
};
