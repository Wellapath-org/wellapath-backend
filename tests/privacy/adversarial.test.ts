/**
 * Adversarial privacy suite.
 *
 * Each case submits something that must never be accepted, and then asserts three things:
 *   1. the request or event was rejected;
 *   2. nothing about it reached the sink (so it cannot be persisted or exported);
 *   3. no fragment of it reached the logs.
 *
 * The prohibited strings are deliberately distinctive so a substring search over the captured
 * log output is a meaningful assertion.
 */
import { metrics } from '../../src/telemetry/metrics';
import { RecordingSink, TestApp, createTestApp, settle } from '../helpers/app';
import { VALID_EVENTS, eventId, nowIso, validEnvelope } from '../helpers/fixtures';

const ENDPOINT = '/v1/telemetry/events';

/** Distinctive markers — if any of these appears in a log or a sink, something leaked. */
const MARKERS = {
  symptom: 'ZZSYMPTOMMARKER_severe_headache_and_vomiting',
  narrative: 'ZZNARRATIVEMARKER_patient_reports_three_days_of_fever',
  condition: 'ZZCONDITIONMARKER_cerebral_malaria',
  name: 'ZZNAMEMARKER_Ada_Obi',
  phone: 'ZZPHONEMARKER_08031234567',
  email: 'zznamemarker@example.com',
  token: 'ZZTOKENMARKER_eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
  coords: '6.5243793,3.3792057',
  address: 'ZZADDRESSMARKER_15_Broad_Street_Lagos_Island',
};

const allMarkers = Object.values(MARKERS);

interface Probe {
  name: string;
  body: unknown;
  /** True when the whole envelope is refused rather than the single event. */
  envelopeLevel?: boolean;
}

const probes: Probe[] = [
  {
    name: 'symptom field on a valid event',
    body: validEnvelope([{ ...VALID_EVENTS.assessment_start(), symptoms: MARKERS.symptom }]),
  },
  {
    name: 'answer payload',
    body: validEnvelope([
      { ...VALID_EVENTS.assessment_step_view(), answer: MARKERS.symptom, question_id: 'q_017' },
    ]),
  },
  {
    name: 'complete answer history array',
    body: validEnvelope([
      {
        ...VALID_EVENTS.assessment_complete(),
        assessment_history: [{ q: 'q_1', a: MARKERS.symptom }],
      },
    ]),
  },
  {
    name: 'clinical free text',
    body: validEnvelope([{ ...VALID_EVENTS.feedback_submit(), free_text: MARKERS.narrative }]),
  },
  {
    name: 'free text in a comment field',
    body: validEnvelope([{ ...VALID_EVENTS.feedback_submit(), comment: MARKERS.narrative }]),
  },
  {
    name: 'condition prediction',
    body: validEnvelope([{ ...VALID_EVENTS.result_view(), condition: MARKERS.condition }]),
  },
  {
    name: 'differential list',
    body: validEnvelope([
      { ...VALID_EVENTS.result_view(), differential: [MARKERS.condition, 'typhoid'] },
    ]),
  },
  {
    name: 'score and scoring contribution',
    body: validEnvelope([{ ...VALID_EVENTS.result_view(), score: 87, score_contribution: 12 }]),
  },
  {
    name: 'red flag match',
    body: validEnvelope([
      { ...VALID_EVENTS.emergency_action(), red_flag: 'rf_006', rule_id: 'rf_006' },
    ]),
  },
  {
    name: 'urgency category',
    body: validEnvelope([{ ...VALID_EVENTS.assessment_complete(), urgency_category: 'EMERGENCY' }]),
  },
  {
    name: 'pregnancy status',
    body: validEnvelope([{ ...VALID_EVENTS.assessment_start(), pregnancy_status: 'second' }]),
  },
  {
    name: 'personal name',
    body: validEnvelope([{ ...VALID_EVENTS.feedback_submit(), name: MARKERS.name }]),
  },
  {
    name: 'email address',
    body: validEnvelope([{ ...VALID_EVENTS.feedback_submit(), email: MARKERS.email }]),
  },
  {
    name: 'phone number',
    body: validEnvelope([{ ...VALID_EVENTS.facility_call(), phone_number: MARKERS.phone }]),
  },
  {
    name: 'account identifier',
    body: validEnvelope([{ ...VALID_EVENTS.app_open(), account_id: 'acct_9911' }]),
  },
  {
    name: 'exact coordinates as separate fields',
    body: validEnvelope([
      { ...VALID_EVENTS.facility_search(), latitude: 6.5243793, longitude: 3.3792057 },
    ]),
  },
  {
    name: 'coordinates smuggled into an allowlisted ID field',
    body: validEnvelope([{ ...VALID_EVENTS.facility_view(), facility_id: MARKERS.coords }]),
  },
  {
    name: 'full street address',
    body: validEnvelope([{ ...VALID_EVENTS.facility_search(), address: MARKERS.address }]),
  },
  {
    name: 'credential in the payload',
    body: validEnvelope([{ ...VALID_EVENTS.app_open(), access_token: MARKERS.token }]),
  },
  {
    name: 'generic metadata container',
    body: validEnvelope([{ ...VALID_EVENTS.app_open(), metadata: { symptom: MARKERS.symptom } }]),
  },
  {
    name: 'generic properties container',
    body: validEnvelope([{ ...VALID_EVENTS.app_open(), properties: { note: MARKERS.narrative } }]),
  },
  {
    name: 'generic context container',
    body: validEnvelope([{ ...VALID_EVENTS.app_open(), context: { name: MARKERS.name } }]),
  },
  {
    name: 'prohibited data nested three levels down a harmless-looking key',
    body: validEnvelope([
      { ...VALID_EVENTS.app_open(), launch_type: 'cold', extras: { a: { b: MARKERS.symptom } } },
    ]),
  },
  {
    name: 'prototype pollution via __proto__',
    body: JSON.parse(
      `{"contract_version":"1.0","sent_at":"${nowIso()}","app":{"platform":"ios","app_version":"1.0.0","app_build":"1"},"events":[{"event_name":"app_open","event_id":"${eventId()}","client_ts":"${nowIso()}","launch_type":"cold","__proto__":{"polluted":true}}]}`,
    ),
  },
  {
    name: 'prototype pollution via constructor',
    body: validEnvelope([{ ...VALID_EVENTS.app_open(), constructor: { polluted: true } }]),
  },
  {
    name: 'unknown event carrying symptom text',
    body: validEnvelope([
      {
        event_name: 'symptom_entered',
        event_id: eventId(),
        client_ts: nowIso(),
        value: MARKERS.symptom,
      },
    ]),
  },
  {
    name: 'prohibited field at envelope level',
    body: { ...validEnvelope([VALID_EVENTS.app_open()]), patient_name: MARKERS.name },
    envelopeLevel: true,
  },
  {
    name: 'prohibited field inside the app context',
    body: {
      ...validEnvelope([VALID_EVENTS.app_open()]),
      app: {
        platform: 'ios',
        app_version: '1.0.0',
        app_build: '1',
        device_id: 'ZZDEVICEMARKER_abcdef',
      },
    },
    envelopeLevel: true,
  },
];

