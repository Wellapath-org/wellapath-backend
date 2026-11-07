/**
 * Community database roles and grants (ADR-001 amendment B2).
 *
 * Roles (per Neon branch / per database):
 * - the OWNER role (Neon: the project's database owner): owns every Community table, runs
 *   migrations, provisioning and the bootstrap CLI over the DIRECT URL. Never used by the app.
 * - `community_app`: the runtime role behind the app's POOLED URL. LOGIN, no superuser, no
 *   CREATEDB/CREATEROLE/REPLICATION/BYPASSRLS, NOINHERIT and a member of no role. DML only, per
 *   the table classes below; no DDL, TRUNCATE, REFERENCES or TRIGGER; no CREATE on any schema or
 *   on the database; no TEMP.
 * - `community_readonly` (optional, `--with-readonly`): NOLOGIN support role. SELECT on
 *   non-sensitive tables and columns only: no auth/session/token tables, no email, no free-text
 *   reasons/notes/evidence and no author/reporter ids (pseudonymous content must not be
 *   re-identifiable). Defined here; created only where explicitly requested.
 *
 * `syncCommunityGrants` is the single source of truth. The migration runner calls it after every
 * `migrateUp`, so a new table can never silently inherit the wrong privileges: every table in
 * the schema must be classified in `TABLE_CLASSES`; an unclassified table gets NO privilege for
 * either role (fail closed) and `migrateUp` reports it as an error.
 */
import { randomBytes } from 'crypto';
import { PoolClient } from 'pg';

export const COMMUNITY_SCHEMA = 'public';
export const RUNTIME_ROLE = 'community_app';
export const READONLY_ROLE = 'community_readonly';

/**
 * - `read_write`: SELECT, INSERT, UPDATE, DELETE.
 * - `append_only`: SELECT, INSERT only (audit/evidence; triggers also reject UPDATE/DELETE/
 *   TRUNCATE for every role, the owner included).
 * - `reference`: SELECT only (seeded by migrations; no endpoint writes it).
 * - `migrations`: SELECT only (the runner's bookkeeping; written by the owner).
 */
export type TableClass = 'read_write' | 'append_only' | 'reference' | 'migrations';

export const TABLE_CLASSES: Readonly<Record<string, TableClass>> = {
  // 0001 auth (Better Auth)
  user: 'read_write',
  session: 'read_write',
  account: 'read_write',
  verification: 'read_write',
  jwks: 'read_write',
  twoFactor: 'read_write',
  // 0002
  profiles: 'read_write',
  professional_verifications: 'read_write',
  // 0003
  spaces: 'reference',
  posts: 'read_write',
  comments: 'read_write',
  // 0004
  reports: 'read_write',
  moderation_actions: 'append_only',
  account_restrictions: 'read_write',
  // 0005
  notifications: 'read_write',
  // 0006
  refresh_token_families: 'read_write',
  refresh_tokens: 'read_write',
  // 0007
  auth_events: 'append_only',
  // 0008
  rate_limit_counters: 'read_write',
  idempotency_keys: 'read_write',
  totp_lockouts: 'read_write',
  // runner
  community_schema_migrations: 'migrations',
};

export const RUNTIME_PRIVILEGES: Readonly<Record<TableClass, readonly string[]>> = {
  read_write: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  append_only: ['SELECT', 'INSERT'],
  reference: ['SELECT'],
  migrations: ['SELECT'],
};

/**
 * Read-only support role: table → readable columns. Tables not listed (auth, sessions, tokens,
 * TOTP, verification codes, auth_events, idempotency responses, rate-limit buckets, lockouts,
 * notifications) are not readable at all.
 */
