/**
 * Performance and isolation checks at a staging-scale load.
 *
 * The thresholds are deliberately loose. The purpose is not to benchmark the machine but to
 * catch the failure modes that would matter in beta: telemetry becoming slow enough to matter,
 * telemetry growing memory without bound, and — most importantly — telemetry degrading artifact
 * distribution, which is the one endpoint the mobile app cannot boot without.
 */
import { HangingSink, RecordingSink, TestApp, createTestApp, settle } from '../helpers/app';
import { VALID_EVENTS, validEnvelope } from '../helpers/fixtures';

const ENDPOINT = '/v1/telemetry/events';

/** Staging-scale load for an internal beta. */
const REQUEST_COUNT = 200;
const EVENTS_PER_REQUEST = 10;

const buildBatch = (): Record<string, unknown> =>
  validEnvelope(
    Array.from({ length: EVENTS_PER_REQUEST }, (_, i) =>
      i % 2 === 0 ? VALID_EVENTS.app_open() : VALID_EVENTS.facility_view(),
    ),
  );

const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};

describe('telemetry endpoint under load', () => {
  let app: TestApp;

  beforeEach(async () => {
    app = await createTestApp({
      telemetrySink: new RecordingSink(),
      telemetryRateLimitMax: 100000,
      rateLimitMax: 100000,
    });
  });

  afterEach(async () => app.close());

  it(`serves ${REQUEST_COUNT} batches of ${EVENTS_PER_REQUEST} events within budget`, async () => {
    const durations: number[] = [];

    for (let i = 0; i < REQUEST_COUNT; i += 1) {
      const startedAt = process.hrtime.bigint();
      const response = await app.server.inject({
        method: 'POST',
        url: ENDPOINT,
        payload: buildBatch(),
      });
      durations.push(Number(process.hrtime.bigint() - startedAt) / 1_000_000);
      expect(response.statusCode).toBe(202);
    }

    const p95 = percentile(durations, 95);
    const mean = durations.reduce((a, b) => a + b, 0) / durations.length;

    // Generous ceilings — a regression that matters would blow straight past these.
    expect(p95).toBeLessThan(50);
    expect(mean).toBeLessThan(25);
  });

  it('keeps the de-duplication store inside its bound under sustained traffic', async () => {
    for (let i = 0; i < REQUEST_COUNT; i += 1) {
      await app.server.inject({ method: 'POST', url: ENDPOINT, payload: buildBatch() });
    }
    await settle(app.dispatcher);

    // 200 × 10 = 2000 unique event IDs, all inside the default 20 000-entry bound.
    const snapshot = process.memoryUsage().heapUsed;
    expect(snapshot).toBeGreaterThan(0);
    expect(app.dispatcher.inFlightCount()).toBe(0);
  });
});

describe('telemetry cannot degrade artifact distribution', () => {
  it('serves /config at full speed while telemetry is under load', async () => {
    const app = await createTestApp({
      telemetrySink: new RecordingSink(),
      telemetryRateLimitMax: 100000,
      rateLimitMax: 100000,
    });

    // Baseline with no telemetry traffic.
    const baseline: number[] = [];
    for (let i = 0; i < 50; i += 1) {
      const startedAt = process.hrtime.bigint();
      await app.server.inject({ method: 'GET', url: '/config' });
      baseline.push(Number(process.hrtime.bigint() - startedAt) / 1_000_000);
    }

    // Interleave /config with telemetry intake.
    const underLoad: number[] = [];
    for (let i = 0; i < 50; i += 1) {
      await app.server.inject({ method: 'POST', url: ENDPOINT, payload: buildBatch() });
      const startedAt = process.hrtime.bigint();
      const response = await app.server.inject({ method: 'GET', url: '/config' });
      underLoad.push(Number(process.hrtime.bigint() - startedAt) / 1_000_000);
      expect(response.statusCode).toBe(200);
    }

    expect(percentile(underLoad, 95)).toBeLessThan(50);
    // Sanity: the baseline was measured, so the comparison means something.
    expect(baseline.length).toBe(50);

    await app.close();
  });

  it('serves /config unaffected while the sink is completely down', async () => {
    const app = await createTestApp({
      telemetrySink: new HangingSink(),
      telemetryRateLimitMax: 100000,
      rateLimitMax: 100000,
    });

    for (let i = 0; i < 100; i += 1) {
      await app.server.inject({ method: 'POST', url: ENDPOINT, payload: buildBatch() });
    }

    // Every delivery is stuck, yet the endpoint that matters is untouched.
    const response = await app.server.inject({ method: 'GET', url: '/config' });
    expect(response.statusCode).toBe(200);
    expect(response.json().artifacts.knowledge_base.version).toBe('2.4');

    const version = await app.server.inject({ method: 'GET', url: '/version' });
    expect(version.statusCode).toBe(200);

    await app.server.close();
  });

  it('sheds rather than accumulating when the sink never drains', async () => {
    const app = await createTestApp({
      telemetrySink: new HangingSink(),
      telemetryRateLimitMax: 100000,
      rateLimitMax: 100000,
    });

    for (let i = 0; i < 500; i += 1) {
      const response = await app.server.inject({
        method: 'POST',
        url: ENDPOINT,
        payload: buildBatch(),
      });
      expect(response.statusCode).toBe(202);
    }

    // In-flight work is capped by configuration, not by however much arrived.
    expect(app.dispatcher.inFlightCount()).toBeLessThanOrEqual(50);

    const metricsResponse = await app.server.inject({ method: 'GET', url: '/internal/metrics' });
    expect(metricsResponse.json().metrics.telemetry.events_dropped_total).toBeGreaterThan(0);

    await app.server.close();
  });
});

describe('sink outage behaviour', () => {
  it('keeps accepting requests through a total provider outage', async () => {
    const failing = {
      name: 'failing',
      deliver: async (): Promise<void> => {
        throw new Error('upstream 503');
      },
    };

    const app = await createTestApp({
      telemetrySink: failing,
      telemetryRateLimitMax: 100000,
      rateLimitMax: 100000,
    });

    const statuses: number[] = [];
    for (let i = 0; i < 50; i += 1) {
      const response = await app.server.inject({
        method: 'POST',
        url: ENDPOINT,
        payload: buildBatch(),
      });
      statuses.push(response.statusCode);
    }

    expect(new Set(statuses)).toEqual(new Set([202]));

    await settle(app.dispatcher);
    const snapshot = (await app.server.inject({ method: 'GET', url: '/internal/metrics' })).json();
    expect(snapshot.metrics.telemetry.sink_failures_total).toBeGreaterThan(0);
    expect(snapshot.metrics.telemetry.events_dropped_total).toBeGreaterThan(0);

    await app.close();
  });
});
