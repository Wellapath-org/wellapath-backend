/**
 * Content integrity verification, independent of transport.
 *
 * Whatever a CDN, ETag or Content-Length header claims, an artifact's bytes are only accepted
 * when they hash to the descriptor's declared sha256 AND match its declared byte count. Both
 * checks run unconditionally so a failure reports every mismatch, not just the first.
 */
import { createHash } from 'crypto';
import { ArtifactDescriptor, Reason } from './contract';

export const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** Computes the descriptor-format digest (`sha256:<hex>`) of a byte buffer. */
export const sha256OfBytes = (bytes: Buffer): string =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/**
 * Verifies fetched bytes against a descriptor. An empty result means the bytes are exactly the
 * object the descriptor names; any reason means the bytes must be discarded.
 */
export const verifyArtifactBytes = (bytes: Buffer, descriptor: ArtifactDescriptor): Reason[] => {
  const reasons: Reason[] = [];
  const path = `artifact ${descriptor.artifact_id}@${descriptor.artifact_version}`;

  if (!SHA256_PATTERN.test(descriptor.sha256)) {
    reasons.push({
      code: 'MALFORMED_FIELD',
      path: `${path}.sha256`,
      detail: 'declared sha256 is not a valid sha256:<64 hex> digest',
    });
  } else if (sha256OfBytes(bytes) !== descriptor.sha256) {
    reasons.push({
      code: 'HASH_MISMATCH',
      path: `${path}.sha256`,
      detail: 'fetched bytes do not hash to the declared sha256',
    });
  }

  if (bytes.byteLength !== descriptor.byte_count) {
    reasons.push({
      code: 'BYTE_COUNT_MISMATCH',
      path: `${path}.byte_count`,
      detail: `fetched ${bytes.byteLength} bytes, descriptor declares ${descriptor.byte_count}`,
    });
  }

  return reasons;
};
