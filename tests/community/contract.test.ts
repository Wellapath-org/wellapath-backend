/**
 * OpenAPI contract conformance (COMMUNITY_API_CONTRACT change process §2: "an OpenAPI
 * response/request conformance test over every route in src/community/**").
 *
 * Loads docs/community/community_api_v1.openapi.yaml (a verbatim copy of the canonical
 * WELLAPATH_ENGINEERING file, sha-pinned in its header) and checks that:
 * 1. every operationId / path / method is implemented, and no other auth/community route
 *    exists (the excluded features have no endpoint);
 * 2. a scenario that calls EVERY operation gets a 2xx whose body validates against the
 *    operation's response schema (Ajv, JSON Schema 2020-12 + formats), with every request body
 *    sent also validating against the operation's request schema;
 * 3. representative error responses validate against the `Error` envelope.
 *
 * Proposed contract fix (recorded in POC_COMMUNITY_AUTH_RESULTS.md, Sprint 3): the YAML models
 * a mutating moderator response as `allOf: [ModerationAction, {target_status, …}]`, but
 * `ModerationAction` has `additionalProperties: false`, so NO object with `target_status` can
 * validate — while the markdown (§12, which wins) requires `ModerationAction + target_status`.
 * The test validates those responses against the evident intent: ModerationAction's properties
 * plus the optional `target_status` / `sessions_revoked` / `target_role`, nothing else.
 */
import { createHash, randomUUID } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { LightMyRequestResponse } from 'fastify';
import { parse } from 'yaml';
import { dirname, join } from 'path';
import {
  bearer,
  CommunityTestApp,
  createCommunityApp,
  describeDb,
  idem,
  memberWithProfile,
  ownerQuery,
  RELAXED_LIMITS,
  resetDatabase,
  setRole,
  signIn,
  SignedIn,
  totp,
  uniqueEmail,
} from './helpers';

// Ajv 8 (2020-12 dialect) and ajv-formats, resolved from where Fastify's own toolchain installs
// them — the top-level `ajv` in this repo is v6 (eslint's), which cannot read OpenAPI 3.1.
const formatsDir = dirname(require.resolve('ajv-formats/package.json'));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Ajv2020 = require(require.resolve('ajv/dist/2020', { paths: [formatsDir] })).default;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const addFormats = require('ajv-formats').default ?? require('ajv-formats');

const SPEC_PATH = join(__dirname, '../../docs/community/community_api_v1.openapi.yaml');
const CANONICAL = '/Users/iamjohnseyi/dev/wp/WELLAPATH_ENGINEERING/community_api_v1.openapi.yaml';

const raw = readFileSync(SPEC_PATH, 'utf8');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const spec = parse(raw) as any;
const METHODS = ['get', 'post', 'put', 'delete', 'patch'];

interface Operation {
  id: string;
  method: string;
  path: string;
  fastifyPath: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  op: any;
}

const operations: Operation[] = Object.entries(spec.paths).flatMap(([path, item]) =>
  Object.entries(item as Record<string, unknown>)
    .filter(([m]) => METHODS.includes(m))
    .map(([m, op]) => ({
      id: (op as { operationId: string }).operationId,
      method: m.toUpperCase(),
      path,
      fastifyPath: path.replace(/\{([a-z_]+)\}/g, ':$1'),
      op,
    })),
);

// ------------------------------------------------------------------ schema compilation

const MOD_RESULT = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'actor_account_id',
    'action',
    'target_type',
    'target_id',
    'reason',
    'created_at',
  ],
  properties: {
    ...spec.components.schemas.ModerationAction.properties,
    target_status: { type: 'string' },
    sessions_revoked: { type: 'integer' },
    target_role: { $ref: '#/components/schemas/Role' },
  },
};

const isModResult = (schema: { allOf?: { $ref?: string }[] }): boolean =>
  Array.isArray(schema?.allOf) && schema.allOf[0]?.$ref === '#/components/schemas/ModerationAction';

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ ...spec, $id: 'openapi' });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const compileRef = (schema: any): ((data: unknown) => boolean) & { errors?: unknown } => {
  const resolved = isModResult(schema) ? MOD_RESULT : schema;
  const rewrite = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(rewrite);
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node)) {
        out[k] = k === '$ref' && typeof v === 'string' ? `openapi${v}` : rewrite(v);
      }
      return out;
    }
    return node;
  };
  return ajv.compile(rewrite(resolved) as object);
};

