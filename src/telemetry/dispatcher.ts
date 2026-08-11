/**
 * Delivery of validated batches to the configured sink.
 *
 * Three properties matter here, in this order:
 *
 *   1. **It can never affect the caller.** `dispatch()` returns synchronously, after the HTTP
 *      response has already been decided. Nothing a sink does — throwing, hanging, failing
 *      every retry — can block, delay or alter a user's assessment, red-flag, scoring, result,
 *      emergency or facility-locator flow. Those flows run on-device and do not consult this
 *      service at all; this class makes sure the telemetry path cannot become a back door into
 *      them.
 *   2. **Retries are bounded.** A fixed maximum attempt count with linear backoff, and no
 *      unbounded queue. Work that cannot be delivered is dropped and counted.
 *   3. **Resource use is bounded.** In-flight deliveries are capped; beyond the cap, batches
 *      are dropped immediately rather than accumulating in memory.
 */
import { TelemetryBatch, TelemetrySink } from './sinks/types';

export interface DispatcherOptions {
  sink: TelemetrySink;
  /** Retries *after* the first attempt. `0` means a single attempt. */
  maxRetries: number;
  /** Base delay between attempts, multiplied by the attempt number. */
  retryBaseDelayMs: number;
  /** Maximum concurrent in-flight deliveries before batches are shed. */
  maxInFlight: number;
  /** Called once per retry attempt. */
  onRetry(): void;
  /** Called when a batch is abandoned after exhausting retries, or shed under backpressure. */
  onDrop(eventCount: number): void;
  /** Called when delivery ultimately fails. Receives a fixed reason, never sink internals. */
  onFailure(): void;
  /** Structured logging hook. Never receives event payloads. */
  logWarning(message: string, detail: Record<string, unknown>): void;
}

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    // Do not hold the event loop open on a pending retry during shutdown or in tests.
    if (typeof timer.unref === 'function') timer.unref();
  });

export class TelemetryDispatcher {
  private inFlight = new Set<Promise<void>>();

  constructor(private readonly options: DispatcherOptions) {}

  /**
   * Hands a batch to the sink without waiting for it. Returns immediately and never throws.
   */
  dispatch(batch: TelemetryBatch): void {
    if (this.inFlight.size >= this.options.maxInFlight) {
      this.options.onDrop(batch.events.length);
      this.options.logWarning('telemetry_dispatch_shed', {
        reason: 'max_in_flight_reached',
        in_flight: this.inFlight.size,
      });
      return;
    }

    const task = this.deliverWithRetries(batch).finally(() => {
      this.inFlight.delete(task);
    });
    this.inFlight.add(task);
  }

  private async deliverWithRetries(batch: TelemetryBatch): Promise<void> {
    const attempts = this.options.maxRetries + 1;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await this.options.sink.deliver(batch);
        return;
      } catch {
        // The sink's error is deliberately not captured: a provider error message could quote
        // back part of the payload it was handed.
        if (attempt < attempts) {
          this.options.onRetry();
          await sleep(this.options.retryBaseDelayMs * attempt);
          continue;
        }
        this.options.onFailure();
        this.options.onDrop(batch.events.length);
        this.options.logWarning('telemetry_delivery_failed', {
          sink: this.options.sink.name,
          attempts,
          event_count: batch.events.length,
        });
      }
    }
  }

  /** Number of deliveries currently in flight. Exposed for tests and backpressure assertions. */
  inFlightCount(): number {
    return this.inFlight.size;
  }

  /** Waits for in-flight deliveries to settle. Test and graceful-shutdown helper only. */
  async drain(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }
}
