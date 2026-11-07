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
import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { bearer, emailOTP, jwt, twoFactor } from 'better-auth/plugins';
import { Pool } from 'pg';
import { EmailSender, OtpPurpose } from './email';

export interface CommunityAuthOptions {
  pool: Pool;
  secret: string;
  baseUrl: string;
  email: EmailSender;
  accessTokenTtlSeconds: number;
  sessionTtlSeconds: number;
  /** Better Auth's own per-IP rate limiter. Tests turn it off to run many flows quickly. */
  rateLimitEnabled?: boolean;
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
    secret: options.secret,
    database: options.pool,
    trustedOrigins: [options.baseUrl],
    // Better Auth ships anonymous usage telemetry; Community must not phone home.
    telemetry: { enabled: false },
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
      updateAge: 60 * 60 * 24,
      // No cookie cache: revocation must take effect on the next request.
      cookieCache: { enabled: false },
    },
    rateLimit: {
      enabled: options.rateLimitEnabled ?? true,
      storage: 'memory',
      window: 60,
      max: 60,
      customRules: {
        '/email-otp/send-verification-otp': { window: 60, max: 3 },
        '/sign-in/email-otp': { window: 60, max: 5 },
        '/two-factor/*': { window: 10, max: 3 },
      },
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
      // Mobile: `Authorization: Bearer <session token>` instead of cookies.
      bearer(),
      emailOTP({
        otpLength: 6,
        expiresIn: 300,
        allowedAttempts: 3,
        storeOTP: 'hashed',
        async sendVerificationOTP({ email, otp, type }) {
          await options.email.sendOtp({
            to: email.toLowerCase(),
            otp,
            purpose: type as OtpPurpose,
            sentAt: new Date().toISOString(),
          });
        },
      }),
      // Short-lived access token. `sid` lets the API reject a token whose session was revoked.
      jwt({
        jwt: {
          issuer: ACCESS_TOKEN_ISSUER,
          audience: ACCESS_TOKEN_AUDIENCE,
          expirationTime: `${options.accessTokenTtlSeconds}s`,
          definePayload: ({ session }) => ({ sid: session.id }),
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
