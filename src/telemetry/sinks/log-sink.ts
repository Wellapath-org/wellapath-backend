/**
 * Default sink: emits each validated batch as a structured Pino log record.
 *
 * Pino structured logging is this project's standard observability output (see
 * `docs/DEPLOYMENT.md`), so this adds no new infrastructure, no new vendor, and no new
 * database table. It is enough to exercise the full contract in staging and to read event
 * volumes off the platform log stream.
 *
 * What is emitted is the already-validated batch — allowlisted fields only. The raw request
 * body is not in scope here and cannot be reached from this class.
 */
import { TelemetryBatch, TelemetrySink } from './types';

export interface LogSinkLogger {
  info(payload: Record<string, unknown>, message: string): void;
}

export class LogSink implements TelemetrySink {
  readonly name = 'log';

  constructor(private readonly logger: LogSinkLogger) {}

  async deliver(batch: TelemetryBatch): Promise<void> {
    for (const event of batch.events) {
      this.logger.info(
        {
          telemetry: {
            contract_version: batch.contract_version,
            received_at: batch.received_at,
            platform: batch.app.platform,
            app_version: batch.app.app_version,
            app_build: batch.app.app_build,
            os_version: batch.app.os_version,
            event,
          },
        },
        'telemetry_event',
      );
    }
  }
}
