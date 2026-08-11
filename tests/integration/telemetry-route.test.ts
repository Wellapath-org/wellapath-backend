import { TELEMETRY_CONTRACT_VERSION } from '../../src/telemetry/contract';
import { metrics } from '../../src/telemetry/metrics';
import { REJECTION_REASONS } from '../../src/telemetry/reason-codes';
import {
  FailingSink,
  HangingSink,
  RecordingSink,
  TestApp,
  createTestApp,
  settle,
} from '../helpers/app';
import { VALID_EVENTS, envelopeFor, eventId, nowIso, validEnvelope } from '../helpers/fixtures';

const ENDPOINT = '/v1/telemetry/events';

describe('POST /v1/telemetry/events — valid intake', () => {
  let app: TestApp;
  let sink: RecordingSink;

  beforeEach(async () => {
    sink = new RecordingSink();
    app = await createTestApp({ telemetrySink: sink });
  });

  afterEach(async () => app.close());

  it('accepts a valid single-event batch', async () => {
    const response = await app.server.inject({
      method: 'POST',
      url: ENDPOINT,
      payload: envelopeFor('app_open'),
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      contract_version: TELEMETRY_CONTRACT_VERSION,
      received: 1,
      accepted: 1,
      rejected: 0,
      duplicates: 0,
      results: [{ index: 0, status: 'accepted' }],
    });
  });

  it('delivers only validated, allowlisted fields to the sink', async () => {
    await app.server.inject({
      method: 'POST',
      url: ENDPOINT,
      payload: envelopeFor('facility_search'),
    });
    await settle(app.dispatcher);

    expect(sink.batches).toHaveLength(1);
    expect(sink.batches[0].app).toEqual({
      platform: 'android',
      app_version: '1.4.2',
      app_build: '204',
      os_version: '14',
    });
    expect(Object.keys(sink.events()[0]).sort()).toEqual(
      [
        'event_name',
        'event_id',
        'client_ts',
        'search_mode',
        'admin_area_code',
        'result_count',
      ].sort(),
    );
  });

  it('accepts a mixed batch of every allowlisted event type', async () => {
    const events = Object.values(VALID_EVENTS)
      .slice(0, 12)
      .map(build => build());

    const response = await app.server.inject({
      method: 'POST',
      url: ENDPOINT,
      payload: validEnvelope(events),
    });

    expect(response.statusCode).toBe(202);
    expect(response.json().accepted).toBe(12);
  });

  it('accepts the valid events in a partially invalid batch', async () => {
    const response = await app.server.inject({
      method: 'POST',
      url: ENDPOINT,
      payload: validEnvelope([
        VALID_EVENTS.app_open(),
        { event_name: 'symptom_entered', event_id: eventId(), client_ts: nowIso() },
        { ...VALID_EVENTS.facility_view(), latitude: 6.5244 },
        VALID_EVENTS.result_view(),
      ]),
    });

    const body = response.json();
    expect(response.statusCode).toBe(202);
    expect(body.accepted).toBe(2);
    expect(body.rejected).toBe(2);
    expect(body.results.map((r: { status: string }) => r.status)).toEqual([
      'accepted',
      'rejected',
      'rejected',
      'accepted',
    ]);
    expect(body.results[1].reason).toBe(REJECTION_REASONS.UNKNOWN_EVENT);
    expect(body.results[2].reason).toBe(REJECTION_REASONS.PROHIBITED_FIELD);
  });

  it('updates the accepted-event metric by event name', async () => {
    await app.server.inject({ method: 'POST', url: ENDPOINT, payload: envelopeFor('app_open') });

    const snapshot = metrics.snapshot().telemetry as Record<string, Record<string, number>>;
    expect(snapshot.events_accepted_total.app_open).toBe(1);
    expect(snapshot.requests_total.accepted).toBe(1);
  });

  it('records telemetry endpoint latency', async () => {
    await app.server.inject({ method: 'POST', url: ENDPOINT, payload: envelopeFor('app_open') });

    const snapshot = metrics.snapshot().telemetry as Record<string, { count: number }>;
    expect(snapshot.request_duration_ms.count).toBe(1);
  });
});

