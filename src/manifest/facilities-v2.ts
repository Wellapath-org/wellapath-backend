/**
 * Facilities 2.0 distribution gate — optional, default-off, fail-closed.
 *
 * This module decides, once at startup, whether `GET /config` may carry an OPTIONAL
 * `facilities_v2` manifest entry describing a *future* facilities 2.x artifact. It exists so
 * that Mobile PR #79's consumer has a backend contract to eventually activate against, without
 * anything changing today:
 *
 *   - Every gate defaults to false or absent. With no configuration, `/config` is byte-identical
 *     to the frozen distribution baseline and `facilities` v1.1 remains the only facilities
 *     artifact served.
 *   - The real Facilities 2.0 candidate is `candidate_unapproved` with `may_publish: false`.
 *     A declaration that truthfully describes it fails the gates on BOTH of those fields
 *     independently — no environment-variable combination can expose it.
 *   - A declaration that is enabled but invalid is REFUSED, never repaired, defaulted or
 *     downgraded into an approved one, and the refusal cannot affect v1.1: `/config` keeps
 *     serving exactly the current response.
 *
 * Refusal reasons carry a code and a field name only — never the offending value, which for a
 * misconfigured deployment could be a secret pasted into the wrong variable.
 *
 * See `docs/FACILITIES_V2_DISTRIBUTION.md` for the contract, the activation preconditions and
 * the rollback procedure. Activation itself remains gated on the authorizations listed in
 * `docs/INGESTION_AND_REGISTRY.md` §§11–13; nothing here grants or implies any of them.
 */
import { APPROVED_ARTIFACT_ORIGINS, OBJECT_KEY_PATTERN } from './origin';
import { SHA256_PATTERN } from './integrity';

/** The only facilities content-schema major version this contract will describe. */
export const SUPPORTED_FACILITIES_V2_SCHEMA_MAJORS: readonly number[] = [2];

/** The artifact line this gate may ever describe. Anything else is a line mismatch. */
export const FACILITIES_ARTIFACT_ID = 'facilities';

/** The only publication status that can pass the gate. `candidate_unapproved` never does. */
export const APPROVED_STATUS = 'approved';

/** Dotted numeric version, e.g. `2.0`. Anything else is structurally invalid. */
export const VERSION_PATTERN = /^\d+(\.\d+)*$/;

/**
 * Raw environment declaration, exactly as configured. Parsing keeps raw strings for the fields
 * whose values must match EXACTLY (`status`, `may_publish`) so that validation — not parsing —
 * is the single place where meaning is assigned, and nothing lenient can creep in between.
 */
export interface FacilitiesV2Declaration {
  /** `FACILITIES_V2_DISTRIBUTION_ENABLED` — master switch. Default false. */
  enabled: boolean;
  /** `FACILITIES_V2_PRODUCTION_APPROVED` — separate production gate. Default false. */
  productionApproved: boolean;
  /** `FACILITIES_V2_ARTIFACT_VERSION` — e.g. `2.0`. Default absent. */
  artifactVersion?: string;
  /** `FACILITIES_V2_SCHEMA_VERSION` — content-schema version, major must be supported. */
  schemaVersion?: string;
  /** `FACILITIES_V2_URL` — full HTTPS URL on an approved artifact origin. */
  url?: string;
  /** `FACILITIES_V2_SHA256` — `sha256:<64 hex>` over the exact artifact bytes. */
  sha256?: string;
  /** `FACILITIES_V2_BYTE_COUNT` — decimal byte count of the exact artifact bytes. */
  byteCount?: string;
  /** `FACILITIES_V2_STATUS` — must be exactly `approved` to pass. */
  status?: string;
  /** `FACILITIES_V2_MAY_PUBLISH` — must be exactly `true` to pass. */
  mayPublish?: string;
  /** `FACILITIES_V2_SOURCE_VERSION` — optional upstream source/provenance version. */
  sourceVersion?: string;
  /** `FACILITIES_V2_PUBLICATION_DECISION_REF` — required authorization marker. */
  publicationDecisionRef?: string;
}

