/**
 * Three-role ownership model (ADR-001 B2): `community_owner` (NOLOGIN, owns everything),
 * `community_migrator` (LOGIN NOINHERIT, SET-only member of the owner) and the runtime role
 * `community_app` (member of nothing).
 *
 * Proves, on a real PostgreSQL 18:
 * - role attributes and the membership graph (no direct or transitive path app → owner/migrator);
 * - `community_app` gets SQLSTATE 42501 for SET ROLE owner/migrator, DISABLE TRIGGER, DROP
 *   TRIGGER, TRUNCATE, CREATE TABLE/SCHEMA/FUNCTION, ALTER FUNCTION, session_replication_role,
 *   and UPDATE/DELETE on both audit tables;
 * - the migrator cannot DDL, read or write anything until it explicitly `SET ROLE`s;
 * - migrations run down/up through the migrator (SET ROLE per transaction, RESET after) and every
 *   object they create is owned by `community_owner`;
 * - provisioning transfers a legacy database (tables owned by the branch owner) to the owner and
 *   the model verifies clean afterwards.
 *
 * Needs COMMUNITY_TEST_OWNER_ROLE and COMMUNITY_TEST_ADMIN_DATABASE_URL (see helpers.ts).
 */
import { randomBytes } from 'crypto';
import { Pool, PoolClient } from 'pg';
import {
  DEFAULT_ROLE_NAMES,
  generatePassword,
  ownershipModelReport,
  ownershipViolations,
  provisionCommunityRoles,
  roleReport,
  runtimeViolations,
} from '../../src/community/db-roles';
import {
  appliedVersions,
  loadMigrations,
  migrateDown,
  migrateUp,
} from '../../src/community/migrate';
import {
  ADMIN_URL,
  APP_URL,
  OWNER_ROLE,
  OWNER_URL,
  adminPool,
  appPool,
  migratorPool,
  ownerPool,
  resetDatabase,
} from './helpers';

const describeModel =
  OWNER_URL && ADMIN_URL && OWNER_ROLE && APP_URL && APP_URL !== OWNER_URL
    ? describe
    : describe.skip;

const { owner: OWNER, migrator: MIGRATOR, runtime: APP } = DEFAULT_ROLE_NAMES;
const OPTS = { ownerRole: OWNER };
const ALL = loadMigrations().map(m => m.version);

const sqlstate = async (pool: Pool, sql: string): Promise<string> => {
  try {
    await pool.query(sql);
    return 'ok';
  } catch (error) {
    return (error as { code?: string }).code ?? 'unknown';
  }
};

const withClient = async <T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> => {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
};

const ownersOf = async (pool: Pool): Promise<string[]> =>
  (
    await pool.query<{ o: string }>(
      `SELECT DISTINCT pg_get_userbyid(c.relowner) AS o FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'S', 'i')
       UNION
       SELECT DISTINCT pg_get_userbyid(p.proowner) FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
       UNION
       SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'public'`,
    )
  ).rows.map(r => r.o);

const noNewRoles = (): string => {
  throw new Error('Community roles must already exist (provisioned before the suite)');
};

