/**
 * Enabled-mode Community wiring. Loaded lazily by `./index` only when COMMUNITY_MODE is
 * enabled, so a disabled deployment never even loads Better Auth or opens a pool.
 */
import { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { AccessTokenVerifier } from './access';
import { createCommunityAuth } from './auth';
import { CommunityEnabledConfig } from './config';
import { EmailSender, FileOutbox, MemoryOutbox } from './email';
import { communityPlugin, isCommunityAllowed } from './plugin';

export const registerEnabledCommunity = async (
  server: FastifyInstance,
  config: CommunityEnabledConfig,
  options: { email?: EmailSender; authRateLimitEnabled?: boolean },
): Promise<void> => {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 10,
    idleTimeoutMillis: 30000,
    // Fail fast: an unreachable Community DB must answer 503 quickly, not hang requests.
    connectionTimeoutMillis: 2000,
  });
  // An idle-client error (DB restarted, network blip) must not crash the process that also
  // serves /config.
  pool.on('error', error => server.log.error({ err: error.message }, 'Community pool error'));

  const email =
    options.email ??
    (config.emailSink === 'outbox-file'
      ? new FileOutbox(config.emailOutboxDir ?? './.community-outbox')
      : new MemoryOutbox());

  const auth = createCommunityAuth({
    pool,
    secret: config.authSecret,
    baseUrl: config.baseUrl,
    email,
    accessTokenTtlSeconds: config.accessTokenTtlSeconds,
    sessionTtlSeconds: config.sessionTtlSeconds,
    rateLimitEnabled: options.authRateLimitEnabled,
  });
  const verifier = new AccessTokenVerifier(auth, pool);

  server.get(
    '/v1/features',
    async (request): Promise<{ community: string; community_allowed: boolean }> => {
      let allowed = false;
      const header = request.headers.authorization;
      if (header?.startsWith('Bearer ')) {
        try {
          allowed = isCommunityAllowed(config, await verifier.verify(header.slice(7).trim()));
        } catch {
          // Invalid token, or the Community DB is down: fail closed, but still answer 200.
          allowed = false;
        }
      }
      return { community: config.mode, community_allowed: allowed };
    },
  );

  await server.register(communityPlugin, { config, pool, auth, verifier });

  server.addHook('onClose', async () => {
    await pool.end();
  });
};
