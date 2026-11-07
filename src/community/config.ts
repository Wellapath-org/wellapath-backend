/**
 * Community configuration (ADR-001 + amendments A1–A4, COMMUNITY_API_CONTRACT v1.0-draft).
 *
 * Deliberately separate from `src/config/env.ts`: nothing here is read unless `COMMUNITY_MODE`
 * names an enabled mode, so the default deployment (`COMMUNITY_MODE` unset → `disabled`) reads
 * no Community variable, opens no pool and registers no Community or auth route. The existing
 * `DATABASE_ENABLED` / `DB_*` semantics are untouched; Community uses its own
 * `COMMUNITY_DATABASE_URL` and never the artifact/ops database.
 */
import { assertVerifyFull } from './db-url';
import type { LimitOverrides } from './limiter';

export const COMMUNITY_MODES = ['disabled', 'internal', 'closed_beta', 'public'] as const;
export type CommunityMode = (typeof COMMUNITY_MODES)[number];

export type EmailSinkKind = 'outbox-file' | 'memory';

export interface VersionedSecret {
  version: number;
  value: string;
}

export interface SessionLifetimes {
  /** Seconds from sign-in. */
  absoluteSeconds: number;
  /** Seconds since the last refresh. */
  idleSeconds: number;
}

export interface CommunityEnabledConfig {
  mode: Exclude<CommunityMode, 'disabled'>;
  databaseUrl: string;
  /**
   * Better Auth secrets, newest first (`BETTER_AUTH_SECRETS="2:…,1:…"`). Versioned from day one
   * (PoC P4): they encrypt the JWKS private key and every TOTP secret.
   */
  authSecrets: VersionedSecret[];
  /**
   * Refresh-token peppers, newest first (`COMMUNITY_REFRESH_PEPPERS="1:…"`). Refresh tokens are
   * stored as HMAC-SHA-256(pepper_vN, token). Distinct from every auth secret.
   */
  refreshPeppers: VersionedSecret[];
  /** Public base URL of this service, used by Better Auth for origin checks. */
  baseUrl: string;
  /** Account ids allowed to use Community in `internal` / `closed_beta`. */
  allowlist: Set<string>;
  emailSink: EmailSinkKind;
  /** Directory for the test-only outbox file sink. */
  emailOutboxDir?: string;
  /** Access-token (JWT) lifetime, seconds. Contract: ≤ 900. */
  accessTokenTtlSeconds: number;
  memberLifetimes: SessionLifetimes;
  privilegedLifetimes: SessionLifetimes;
  /** How long a TOTP step-up stays valid for privileged actions, seconds (contract: 12 h). */
  stepUpTtlSeconds: number;
  /** Minimum response time of `POST /v1/auth/otp/request`, so the outcome is not observable. */
  otpRequestMinMs: number;
  /** Test-only overrides of the limits in `limiter.ts`. Never read from the environment. */
  limitOverrides?: LimitOverrides;
}

export type CommunityConfig = { mode: 'disabled' } | CommunityEnabledConfig;

type Env = Record<string, string | undefined>;

const required = (env: Env, key: string): string => {
  const value = env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
};

const int = (env: Env, key: string, fallback: number, min: number, max: number): number => {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!/^\d+$/.test(raw) || !Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`Invalid value for ${key}: expected an integer in [${min}, ${max}]`);
  }
  return parsed;
};

/**
 * Parses `"<version>:<secret>,<version>:<secret>"`, newest (highest version) first. Values are
 * never echoed in errors.
 */
export const parseVersionedSecrets = (raw: string, key: string): VersionedSecret[] => {
  const entries = raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map((entry, index) => {
      const colon = entry.indexOf(':');
      const version = Number.parseInt(entry.slice(0, colon), 10);
      const value = entry.slice(colon + 1);
      if (colon <= 0 || !/^\d+$/.test(entry.slice(0, colon)) || !value) {
        throw new Error(
          `Invalid ${key} entry at position ${index + 1}: expected <version>:<secret>`,
        );
      }
      if (value.length < 32) throw new Error(`${key} secrets must be at least 32 characters`);
      return { version, value };
    });
  if (entries.length === 0) throw new Error(`${key} must contain at least one entry`);
  if (new Set(entries.map(e => e.version)).size !== entries.length) {
    throw new Error(`${key} has duplicate versions`);
  }
  return entries.sort((a, b) => b.version - a.version);
};

