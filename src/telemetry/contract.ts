/**
 * WellaPath privacy-safe product telemetry contract — I1 / W1.
 *
 * THIS FILE IS THE SINGLE SOURCE OF TRUTH.
 *
 * The runtime validator, the JSON Schema, the OpenAPI document, the generated mobile client
 * types, and the documented allowlist matrix are all derived from the declarations below.
 * Changing an event or a field here changes all of them — regenerate with
 * `npm run telemetry:contract`.
 *
 * Locked constraints this contract exists to uphold:
 *   - No symptom-level PHI is ever accepted server-side.
 *   - Clinical scoring, red-flag evaluation and urgency determination stay on-device.
 *   - The backend must not receive or be able to reconstruct a complete assessment history.
 *
 * Everything is allowlisted. Anything not declared here is rejected at the boundary.
 */

/** Contract version. Bump the minor for additive changes, the major for breaking ones. */
export const TELEMETRY_CONTRACT_VERSION = '1.0';

/** Contract versions this server build will accept in the request envelope. */
export const SUPPORTED_CONTRACT_VERSIONS: readonly string[] = [TELEMETRY_CONTRACT_VERSION];

/** Hard boundary limits. Enforced before and during validation. */
export const LIMITS = {
  /** Maximum accepted request body size, in bytes. Enforced by Fastify before parsing. */
  maxBodyBytes: 32768,
  /** Maximum number of events in a single batch. */
  maxEventsPerBatch: 20,
  /** Minimum number of events in a single batch. */
  minEventsPerBatch: 1,
  /** How far in the past a client timestamp may be — generous, to allow an offline queue. */
  maxClientTimestampAgeMs: 30 * 24 * 60 * 60 * 1000,
  /** How far in the future a client timestamp may be — allows for modest clock skew. */
  maxClientTimestampSkewMs: 24 * 60 * 60 * 1000,
} as const;

/**
 * Privacy classification applied to every accepted property.
 *
 * - `operational`            — build/lifecycle/technical measure. Carries no user meaning.
 * - `ephemeral-pseudonymous` — opaque per-assessment or per-event ID. Not an identity, not
 *                              persistent across sessions, not derived from device identity.
 * - `coarse-geography`       — administrative area no finer than state level.
 * - `content-reference`      — an ID of published content the user opened. Not clinical output.
 * - `structured-feedback`    — a bounded rating/category the user explicitly submitted.
 */
export type PrivacyClass =
  | 'operational'
  | 'ephemeral-pseudonymous'
  | 'coarse-geography'
  | 'content-reference'
  | 'structured-feedback';

interface FieldSpecBase {
  required: boolean;
  privacy: PrivacyClass;
  description: string;
}

export interface EnumFieldSpec extends FieldSpecBase {
  kind: 'enum';
  values: readonly string[];
}

export interface StringFieldSpec extends FieldSpecBase {
  kind: 'string';
  /** Anchored at both ends by the validator and by the generated JSON Schema. */
  pattern: string;
  maxLength: number;
}

export interface IntegerFieldSpec extends FieldSpecBase {
  kind: 'integer';
  min: number;
  max: number;
}

export interface BooleanFieldSpec extends FieldSpecBase {
  kind: 'boolean';
}

export type FieldSpec = EnumFieldSpec | StringFieldSpec | IntegerFieldSpec | BooleanFieldSpec;

export type FieldSpecMap = Readonly<Record<string, FieldSpec>>;

/* -------------------------------------------------------------------------------------------- */
/* Shared patterns                                                                                */
/* -------------------------------------------------------------------------------------------- */

