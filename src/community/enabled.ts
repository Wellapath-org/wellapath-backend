/**
 * Enabled-mode Community wiring. Loaded lazily by `./index` only when COMMUNITY_MODE is
 * enabled, so a disabled deployment never even loads Better Auth or opens a pool.
 */
import { FastifyInstance, FastifyRequest } from 'fastify';
import { Pool } from 'pg';
import { createCommunityAuth } from './auth';
import { CommunityEnabledConfig } from './config';
import { CommunityContext } from './context';
import { assertVerifyFull } from './db-url';
import { Hasher } from './crypto';
import { EmailSender, FileOutbox, MemoryOutbox, ResendSender } from './email';
import { AuthEvents } from './events';
import { ApiError, applyContractHeaders, isDatabaseUnavailable, sendApiError } from './http';
import { IdempotencyStore } from './idempotency';
import { RateLimiter } from './limiter';
import { communityPlugin } from './plugin';
import { AuthRetentionJob } from './purge';
import { TokenService } from './tokens';

declare module 'fastify' {
  interface FastifyInstance {
    communityRoutes?: { method: string; url: string }[];
  }
}

export interface EnabledOptions {
  email?: EmailSender;
  /** The security client IP, injected by the app (see `RegisterCommunityOptions.clientIp`). */
  clientIp: (request: FastifyRequest) => string;
  /** Whether that IP identifies individual clients (selects per-IP vs interim global ceilings). */
  clientIpAttributed: boolean;
}

const createSender = (config: CommunityEnabledConfig): EmailSender => {
  if (config.emailSink === 'resend') {
    if (!config.resend) throw new Error('Resend configuration missing');
    return new ResendSender(config.resend);
  }
  if (config.emailSink === 'outbox-file') {
    return new FileOutbox(config.emailOutboxDir ?? './.community-outbox');
  }
  return new MemoryOutbox();
};

export const registerEnabledCommunity = async (
  server: FastifyInstance,
  config: CommunityEnabledConfig,
  options: EnabledOptions,
): Promise<void> => {
  const pool = new Pool({
    // B5, enforced here too so a programmatic config cannot bypass loadCommunityConfig.
    connectionString: assertVerifyFull(config.databaseUrl, 'COMMUNITY_DATABASE_URL'),
    max: 10,
    idleTimeoutMillis: 30000,
    // Fail fast: an unreachable Community DB must answer 503 quickly, not hang requests.
    connectionTimeoutMillis: 2000,
  });
  // An idle-client error (DB restarted, network blip) must not crash the process that also
  // serves /config.
  pool.on('error', error => server.log.error({ err: error.message }, 'Community pool error'));

  const email = options.email ?? createSender(config);
  // Only the provider name is logged: never the key, the sender address or any recipient.
  server.log.info({ event: 'community_email_provider', provider: email.name }, 'Community email');

  const auth = createCommunityAuth({
    pool,
    secrets: config.authSecrets,
    baseUrl: config.baseUrl,
    email,
    accessTokenTtlSeconds: config.accessTokenTtlSeconds,
    sessionTtlSeconds: config.memberLifetimes.absoluteSeconds,
    logger: server.log,
  });
  const hasher = new Hasher(config.refreshPeppers);
  const events = new AuthEvents(pool, hasher);
  const tokens = new TokenService(pool, auth, hasher, events, config);
  const limiter = new RateLimiter(pool, hasher, {
    clientIpAttributed: options.clientIpAttributed,
    overrides: config.limitOverrides,
  });
  const ctx = new CommunityContext({
    config,
    pool,
    auth,
    email,
    hasher,
    events,
    tokens,
    limiter,
    idempotency: new IdempotencyStore(pool),
    clientIp: options.clientIp,
  });

  // Route registry (method + URL of every auth/community route) for the contract test, which
  // checks that the implementation exposes exactly the OpenAPI operations.
  const routes: { method: string; url: string }[] = [];
  server.addHook('onRoute', route => {
    if (!/^\/v1\/(auth|community|features)/.test(route.url)) return;
    for (const method of [route.method].flat()) {
      if (method !== 'HEAD') routes.push({ method, url: route.url });
    }
  });
  server.decorate('communityRoutes', routes);

  // GET /v1/features: optional bearer, always 200 (or 429), never 5xx; fails closed. With the
  // Community DB down it reports `disabled` (contract §6).
  server.get('/v1/features', async (request, reply) => {
    applyContractHeaders(request, reply);
    const closed = { community: 'disabled', community_allowed: false };
    try {
      await ctx.limit(reply, [{ name: 'features_ip', key: ctx.ip(request) }]);
    } catch (error) {
      if (error instanceof ApiError) return sendApiError(request, reply, error);
      return reply.send(closed);
    }
    let allowed = false;
    const header = request.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      try {
        allowed = ctx.isAllowed(await tokens.verifyAccess(header.slice(7).trim()));
      } catch (error) {
        if (isDatabaseUnavailable(error)) return reply.send(closed);
        allowed = false;
      }
    }
    return reply.send({ community: config.mode, community_allowed: allowed });
  });

  await server.register(communityPlugin, { ctx });

  // Sign-in retention: pending OTP rows (they contain the address) are gone within 24 h.
  const retention = new AuthRetentionJob(pool, server.log, config.authPurgeIntervalSeconds, email);
  server.addHook('onReady', async () => retention.start());

  server.addHook('onClose', async () => {
    await retention.stop();
    await pool.end();
  });
};
