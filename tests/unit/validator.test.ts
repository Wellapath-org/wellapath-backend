import { EVENT_NAMES, LIMITS } from '../../src/telemetry/contract';
import { REJECTION_REASONS } from '../../src/telemetry/reason-codes';
import { validateEnvelope, validateEvent } from '../../src/telemetry/validator';
import { MINIMAL_EVENTS, VALID_EVENTS, eventId, nowIso, validEnvelope } from '../helpers/fixtures';

const now = (): number => Date.now();

/** Validates one event inside a full envelope and returns its outcome. */
const outcomeFor = (event: unknown): { status: string; reason?: string; field?: string } => {
  const result = validateEnvelope(validEnvelope([event as Record<string, unknown>]), now());
  if (!result.ok) throw new Error(`envelope rejected: ${result.reason}`);
  return result.outcomes[0];
};

describe('validator — accepts every allowlisted event', () => {
  it.each(EVENT_NAMES)('accepts a fully populated %s', name => {
    const result = validateEvent(VALID_EVENTS[name](), now());
    expect(result).toEqual({ ok: true, event: expect.objectContaining({ event_name: name }) });
  });

  it.each(EVENT_NAMES)('accepts a minimal %s', name => {
    const result = validateEvent(MINIMAL_EVENTS[name](), now());
    expect(result.ok).toBe(true);
  });

  it('returns only allowlisted keys on the accepted event', () => {
    const result = validateEvent(VALID_EVENTS.facility_search(), now());
    if (!result.ok) throw new Error('expected acceptance');
    expect(Object.keys(result.event).sort()).toEqual(
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
});

describe('validator — unknown events fail closed', () => {
  const unknownNames = [
    'symptom_entered',
    'assessment_answer',
    'score_computed',
    'red_flag_triggered',
    'app_open ',
    'App_Open',
    'toString',
    'constructor',
    '__proto__',
    '',
  ];

  it.each(unknownNames)('rejects event_name %p', name => {
    const result = validateEvent(
      { event_name: name, event_id: eventId(), client_ts: nowIso() },
      now(),
    );
    expect(result).toMatchObject({ ok: false });
  });

  it('rejects a missing event_name', () => {
    const result = validateEvent({ event_id: eventId(), client_ts: nowIso() }, now());
    expect(result).toEqual({ ok: false, reason: REJECTION_REASONS.UNKNOWN_EVENT });
  });

  it('rejects a non-string event_name', () => {
    const result = validateEvent({ event_name: 42, event_id: eventId() }, now());
    expect(result).toEqual({ ok: false, reason: REJECTION_REASONS.UNKNOWN_EVENT });
  });
});

describe('validator — unknown and prohibited properties fail closed', () => {
  it('rejects an undeclared property on a valid event', () => {
    const event = { ...VALID_EVENTS.app_open(), some_new_field: 'value' };
    expect(validateEvent(event, now())).toEqual({
      ok: false,
      reason: REJECTION_REASONS.UNKNOWN_PROPERTY,
    });
  });

  it('does not echo the unknown key back', () => {
    const event = { ...VALID_EVENTS.app_open(), patient_secret_key: 'value' };
    const result = validateEvent(event, now());
    expect(JSON.stringify(result)).not.toContain('patient_secret_key');
  });

  it('rejects a property valid on a different event', () => {
    const event = { ...VALID_EVENTS.app_open(), facility_id: 'fac_1' };
    expect(validateEvent(event, now())).toMatchObject({ ok: false });
  });

  it('rejects an assessment session ID on an emergency event', () => {
    const event = {
      ...VALID_EVENTS.emergency_action(),
      assessment_session_id: 'sess_abcdefghij123',
    };
    expect(validateEvent(event, now())).toEqual({
      ok: false,
      reason: REJECTION_REASONS.UNKNOWN_PROPERTY,
    });
  });

  it('rejects a missing required property and names the allowlisted field', () => {
    const event = VALID_EVENTS.facility_view();
    delete event.facility_id;
    expect(validateEvent(event, now())).toEqual({
      ok: false,
      reason: REJECTION_REASONS.MISSING_REQUIRED_PROPERTY,
      field: 'facility_id',
    });
  });
});

describe('validator — boundary lengths, enums and types', () => {
  it('accepts a facility_id at exactly the maximum length', () => {
    const event = { ...VALID_EVENTS.facility_view(), facility_id: 'f'.repeat(64) };
    expect(validateEvent(event, now()).ok).toBe(true);
  });

  it('rejects a facility_id one character over the maximum', () => {
    const event = { ...VALID_EVENTS.facility_view(), facility_id: 'f'.repeat(65) };
    expect(validateEvent(event, now())).toEqual({
      ok: false,
      reason: REJECTION_REASONS.VALUE_TOO_LONG,
      field: 'facility_id',
    });
  });

  it('rejects an out-of-enum value', () => {
    const event = { ...VALID_EVENTS.emergency_action(), action_type: 'call_ambulance' };
    expect(validateEvent(event, now())).toEqual({
      ok: false,
      reason: REJECTION_REASONS.INVALID_ENUM_VALUE,
      field: 'action_type',
    });
  });

  it('rejects an unlisted administrative area code', () => {
    const event = { ...VALID_EVENTS.facility_search(), admin_area_code: 'NG-ZZ' };
    expect(validateEvent(event, now())).toMatchObject({
      ok: false,
      reason: REJECTION_REASONS.INVALID_ENUM_VALUE,
    });
  });

  it.each([
    [0, false],
    [1, true],
    [5, true],
    [6, false],
    [-1, false],
  ])('bounds feedback rating %p → accepted=%p', (rating, accepted) => {
    const event = { ...VALID_EVENTS.feedback_submit(), rating };
    expect(validateEvent(event, now()).ok).toBe(accepted);
  });

  it('rejects a non-integer numeric value', () => {
    const event = { ...VALID_EVENTS.assessment_step_view(), step_index: 3.5 };
    expect(validateEvent(event, now())).toEqual({
      ok: false,
      reason: REJECTION_REASONS.INVALID_TYPE,
      field: 'step_index',
    });
  });

  it('rejects a string where an integer is declared', () => {
    const event = { ...VALID_EVENTS.assessment_step_view(), step_index: '3' };
    expect(validateEvent(event, now())).toMatchObject({
      ok: false,
      reason: REJECTION_REASONS.INVALID_TYPE,
    });
  });

  it('rejects a non-boolean where a boolean is declared', () => {
    const event = { ...VALID_EVENTS.app_open(), is_first_launch: 'true' };
    expect(validateEvent(event, now())).toMatchObject({
      ok: false,
      reason: REJECTION_REASONS.INVALID_TYPE,
    });
  });

  it('rejects a nested object or array as a property value', () => {
    for (const value of [{ nested: 1 }, [1, 2, 3], []]) {
      const event = { ...VALID_EVENTS.app_open(), is_first_launch: value };
      expect(validateEvent(event, now())).toMatchObject({
        ok: false,
        reason: REJECTION_REASONS.NESTED_VALUE_NOT_ALLOWED,
      });
    }
  });

  it('rejects a full OS build string, accepting only major[.minor]', () => {
    const envelope = validEnvelope([VALID_EVENTS.app_open()]);
    (envelope.app as Record<string, unknown>).os_version = '17.4.1 (21E236)';
    expect(validateEnvelope(envelope, now())).toEqual({
      ok: false,
      reason: REJECTION_REASONS.INVALID_ENVELOPE,
    });
  });
});

describe('validator — identifiers and timestamps', () => {
  it.each(['short', 'has spaces here 12345', 'has/slashes/and+plus/xyz', '', 'x'.repeat(65)])(
    'rejects malformed event_id %p',
    id => {
      const event = { ...VALID_EVENTS.app_open(), event_id: id };
      expect(validateEvent(event, now())).toMatchObject({ ok: false });
    },
  );

  it.each([
    'not-a-date',
    '2026-08-11',
    '2026-08-11T09:01:14+01:00',
    '2026-13-45T99:99:99Z',
    '11/08/2026',
  ])('rejects malformed client_ts %p', ts => {
    const event = { ...VALID_EVENTS.app_open(), client_ts: ts };
    expect(validateEvent(event, now())).toMatchObject({ ok: false });
  });

  it('rejects a timestamp far in the future', () => {
    const event = { ...VALID_EVENTS.app_open(), client_ts: nowIso(48 * 3600 * 1000) };
    expect(validateEvent(event, now())).toEqual({
      ok: false,
      reason: REJECTION_REASONS.TIMESTAMP_OUT_OF_RANGE,
      field: 'client_ts',
    });
  });

  it('rejects a timestamp older than the offline-queue window', () => {
    const event = { ...VALID_EVENTS.app_open(), client_ts: nowIso(-31 * 24 * 3600 * 1000) };
    expect(validateEvent(event, now())).toEqual({
      ok: false,
      reason: REJECTION_REASONS.TIMESTAMP_OUT_OF_RANGE,
      field: 'client_ts',
    });
  });

  it('accepts a timestamp inside the offline-queue window', () => {
    const event = { ...VALID_EVENTS.app_open(), client_ts: nowIso(-10 * 24 * 3600 * 1000) };
    expect(validateEvent(event, now()).ok).toBe(true);
  });
});

describe('validator — envelope', () => {
  it('rejects a non-object body', () => {
    for (const body of [null, 'string', 42, [], true]) {
      expect(validateEnvelope(body, now())).toEqual({
        ok: false,
        reason: REJECTION_REASONS.INVALID_ENVELOPE,
      });
    }
  });

  it('rejects an unknown envelope key', () => {
    const envelope = { ...validEnvelope([VALID_EVENTS.app_open()]), user_id: 'u1' };
    expect(validateEnvelope(envelope, now())).toMatchObject({ ok: false });
  });

  it('rejects an unsupported contract version', () => {
    const envelope = { ...validEnvelope([VALID_EVENTS.app_open()]), contract_version: '2.0' };
    expect(validateEnvelope(envelope, now())).toEqual({
      ok: false,
      reason: REJECTION_REASONS.UNSUPPORTED_CONTRACT_VERSION,
    });
  });

  it('rejects an empty batch', () => {
    expect(validateEnvelope(validEnvelope([]), now())).toEqual({
      ok: false,
      reason: REJECTION_REASONS.EMPTY_BATCH,
    });
  });

  it('rejects a batch over the maximum size', () => {
    const events = Array.from({ length: LIMITS.maxEventsPerBatch + 1 }, () =>
      VALID_EVENTS.app_open(),
    );
    expect(validateEnvelope(validEnvelope(events), now())).toEqual({
      ok: false,
      reason: REJECTION_REASONS.BATCH_TOO_LARGE,
    });
  });

  it('accepts a batch at exactly the maximum size', () => {
    const events = Array.from({ length: LIMITS.maxEventsPerBatch }, () => VALID_EVENTS.app_open());
    const result = validateEnvelope(validEnvelope(events), now());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.events).toHaveLength(LIMITS.maxEventsPerBatch);
  });

  it('rejects a missing or malformed app context', () => {
    for (const app of [undefined, null, 'android', { platform: 'windows' }, {}]) {
      const envelope = { ...validEnvelope([VALID_EVENTS.app_open()]), app };
      expect(validateEnvelope(envelope, now())).toEqual({
        ok: false,
        reason: REJECTION_REASONS.INVALID_ENVELOPE,
      });
    }
  });

  it('rejects one bad event without poisoning the rest of the batch', () => {
    const envelope = validEnvelope([
      VALID_EVENTS.app_open(),
      { event_name: 'symptom_entered', event_id: eventId(), client_ts: nowIso() },
      VALID_EVENTS.facility_view(),
    ]);

    const result = validateEnvelope(envelope, now());
    if (!result.ok) throw new Error('expected envelope acceptance');

    expect(result.events).toHaveLength(2);
    expect(result.outcomes.map(o => o.status)).toEqual(['accepted', 'rejected', 'accepted']);
    expect(result.outcomes[1].reason).toBe(REJECTION_REASONS.UNKNOWN_EVENT);
  });
});

describe('validator — safe error serialization', () => {
  it('never carries a rejected value into the rejection it caused', () => {
    const secret = 'PATIENT-NAME-Ada-Obi-08031234567';
    // Over the 64-character limit, so this value is rejected rather than accepted.
    const event = { ...VALID_EVENTS.facility_view(), facility_id: `${secret}-${'x'.repeat(40)}` };
    const outcome = outcomeFor(event);

    expect(outcome).toEqual({
      index: 0,
      status: 'rejected',
      reason: REJECTION_REASONS.VALUE_TOO_LONG,
      field: 'facility_id',
    });

    const serialized = JSON.stringify(outcome);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('Ada');
    expect(serialized).not.toContain('08031234567');
  });

  it('only ever reports fixed reason codes', () => {
    const permitted = new Set(Object.values(REJECTION_REASONS));
    const badEvents = [
      { event_name: 'unknown_thing' },
      { ...VALID_EVENTS.app_open(), extra: 1 },
      { ...VALID_EVENTS.app_open(), launch_type: 'sideways' },
      { ...VALID_EVENTS.app_open(), event_id: '!!' },
    ];

    for (const event of badEvents) {
      const outcome = outcomeFor(event);
      expect(permitted.has(outcome.reason as never)).toBe(true);
    }
  });
});
