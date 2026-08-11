/**
 * Sink that accepts and discards. Used when `TELEMETRY_SINK=none`.
 *
 * Useful for exercising validation and the operational metrics without emitting anything at
 * all — for example when confirming that the endpoint is well-behaved before a sink has been
 * chosen.
 */
import { TelemetryBatch, TelemetrySink } from './types';

export class NoopSink implements TelemetrySink {
  readonly name = 'none';

  async deliver(_batch: TelemetryBatch): Promise<void> {
    return;
  }
}
