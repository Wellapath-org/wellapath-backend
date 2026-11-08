/**
 * `/v1/community/me*` — self, profile, professional claim, export and deletion (contract §7).
 * `GET /me`, export and delete are not allowlist-gated: data rights do not depend on the
 * allowlist.
 */
import { FastifyInstance } from 'fastify';
import { CommunityContext, trimmed, verificationDto } from '../context';
import { deleteUser, exportUser } from '../data-rights';
import { ApiError, conflict, invalidState, notFound, validation } from '../http';
import { hasRole } from '../tokens';

const DISPLAY_NAME = /^[A-Za-z0-9 _.-]+$/;
/**
 * Contract §7.2 (P7, founder-approved 2026-11-08), identical in the mobile client: a name is
 * email-like if it contains `@` or ends with `<letter|digit>.<common TLD>`.
 */
export const EMAIL_LIKE = /@|[A-Za-z0-9]\.(com|net|org|ng|io|co|uk|edu|gov|info|me|app)$/i;
/** 7 or more digits in total, anywhere in the name, reads as a phone number. */
export const MAX_DISPLAY_NAME_DIGITS = 6;

export const DISPLAY_NAME_MIN = 3;
export const DISPLAY_NAME_MAX = 30;

/**
 * Contract §7.2 (founder decision 2026-11-08), identical in the mobile client: leading and
 * trailing whitespace is removed first, and every rule runs on, and the server stores and
 * returns, the trimmed value. "Whitespace" is exactly what ECMAScript `String.prototype.trim`
 * removes (the mobile client implements the same set explicitly). Interior whitespace is not
 * touched: a tab or a run of 2+ spaces inside the name is still `pattern`.
 */
export const canonicalDisplayName = (raw: string): string => raw.trim();

/** Length of the trimmed value: empty or < 3 is `min_length`, > 30 is `max_length`. */
export const checkDisplayNameLength = (name: string): void => {
  if (name.length < DISPLAY_NAME_MIN) throw validation('display_name', 'min_length');
  if (name.length > DISPLAY_NAME_MAX) throw validation('display_name', 'max_length');
};

/**
 * The §7.2 content rules on the trimmed value, in the contract's order: contact-detail check
 * (400 not_allowed_value) first, then the character pattern (400 pattern).
 */
export const checkDisplayName = (name: string): void => {
  const digits = (name.match(/[0-9]/g) ?? []).length;
  if (digits > MAX_DISPLAY_NAME_DIGITS || EMAIL_LIKE.test(name)) {
    throw validation('display_name', 'not_allowed_value');
  }
  if (/ {2,}/.test(name) || !DISPLAY_NAME.test(name)) {
    throw validation('display_name', 'pattern');
  }
};

/** Every §7.2 rule, in order; returns the value to store. */
export const validateDisplayName = (raw: string): string => {
  const name = canonicalDisplayName(raw);
  checkDisplayNameLength(name);
  checkDisplayName(name);
  return name;
};

