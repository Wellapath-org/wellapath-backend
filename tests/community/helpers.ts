/**
 * Community test harness (contract v1.0-draft).
 *
 * Database suites need a disposable local Postgres, provisioned with the three-role model
 * (`scripts/community/provision-runtime-role.ts`, see docs/COMMUNITY_POC.md):
 *   COMMUNITY_TEST_DATABASE_URL        `community_migrator` (LOGIN, NOINHERIT; SET-only member of
 *                                      the NOLOGIN owner). Legacy: any role owning the tables.
 *   COMMUNITY_TEST_OWNER_ROLE          `community_owner`: suites act as it via SET ROLE
 *   COMMUNITY_TEST_APP_DATABASE_URL    runtime role `community_app` (DML only)
 *   COMMUNITY_TEST_ADMIN_DATABASE_URL  branch-owner stand-in (`neondb_owner` equivalent: LOGIN
 *                                      CREATEROLE CREATEDB, owns the database). Provisioning only.
 * When they are not set the database suites are skipped (`describeDb`) and say so; they never
 * fall back to DB_* (staging) variables. CI provides a Postgres service for them.
 *
 * Every flow goes through the WellaPath facade routes (`/v1/auth/*`) exactly as the mobile app
 * would; nothing calls Better Auth's own handler (it is not mounted).
 */
import { createHmac, randomBytes, randomUUID } from 'crypto';
import { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { Pool } from 'pg';
import { buildApp } from '../../src/app';
import {
  CommunityEnabledConfig,
  DEFAULT_MEMBER_LIFETIMES,
  DEFAULT_PRIVILEGED_LIFETIMES,
} from '../../src/community/config';
import { MemoryOutbox } from '../../src/community/email';
import { LimitOverrides } from '../../src/community/limiter';
import { MigrateOptions, migrateDown, migrateUp } from '../../src/community/migrate';
import { LogCapture } from '../helpers/app';

export const OWNER_URL = process.env.COMMUNITY_TEST_DATABASE_URL;
export const APP_URL = process.env.COMMUNITY_TEST_APP_DATABASE_URL ?? OWNER_URL;
export const ADMIN_URL = process.env.COMMUNITY_TEST_ADMIN_DATABASE_URL;
/** The NOLOGIN owner the migrator SETs ROLE to; unset = legacy single owner login. */
export const OWNER_ROLE = process.env.COMMUNITY_TEST_OWNER_ROLE || undefined;
export const MIGRATE_OPTIONS: MigrateOptions = { ownerRole: OWNER_ROLE ?? null };

export const describeDb: jest.Describe = OWNER_URL ? describe : describe.skip;
if (!OWNER_URL) {
  // eslint-disable-next-line no-console
  console.warn('COMMUNITY_TEST_DATABASE_URL not set: Community database suites are SKIPPED');
}

/**
 * Acts as the OWNER for test setup and assertions: the migrator connection with
 * `role=community_owner` in the startup options (i.e. an explicit SET ROLE per connection).
 */
export const ownerPool = (): Pool =>
  new Pool({
    connectionString: OWNER_URL,
    ...(OWNER_ROLE ? { options: `-c role=${OWNER_ROLE}` } : {}),
  });
/** The migrator as it logs in: no SET ROLE, so no privilege of its own. */
export const migratorPool = (): Pool => new Pool({ connectionString: OWNER_URL });
export const appPool = (): Pool => new Pool({ connectionString: APP_URL });
export const adminPool = (database?: string): Pool => {
  const url = new URL(ADMIN_URL as string);
  if (database) url.pathname = `/${database}`;
  return new Pool({ connectionString: url.toString() });
};

/** Drops and recreates the whole Community schema through the real migrations (as migrator). */
export const resetDatabase = async (): Promise<void> => {
  const pool = migratorPool();
  try {
    await migrateDown(pool, undefined, undefined, MIGRATE_OPTIONS);
    await migrateUp(pool, undefined, MIGRATE_OPTIONS);
  } finally {
    await pool.end();
  }
};

/** Runs SQL as the migration owner (test setup only: bootstrap, clock manipulation). */
export const ownerQuery = async (sql: string, params: unknown[] = []): Promise<unknown[]> => {
  const pool = ownerPool();
  try {
    return (await pool.query(sql, params)).rows;
  } finally {
    await pool.end();
  }
};

/**
 * Generous ceilings so suites that sign in many accounts from one test "IP" are not limited.
 * Suites that test a limit build an app WITHOUT these overrides.
 */
export const RELAXED_LIMITS: LimitOverrides = {
  otp_request_ip: { max: 100000, interimMax: 100000 },
  otp_verify_ip: { max: 100000, interimMax: 100000 },
  refresh_ip: { max: 100000, interimMax: 100000 },
  create_post_hour: { max: 1000 },
  create_post_day: { max: 1000 },
  create_comment_hour: { max: 1000 },
  create_report_day: { max: 1000 },
  authenticated_default: { max: 100000 },
  privileged_mutation_hour: { max: 100000 },
  totp_attempts_account: { max: 1000 },
  session_routes_account: { max: 1000 },
};

/** Stable per process: Better Auth encrypts the JWKS private key and TOTP secrets with it. */
const TEST_AUTH_SECRET = randomBytes(32).toString('base64url');
const TEST_PEPPER = randomBytes(32).toString('base64url');

export interface CommunityTestApp {
  server: FastifyInstance;
  outbox: MemoryOutbox;
  config: CommunityEnabledConfig;
  logs: LogCapture;
  close: () => Promise<void>;
}

export interface TestAppOptions {
  config?: Partial<CommunityEnabledConfig>;
  trustProxyHops?: number;
  /** Shared outbox (so a restarted app still sees earlier OTPs). */
  outbox?: MemoryOutbox;
}

export const testConfig = (
  overrides: Partial<CommunityEnabledConfig> = {},
): CommunityEnabledConfig => ({
  mode: 'internal',
  databaseUrl: APP_URL as string,
  authSecrets: [{ version: 1, value: TEST_AUTH_SECRET }],
  refreshPeppers: [{ version: 1, value: TEST_PEPPER }],
  baseUrl: 'http://localhost:3000',
  allowlist: new Set<string>(),
  emailSink: 'memory',
  accessTokenTtlSeconds: 900,
  memberLifetimes: DEFAULT_MEMBER_LIFETIMES,
  privilegedLifetimes: DEFAULT_PRIVILEGED_LIFETIMES,
  stepUpTtlSeconds: 12 * 3600,
  otpRequestMinMs: 0,
  limitOverrides: RELAXED_LIMITS,
  ...overrides,
});

export const createCommunityApp = async (
  options: TestAppOptions = {},
): Promise<CommunityTestApp> => {
  const outbox = options.outbox ?? new MemoryOutbox();
  const logs = new LogCapture();
  const config = testConfig(options.config);
  const built = await buildApp({
    logDestination: logs,
    registerDatabase: false,
    telemetryEnabled: false,
    rateLimitMax: 100000,
    trustProxyHops: options.trustProxyHops,
    community: { config, email: outbox },
  });
  await built.server.ready();
  return {
    server: built.server,
    outbox,
    config,
    logs,
    close: async () => {
      await built.server.close();
    },
  };
};

export const bearer = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
});

