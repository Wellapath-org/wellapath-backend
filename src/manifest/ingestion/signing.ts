/**
 * Attestation policy — a recorded gap, not an implementation.
 *
 * There is no signing algorithm, no trusted key source, no custody model, no rotation process and
 * no verification policy approved for this system. None of those is invented here. The honest
 * consequence is that any production-like ingestion **fails closed** with
 * `SIGNATURE_POLICY_UNAVAILABLE`, and will keep failing until each of those five things is
 * separately decided and recorded.
 *
 * What this module must never do, and does not do:
 *   - ship a placeholder production key, or any key material at all;
 *   - read a trust mode, key, or bypass from `process.env` or any other ambient source;
 *   - describe unsigned input as verified;
 *   - emit a verification receipt that could be mistaken for an operative one.
 *
 * The test-only trust mode exists solely so the rest of the pipeline can be exercised. It is a
 * function argument, never ambient state; it is refused outside `development`; it requires the
 * envelope to declare itself synthetic; and the receipt it produces is explicitly marked
 * non-operative.
 */
import { Environment } from '../contract';
import {
  EnvelopeAttestation,
  IngestionEnvelope,
  StageReason,
  TRUST_MODES,
  TrustMode,
} from './contract';

/**
 * Environments in which the synthetic test-only trust mode may ever be considered. Staging, beta
 * and production are excluded by construction, not by configuration.
 */
export const TEST_TRUST_MODE_ALLOWED_ENVIRONMENTS: readonly Environment[] = ['development'];

/**
 * A verification outcome. `operative` is the field that matters: it is `false` for every result
 * this module can currently produce, because no verification policy exists. A caller that treats
 * a non-operative receipt as proof of signature is misreading it, which is why the field is named
 * for what it is rather than for what a caller might hope.
 */
export interface AttestationResult {
  verified: boolean;
  operative: boolean;
  trust_mode: TrustMode | null;
  /** Human-readable statement of why this result is what it is. Never key material. */
  statement: string;
}

/** The only result a production path can currently get, and the reason it fails closed. */
export const SIGNING_POLICY_STATEMENT =
  'No signing algorithm, trusted key source, custody model, rotation process or verification ' +
  'policy has been approved for this system. Production-like ingestion therefore fails closed. ' +
  'This is a recorded gap, not a defect to be worked around.';

/**
 * Evaluates the attestation on an envelope.
 *
 * Returns the reasons ingestion must stop, plus the (never operative) result. An empty reason
 * list means only that the pipeline may continue in a synthetic test; it never means the artifact
 * was verified.
 */
export const evaluateAttestation = (
  envelope: IngestionEnvelope,
): { reasons: StageReason[]; result: AttestationResult } => {
  const attestation: EnvelopeAttestation | undefined = envelope.attestation;
  const path = 'envelope.attestation';

  if (attestation === null || typeof attestation !== 'object') {
    return {
      reasons: [
        {
          stage: 'integrity_verified',
          code: 'SIGNATURE_POLICY_UNAVAILABLE',
          path,
          detail: `attestation is absent; ${SIGNING_POLICY_STATEMENT}`,
        },
      ],
      result: {
        verified: false,
        operative: false,
        trust_mode: null,
        statement: SIGNING_POLICY_STATEMENT,
      },
    };
  }

  if (!(TRUST_MODES as readonly string[]).includes(attestation.trust_mode)) {
    return {
      reasons: [
        {
          stage: 'integrity_verified',
          code: 'TRUST_MODE_UNKNOWN',
          path: `${path}.trust_mode`,
          detail: `unknown trust mode ${String(attestation.trust_mode)}; unknown trust is never trust`,
        },
      ],
      result: {
        verified: false,
        operative: false,
        trust_mode: null,
        statement: 'unknown trust mode',
      },
    };
  }

  if (attestation.trust_mode === 'synthetic_test_only') {
    // Refused outside development, and refused for anything claiming to be a real artifact.
    if (!TEST_TRUST_MODE_ALLOWED_ENVIRONMENTS.includes(envelope.environment)) {
      return {
        reasons: [
          {
            stage: 'integrity_verified',
            code: 'TEST_TRUST_MODE_FORBIDDEN',
            path: `${path}.trust_mode`,
            detail: `the synthetic test-only trust mode is refused in ${envelope.environment}; it exists only to exercise the pipeline in development`,
          },
        ],
        result: {
          verified: false,
          operative: false,
          trust_mode: 'synthetic_test_only',
          statement: 'test-only trust mode is not valid in this environment',
        },
      };
    }
    if (envelope.synthetic !== true) {
      return {
        reasons: [
          {
            stage: 'integrity_verified',
            code: 'TEST_TRUST_MODE_FORBIDDEN',
            path: `${path}.trust_mode`,
            detail:
              'the synthetic test-only trust mode requires the envelope to declare synthetic: true; it must never be applied to an envelope claiming a real artifact',
          },
        ],
        result: {
          verified: false,
          operative: false,
          trust_mode: 'synthetic_test_only',
          statement: 'test-only trust mode requires a synthetic envelope',
        },
      };
    }
    return {
      reasons: [],
      result: {
        verified: false,
        operative: false,
        trust_mode: 'synthetic_test_only',
        statement:
          'NON-OPERATIVE: no signature was checked. This result exists to exercise the pipeline ' +
          'against synthetic fixtures and constitutes no verification of anything.',
      },
    };
  }

  // Production. There is nothing to verify with, so it fails closed — regardless of what the
  // producer claims about having signed it.
  return {
    reasons: [
      {
        stage: 'integrity_verified',
        code: 'SIGNATURE_POLICY_UNAVAILABLE',
        path: `${path}.trust_mode`,
        detail: SIGNING_POLICY_STATEMENT,
      },
    ],
    result: {
      verified: false,
      operative: false,
      trust_mode: 'production',
      statement: SIGNING_POLICY_STATEMENT,
    },
  };
};