export const READONLY_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  user: ['id', 'role', 'createdAt', 'deletedAt'],
  profiles: ['user_id', 'display_name', 'created_at', 'updated_at'],
  professional_verifications: ['id', 'status', 'created_at', 'updated_at'],
  spaces: ['id', 'name', 'description', 'created_at'],
  posts: ['id', 'space_id', 'display_mode', 'body', 'status', 'created_at', 'updated_at'],
  comments: ['id', 'post_id', 'display_mode', 'body', 'status', 'created_at', 'updated_at'],
  reports: ['id', 'target_type', 'target_id', 'reason', 'status', 'created_at', 'updated_at'],
  moderation_actions: ['id', 'action', 'target_type', 'target_id', 'created_at'],
  account_restrictions: ['id', 'user_id', 'kind', 'created_at', 'expires_at', 'lifted_at'],
  community_schema_migrations: ['version', 'name', 'applied_at'],
};

export interface CommunityRoleNames {
  runtime: string;
  readonly: string;
}

export const DEFAULT_ROLE_NAMES: CommunityRoleNames = {
  runtime: RUNTIME_ROLE,
  readonly: READONLY_ROLE,
};

export interface GrantSyncResult {
  rolesSynced: string[];
  tables: string[];
  /** Tables present in the schema but absent from TABLE_CLASSES: no privilege granted. */
  unclassified: string[];
}

const ident = (client: PoolClient, name: string): string => client.escapeIdentifier(name);

const roleExists = async (client: PoolClient, role: string): Promise<boolean> =>
  (await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rowCount === 1;

/**
 * Re-applies every Community grant for whichever of the two roles exist, in one transaction.
 * Run as the table owner. Idempotent.
 */
export const syncCommunityGrants = async (
  client: PoolClient,
  roles: CommunityRoleNames = DEFAULT_ROLE_NAMES,
): Promise<GrantSyncResult> => {
  const schema = ident(client, COMMUNITY_SCHEMA);
  const { rows } = await client.query<{ t: string }>(
    `SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f') ORDER BY 1`,
    [COMMUNITY_SCHEMA],
  );
  const tables = rows.map(r => r.t);
  const unclassified = tables.filter(t => !(t in TABLE_CLASSES));
  const synced: string[] = [];
  const hasRuntime = await roleExists(client, roles.runtime);
  const hasReadonly = await roleExists(client, roles.readonly);

  await client.query('BEGIN');
  try {
    // Nobody but the owner creates objects in the Community schema.
    await client.query(`REVOKE CREATE ON SCHEMA ${schema} FROM PUBLIC`);

    if (hasRuntime) {
      const app = ident(client, roles.runtime);
      await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${app}`);
      await client.query(`REVOKE CREATE ON SCHEMA ${schema} FROM ${app}`);
      await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM ${app}`);
      await client.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${schema} FROM ${app}`);
      for (const table of tables) {
        const cls = TABLE_CLASSES[table];
        if (!cls) continue; // fail closed
        await client.query(
          `GRANT ${RUNTIME_PRIVILEGES[cls].join(', ')} ON ${schema}.${ident(client, table)} TO ${app}`,
        );
      }
      await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${app}`);
      // Objects the owner creates later (outside this runner, or before the next sync) get the
      // append-only floor: SELECT + INSERT, never UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER.
      // This also replaces the broader default that migration 0001 once set.
      await client.query(
        `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} REVOKE ALL ON TABLES FROM ${app}`,
      );
      await client.query(
        `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT SELECT, INSERT ON TABLES TO ${app}`,
      );
      await client.query(
        `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} REVOKE ALL ON SEQUENCES FROM ${app}`,
      );
      await client.query(
        `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT USAGE, SELECT ON SEQUENCES TO ${app}`,
      );
      synced.push(roles.runtime);
    }

    if (hasReadonly) {
      const ro = ident(client, roles.readonly);
      await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${ro}`);
      await client.query(`REVOKE CREATE ON SCHEMA ${schema} FROM ${ro}`);
      await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM ${ro}`);
      await client.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${schema} FROM ${ro}`);
      for (const table of tables) {
        const columns = READONLY_COLUMNS[table];
        if (!columns || !(table in TABLE_CLASSES)) continue;
        await client.query(
          `GRANT SELECT (${columns.map(c => ident(client, c)).join(', ')}) ON ${schema}.${ident(client, table)} TO ${ro}`,
        );
      }
      // No default privileges: a new table is invisible to support until classified here.
      await client.query(
        `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} REVOKE ALL ON TABLES FROM ${ro}`,
      );
      synced.push(roles.readonly);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
  return { rolesSynced: synced, tables, unclassified };
};

// ------------------------------------------------------------------------------ provisioning

/** 32 random bytes, base64url; re-drawn until it satisfies Neon's composition guidance. */
export const generatePassword = (): string => {
  for (;;) {
    const candidate = randomBytes(32).toString('base64url');
    if (
      /[a-z]/.test(candidate) &&
      /[A-Z]/.test(candidate) &&
      /\d/.test(candidate) &&
      !/(.)\1\1/.test(candidate)
    ) {
      return candidate;
    }
  }
};

interface RoleAttributes {
  rolsuper: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
  rolinherit: boolean;
  rolreplication: boolean;
  rolbypassrls: boolean;
  rolcanlogin: boolean;
}

const ATTRIBUTE_SQL =
  'NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS' as const;

const wrongAttributes = (a: RoleAttributes, login: boolean): string[] => {
  const wrong: string[] = [];
  if (a.rolsuper) wrong.push('SUPERUSER');
  if (a.rolcreatedb) wrong.push('CREATEDB');
  if (a.rolcreaterole) wrong.push('CREATEROLE');
  if (a.rolinherit) wrong.push('INHERIT');
  if (a.rolreplication) wrong.push('REPLICATION');
  if (a.rolbypassrls) wrong.push('BYPASSRLS');
  if (a.rolcanlogin !== login) wrong.push(login ? 'NOLOGIN' : 'LOGIN');
  return wrong;
};

const attributes = async (client: PoolClient, role: string): Promise<RoleAttributes | null> => {
  const { rows } = await client.query<RoleAttributes>(
    `SELECT rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolreplication, rolbypassrls,
            rolcanlogin FROM pg_roles WHERE rolname = $1`,
    [role],
  );
  return rows[0] ?? null;
};

/**
 * Sets a role's password without the secret appearing in any statement text: the value is
 * bound as a parameter of `set_config` (pg_stat_statements and statement logs see `$1`), and the
 * DO block that uses it is a nested statement whose text contains no secret.
 */
const setPasswordQuietly = async (
  client: PoolClient,
  role: string,
  password: string,
  create: boolean,
): Promise<void> => {
  await client.query('BEGIN');
  try {
    await client.query(`SELECT set_config('wellapath.provision_secret', $1, true)`, [password]);
    const verb = create
      ? `CREATE ROLE %I LOGIN ${ATTRIBUTE_SQL} PASSWORD %L`
      : 'ALTER ROLE %I PASSWORD %L';
    await client.query(`DO $wp$