const responseSchema = (op: Operation, status: number): unknown | undefined => {
  const r = op.op.responses[String(status)];
  if (!r) return undefined;
  const resolved = r.$ref ? spec.components.responses[r.$ref.split('/').pop()] : r;
  return resolved.content?.['application/json']?.schema;
};

const requestSchema = (op: Operation): unknown | undefined =>
  op.op.requestBody?.content?.['application/json']?.schema;

const errorValidator = compileRef({ $ref: '#/components/schemas/Error' });

// ------------------------------------------------------------------ the tests

describe('OpenAPI copy', () => {
  it('is the canonical file verbatim (sha pinned in the header)', () => {
    const pinned = /^# canonical-sha256: ([0-9a-f]{64})$/m.exec(raw)?.[1];
    const body = raw.split('\n').slice(7).join('\n');
    expect(createHash('sha256').update(body).digest('hex')).toBe(pinned);
    if (existsSync(CANONICAL)) {
      // Local runs next to the WELLAPATH_ENGINEERING checkout: the copy must be current.
      expect(readFileSync(CANONICAL, 'utf8')).toBe(body);
    }
  });

  it('declares 52 operations with unique operationIds', () => {
    expect(operations).toHaveLength(52);
    expect(new Set(operations.map(o => o.id)).size).toBe(52);
  });
});

