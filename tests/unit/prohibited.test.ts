import {
  buildLogRedactionPaths,
  classifyKey,
  hasProhibitedValueShape,
  scanForProhibited,
} from '../../src/telemetry/prohibited';

describe('prohibited key detection', () => {
  const cases: [string, string][] = [
    ['symptoms', 'prohibited_field'],
    ['symptom_list', 'prohibited_field'],
    ['presenting_complaint', 'prohibited_field'],
    ['answers', 'prohibited_field'],
    ['answer_text', 'prohibited_field'],
    ['assessment_history', 'prohibited_field'],
    ['free_text', 'prohibited_field'],
    ['freeText', 'prohibited_field'],
    ['narrative', 'prohibited_field'],
    ['clinical_notes', 'prohibited_field'],
    ['diagnosis', 'prohibited_field'],
    ['possible_diagnoses', 'prohibited_field'],
    ['condition_id', 'prohibited_field'],
    ['differential', 'prohibited_field'],
    ['score', 'prohibited_field'],
    ['score_contribution', 'prohibited_field'],
    ['red_flag', 'prohibited_field'],
    ['redFlagMatched', 'prohibited_field'],
    ['rule_id', 'prohibited_field'],
    ['urgency_category', 'prohibited_field'],
    ['triage_level', 'prohibited_field'],
    ['severity', 'prohibited_field'],
    ['pregnancy_status', 'prohibited_field'],
    ['is_pregnant', 'prohibited_field'],
    ['trimester', 'prohibited_field'],
    ['patient_name', 'prohibited_field'],
    ['name', 'prohibited_field'],
    ['full_name', 'prohibited_field'],
    ['email', 'prohibited_field'],
    ['email_address', 'prohibited_field'],
    ['phone_number', 'prohibited_field'],
    ['msisdn', 'prohibited_field'],
    ['user_id', 'prohibited_field'],
    ['account_id', 'prohibited_field'],
    ['dob', 'prohibited_field'],
    ['date_of_birth', 'prohibited_field'],
    ['latitude', 'prohibited_field'],
    ['longitude', 'prohibited_field'],
    ['lat', 'prohibited_field'],
    ['lng', 'prohibited_field'],
    ['gps', 'prohibited_field'],
    ['coordinates', 'prohibited_field'],
    ['street_address', 'prohibited_field'],
    ['postcode', 'prohibited_field'],
    ['geohash', 'prohibited_field'],
    ['device_id', 'prohibited_field'],
    ['install_id', 'prohibited_field'],
    ['advertising_id', 'prohibited_field'],
    ['device_fingerprint', 'prohibited_field'],
    ['authorization', 'prohibited_field'],
    ['access_token', 'prohibited_field'],
    ['cookie', 'prohibited_field'],
    ['password', 'prohibited_field'],
    ['api_key', 'prohibited_field'],
    ['secret', 'prohibited_field'],
    ['jwt', 'prohibited_field'],
    // Generic containers
    ['properties', 'prohibited_container'],
    ['metadata', 'prohibited_container'],
    ['context', 'prohibited_container'],
    ['extra', 'prohibited_container'],
    ['data', 'prohibited_container'],
    ['payload', 'prohibited_container'],
    ['custom', 'prohibited_container'],
    ['tags', 'prohibited_container'],
    // Prototype pollution
    ['__proto__', 'unsafe_key'],
    ['constructor', 'unsafe_key'],
    ['prototype', 'unsafe_key'],
  ];

  it.each(cases)('flags %p as %s', (key, kind) => {
    expect(classifyKey(key)?.kind).toBe(kind);
  });

  it('matches regardless of case or separator style', () => {
    for (const key of ['Symptom', 'SYMPTOMS', 'symptom-list', 'symptom.list', 'symptomList']) {
      expect(classifyKey(key)).not.toBeNull();
    }
  });

  it('leaves genuinely safe keys alone', () => {
    for (const key of ['step_index', 'launch_type', 'result_count', 'facility_id', 'rating']) {
      expect(classifyKey(key)).toBeNull();
    }
  });

  it('reports the matched rule, never the offending key', () => {
    const hit = classifyKey('patient_symptom_free_text_blob');
    expect(hit).not.toBeNull();
    expect(hit?.rule).not.toContain('blob');
  });
});

describe('prohibited value shapes', () => {
  it.each([
    '6.524379,3.379206',
    '6.524379:3.379206',
    '-1.286389 / 36.817223',
    'ada.obi@example.com',
    'contact me at ada@wellapath.org please',
  ])('flags %p', value => {
    expect(hasProhibitedValueShape(value)).toBe(true);
  });

  it.each(['fac_lagos_00123', 'NG-LA', '1.4.2', '204', 'art_malaria_overview', '6.5'])(
    'permits %p',
    value => {
      expect(hasProhibitedValueShape(value)).toBe(false);
    },
  );
});

describe('deep scan', () => {
  it('finds a prohibited key at the top level', () => {
    expect(scanForProhibited({ symptoms: ['fever'] }).hit?.kind).toBe('prohibited_field');
  });

  it('finds a prohibited key nested several levels down', () => {
    const payload = { a: { b: { c: { d: { patient_name: 'Ada' } } } } };
    expect(scanForProhibited(payload).hit?.kind).toBe('prohibited_field');
  });

  it('finds a prohibited key inside an array element', () => {
    expect(scanForProhibited({ items: [{ ok: 1 }, { red_flag: 'rf_006' }] }).hit).not.toBeNull();
  });

  it('finds a prohibited value shape even under a harmless key', () => {
    expect(scanForProhibited({ label: '6.524379,3.379206' }).hit).not.toBeNull();
  });

  it('passes a clean payload', () => {
    const payload = { event_name: 'app_open', step_index: 2, launch_type: 'cold' };
    expect(scanForProhibited(payload)).toEqual({ hit: null, exhausted: false });
  });

  it('bounds itself on a deeply nested payload rather than recursing forever', () => {
    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 200; i += 1) deep = { nested: deep };
    expect(scanForProhibited(deep).exhausted).toBe(true);
  });

  it('bounds itself on a very wide payload', () => {
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 5000; i += 1) wide[`k${i}`] = i;
    expect(scanForProhibited(wide).exhausted).toBe(true);
  });
});

describe('log redaction paths', () => {
  const paths = buildLogRedactionPaths();

  it.each(['req.headers.authorization', 'req.headers.cookie', 'req.body', 'body', 'payload'])(
    'redacts %s',
    path => {
      expect(paths).toContain(path);
    },
  );

  it('is shared by the request logger and the standalone logger', () => {
    // Both call the same builder, so this asserts the builder is deterministic and non-empty.
    expect(buildLogRedactionPaths()).toEqual(paths);
    expect(paths.length).toBeGreaterThan(5);
  });
});
