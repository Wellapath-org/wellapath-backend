/**
 * ADR-001 B2: the least-privilege runtime role `community_app` and the optional
 * `community_readonly` support role. Privilege matrix asserted with has_*_privilege, denied
 * operations proven to fail as the runtime role, grants re-applied by the migration runner, and
 * the provisioning path (create → idempotent re-run) exercised on a throwaway role name.
 *
 * Needs COMMUNITY_TEST_APP_DATABASE_URL to be a DIFFERENT role (community_app) from the owner,
 * and an owner with CREATEROLE (as Neon's owner role has).
 */
import { randomBytes } from 'crypto';
import { Pool, PoolClient } from 'pg';
import {
  CommunityRoleNames,
  DEFAULT_ROLE_NAMES,
  generatePassword,
  provisionCommunityRoles,
  READONLY_COLUMNS,
  roleReport,
  runtimeViolations,
  TABLE_CLASSES,
} from '../../src/community/db-roles';
import { isRemoteDatabaseUrl } from '../../src/community/db-url';
import { migrateUp } from '../../src/community/migrate';
import { APP_URL, OWNER_URL, appPool, ownerPool, resetDatabase } from './helpers';

const describeRoles = OWNER_URL && APP_URL && APP_URL !== OWNER_URL ? describe : describe.skip;
/**
 * Roles are cluster-wide (per Neon branch), not per database. `community_readonly` must not be
 * created on a shared/cloud branch (ADR-001 B2), so the read-only parts run on local hosts only.
 */
const LOCAL = OWNER_URL ? !isRemoteDatabaseUrl(OWNER_URL, 'COMMUNITY_TEST_DATABASE_URL') : false;
const describeLocal = LOCAL ? describe : describe.skip;

const AUDIT = ['moderation_actions', 'auth_events'];

const priv = async (pool: Pool, role: string, table: string, privilege: string): Promise<boolean> =>
  (
    await pool.query<{ ok: boolean }>(`SELECT has_table_privilege($1, $2, $3) AS ok`, [
      role,
      `public.${table.includes('"') ? table : `"${table}"`}`,
      privilege,
    ])
  ).rows[0].ok;

const withClient = async <T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> => {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
};

const dropProbeRole = async (owner: Pool, role: string): Promise<void> => {
  const exists = await owner.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
  if (!exists.rowCount) return;
  const r = `"${role}"`;
  const { rows } = await owner.query<{ db: string }>('SELECT current_database() AS db');
  for (const sql of [
    `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${r}`,
    `REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${r}`,
    `REVOKE ALL ON SCHEMA public FROM ${r}`,
    `REVOKE ALL ON DATABASE "${rows[0].db}" FROM ${r}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM ${r}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM ${r}`,
    `DROP ROLE ${r}`,
  ]) {
    await owner.query(sql);
  }
};

