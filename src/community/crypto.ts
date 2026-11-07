/**
 * Keyed hashing for Community (contract §3.2, §4.1).
 *
 * - Refresh tokens: `wprt_` + 256-bit random base64url. Stored only as
 *   HMAC-SHA-256(pepper_vN, token); `pepper_version` is stored beside the hash so a pepper can be
 *   rotated without signing every device out.
 * - Email / IP / bucket keys: HMAC with a sub-key derived (HKDF) from the current pepper, so the
 *   audit log and the limiter never hold a plaintext email or IP.
 */
import { createHmac, hkdfSync, randomBytes } from 'crypto';
import { VersionedSecret } from './config';

export const REFRESH_TOKEN_PREFIX = 'wprt_';

export const newRefreshToken = (): string =>
  `${REFRESH_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;

export class Hasher {
  private readonly lookupKey: Buffer;

  constructor(private readonly peppers: VersionedSecret[]) {
    if (peppers.length === 0) throw new Error('At least one refresh pepper is required');
    // Lookup HMACs (email, IP, buckets) stay stable across pepper rotation by deriving from the
    // OLDEST pepper; refresh-token hashes use the newest and record their version.
    const oldest = peppers[peppers.length - 1];
    this.lookupKey = Buffer.from(
      hkdfSync('sha256', oldest.value, 'wellapath-community', 'lookup-hmac-v1', 32),
    );
  }

  get currentPepperVersion(): number {
    return this.peppers[0].version;
  }

  /** HMAC of a refresh token under the given (default: current) pepper version. */
  refreshHash(token: string, version = this.peppers[0].version): string | undefined {
    const pepper = this.peppers.find(p => p.version === version);
    if (!pepper) return undefined;
    return createHmac('sha256', pepper.value).update(token).digest('base64url');
  }

  /** Every (version, hash) candidate for a presented token, newest pepper first. */
  refreshHashCandidates(token: string): { version: number; hash: string }[] {
    return this.peppers.map(p => ({
      version: p.version,
      hash: createHmac('sha256', p.value).update(token).digest('base64url'),
    }));
  }

  /** Keyed lookup hash for an email, IP or limiter bucket component. */
  lookup(kind: string, value: string): string {
    return createHmac('sha256', this.lookupKey).update(`${kind}\u0000${value}`).digest('base64url');
  }
}

/**
 * Normalised email for the per-email limit and audit key (contract §4.1 item 4). The account's
 * stored email is only lower-cased; this key is stricter so case, `+tag` and Gmail dots cannot be
 * used to bypass a limit.
 */
export const normaliseEmail = (email: string): string => {
  const lowered = email.normalize('NFKC').trim().toLowerCase();
  const at = lowered.lastIndexOf('@');
  if (at <= 0) return lowered;
  let local = lowered.slice(0, at);
  let domain = lowered.slice(at + 1);
  const plus = local.indexOf('+');
  if (plus >= 0) local = local.slice(0, plus);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return `${local}@${domain}`;
};
