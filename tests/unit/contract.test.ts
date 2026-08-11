import {
  APP_CONTEXT_SPEC,
  COMMON_EVENT_SPEC,
  ENVELOPE_SPEC,
  EVENT_NAMES,
  EVENT_SPECS,
  LIMITS,
  NG_ADMIN_AREA_CODES,
  TELEMETRY_CONTRACT_VERSION,
  isAllowlistedEvent,
  propertiesForEvent,
} from '../../src/telemetry/contract';
import { classifyKey } from '../../src/telemetry/prohibited';
import { VALID_EVENTS, MINIMAL_EVENTS } from '../helpers/fixtures';

/** The 12 events the I1/W1 brief authorises, and nothing else. */
const BRIEF_EVENT_NAMES = [
  'app_open',
  'assessment_start',
  'assessment_step_view',
  'assessment_complete',
  'result_view',
  'facility_search',
  'facility_view',
  'facility_call',
  'directions_open',
  'emergency_action',
  'library_article_view',
  'feedback_submit',
];

describe('telemetry contract', () => {
  it('declares contract version 1.0', () => {
    expect(TELEMETRY_CONTRACT_VERSION).toBe('1.0');
  });

  it('allowlists exactly the twelve approved events', () => {
    expect([...EVENT_NAMES].sort()).toEqual([...BRIEF_EVENT_NAMES].sort());
  });

  it('recognises allowlisted events and nothing else', () => {
    for (const name of BRIEF_EVENT_NAMES) expect(isAllowlistedEvent(name)).toBe(true);
    for (const name of ['symptom_entered', 'score_computed', 'toString', 'constructor', '']) {
      expect(isAllowlistedEvent(name)).toBe(false);
    }
  });

  it('gives every event the three common fields', () => {
    for (const name of EVENT_NAMES) {
      const properties = propertiesForEvent(name);
      expect(properties.event_name).toBeDefined();
      expect(properties.event_id).toBeDefined();
      expect(properties.client_ts).toBeDefined();
    }
  });

  it('bounds every declared property with an explicit limit', () => {
    const specs = [
      ...Object.values(ENVELOPE_SPEC),
      ...Object.values(APP_CONTEXT_SPEC),
      ...Object.values(COMMON_EVENT_SPEC),
      ...EVENT_NAMES.flatMap(name => Object.values(EVENT_SPECS[name].properties)),
    ];

    for (const spec of specs) {
      expect(spec.description.length).toBeGreaterThan(0);
      expect(spec.privacy).toBeTruthy();
      if (spec.kind === 'string') {
        expect(spec.maxLength).toBeGreaterThan(0);
        expect(spec.maxLength).toBeLessThanOrEqual(64);
        expect(spec.pattern.length).toBeGreaterThan(0);
      }
      if (spec.kind === 'integer') expect(spec.max).toBeGreaterThan(spec.min - 1);
      if (spec.kind === 'enum') expect(spec.values.length).toBeGreaterThan(0);
    }
  });

  it('accepts no property that is an object or array container', () => {
    const kinds = EVENT_NAMES.flatMap(name =>
      Object.values(EVENT_SPECS[name].properties).map(spec => spec.kind),
    );
    expect(kinds.every(kind => ['string', 'integer', 'boolean', 'enum'].includes(kind))).toBe(true);
  });

  /**
   * The two defenses must not contradict each other: if an allowlisted field name tripped the
   * prohibited-key list, a valid event would be rejected at runtime.
   */
  it('has no allowlisted field name that trips the prohibited-key defense', () => {
    const allNames = new Set<string>([
      'contract_version',
      'sent_at',
      'app',
      'events',
      ...Object.keys(APP_CONTEXT_SPEC),
      ...Object.keys(COMMON_EVENT_SPEC),
      ...EVENT_NAMES.flatMap(name => Object.keys(EVENT_SPECS[name].properties)),
    ]);

    for (const name of allNames) {
      expect({ name, hit: classifyKey(name) }).toEqual({ name, hit: null });
    }
  });

  it('excludes clinical output fields from every event', () => {
    const forbidden = [
      'urgency_category',
      'urgency',
      'condition',
      'condition_id',
      'score',
      'red_flag',
      'red_flag_id',
      'rule_id',
      'question_id',
      'answer',
      'symptom',
      'free_text',
      'feedback_text',
      'latitude',
      'longitude',
    ];

    for (const name of EVENT_NAMES) {
      const properties = Object.keys(propertiesForEvent(name));
      for (const field of forbidden) {
        expect(properties).not.toContain(field);
      }
    }
  });

  it('permits no geography finer than an ISO 3166-2:NG state code', () => {
    expect(NG_ADMIN_AREA_CODES).toHaveLength(37);
    expect(NG_ADMIN_AREA_CODES.every(code => /^NG-[A-Z]{2}$/.test(code))).toBe(true);
    expect(new Set(NG_ADMIN_AREA_CODES).size).toBe(37);
  });

  it('bounds the batch and body size', () => {
    expect(LIMITS.maxEventsPerBatch).toBe(20);
    expect(LIMITS.maxBodyBytes).toBe(32768);
    expect(LIMITS.minEventsPerBatch).toBe(1);
  });

  it('has a fixture for every allowlisted event', () => {
    expect(Object.keys(VALID_EVENTS).sort()).toEqual([...EVENT_NAMES].sort());
    expect(Object.keys(MINIMAL_EVENTS).sort()).toEqual([...EVENT_NAMES].sort());
  });
});