export const registerMeRoutes = (server: FastifyInstance, ctx: CommunityContext): void => {
  const { s } = ctx;

  // M1
  server.get('/v1/community/me', async (request, reply) => {
    const principal = await ctx.authenticate(request, reply);
    return reply.send(await ctx.me(principal));
  });

  // M2
  server.get('/v1/community/me/profile', async (request, reply) => {
    const principal = await ctx.member(request, reply);
    const profile = await ctx.profile(principal.userId);
    if (!profile) throw notFound();
    return reply.send(profile);
  });

  // M3
  server.put(
    '/v1/community/me/profile',
    {
      schema: {
        body: {
          type: 'object',
          required: ['display_name'],
          additionalProperties: false,
          properties: {
            display_name: {
              type: 'string',
              // Length (3–30) is checked on the TRIMMED value, below; the character pattern in
              // checkDisplayName, after the email-like check, so an email address is
              // `not_allowed_value` (P7), not `pattern`.
            },
          },
        },
      },
    },
    async (request, reply) => {
      // Trim, then the length check: request validation, so it still runs before
      // authentication (C7(c)), where the schema's minLength/maxLength used to.
      const display_name = canonicalDisplayName(
        (request.body as { display_name: string }).display_name,
      );
      checkDisplayNameLength(display_name);
      const principal = await ctx.member(request, reply, { defaultLimit: false });
      ctx.assertNotRestricted(principal);
      await ctx.limit(reply, [{ name: 'put_profile_hour', key: principal.userId }]);
      checkDisplayName(display_name);
      try {
        await s.pool.query(
          `INSERT INTO profiles (user_id, display_name) VALUES ($1, $2)
           ON CONFLICT (user_id) DO UPDATE SET display_name = EXCLUDED.display_name, updated_at = now()`,
          [principal.userId, display_name],
        );
      } catch (error) {
        if ((error as { code?: string }).code === '23505') throw conflict('display_name_taken');
        throw error;
      }
      return reply.send(await ctx.profile(principal.userId));
    },
  );

  // M4
  server.get('/v1/community/me/professional-claim', async (request, reply) => {
    const principal = await ctx.member(request, reply);
    const { rows } = await s.pool.query(
      `SELECT id, profession, specialty, status, verified_at, created_at
         FROM professional_verifications WHERE user_id = $1
        ORDER BY (status IN ('pending', 'verified')) DESC, created_at DESC LIMIT 1`,
      [principal.userId],
    );
    if (!rows[0]) throw notFound();
    return reply.send(verificationDto(rows[0]));
  });

  // M5
  server.post(
    '/v1/community/me/professional-claim',
    {
      schema: {
        body: {
          type: 'object',
          required: ['profession'],
          // No `status` field: a claim always starts pending (sending one ⇒ unknown_field).
          additionalProperties: false,
          properties: {
            profession: { type: 'string', minLength: 2, maxLength: 80 },
            specialty: { type: 'string', minLength: 2, maxLength: 80 },
          },
        },
      },
    },
    async (request, reply) => {
      const principal = await ctx.member(request, reply, { defaultLimit: false });
      return ctx.idempotent(
        request,
        reply,
        principal,
        'POST /v1/community/me/professional-claim',
        {
          required: true,
          limits: [{ name: 'professional_claim_day', key: principal.userId }],
        },
        async () => {
          ctx.assertNotRestricted(principal);
          const body = request.body as { profession: string; specialty?: string };
          const profession = trimmed(body.profession, 'profession', 2, 80);
          const specialty =
            body.specialty === undefined ? null : trimmed(body.specialty, 'specialty', 2, 80);
          await ctx.requireProfile(principal.userId);
          try {
            const { rows } = await s.pool.query(
              `INSERT INTO professional_verifications (user_id, profession, specialty, status)
               VALUES ($1, $2, $3, 'pending')
               RETURNING id, profession, specialty, status, verified_at, created_at`,
              [principal.userId, profession, specialty],
            );
            return { status: 201, body: verificationDto(rows[0]) };
          } catch (error) {
            if ((error as { code?: string }).code === '23505') throw conflict('claim_exists');
            throw error;
          }
        },
      );
    },
  );

  // M6
  server.delete('/v1/community/me/professional-claim', async (request, reply) => {
    const principal = await ctx.member(request, reply);
    await ctx.tx(async client => {
      const { rows } = await client.query<{ id: string; status: string }>(
        `SELECT id, status FROM professional_verifications
          WHERE user_id = $1 AND status IN ('pending', 'verified') FOR UPDATE`,
        [principal.userId],
      );
      if (!rows[0]) throw invalidState('no_active_claim');
      await client.query(
        `UPDATE professional_verifications
            SET status = 'revoked', verified_at = NULL, updated_at = now()
          WHERE id = $1`,
        [rows[0].id],
      );
      await ctx.audit(client, {
        actor: principal.userId,
        action: 'withdraw_professional',
        targetType: 'professional_verification',
        targetId: rows[0].id,
        reason: 'withdrawn by user',
        evidence: { previous_status: rows[0].status },
      });
    });
    return reply.status(204).send();
  });

  // M7
  server.get('/v1/community/me/export', async (request, reply) => {
    const principal = await ctx.authenticate(request, reply, { defaultLimit: false });
    await ctx.limit(reply, [{ name: 'export_day', key: principal.userId }]);
    const data = await exportUser(s.pool, principal.userId);
    if (!data) throw notFound();
    await s.events.record('data_exported', {
      accountId: principal.userId,
      familyId: principal.familyId,
    });
    return reply
      .header('content-disposition', 'attachment; filename="wellapath-community-export.json"')
      .send(data);
  });

  // M8
  server.post(
    '/v1/community/me/delete',
    {
      schema: {
        body: {
          type: 'object',
          required: ['confirm'],
          additionalProperties: false,
          properties: { confirm: { const: 'DELETE MY ACCOUNT' } },
        },
      },
    },
    async (request, reply) => {
      const principal = await ctx.authenticate(request, reply, { defaultLimit: false });
      await ctx.limit(reply, [{ name: 'deletion_day', key: principal.userId }]);
      // A moderator or admin must be demoted first (contract M8).
      if (hasRole(principal.role, 'moderator')) throw invalidState('privileged_account');
      const deleted = await deleteUser(s.pool, s.tokens, principal.userId);
      if (!deleted) throw new ApiError('not_found');
      await s.events.record('account_deleted', { accountId: principal.userId });
      return reply.status(204).send();
    },
  );
};
