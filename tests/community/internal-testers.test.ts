/**
 * F-077: COMMUNITY_INTERNAL_TESTER_EMAILS. In `internal` mode only, a signed-in account whose
 * server-side email is verified and exactly equals an approved address is allowed, alongside the
 * account-id allowlist. Exact matches only; malformed configuration refuses to boot; the list
 * never leaves the server.
 */
import { randomBytes } from 'crypto';
import {
  loadCommunityConfig,
  normalizeTesterEmail,
  parseInternalTesterEmails,
} from '../../src/community/config';
import {
  bearer,
  CommunityTestApp,
  createCommunityApp,
  describeDb,
  ownerQuery,
  resetDatabase,
  signIn,
  SignedIn,
  uniqueEmail,
} from './helpers';

const secret = (): string => randomBytes(32).toString('base64url');
const baseEnv = (): Record<string, string> => ({
  COMMUNITY_MODE: 'internal',
  COMMUNITY_DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  BETTER_AUTH_SECRET: secret(),
  COMMUNITY_REFRESH_PEPPERS: `1:${secret()}`,
  NODE_ENV: 'test',
});

describe('COMMUNITY_INTERNAL_TESTER_EMAILS parsing', () => {
  it('trims, lower-cases, ignores empty entries and tolerates duplicates', () => {
    const set = parseInternalTesterEmails(
      '  Ada@Example.org , ,ada@example.org,,  bo.b+qa@mail.example.ng ',
      'internal',
    );
    expect([...set].sort()).toEqual(['ada@example.org', 'bo.b+qa@mail.example.ng']);
  });

  it('unset or blank → empty set (feature off)', () => {
    expect(parseInternalTesterEmails(undefined, 'internal').size).toBe(0);
    expect(parseInternalTesterEmails(' , , ', 'internal').size).toBe(0);
  });

  it.each([
    ['*@example.org'],
    ['*'],
    ['@example.org'],
    ['example.org'],
    ['ada@*.org'],
    ['ada@example'],
    ['ada@@example.org'],
    ['a da@example.org'],
    ['"ada"@example.org'],
    ['ada@example.org;bob@example.org'],
    ['ada..b@example.org'],
    ['ada?@example.org'],
    ['%@example.org.'],
  ])('rejects %j: refuses to boot (fail closed), without echoing the value', raw => {
    let message = '';
    try {
      parseInternalTesterEmails(`good@example.org,${raw}`, 'internal');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/COMMUNITY_INTERNAL_TESTER_EMAILS entry at position 2/);
    expect(message).not.toContain('example');
    expect(message).not.toContain('good');
  });

  it.each(['closed_beta', 'public'] as const)(
    'a non-empty list with COMMUNITY_MODE=%s refuses to boot',
    mode => {
      expect(() => parseInternalTesterEmails('ada@example.org', mode)).toThrow(
        /only allowed with COMMUNITY_MODE=internal/,
      );
    },
  );

  it('COMMUNITY_MODE=disabled ignores the list entirely (no Community at all)', () => {
    expect(
      loadCommunityConfig({
        COMMUNITY_MODE: 'disabled',
        COMMUNITY_INTERNAL_TESTER_EMAILS: 'ada@example.org',
      }),
    ).toEqual({ mode: 'disabled' });
  });

  it('loadCommunityConfig wires the parsed set (internal) and fails closed on a bad entry', () => {
    const config = loadCommunityConfig({
      ...baseEnv(),
      COMMUNITY_INTERNAL_TESTER_EMAILS: ' Ada@Example.org ',
    });
    expect(config.mode).toBe('internal');
    if (config.mode === 'disabled') throw new Error('unreachable');
    expect([...config.internalTesterEmails]).toEqual(['ada@example.org']);
    expect(() =>
      loadCommunityConfig({ ...baseEnv(), COMMUNITY_INTERNAL_TESTER_EMAILS: '*@example.org' }),
    ).toThrow(/position 1/);
    expect(() =>
      loadCommunityConfig({
        ...baseEnv(),
        COMMUNITY_MODE: 'closed_beta',
        COMMUNITY_INTERNAL_TESTER_EMAILS: 'ada@example.org',
      }),
    ).toThrow(/only allowed with COMMUNITY_MODE=internal/);
  });

  it('normalisation is trim + lower-case only', () => {
    expect(normalizeTesterEmail('  MiXeD@Example.ORG ')).toBe('mixed@example.org');
  });
});

