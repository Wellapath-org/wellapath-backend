/**
 * Community PoC test harness.
 *
 * Database suites need a disposable local Postgres:
 *   COMMUNITY_TEST_DATABASE_URL      migration owner (creates/drops tables)
 *   COMMUNITY_TEST_APP_DATABASE_URL  runtime role `community_app` (DML only)
 * When they are not set the database suites are skipped (`describeDb`) and say so; they never
 * fall back to DB_* (staging) variables. CI provides a Postgres service for them.
 */
import { createHmac, randomBytes } from 'crypto';
import { Pool } from 'pg';
import { buildApp } from '../../src/app';
import { CommunityEnabledConfig } from '../../src/community/config';
import { MemoryOutbox } from '../../src/community/email';
import { migrateDown, migrateUp } from '../../src/community/migrate';
import { LogCapture } from '../helpers/app';
import { FastifyInstance } from 'fastify';

export const OWNER_URL = process.env.COMMUNITY_TEST_DATABASE_URL;
export const APP_URL = process.env.COMMUNITY_TEST_APP_DATABASE_URL ?? OWNER_URL;

export const describeDb: jest.Describe = OWNER_URL ? describe : describe.skip;
if (!OWNER_URL) {
  // eslint-disable-next-line no-console
  console.warn('COMMUNITY_TEST_DATABASE_URL not set: Community database suites are SKIPPED');
}

export const ownerPool = (): Pool => new Pool({ connectionString: OWNER_URL });
export const appPool = (): Pool => new Pool({ connectionString: APP_URL });

/** Drops and recreates the whole Community schema through the real migrations. */
export const resetDatabase = async (): Promise<void> => {
  const pool = ownerPool();
  try {
    await migrateDown(pool);
    await migrateUp(pool);
  } finally {
    await pool.end();
  }
};

export interface CommunityTestApp {
  server: FastifyInstance;
  outbox: MemoryOutbox;
  config: CommunityEnabledConfig;
  logs: LogCapture;
  close: () => Promise<void>;
}

/**
 * One random secret per test process. It must be stable across app instances that share a
 * database: Better Auth encrypts the JWKS private key and TOTP secrets with it (PoC finding —
 * rotating BETTER_AUTH_SECRET needs a planned key rotation). Never shared with any environment.
 */
const TEST_AUTH_SECRET = randomBytes(32).toString('base64url');

export const testConfig = (
  overrides: Partial<CommunityEnabledConfig> = {},
): CommunityEnabledConfig => ({
  mode: 'internal',
  databaseUrl: APP_URL as string,
  authSecret: TEST_AUTH_SECRET,
  baseUrl: 'http://localhost:3000',
  allowlist: new Set<string>(),
  emailSink: 'memory',
  accessTokenTtlSeconds: 900,
  sessionTtlSeconds: 3600,
  stepUpTtlSeconds: 3600,
  ...overrides,
});