describeDb('OpenAPI conformance (every operation)', () => {
  let app: CommunityTestApp;
  const seen = new Map<string, number>();
  const failures: string[] = [];

  const opById = (id: string): Operation => {
    const op = operations.find(o => o.id === id);
    if (!op) throw new Error(`unknown operation ${id}`);
    return op;
  };

  /** Calls an operation, validating the request body and the response body. */
  const call = async (
    id: string,
    opts: {
      user?: SignedIn;
      params?: Record<string, string>;
      query?: string;
      body?: Record<string, unknown>;
      headers?: Record<string, string>;
      expect?: number;
      /** A deliberately invalid request (negative test): skip request-schema validation. */
      invalid?: boolean;
    } = {},
  ): Promise<LightMyRequestResponse> => {
    const op = opById(id);
    if (opts.body !== undefined && !opts.invalid) {
      const reqSchema = requestSchema(op);
      if (reqSchema) {
        const v = compileRef(reqSchema);
        if (!v(opts.body)) failures.push(`${id} request: ${JSON.stringify(v.errors)}`);
      }
    }
    let url = op.path.replace(/\{([a-z_]+)\}/g, (_, k: string) => opts.params?.[k] ?? 'missing');
    if (opts.query) url += `?${opts.query}`;
    const res = await app.server.inject({
      method: op.method as 'GET',
      url,
      headers: { ...(opts.user ? bearer(opts.user.accessToken) : {}), ...(opts.headers ?? {}) },
      payload: opts.body,
    });
    if (opts.expect !== undefined && res.statusCode !== opts.expect) {
      failures.push(`${id}: expected ${opts.expect}, got ${res.statusCode} ${res.body}`);
    }
    if (res.statusCode >= 200 && res.statusCode < 300) {
      seen.set(id, res.statusCode);
      if (!op.op.responses[String(res.statusCode)]) {
        failures.push(`${id}: status ${res.statusCode} not declared`);
      }
      const schema = responseSchema(op, res.statusCode);
      if (schema) {
        const v = compileRef(schema);
        if (!v(res.json()))
          failures.push(`${id} response: ${JSON.stringify(v.errors)} ${res.body}`);
      } else if (res.body) {
        failures.push(`${id}: ${res.statusCode} must have no body, got ${res.body}`);
      }
    } else {
      if (!op.op.responses[String(res.statusCode)] && res.statusCode !== 404) {
        failures.push(`${id}: error status ${res.statusCode} not declared`);
      }
      if (!errorValidator(res.json())) {
        failures.push(`${id} error: ${JSON.stringify(errorValidator.errors)} ${res.body}`);
      }
    }
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-request-id']).toEqual(expect.any(String));
    return res;
  };

  beforeAll(async () => {
    await resetDatabase();
    app = await createCommunityApp({ config: { limitOverrides: RELAXED_LIMITS } });
  });
  afterAll(async () => app.close());

  it('implements exactly the operations in the spec (no extra auth/community routes)', () => {
    const registered = (app.server.communityRoutes ?? []).filter(r => !r.url.endsWith('/*'));
    const key = (m: string, u: string): string => `${m} ${u}`;
    const implemented = new Set(registered.map(r => key(r.method, r.url)));
    const declared = new Set(operations.map(o => key(o.method, o.fastifyPath)));
    for (const o of operations) {
      expect({ op: o.id, implemented: implemented.has(key(o.method, o.fastifyPath)) }).toEqual({
        op: o.id,
        implemented: true,
      });
    }
    for (const r of registered) {
      expect({ route: key(r.method, r.url), declared: declared.has(key(r.method, r.url)) }).toEqual(
        {
          route: key(r.method, r.url),
          declared: true,
        },
      );
    }
  });

  it('every operation returns a schema-valid 2xx in a full scenario; errors use the envelope', async () => {
    // ---------------------------------------------------------------- auth (member)
    await call('getFeatures', { expect: 200 });
    const email = uniqueEmail('contract');
    await call('requestOtp', { body: { email }, expect: 202 });
    const deviceId = randomUUID();
    const verified = await call('verifyOtp', {
      body: {
        email,
        code: app.outbox.latestOtp(email),
        device_id: deviceId,
        device_label: 'Pixel 7',
      },
      expect: 200,
    });
    let alice: SignedIn = {
      email,
      userId: verified.json().account.account_id,
      deviceId,
      accessToken: verified.json().access_token,
      refreshToken: verified.json().refresh_token,
      familyId: '',
    };
    app.config.allowlist.add(alice.userId);
    const rotated = await call('refreshTokens', {
      body: { refresh_token: alice.refreshToken, device_id: deviceId },
      expect: 200,
    });
    alice = {
      ...alice,
      accessToken: rotated.json().access_token,
      refreshToken: rotated.json().refresh_token,
    };
    await call('getFeatures', { user: alice, expect: 200 });
    await call('listSessions', { user: alice, expect: 200 });
    await call('revokeOtherSessions', { user: alice, body: {}, expect: 200 });

    // ---------------------------------------------------------------- self
    await call('getMe', { user: alice, expect: 200 });
    await call('getProfile', { user: alice, expect: 404 });
    await call('putProfile', {
      user: alice,
      body: { display_name: 'Contract Alice' },
      expect: 200,
    });
    await call('getProfile', { user: alice, expect: 200 });
    const claim = await call('claimProfession', {
      user: alice,
      headers: idem(),
      body: { profession: 'Midwife', specialty: 'Antenatal care' },
      expect: 201,
    });
    await call('getProfessionalClaim', { user: alice, expect: 200 });
    await call('getMe', { user: alice, expect: 200 }); // with profile + professional

    // ---------------------------------------------------------------- content
    const bob = await memberWithProfile(app, 'cbob');
    await call('listSpaces', { user: alice, expect: 200 });
    const post = await call('createPost', {
      user: alice,
      params: { space_id: 'general_health' },
      headers: idem(),
      body: { body: 'Contract post', display_mode: 'named' },
      expect: 201,
    });
    const postId = post.json().id;
    await call('createPost', {
      user: alice,
      params: { space_id: 'general_health' },
      headers: idem(),
      body: { body: 'Pseudonymous', display_mode: 'pseudonymous' },
      expect: 201,
    });
    await call('listPosts', {
      user: bob,
      params: { space_id: 'general_health' },
      query: 'limit=1',
      expect: 200,
    });
    await call('getPost', { user: bob, params: { post_id: postId }, expect: 200 });
    const comment = await call('createComment', {
      user: bob,
      params: { post_id: postId },
      headers: idem(),
      body: { body: 'Contract comment', display_mode: 'pseudonymous' },
      expect: 201,
    });
    const commentId = comment.json().id;
    await call('listComments', { user: alice, params: { post_id: postId }, expect: 200 });
    const report = await call('createReport', {
      user: bob,
      headers: idem(),
      body: {
        target_type: 'post',
        target_id: postId,
        reason: 'self_harm_or_emergency',
        note: 'worried',
      },
      expect: 201,
    });
    await call('createReport', {
      user: alice,
      headers: idem(),
      body: { target_type: 'comment', target_id: commentId, reason: 'spam' },
      expect: 201,
    });
    const notes = await call('listNotifications', { user: alice, expect: 200 });
    await call('unreadCount', { user: alice, expect: 200 });
    await call('markNotificationRead', {
      user: alice,
      params: { notification_id: notes.json().items[0].id },
      expect: 204,
    });
    await call('markAllNotificationsRead', { user: alice, expect: 204 });

    // ---------------------------------------------------------------- privileged accounts
    const mkPrivileged = async (label: string, role: 'moderator' | 'admin'): Promise<SignedIn> => {
      const first = await signIn(app, uniqueEmail(label));
      await setRole(first.userId, role);
      const user = await signIn(app, first.email);
      const enrol = await call('startTotpEnrolment', { user, body: {}, expect: 200 });
      const secret = enrol.json().secret_base32;
      await call('confirmTotpEnrolment', { user, body: { code: totp(secret) }, expect: 200 });
      await call('stepUpTotp', { user, body: { code: totp(secret) }, expect: 200 });
      return user;
    };
    const mod = await mkPrivileged('cmod', 'moderator');
    const admin = await mkPrivileged('cadmin', 'admin');

    // ---------------------------------------------------------------- moderation
    const queue = await call('listReports', { user: mod, expect: 200 });
    expect(queue.json().items[0].reason).toBe('self_harm_or_emergency');
    await call('listReports', { user: mod, query: 'status=dismissed', expect: 200 });
    await call('getReport', { user: mod, params: { report_id: report.json().id }, expect: 200 });
    await call('modGetPost', { user: mod, params: { post_id: postId }, expect: 200 });
    await call('modGetComment', { user: mod, params: { comment_id: commentId }, expect: 200 });
    await call('revealIdentity', {
      user: mod,
      body: { target_type: 'post', target_id: postId, reason: 'self-harm report follow-up' },
      expect: 200,
    });
    const R = { reason: 'violates the community guidelines' };
    await call('hidePost', { user: mod, params: { post_id: postId }, body: R, expect: 200 });
    await call('restorePost', { user: mod, params: { post_id: postId }, body: R, expect: 200 });
    await call('hideComment', {
      user: mod,
      params: { comment_id: commentId },
      body: R,
      expect: 200,
    });
    await call('restoreComment', {
      user: mod,
      params: { comment_id: commentId },
      body: R,
      expect: 200,
    });
    const other = await call('createPost', {
      user: bob,
      params: { space_id: 'pregnancy_maternal' },
      headers: idem(),
      body: { body: 'to be removed', display_mode: 'named' },
      expect: 201,
    });
    await call('removePost', {
      user: mod,
      params: { post_id: other.json().id },
      body: R,
      expect: 200,
    });
    const c2 = await call('createComment', {
      user: alice,
      params: { post_id: postId },
      headers: idem(),
      body: { body: 'remove me', display_mode: 'named' },
      expect: 201,
    });
    await call('removeComment', {
      user: mod,
      params: { comment_id: c2.json().id },
      body: R,
      expect: 200,
    });
    const toDismiss = await call('createReport', {
      user: bob,
      headers: idem(),
      body: { target_type: 'comment', target_id: commentId, reason: 'other' },
      expect: 201,
    });
    // (bob's comment reported by bob is allowed — no rule forbids reporting your own content)
    await call('dismissReport', {
      user: mod,
      params: { report_id: toDismiss.json().id },
      body: R,
      expect: 200,
    });
    const until = new Date(Date.now() + 86400_000).toISOString();
    await call('restrictAccount', {
      user: mod,
      params: { account_id: bob.userId },
      body: { ...R, until },
      expect: 200,
    });
    await call('reinstateAccount', {
      user: mod,
      params: { account_id: bob.userId },
      body: R,
      expect: 200,
    });
    const carol = await memberWithProfile(app, 'ccarol');
    await call('suspendAccount', {
      user: mod,
      params: { account_id: carol.userId },
      body: R,
      expect: 200,
    });
    await call('listModerationActions', { user: mod, query: 'limit=5', expect: 200 });
    await call('listModerationActions', {
      user: mod,
      query: `target_type=account&target_id=${bob.userId}`,
      expect: 200,
    });

    // ---------------------------------------------------------------- admin
    const dave = await memberWithProfile(app, 'cdave');
    await call('changeRole', {
      user: admin,
      params: { account_id: dave.userId },
      body: { role: 'moderator', reason: 'trusted volunteer moderator' },
      expect: 200,
    });
    const mod2 = await mkPrivileged('cmod2', 'moderator');
    await call('resetTotp', {
      user: admin,
      params: { account_id: mod2.userId },
      body: R,
      expect: 200,
    });
    await call('listVerifications', { user: admin, expect: 200 });
    await call('verifyProfessional', {
      user: admin,
      params: { verification_id: claim.json().id },
      body: { reason: 'licence checked with the council', evidence_ref: 'NMCN-1' },
      expect: 200,
    });
    await call('listVerifications', { user: admin, query: 'status=verified', expect: 200 });
    await call('getMe', { user: alice, expect: 200 }); // verified professional in Me
    await call('getPost', { user: bob, params: { post_id: postId }, expect: 200 }); // badge
    await call('revokeProfessional', {
      user: admin,
      params: { verification_id: claim.json().id },
      body: R,
      expect: 200,
    });
    await call('claimProfession', {
      user: alice,
      headers: idem(),
      body: { profession: 'Nurse' },
      expect: 201,
    });
    await call('withdrawProfessionalClaim', { user: alice, expect: 204 });

    // ---------------------------------------------------------------- member deletes, data rights
    await call('deleteOwnComment', { user: bob, params: { comment_id: commentId }, expect: 204 });
    await call('deleteOwnPost', { user: alice, params: { post_id: postId }, expect: 204 });
    await call('exportMyData', { user: alice, expect: 200 });
    const erin = await memberWithProfile(app, 'cerin');
    await call('deleteMyAccount', {
      user: erin,
      body: { confirm: 'DELETE MY ACCOUNT' },
      expect: 204,
    });
    await call('logout', { user: alice, body: { refresh_token: alice.refreshToken }, expect: 204 });

    // ---------------------------------------------------------------- representative errors
    await call('getMe', { expect: 401 });
    await call('getPost', { user: bob, params: { post_id: 'nope' }, expect: 404 });
    await call('createPost', {
      user: bob,
      params: { space_id: 'general_health' },
      headers: idem(),
      body: { body: 'x', display_mode: 'named', triage_level: 'red' },
      invalid: true,
      expect: 400,
    });
    await call('createReport', {
      user: bob,
      headers: idem(),
      body: { target_type: 'post', target_id: other.json().id, reason: 'spam' },
      expect: 404, // removed ⇒ not visible ⇒ 404
    });
    await call('listReports', { user: bob, expect: 403 });
    await call('refreshTokens', {
      body: { refresh_token: `wprt_${'z'.repeat(43)}`, device_id: randomUUID() },
      expect: 401,
    });
    await call('reinstateAccount', {
      user: mod,
      params: { account_id: bob.userId },
      body: R,
      expect: 422,
    });
    await call('startTotpEnrolment', { user: mod, body: {}, expect: 409 });

    expect(failures).toEqual([]);
    const missing = operations.map(o => o.id).filter(id => !seen.has(id));
    expect(missing).toEqual([]);
    // Make sure the test really exercised the owner query path once (sanity).
    expect(((await ownerQuery('SELECT 1 AS one')) as { one: number }[])[0].one).toBe(1);
  });
});