export const idem = (): Record<string, string> => ({ 'idempotency-key': randomUUID() });

let counter = 0;
export const uniqueEmail = (label: string): string =>
  `${label}.${Date.now()}.${counter++}@example.test`;

export interface SignedIn {
  email: string;
  userId: string;
  deviceId: string;
  accessToken: string;
  refreshToken: string;
  familyId: string;
}

export const sidOf = (accessToken: string): string =>
  (
    JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString('utf8')) as {
      sid: string;
    }
  ).sid;

export const requestOtp = (
  app: CommunityTestApp,
  email: string,
  headers: Record<string, string> = {},
): Promise<LightMyRequestResponse> =>
  app.server.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { email }, headers });

export const verifyOtp = (
  app: CommunityTestApp,
  email: string,
  code: string,
  deviceId: string = randomUUID(),
  headers: Record<string, string> = {},
): Promise<LightMyRequestResponse> =>
  app.server.inject({
    method: 'POST',
    url: '/v1/auth/otp/verify',
    payload: { email, code, device_id: deviceId, device_label: 'Test device' },
    headers,
  });

/** Email-OTP sign-up / sign-in through the facade, capturing the OTP from the test outbox. */
export const signIn = async (
  app: CommunityTestApp,
  email: string,
  deviceId: string = randomUUID(),
): Promise<SignedIn> => {
  const send = await requestOtp(app, email);
  if (send.statusCode !== 202) throw new Error(`otp/request: ${send.statusCode} ${send.body}`);
  const res = await verifyOtp(app, email, app.outbox.latestOtp(email, 'sign-in'), deviceId);
  if (res.statusCode !== 200) throw new Error(`otp/verify: ${res.statusCode} ${res.body}`);
  const body = res.json() as {
    access_token: string;
    refresh_token: string;
    account: { account_id: string };
  };
  return {
    email,
    userId: body.account.account_id,
    deviceId,
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    familyId: sidOf(body.access_token),
  };
};

