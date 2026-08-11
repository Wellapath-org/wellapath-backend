import { TelemetryDispatcher, DispatcherOptions } from '../../src/telemetry/dispatcher';
import { TelemetryBatch, TelemetrySink } from '../../src/telemetry/sinks/types';
import { ValidatedEvent } from '../../src/telemetry/types';

const batch = (eventCount = 1): TelemetryBatch => ({
  contract_version: '1.0',
  received_at: new Date().toISOString(),
  app: { platform: 'android', app_version: '1.4.2', app_build: '204' },
  events: Array.from(
    { length: eventCount },
    (_, i) =>
      ({
        event_name: 'app_open',
        event_id: `evt_${i}`,
        client_ts: new Date().toISOString(),
        launch_type: 'cold',
      }) as unknown as ValidatedEvent,
  ),
});

interface Counters {
  retries: number;
  failures: number;
  dropped: number;
  warnings: { message: string; detail: Record<string, unknown> }[];
}

const makeDispatcher = (
  sink: TelemetrySink,
  overrides: Partial<DispatcherOptions> = {},
): { dispatcher: TelemetryDispatcher; counters: Counters } => {
  const counters: Counters = { retries: 0, failures: 0, dropped: 0, warnings: [] };

  const dispatcher = new TelemetryDispatcher({
    sink,
    maxRetries: 2,
    retryBaseDelayMs: 1,
    maxInFlight: 10,
    onRetry: () => {
      counters.retries += 1;
    },
    onFailure: () => {
      counters.failures += 1;
    },
    onDrop: count => {
      counters.dropped += count;
    },
    logWarning: (message, detail) => counters.warnings.push({ message, detail }),
    ...overrides,
  });

  return { dispatcher, counters };
};

describe('dispatcher', () => {
  it('delivers a batch to the sink', async () => {
    const delivered: TelemetryBatch[] = [];
    const sink: TelemetrySink = {
      name: 'ok',
      deliver: async b => {
        delivered.push(b);
      },
    };

    const { dispatcher } = makeDispatcher(sink);
    dispatcher.dispatch(batch());
    await dispatcher.drain();

    expect(delivered).toHaveLength(1);
  });

  it('returns synchronously without waiting for the sink', () => {
    const sink: TelemetrySink = {
      name: 'hanging',
      deliver: () => new Promise<void>(() => undefined),
    };

    const { dispatcher } = makeDispatcher(sink);
    const startedAt = Date.now();
    dispatcher.dispatch(batch());

    expect(Date.now() - startedAt).toBeLessThan(50);
    expect(dispatcher.inFlightCount()).toBe(1);
  });

  it('retries a failing delivery up to the bound, then gives up', async () => {
    let attempts = 0;
    const sink: TelemetrySink = {
      name: 'failing',
      deliver: async () => {
        attempts += 1;
        throw new Error('provider down');
      },
    };

    const { dispatcher, counters } = makeDispatcher(sink, { maxRetries: 2 });
    dispatcher.dispatch(batch(3));
    await dispatcher.drain();

    expect(attempts).toBe(3); // first attempt + 2 retries
    expect(counters.retries).toBe(2);
    expect(counters.failures).toBe(1);
    expect(counters.dropped).toBe(3);
  });

  it('stops retrying as soon as a delivery succeeds', async () => {
    let attempts = 0;
    const sink: TelemetrySink = {
      name: 'flaky',
      deliver: async () => {
        attempts += 1;
        if (attempts < 2) throw new Error('transient');
      },
    };

    const { dispatcher, counters } = makeDispatcher(sink);
    dispatcher.dispatch(batch());
    await dispatcher.drain();

    expect(attempts).toBe(2);
    expect(counters.failures).toBe(0);
    expect(counters.dropped).toBe(0);
  });

  it('makes exactly one attempt when retries are disabled', async () => {
    let attempts = 0;
    const sink: TelemetrySink = {
      name: 'failing',
      deliver: async () => {
        attempts += 1;
        throw new Error('down');
      },
    };

    const { dispatcher } = makeDispatcher(sink, { maxRetries: 0 });
    dispatcher.dispatch(batch());
    await dispatcher.drain();

    expect(attempts).toBe(1);
  });

  it('never throws, whatever the sink does', async () => {
    const sink: TelemetrySink = {
      name: 'hostile',
      deliver: () => {
        throw new Error('synchronous explosion');
      },
    };

    const { dispatcher, counters } = makeDispatcher(sink);
    expect(() => dispatcher.dispatch(batch())).not.toThrow();
    await dispatcher.drain();
    expect(counters.failures).toBe(1);
  });

  it('sheds batches rather than queueing without bound', async () => {
    const sink: TelemetrySink = {
      name: 'hanging',
      deliver: () => new Promise<void>(() => undefined),
    };

    const { dispatcher, counters } = makeDispatcher(sink, { maxInFlight: 3 });
    for (let i = 0; i < 20; i += 1) dispatcher.dispatch(batch(2));

    expect(dispatcher.inFlightCount()).toBe(3);
    expect(counters.dropped).toBe(17 * 2);
    expect(counters.warnings[0].message).toBe('telemetry_dispatch_shed');
  });

  it('never carries a sink error message into its own reporting', async () => {
    const sink: TelemetrySink = {
      name: 'leaky',
      deliver: async () => {
        throw new Error('failed to insert row: symptom_text=fever, patient=Ada');
      },
    };

    const { dispatcher, counters } = makeDispatcher(sink);
    dispatcher.dispatch(batch());
    await dispatcher.drain();

    const serialized = JSON.stringify(counters.warnings);
    expect(serialized).not.toContain('fever');
    expect(serialized).not.toContain('Ada');
    expect(serialized).not.toContain('symptom_text');
  });

  it('releases in-flight slots once deliveries settle', async () => {
    const sink: TelemetrySink = { name: 'ok', deliver: async () => undefined };
    const { dispatcher } = makeDispatcher(sink);

    for (let i = 0; i < 5; i += 1) dispatcher.dispatch(batch());
    await dispatcher.drain();

    expect(dispatcher.inFlightCount()).toBe(0);
  });
});