BEGIN
  EXECUTE format('${verb}', ${client.escapeLiteral(role)}, current_setting('wellapath.provision_secret'));
END
$wp$`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    // Never surface the driver error verbatim: some servers quote the failing statement.
    const code = (error as { code?: string }).code ?? 'unknown';
    throw new Error(`${create ? 'CREATE' : 'ALTER'} ROLE ${role} failed (SQLSTATE ${code})`);
  }
};

export interface ProvisionOptions {
  roles?: CommunityRoleNames;
  withReadonly?: boolean;
  /** Generates a new password; called only when the runtime role is created or rotated. */
  newPassword: () => string;
  /** Set a new password on an EXISTING runtime role (rotation). */
  rotatePassword?: boolean;
  /** Called as soon as a new password has been committed (persist the credential now). */
  passwordApplied?: () => void;
}

export interface ProvisionResult {
  runtimeCreated: boolean;
  runtimeAttributesFixed: string[];
  /** Present only when the runtime role was created or its password rotated. Never log it. */
  runtimePassword?: string;
  readonlyCreated: boolean;
  grants: GrantSyncResult;
}

const ensureNoMemberships = async (client: PoolClient, role: string): Promise<void> => {
  const { rows } = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member
      WHERE r.rolname = $1`,
    [role],
  );
  if (rows[0].n > 0) {
    throw new Error(`${role} is a member of another role; revoke that membership first`);
  }
};