export const createCommunityApp = async (
  overrides: Partial<CommunityEnabledConfig> = {},
): Promise<CommunityTestApp> => {
  const outbox = new MemoryOutbox();
  const logs = new LogCapture();
  const config = testConfig(overrides);
  const built = await buildApp({
    logDestination: logs,
    registerDatabase: false,
    telemetryEnabled: false,
    rateLimitMax: 100000,
    community: { config, email: outbox, authRateLimitEnabled: false },
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

const json = (body: string): Record<string, unknown> => (body ? JSON.parse(body) : {});

export interface SignedIn {
  email: string;
  userId: string;
  sessionToken: string;
  accessToken: string;
}

let counter = 0;
export const uniqueEmail = (label: string): string =>
  `${label}.${Date.now()}.${counter++}@example.test`;

/** Mints a short-lived access token (JWT) from a session token — the "refresh" call. */
export const mintAccessToken = async (
  app: CommunityTestApp,
  sessionToken: string,
): Promise<string> => {
  const res = await app.server.inject({
    method: 'GET',
    url: '/v1/auth/token',
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  if (res.statusCode !== 200) throw new Error(`token: ${res.statusCode} ${res.body}`);
  return json(res.body).token as string;
};

/** Email-OTP sign-up / sign-in, capturing the OTP from the test outbox. */
export const signIn = async (app: CommunityTestApp, email: string): Promise<SignedIn> => {
  const send = await app.server.inject({
    method: 'POST',
    url: '/v1/auth/email-otp/send-verification-otp',
    payload: { email, type: 'sign-in' },
  });
  if (send.statusCode !== 200) throw new Error(`send-otp: ${send.statusCode} ${send.body}`);
  const otp = app.outbox.latestOtp(email, 'sign-in');
  const res = await app.server.inject({
    method: 'POST',
    url: '/v1/auth/sign-in/email-otp',
    payload: { email, otp },
  });
  if (res.statusCode !== 200) throw new Error(`sign-in: ${res.statusCode} ${res.body}`);
  const body = json(res.body) as { token: string; user: { id: string } };
  return {
    email,
    userId: body.user.id,
    sessionToken: body.token,
    accessToken: await mintAccessToken(app, body.token),
  };
};

export const bearer = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
});

export const setRole = async (userId: string, role: string): Promise<void> => {
  // Bootstrap path: the first admin is created out-of-band by the migration owner (runbook),
  // because no admin exists yet to grant the role through the audited API.
  const pool = ownerPool();
  try {
    await pool.query(`UPDATE "user" SET "role" = $2 WHERE "id" = $1`, [userId, role]);
  } finally {
    await pool.end();
  }
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

export interface Enrolled extends SignedIn {
  totpSecret: string;
  backupCodes: string[];
}

/** Enrols TOTP (enable → verify first code). Better Auth rotates the session on enrolment. */
export const enrollTotp = async (app: CommunityTestApp, user: SignedIn): Promise<Enrolled> => {
  const enable = await app.server.inject({
    method: 'POST',
    url: '/v1/auth/two-factor/enable',
    headers: bearer(user.sessionToken),
    payload: {},
  });
  if (enable.statusCode !== 200) throw new Error(`enable: ${enable.statusCode} ${enable.body}`);
  const { totpURI, backupCodes } = json(enable.body) as { totpURI: string; backupCodes: string[] };
  const secret = new URL(totpURI).searchParams.get('secret') as string;
  const verify = await app.server.inject({
    method: 'POST',
    url: '/v1/auth/two-factor/verify-totp',
    headers: bearer(user.sessionToken),
    payload: { code: totp(secret) },
  });
  if (verify.statusCode !== 200) throw new Error(`verify: ${verify.statusCode} ${verify.body}`);
  const sessionToken =
    (verify.headers['set-auth-token'] as string) ?? (json(verify.body).token as string);
  return {
    ...user,
    sessionToken,
    accessToken: await mintAccessToken(app, sessionToken),
    totpSecret: secret,
    backupCodes,
  };
};

export const stepUp = async (app: CommunityTestApp, user: Enrolled): Promise<number> => {
  const res = await app.server.inject({
    method: 'POST',
    url: '/v1/community/mfa/step-up',
    headers: bearer(user.accessToken),
    payload: { code: totp(user.totpSecret) },
  });
  return res.statusCode;
};

/** A moderator/admin with TOTP enrolled and a fresh step-up on the current session. */
export const privilegedUser = async (
  app: CommunityTestApp,
  label: string,
  role: 'moderator' | 'admin',
): Promise<Enrolled> => {
  const user = await signIn(app, uniqueEmail(label));
  await setRole(user.userId, role);
  const enrolled = await enrollTotp(app, user);
  const status = await stepUp(app, enrolled);
  if (status !== 200) throw new Error(`step-up failed: ${status}`);
  return enrolled;
};