/** Closed set of machine-readable refusal reasons. Logged as codes, never with values. */
export const FACILITIES_V2_REASON_CODES = [
  'V2_NOT_ENABLED',
  'STATUS_NOT_APPROVED',
  'PUBLICATION_NOT_AUTHORIZED',
  'SCHEMA_MAJOR_UNSUPPORTED',
  'ARTIFACT_VERSION_INVALID',
  'SHA256_INVALID',
  'BYTE_COUNT_INVALID',
  'URL_INVALID',
  'URL_NOT_HTTPS',
  'URL_HAS_CREDENTIALS',
  'URL_HAS_QUERY',
  'ORIGIN_NOT_APPROVED',
  'OBJECT_KEY_INVALID',
  'ARTIFACT_LINE_MISMATCH',
  'AUTHORIZATION_MARKER_MISSING',
  'PRODUCTION_NOT_APPROVED',
] as const;

export type FacilitiesV2ReasonCode = (typeof FACILITIES_V2_REASON_CODES)[number];

/**
 * One refusal. Deliberately value-free: `field` names the environment variable that failed and
 * `detail` describes the rule, so a refusal can be diagnosed from logs without the logs ever
 * carrying whatever was actually configured there.
 */
export interface FacilitiesV2Reason {
  code: FacilitiesV2ReasonCode;
  field: string;
  detail: string;
}

/**
 * The optional `/config` entry, produced ONLY when every gate passes. Field names match what
 * the Mobile consumer (`FacilitiesV2Manifest.tryParse`, Mobile PR #79) reads: top-level
 * `schema_version` plus an `artifact` object with `version`, `status`, `may_publish`, `url`
 * and `sha256`. Extra fields are informational and ignored by that parser.
 */
export interface FacilitiesV2Exposure {
  schema_version: string;
  artifact: {
    artifact_id: string;
    version: string;
    status: string;
    may_publish: boolean;
    url: string;
    sha256: string;
    byte_count: number;
    country: string;
    publication_decision_ref: string;
    source_version?: string;
  };
}

export interface FacilitiesV2Resolution {
  /** Non-null ONLY when every gate passed. Null means `/config` serves v1.1 alone. */
  exposure: FacilitiesV2Exposure | null;
  /** Every reason the declaration was refused. Empty only when `exposure` is non-null. */
  reasons: FacilitiesV2Reason[];
}

/**
 * Reads the declaration from an environment map. Absent and empty values stay absent; the two
 * boolean gates are true ONLY for the exact lowercase-insensitive string `true`, matching the
 * repository's `boolEnv` convention — any other value, including typos, means false.
 */
export const parseFacilitiesV2Env = (env: NodeJS.ProcessEnv): FacilitiesV2Declaration => {
  const read = (key: string): string | undefined => {
    const value = env[key];
    return value === undefined || value === '' ? undefined : value;
  };
  const readBool = (key: string): boolean => read(key)?.toLowerCase() === 'true';

  return {
    enabled: readBool('FACILITIES_V2_DISTRIBUTION_ENABLED'),
    productionApproved: readBool('FACILITIES_V2_PRODUCTION_APPROVED'),
    artifactVersion: read('FACILITIES_V2_ARTIFACT_VERSION'),
    schemaVersion: read('FACILITIES_V2_SCHEMA_VERSION'),
    url: read('FACILITIES_V2_URL'),
    sha256: read('FACILITIES_V2_SHA256'),
    byteCount: read('FACILITIES_V2_BYTE_COUNT'),
    status: read('FACILITIES_V2_STATUS'),
    mayPublish: read('FACILITIES_V2_MAY_PUBLISH'),
    sourceVersion: read('FACILITIES_V2_SOURCE_VERSION'),
    publicationDecisionRef: read('FACILITIES_V2_PUBLICATION_DECISION_REF'),
  };
};

