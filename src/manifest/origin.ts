/**
 * Origin and transport policy for artifact delivery.
 *
 * Artifacts may only ever be represented by an immutable object key on an approved origin.
 * Arbitrary external URLs, plain HTTP, embedded credentials and query strings are all rejected
 * outright — a query string is refused entirely rather than scanned for "secrets", because the
 * safe set of query parameters for an immutable public object is empty.
 *
 * Integrity is verified from the descriptor's own sha256/byte_count (`integrity.ts`),
 * independent of anything the transport claims.
 */
import { Reason } from './contract';

/**
 * Origins artifacts may be served from. The R2 public development domain is already public in
 * the repository (tests, docs, `.env.example`) — listing it here exposes nothing new.
 */
export const APPROVED_ARTIFACT_ORIGINS: readonly string[] = [
  'https://pub-8bc2ba0d7e7647799d89662d70f23c45.r2.dev',
];

/**
 * Immutable object-key convention already in use on R2: `<artifact>.<country>.v<version>.json`,
 * flat at the bucket root (e.g. `kb.ng.v2.4.json`). A key is never reused for changed content.
 */
export const OBJECT_KEY_PATTERN = /^[a-z0-9_]+\.[a-z]{2}\.v\d+(\.\d+)*\.json$/;

export const validateObjectKey = (objectKey: string, path: string): Reason[] => {
  if (!OBJECT_KEY_PATTERN.test(objectKey)) {
    return [
      {
        code: 'OBJECT_KEY_INVALID',
        path,
        detail: `object key does not match the immutable naming convention: ${objectKey}`,
      },
    ];
  }
  return [];
};

/**
 * Validates a full artifact URL against the transport policy. The URL must be HTTPS, on an
 * approved origin, carry no credentials, no query string and no fragment, and resolve to
 * exactly the descriptor's object key.
 */
export const validateArtifactUrl = (url: string, objectKey: string, path: string): Reason[] => {
  const reasons: Reason[] = [];

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [{ code: 'MALFORMED_FIELD', path, detail: 'url is not parseable' }];
  }

  if (parsed.protocol !== 'https:') {
    reasons.push({ code: 'ORIGIN_NOT_HTTPS', path, detail: `protocol ${parsed.protocol} refused` });
  }
  if (parsed.username !== '' || parsed.password !== '') {
    reasons.push({
      code: 'ORIGIN_HAS_CREDENTIALS',
      path,
      detail: 'url embeds credentials; credentials are never permitted in a manifest',
    });
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    reasons.push({
      code: 'ORIGIN_HAS_QUERY',
      path,
      detail: 'url carries a query string or fragment; immutable objects take no parameters',
    });
  }
  if (!APPROVED_ARTIFACT_ORIGINS.includes(parsed.origin)) {
    reasons.push({
      code: 'ORIGIN_NOT_APPROVED',
      path,
      detail: `origin ${parsed.origin} is not an approved artifact origin`,
    });
  } else if (parsed.pathname !== `/${objectKey}`) {
    reasons.push({
      code: 'ORIGIN_NOT_APPROVED',
      path,
      detail: `url path ${parsed.pathname} does not resolve to the declared object key`,
    });
  }

  return reasons;
};