/** Opaque, ephemeral, client-generated ID. URL-safe alphabet only. */
const OPAQUE_ID_PATTERN = '[A-Za-z0-9_-]{16,64}';
/** Event de-duplication ID. Same alphabet, slightly shorter floor. */
const EVENT_ID_PATTERN = '[A-Za-z0-9_-]{8,64}';
/** ISO-8601, UTC only (`Z`), optional milliseconds. Offsets are rejected. */
const ISO_UTC_TIMESTAMP_PATTERN = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,3})?Z';
/** Semver-ish application version, e.g. `1.4.2` or `1.4.2-beta.3`. */
const APP_VERSION_PATTERN = '\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}(-[A-Za-z0-9.]{1,16})?';
/** Build number. Digits only. */
const APP_BUILD_PATTERN = '\\d{1,10}';
/**
 * OS version restricted to major[.minor] only. Full build strings (e.g. `17.4.1 (21E236)`) are
 * deliberately not accepted — they narrow the device population and drift toward fingerprinting.
 */
const OS_VERSION_PATTERN = '\\d{1,3}(\\.\\d{1,3})?';
/** Opaque published-content or facility identifier. */
const RESOURCE_ID_PATTERN = '[A-Za-z0-9_.:-]{1,64}';
/** Artifact/presentation contract version, e.g. `2.4` or `1.0.0`. */
const SHORT_VERSION_PATTERN = '\\d{1,3}(\\.\\d{1,3}){0,2}';

/**
 * ISO 3166-2:NG subdivision codes — the 36 states plus the Federal Capital Territory.
 *
 * State level is the finest geography this contract will ever accept. It is an external public
 * standard rather than an invented code set. See `docs/TELEMETRY_CONTRACT.md` for the mapping
 * obligation this places on the mobile client.
 */
export const NG_ADMIN_AREA_CODES: readonly string[] = [
  'NG-AB', // Abia
  'NG-AD', // Adamawa
  'NG-AK', // Akwa Ibom
  'NG-AN', // Anambra
  'NG-BA', // Bauchi
  'NG-BE', // Benue
  'NG-BO', // Borno
  'NG-BY', // Bayelsa
  'NG-CR', // Cross River
  'NG-DE', // Delta
  'NG-EB', // Ebonyi
  'NG-ED', // Edo
  'NG-EK', // Ekiti
  'NG-EN', // Enugu
  'NG-FC', // Federal Capital Territory
  'NG-GO', // Gombe
  'NG-IM', // Imo
  'NG-JI', // Jigawa
  'NG-KD', // Kaduna
  'NG-KE', // Kebbi
  'NG-KN', // Kano
  'NG-KO', // Kogi
  'NG-KT', // Katsina
  'NG-KW', // Kwara
  'NG-LA', // Lagos
  'NG-NA', // Nasarawa
  'NG-NI', // Niger
  'NG-OG', // Ogun
  'NG-ON', // Ondo
  'NG-OS', // Osun
  'NG-OY', // Oyo
  'NG-PL', // Plateau
  'NG-RI', // Rivers
  'NG-SO', // Sokoto
  'NG-TA', // Taraba
  'NG-YO', // Yobe
  'NG-ZA', // Zamfara
] as const;

/* -------------------------------------------------------------------------------------------- */
/* Envelope                                                                                       */
/* -------------------------------------------------------------------------------------------- */

/**
 * Coarse application/runtime context, sent once per batch rather than per event.
 *
 * Deliberately excluded: device model, device ID, install ID, advertising ID, IDFV/ANDROID_ID,
 * carrier, screen metrics, timezone. Each is either an identifier or a fingerprinting surface.
 */
export const APP_CONTEXT_SPEC: FieldSpecMap = {
  platform: {
    kind: 'enum',
    values: ['ios', 'android'],
    required: true,
    privacy: 'operational',
    description: 'Mobile platform.',
  },
  app_version: {
    kind: 'string',
    pattern: APP_VERSION_PATTERN,
    maxLength: 24,
    required: true,
    privacy: 'operational',
    description: 'Application version as released.',
  },
  app_build: {
    kind: 'string',
    pattern: APP_BUILD_PATTERN,
    maxLength: 10,
    required: true,
    privacy: 'operational',
    description: 'Application build number.',
  },
  os_version: {
    kind: 'string',
    pattern: OS_VERSION_PATTERN,
    maxLength: 8,
    required: false,
    privacy: 'operational',
    description: 'OS version, major[.minor] only. Full build strings are rejected.',
  },
} as const;