describeRoles('community_app runtime role (B2)', () => {
  let owner: Pool;
  let app: Pool;

  beforeAll(async () => {
    await resetDatabase();
    owner = ownerPool();
    app = appPool();
    await withClient(owner, c =>
      provisionCommunityRoles(c, {
        withReadonly: LOCAL,
        newPassword: () => {
          throw new Error('community_app must already exist in the test database');
        },
      }),
    );
  });
  afterAll(async () => {
    await owner.end();
    await app.end();
  });

  it('the app connects as community_app, not as the owner', async () => {
    const { rows } = await app.query<{ u: string }>('SELECT current_user AS u');
    expect(rows[0].u).toBe(DEFAULT_ROLE_NAMES.runtime);
  });

  it('every table the migrations create is classified, and nothing else is', async () => {
    const { rows } = await owner.query<{ t: string }>(
      `SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`,
    );
    expect(rows.map(r => r.t).sort()).toEqual(Object.keys(TABLE_CLASSES).sort());
    for (const table of Object.keys(READONLY_COLUMNS)) expect(TABLE_CLASSES).toHaveProperty(table);
  });

  it('matches the intended privilege matrix exactly (has_table_privilege, all 22 tables)', async () => {
    const report = await withClient(owner, c => roleReport(c, DEFAULT_ROLE_NAMES.runtime));
    expect(report.tables).toHaveLength(Object.keys(TABLE_CLASSES).length);
    expect(runtimeViolations(report)).toEqual([]);
    expect(report.attributes).toEqual({
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolinherit: false,
      rolreplication: false,
      rolbypassrls: false,
      rolcanlogin: true,
    });
    expect(report.memberOf).toBe(0);
    expect(report.database).toEqual({ connect: true, create: false, temporary: false });
    expect(report.schema).toEqual({ usage: true, create: false });
    expect(report.pgAuthidSelect).toBe(false);
  });

  it.each(AUDIT)('%s: SELECT + INSERT only', async table => {
    const role = DEFAULT_ROLE_NAMES.runtime;
    expect(await priv(owner, role, table, 'SELECT')).toBe(true);
    expect(await priv(owner, role, table, 'INSERT')).toBe(true);
    for (const p of ['UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
      expect(await priv(owner, role, table, p)).toBe(false);
    }
  });

  it.each(AUDIT)('%s: UPDATE, DELETE and TRUNCATE fail as community_app', async table => {
    await expect(app.query(`UPDATE ${table} SET id = id`)).rejects.toThrow(/permission denied/);
    await expect(app.query(`DELETE FROM ${table}`)).rejects.toThrow(/permission denied/);
    await expect(app.query(`TRUNCATE ${table}`)).rejects.toThrow(/permission denied/);
  });

  it('ordinary tables: DML works; spaces is read-only', async () => {
    await expect(app.query('SELECT count(*) FROM posts')).resolves.toBeDefined();
    await expect(
      app.query(`INSERT INTO spaces (id, name, description) VALUES ('general_health','x','y')`),
    ).rejects.toThrow(/permission denied/);
    await expect(app.query(`UPDATE spaces SET name = name`)).rejects.toThrow(/permission denied/);
  });

  it('no DDL: CREATE TABLE, CREATE TEMP TABLE, ALTER, DROP, CREATE FUNCTION all fail', async () => {
    await expect(app.query('CREATE TABLE probe_ddl (id int)')).rejects.toThrow(/permission denied/);
    await expect(app.query('CREATE TEMP TABLE probe_tmp (id int)')).rejects.toThrow(
      /permission denied/,
    );
    await expect(app.query('ALTER TABLE posts ADD COLUMN probe int')).rejects.toThrow(
      /must be owner/,
    );
    await expect(app.query('ALTER TABLE moderation_actions DISABLE TRIGGER ALL')).rejects.toThrow(
      /must be owner/,
    );
    await expect(app.query('DROP TABLE notifications')).rejects.toThrow(/must be owner/);
    await expect(
      app.query(`CREATE FUNCTION public.probe() RETURNS int LANGUAGE sql AS 'SELECT 1'`),
    ).rejects.toThrow(/permission denied/);
    await expect(app.query('CREATE SCHEMA probe')).rejects.toThrow(/permission denied/);
  });

  it('no role management, no catalog secrets, no privilege escalation', async () => {
    await expect(app.query('SELECT rolpassword FROM pg_authid')).rejects.toThrow(
      /permission denied/,
    );
    await expect(app.query(`CREATE ROLE probe_role`)).rejects.toThrow(/permission denied/);
    await expect(app.query(`ALTER ROLE community_app CREATEROLE`)).rejects.toThrow(
      /permission denied/,
    );
    // Without grant option a GRANT is a no-op (Postgres only warns), so assert the outcome.
    await app.query(`GRANT UPDATE ON auth_events TO community_app`).catch(() => undefined);
    // The attempted self-grant changed nothing.
    expect(await priv(owner, DEFAULT_ROLE_NAMES.runtime, 'auth_events', 'UPDATE')).toBe(false);
  });

  it('the migration runner re-applies grants; an unclassified table fails closed and loudly', async () => {
    // A table created by the owner outside the runner gets the default floor only.
    await owner.query('CREATE TABLE probe_future (id bigserial PRIMARY KEY, v text)');
    try {
      const role = DEFAULT_ROLE_NAMES.runtime;
      expect(await priv(owner, role, 'probe_future', 'SELECT')).toBe(true);
      expect(await priv(owner, role, 'probe_future', 'INSERT')).toBe(true);
      expect(await priv(owner, role, 'probe_future', 'UPDATE')).toBe(false);
      expect(await priv(owner, role, 'probe_future', 'DELETE')).toBe(false);
      expect(await priv(owner, role, 'probe_future', 'TRUNCATE')).toBe(false);
      expect(await priv(owner, DEFAULT_ROLE_NAMES.readonly, 'probe_future', 'SELECT')).toBe(false);
      // The runner: nothing pending, but it re-syncs and refuses the unclassified table.
      await expect(migrateUp(owner)).rejects.toThrow(
        /Unclassified Community table\(s\) probe_future/,
      );
      expect(await priv(owner, role, 'probe_future', 'SELECT')).toBe(false);
      expect(await priv(owner, role, 'probe_future', 'INSERT')).toBe(false);
    } finally {
      await owner.query('DROP TABLE probe_future');
    }
    // A drifted grant (someone granted UPDATE on an audit table) is repaired by the next run.
    await owner.query('GRANT UPDATE ON auth_events TO community_app');
    expect(await priv(owner, DEFAULT_ROLE_NAMES.runtime, 'auth_events', 'UPDATE')).toBe(true);
    await expect(migrateUp(owner)).resolves.toEqual([]);
    expect(await priv(owner, DEFAULT_ROLE_NAMES.runtime, 'auth_events', 'UPDATE')).toBe(false);
  });

  describeLocal('community_readonly (defined; created only on request, local only)', () => {
    const ro = DEFAULT_ROLE_NAMES.readonly;
    const col = async (table: string, column: string): Promise<boolean> =>
      (
        await owner.query<{ ok: boolean }>(
          `SELECT has_column_privilege($1, $2, $3, 'SELECT') AS ok`,
          [ro, `public."${table}"`, column],
        )
      ).rows[0].ok;

    it('NOLOGIN, no attributes, cannot write anything', async () => {
      const report = await withClient(owner, c => roleReport(c, ro));
      expect(report.attributes?.rolcanlogin).toBe(false);
      expect(report.attributes?.rolsuper).toBe(false);
      expect(report.schema.create).toBe(false);
      for (const row of report.tables) {
        for (const p of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
          expect([row.table, p, row.privileges[p as 'INSERT']]).toEqual([row.table, p, false]);
        }
      }
    });

    it('no access at all to auth, session, token or audit-identity tables', async () => {
      for (const table of [
        'session',
        'account',
        'verification',
        'jwks',
        'twoFactor',
        'refresh_token_families',
        'refresh_tokens',
        'auth_events',
        'idempotency_keys',
        'rate_limit_counters',
        'totp_lockouts',
        'notifications',
      ]) {
        const { rows } = await owner.query<{ ok: boolean }>(
          `SELECT has_any_column_privilege($1, $2, 'SELECT') AS ok`,
          [ro, `public."${table}"`],
        );
        expect([table, rows[0].ok]).toEqual([table, false]);
      }
    });

    it('no email, no free text reasons/evidence, no author/reporter ids (identity reveal)', async () => {
      expect(await col('user', 'email')).toBe(false);
      expect(await col('user', 'name')).toBe(false);
      expect(await col('user', 'id')).toBe(true);
      expect(await col('posts', 'author_id')).toBe(false);
      expect(await col('posts', 'body')).toBe(true);
      expect(await col('comments', 'author_id')).toBe(false);
      expect(await col('reports', 'reporter_id')).toBe(false);
      expect(await col('reports', 'note')).toBe(false);
      expect(await col('moderation_actions', 'evidence')).toBe(false);
      expect(await col('moderation_actions', 'reason')).toBe(false);
      expect(await col('moderation_actions', 'actor_account_id')).toBe(false);
      expect(await col('professional_verifications', 'evidence_ref')).toBe(false);
      expect(await col('professional_verifications', 'profession')).toBe(false);
      expect(await col('account_restrictions', 'reason')).toBe(false);
    });
  });

  it('provisioning: creates a role with the right attributes, then is idempotent', async () => {
    const suffix = randomBytes(4).toString('hex');
    const roles: CommunityRoleNames = {
      runtime: `community_app_probe_${suffix}`,
      readonly: `community_ro_probe_${suffix}`,
    };
    let generated = 0;
    try {
      const first = await withClient(owner, c =>
        provisionCommunityRoles(c, {
          roles,
          withReadonly: LOCAL,
          newPassword: () => {
            generated += 1;
            return generatePassword();
          },
        }),
      );
      expect(first.runtimeCreated).toBe(true);
      expect(first.readonlyCreated).toBe(LOCAL);
      expect(first.runtimePassword).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(first.runtimeAttributesFixed).toEqual([]);
      const report = await withClient(owner, c => roleReport(c, roles.runtime));
      expect(runtimeViolations(report)).toEqual([]);

      // The secret never appears in any statement text the server keeps.
      const { rows } = await owner.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE query LIKE '%' || $1 || '%'`,
        [first.runtimePassword],
      );
      expect(rows[0].n).toBe(0);

      const second = await withClient(owner, c =>
        provisionCommunityRoles(c, {
          roles,
          withReadonly: LOCAL,
          newPassword: () => {
            generated += 1;
            return generatePassword();
          },
        }),
      );
      expect(second.runtimeCreated).toBe(false);
      expect(second.readonlyCreated).toBe(false);
      expect(second.runtimePassword).toBeUndefined();
      expect(generated).toBe(1);

      // Attribute drift is repaired.
      await owner.query(`ALTER ROLE "${roles.runtime}" INHERIT`);
      const third = await withClient(owner, c =>
        provisionCommunityRoles(c, { roles, newPassword: generatePassword }),
      );
      expect(third.runtimeAttributesFixed).toEqual(['INHERIT']);

      // Rotation sets a new password on the existing role.
      const rotated = await withClient(owner, c =>
        provisionCommunityRoles(c, { roles, rotatePassword: true, newPassword: generatePassword }),
      );
      expect(rotated.runtimeCreated).toBe(false);
      expect(rotated.runtimePassword).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(rotated.runtimePassword).not.toBe(first.runtimePassword);
    } finally {
      await dropProbeRole(owner, roles.runtime);
      await dropProbeRole(owner, roles.readonly);
    }
  });

  it('refuses to run as a runtime role', async () => {
    await expect(
      withClient(app, c => provisionCommunityRoles(c, { newPassword: generatePassword })),
    ).rejects.toThrow(/OWNER role/);
  });
});