const ensureAttributes = async (
  client: PoolClient,
  role: string,
  login: boolean,
): Promise<string[]> => {
  const current = await attributes(client, role);
  if (!current) throw new Error(`${role} does not exist`);
  const wrong = wrongAttributes(current, login);
  if (wrong.length > 0) {
    // Only the drifted attributes are reset: a CREATEROLE owner may not even mention
    // SUPERUSER/REPLICATION/BYPASSRLS, so a role that has those needs a human with more rights.
    const fix = wrong.map(w => (w.startsWith('NO') ? w.slice(2) : `NO${w}`));
    try {
      await client.query(`ALTER ROLE ${ident(client, role)} ${fix.join(' ')}`);
    } catch (error) {
      throw new Error(
        `${role} has attribute(s) ${wrong.join(', ')} that this owner cannot reset ` +
          `(SQLSTATE ${(error as { code?: string }).code ?? 'unknown'}); fix them manually`,
      );
    }
  }
  return wrong;
};

/**
 * Idempotent provisioning, run as the OWNER over a direct connection:
 * creates/validates the runtime role (and optionally the read-only role), grants CONNECT on the
 * current database, removes PUBLIC's TEMP and CREATE on the database, then syncs table grants.
 */
export const provisionCommunityRoles = async (
  client: PoolClient,
  options: ProvisionOptions,
): Promise<ProvisionResult> => {
  const roles = options.roles ?? DEFAULT_ROLE_NAMES;
  const { rows } = await client.query<{ me: string; db: string }>(
    'SELECT current_user AS me, current_database() AS db',
  );
  const { me, db } = rows[0];
  if (me === roles.runtime || me === roles.readonly) {
    throw new Error('Run provisioning as the OWNER role, not as a Community runtime role');
  }
  const database = ident(client, db);

  let runtimeCreated = false;
  let runtimePassword: string | undefined;
  if (!(await attributes(client, roles.runtime))) {
    runtimePassword = options.newPassword();
    await setPasswordQuietly(client, roles.runtime, runtimePassword, true);
    runtimeCreated = true;
    options.passwordApplied?.();
  } else if (options.rotatePassword) {
    runtimePassword = options.newPassword();
    await setPasswordQuietly(client, roles.runtime, runtimePassword, false);
    options.passwordApplied?.();
  }
  const runtimeAttributesFixed = await ensureAttributes(client, roles.runtime, true);
  await ensureNoMemberships(client, roles.runtime);

  let readonlyCreated = false;
  if (options.withReadonly) {
    if (!(await attributes(client, roles.readonly))) {
      await client.query(`CREATE ROLE ${ident(client, roles.readonly)} NOLOGIN ${ATTRIBUTE_SQL}`);
      readonlyCreated = true;
    }
    await ensureAttributes(client, roles.readonly, false);
    await ensureNoMemberships(client, roles.readonly);
  }

  await client.query(`REVOKE TEMPORARY, CREATE ON DATABASE ${database} FROM PUBLIC`);
  await client.query(`GRANT CONNECT ON DATABASE ${database} TO ${ident(client, roles.runtime)}`);
  await client.query(
    `REVOKE TEMPORARY, CREATE ON DATABASE ${database} FROM ${ident(client, roles.runtime)}`,
  );
  if (options.withReadonly) {
    await client.query(`GRANT CONNECT ON DATABASE ${database} TO ${ident(client, roles.readonly)}`);
  }

  const grants = await syncCommunityGrants(client, roles);
  return { runtimeCreated, runtimeAttributesFixed, runtimePassword, readonlyCreated, grants };
};

// ------------------------------------------------------------------------------ verification

export const TABLE_PRIVILEGES = [
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'TRUNCATE',
  'REFERENCES',
  'TRIGGER',
] as const;

export interface PrivilegeRow {
  table: string;
  privileges: Record<(typeof TABLE_PRIVILEGES)[number], boolean>;
  /** Column-level SELECT on at least one column (relevant for the read-only role). */
  anyColumnSelect: boolean;
}

