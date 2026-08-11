/**
 * Fail-closed telemetry validator.
 *
 * Every rule here is a rejection rule. Nothing is accepted unless `contract.ts` explicitly
 * declares it, and nothing about a rejected value is carried out of this module beyond a fixed
 * reason code and — where the name is one of ours — an allowlisted field name.
 *
 * Validation is deliberately hand-written against the contract declarations rather than
 * delegated to a schema library: it lets an unknown key be reported without echoing it, keeps
 * the rejection-reason set closed, and avoids a validation error message that could quote the
 * offending value back to the caller or into a log line.
 */
import {
  APP_CONTEXT_SPEC,
  ENVELOPE_SPEC,
  FieldSpec,
  FieldSpecMap,
  LIMITS,
  SUPPORTED_CONTRACT_VERSIONS,
  isAllowlistedEvent,
  propertiesForEvent,
} from './contract';
import { REJECTION_REASONS, RejectionReason, EVENT_STATUS } from './reason-codes';
import { hasProhibitedValueShape, scanForProhibited } from './prohibited';
import {
  EnvelopeValidationResult,
  EventOutcome,
  TelemetryPropertyValue,
  ValidatedAppContext,
  ValidatedEvent,
} from './types';

const ENVELOPE_KEYS: readonly string[] = ['contract_version', 'sent_at', 'app', 'events'];

/** Anchored regexes, compiled once per pattern. */
const patternCache = new Map<string, RegExp>();

const anchoredPattern = (pattern: string): RegExp => {
  const cached = patternCache.get(pattern);
  if (cached) return cached;
  const compiled = new RegExp(`^(?:${pattern})$`);
  patternCache.set(pattern, compiled);
  return compiled;
};

const ownKeys = (value: object): string[] => Object.getOwnPropertyNames(value);

const hasOwn = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A field-level failure: a fixed reason plus, where safe, the allowlisted field name. */
interface FieldFailure {
  reason: RejectionReason;
  field?: string;
}

/** Maps a prohibited-scan hit onto a reason code. */
const reasonForProhibitedKind = (kind: string): RejectionReason => {
  if (kind === 'unsafe_key') return REJECTION_REASONS.UNSAFE_KEY;
  if (kind === 'prohibited_container') return REJECTION_REASONS.PROHIBITED_CONTAINER;
  return REJECTION_REASONS.PROHIBITED_FIELD;
};

/**
 * Validates a single value against its spec.
 * `field` is the contract's own name for the property, so it is safe to return.
 */
export const validateValue = (
  field: string,
  spec: FieldSpec,
  value: unknown,
): FieldFailure | null => {
  if (value === null || typeof value === 'object') {
    return { reason: REJECTION_REASONS.NESTED_VALUE_NOT_ALLOWED, field };
  }

  switch (spec.kind) {
    case 'enum': {
      if (typeof value !== 'string') return { reason: REJECTION_REASONS.INVALID_TYPE, field };
      if (!spec.values.includes(value)) {
        return { reason: REJECTION_REASONS.INVALID_ENUM_VALUE, field };
      }
      return null;
    }
    case 'string': {
      if (typeof value !== 'string') return { reason: REJECTION_REASONS.INVALID_TYPE, field };
      if (value.length > spec.maxLength) {
        return { reason: REJECTION_REASONS.VALUE_TOO_LONG, field };
      }
      if (!anchoredPattern(spec.pattern).test(value)) {
        return { reason: REJECTION_REASONS.INVALID_FORMAT, field };
      }
      if (hasProhibitedValueShape(value)) {
        return { reason: REJECTION_REASONS.PROHIBITED_VALUE_SHAPE, field };
      }
      return null;
    }
    case 'integer': {
      if (typeof value !== 'number' || !Number.isInteger(value) || !Number.isFinite(value)) {
        return { reason: REJECTION_REASONS.INVALID_TYPE, field };
      }
      if (value < spec.min || value > spec.max) {
        return { reason: REJECTION_REASONS.VALUE_OUT_OF_RANGE, field };
      }
      return null;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') return { reason: REJECTION_REASONS.INVALID_TYPE, field };
      return null;
    }
    default:
      return { reason: REJECTION_REASONS.INVALID_TYPE, field };
  }
};

/**
 * Validates an ISO-8601 UTC timestamp that has already passed its pattern check, confirming it
 * is a real instant inside the accepted window.
 */
export const validateTimestampWindow = (
  field: string,
  value: string,
  nowMs: number,
): FieldFailure | null => {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return { reason: REJECTION_REASONS.INVALID_FORMAT, field };
  if (nowMs - parsed > LIMITS.maxClientTimestampAgeMs) {
    return { reason: REJECTION_REASONS.TIMESTAMP_OUT_OF_RANGE, field };
  }
  if (parsed - nowMs > LIMITS.maxClientTimestampSkewMs) {
    return { reason: REJECTION_REASONS.TIMESTAMP_OUT_OF_RANGE, field };
  }
  return null;
};

/**
 * Validates an object against a spec map: rejects unknown keys, missing required keys, and any
 * value that fails its spec. Returns the accepted values on success.
 */
const validateAgainstSpecMap = (
  source: Record<string, unknown>,
  specs: FieldSpecMap,
): { failure: FieldFailure } | { accepted: Record<string, TelemetryPropertyValue> } => {
  for (const key of ownKeys(source)) {
    if (!hasOwn(specs, key)) {
      // The key is attacker-controlled — it is counted and refused, never echoed.
      return { failure: { reason: REJECTION_REASONS.UNKNOWN_PROPERTY } };
    }
  }

  const accepted: Record<string, TelemetryPropertyValue> = {};

  for (const field of Object.keys(specs)) {
    const spec = specs[field];
    const present = hasOwn(source, field) && source[field] !== undefined;

    if (!present) {
      if (spec.required) {
        return { failure: { reason: REJECTION_REASONS.MISSING_REQUIRED_PROPERTY, field } };
      }
      continue;
    }

    const failure = validateValue(field, spec, source[field]);
    if (failure) return { failure };

    accepted[field] = source[field] as TelemetryPropertyValue;
  }

  return { accepted };
};