export const refresh = (
  app: CommunityTestApp,
  refreshToken: string,
  deviceId: string,
): Promise<LightMyRequestResponse> =>
  app.server.inject({
    method: 'POST',
    url: '/v1/auth/refresh',
    payload: { refresh_token: refreshToken, device_id: deviceId },
  });

/** Bootstrap path for tests: role set by the migration owner (as the bootstrap CLI does). */
export const setRole = async (userId: string, role: string): Promise<void> => {
  await ownerQuery(`UPDATE "user" SET "role" = $2 WHERE "id" = $1`, [userId, role]);
};

/** Letters only, so a random name never trips the "looks like a phone number" rule. */
const randomName = (): string =>
  `user_${Array.from(randomBytes(10), b => String.fromCharCode(97 + (b % 26))).join('')}`;

export const setProfile = async (
  app: CommunityTestApp,
  user: SignedIn,
  name?: string,
): Promise<LightMyRequestResponse> =>
  app.server.inject({
    method: 'PUT',
    url: '/v1/community/me/profile',
    headers: bearer(user.accessToken),
    payload: { display_name: name ?? randomName() },
  });

/** A signed-in member with a profile, allowlisted in the given app config. */
export const memberWithProfile = async (
  app: CommunityTestApp,
  label: string,
  name?: string,
): Promise<SignedIn> => {
  const user = await signIn(app, uniqueEmail(label));
  app.config.allowlist.add(user.userId);
  const res = await setProfile(app, user, name);
  if (res.statusCode !== 200) throw new Error(`profile: ${res.statusCode} ${res.body}`);
  return user;
};

// ------------------------------------------------------------------ RFC 6238 TOTP (SHA-1)
const base32Decode = (input: string): Buffer => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of input.replace(/=+$/, '').toUpperCase()) {
    const value = alphabet.indexOf(char);
    if (value < 0) throw new Error('bad base32');
    bits += value.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8)
    bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
};

export const totp = (base32Secret: string, at = Date.now(), period = 30, digits = 6): string => {
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / period)));
  const hmac = createHmac('sha1', base32Decode(base32Secret)).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return code.toString().padStart(digits, '0');
};

/** A code that is wrong for every accepted window. */
export const wrongTotp = (secret: string): string => {
  const near = [-1, 0, 1].map(w => totp(secret, Date.now() + w * 30000));
  for (let i = 0; i < 1000000; i += 1) {
    const candidate = String(i).padStart(6, '0');
    if (!near.includes(candidate)) return candidate;
  }
  throw new Error('unreachable');
};

export interface Enrolled extends SignedIn {
  totpSecret: string;
  backupCodes: string[];
}

/** TOTP enrolment through the facade (A7 + A8). Confirmation is also a step-up. */
export const enrollTotp = async (app: CommunityTestApp, user: SignedIn): Promise<Enrolled> => {
  const start = await app.server.inject({
    method: 'POST',
    url: '/v1/auth/totp/enrol',
    headers: bearer(user.accessToken),
    payload: {},
  });
  if (start.statusCode !== 200) throw new Error(`enrol: ${start.statusCode} ${start.body}`);
  const { secret_base32 } = start.json() as { secret_base32: string };
  const confirm = await app.server.inject({
    method: 'POST',
    url: '/v1/auth/totp/enrol/confirm',
    headers: bearer(user.accessToken),
    payload: { code: totp(secret_base32) },
  });
  if (confirm.statusCode !== 200) throw new Error(`confirm: ${confirm.statusCode} ${confirm.body}`);
  return {
    ...user,
    totpSecret: secret_base32,
    backupCodes: (confirm.json() as { backup_codes: string[] }).backup_codes,
  };
};

export const stepUp = async (
  app: CommunityTestApp,
  user: Enrolled,
  payload?: Record<string, string>,
): Promise<LightMyRequestResponse> =>
  app.server.inject({
    method: 'POST',
    url: '/v1/auth/totp/verify',
    headers: bearer(user.accessToken),
    payload: payload ?? { code: totp(user.totpSecret) },
  });

/**
 * A moderator/admin: role granted by the owner (bootstrap), then sign in (privileged lifetimes),
 * enrol TOTP (confirmation = step-up) and give them a profile.
 */
export const privilegedUser = async (
  app: CommunityTestApp,
  label: string,
  role: 'moderator' | 'admin',
): Promise<Enrolled> => {
  const first = await signIn(app, uniqueEmail(label));
  await setRole(first.userId, role);
  const user = await signIn(app, first.email);
  const enrolled = await enrollTotp(app, user);
  await setProfile(app, enrolled);
  return enrolled;
};