describeModel('three-role ownership model (B2)', () => {
  let owner: Pool;
  let migrator: Pool;
  let app: Pool;
  let admin: Pool;

  beforeAll(async () => {
    await resetDatabase();
    owner = ownerPool();
    migrator = migratorPool();
    app = appPool();
    admin = adminPool();
    await withClient(admin, c => provisionCommunityRoles(c, { newPassword: noNewRoles }));
  });
  afterAll(async () => {
    await Promise.all([owner.end(), migrator.end(), app.end(), admin.end()]);
  });

  describe('roles and membership graph', () => {
    it('owner: NOLOGIN, no attributes, member of nothing, owns the schema and every object', async () => {
      const report = await withClient(admin, c => roleReport(c, OWNER));
      expect(report.attributes).toEqual({
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolinherit: false,
        rolreplication: false,
        rolbypassrls: false,
        rolcanlogin: false,
      });
      expect(report.memberships).toEqual([]);
      expect(await ownersOf(admin)).toEqual([OWNER]);
    });

    it('migrator: LOGIN NOINHERIT, only member of the owner with INHERIT FALSE, SET TRUE', async () => {
      const report = await withClient(admin, c => roleReport(c, MIGRATOR));
      expect(report.attributes).toEqual({
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolinherit: false,
        rolreplication: false,
        rolbypassrls: false,
        rolcanlogin: true,
      });
      expect(report.memberships).toEqual([
        { role: OWNER, admin_option: false, inherit_option: false, set_option: true },
      ]);
      // No privilege of its own on any Community table, schema CREATE or database CREATE/TEMP.
      for (const t of report.tables) {
        expect([t.table, Object.values(t.privileges).some(Boolean), t.anyColumnSelect]).toEqual([
          t.table,
          false,
          false,
        ]);
      }
      expect(report.schema.create).toBe(false);
      expect(report.database).toEqual({ connect: true, create: false, temporary: false });
    });

    it('app: member of nothing; no direct or transitive path to the owner or the migrator', async () => {
      const report = await withClient(admin, c => roleReport(c, APP));
      expect(report.memberships).toEqual([]);
      expect(runtimeViolations(report)).toEqual([]);
      const { rows } = await admin.query<Record<string, boolean>>(
        `SELECT pg_has_role($1, $2, 'MEMBER') AS mo, pg_has_role($1, $2, 'USAGE') AS uo,
                pg_has_role($1, $2, 'SET') AS so, pg_has_role($1, $3, 'MEMBER') AS mm,
                pg_has_role($1, $3, 'SET') AS sm`,
        [APP, OWNER, MIGRATOR],
      );
      expect(rows[0]).toEqual({ mo: false, uo: false, so: false, mm: false, sm: false });
      // Nobody but the migrator (and the provisioning admin) can reach the owner.
      const members = await admin.query<{ m: string }>(
        `WITH RECURSIVE up(oid) AS (
           SELECT member FROM pg_auth_members WHERE roleid = (SELECT oid FROM pg_roles WHERE rolname = $1)
           UNION SELECT a.member FROM pg_auth_members a JOIN up ON a.roleid = up.oid)
         SELECT rolname AS m FROM pg_roles WHERE oid IN (SELECT oid FROM up) ORDER BY 1`,
        [OWNER],
      );
      const reach = members.rows.map(r => r.m);
      expect(reach).toContain(MIGRATOR);
      expect(reach).not.toContain(APP);
    });

    it('verify: the whole model reports no violation', async () => {
      const model = await withClient(admin, c => ownershipModelReport(c));
      expect(ownershipViolations(model)).toEqual([]);
      expect(model.owner.objectsNotOwned).toBe(0);
      expect(model.owner.auditTriggersEnabled).toBe(true);
      expect(model.runtime.ownerDefaultAclTables).toBe('INSERT,SELECT');
      expect(model.runtime.ownerDefaultAclSequences).toBe('SELECT,USAGE');
      expect(model.runtime.foreignDefaultAcls).toBe(0);
    });
  });

  describe('community_app: every forbidden operation is SQLSTATE 42501', () => {
    beforeAll(async () => {
      await owner.query(`INSERT INTO "user" ("id","name","email","emailVerified","updatedAt")
        VALUES ('own1','m','own1@example.test',true,now()) ON CONFLICT DO NOTHING`);
      await app.query(`INSERT INTO moderation_actions
        (actor_account_id, action, target_type, target_id, reason)
        VALUES ('own1', 'hide_content', 'post', 'p1', 'a valid reason')`);
      await app.query(`INSERT INTO auth_events (event, account_id) VALUES ('logout', 'own1')`);
    });

    it.each([
      ['SET ROLE owner', `SET ROLE ${OWNER}`],
      ['SET ROLE migrator', `SET ROLE ${MIGRATOR}`],
      ['SET SESSION AUTHORIZATION owner', `SET SESSION AUTHORIZATION ${OWNER}`],
      [
        'DISABLE TRIGGER (moderation_actions)',
        'ALTER TABLE moderation_actions DISABLE TRIGGER moderation_actions_no_update_delete',
      ],
      ['DISABLE TRIGGER ALL (auth_events)', 'ALTER TABLE auth_events DISABLE TRIGGER ALL'],
      [
        'DROP TRIGGER (moderation_actions)',
        'DROP TRIGGER moderation_actions_no_truncate ON moderation_actions',
      ],
      ['DROP TRIGGER (auth_events)', 'DROP TRIGGER auth_events_no_update_delete ON auth_events'],
      ['ALTER FUNCTION (reject_change)', 'ALTER FUNCTION community_reject_change() RENAME TO x'],
      [
        'CREATE OR REPLACE FUNCTION (reject_change)',
        `CREATE OR REPLACE FUNCTION community_reject_change() RETURNS trigger LANGUAGE plpgsql
           AS $$ BEGIN RETURN NEW; END $$`,
      ],
      ['DROP TABLE (audit)', 'DROP TABLE auth_events'],
      ['ALTER TABLE OWNER', `ALTER TABLE moderation_actions OWNER TO ${APP}`],
      ['session_replication_role', 'SET session_replication_role = replica'],
      ['TRUNCATE moderation_actions', 'TRUNCATE moderation_actions'],
      ['TRUNCATE auth_events', 'TRUNCATE auth_events'],
      ['TRUNCATE (ordinary table)', 'TRUNCATE posts'],
      ['UPDATE moderation_actions', `UPDATE moderation_actions SET reason = 'changed reason!'`],
      ['DELETE moderation_actions', 'DELETE FROM moderation_actions'],
      ['UPDATE auth_events', `UPDATE auth_events SET event = 'sign_in_failed'`],
      ['DELETE auth_events', 'DELETE FROM auth_events'],
      ['CREATE TABLE', 'CREATE TABLE probe_app (id int)'],
      ['CREATE TABLE public.', 'CREATE TABLE public.probe_app (id int)'],
      ['CREATE TEMP TABLE', 'CREATE TEMP TABLE probe_tmp (id int)'],
      ['CREATE VIEW', 'CREATE VIEW probe_view AS SELECT 1'],
      ['CREATE FUNCTION', `CREATE FUNCTION public.probe() RETURNS int LANGUAGE sql AS 'SELECT 1'`],
      ['CREATE SCHEMA', 'CREATE SCHEMA probe'],
      ['CREATE ROLE', 'CREATE ROLE probe_role'],
      ['GRANT owner to self', `GRANT ${OWNER} TO ${APP}`],
    ])('%s', async (_label, sql) => {
      expect(await sqlstate(app, sql)).toBe('42501');
    });

    it('the audit rows and triggers are untouched afterwards', async () => {
      const { rows } = await owner.query<{ n: number }>(
        `SELECT (SELECT count(*) FROM moderation_actions)::int + (SELECT count(*) FROM auth_events)::int AS n`,
      );
      expect(rows[0].n).toBeGreaterThanOrEqual(2);
      const model = await withClient(admin, c => ownershipModelReport(c));
      expect(model.owner.auditTriggersEnabled).toBe(true);
    });
  });

  describe('community_migrator without SET ROLE has no privilege', () => {
    it.each([
      ['CREATE TABLE', 'CREATE TABLE probe_mig (id int)'],
      ['ALTER TABLE', 'ALTER TABLE posts ADD COLUMN probe int'],
      ['DISABLE TRIGGER', 'ALTER TABLE auth_events DISABLE TRIGGER ALL'],
      ['DROP TABLE', 'DROP TABLE notifications'],
      ['CREATE SCHEMA', 'CREATE SCHEMA probe'],
      ['CREATE TEMP TABLE', 'CREATE TEMP TABLE probe_tmp (id int)'],
      ['SELECT', 'SELECT count(*) FROM "user"'],
      ['INSERT', `INSERT INTO spaces (id, name, description) VALUES ('x', 'x', 'x')`],
      ['SET ROLE app', `SET ROLE ${APP}`],
    ])('%s → 42501', async (_label, sql) => {
      expect(await sqlstate(migrator, sql)).toBe('42501');
    });

    it('after an explicit SET ROLE it acts as the owner; RESET ROLE drops it again', async () => {
      await withClient(migrator, async c => {
        expect((await c.query('SELECT current_user AS u')).rows[0].u).toBe(MIGRATOR);
        await c.query(`SET ROLE ${OWNER}`);
        await c.query('CREATE TABLE probe_owned (id int)');
        const { rows } = await c.query(
          `SELECT pg_get_userbyid(relowner) AS o FROM pg_class WHERE relname = 'probe_owned'`,
        );
        expect(rows[0].o).toBe(OWNER);
        await c.query('DROP TABLE probe_owned');
        await c.query('RESET ROLE');
        expect((await c.query('SELECT current_user AS u')).rows[0].u).toBe(MIGRATOR);
        await expect(c.query('SELECT count(*) FROM "user"')).rejects.toMatchObject({
          code: '42501',
        });
      });
    });

    it('migrations run up/down through the migrator, objects owned by the owner', async () => {
      expect(await migrateDown(migrator, 2, undefined, OPTS)).toEqual(ALL.slice(-2).reverse());
      expect(await migrateUp(migrator, undefined, OPTS)).toEqual(ALL.slice(-2));
      expect(await migrateUp(migrator, undefined, OPTS)).toEqual([]);
      expect(await appliedVersions(migrator, OPTS)).toEqual(ALL);
      expect(await ownersOf(admin)).toEqual([OWNER]);
      // The pooled clients are back to the migrator (RESET ROLE after every step).
      const roles = await Promise.all(
        [1, 2, 3].map(() => migrator.query<{ u: string }>('SELECT current_user AS u')),
      );
      expect(roles.map(r => r.rows[0].u)).toEqual([MIGRATOR, MIGRATOR, MIGRATOR]);
      // Grants were re-synced as the owner: the runtime matrix is intact.
      const report = await withClient(admin, c => roleReport(c, APP));
      expect(runtimeViolations(report)).toEqual([]);
    });

    it('without SET ROLE the runner fails (no privilege), changing nothing', async () => {
      await expect(appliedVersions(migrator)).rejects.toMatchObject({ code: '42501' });
    });
  });

  describe('provisioning a legacy database (tables owned by the branch owner)', () => {
    const db = `community_transfer_${randomBytes(4).toString('hex')}`;
    let legacy: Pool;

    beforeAll(async () => {
      await admin.query(`CREATE DATABASE ${db}`);
      legacy = adminPool(db);
      // How the Neon development branch looked before this change: migrated by the owner login.
      await migrateUp(legacy);
    });
    afterAll(async () => {
      await legacy.end();
      await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    });

    it('transfers schema and objects to community_owner, idempotently, and verifies clean', async () => {
      const me = (await legacy.query<{ u: string }>('SELECT current_user AS u')).rows[0].u;
      expect(await ownersOf(legacy)).toEqual(expect.arrayContaining([me]));
      const first = await withClient(legacy, c =>
        provisionCommunityRoles(c, { newPassword: noNewRoles }),
      );
      expect(first.ownership.schemaTransferred).toBe(true);
      expect(first.ownership.transferred).toBeGreaterThanOrEqual(22 + 3);
      expect(await ownersOf(legacy)).toEqual([OWNER]);
      const second = await withClient(legacy, c =>
        provisionCommunityRoles(c, { newPassword: generatePassword }),
      );
      expect(second.ownership).toEqual({ transferred: 0, schemaTransferred: false });
      const model = await withClient(legacy, c => ownershipModelReport(c));
      expect(ownershipViolations(model)).toEqual([]);
      // The provisioning role kept only a SET-only membership (break-glass), no inherited rights.
      const { rows } = await legacy.query<Record<string, boolean>>(
        `SELECT has_table_privilege(current_user, 'public.auth_events', 'SELECT') AS sel,
                pg_has_role(current_user, $1, 'USAGE') AS usage`,
        [OWNER],
      );
      expect(rows[0]).toEqual({ sel: false, usage: false });
    });

    it('then the migrator migrates it down/up through SET ROLE', async () => {
      const url = new URL(OWNER_URL as string);
      url.pathname = `/${db}`;
      const mig = new Pool({ connectionString: url.toString() });
      try {
        expect(await migrateDown(mig, undefined, undefined, OPTS)).toEqual([...ALL].reverse());
        expect(await migrateUp(mig, undefined, OPTS)).toEqual(ALL);
        expect(await ownersOf(legacy)).toEqual([OWNER]);
      } finally {
        await mig.end();
      }
    });
  });
});
