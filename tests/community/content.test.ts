/**
 * Member surface (contract §7–§11): profile rules, spaces, posts, single-level comments,
 * deletes, reports (incl. duplicate detection), notifications, cursor pagination, idempotency,
 * the allowlist gate, prohibited keys and the "no author identity in member payloads" rule.
 */
import { randomUUID } from 'crypto';
import { LightMyRequestResponse } from 'fastify';
import {
  bearer,
  CommunityTestApp,
  createCommunityApp,
  describeDb,
  idem,
  memberWithProfile,
  ownerQuery,
  privilegedUser,
  resetDatabase,
  setProfile,
  signIn,
  SignedIn,
  uniqueEmail,
} from './helpers';

const FORBIDDEN_MEMBER_KEYS = [
  'author_id',
  'author_account_id',
  'account_id',
  'user_id',
  'accountable_identity',
  'author_email',
  'email',
  'reporter_id',
  'parent_comment_id',
];

const keysDeep = (value: unknown, out: string[] = []): string[] => {
  if (Array.isArray(value)) value.forEach(v => keysDeep(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      keysDeep(v, out);
    }
  }
  return out;
};

const expectNoIdentity = (res: LightMyRequestResponse, ...ids: string[]): void => {
  const keys = keysDeep(res.json());
  for (const k of FORBIDDEN_MEMBER_KEYS) expect(keys).not.toContain(k);
  for (const id of ids) expect(res.body).not.toContain(id);
};

