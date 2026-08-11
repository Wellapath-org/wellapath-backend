/**
 * The complete, closed set of rejection reason codes.
 *
 * These are the ONLY rejection detail that ever crosses the response boundary or enters a log
 * line. They are fixed strings chosen at development time — no attacker-controlled value, no
 * offending key name, and no offending value is ever interpolated into them.
 *
 * They double as the low-cardinality label set for the rejection metric, which is why the set
 * is closed and small.
 */
export const REJECTION_REASONS = {
  /* Envelope / transport level — the whole request is refused. */
  MALFORMED_JSON: 'malformed_json',
  PAYLOAD_TOO_LARGE: 'payload_too_large',
  UNSUPPORTED_CONTENT_TYPE: 'unsupported_content_type',
  INVALID_ENVELOPE: 'invalid_envelope',
  UNSUPPORTED_CONTRACT_VERSION: 'unsupported_contract_version',
  EMPTY_BATCH: 'empty_batch',
  BATCH_TOO_LARGE: 'batch_too_large',
  TELEMETRY_DISABLED: 'telemetry_disabled',
  RATE_LIMITED: 'rate_limited',

  /* Event level — the individual event is refused, the rest of the batch may proceed. */
  UNKNOWN_EVENT: 'unknown_event',
  UNKNOWN_PROPERTY: 'unknown_property',
  MISSING_REQUIRED_PROPERTY: 'missing_required_property',
  INVALID_TYPE: 'invalid_type',
  INVALID_ENUM_VALUE: 'invalid_enum_value',
  INVALID_FORMAT: 'invalid_format',
  VALUE_TOO_LONG: 'value_too_long',
  VALUE_OUT_OF_RANGE: 'value_out_of_range',
  TIMESTAMP_OUT_OF_RANGE: 'timestamp_out_of_range',
  NESTED_VALUE_NOT_ALLOWED: 'nested_value_not_allowed',

  /* Defense-in-depth layer. */
  PROHIBITED_FIELD: 'prohibited_field',
  PROHIBITED_CONTAINER: 'prohibited_container',
  PROHIBITED_VALUE_SHAPE: 'prohibited_value_shape',
  UNSAFE_KEY: 'unsafe_key',
  PAYLOAD_TOO_COMPLEX: 'payload_too_complex',
} as const;

export type RejectionReason = (typeof REJECTION_REASONS)[keyof typeof REJECTION_REASONS];

/** Every reason code, used to pre-seed metrics so the label set is fixed and enumerable. */
export const ALL_REJECTION_REASONS: readonly RejectionReason[] = Object.values(REJECTION_REASONS);

/** Per-event outcome statuses. */
export const EVENT_STATUS = {
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
  DUPLICATE: 'duplicate',
} as const;

export type EventStatus = (typeof EVENT_STATUS)[keyof typeof EVENT_STATUS];
