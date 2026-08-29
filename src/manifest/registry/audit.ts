/**
 * Audit event contract v1 — append-only, deterministic, and redacted by construction.
 *
 * Every registry transition emits exactly one event, whether it succeeded or not. Events bind the
 * revision they moved the registry from and to, so a reader can prove the chain is continuous and
 * that nothing was inserted or dropped. Event ids are derived from the event's own content rather
 * than generated randomly, so the same inputs always produce the same audit trail — a test can
 * assert on it, and two replays cannot silently differ.
 *
 * What an event must never carry: a URL with credentials, a token, a key, a secret, raw artifact
 * bytes, or sensitive configuration. That is enforced here by `findSensitiveData`, not left to the
 * discipline of whoever adds the next event type.
 *
 * Nothing in this module writes anywhere. `logger` is deliberately not imported: these are records
 * to be returned and asserted on, not runtime logs.
 */
import { createHash } from 'crypto';
import { Environment } from '../contract';
import {
  AnyReasonCode,
  ArtifactIdentity,
  IngestionOperation,
  PipelineStage,
} from '../ingestion/contract';

export const AUDIT_EVENT_VERSION = '1.0.0';

export type AuditEventType =
  | 'envelope_received'
  | 'rejection'
  | 'staging'
  | 'publication'
  | 'activation'
  | 'rollback'
  | 'idempotent_replay'
  | 'conflict';

export const AUDIT_EVENT_TYPES: readonly AuditEventType[] = [
  'envelope_received',
  'rejection',
  'staging',
  'publication',
  'activation',
  'rollback',
  'idempotent_replay',
  'conflict',
];

export type AuditOutcome = 'accepted' | 'refused' | 'no_op';

/**
 * The authority a transition is attributed to.
 *
 * `actor_ref` is a reference to a recorded decision or an operator identity — never a person's
 * name, credential or contact detail.
 */
export interface AuditAuthority {
  actor_ref: string;
  publication_decision_ref: string | null;
  activation_decision_ref: string | null;
  rollback_decision_ref: string | null;
}

export interface AuditEvent {
  event_version: string;
  event_id: string;
  event_type: AuditEventType;
  /** Registry revision before the attempt, and after it. Equal when nothing changed. */
  prior_revision: number;
  resulting_revision: number;
  environment: Environment;
  operation: IngestionOperation | null;
  /** Identity acted on. Digest included: an audit trail that cannot identify content is useless. */
  identity: ArtifactIdentity | null;
  authority: AuditAuthority;
  outcome: AuditOutcome;
  /** Stage the outcome was decided at, for refusals. */
  stage: PipelineStage | null;
  reason_codes: AnyReasonCode[];
  /** Correlation key: the envelope's idempotency key. */
  correlation_key: string;
  occurred_at: string;
}

/** Keys whose presence in an audit payload is a leak regardless of value. */
const FORBIDDEN_KEY_PATTERN =
  /(password|secret|token|credential|api[_-]?key|authorization|cookie|session|private[_-]?key|bytes|payload|body|content)/i;

/** Values that look like credentials, bearer tokens, presigned URLs or raw content. */
const FORBIDDEN_VALUE_PATTERNS: { pattern: RegExp; what: string }[] = [
  { pattern: /https?:\/\/[^/\s]*:[^/@\s]*@/i, what: 'URL with embedded credentials' },
  {
    pattern: /[?&](x-amz-signature|signature|sig|token|access[_-]?key)=/i,
    what: 'signed or tokenised URL',
  },
  { pattern: /\bBearer\s+[A-Za-z0-9._-]{8,}/i, what: 'bearer token' },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, what: 'private key material' },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/, what: 'AWS access key id' },
  { pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, what: 'JWT' },
];

export interface SensitiveFinding {
  path: string;
  what: string;
}

/**
 * Scans an audit event (or any candidate payload) for data that must never be recorded.
 *
 * Returns every finding rather than the first, so a reviewer sees the whole problem. An empty
 * result is the only acceptable state for an emitted event.
 */
export const findSensitiveData = (value: unknown, path = 'event'): SensitiveFinding[] => {
  const findings: SensitiveFinding[] = [];

  const walk = (node: unknown, at: string): void => {
    if (typeof node === 'string') {
      for (const { pattern, what } of FORBIDDEN_VALUE_PATTERNS) {
        if (pattern.test(node)) findings.push({ path: at, what });
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((entry, index) => walk(entry, `${at}[${index}]`));
      return;
    }
    if (node !== null && typeof node === 'object') {
      for (const [key, entry] of Object.entries(node as Record<string, unknown>)) {
        if (FORBIDDEN_KEY_PATTERN.test(key)) {
          findings.push({ path: `${at}.${key}`, what: `forbidden field name '${key}'` });
        }
        walk(entry, `${at}.${key}`);
      }
    }
  };

  walk(value, path);
  return findings;
};

/** Canonical JSON: keys sorted recursively, no whitespace. Used for ids and replay digests. */
export const canonicalize = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};

/** Content-derived event id: same event content always yields the same id. */
export const deriveEventId = (event: Omit<AuditEvent, 'event_id'>): string =>
  `evt_${createHash('sha256').update(canonicalize(event)).digest('hex').slice(0, 32)}`;

/**
 * Builds an audit event and refuses to produce one carrying sensitive data.
 *
 * The refusal is deliberate: an audit trail that can leak is worse than none, because it is
 * trusted. A caller that trips this has a bug in what it passed, not in the audit contract.
 */
export const buildAuditEvent = (
  draft: Omit<AuditEvent, 'event_id' | 'event_version'>,
): AuditEvent => {
  const withVersion = { ...draft, event_version: AUDIT_EVENT_VERSION };
  const findings = findSensitiveData(withVersion);
  if (findings.length > 0) {
    throw new Error(
      `refusing to emit an audit event carrying sensitive data: ${findings
        .map(finding => `${finding.path} (${finding.what})`)
        .join('; ')}`,
    );
  }
  return { ...withVersion, event_id: deriveEventId(withVersion) };
};
