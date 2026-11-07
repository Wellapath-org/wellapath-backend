/**
 * In-app notification centre (contract §11): polling only. A notification carries ids and a
 * notice code only — never an actor id, another member's text or a moderator's reason.
 */
import { FastifyInstance } from 'fastify';
import { CommunityContext } from '../context';
import { cursorTs, notFound, page, parsePage, requireUuid, ts, tsRequired } from '../http';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const notificationDto = (r: Record<string, any>): Record<string, unknown> => ({
  id: r.id,
  type: r.type,
  post_id: r.post_id,
  comment_id: r.comment_id,
  notice: r.notice,
  created_at: tsRequired(r.created_at),
  read_at: ts(r.read_at),
});

export const registerNotificationRoutes = (
  server: FastifyInstance,
  ctx: CommunityContext,
): void => {
  const { s } = ctx;

  const unread = async (userId: string): Promise<number> => {
    const { rows } = await s.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL`,
      [userId],
    );
    return rows[0].n;
  };

  // N1
  server.get('/v1/community/notifications', async (request, reply) => {
    const principal = await ctx.member(request, reply);
    const q = parsePage(request.query as Record<string, unknown>, 'notifications', ['t', 'id']);
    const { rows } = await s.pool.query(
      `SELECT id, type, post_id, comment_id, notice, created_at, read_at,
              ${cursorTs('created_at')} AS cursor_ts
         FROM notifications
        WHERE user_id = $1
          AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
        ORDER BY created_at DESC, id DESC LIMIT $4`,
      [principal.userId, q.cursor?.t ?? null, q.cursor?.id ?? null, q.limit + 1],
    );
    return reply.send({
      ...page(rows, q.limit, notificationDto, r => ({ t: r.cursor_ts, id: r.id }), 'notifications'),
      unread_count: await unread(principal.userId),
    });
  });

  // N2
  server.get('/v1/community/notifications/unread-count', async (request, reply) => {
    const principal = await ctx.member(request, reply);
    return reply.send({ unread_count: await unread(principal.userId) });
  });

  // N3 — idempotent; read_at is set the first time only. Not own ⇒ 404.
  server.post('/v1/community/notifications/:notification_id/read', async (request, reply) => {
    const principal = await ctx.member(request, reply);
    const id = requireUuid((request.params as { notification_id: string }).notification_id);
    const { rowCount } = await s.pool.query(
      `UPDATE notifications SET read_at = COALESCE(read_at, now())
        WHERE id = $1 AND user_id = $2`,
      [id, principal.userId],
    );
    if (!rowCount) throw notFound();
    return reply.status(204).send();
  });

  // N4
  server.post('/v1/community/notifications/read-all', async (request, reply) => {
    const principal = await ctx.member(request, reply);
    await s.pool.query(
      `UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL`,
      [principal.userId],
    );
    return reply.status(204).send();
  });
};
