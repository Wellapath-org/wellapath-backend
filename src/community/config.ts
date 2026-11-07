/**
 * Community configuration (PROOF OF CONCEPT — ADR-001).
 *
 * Deliberately separate from `src/config/env.ts`: nothing here is read unless `COMMUNITY_MODE`
 * names an enabled mode, so the default deployment (`COMMUNITY_MODE` unset → `disabled`) reads
 * no Community variable, opens no pool and registers no Community or auth route. The existing
 * `DATABASE_ENABLED` / `DB_*` semantics are untouched; Community uses its own
 * `COMMUNITY_DATABASE_URL` and never the artifact/ops database.
 */

export const COMMUNITY_MODES = ['disabled', 'internal', 'closed_beta', 'public'] as const;
export type CommunityMode = (typeof COMMUNITY_MODES)[number];

export type EmailSinkKind = 'outbox-file' | 'memory';

export interface CommunityEnabledConfig {
  mode: Exclude<CommunityMode, 'disabled'>;
  databaseUrl: string;
  /** Better Auth signing/encryption secret. Never logged, never committed. */
  authSecret: string;
  /** Public base URL of this service, used by Better Auth for origin checks. */
  baseUrl: string;
  /** Account ids allowed to use Community in `internal` / `closed_beta`. */
  allowlist: Set<string>;
  emailSink: EmailSinkKind;
  /** Directory for the test-only outbox file sink. */
  emailOutboxDir?: string;
  /** Access-token (JWT) lifetime, seconds. */
  accessTokenTtlSeconds: number;
  /** Session (refresh credential) lifetime, seconds. */
  sessionTtlSeconds: number;
  /** How long a TOTP step-up stays valid for privileged actions, seconds. */
  stepUpTtlSeconds: number;
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
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`Invalid value for ${key}: expected an integer in [${min}, ${max}]`);
  }
  return parsed;
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

export const loadCommunityConfig = (env: Env = process.env): CommunityConfig => {
  const mode = parseCommunityMode(env.COMMUNITY_MODE);
  if (mode === 'disabled') return { mode };

  const nodeEnv = env.NODE_ENV ?? 'development';
  const emailSinkRaw = env.COMMUNITY_EMAIL_SINK ?? 'outbox-file';
  if (emailSinkRaw !== 'outbox-file' && emailSinkRaw !== 'memory') {
    throw new Error('Invalid value for COMMUNITY_EMAIL_SINK: expected outbox-file or memory');
  }
  // The PoC has no real email provider wired. The outbox sinks write OTPs somewhere a test can
  // read them, which must never happen in production.
  if (nodeEnv === 'production') {
    throw new Error(
      'COMMUNITY_MODE is enabled with NODE_ENV=production, but the PoC only has test email sinks. Refusing to boot.',
    );
  }

  const authSecret = required(env, 'BETTER_AUTH_SECRET');
  if (authSecret.length < 32) {
    throw new Error('BETTER_AUTH_SECRET must be at least 32 characters');
  }

  return {
    mode,
    databaseUrl: required(env, 'COMMUNITY_DATABASE_URL'),
    authSecret,
    baseUrl: env.COMMUNITY_BASE_URL ?? `http://localhost:${env.PORT ?? '3000'}`,
    allowlist: new Set(
      (env.COMMUNITY_ALLOWLIST ?? '')
        .split(',')
        .map(id => id.trim())
        .filter(Boolean),
    ),
    emailSink: emailSinkRaw,
    emailOutboxDir: env.COMMUNITY_EMAIL_OUTBOX_DIR,
    accessTokenTtlSeconds: int(env, 'COMMUNITY_ACCESS_TOKEN_TTL_SECONDS', 900, 1, 3600),
    sessionTtlSeconds: int(
      env,
      'COMMUNITY_SESSION_TTL_SECONDS',
      60 * 60 * 24 * 30,
      60,
      60 * 60 * 24 * 90,
    ),
    stepUpTtlSeconds: int(env, 'COMMUNITY_STEP_UP_TTL_SECONDS', 60 * 60 * 12, 1, 60 * 60 * 24),
  };
};