const majorOf = (version: string): number => Number.parseInt(version.split('.')[0], 10);

/**
 * Evaluates every gate and either produces the exposure or refuses with the complete reason
 * list. All gates are checked unconditionally — the current candidate must be seen to fail on
 * `status` AND `may_publish` independently, not merely on whichever check runs first.
 *
 * This runs once at startup. A refusal is final for the process: there is no retry, no partial
 * exposure and no fallback other than the unchanged v1.1 response.
 */
export const resolveFacilitiesV2 = (
  declaration: FacilitiesV2Declaration,
  environment: string,
): FacilitiesV2Resolution => {
  const reasons: FacilitiesV2Reason[] = [];

  if (!declaration.enabled) {
    reasons.push({
      code: 'V2_NOT_ENABLED',
      field: 'FACILITIES_V2_DISTRIBUTION_ENABLED',
      detail: 'facilities v2 distribution is not explicitly enabled',
    });
  }

  // The two independent governance fields. Exact literal matches only: `candidate_unapproved`,
  // `Approved`, `TRUE`, `1`, `yes` and every other variant all refuse.
  if (declaration.status !== APPROVED_STATUS) {
    reasons.push({
      code: 'STATUS_NOT_APPROVED',
      field: 'FACILITIES_V2_STATUS',
      detail: `publication status is not exactly '${APPROVED_STATUS}'; a candidate is never exposed`,
    });
  }
  if (declaration.mayPublish !== 'true') {
    reasons.push({
      code: 'PUBLICATION_NOT_AUTHORIZED',
      field: 'FACILITIES_V2_MAY_PUBLISH',
      detail: "may_publish is not exactly 'true'; the source has not authorized publication",
    });
  }

  const schemaVersion = declaration.schemaVersion;
  if (
    schemaVersion === undefined ||
    !VERSION_PATTERN.test(schemaVersion) ||
    !SUPPORTED_FACILITIES_V2_SCHEMA_MAJORS.includes(majorOf(schemaVersion))
  ) {
    reasons.push({
      code: 'SCHEMA_MAJOR_UNSUPPORTED',
      field: 'FACILITIES_V2_SCHEMA_VERSION',
      detail: `schema version is absent, malformed or outside the supported majors [${SUPPORTED_FACILITIES_V2_SCHEMA_MAJORS.join(', ')}]`,
    });
  }

  const artifactVersion = declaration.artifactVersion;
  if (
    artifactVersion === undefined ||
    !VERSION_PATTERN.test(artifactVersion) ||
    !SUPPORTED_FACILITIES_V2_SCHEMA_MAJORS.includes(majorOf(artifactVersion))
  ) {
    reasons.push({
      code: 'ARTIFACT_VERSION_INVALID',
      field: 'FACILITIES_V2_ARTIFACT_VERSION',
      detail: 'artifact version is absent, malformed or not a 2.x version',
    });
  }

  if (declaration.sha256 === undefined || !SHA256_PATTERN.test(declaration.sha256)) {
    reasons.push({
      code: 'SHA256_INVALID',
      field: 'FACILITIES_V2_SHA256',
      detail: 'sha256 is absent or not a sha256:<64 hex> digest',
    });
  }

  let byteCount: number | null = null;
  if (declaration.byteCount !== undefined && /^\d+$/.test(declaration.byteCount)) {
    const parsed = Number.parseInt(declaration.byteCount, 10);
    if (Number.isSafeInteger(parsed) && parsed > 0) byteCount = parsed;
  }
  if (byteCount === null) {
    reasons.push({
      code: 'BYTE_COUNT_INVALID',
      field: 'FACILITIES_V2_BYTE_COUNT',
      detail: 'byte count is absent or not a positive decimal integer',
    });
  }

  // Transport policy — the same rules `src/manifest/origin.ts` enforces for the manifest
  // contract, sharing its origin allowlist and object-key convention so an origin can never be
  // approved for one surface and not the other. Arbitrary external URLs cannot pass.
  let country: string | null = null;
  const url = declaration.url;
  if (url === undefined) {
    reasons.push({
      code: 'URL_INVALID',
      field: 'FACILITIES_V2_URL',
      detail: 'artifact url is absent',
    });
  } else {
    let parsed: URL | null = null;
    try {
      parsed = new URL(url);
    } catch {
      reasons.push({
        code: 'URL_INVALID',
        field: 'FACILITIES_V2_URL',
        detail: 'artifact url is not parseable',
      });
    }
    if (parsed !== null) {
      if (parsed.protocol !== 'https:') {
        reasons.push({
          code: 'URL_NOT_HTTPS',
          field: 'FACILITIES_V2_URL',
          detail: 'artifact url is not https',
        });
      }
      if (parsed.username !== '' || parsed.password !== '') {
        reasons.push({
          code: 'URL_HAS_CREDENTIALS',
          field: 'FACILITIES_V2_URL',
          detail: 'artifact url embeds credentials; credentials are never permitted',
        });
      }
      if (parsed.search !== '' || parsed.hash !== '') {
        reasons.push({
          code: 'URL_HAS_QUERY',
          field: 'FACILITIES_V2_URL',
          detail: 'artifact url carries a query string or fragment; immutable objects take none',
        });
      }
      if (!APPROVED_ARTIFACT_ORIGINS.includes(parsed.origin)) {
        reasons.push({
          code: 'ORIGIN_NOT_APPROVED',
          field: 'FACILITIES_V2_URL',
          detail: 'artifact url origin is not on the approved artifact-origin allowlist',
        });
      } else {
        const objectKey = parsed.pathname.replace(/^\//, '');
        if (!OBJECT_KEY_PATTERN.test(objectKey)) {
          reasons.push({
            code: 'OBJECT_KEY_INVALID',
            field: 'FACILITIES_V2_URL',
            detail: 'artifact url does not resolve to an immutable object key at the bucket root',
          });
        } else {
          const [artifactPart, countryPart] = objectKey.split('.');
          if (artifactPart !== FACILITIES_ARTIFACT_ID) {
            reasons.push({
              code: 'ARTIFACT_LINE_MISMATCH',
              field: 'FACILITIES_V2_URL',
              detail: `object key does not belong to the '${FACILITIES_ARTIFACT_ID}' artifact line`,
            });
          } else {
            country = countryPart;
          }
        }
      }
    }
  }

  const marker = declaration.publicationDecisionRef;
  if (marker === undefined || marker.trim() === '') {
    reasons.push({
      code: 'AUTHORIZATION_MARKER_MISSING',
      field: 'FACILITIES_V2_PUBLICATION_DECISION_REF',
      detail: 'no publication decision reference is recorded; unauthorized publication is refused',
    });
  }

  if (environment === 'production' && !declaration.productionApproved) {
    reasons.push({
      code: 'PRODUCTION_NOT_APPROVED',
      field: 'FACILITIES_V2_PRODUCTION_APPROVED',
      detail: 'production exposure requires its own explicit approval gate',
    });
  }

  if (reasons.length > 0) {
    return { exposure: null, reasons };
  }

  return {
    exposure: {
      schema_version: schemaVersion as string,
      artifact: {
        artifact_id: FACILITIES_ARTIFACT_ID,
        version: artifactVersion as string,
        status: APPROVED_STATUS,
        may_publish: true,
        url: url as string,
        sha256: declaration.sha256 as string,
        byte_count: byteCount as number,
        country: country as string,
        publication_decision_ref: (marker as string).trim(),
        ...(declaration.sourceVersion !== undefined
          ? { source_version: declaration.sourceVersion }
          : {}),
      },
    },
    reasons: [],
  };
};