describeDb('member surface', () => {
  let app: CommunityTestApp;
  let alice: SignedIn;
  let bob: SignedIn;
  let carol: SignedIn;

  const post = (
    user: SignedIn,
    payload: Record<string, unknown>,
    headers: Record<string, string> = idem(),
    space = 'general_health',
  ): Promise<LightMyRequestResponse> =>
    app.server.inject({
      method: 'POST',
      url: `/v1/community/spaces/${space}/posts`,
      headers: { ...bearer(user.accessToken), ...headers },
      payload,
    });

  const comment = (
    user: SignedIn,
    postId: string,
    payload: Record<string, unknown>,
    headers: Record<string, string> = idem(),
  ): Promise<LightMyRequestResponse> =>
    app.server.inject({
      method: 'POST',
      url: `/v1/community/posts/${postId}/comments`,
      headers: { ...bearer(user.accessToken), ...headers },
      payload,
    });

  const get = (user: SignedIn, url: string): Promise<LightMyRequestResponse> =>
    app.server.inject({ method: 'GET', url, headers: bearer(user.accessToken) });

  beforeAll(async () => {
    await resetDatabase();
    app = await createCommunityApp();
    alice = await memberWithProfile(app, 'alice', 'SunnyMum');
    bob = await memberWithProfile(app, 'bob', 'BobTheBuilder');
    carol = await memberWithProfile(app, 'carol', 'Carol_C');
  });
  afterAll(async () => app.close());

  describe('allowlist gate', () => {
    it('a non-allowlisted account: /me works (community_allowed false), content is 403', async () => {
      const outsider = await signIn(app, uniqueEmail('outsider'));
      const me = await get(outsider, '/v1/community/me');
      expect(me.statusCode).toBe(200);
      expect(me.json()).toMatchObject({ community_allowed: false, profile: null });
      const spaces = await get(outsider, '/v1/community/spaces');
      expect(spaces.statusCode).toBe(403);
      expect(spaces.json().error.code).toBe('community_not_allowed');
      const features = await app.server.inject({
        method: 'GET',
        url: '/v1/features',
        headers: bearer(outsider.accessToken),
      });
      expect(features.json()).toEqual({ community: 'internal', community_allowed: false });
      // Data rights are not gated.
      expect((await get(outsider, '/v1/community/me/export')).statusCode).toBe(200);
    });

    it('/v1/features: allowlisted ⇒ allowed; signed out ⇒ not; no-store', async () => {
      const signedIn = await app.server.inject({
        method: 'GET',
        url: '/v1/features',
        headers: bearer(alice.accessToken),
      });
      expect(signedIn.json()).toEqual({ community: 'internal', community_allowed: true });
      expect(signedIn.headers['cache-control']).toBe('no-store');
      const anon = await app.server.inject({ method: 'GET', url: '/v1/features' });
      expect(anon.json()).toEqual({ community: 'internal', community_allowed: false });
    });
  });

  describe('profile (M2/M3)', () => {
    it('GET /me/profile is 404 until a profile exists', async () => {
      const fresh = await signIn(app, uniqueEmail('noprofile'));
      app.config.allowlist.add(fresh.userId);
      expect((await get(fresh, '/v1/community/me/profile')).statusCode).toBe(404);
      expect((await setProfile(app, fresh, 'Fresh Name')).statusCode).toBe(200);
      expect((await get(fresh, '/v1/community/me/profile')).json()).toEqual({
        display_name: 'Fresh Name',
        professional: null,
      });
    });

    it.each([
      ['ab', 'min_length'],
      ['x'.repeat(31), 'max_length'],
      [' lead', 'pattern'],
      ['trail ', 'pattern'],
      ['two  spaces', 'pattern'],
      ['bad!char', 'pattern'],
      ['call 0803123456', 'not_allowed_value'],
      ['john.doe.gmail.com', 'not_allowed_value'],
    ])('rejects display_name %p (%s)', async (name, rule) => {
      const res = await setProfile(app, alice, name);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.details).toEqual({ field: 'display_name', rule });
    });

    it('display names are unique case-insensitively: 409 conflict display_name_taken', async () => {
      const res = await setProfile(app, bob, 'sunnymum');
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatchObject({
        code: 'conflict',
        details: { reason: 'display_name_taken' },
      });
    });

    it('a profile is required to post, comment or claim (422 profile_required)', async () => {
      const fresh = await signIn(app, uniqueEmail('noprof2'));
      app.config.allowlist.add(fresh.userId);
      const res = await post(fresh, { body: 'hi', display_mode: 'pseudonymous' });
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toMatchObject({
        code: 'invalid_state',
        details: { reason: 'profile_required' },
      });
    });
  });

  describe('spaces and posts', () => {
    it('lists exactly the two spaces', async () => {
      const res = await get(alice, '/v1/community/spaces');
      expect(res.json().items.map((s: { id: string }) => s.id)).toEqual([
        'general_health',
        'pregnancy_maternal',
      ]);
      expect(res.json().items[1].name).toBe('Pregnancy and Maternal Health');
    });

    it('creates a named post: 201 full Post DTO, body trimmed, Location header', async () => {
      const res = await post(alice, { body: '  First post  ', display_mode: 'named' });
      expect(res.statusCode).toBe(201);
      expect(res.headers.location).toBe(`/v1/community/posts/${res.json().id}`);
      expect(res.json()).toMatchObject({
        space_id: 'general_health',
        body: 'First post',
        author: { display_mode: 'named', display_name: 'SunnyMum', badge: null },
        viewer_is_author: true,
        status: 'visible',
        comment_count: 0,
      });
      expectNoIdentity(res, alice.userId, alice.email);
    });

    it('a pseudonymous post shows no name, no badge and no id to anyone (author stored)', async () => {
      const res = await post(alice, { body: 'secret question', display_mode: 'pseudonymous' });
      const id = res.json().id;
      const asBob = await get(bob, `/v1/community/posts/${id}`);
      expect(asBob.json().author).toEqual({
        display_mode: 'pseudonymous',
        display_name: null,
        badge: null,
      });
      expect(asBob.json().viewer_is_author).toBe(false);
      expectNoIdentity(asBob, alice.userId, alice.email, 'SunnyMum');
      const [row] = (await ownerQuery(`SELECT author_id FROM posts WHERE id = $1`, [id])) as {
        author_id: string;
      }[];
      expect(row.author_id).toBe(alice.userId);
    });

    it.each([
      [{ body: 'x' }, 'display_mode', 'required'],
      [{ display_mode: 'named' }, 'body', 'required'],
      [{ body: 'x', display_mode: 'anonymous' }, 'display_mode', 'enum'],
      [{ body: 'x'.repeat(2001), display_mode: 'named' }, 'body', 'max_length'],
      [{ body: '   ', display_mode: 'named' }, 'body', 'min_length'],
      [{ body: 'x', display_mode: 'named', title: 't' }, 'title', 'unknown_field'],
      [{ body: 'x', display_mode: 'named', image_url: 'u' }, 'image_url', 'unknown_field'],
    ])('rejects %j (%s %s)', async (payload, field, rule) => {
      const res = await post(alice, payload);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatchObject({
        code: 'validation_failed',
        details: { field, rule },
      });
      expect(res.json().error).not.toHaveProperty('statusCode');
    });

    it('unknown space ⇒ 404; malformed post id ⇒ 404 (not 400)', async () => {
      expect(
        (await post(alice, { body: 'x', display_mode: 'named' }, idem(), 'mental_health'))
          .statusCode,
      ).toBe(404);
      expect((await get(alice, '/v1/community/spaces/mental_health/posts')).statusCode).toBe(404);
      expect((await get(alice, '/v1/community/posts/not-a-uuid')).statusCode).toBe(404);
      expect((await get(alice, `/v1/community/posts/${randomUUID()}`)).statusCode).toBe(404);
    });

    it('Idempotency-Key: required; same key+body replays; different body ⇒ 422', async () => {
      const missing = await post(alice, { body: 'no key', display_mode: 'named' }, {});
      expect(missing.statusCode).toBe(400);
      expect(missing.json().error.details).toEqual({ field: 'Idempotency-Key', rule: 'required' });

      const key = { 'idempotency-key': randomUUID() };
      const first = await post(alice, { body: 'once', display_mode: 'named' }, key);
      const replay = await post(alice, { display_mode: 'named', body: 'once' }, key);
      expect(first.statusCode).toBe(201);
      expect(replay.statusCode).toBe(201);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.json().id).toBe(first.json().id);
      const [count] = (await ownerQuery(
        `SELECT count(*)::int AS n FROM posts WHERE body = 'once'`,
      )) as {
        n: number;
      }[];
      expect(count.n).toBe(1);

      const reused = await post(alice, { body: 'different', display_mode: 'named' }, key);
      expect(reused.statusCode).toBe(422);
      expect(reused.json().error.code).toBe('idempotency_key_reused');
    });

    it('cursor pagination: newest first, stable, limit 1..50, bad cursor 400', async () => {
      const space = 'pregnancy_maternal';
      const ids: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        ids.push(
          (await post(bob, { body: `p${i}`, display_mode: 'named' }, idem(), space)).json().id,
        );
      }
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const url = `/v1/community/spaces/${space}/posts?limit=2${cursor ? `&cursor=${cursor}` : ''}`;
        const res = await get(bob, url);
        expect(res.statusCode).toBe(200);
        seen.push(...res.json().items.map((p: { id: string }) => p.id));
        cursor = res.json().next_cursor;
      } while (cursor);
      expect(seen).toEqual([...ids].reverse());

      for (const q of ['limit=0', 'limit=51', 'limit=abc', 'cursor=@@@', 'cursor=eyJsIjoieCJ9']) {
        const res = await get(bob, `/v1/community/spaces/${space}/posts?${q}`);
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe('validation_failed');
      }
      // A cursor from another list is rejected.
      const other = await get(bob, `/v1/community/spaces/${space}/posts?limit=1`);
      const foreign = await get(
        bob,
        `/v1/community/notifications?cursor=${other.json().next_cursor}`,
      );
      expect(foreign.statusCode).toBe(400);
    });

    it('delete own post ⇒ 204 and body erased; another member ⇒ 403; then 404 for all', async () => {
      const id = (await post(alice, { body: 'to delete', display_mode: 'named' })).json().id;
      const notMine = await app.server.inject({
        method: 'DELETE',
        url: `/v1/community/posts/${id}`,
        headers: bearer(bob.accessToken),
      });
      expect(notMine.statusCode).toBe(403);
      const mine = await app.server.inject({
        method: 'DELETE',
        url: `/v1/community/posts/${id}`,
        headers: bearer(alice.accessToken),
      });
      expect(mine.statusCode).toBe(204);
      expect((await get(alice, `/v1/community/posts/${id}`)).statusCode).toBe(404);
      const [row] = (await ownerQuery(`SELECT body, status FROM posts WHERE id = $1`, [id])) as {
        body: string | null;
        status: string;
      }[];
      expect(row).toEqual({ body: null, status: 'deleted_by_author' });
    });
  });

  describe('comments (single level) and notifications', () => {
    let postId: string;
    beforeAll(async () => {
      postId = (await post(alice, { body: 'Ask me', display_mode: 'named' })).json().id;
    });

    it('creates a comment (201 Comment DTO); parent_comment_id is rejected', async () => {
      const res = await comment(bob, postId, { body: ' reply ', display_mode: 'named' });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({
        post_id: postId,
        body: 'reply',
        author: { display_mode: 'named', display_name: 'BobTheBuilder' },
        viewer_is_author: true,
        status: 'visible',
      });
      expectNoIdentity(res, bob.userId);
      const nested = await comment(bob, postId, {
        body: 'nested',
        display_mode: 'named',
        parent_comment_id: res.json().id,
      });
      expect(nested.statusCode).toBe(400);
      expect(nested.json().error.details).toEqual({
        field: 'parent_comment_id',
        rule: 'unknown_field',
      });
      expect(
        (await comment(bob, postId, { body: 'x'.repeat(1001), display_mode: 'named' })).statusCode,
      ).toBe(400);
    });

    it('lists comments oldest first; posts are not embedded with comments', async () => {
      await comment(carol, postId, { body: 'second', display_mode: 'pseudonymous' });
      const list = await get(alice, `/v1/community/posts/${postId}/comments`);
      expect(list.json().items.map((c: { body: string }) => c.body)).toEqual(['reply', 'second']);
      expectNoIdentity(list, bob.userId, carol.userId);
      const detail = await get(alice, `/v1/community/posts/${postId}`);
      expect(detail.json()).not.toHaveProperty('comments');
      expect(detail.json().comment_count).toBe(2);
    });

    it('notifies the post author (reply_to_post) and earlier commenters (comment_reply)', async () => {
      const aliceN = await get(alice, '/v1/community/notifications');
      expect(aliceN.statusCode).toBe(200);
      const types = aliceN.json().items.map((n: { type: string }) => n.type);
      expect(types.filter((t: string) => t === 'reply_to_post')).toHaveLength(2);
      expect(aliceN.json().unread_count).toBeGreaterThanOrEqual(2);
      expectNoIdentity(aliceN, bob.userId, carol.userId);
      const bobN = await get(bob, '/v1/community/notifications');
      const replies = bobN.json().items.filter((n: { type: string }) => n.type === 'comment_reply');
      expect(replies).toHaveLength(1);
      expect(replies[0]).toMatchObject({ post_id: postId, notice: null, read_at: null });
      // At most one unread comment_reply per post per recipient.
      await comment(carol, postId, { body: 'third', display_mode: 'named' });
      const bobAgain = await get(bob, '/v1/community/notifications');
      expect(
        bobAgain.json().items.filter((n: { type: string }) => n.type === 'comment_reply'),
      ).toHaveLength(1);
    });

    it('C7(d): comment_reply skips suspended, deleted and hidden-comment authors (restricted still told)', async () => {
      const op = await memberWithProfile(app, 'c7op', 'C7Poster');
      const target = (await post(op, { body: 'C7(d) thread', display_mode: 'named' })).json()
        .id as string;
      const commenters: Record<string, SignedIn> = {};
      for (const label of [
        'visible',
        'hidden',
        'ownDeleted',
        'suspended',
        'deleted',
        'restricted',
      ]) {
        commenters[label] = await memberWithProfile(app, `c7${label}`, `C7${label}`);
      }
      const commentIds: Record<string, string> = {};
      for (const [label, user] of Object.entries(commenters)) {
        const res = await comment(user, target, { body: `from ${label}`, display_mode: 'named' });
        expect(res.statusCode).toBe(201);
        commentIds[label] = res.json().id;
      }
      // Each earlier commenter got their own reply notifications while the thread grew; start clean.
      await ownerQuery(`DELETE FROM notifications WHERE post_id = $1`, [target]);
      await ownerQuery(`UPDATE comments SET status = 'hidden' WHERE id = $1`, [commentIds.hidden]);
      const del = await app.server.inject({
        method: 'DELETE',
        url: `/v1/community/comments/${commentIds.ownDeleted}`,
        headers: bearer(commenters.ownDeleted.accessToken),
      });
      expect(del.statusCode).toBe(204);
      for (const [label, kind] of [
        ['suspended', 'suspended'],
        ['restricted', 'restricted'],
      ] as const) {
        await ownerQuery(
          `INSERT INTO account_restrictions (user_id, kind, reason, created_by)
           VALUES ($1, $2, 'C7(d) test restriction', $3)`,
          [commenters[label].userId, kind, op.userId],
        );
      }
      const gone = await app.server.inject({
        method: 'POST',
        url: '/v1/community/me/delete',
        headers: bearer(commenters.deleted.accessToken),
        payload: { confirm: 'DELETE MY ACCOUNT' },
      });
      expect(gone.statusCode).toBe(204);

      const newcomer = await memberWithProfile(app, 'c7new', 'C7Newcomer');
      expect(
        (await comment(newcomer, target, { body: 'late reply', display_mode: 'named' })).statusCode,
      ).toBe(201);
      const notified = (
        (await ownerQuery(
          `SELECT user_id FROM notifications WHERE post_id = $1 AND type = 'comment_reply'`,
          [target],
        )) as { user_id: string }[]
      ).map(r => r.user_id);
      expect(notified.sort()).toEqual(
        [commenters.visible.userId, commenters.restricted.userId].sort(),
      );
      // The post author still gets reply_to_post; the newcomer is never told about their own reply.
      expect(notified).not.toContain(op.userId);
      expect(notified).not.toContain(newcomer.userId);
    });

    it('mark-read (own only, idempotent), unread-count and read-all', async () => {
      const list = (await get(bob, '/v1/community/notifications')).json();
      const id = list.items[0].id;
      const other = await app.server.inject({
        method: 'POST',
        url: `/v1/community/notifications/${id}/read`,
        headers: bearer(alice.accessToken),
      });
      expect(other.statusCode).toBe(404);
      for (let i = 0; i < 2; i += 1) {
        const res = await app.server.inject({
          method: 'POST',
          url: `/v1/community/notifications/${id}/read`,
          headers: bearer(bob.accessToken),
        });
        expect(res.statusCode).toBe(204);
      }
      expect((await get(bob, '/v1/community/notifications/unread-count')).json()).toEqual({
        unread_count: 0,
      });
      const all = await app.server.inject({
        method: 'POST',
        url: '/v1/community/notifications/read-all',
        headers: bearer(alice.accessToken),
      });
      expect(all.statusCode).toBe(204);
      expect(
        (await get(alice, '/v1/community/notifications/unread-count')).json().unread_count,
      ).toBe(0);
    });

    it('delete own comment ⇒ 204; not own ⇒ 403; hidden from the list afterwards', async () => {
      const c = (await comment(carol, postId, { body: 'oops', display_mode: 'named' })).json();
      const notMine = await app.server.inject({
        method: 'DELETE',
        url: `/v1/community/comments/${c.id}`,
        headers: bearer(bob.accessToken),
      });
      expect(notMine.statusCode).toBe(403);
      const mine = await app.server.inject({
        method: 'DELETE',
        url: `/v1/community/comments/${c.id}`,
        headers: bearer(carol.accessToken),
      });
      expect(mine.statusCode).toBe(204);
      const list = await get(alice, `/v1/community/posts/${postId}/comments`);
      expect(list.json().items.map((x: { id: string }) => x.id)).not.toContain(c.id);
    });
  });

  describe('reports', () => {
    let postId: string;
    beforeAll(async () => {
      postId = (await post(alice, { body: 'reportable', display_mode: 'named' })).json().id;
    });

    const report = (
      user: SignedIn,
      payload: Record<string, unknown>,
      headers = idem(),
    ): Promise<LightMyRequestResponse> =>
      app.server.inject({
        method: 'POST',
        url: '/v1/community/reports',
        headers: { ...bearer(user.accessToken), ...headers },
        payload,
      });

    it('creates a report (201 {id, status: open, created_at}); empty note ⇒ null', async () => {
      const res = await report(bob, {
        target_type: 'post',
        target_id: postId,
        reason: 'misinformation',
        note: '   ',
      });
      expect(res.statusCode).toBe(201);
      expect(Object.keys(res.json()).sort()).toEqual(['created_at', 'id', 'status']);
      const [row] = (await ownerQuery(`SELECT note FROM reports WHERE id = $1`, [
        res.json().id,
      ])) as {
        note: string | null;
      }[];
      expect(row.note).toBeNull();
    });

    it('duplicate open report by the same account ⇒ 409 duplicate_report', async () => {
      const res = await report(bob, { target_type: 'post', target_id: postId, reason: 'spam' });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.details).toEqual({ reason: 'duplicate_report' });
      // A different reporter is fine.
      expect(
        (await report(carol, { target_type: 'post', target_id: postId, reason: 'spam' }))
          .statusCode,
      ).toBe(201);
    });

    it('uses the contract reason enum and note limit; missing/hidden targets are 404', async () => {
      expect(
        (await report(bob, { target_type: 'post', target_id: postId, reason: 'self_harm' }))
          .statusCode,
      ).toBe(400);
      expect(
        (
          await report(bob, {
            target_type: 'post',
            target_id: postId,
            reason: 'other',
            note: 'x'.repeat(501),
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (await report(bob, { target_type: 'post', target_id: randomUUID(), reason: 'spam' }))
          .statusCode,
      ).toBe(404);
      expect(
        (await report(bob, { target_type: 'comment', target_id: 'nope', reason: 'spam' }))
          .statusCode,
      ).toBe(404);
    });

    it('a restricted account may still report (safety exception) but not post', async () => {
      const mod = await privilegedUser(app, 'restrictor', 'moderator');
      const dave = await memberWithProfile(app, 'dave');
      const restrict = await app.server.inject({
        method: 'POST',
        url: `/v1/community/mod/accounts/${dave.userId}/restrict`,
        headers: bearer(mod.accessToken),
        payload: { reason: 'cooling off period for a week' },
      });
      expect(restrict.statusCode).toBe(200);
      const me = (await get(dave, '/v1/community/me')).json();
      expect(me.status).toBe('restricted');
      const write = await post(dave, { body: 'still here', display_mode: 'named' });
      expect(write.statusCode).toBe(403);
      expect(write.json().error.code).toBe('account_restricted');
      expect(
        (await report(dave, { target_type: 'post', target_id: postId, reason: 'harassment' }))
          .statusCode,
      ).toBe(201);
    });
  });

  describe('professional claim (M4–M6)', () => {
    it('claim → pending (no status input), 409 while active, withdraw is audited', async () => {
      const claim = (payload: Record<string, unknown>): Promise<LightMyRequestResponse> =>
        app.server.inject({
          method: 'POST',
          url: '/v1/community/me/professional-claim',
          headers: { ...bearer(carol.accessToken), ...idem() },
          payload,
        });
      const withStatus = await claim({ profession: 'Midwife', status: 'verified' });
      expect(withStatus.statusCode).toBe(400);
      expect(withStatus.json().error.details).toEqual({ field: 'status', rule: 'unknown_field' });
      const res = await claim({ profession: 'Midwife', specialty: 'Antenatal care' });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({
        status: 'pending',
        verified_at: null,
        specialty: 'Antenatal care',
      });
      expect((await claim({ profession: 'Nurse' })).json().error.details).toEqual({
        reason: 'claim_exists',
      });
      expect((await get(carol, '/v1/community/me/professional-claim')).json().id).toBe(
        res.json().id,
      );
      // A pending claim never shows a badge.
      const p = await post(carol, { body: 'advice?', display_mode: 'named' });
      expect(p.json().author.badge).toBeNull();
      const del = await app.server.inject({
        method: 'DELETE',
        url: '/v1/community/me/professional-claim',
        headers: bearer(carol.accessToken),
      });
      expect(del.statusCode).toBe(204);
      const again = await app.server.inject({
        method: 'DELETE',
        url: '/v1/community/me/professional-claim',
        headers: bearer(carol.accessToken),
      });
      expect(again.json().error.details).toEqual({ reason: 'no_active_claim' });
      const audit = (await ownerQuery(
        `SELECT actor_account_id, reason FROM moderation_actions WHERE action = 'withdraw_professional' AND target_id = $1`,
        [res.json().id],
      )) as { actor_account_id: string; reason: string }[];
      expect(audit).toEqual([{ actor_account_id: carol.userId, reason: 'withdrawn by user' }]);
    });
  });

  describe('data-safety: prohibited (assessment) keys', () => {
    const ROUTES: [string, string, Record<string, unknown>][] = [
      ['POST', '/v1/community/spaces/general_health/posts', { body: 'x', display_mode: 'named' }],
      [
        'POST',
        '/v1/community/posts/00000000-0000-4000-8000-000000000000/comments',
        { body: 'x', display_mode: 'named' },
      ],
      [
        'POST',
        '/v1/community/reports',
        { target_type: 'post', target_id: randomUUID(), reason: 'spam' },
      ],
      ['PUT', '/v1/community/me/profile', { display_name: 'Valid Name' }],
      ['POST', '/v1/community/me/professional-claim', { profession: 'Nurse' }],
      ['POST', '/v1/community/me/delete', { confirm: 'DELETE MY ACCOUNT' }],
      ['POST', '/v1/auth/otp/request', { email: 'a@example.test' }],
      [
        'POST',
        '/v1/auth/refresh',
        { refresh_token: `wprt_${'a'.repeat(43)}`, device_id: randomUUID() },
      ],
      [
        'POST',
        '/v1/community/mod/identity/reveal',
        { target_type: 'post', target_id: randomUUID(), reason: 'a valid reason' },
      ],
    ];
    const KEYS = [
      'symptoms',
      'symptom_ids',
      'answers',
      'assessment_id',
      'triage_level',
      'urgency',
      'red_flags',
      'diagnosis',
      'differential',
      'condition_ids',
      'care_recommendation',
      'engine_version',
      'artifact_version',
    ];

    it.each(ROUTES)(
      '%s %s rejects every prohibited key (top-level and nested)',
      async (method, url, base) => {
        for (const key of KEYS) {
          for (const payload of [
            { ...base, [key]: 1 },
            { ...base, meta: { deep: [{ [key]: 1 }] } },
          ]) {
            const res = await app.server.inject({
              method: method as 'POST' | 'PUT',
              url,
              headers: { ...bearer(alice.accessToken), ...idem() },
              payload,
            });
            expect(res.statusCode).toBe(400);
            expect(res.json().error.details.rule).toBe('prohibited_key');
            expect(res.body).not.toContain('"1"');
          }
        }
      },
    );

    it('query-string keys are checked too, and the rejection is logged without values', async () => {
      app.logs.clear();
      const res = await get(alice, '/v1/community/spaces?triage_result=red');
      expect(res.statusCode).toBe(400);
      expect(res.json().error.details).toEqual({ field: 'triage_result', rule: 'prohibited_key' });
      const text = app.logs.text();
      expect(text).toContain('community_prohibited_key_rejected');
      expect(text).not.toContain('red"');
    });
  });

  describe('contract headers and envelope', () => {
    it('every Community response is no-store and carries X-Request-Id (client id echoed if valid)', async () => {
      const res = await app.server.inject({
        method: 'GET',
        url: '/v1/community/spaces',
        headers: { ...bearer(alice.accessToken), 'x-request-id': 'abcDEF12_-x' },
      });
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['x-request-id']).toBe('abcDEF12_-x');
      const bad = await app.server.inject({
        method: 'GET',
        url: '/v1/community/nope',
        headers: { 'x-request-id': 'bad id!' },
      });
      expect(bad.statusCode).toBe(404);
      expect(bad.headers['x-request-id']).not.toBe('bad id!');
      expect(bad.json().error.request_id).toBe(bad.headers['x-request-id']);
    });

    it('malformed JSON maps to validation_failed (contract envelope, no statusCode key)', async () => {
      const res = await app.server.inject({
        method: 'PUT',
        url: '/v1/community/me/profile',
        headers: { ...bearer(alice.accessToken), 'content-type': 'application/json' },
        payload: '{"display_name":',
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('validation_failed');
      expect(res.json().error).not.toHaveProperty('statusCode');
    });
  });
});