describe('POST /v1/telemetry/events — rejection', () => {
  let app: TestApp;

  beforeEach(async () => {
    app = await createTestApp({ telemetrySink: new RecordingSink() });
  });

  afterEach(async () => app.close());

  it('rejects an unsupported contract version', async () => {
    const response = await app.server.inject({
      method: 'POST',
      url: ENDPOINT,
      payload: { ...envelopeFor('app_open'), contract_version: '9.9' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        statusCode: 400,
        message: 'Unsupported telemetry contract version',
        reason_code: REJECTION_REASONS.UNSUPPORTED_CONTRACT_VERSION,
      },
    });
  });

  it('rejects an unknown envelope key', async () => {
    const response = await app.server.inject({
      method: 'POST',
      url: ENDPOINT,
      payload: { ...envelopeFor('app_open'), user_id: 'user-123' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain('user-123');
  });

  it('rejects an empty batch', async () => {
    const response = await app.server.inject({
      method: 'POST',
      url: ENDPOINT,
      payload: validEnvelope([]),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.reason_code).toBe(REJECTION_REASONS.EMPTY_BATCH);
  });

  it('rejects an oversized batch', async () => {
    const events = Array.from({ length: 21 }, () => VALID_EVENTS.app_open());
    const response = await app.server.inject({
      method: 'POST',
      url: ENDPOINT,
      payload: validEnvelope(events),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.reason_code).toBe(REJECTION_REASONS.BATCH_TOO_LARGE);
  });

  it('rejects malformed JSON without quoting the body', async () => {
    const response = await app.server.inject({
      method: 'POST',
      url: ENDPOINT,
      headers: { 'content-type': 'application/json' },
      payload: '{"contract_version":"1.0","symptom":"severe headache and fever",,,}',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        statusCode: 400,
        message: 'Request body could not be parsed',
        reason_code: REJECTION_REASONS.MALFORMED_JSON,
      },
    });
    expect(response.body).not.toContain('headache');
  });

  it('rejects a body over the size limit', async () => {
    const response = await app.server.inject({
      method: 'POST',
      url: ENDPOINT,
      headers: { 'content-type': 'application/json' },
      payload: `{"padding":"${'x'.repeat(40000)}"}`,
    });

    expect(response.statusCode).toBe(413);
    expect(response.json().error.message).toBe('Request body exceeds the permitted size');
  });

  it('rejects a non-JSON content type', async () => {
    const response = await app.server.inject({
      method: 'POST',
      url: ENDPOINT,
      headers: { 'content-type': 'text/plain' },
      payload: 'symptom=fever',
    });

    expect(response.statusCode).toBe(415);
    expect(response.body).not.toContain('fever');
  });

  it('counts rejections under a safe reason label', async () => {
    await app.server.inject({
      method: 'POST',
      url: ENDPOINT,
      payload: { ...envelopeFor('app_open'), contract_version: '9.9' },
    });

    const snapshot = metrics.snapshot().telemetry as Record<string, Record<string, number>>;
    expect(snapshot.events_rejected_total.unsupported_contract_version).toBe(1);
    expect(snapshot.requests_total.rejected).toBe(1);
  });
});

describe('POST /v1/telemetry/events — de-duplication', () => {
  let app: TestApp;
  let sink: RecordingSink;

  beforeEach(async () => {
    sink = new RecordingSink();
    app = await createTestApp({ telemetrySink: sink });
  });

  afterEach(async () => app.close());

  it('accepts the first copy and de-duplicates the resend', async () => {
    const envelope = envelopeFor('app_open');

    const first = await app.server.inject({ method: 'POST', url: ENDPOINT, payload: envelope });
    const second = await app.server.inject({ method: 'POST', url: ENDPOINT, payload: envelope });
    await settle(app.dispatcher);

    expect(first.json()).toMatchObject({ accepted: 1, duplicates: 0 });
    expect(second.json()).toMatchObject({ accepted: 0, duplicates: 1 });
    expect(second.json().results[0].status).toBe('duplicate');
    expect(sink.events()).toHaveLength(1);
  });

  it('de-duplicates repeats inside a single batch', async () => {
    const event = VALID_EVENTS.app_open();
    const response = await app.server.inject({
      method: 'POST',
      url: ENDPOINT,
      payload: validEnvelope([event, { ...event }]),
    });
    await settle(app.dispatcher);

    expect(response.json()).toMatchObject({ accepted: 1, duplicates: 1 });
    expect(sink.events()).toHaveLength(1);
  });

  it('counts duplicates in the metrics snapshot', async () => {
    const envelope = envelopeFor('app_open');
    await app.server.inject({ method: 'POST', url: ENDPOINT, payload: envelope });
    await app.server.inject({ method: 'POST', url: ENDPOINT, payload: envelope });

    const snapshot = metrics.snapshot().telemetry as Record<string, number>;
    expect(snapshot.events_duplicate_total).toBe(1);
  });
});

describe('POST /v1/telemetry/events — sink behaviour', () => {
  it('returns 202 even when every delivery attempt fails', async () => {
    const sink = new FailingSink();
    const app = await createTestApp({ telemetrySink: sink });

    const response = await app.server.inject({
      method: 'POST',
      url: ENDPOINT,
      payload: envelopeFor('app_open'),
    });

    expect(response.statusCode).toBe(202);
    expect(response.json().accepted).toBe(1);

    await settle(app.dispatcher);
    expect(sink.attempts).toBeGreaterThan(1);

    const snapshot = metrics.snapshot().telemetry as Record<string, number>;
    expect(snapshot.sink_failures_total).toBe(1);
    expect(snapshot.events_dropped_total).toBe(1);

    await app.close();
  });

  it('responds promptly even when the sink never settles', async () => {
    const app = await createTestApp({ telemetrySink: new HangingSink() });

    const startedAt = Date.now();
    const response = await app.server.inject({
      method: 'POST',
      url: ENDPOINT,
      payload: envelopeFor('app_open'),
    });

    expect(response.statusCode).toBe(202);
    expect(Date.now() - startedAt).toBeLessThan(1000);

    await app.server.close();
  });

  it('never surfaces a provider error message to the client', async () => {
    const app = await createTestApp({ telemetrySink: new FailingSink() });

    const response = await app.server.inject({
      method: 'POST',
      url: ENDPOINT,
      payload: envelopeFor('app_open'),
    });

    expect(response.body).not.toContain('provider unavailable');
    expect(response.body).not.toContain('503 upstream');

    await settle(app.dispatcher);
    await app.close();
  });
});

describe('POST /v1/telemetry/events — feature disabled', () => {
  let app: TestApp;
  let sink: RecordingSink;

  beforeEach(async () => {
    sink = new RecordingSink();
    app = await createTestApp({ telemetryEnabled: false, telemetrySink: sink });
  });

  afterEach(async () => app.close());

  it('returns 503 with a stable reason code', async () => {
    const response = await app.server.inject({
      method: 'POST',
      url: ENDPOINT,
      payload: envelopeFor('app_open'),
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: {
        statusCode: 503,
        message: 'Telemetry intake is disabled',
        reason_code: REJECTION_REASONS.TELEMETRY_DISABLED,
      },
    });
  });

  it('delivers nothing to the sink while disabled', async () => {
    await app.server.inject({ method: 'POST', url: ENDPOINT, payload: envelopeFor('app_open') });
    await settle(app.dispatcher);
    expect(sink.batches).toHaveLength(0);
  });

  it('does not even parse the payload while disabled', async () => {
    const response = await app.server.inject({
      method: 'POST',
      url: ENDPOINT,
      payload: { ...envelopeFor('app_open'), anything: 'at all' },
    });

    expect(response.statusCode).toBe(503);
  });
});

describe('POST /v1/telemetry/events — rate limiting', () => {
  it('rate-limits the telemetry endpoint independently', async () => {
    const app = await createTestApp({
      telemetrySink: new RecordingSink(),
      telemetryRateLimitMax: 2,
    });

    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const response = await app.server.inject({
        method: 'POST',
        url: ENDPOINT,
        payload: envelopeFor('app_open'),
      });
      statuses.push(response.statusCode);
    }

    expect(statuses.slice(0, 2)).toEqual([202, 202]);
    expect(statuses.slice(2)).toEqual([429, 429]);

    await app.close();
  });

  it('shapes the 429 like the rest of the service', async () => {
    const app = await createTestApp({
      telemetrySink: new RecordingSink(),
      telemetryRateLimitMax: 1,
    });

    await app.server.inject({ method: 'POST', url: ENDPOINT, payload: envelopeFor('app_open') });
    const limited = await app.server.inject({
      method: 'POST',
      url: ENDPOINT,
      payload: envelopeFor('app_open'),
    });

    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.statusCode).toBe(429);

    await app.close();
  });
});

describe('GET /internal/metrics', () => {
  let app: TestApp;

  beforeEach(async () => {
    app = await createTestApp({ telemetrySink: new RecordingSink() });
  });

  afterEach(async () => app.close());

  it('reports the contract version and enablement state', async () => {
    const response = await app.server.inject({ method: 'GET', url: '/internal/metrics' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      telemetry_contract_version: TELEMETRY_CONTRACT_VERSION,
      telemetry_enabled: true,
      telemetry_sink: 'recording',
    });
  });

  it('reflects intake activity', async () => {
    await app.server.inject({ method: 'POST', url: ENDPOINT, payload: envelopeFor('result_view') });
    const response = await app.server.inject({ method: 'GET', url: '/internal/metrics' });

    expect(response.json().metrics.telemetry.events_accepted_total.result_view).toBe(1);
    expect(response.json().metrics.http.requests_total['/v1/telemetry/events|2xx']).toBe(1);
  });
});

describe('CORS', () => {
  it('permits POST for the mobile client', async () => {
    const app = await createTestApp({ telemetrySink: new RecordingSink() });

    const response = await app.server.inject({
      method: 'OPTIONS',
      url: ENDPOINT,
      headers: {
        origin: 'https://wellapath.org',
        'access-control-request-method': 'POST',
      },
    });

    expect(response.statusCode).toBeLessThan(300);
    expect(response.headers['access-control-allow-methods']).toContain('POST');

    await app.close();
  });
});
