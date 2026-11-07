/**
 * Better Auth instance for Community (ADR-001 option A).
 *
 * Module-system note: `better-auth` 1.7.x ships ESM only (`"type": "module"`, `.mjs`, no
 * `require` export condition). This repo compiles to CommonJS. It works at runtime because
 * Node >= 20.19 / >= 22.12 can `require()` a synchronous ES module graph (no top-level await),
 * and Better Auth's graph has none. TypeScript (module: commonjs, node10 resolution) resolves
 * its types without a tsconfig change. Jest needs the ESM packages transformed; see
 * jest.config.js. Recorded as a PoC finding in POC_COMMUNITY_AUTH_RESULTS.md.
 */
import { AsyncLocalStorage } from 'async_hooks';
import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { bearer, emailOTP, jwt, twoFactor } from 'better-auth/plugins';
import { FastifyBaseLogger } from 'fastify';
import { Pool } from 'pg';
import { VersionedSecret } from './config';
import { EmailSender, OTP_TTL_SECONDS, OtpPurpose } from './email';
import { scrubLogValue } from './log-safety';

/**
 * Better Auth runs `sendVerificationOTP` through `runInBackgroundOrAwait`, which catches and
 * only logs a failure, so the facade would answer 202 for a code that was never sent. The
 * facade therefore opens a delivery slot around the call; the sender records its outcome in it
 * and the facade answers 503 `email_unavailable` (routes/auth.ts).
 */
export interface OtpDeliverySlot {
  error?: unknown;
  attempted: boolean;
}
export const otpDelivery = new AsyncLocalStorage<OtpDeliverySlot>();

/**
 * Better Auth is the identity and session store ONLY (contract §3.1). Its HTTP handler is never
 * mounted: every `/v1/auth/*` route is a WellaPath facade (./routes/auth.ts) calling
 * `auth.api.*` server-side, so the Better Auth session token never leaves the server.
 */
export interface CommunityAuthOptions {
  pool: Pool;
  secrets: VersionedSecret[];
  baseUrl: string;
  email: EmailSender;
  accessTokenTtlSeconds: number;
  /** Upper bound for the Better Auth session; the refresh family's own limits are stricter. */
  sessionTtlSeconds: number;
  /** Better Auth's own log lines go to Pino (scrubbed), never straight to the console. */
  logger?: FastifyBaseLogger;
}

export const AUTH_BASE_PATH = '/v1/auth';
export const ACCESS_TOKEN_ISSUER = 'wellapath-community';
export const ACCESS_TOKEN_AUDIENCE = 'wellapath-community-api';

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export const createCommunityAuth = (options: CommunityAuthOptions) =>
  betterAuth({
    appName: 'WellaPath Community',
    basePath: AUTH_BASE_PATH,
    baseURL: options.baseUrl,
    // Versioned from day one (PoC P4): they encrypt the JWKS private key and TOTP secrets.
    secret: options.secrets[0].value,
    secrets: options.secrets,
    database: options.pool,
    trustedOrigins: [options.baseUrl],
    // Better Auth ships anonymous usage telemetry; Community must not phone home.
    telemetry: { enabled: false },
    // Its console logger would bypass Pino's redaction; route it through Pino instead.
    logger: {
      level: 'warn',
      disableColors: true,
      log: (level, message, ...args): void => {
        const log = options.logger;
        if (!log) return;
        const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info';
        log[method]({ event: 'better_auth', args: scrubLogValue(args) }, message);
      },
    },
    // Passwords are off: sign-in and recovery are email OTP only (ADR-001 R2.1).
    emailAndPassword: { enabled: false },
    user: {
      additionalFields: {
        // `input: false` — a client can never set its own role at sign-up or via update-user.
        role: { type: 'string', required: false, defaultValue: 'member', input: false },
      },
    },
    databaseHooks: {
      session: {
        create: {
          // A suspended account cannot obtain a new session (suspension also deletes the
          // existing ones), so signing in again with a fresh OTP does not lift a suspension.
          before: async session => {
            const { rows } = await options.pool.query(
              `SELECT 1 FROM account_restrictions
                WHERE user_id = $1 AND kind = 'suspended' AND lifted_at IS NULL
                  AND (expires_at IS NULL OR expires_at > now())`,
              [session.userId],
            );
            if (rows.length > 0) {
              throw new APIError('FORBIDDEN', {
                message: 'Account suspended',
                code: 'ACCOUNT_SUSPENDED',
              });
            }
            return { data: session };
          },
        },
      },
    },
    session: {
      expiresIn: options.sessionTtlSeconds,
      // Never extended by Better Auth: the refresh family owns absolute and idle limits.
      updateAge: options.sessionTtlSeconds,
      // No cookie cache: revocation must take effect on the next request.
      cookieCache: { enabled: false },
    },
    // ADR A3: Better Auth's limiter keys on client-supplied proxy headers. It is OFF; the single
    // WellaPath limiter (./limiter.ts) applies instead.
    rateLimit: { enabled: false },
    advanced: {
      // Contract §14: no client-controlled IP / user agent on the session row.
      ipAddress: { disableIpTracking: true },
    },
    // Endpoints the PoC does not use are switched off, so they are not attack surface.
    disabledPaths: [
      '/email-otp/request-password-reset',
      '/forget-password/email-otp',
      '/email-otp/reset-password',
      '/two-factor/send-otp',
      '/two-factor/verify-otp',
      '/update-user',
      '/delete-user',
      '/change-email',
      '/email-otp/request-email-change',
      '/email-otp/change-email',
    ],
    plugins: [
      // Internal only: server-side `auth.api.*` calls authenticate with the session token as a
      // bearer header. Clients never see that token.
      bearer(),
      emailOTP({
        otpLength: 6,
        expiresIn: OTP_TTL_SECONDS,
        // Contract A2/§4.2: 5 verify attempts per issued code, then the code is invalidated.
        allowedAttempts: 5,
        storeOTP: 'hashed',
        async sendVerificationOTP({ email, otp, type }) {
          const slot = otpDelivery.getStore();
          if (slot) slot.attempted = true;
          try {
            await options.email.sendOtp({
              to: email.toLowerCase(),
              otp,
              purpose: type as OtpPurpose,
              sentAt: new Date().toISOString(),
            });
          } catch (error) {
            // Recorded for the facade; not rethrown, so Better Auth logs nothing about it.
            if (slot) slot.error = error;
            else throw error;
          }
        },
      }),
      // EdDSA signing keys (JWKS). Access tokens are minted server-side by ./tokens.ts through
      // `auth.api.signJWT` with sub, sid (refresh family id), jti, iat and exp.
      jwt({
        jwks: { keyPairConfig: { alg: 'EdDSA', crv: 'Ed25519' } },
        jwt: {
          issuer: ACCESS_TOKEN_ISSUER,
          audience: ACCESS_TOKEN_AUDIENCE,
          expirationTime: `${options.accessTokenTtlSeconds}s`,
        },
      }),
      twoFactor({
        issuer: 'WellaPath Community',
        // Email-OTP users have no password; TOTP enrolment must not demand one.
        allowPasswordless: true,
      }),
    ],
  });

export type CommunityAuth = ReturnType<typeof createCommunityAuth>;
