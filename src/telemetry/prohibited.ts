/**
 * Centralized prohibited-key and sensitive-shape defense.
 *
 * This is the SECOND layer, not the primary control. The primary control is the allowlist in
 * `contract.ts`: a property that is not declared there is rejected regardless of its name.
 *
 * This layer exists so that:
 *   1. an attempt to send prohibited data is *distinguishable* from an ordinary schema mistake,
 *      and shows up under its own rejection-reason metric;
 *   2. the same key list drives log redaction, so a prohibited key cannot be introduced on some
 *      future surface and quietly land in logs;
 *   3. values that satisfy an allowlisted pattern but are shaped like prohibited content
 *      (coordinate pairs, email addresses) are still refused.
 *
 * Key matching is deliberately split into exact matches and substring matches. Substring
 * matching is powerful but collides easily — `name` would match the allowlisted `event_name`,
 * `lat` would match `platform`, `ip` would match `description`. Those live in the exact set.
 */

/** Keys that are unsafe as object members regardless of content. */
export const UNSAFE_KEYS: readonly string[] = ['__proto__', 'constructor', 'prototype'];

/**
 * Generic container names. Rejected outright so that no arbitrary bag of values can be
 * smuggled through a legitimate-looking wrapper.
 */
export const PROHIBITED_CONTAINER_KEYS: readonly string[] = [
  'properties',
  'metadata',
  'meta',
  'context',
  'extra',
  'extras',
  'payload',
  'data',
  'attributes',
  'props',
  'custom',
  'fields',
  'params',
  'tags',
];

/**
 * Prohibited keys matched by exact (case- and separator-normalized) equality.
 * Used where a substring rule would collide with an allowlisted field name.
 */
export const PROHIBITED_EXACT_KEYS: readonly string[] = [
  // Identity
  'name',
  'fullname',
  'firstname',
  'lastname',
  'middlename',
  'surname',
  'givenname',
  'displayname',
  'username',
  'user',
  'userid',
  'accountid',
  'account',
  'subject',
  'age',
  'dob',
  'sex',
  'gender',
  // Location
  'lat',
  'lng',
  'lon',
  'long',
  'coords',
  'coord',
  'geo',
  'gps',
  'position',
  'place',
  'ip',
  // Network / device identity
  'ua',
  'imei',
  'imsi',
  'msisdn',
  'idfa',
  'idfv',
  'gaid',
  'adid',
  // Clinical
  'text',
  'note',
  'notes',
  'comment',
  'comments',
  'reason',
  'query',
  'q',
];

/**
 * Prohibited key fragments matched anywhere in the normalized key. Each entry has been checked
 * against the full allowlist in `contract.ts` for collisions.
 */
export const PROHIBITED_KEY_FRAGMENTS: readonly string[] = [
  // Symptoms, answers, clinical narrative
  'symptom',
  'complaint',
  'presenting',
  'answer',
  'response_text',
  'freetext',
  'free_text',
  'narrative',
  'transcript',
  'history',
  'journal',
  // Clinical output
  // `score` and `weight` are fragments, not exact matches, so `score_contribution` and
  // `symptom_weight` are caught too — the brief names scoring contributions explicitly.
  'score',
  'scoring',
  'weight',
  'diagnos',
  'condition',
  'differential',
  'prediction',
  'predicted',
  'likelihood',
  'probability',
  'confidence',
  'redflag',
  'red_flag',
  'flagmatch',
  'rulematch',
  'rule_id',
  'ruleid',
  'triage',
  'urgency',
  'severity',
  'clinical',
  'pregnan',
  'gestation',
  'trimester',
  'hiv',
  'comorbid',
  'medication',
  'allergy',
  'vitals',
  // Free text surfaces
  'description',
  'message',
  'feedback_text',
  'body_text',
  // Identity
  'email',
  'e_mail',
  'phone',
  'mobile_number',
  'telephone',
  'contact',
  'patient',
  'birthdate',
  'birth_date',
  'dateofbirth',
  'nationalid',
  'national_id',
  'ssn',
  'passport',
  // Precise location
  'latitude',
  'longitude',
  'geolocation',
  'coordinate',
  'address',
  'street',
  'postcode',
  'postal',
  'zipcode',
  'placemark',
  'geohash',
  // Device / install identity
  'deviceid',
  'device_id',
  'installid',
  'install_id',
  'advertis',
  'fingerprint',
  'androidid',
  'android_id',
  'vendorid',
  'pushtoken',
  'push_token',
  // Credentials
  'authorization',
  'auth_token',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'sessiontoken',
  'session_token',
  'bearer',
  'cookie',
  'password',
  'passcode',
  'secret',
  'apikey',
  'api_key',
  'credential',
  'privatekey',
  'private_key',
  'signature',
  'jwt',
];

