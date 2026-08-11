/**
 * Test harness around the real application factory.
 *
 * Tests drive the actual Fastify stack — real error handler, real rate limiter, real content-type
 * parser, real log pipeline — through `inject()`. Log output is captured so a test can assert on
 * what did *not* reach the logs, which is most of the point of the privacy suite.
 */
import { Writable } from 'stream';
import { FastifyInstance } from 'fastify';
import { buildApp, BuildAppOptions } from '../../src/app';
import { metrics } from '../../src/telemetry/metrics';
import { TelemetryDispatcher } from '../../src/telemetry/dispatcher';
import { TelemetryBatch, TelemetrySink } from '../../src/telemetry/sinks/types';

/** Collects every byte Pino writes. */
export class LogCapture extends Writable {
  readonly chunks: string[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _write(chunk: any, _encoding: string, callback: (error?: Error | null) => void): void {
    this.chunks.push(chunk.toString());
    callback();
  }

  /** Everything logged, as one string. */
  text(): string {
    return this.chunks.join('');
  }

  clear(): void {
    this.chunks.length = 0;
  }
}

/** Sink that records what it was handed. Stands in for a provider in tests. */
export class RecordingSink implements TelemetrySink {
  readonly name = 'recording';
  readonly batches: TelemetryBatch[] = [];

  async deliver(batch: TelemetryBatch): Promise<void> {
    this.batches.push(batch);
  }

  /** Every event this sink has been given, flattened. */
  events(): Record<string, unknown>[] {
    return this.batches.flatMap(batch => batch.events as unknown as Record<string, unknown>[]);
  }
}

/** Sink that always fails, to prove failure cannot reach the caller. */
export class FailingSink implements TelemetrySink {
  readonly name = 'failing';
  attempts = 0;

  async deliver(_batch: TelemetryBatch): Promise<void> {
    this.attempts += 1;
    throw new Error('provider unavailable: 503 upstream');
  }
}

/** Sink that never settles, to prove a hung provider cannot block a response. */
export class HangingSink implements TelemetrySink {
  readonly name = 'hanging';

  async deliver(_batch: TelemetryBatch): Promise<void> {
    return new Promise<void>(() => {
      /* never resolves */
    });
  }
}

export interface TestApp {
  server: FastifyInstance;
  logs: LogCapture;
  dispatcher: TelemetryDispatcher;
  close: () => Promise<void>;
}

export const createTestApp = async (options: BuildAppOptions = {}): Promise<TestApp> => {
  metrics.reset();
  const logs = new LogCapture();

  const built = await buildApp({
    logDestination: logs,
    registerDatabase: false,
    telemetryEnabled: true,
    ...options,
  });

  await built.server.ready();

  return {
    server: built.server,
    logs,
    dispatcher: built.dispatcher,
    close: async (): Promise<void> => {
      await built.dispatcher.drain().catch(() => undefined);
      await built.server.close();
    },
  };
};

/** Waits for in-flight sink deliveries to settle. */
export const settle = async (dispatcher: TelemetryDispatcher): Promise<void> => {
  await dispatcher.drain();
  await new Promise(resolve => setImmediate(resolve));
};