/** Parses `COMMUNITY_MODE`. A typo refuses to boot rather than silently enabling anything. */
export const parseCommunityMode = (raw: string | undefined): CommunityMode => {
  if (raw === undefined || raw === '') return 'disabled';
  const normalized = raw.toLowerCase();
  if ((COMMUNITY_MODES as readonly string[]).includes(normalized)) {
    return normalized as CommunityMode;
  }
  // The value is not echoed, matching `strictBoolEnv` in src/config/env.ts.
  throw new Error(
    `Invalid value for COMMUNITY_MODE: expected one of ${COMMUNITY_MODES.join(', ')}`,
  );
};

const HOUR = 60 * 60;
const DAY = 24 * HOUR;

export const DEFAULT_MEMBER_LIFETIMES: SessionLifetimes = {
  absoluteSeconds: 30 * DAY,
  idleSeconds: 7 * DAY,
};
export const DEFAULT_PRIVILEGED_LIFETIMES: SessionLifetimes = {
  absoluteSeconds: 12 * HOUR,
  idleSeconds: HOUR,
};

export const loadCommunityConfig = (env: Env = process.env): CommunityConfig => {
  const mode = parseCommunityMode(env.COMMUNITY_MODE);
  if (mode === 'disabled') return { mode };

  const nodeEnv = env.NODE_ENV ?? 'development';
  const emailSinkRaw = env.COMMUNITY_EMAIL_SINK ?? 'outbox-file';
  if (emailSinkRaw !== 'outbox-file' && emailSinkRaw !== 'memory') {
    throw new Error('Invalid value for COMMUNITY_EMAIL_SINK: expected outbox-file or memory');
  }
  // No real email provider (Resend) is wired yet. The outbox sinks write OTPs somewhere a test
  // can read them, which must never happen in production.
  if (nodeEnv === 'production') {
    throw new Error(
      'COMMUNITY_MODE is enabled with NODE_ENV=production, but only test email sinks exist. Refusing to boot.',
    );
  }

  let authSecrets: VersionedSecret[];
  if (env.BETTER_AUTH_SECRETS) {
    authSecrets = parseVersionedSecrets(env.BETTER_AUTH_SECRETS, 'BETTER_AUTH_SECRETS');
  } else {
    const single = required(env, 'BETTER_AUTH_SECRET');
    if (single.length < 32) throw new Error('BETTER_AUTH_SECRET must be at least 32 characters');
    authSecrets = [{ version: 1, value: single }];
  }
  const refreshPeppers = parseVersionedSecrets(
    required(env, 'COMMUNITY_REFRESH_PEPPERS'),
    'COMMUNITY_REFRESH_PEPPERS',
  );
  const authValues = new Set(authSecrets.map(s => s.value));
  if (refreshPeppers.some(p => authValues.has(p.value))) {
    throw new Error('COMMUNITY_REFRESH_PEPPERS must be distinct from the Better Auth secrets');
  }

  return {
    mode,
    // B5: a non-local runtime URL without an explicit sslmode=verify-full refuses to boot.
    databaseUrl: assertVerifyFull(
      required(env, 'COMMUNITY_DATABASE_URL'),
      'COMMUNITY_DATABASE_URL',
    ),
    authSecrets,
    refreshPeppers,
    baseUrl: env.COMMUNITY_BASE_URL ?? `http://localhost:${env.PORT ?? '3000'}`,
    allowlist: new Set(
      (env.COMMUNITY_ALLOWLIST ?? '')
        .split(',')
        .map(id => id.trim())
        .filter(Boolean),
    ),
    emailSink: emailSinkRaw,
    emailOutboxDir: env.COMMUNITY_EMAIL_OUTBOX_DIR,
    accessTokenTtlSeconds: int(env, 'COMMUNITY_ACCESS_TOKEN_TTL_SECONDS', 900, 1, 900),
    memberLifetimes: DEFAULT_MEMBER_LIFETIMES,
    privilegedLifetimes: DEFAULT_PRIVILEGED_LIFETIMES,
    stepUpTtlSeconds: int(env, 'COMMUNITY_STEP_UP_TTL_SECONDS', 12 * HOUR, 1, 12 * HOUR),
    otpRequestMinMs: int(env, 'COMMUNITY_OTP_REQUEST_MIN_MS', 400, 0, 5000),
  };
};
