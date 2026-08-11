/**
 * Provider-neutral telemetry sink interface.
 *
 * No analytics vendor has been selected for WellaPath, and this step deliberately does not
 * choose one. Everything downstream of validation talks to this interface, so adopting a
 * provider later is a new file in this directory plus one environment variable — no change to
 * the contract, the validator, the route, or the mobile client.
 *
 * A sink only ever receives a `TelemetryBatch`, which is built exclusively from validated,
 * allowlisted fields. The raw request body is not available to a sink and is never retained.
 */
import { ValidatedAppContext, ValidatedEvent } from '../types';

/** The only shape a sink ever sees. Constructed after validation, from allowlisted values. */
export interface TelemetryBatch {
  contract_version: string;
  /** Server receipt time, ISO-8601 UTC. */
  received_at: string;
  app: ValidatedAppContext;
  events: ValidatedEvent[];
}

export interface TelemetrySink {
  /** Stable identifier, used in operational logs and in the metrics snapshot. */
  readonly name: string;
  /** Delivers a batch. Rejecting the promise signals a retryable failure. */
  deliver(batch: TelemetryBatch): Promise<void>;
}