/** Top-level request envelope fields, excluding the `app` object and the `events` array. */
export const ENVELOPE_SPEC: FieldSpecMap = {
  contract_version: {
    kind: 'enum',
    values: SUPPORTED_CONTRACT_VERSIONS,
    required: true,
    privacy: 'operational',
    description: 'Telemetry contract version the client was built against.',
  },
  sent_at: {
    kind: 'string',
    pattern: ISO_UTC_TIMESTAMP_PATTERN,
    maxLength: 24,
    required: true,
    privacy: 'operational',
    description: 'Client clock reading when the batch was transmitted. ISO-8601 UTC.',
  },
} as const;

/* -------------------------------------------------------------------------------------------- */
/* Event-specific properties                                                                      */
/* -------------------------------------------------------------------------------------------- */

const assessmentSessionIdSpec = (description: string): StringFieldSpec => ({
  kind: 'string',
  pattern: OPAQUE_ID_PATTERN,
  maxLength: 64,
  required: true,
  privacy: 'ephemeral-pseudonymous',
  description,
});

export interface EventSpec {
  description: string;
  /** Why this event's payload is safe — carried into the generated documentation. */
  privacyNote: string;
  properties: FieldSpecMap;
}

/**
 * The event allowlist.
 *
 * Every property below is a deliberate inclusion. Notable deliberate *exclusions* are recorded
 * in `docs/TELEMETRY_CONTRACT.md` under "Excluded and unresolved fields" — most importantly
 * `urgency_category`, `question_id` and the free-text feedback body.
 */
