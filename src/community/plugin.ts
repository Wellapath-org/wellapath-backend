/**
 * Community plugin (ADR-001 + amendments A1–A4; COMMUNITY_API_CONTRACT v1.0-draft). Not
 * approved for release.
 *
 * Registered by `buildApp` only when `COMMUNITY_MODE` is internal | closed_beta | public. It owns
 * its own pg pool on `COMMUNITY_DATABASE_URL`; `/config`, `/health` and `/version` never touch it,
 * so a Community database outage is confined to `/v1/auth/*` and `/v1/community/*`.
 *
 * This encapsulated scope:
 * - uses a STRICT Ajv (`removeAdditional: false`, `coerceTypes: false`): unknown keys are
 *   rejected (400), never stripped;
 * - rejects prohibited (assessment-data) keys in the body or query BEFORE schema validation;
 * - maps every error to the contract envelope `{error:{code,message,request_id,details?}}`;
 * - sets `Cache-Control: no-store` and `X-Request-Id` on every response;
 * - answers 404 `not_found` for any other `/v1/auth/*` or `/v1/community/*` path (Better Auth's
 *   own handler is never mounted).
 *
 * Isolation: nothing under src/community imports artifact, manifest or telemetry code, and no
 * route accepts symptoms, triage results or assessment data (see the isolation tests).
 */
import { AjvCompiler } from '@fastify/ajv-compiler';
import { FastifyError, FastifyInstance } from 'fastify';
import { CommunityContext } from './context';
import {
  ApiError,
  applyContractHeaders,
  findProhibitedKey,
  isDatabaseUnavailable,
  mapValidationError,
  sendApiError,
  validation,
} from './http';
import { registerAuthRoutes } from './routes/auth';
import { registerContentRoutes } from './routes/content';
import { registerMeRoutes } from './routes/me';
import { registerModerationRoutes } from './routes/moderation';
import { registerNotificationRoutes } from './routes/notifications';

export interface CommunityPluginOptions {
  ctx: CommunityContext;
}

export async function communityPlugin(
  server: FastifyInstance,
  options: CommunityPluginOptions,
): Promise<void> {
  const { ctx } = options;

  server.setValidatorCompiler(
    AjvCompiler()(
      {},
      {
        customOptions: {
          removeAdditional: false,
          coerceTypes: false,
          useDefaults: false,
          allErrors: false,
        },
      },
    ),
  );

  server.addHook('onRequest', async (request, reply) => {
    applyContractHeaders(request, reply);
  });

  // Contract §5: a distinct, monitorable rejection, before schema validation.
  server.addHook('preValidation', async request => {
    const field =
      findProhibitedKey(request.body) ??
      findProhibitedKey(request.query as Record<string, unknown> | undefined);
    if (field) {
      const key =
        field
          .split('.')
          .pop()
          ?.replace(/\[\d+\]$/, '') ?? field;
      request.log.warn(
        { event: 'community_prohibited_key_rejected', route: request.routeOptions.url, key },
        'Community prohibited key rejected',
      );
      throw validation(field, 'prohibited_key');
    }
  });

  server.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof ApiError) return sendApiError(request, reply, error);
    if (error.validation) return sendApiError(request, reply, mapValidationError(error));
    if (isDatabaseUnavailable(error)) {
      request.log.error(
        { code: (error as { code?: string }).code },
        'Community database unavailable',
      );
      return sendApiError(request, reply, new ApiError('community_unavailable'));
    }
    if (error.statusCode === 429) {
      const after = Number.parseInt(String(reply.getHeader('retry-after') ?? '60'), 10) || 60;
      return sendApiError(
        request,
        reply,
        new ApiError('rate_limited', { retry_after_seconds: after }, undefined, {
          'retry-after': String(after),
        }),
      );
    }
    if (typeof error.code === 'string' && error.code.startsWith('FST_ERR_CTP')) {
      // Malformed JSON, empty JSON body, unsupported media type, body too large.
      return sendApiError(request, reply, validation('body', 'type'));
    }
    request.log.error({ err: error.message, code: error.code }, 'Community internal error');
    return sendApiError(request, reply, new ApiError('internal_error'));
  });

  registerAuthRoutes(server, ctx);
  registerMeRoutes(server, ctx);
  registerContentRoutes(server, ctx);
  registerNotificationRoutes(server, ctx);
  registerModerationRoutes(server, ctx);

  // Every other auth/community path: 404 in the contract envelope. Password reset, email change,
  // phone sign-in and Better Auth's own endpoints therefore do not exist.
  for (const url of ['/v1/auth/*', '/v1/community/*']) {
    server.route({
      method: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
      url,
      handler: async () => {
        throw new ApiError('not_found');
      },
    });
  }
}
