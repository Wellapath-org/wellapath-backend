/**
 * Telemetry intake orchestration: validate → de-duplicate → count → dispatch.
 *
 * The route layer stays thin so that this pipeline can be unit-tested without HTTP, and so
 * there is exactly one place where a decision about accepting data is made.
 */
import { TELEMETRY_CONTRACT_VERSION } from './contract';
import { DedupeStore } from './dedupe';
import { TelemetryDispatcher } from './dispatcher';
import { metrics } from './metrics';
import { EVENT_STATUS, REJECTION_REASONS, RejectionReason } from './reason-codes';
import { EventOutcome, ValidatedEvent } from './types';
import { validateEnvelope } from './validator';

export interface IngestResponseBody {
  contract_version: string;
  received: number;
  accepted: number;
  rejected: number;
  duplicates: number;
  results: EventOutcome[];
}

export interface IngestErrorBody {
  error: {
    statusCode: number;
    message: string;
    reason_code: RejectionReason;
  };
}

export type IngestResult =
  | { statusCode: 202; body: IngestResponseBody }
  | { statusCode: 400 | 503; body: IngestErrorBody };

export interface TelemetryServiceOptions {
  enabled: boolean;
  dispatcher: TelemetryDispatcher;
  dedupe: DedupeStore;
  /** Injectable clock, so timestamp-window behaviour is testable without faking globals. */
  now?: () => number;
}

/**
 * Generic, non-sensitive client-facing messages. There is one per envelope-level failure mode
 * and none of them varies with the submitted content.
 */
const ENVELOPE_MESSAGES: Partial<Record<RejectionReason, string>> = {
  [REJECTION_REASONS.MALFORMED_JSON]: 'Request body could not be parsed',
  [REJECTION_REASONS.PAYLOAD_TOO_LARGE]: 'Request body exceeds the permitted size',
  [REJECTION_REASONS.UNSUPPORTED_CONTENT_TYPE]: 'Unsupported content type',
  [REJECTION_REASONS.INVALID_ENVELOPE]: 'Invalid telemetry envelope',
  [REJECTION_REASONS.UNSUPPORTED_CONTRACT_VERSION]: 'Unsupported telemetry contract version',
  [REJECTION_REASONS.EMPTY_BATCH]: 'Batch contains no events',
  [REJECTION_REASONS.BATCH_TOO_LARGE]: 'Batch contains too many events',
  [REJECTION_REASONS.PAYLOAD_TOO_COMPLEX]: 'Invalid telemetry envelope',
  [REJECTION_REASONS.PROHIBITED_FIELD]: 'Invalid telemetry envelope',
  [REJECTION_REASONS.PROHIBITED_CONTAINER]: 'Invalid telemetry envelope',
  [REJECTION_REASONS.UNSAFE_KEY]: 'Invalid telemetry envelope',
  [REJECTION_REASONS.TELEMETRY_DISABLED]: 'Telemetry intake is disabled',
};

/** Builds the error envelope. Matches the project-wide `{ error: { statusCode, message } }`. */
export const buildIngestError = (
  statusCode: 400 | 503,
  reason: RejectionReason,
): IngestErrorBody => ({
  error: {
    statusCode,
    message: ENVELOPE_MESSAGES[reason] ?? 'Invalid telemetry request',
    reason_code: reason,
  },
});

export class TelemetryService {
  private readonly now: () => number;

  constructor(private readonly options: TelemetryServiceOptions) {
    this.now = options.now ?? ((): number => Date.now());
  }

  get enabled(): boolean {
    return this.options.enabled;
  }

  /**
   * Processes one request body. Takes the already-parsed body — this method never sees, logs
   * or retains the raw bytes.
   */
  ingest(body: unknown): IngestResult {
    if (!this.options.enabled) {
      metrics.telemetryRequests.increment('disabled');
      return {
        statusCode: 503,
        body: buildIngestError(503, REJECTION_REASONS.TELEMETRY_DISABLED),
      };
    }

    const nowMs = this.now();
    const validation = validateEnvelope(body, nowMs);

    if (!validation.ok) {
      metrics.telemetryRequests.increment('rejected');
      metrics.incrementRejection(validation.reason);
      return { statusCode: 400, body: buildIngestError(400, validation.reason) };
    }

    const deliverable: ValidatedEvent[] = [];
    let acceptedCursor = 0;
    let duplicates = 0;

    for (const outcome of validation.outcomes) {
      if (outcome.status !== EVENT_STATUS.ACCEPTED) {
        if (outcome.reason) metrics.incrementRejection(outcome.reason);
        continue;
      }

      const event = validation.events[acceptedCursor];
      acceptedCursor += 1;

      if (this.options.dedupe.seen(event.event_id, nowMs)) {
        outcome.status = EVENT_STATUS.DUPLICATE;
        metrics.telemetryEventsDuplicate.increment();
        duplicates += 1;
        continue;
      }

      deliverable.push(event);
      metrics.telemetryEventsAccepted.increment(event.event_name);
    }

    if (deliverable.length > 0) {
      // Fire and forget. Sink behaviour cannot influence the response below.
      this.options.dispatcher.dispatch({
        contract_version: validation.contract_version,
        received_at: new Date(nowMs).toISOString(),
        app: validation.app,
        events: deliverable,
      });
    }

    metrics.telemetryRequests.increment('accepted');

    const rejected = validation.outcomes.filter(
      outcome => outcome.status === EVENT_STATUS.REJECTED,
    ).length;

    return {
      statusCode: 202,
      body: {
        contract_version: TELEMETRY_CONTRACT_VERSION,
        received: validation.outcomes.length,
        accepted: deliverable.length,
        rejected,
        duplicates,
        results: validation.outcomes,
      },
    };
  }
}