export interface RoleReport {
  role: string;
  exists: boolean;
  attributes?: RoleAttributes;
  memberOf: number;
  database: { connect: boolean; create: boolean; temporary: boolean };
  schema: { usage: boolean; create: boolean };
  pgAuthidSelect: boolean;
  tables: PrivilegeRow[];
}

/** has_*_privilege matrix for one role. Contains role/table names and booleans only. */
export const roleReport = async (client: PoolClient, role: string): Promise<RoleReport> => {
  const attrs = await attributes(client, role);
  if (!attrs) {
    return {
      role,
      exists: false,
      memberOf: 0,
      database: { connect: false, create: false, temporary: false },
      schema: { usage: false, create: false },
      pgAuthidSelect: false,
      tables: [],
    };
  }
  const one = async <T>(sql: string, params: unknown[]): Promise<T> =>
    (await client.query(sql, params)).rows[0] as T;
  const db = await one<{ c: boolean; cr: boolean; t: boolean }>(
    `SELECT has_database_privilege($1, current_database(), 'CONNECT') AS c,
            has_database_privilege($1, current_database(), 'CREATE') AS cr,
            has_database_privilege($1, current_database(), 'TEMPORARY') AS t`,
    [role],
  );
  const sch = await one<{ u: boolean; c: boolean }>(
    `SELECT has_schema_privilege($1, $2, 'USAGE') AS u, has_schema_privilege($1, $2, 'CREATE') AS c`,
    [role, COMMUNITY_SCHEMA],
  );
  const authid = await one<{ s: boolean }>(
    `SELECT has_table_privilege($1, 'pg_catalog.pg_authid', 'SELECT') AS s`,
    [role],
  );
  const members = await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member
      WHERE r.rolname = $1`,
    [role],
  );
  const { rows } = await client.query<Record<string, boolean | string>>(
    `SELECT c.relname AS t,
            ${TABLE_PRIVILEGES.map(p => `has_table_privilege($1, c.oid, '${p}') AS "${p}"`).join(
              ', ',
            )},
            has_any_column_privilege($1, c.oid, 'SELECT') AS any_col
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $2 AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
      ORDER BY 1`,
    [role, COMMUNITY_SCHEMA],
  );
  return {
    role,
    exists: true,
    attributes: attrs,
    memberOf: members.n,
    database: { connect: db.c, create: db.cr, temporary: db.t },
    schema: { usage: sch.u, create: sch.c },
    pgAuthidSelect: authid.s,
    tables: rows.map(r => ({
      table: r.t as string,
      privileges: Object.fromEntries(
        TABLE_PRIVILEGES.map(p => [p, r[p] as boolean]),
      ) as PrivilegeRow['privileges'],
      anyColumnSelect: r.any_col as boolean,
    })),
  };
};

/** Differences between a runtime-role report and the intended matrix (empty = compliant). */
export const runtimeViolations = (report: RoleReport): string[] => {
  const out: string[] = [];
  if (!report.exists) return [`${report.role} does not exist`];
  const a = report.attributes as RoleAttributes;
  const bad = wrongAttributes(a, true);
  if (bad.length) out.push(`attributes: ${bad.join(', ')}`);
  if (report.memberOf > 0) out.push('member of another role');
  if (!report.database.connect) out.push('database: no CONNECT');
  if (report.database.create) out.push('database: CREATE');
  if (report.database.temporary) out.push('database: TEMPORARY');
  if (!report.schema.usage) out.push('schema: no USAGE');
  if (report.schema.create) out.push('schema: CREATE');
  if (report.pgAuthidSelect) out.push('pg_authid: SELECT');
  for (const row of report.tables) {
    const cls = TABLE_CLASSES[row.table];
    const want = new Set(cls ? RUNTIME_PRIVILEGES[cls] : []);
    for (const p of TABLE_PRIVILEGES) {
      if (row.privileges[p] !== want.has(p)) {
        out.push(`${row.table}: ${p} is ${row.privileges[p]} (expected ${want.has(p)})`);
      }
    }
  }
  return out;
};
