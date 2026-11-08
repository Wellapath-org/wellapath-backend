/**
 * Community entry point (ADR-001). Not approved for release.
 *
 * `GET /v1/features` is registered in every mode: it is how the app learns Community is off,
 * and in `disabled` mode it is a constant that reads no configuration beyond COMMUNITY_MODE and
 * touches no database. Every other Community or auth route exists only in an enabled mode, and
 * the enabled code (Better Auth, pg pool) is not even loaded in `disabled` mode.
 */
import { randomUUID } from 'crypto';
import { FastifyInstance, FastifyRequest } from 'fastify';
import { CommunityConfig } from './config';
import type { EmailSender } from './email';

export interface RegisterCommunityOptions {
  config: CommunityConfig;
  /** Overrides the configured sink (tests pass a MemoryOutbox). */
  email?: EmailSender;
  /**
   * The security client IP (SEC-001/SEC-002), derived once by the app (`src/config/client-ip.ts`)
   * and injected, so Community imports nothing outside src/community. Default: `request.ip`.
   */
  clientIp?: (request: FastifyRequest) => string;
  /**
   * Whether the security IP identifies individual clients (CLIENT_IP_SOURCE=cf-connecting-ip, or
   * a measured TRUST_PROXY_HOPS). Selects per-IP vs interim global ceilings.
   */
  clientIpAttributed?: boolean;
}

export interface CommunityFeatures {
  community: CommunityConfig['mode'];
  community_allowed: boolean;
}

const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

export const registerCommunity = async (
  server: FastifyInstance,
  options: RegisterCommunityOptions,
): Promise<void> => {
  const { config } = options;
  if (config.mode === 'disabled') {
    // Constant. No DB, no auth library. Headers kept inline so this path imports nothing else.
    server.get('/v1/features', async (request, reply): Promise<CommunityFeatures> => {
      const sent = request.headers['x-request-id'];
      reply.header('cache-control', 'no-store');
      reply.header(
        'x-request-id',
        typeof sent === 'string' && REQUEST_ID.test(sent) ? sent : randomUUID(),
      );
      return { community: 'disabled', community_allowed: false };
    });
    return;
  }
  const { registerEnabledCommunity } = await import('./enabled');
  await registerEnabledCommunity(server, config, {
    email: options.email,
    clientIp: options.clientIp ?? ((request: FastifyRequest): string => request.ip),
    clientIpAttributed: options.clientIpAttributed ?? false,
  });
};