export interface EventValidationSuccess {
  ok: true;
  event: ValidatedEvent;
}

export interface EventValidationFailure {
  ok: false;
  reason: RejectionReason;
  field?: string;
}

export type EventValidationResult = EventValidationSuccess | EventValidationFailure;

/** Validates a single event object. */
export const validateEvent = (raw: unknown, nowMs: number): EventValidationResult => {
  if (!isPlainObject(raw)) {
    return { ok: false, reason: REJECTION_REASONS.INVALID_TYPE };
  }

  // Defense-in-depth pass first, so a prohibited key is reported as such rather than as a
  // generic unknown property.
  const scan = scanForProhibited(raw);
  if (scan.exhausted) {
    return { ok: false, reason: REJECTION_REASONS.PAYLOAD_TOO_COMPLEX };
  }
  if (scan.hit) {
    return { ok: false, reason: reasonForProhibitedKind(scan.hit.kind) };
  }

  const nameValue = hasOwn(raw, 'event_name') ? raw.event_name : undefined;
  if (typeof nameValue !== 'string' || !isAllowlistedEvent(nameValue)) {
    return { ok: false, reason: REJECTION_REASONS.UNKNOWN_EVENT };
  }

  const result = validateAgainstSpecMap(raw, propertiesForEvent(nameValue));
  if ('failure' in result) {
    return { ok: false, reason: result.failure.reason, field: result.failure.field };
  }

  const timestampFailure = validateTimestampWindow(
    'client_ts',
    result.accepted.client_ts as string,
    nowMs,
  );
  if (timestampFailure) {
    return { ok: false, reason: timestampFailure.reason, field: timestampFailure.field };
  }

  return { ok: true, event: result.accepted as ValidatedEvent };
};

/**
 * Validates a complete request body.
 *
 * Envelope problems refuse the whole request. Event problems refuse only that event, so one bad
 * event in an offline-queue flush cannot poison the batch and trap the client in a retry loop.
 */
export const validateEnvelope = (body: unknown, nowMs: number): EnvelopeValidationResult => {
  if (!isPlainObject(body)) {
    return { ok: false, reason: REJECTION_REASONS.INVALID_ENVELOPE };
  }

  for (const key of ownKeys(body)) {
    if (!ENVELOPE_KEYS.includes(key)) {
      return { ok: false, reason: REJECTION_REASONS.INVALID_ENVELOPE };
    }
  }

  // Scan the envelope shell (everything except the events array, which is scanned per event).
  const shell: Record<string, unknown> = {};
  for (const key of ENVELOPE_KEYS) {
    if (key !== 'events' && hasOwn(body, key)) shell[key] = body[key];
  }
  const shellScan = scanForProhibited(shell);
  if (shellScan.exhausted) {
    return { ok: false, reason: REJECTION_REASONS.PAYLOAD_TOO_COMPLEX };
  }
  if (shellScan.hit) {
    return { ok: false, reason: reasonForProhibitedKind(shellScan.hit.kind) };
  }

  const contractVersion = body.contract_version;
  if (
    typeof contractVersion !== 'string' ||
    !SUPPORTED_CONTRACT_VERSIONS.includes(contractVersion)
  ) {
    return { ok: false, reason: REJECTION_REASONS.UNSUPPORTED_CONTRACT_VERSION };
  }

  const sentAtSpec = ENVELOPE_SPEC.sent_at;
  const sentAtFailure = validateValue('sent_at', sentAtSpec, body.sent_at);
  if (sentAtFailure) {
    return { ok: false, reason: REJECTION_REASONS.INVALID_ENVELOPE };
  }
  if (validateTimestampWindow('sent_at', body.sent_at as string, nowMs)) {
    return { ok: false, reason: REJECTION_REASONS.INVALID_ENVELOPE };
  }

  if (!isPlainObject(body.app)) {
    return { ok: false, reason: REJECTION_REASONS.INVALID_ENVELOPE };
  }
  const appResult = validateAgainstSpecMap(body.app, APP_CONTEXT_SPEC);
  if ('failure' in appResult) {
    return { ok: false, reason: REJECTION_REASONS.INVALID_ENVELOPE };
  }

  const rawEvents = body.events;
  if (!Array.isArray(rawEvents)) {
    return { ok: false, reason: REJECTION_REASONS.INVALID_ENVELOPE };
  }
  if (rawEvents.length < LIMITS.minEventsPerBatch) {
    return { ok: false, reason: REJECTION_REASONS.EMPTY_BATCH };
  }
  if (rawEvents.length > LIMITS.maxEventsPerBatch) {
    return { ok: false, reason: REJECTION_REASONS.BATCH_TOO_LARGE };
  }

  const events: ValidatedEvent[] = [];
  const outcomes: EventOutcome[] = [];

  rawEvents.forEach((raw, index) => {
    const result = validateEvent(raw, nowMs);
    if (result.ok) {
      events.push(result.event);
      outcomes.push({ index, status: EVENT_STATUS.ACCEPTED });
      return;
    }
    outcomes.push({
      index,
      status: EVENT_STATUS.REJECTED,
      reason: result.reason,
      ...(result.field ? { field: result.field } : {}),
    });
  });

  return {
    ok: true,
    contract_version: contractVersion,
    sent_at: body.sent_at as string,
    app: appResult.accepted as unknown as ValidatedAppContext,
    events,
    outcomes,
  };
};