describe('privacy — prohibited payloads are rejected and never persisted or logged', () => {
  let app: TestApp;
  let sink: RecordingSink;

  beforeEach(async () => {
    sink = new RecordingSink();
    app = await createTestApp({ telemetrySink: sink });
  });

  afterEach(async () => app.close());

  it.each(probes.map(probe => [probe.name, probe] as const))('rejects %s', async (_name, probe) => {
    const response = await app.server.inject({
      method: 'POST',
      url: ENDPOINT,
      payload: probe.body as Record<string, unknown>,
    });

    if (probe.envelopeLevel) {
      expect(response.statusCode).toBe(400);
    } else {
      expect(response.statusCode).toBe(202);
      expect(response.json().accepted).toBe(0);
      expect(response.json().rejected).toBe(1);
    }

    await settle(app.dispatcher);

    // Nothing reached the sink, so nothing could be persisted or exported.
    expect(sink.batches).toHaveLength(0);

    // Nothing leaked into the response.
    for (const marker of allMarkers) {
      expect(response.body).not.toContain(marker);
    }

    // Nothing leaked into the logs.
    const logs = app.logs.text();
    for (const marker of allMarkers) {
      expect(logs).not.toContain(marker);
    }
  });

  it('leaves Object.prototype unpolluted', async () => {
    for (const probe of probes) {
      await app.server.inject({
        method: 'POST',
        url: ENDPOINT,
        payload: probe.body as Record<string, unknown>,
      });
    }

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('counts prohibited attempts under a safe reason label', async () => {
    await app.server.inject({
      method: 'POST',
      url: ENDPOINT,
      payload: validEnvelope([{ ...VALID_EVENTS.app_open(), symptoms: MARKERS.symptom }]),
    });

    const snapshot = metrics.snapshot().telemetry as Record<string, Record<string, number>>;
    expect(snapshot.events_rejected_total.prohibited_field).toBe(1);
    expect(JSON.stringify(snapshot)).not.toContain(MARKERS.symptom);
  });
});

describe('privacy — oversized and malformed payloads leave no trace', () => {
  let app: TestApp;
  let sink: RecordingSink;

  beforeEach(async () => {
    sink = new RecordingSink();
    app = await createTestApp({ telemetrySink: sink });
  });

  afterEach(async () => app.close());

  it('does not log the body of an oversized payload', async () => {
    const response = await app.server.inject({
      method: 'POST',
      url: ENDPOINT,
      headers: { 'content-type': 'application/json' },
      payload: `{"note":"${MARKERS.narrative}${'x'.repeat(40000)}"}`,
    });

    expect(response.statusCode).toBe(413);
    expect(app.logs.text()).not.toContain(MARKERS.narrative);
    expect(response.body).not.toContain(MARKERS.narrative);
  });

  it('does not log the body of a malformed payload', async () => {
    const response = await app.server.inject({
      method: 'POST',
      url: ENDPOINT,
      headers: { 'content-type': 'application/json' },
      payload: `{"symptom":"${MARKERS.symptom}",,,`,
    });

    expect(response.statusCode).toBe(400);
    expect(app.logs.text()).not.toContain(MARKERS.symptom);
  });

  it('does not log the body of a rejected but well-formed payload', async () => {
    await app.server.inject({
      method: 'POST',
      url: ENDPOINT,
      payload: validEnvelope([
        { ...VALID_EVENTS.result_view(), condition: MARKERS.condition, score: 91 },
      ]),
    });

    const logs = app.logs.text();
    expect(logs).not.toContain(MARKERS.condition);
    expect(logs).not.toContain('"score"');
  });

  it('never logs a raw request body for an accepted payload either', async () => {
    await app.server.inject({
      method: 'POST',
      url: ENDPOINT,
      payload: validEnvelope([VALID_EVENTS.app_open()]),
    });
    await settle(app.dispatcher);

    const logs = app.logs.text();
    // Fastify logs request metadata, never the parsed or raw body.
    expect(logs).not.toContain('"body"');
    expect(logs).not.toContain('"req":{"body"');
  });
});

describe('privacy — headers and URLs', () => {
  let app: TestApp;

  beforeEach(async () => {
    app = await createTestApp({ telemetrySink: new RecordingSink() });
  });

  afterEach(async () => app.close());

  it('redacts authorization and cookie headers', async () => {
    await app.server.inject({
      method: 'POST',
      url: ENDPOINT,
      headers: {
        authorization: `Bearer ${MARKERS.token}`,
        cookie: `session=${MARKERS.token}`,
      },
      payload: validEnvelope([VALID_EVENTS.app_open()]),
    });

    const logs = app.logs.text();
    expect(logs).not.toContain(MARKERS.token);
  });

  it('strips the query string from logged paths', async () => {
    await app.server.inject({
      method: 'GET',
      url: `/does-not-exist?symptom=${encodeURIComponent(MARKERS.symptom)}`,
    });

    const logs = app.logs.text();
    expect(logs).not.toContain(MARKERS.symptom);
    expect(logs).toContain('/does-not-exist');
  });

  it('keeps a query string out of the 404 response too', async () => {
    const response = await app.server.inject({
      method: 'GET',
      url: `/nope?condition=${MARKERS.condition}`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain(MARKERS.condition);
  });
});

describe('privacy — the sink only ever receives allowlisted fields', () => {
  it('strips nothing because nothing extraneous survives validation', async () => {
    const sink = new RecordingSink();
    const app = await createTestApp({ telemetrySink: sink });

    await app.server.inject({
      method: 'POST',
      url: ENDPOINT,
      payload: validEnvelope([
        VALID_EVENTS.assessment_complete(),
        VALID_EVENTS.facility_search(),
        VALID_EVENTS.emergency_action(),
      ]),
    });
    await settle(app.dispatcher);

    const permitted = new Set([
      'event_name',
      'event_id',
      'client_ts',
      'assessment_session_id',
      'completion_status',
      'duration_ms',
      'step_count',
      'search_mode',
      'admin_area_code',
      'result_count',
      'action_type',
    ]);

    for (const event of sink.events()) {
      for (const key of Object.keys(event)) {
        expect(permitted.has(key)).toBe(true);
      }
    }

    await app.close();
  });
});