export const EVENT_SPECS: Readonly<Record<string, EventSpec>> = {
  app_open: {
    description: 'The application was brought to the foreground.',
    privacyNote: 'Lifecycle only. No user, assessment or content reference.',
    properties: {
      launch_type: {
        kind: 'enum',
        values: ['cold', 'warm'],
        required: true,
        privacy: 'operational',
        description: 'Whether the process was started fresh or resumed.',
      },
      is_first_launch: {
        kind: 'boolean',
        required: false,
        privacy: 'operational',
        description: 'True only on the first launch after installation.',
      },
    },
  },

  assessment_start: {
    description: 'The user began an assessment.',
    privacyNote:
      'Carries an opaque per-assessment ID and non-clinical flow metadata. No symptom, ' +
      'answer or condition data.',
    properties: {
      assessment_session_id: assessmentSessionIdSpec(
        'Opaque, ephemeral ID for this assessment. Generated per assessment, never reused, ' +
          'never derived from device or account identity.',
      ),
      flow_version: {
        kind: 'string',
        pattern: SHORT_VERSION_PATTERN,
        maxLength: 12,
        required: false,
        privacy: 'operational',
        description: 'Version of the assessment flow presented on-device.',
      },
      entry_point: {
        kind: 'enum',
        values: ['home', 'library', 'facility_locator', 'deep_link'],
        required: false,
        privacy: 'operational',
        description: 'Which screen the assessment was launched from.',
      },
    },
  },

  assessment_step_view: {
    description: 'An assessment step was displayed.',
    privacyNote:
      'Ordinal position only. Question IDs are deliberately NOT accepted in v1.0: in an ' +
      'adaptive flow the sequence of question IDs within a session is answer-derived, which ' +
      'would let the backend partially reconstruct an assessment path. Ordinal position ' +
      'supports the drop-off funnel without that risk.',
    properties: {
      assessment_session_id: assessmentSessionIdSpec(
        'Opaque, ephemeral ID for the assessment this step belongs to.',
      ),
      step_index: {
        kind: 'integer',
        min: 0,
        max: 200,
        required: true,
        privacy: 'operational',
        description: 'Zero-based ordinal position of the step within the flow.',
      },
      step_count: {
        kind: 'integer',
        min: 1,
        max: 200,
        required: false,
        privacy: 'operational',
        description: 'Total steps in the flow at the time of viewing, if known.',
      },
    },
  },

  assessment_complete: {
    description: 'An assessment reached a terminal state.',
    privacyNote:
      'Completion shape and effort measures only. `urgency_category` is NOT accepted — it is ' +
      'a clinical output and has no approval on record in this repository.',
    properties: {
      assessment_session_id: assessmentSessionIdSpec('Opaque, ephemeral ID for the assessment.'),
      completion_status: {
        kind: 'enum',
        values: ['completed', 'abandoned', 'interrupted'],
        required: true,
        privacy: 'operational',
        description: 'How the assessment ended.',
      },
      duration_ms: {
        kind: 'integer',
        min: 0,
        max: 7200000,
        required: false,
        privacy: 'operational',
        description: 'Wall-clock duration of the assessment in milliseconds.',
      },
      step_count: {
        kind: 'integer',
        min: 0,
        max: 200,
        required: false,
        privacy: 'operational',
        description: 'Number of steps the user actually reached.',
      },
    },
  },

  result_view: {
    description: 'The result screen was displayed.',
    privacyNote:
      'Presentation-layer version only. No condition, differential, score, explanation, ' +
      'urgency or narrative is accepted.',
    properties: {
      assessment_session_id: assessmentSessionIdSpec(
        'Opaque, ephemeral ID for the assessment whose result was shown.',
      ),
      presentation_contract_version: {
        kind: 'string',
        pattern: SHORT_VERSION_PATTERN,
        maxLength: 12,
        required: false,
        privacy: 'operational',
        description: 'Version of the on-device result presentation contract.',
      },
    },
  },

  facility_search: {
    description: 'The user ran a facility search.',
    privacyNote:
      'Search mode, outcome volume, and state-level administrative area only. No coordinates, ' +
      'no address text, no query text, no location history.',
    properties: {
      search_mode: {
        kind: 'enum',
        values: ['nearby', 'manual_area', 'name'],
        required: true,
        privacy: 'operational',
        description: 'How the search was initiated.',
      },
      admin_area_code: {
        kind: 'enum',
        values: NG_ADMIN_AREA_CODES,
        required: false,
        privacy: 'coarse-geography',
        description:
          'ISO 3166-2:NG state-level code. State level is the finest geography accepted. ' +
          'Omit if the client cannot map its area to a code with confidence.',
      },
      result_count: {
        kind: 'integer',
        min: 0,
        max: 500,
        required: false,
        privacy: 'operational',
        description: 'Number of facilities returned. Zero-result searches are a coverage signal.',
      },
    },
  },

  facility_view: {
    description: 'A facility detail screen was opened.',
    privacyNote:
      'Facility ID and navigation origin only. Not correlated to any assessment session.',
    properties: {
      facility_id: {
        kind: 'string',
        pattern: RESOURCE_ID_PATTERN,
        maxLength: 64,
        required: true,
        privacy: 'content-reference',
        description: 'Identifier from the facilities artifact.',
      },
      source: {
        kind: 'enum',
        values: ['search_results', 'map', 'saved', 'emergency_screen'],
        required: false,
        privacy: 'operational',
        description: 'Which surface the facility was opened from.',
      },
    },
  },

  facility_call: {
    description: 'The user initiated a call to a facility.',
    privacyNote:
      'Facility ID and navigation origin only. No phone number is accepted — the number is ' +
      'already published in the facilities artifact and echoing it back adds only risk.',
    properties: {
      facility_id: {
        kind: 'string',
        pattern: RESOURCE_ID_PATTERN,
        maxLength: 64,
        required: true,
        privacy: 'content-reference',
        description: 'Identifier from the facilities artifact.',
      },
      source: {
        kind: 'enum',
        values: ['search_results', 'facility_detail', 'emergency_screen'],
        required: false,
        privacy: 'operational',
        description: 'Which surface the call was initiated from.',
      },
    },
  },

  directions_open: {
    description: 'The user opened directions to a facility.',
    privacyNote: 'Facility ID and handoff target only. No origin coordinates, no route data.',
    properties: {
      facility_id: {
        kind: 'string',
        pattern: RESOURCE_ID_PATTERN,
        maxLength: 64,
        required: true,
        privacy: 'content-reference',
        description: 'Identifier from the facilities artifact.',
      },
      source: {
        kind: 'enum',
        values: ['search_results', 'facility_detail', 'emergency_screen'],
        required: false,
        privacy: 'operational',
        description: 'Which surface directions were opened from.',
      },
    },
  },

  emergency_action: {
    description: 'The user took an action on an emergency surface.',
    privacyNote:
      'Allowlisted action type only. The triggering symptom, answer, red flag, rule ID and ' +
      'narrative are all rejected. No assessment session ID is accepted on this event — ' +
      'correlating an emergency action to an assessment would imply a red-flag match.',
    properties: {
      action_type: {
        kind: 'enum',
        values: [
          'call_emergency_number',
          'view_emergency_guidance',
          'dismiss_emergency_banner',
          'open_nearest_facility',
        ],
        required: true,
        privacy: 'operational',
        description: 'Which emergency affordance the user used.',
      },
    },
  },

  library_article_view: {
    description: 'A library article was opened.',
    privacyNote:
      'Published-content reference and content version only. Not correlated to any assessment ' +
      'session, so an article view cannot be joined to a clinical journey.',
    properties: {
      article_id: {
        kind: 'string',
        pattern: RESOURCE_ID_PATTERN,
        maxLength: 64,
        required: true,
        privacy: 'content-reference',
        description: 'Identifier of the published article.',
      },
      content_version: {
        kind: 'string',
        pattern: SHORT_VERSION_PATTERN,
        maxLength: 12,
        required: false,
        privacy: 'operational',
        description: 'Version of the content bundle the article was served from.',
      },
    },
  },

  feedback_submit: {
    description: 'The user submitted structured feedback.',
    privacyNote:
      'Rating and category only. Free text is excluded from this contract entirely and must ' +
      'not be routed here — see docs/TELEMETRY_CONTRACT.md.',
    properties: {
      rating: {
        kind: 'integer',
        min: 1,
        max: 5,
        required: true,
        privacy: 'structured-feedback',
        description: 'Star rating, 1 to 5.',
      },
      category: {
        kind: 'enum',
        values: ['usability', 'performance', 'content', 'other'],
        required: false,
        privacy: 'structured-feedback',
        description: 'Bounded feedback category.',
      },
    },
  },
} as const;