/** Bounds on the defensive deep scan, so a hostile payload cannot make it expensive. */
const SCAN_MAX_DEPTH = 8;
const SCAN_MAX_NODES = 2000;

/** Coordinate pair smuggled into a permissive ID field, e.g. `6.52438:3.37921`. */
const COORDINATE_PAIR_SHAPE = /-?\d{1,3}\.\d{3,}\s*[,:;_|/-]\s*-?\d{1,3}\.\d{3,}/;
/** Anything email-shaped. */
const EMAIL_SHAPE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/** Normalizes a key for matching: lowercased, separators and spaces stripped for exact tests. */
const normalizeKey = (key: string): string => key.toLowerCase().trim();

const stripSeparators = (key: string): string => key.replace(/[\s_.-]/g, '');

export type ProhibitedKeyKind = 'unsafe_key' | 'prohibited_container' | 'prohibited_field';

export interface ProhibitedKeyHit {
  kind: ProhibitedKeyKind;
  /**
   * The matched rule, NOT the offending key. Attacker-controlled key names are never carried
   * out of this module — see `reason-codes.ts` for what may cross the response boundary.
   */
  rule: string;
}

/** Classifies a single key. Returns null when the key trips no defense. */
export const classifyKey = (key: string): ProhibitedKeyHit | null => {
  const lower = normalizeKey(key);
  const compact = stripSeparators(lower);

  if (UNSAFE_KEYS.includes(key) || UNSAFE_KEYS.includes(lower)) {
    return { kind: 'unsafe_key', rule: lower };
  }
  if (PROHIBITED_CONTAINER_KEYS.includes(lower)) {
    return { kind: 'prohibited_container', rule: lower };
  }
  if (PROHIBITED_EXACT_KEYS.includes(compact)) {
    return { kind: 'prohibited_field', rule: compact };
  }
  for (const fragment of PROHIBITED_KEY_FRAGMENTS) {
    if (lower.includes(fragment) || compact.includes(stripSeparators(fragment))) {
      return { kind: 'prohibited_field', rule: fragment };
    }
  }
  return null;
};

/** True when a string value is shaped like prohibited content even if its key is allowlisted. */
export const hasProhibitedValueShape = (value: string): boolean =>
  COORDINATE_PAIR_SHAPE.test(value) || EMAIL_SHAPE.test(value);

export interface ProhibitedScanResult {
  hit: ProhibitedKeyHit | null;
  /** True when the scan hit its depth or node budget — treated as a rejection by the caller. */
  exhausted: boolean;
}

/**
 * Deep-scans an already-parsed payload for prohibited keys, unsafe keys and prohibited value
 * shapes, at every level of nesting.
 *
 * Runs BEFORE allowlist validation so that a prohibited key inside an otherwise well-formed
 * event is reported and counted as a prohibited-field attempt rather than as a generic
 * unknown property.
 */
export const scanForProhibited = (value: unknown): ProhibitedScanResult => {
  let nodes = 0;

  const walk = (node: unknown, depth: number): ProhibitedKeyHit | null | 'exhausted' => {
    if (depth > SCAN_MAX_DEPTH) return 'exhausted';
    if (++nodes > SCAN_MAX_NODES) return 'exhausted';

    if (typeof node === 'string') {
      return hasProhibitedValueShape(node)
        ? { kind: 'prohibited_field', rule: 'value_shape' }
        : null;
    }
    if (node === null || typeof node !== 'object') return null;

    if (Array.isArray(node)) {
      for (const item of node) {
        const result = walk(item, depth + 1);
        if (result) return result;
      }
      return null;
    }

    for (const key of Object.getOwnPropertyNames(node)) {
      const hit = classifyKey(key);
      if (hit) return hit;
      const result = walk((node as Record<string, unknown>)[key], depth + 1);
      if (result) return result;
    }
    return null;
  };

  const outcome = walk(value, 0);
  if (outcome === 'exhausted') return { hit: null, exhausted: true };
  return { hit: outcome, exhausted: false };
};

/**
 * Pino redaction paths built from the same defense list.
 *
 * Covers the header and body positions where a prohibited value could realistically reach a
 * log line. Telemetry request bodies are never logged at all (see `src/plugins/logging.ts`),
 * so this is a backstop rather than the primary control.
 */
export const buildLogRedactionPaths = (): string[] => [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  'req.headers["x-api-key"]',
  'req.headers["proxy-authorization"]',
  'res.headers["set-cookie"]',
  'req.body',
  'request.body',
  'body',
  'payload',
  'err.config.body',
  'err.request.body',
];
