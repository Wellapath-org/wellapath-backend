import { EventStatus, RejectionReason } from './reason-codes';

/**
 * The only value types a telemetry property may hold. There is no object or array type here by
 * design — nesting is how arbitrary data smuggles itself past a flat allowlist.
 */
export type TelemetryPropertyValue = string | number | boolean;

/** Coarse application/runtime context, sent once per batch. */
export interface ValidatedAppContext {
  platform: string;
  app_version: string;
  app_build: string;
  os_version?: string;
}

/**
 * An event that has passed the allowlist. Every key present is guaranteed to be declared in
 * `contract.ts` for this event name, and every value is guaranteed to satisfy its spec.
 */
export type ValidatedEvent = {
  event_name: string;
  event_id: string;
  client_ts: string;
} & Record<string, TelemetryPropertyValue>;

/** A batch that has passed envelope validation, carrying only accepted events. */
export interface ValidatedEnvelope {
  contract_version: string;
  sent_at: string;
  app: ValidatedAppContext;
  events: ValidatedEvent[];
}

/** Per-event outcome. `field` is only ever an allowlisted field name, never a client-supplied key. */
export interface EventOutcome {
  index: number;
  status: EventStatus;
  reason?: RejectionReason;
  field?: string;
}

/** Envelope-level validation failed; the whole request is refused. */
export interface EnvelopeRejected {
  ok: false;
  reason: RejectionReason;
}

/** Envelope-level validation passed. Individual events may still have been rejected. */
export interface EnvelopeAccepted {
  ok: true;
  contract_version: string;
  sent_at: string;
  app: ValidatedAppContext;
  events: ValidatedEvent[];
  outcomes: EventOutcome[];
}

export type EnvelopeValidationResult = EnvelopeAccepted | EnvelopeRejected;