/** The allowlisted event names, in declaration order. */
export const EVENT_NAMES: readonly string[] = Object.keys(EVENT_SPECS);

/** Fields every event carries, whatever its name. */
export const COMMON_EVENT_SPEC: FieldSpecMap = {
  event_name: {
    kind: 'enum',
    values: EVENT_NAMES,
    required: true,
    privacy: 'operational',
    description: 'Allowlisted event name.',
  },
  event_id: {
    kind: 'string',
    pattern: EVENT_ID_PATTERN,
    maxLength: 64,
    required: true,
    privacy: 'ephemeral-pseudonymous',
    description: 'Client-generated unique ID for this event. Used for de-duplication only.',
  },
  client_ts: {
    kind: 'string',
    pattern: ISO_UTC_TIMESTAMP_PATTERN,
    maxLength: 24,
    required: true,
    privacy: 'operational',
    description: 'Client clock reading when the event occurred. ISO-8601 UTC.',
  },
} as const;

/** Returns true when `name` is an allowlisted event name. */
export const isAllowlistedEvent = (name: string): boolean =>
  Object.prototype.hasOwnProperty.call(EVENT_SPECS, name);

/** Returns the full accepted property set for an event: common fields plus event-specific. */
export const propertiesForEvent = (name: string): FieldSpecMap => {
  const spec = EVENT_SPECS[name];
  if (!spec) return COMMON_EVENT_SPEC;
  return { ...COMMON_EVENT_SPEC, ...spec.properties };
};