describeDb('internal tester email access (F-077)', () => {
  let app: CommunityTestApp;
  let approvedUser: SignedIn;
  const approved = uniqueEmail('approved').toLowerCase();
  const approvedMixedCase = uniqueEmail('Mixed.Case');
  const listed = (): string[] => [approved, approvedMixedCase.toLowerCase()];

  const features = (user?: SignedIn) =>
    app.server.inject({
      method: 'GET',
      url: '/v1/features',
      headers: user ? bearer(user.accessToken) : {},
    });
  const spaces = (user: SignedIn) =>
    app.server.inject({
      method: 'GET',
      url: '/v1/community/spaces',
      headers: bearer(user.accessToken),
    });
  const grantEvents = async (userId: string): Promise<Array<{ detail: unknown }>> =>
    (await ownerQuery(
      `SELECT detail FROM auth_events WHERE event = 'internal_tester_access_granted' AND account_id = $1`,
      [userId],
    )) as Array<{ detail: unknown }>;
  const settle = () => new Promise(resolve => setTimeout(resolve, 150));

  beforeAll(async () => {
    await resetDatabase();
    app = await createCommunityApp({
      config: {
        // As the environment parser would produce it from a messy value.
        internalTesterEmails: parseInternalTesterEmails(
          ` ${approved.toUpperCase()} , ,${approvedMixedCase}, ${approved} `,
          'internal',
        ),
      },
    });
    approvedUser = await signIn(app, approved);
  });
  afterAll(async () => app.close());

  it('approved verified email → allowed, content readable, /me says allowed', async () => {
    const user = approvedUser;
    expect((await features(user)).json()).toEqual({
      community: 'internal',
      community_allowed: true,
    });
    expect((await spaces(user)).statusCode).toBe(200);
    const me = await app.server.inject({
      method: 'GET',
      url: '/v1/community/me',
      headers: bearer(user.accessToken),
    });
    expect(me.json()).toMatchObject({ community_allowed: true });
  });

  it('approved email signed in with different case → allowed', async () => {
    const user = await signIn(app, approvedMixedCase.toUpperCase());
    expect((await features(user)).json().community_allowed).toBe(true);
  });

  it('unapproved email → denied (features false, content 403)', async () => {
    const outsider = await signIn(app, uniqueEmail('outsider'));
    expect((await features(outsider)).json()).toEqual({
      community: 'internal',
      community_allowed: false,
    });
    const res = await spaces(outsider);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('community_not_allowed');
  });

  it('signed out → never allowed, even with the list set', async () => {
    expect((await features()).json()).toEqual({ community: 'internal', community_allowed: false });
  });

  it('an unverified email on the list cannot gain access', async () => {
    const email = uniqueEmail('unverified').toLowerCase();
    app.config.internalTesterEmails = new Set([...listed(), email]);
    const user = await signIn(app, email);
    expect((await features(user)).json().community_allowed).toBe(true);
    await ownerQuery(`UPDATE "user" SET "emailVerified" = false WHERE id = $1`, [user.userId]);
    expect((await features(user)).json().community_allowed).toBe(false);
    expect((await spaces(user)).statusCode).toBe(403);
  });

  it('wildcard-like and domain-only entries match nothing (Set lookup of the whole address)', async () => {
    const user = await signIn(app, uniqueEmail('domainmate'));
    const domain = user.email.split('@')[1];
    app.config.internalTesterEmails = new Set([
      `*@${domain}`,
      domain,
      `@${domain}`,
      `*${user.email.slice(1)}`,
      user.email.split('@')[0],
    ]);
    expect((await features(user)).json().community_allowed).toBe(false);
    expect((await spaces(user)).statusCode).toBe(403);
    app.config.internalTesterEmails = new Set(listed());
  });

  it('a non-internal mode never grants through the email list', async () => {
    const user = approvedUser;
    const mutable = app.config as { mode: string };
    try {
      mutable.mode = 'closed_beta';
      expect((await features(user)).json()).toEqual({
        community: 'closed_beta',
        community_allowed: false,
      });
      expect((await spaces(user)).statusCode).toBe(403);
    } finally {
      mutable.mode = 'internal';
    }
    expect((await features(user)).json().community_allowed).toBe(true);
  });

  it('the account-id allowlist still works, and both mechanisms coexist', async () => {
    const byId = await signIn(app, uniqueEmail('byid'));
    expect((await features(byId)).json().community_allowed).toBe(false);
    app.config.allowlist.add(byId.userId);
    expect((await features(byId)).json().community_allowed).toBe(true);

    const both = approvedUser;
    app.config.allowlist.add(both.userId);
    expect((await features(both)).json().community_allowed).toBe(true);
    app.config.allowlist.delete(both.userId);
    expect((await features(both)).json().community_allowed).toBe(true);

    // Removing the email keeps an id-allowlisted account allowed, and vice versa.
    app.config.internalTesterEmails = new Set<string>();
    expect((await features(byId)).json().community_allowed).toBe(true);
    expect((await features(both)).json().community_allowed).toBe(false);
    app.config.internalTesterEmails = new Set(listed());
    app.config.allowlist.delete(byId.userId);
    expect((await features(byId)).json().community_allowed).toBe(false);
  });

  it('first email-based access writes exactly one audit row, with no email in it', async () => {
    const email = uniqueEmail('audited').toLowerCase();
    app.config.internalTesterEmails = new Set([...listed(), email]);
    const user = await signIn(app, email);
    for (let i = 0; i < 5; i += 1) await features(user);
    await spaces(user);
    await settle();
    const rows = await grantEvents(user.userId);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(email);
    expect(JSON.stringify(rows)).not.toContain(email.split('@')[0]);

    // An id-allowlisted account is not logged as an email grant.
    const byId = await signIn(app, uniqueEmail('idonly'));
    app.config.allowlist.add(byId.userId);
    await features(byId);
    await settle();
    expect(await grantEvents(byId.userId)).toHaveLength(0);

    // A second process (fresh app, empty memory) does not duplicate the row.
    const second = await createCommunityApp({ config: { internalTesterEmails: new Set([email]) } });
    try {
      const again = await signIn(second, email);
      await second.server.inject({
        method: 'GET',
        url: '/v1/features',
        headers: bearer(again.accessToken),
      });
      await settle();
      expect(await grantEvents(user.userId)).toHaveLength(1);
    } finally {
      await second.close();
    }
  });

  it('the approved list is never exposed in responses or logs', async () => {
    const user = approvedUser;
    const outsider = await signIn(app, uniqueEmail('looker'));
    const bodies: string[] = [];
    for (const u of [user, outsider]) {
      for (const url of [
        '/v1/features',
        '/v1/community/me',
        '/v1/community/spaces',
        '/v1/community/me/export',
      ]) {
        const res = await app.server.inject({ method: 'GET', url, headers: bearer(u.accessToken) });
        bodies.push(JSON.stringify(res.headers), res.body);
      }
    }
    for (const url of ['/v1/features', '/health', '/config']) {
      const res = await app.server.inject({ method: 'GET', url });
      bodies.push(JSON.stringify(res.headers), res.body);
    }
    const others = listed().filter(e => e !== approved);
    const outsiderView = bodies.slice(8, 16).join('\n');
    for (const e of listed()) expect(outsiderView).not.toContain(e);
    const all = bodies.join('\n');
    for (const e of others) expect(all).not.toContain(e);
    const logs = app.logs.text();
    for (const e of listed()) {
      expect(logs).not.toContain(e);
      expect(logs).not.toContain(e.toUpperCase());
    }
    expect(logs).not.toContain('internalTesterEmails');
  });
});
