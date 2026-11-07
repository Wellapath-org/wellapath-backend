/**
 * Community entry point (PROOF OF CONCEPT — ADR-001). Not approved for release.
 *
 * `GET /v1/features` is registered in every mode: it is how the app learns Community is off,
 * and in `disabled` mode it is a constant that reads no configuration beyond COMMUNITY_MODE and
 * touches no database. Every other Community or auth route exists only in an enabled mode, and
 * the enabled code (Better Auth, pg pool) is not even loaded in `disabled` mode.
 */
import { FastifyInstance } from 'fastify';
import { CommunityConfig } from './config';
import type { EmailSender } from './email';

export interface RegisterCommunityOptions {
  config: CommunityConfig;
  /** Overrides the configured sink (tests pass a MemoryOutbox). */
  email?: EmailSender;
  /** Better Auth's own rate limiter; tests disable it. */
  authRateLimitEnabled?: boolean;
}

export interface CommunityFeatures {
  community: CommunityConfig['mode'];
  community_allowed: boolean;
}

export const registerCommunity = async (
  server: FastifyInstance,
  options: RegisterCommunityOptions,
): Promise<void> => {
  const { config } = options;
  if (config.mode === 'disabled') {
    server.get(
      '/v1/features',
      async (): Promise<CommunityFeatures> => ({
        community: 'disabled',
        community_allowed: false,
      }),
    );
    return;
  }
  const { registerEnabledCommunity } = await import('./enabled');
  await registerEnabledCommunity(server, config, options);
};
