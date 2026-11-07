/**
 * Community database roles, ownership and grants (ADR-001 amendment B2, three-role model).
 *
 * Roles (Postgres roles are cluster-wide, i.e. per Neon BRANCH, not per database):
 * - `community_owner`: NOLOGIN, no attributes, member of no role. Owns the Community schema
 *   (`public`) and every table, sequence, function and trigger in it. Nobody logs in as it.
 * - `community_migrator`: LOGIN, NOINHERIT, no other attribute. Its only membership is
 *   `community_owner` WITH INHERIT FALSE, SET TRUE, ADMIN FALSE: it has no privilege of its own
 *   and gets owner powers only after an explicit `SET ROLE community_owner`, which the migration
 *   runner (and the bootstrap CLI) issue per transaction over the DIRECT URL.
 * - `community_app`: the runtime role behind the app's POOLED URL. LOGIN, NOINHERIT, no
 *   SUPERUSER/CREATEDB/CREATEROLE/REPLICATION/BYPASSRLS and a member of NO role (so it can
 *   neither inherit nor `SET ROLE` to the owner or the migrator). DML only, per the table classes
 *   below; no DDL, TRUNCATE, REFERENCES or TRIGGER; no CREATE on any schema or on the database;
 *   no TEMP. As a non-owner it cannot disable, drop or alter the append-only triggers.
 * - `community_readonly` (optional, `--with-readonly`, LOCAL ONLY): NOLOGIN support role,
 *   column-limited SELECT on non-sensitive data. Never created on a Neon branch.
 *
 * The Neon branch owner (`neondb_owner`) is a Neon-managed admin role (CREATEROLE, BYPASSRLS,
 * member of `neon_superuser`). It runs provisioning only, keeps ADMIN on the roles it created and
 * a SET-only membership in `community_owner` (needed to transfer ownership). It is the break-glass
 * role: the ownership model cannot constrain it.
 *
 * `syncCommunityGrants` is the single source of truth for table grants. It runs AS the owner
 * (`SET ROLE community_owner`): from the migration runner after every `migrateUp`, and from
 * provisioning. Every table must be classified in `TABLE_CLASSES`; an unclassified table gets NO
 * privilege (fail closed) and `migrateUp` reports it as an error.
 */
import { randomBytes } from 'crypto';
import { PoolClient } from 'pg';

export const COMMUNITY_SCHEMA = 'public';
export const OWNER_ROLE = 'community_owner';
export const MIGRATOR_ROLE = 'community_migrator';
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
  // 0001 auth (Better Auth). `verification` needs DELETE for the sign-in retention purge too.
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
  // 0008 (`rate_limit_counters` DELETE is also used by the retention purge)
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

/** Tables the retention purge (`purge.ts`) deletes from, as `community_app`. */
export const PURGE_TABLES = ['verification', 'rate_limit_counters'] as const;

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
  owner: string;
  migrator: string;
  runtime: string;
  readonly: string;
}

export const DEFAULT_ROLE_NAMES: CommunityRoleNames = {
  owner: OWNER_ROLE,
  migrator: MIGRATOR_ROLE,
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

const sqlstate = (error: unknown): string => (error as { code?: string }).code ?? 'unknown';

/**
 * Runs `fn` as `role` (`SET ROLE`), then `RESET ROLE`. `role` null/undefined = as the session
 * user. If RESET fails the caller must discard the connection (`client.release(true)`), so the
 * helper rethrows in that case.
 */
export const asRole = async <T>(
  client: PoolClient,
  role: string | null | undefined,
  fn: () => Promise<T>,
): Promise<T> => {
  if (!role) return fn();
  await client.query(`SET ROLE ${ident(client, role)}`);
  try {
    return await fn();
  } finally {
    await client.query('RESET ROLE');
  }
};

/**
 * Re-applies every Community grant for whichever of the runtime/read-only roles exist, in one
 * transaction. MUST run as the owner of every relation in the schema (in the three-role model:
 * under `SET ROLE community_owner`), otherwise it refuses: a GRANT by a non-owner is only a
 * WARNING in Postgres and would silently change nothing. Idempotent.
 */
export const syncCommunityGrants = async (
  client: PoolClient,
  roles: CommunityRoleNames = DEFAULT_ROLE_NAMES,
): Promise<GrantSyncResult> => {
  const schema = ident(client, COMMUNITY_SCHEMA);
  const notOwned = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
        AND c.relowner <> (SELECT oid FROM pg_roles WHERE rolname = current_user)`,
    [COMMUNITY_SCHEMA],
  );
  if (notOwned.rows[0].n > 0) {
    throw new Error(
      `syncCommunityGrants must run as the owner of every Community relation ` +
        `(${notOwned.rows[0].n} not owned by the current role): SET ROLE ${roles.owner} first`,
    );
  }
  const me = ident(
    client,
    (await client.query<{ u: string }>('SELECT current_user AS u')).rows[0].u,
  );
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
  const hasMigrator = await roleExists(client, roles.migrator);

  await client.query('BEGIN');
  try {
    // Nobody but the owner creates objects in the Community schema.
    await client.query(`REVOKE CREATE ON SCHEMA ${schema} FROM PUBLIC`);

    if (hasMigrator) {
      // The migrator has no privilege of its own: everything it does is as the owner.
      const mig = ident(client, roles.migrator);
      await client.query(`REVOKE ALL ON SCHEMA ${schema} FROM ${mig}`);
      await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM ${mig}`);
      await client.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${schema} FROM ${mig}`);
    }

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
      // FOR ROLE = the owner (current_user here), so it covers every future Community table.
      const dp = `ALTER DEFAULT PRIVILEGES FOR ROLE ${me} IN SCHEMA ${schema}`;
      await client.query(`${dp} REVOKE ALL ON TABLES FROM ${app}`);
      await client.query(`${dp} GRANT SELECT, INSERT ON TABLES TO ${app}`);
      await client.query(`${dp} REVOKE ALL ON SEQUENCES FROM ${app}`);
      await client.query(`${dp} GRANT USAGE, SELECT ON SEQUENCES TO ${app}`);
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
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${me} IN SCHEMA ${schema} REVOKE ALL ON TABLES FROM ${ro}`,
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

/**
 * 32 random bytes (crypto.randomBytes), base64url = 43 characters; re-drawn until it satisfies
 * Neon's composition guidance for SQL-created roles.
 */
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

export interface RoleAttributes {
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
    throw new Error(
      `${create ? 'CREATE' : 'ALTER'} ROLE ${role} failed (SQLSTATE ${sqlstate(error)})`,
    );
  }
};

/** Which login role a generated credential belongs to. */
export type CredentialKind = 'runtime' | 'migrator';

export interface ProvisionOptions {
  roles?: CommunityRoleNames;
  withReadonly?: boolean;
  /** Generates a new password; called only when a login role is created or rotated. */
  newPassword: (kind: CredentialKind) => string;
  /** Set a new password on the EXISTING runtime role (rotation). */
  rotatePassword?: boolean;
  /** Set a new password on the EXISTING migrator role (rotation). */
  rotateMigratorPassword?: boolean;
  /** Called as soon as a new password has been committed (persist the credential now). */
  passwordApplied?: (kind: CredentialKind) => void;
}

export interface OwnershipResult {
  /** Relations, routines and types moved from the provisioning role to the owner. */
  transferred: number;
  schemaTransferred: boolean;
}

export interface ProvisionResult {
  ownerCreated: boolean;
  ownerAttributesFixed: string[];
  migratorCreated: boolean;
  migratorAttributesFixed: string[];
  /** Present only when the migrator was created or rotated. Never log it. */
  migratorPassword?: string;
  runtimeCreated: boolean;
  runtimeAttributesFixed: string[];
  /** Present only when the runtime role was created or its password rotated. Never log it. */
  runtimePassword?: string;
  readonlyCreated: boolean;
  ownership: OwnershipResult;
  grants: GrantSyncResult;
}

interface MembershipRow {
  role: string;
  admin_option: boolean;
  inherit_option: boolean;
  set_option: boolean;
}

const membershipsOf = async (client: PoolClient, member: string): Promise<MembershipRow[]> =>
  (
    await client.query<MembershipRow>(
      `SELECT r.rolname AS role, a.admin_option, a.inherit_option, a.set_option
         FROM pg_auth_members a JOIN pg_roles r ON r.oid = a.roleid
         JOIN pg_roles m ON m.oid = a.member WHERE m.rolname = $1 ORDER BY 1`,
      [member],
    )
  ).rows;

const ensureNoMemberships = async (client: PoolClient, role: string): Promise<void> => {
  if ((await membershipsOf(client, role)).length > 0) {
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
        `${role} has attribute(s) ${wrong.join(', ')} that this role cannot reset ` +
          `(SQLSTATE ${sqlstate(error)}); fix them manually`,
      );
    }
  }
  return wrong;
};

/** True if `role` can `SET ROLE` to `target` (directly or through a chain of SET grants). */
const canSetRole = async (client: PoolClient, role: string, target: string): Promise<boolean> =>
  (await client.query<{ ok: boolean }>(`SELECT pg_has_role($1, $2, 'SET') AS ok`, [role, target]))
    .rows[0].ok;

/**
 * The migrator's single membership: owner, INHERIT FALSE, SET TRUE, ADMIN FALSE. Any other
 * membership refuses (manual fix), wrong options are re-granted where this role is the grantor.
 */
const ensureMigratorMembership = async (
  client: PoolClient,
  roles: CommunityRoleNames,
): Promise<void> => {
  const others = (await membershipsOf(client, roles.migrator)).filter(m => m.role !== roles.owner);
  if (others.length > 0) {
    throw new Error(
      `${roles.migrator} is a member of a role other than ${roles.owner}; revoke it first`,
    );
  }
  const owner = ident(client, roles.owner);
  const migrator = ident(client, roles.migrator);
  const rows = (await membershipsOf(client, roles.migrator)).filter(m => m.role === roles.owner);
  if (rows.some(r => r.admin_option)) {
    await client.query(`REVOKE ADMIN OPTION FOR ${owner} FROM ${migrator}`);
  }
  if (rows.length === 0 || rows.some(r => r.inherit_option || !r.set_option)) {
    await client.query(`GRANT ${owner} TO ${migrator} WITH INHERIT FALSE, SET TRUE`);
  }
  const after = (await membershipsOf(client, roles.migrator)).filter(m => m.role === roles.owner);
  if (after.length === 0 || after.some(r => r.admin_option || r.inherit_option || !r.set_option)) {
    throw new Error(
      `${roles.migrator}'s membership in ${roles.owner} must be INHERIT FALSE, SET TRUE, ` +
        'ADMIN FALSE (a grant by another grantor differs); fix it manually',
    );
  }
};

interface TransferTarget {
  kind: string;
  name: string;
}

/**
 * Moves everything the provisioning role owns in the Community schema to the owner role:
 * tables (their indexes, triggers, owned sequences and row types follow), views, standalone
 * sequences, routines and types, then the schema itself. Extension members are skipped. An
 * object owned by some third role makes the ALTER fail, so the run stops loudly. Idempotent.
 */
const transferOwnership = async (
  client: PoolClient,
  roles: CommunityRoleNames,
  database: string,
): Promise<OwnershipResult> => {
  const ownerOid = `(SELECT oid FROM pg_roles WHERE rolname = $2)`;
  const notExt = (cls: string, col: string): string =>
    `NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = '${cls}'::regclass
                  AND d.objid = ${col} AND d.deptype = 'e')`;
  const relations = await client.query<TransferTarget>(
    `SELECT CASE c.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW'
              WHEN 'f' THEN 'FOREIGN TABLE' WHEN 'S' THEN 'SEQUENCE' ELSE 'TABLE' END AS kind,
            format('%I.%I', n.nspname, c.relname) AS name
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
        AND c.relowner <> ${ownerOid} AND ${notExt('pg_class', 'c.oid')}
        -- sequences owned by a column move with their table
        AND NOT (c.relkind = 'S' AND EXISTS (
              SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass
                 AND d.objid = c.oid AND d.refclassid = 'pg_class'::regclass
                 AND d.deptype IN ('a', 'i')))
      ORDER BY (c.relkind = 'S'), 2`,
    [COMMUNITY_SCHEMA, roles.owner],
  );
  const routines = await client.query<TransferTarget>(
    `SELECT 'ROUTINE' AS kind, p.oid::regprocedure::text AS name
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = $1 AND p.proowner <> ${ownerOid} AND ${notExt('pg_proc', 'p.oid')}
      ORDER BY 2`,
    [COMMUNITY_SCHEMA, roles.owner],
  );
  const types = await client.query<TransferTarget>(
    `SELECT 'TYPE' AS kind, format('%I.%I', n.nspname, t.typname) AS name
       FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = $1 AND t.typowner <> ${ownerOid} AND ${notExt('pg_type', 't.oid')}
        AND (t.typtype IN ('d', 'e', 'r')
             OR (t.typtype = 'c' AND EXISTS (SELECT 1 FROM pg_class c
                                              WHERE c.oid = t.typrelid AND c.relkind = 'c')))
      ORDER BY 2`,
    [COMMUNITY_SCHEMA, roles.owner],
  );
  const schemaOwned = await client.query<{ ok: boolean }>(
    `SELECT nspowner = ${ownerOid} AS ok FROM pg_namespace WHERE nspname = $1`,
    [COMMUNITY_SCHEMA, roles.owner],
  );
  const targets = [...relations.rows, ...routines.rows, ...types.rows];
  const owner = ident(client, roles.owner);
  const schemaTransferred = schemaOwned.rows[0]?.ok === false;
  if (targets.length === 0 && !schemaTransferred) return { transferred: 0, schemaTransferred };

  await client.query('BEGIN');
  try {
    if (schemaTransferred) {
      // ALTER SCHEMA … OWNER needs the new owner to hold CREATE on the database at that moment.
      // It is granted for this statement only and revoked in the same transaction.
      const db = ident(client, database);
      await client.query(`GRANT CREATE ON DATABASE ${db} TO ${owner}`);
      await client.query(`ALTER SCHEMA ${ident(client, COMMUNITY_SCHEMA)} OWNER TO ${owner}`);
      await client.query(`REVOKE CREATE ON DATABASE ${db} FROM ${owner}`);
    }
    for (const t of targets) {
      // `name` comes from format('%I') / regprocedure, i.e. it is already quoted.
      await client.query(`ALTER ${t.kind} ${t.name} OWNER TO ${owner}`);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw new Error(
      `Transferring Community objects to ${roles.owner} failed (SQLSTATE ${sqlstate(error)}): ` +
        'an object may be owned by a third role; reassign it manually',
    );
  }
  return { transferred: targets.length, schemaTransferred };
};

const createOrRotateLogin = async (
  client: PoolClient,
  role: string,
  kind: CredentialKind,
  rotate: boolean,
  options: ProvisionOptions,
): Promise<{ created: boolean; password?: string }> => {
  if (!(await attributes(client, role))) {
    const password = options.newPassword(kind);
    await setPasswordQuietly(client, role, password, true);
    options.passwordApplied?.(kind);
    return { created: true, password };
  }
  if (rotate) {
    const password = options.newPassword(kind);
    await setPasswordQuietly(client, role, password, false);
    options.passwordApplied?.(kind);
    return { created: false, password };
  }
  return { created: false };
};

/**
 * Idempotent provisioning, run as the Neon BRANCH OWNER (`neondb_owner`; locally an equivalent
 * CREATEROLE login that owns the database) over a DIRECT connection:
 * 1. creates/validates `community_owner` (NOLOGIN), `community_migrator` (LOGIN NOINHERIT,
 *    member of the owner WITH INHERIT FALSE, SET TRUE) and `community_app` (LOGIN, no
 *    membership); passwords only for created/rotated login roles;
 * 2. gives the provisioning role a SET-only membership in the owner and transfers ownership of
 *    the schema and of everything it owns in it to `community_owner`;
 * 3. database: removes PUBLIC's TEMP and CREATE, grants CONNECT to the two login roles;
 * 4. drops default privileges the provisioning role once set for the runtime role;
 * 5. as `community_owner`: syncs table grants and default privileges (FOR ROLE community_owner).
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
  if ([roles.runtime, roles.readonly, roles.migrator, roles.owner].includes(me)) {
    throw new Error(
      'Run provisioning as the Neon BRANCH OWNER (admin) role, not as a Community role',
    );
  }
  const database = ident(client, db);

  // 1a. owner (NOLOGIN)
  let ownerCreated = false;
  if (!(await attributes(client, roles.owner))) {
    await client.query(`CREATE ROLE ${ident(client, roles.owner)} NOLOGIN ${ATTRIBUTE_SQL}`);
    ownerCreated = true;
  }
  const ownerAttributesFixed = await ensureAttributes(client, roles.owner, false);
  await ensureNoMemberships(client, roles.owner);
  // The provisioning role needs SET (not INHERIT) on the owner to hand objects over to it.
  if (!(await canSetRole(client, me, roles.owner))) {
    try {
      await client.query(
        `GRANT ${ident(client, roles.owner)} TO ${ident(client, me)} WITH INHERIT FALSE, SET TRUE`,
      );
    } catch (error) {
      throw new Error(
        `Cannot grant ${roles.owner} to the provisioning role (SQLSTATE ${sqlstate(error)}): ` +
          'it needs ADMIN on the owner role (true for the role that created it)',
      );
    }
  }

  // 1b. migrator (LOGIN NOINHERIT, SET-only member of the owner)
  const migrator = await createOrRotateLogin(
    client,
    roles.migrator,
    'migrator',
    options.rotateMigratorPassword === true,
    options,
  );
  const migratorAttributesFixed = await ensureAttributes(client, roles.migrator, true);
  await ensureMigratorMembership(client, roles);

  // 1c. runtime (LOGIN, member of nothing)
  const runtime = await createOrRotateLogin(
    client,
    roles.runtime,
    'runtime',
    options.rotatePassword === true,
    options,
  );
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

  // 2. ownership
  const ownership = await transferOwnership(client, roles, db);

  // 3. database-level privileges
  await client.query(`REVOKE TEMPORARY, CREATE ON DATABASE ${database} FROM PUBLIC`);
  for (const login of [roles.runtime, roles.migrator]) {
    await client.query(`GRANT CONNECT ON DATABASE ${database} TO ${ident(client, login)}`);
    await client.query(
      `REVOKE TEMPORARY, CREATE ON DATABASE ${database} FROM ${ident(client, login)}`,
    );
  }
  await client.query(
    `REVOKE TEMPORARY, CREATE ON DATABASE ${database} FROM ${ident(client, roles.owner)}`,
  );
  if (options.withReadonly) {
    await client.query(`GRANT CONNECT ON DATABASE ${database} TO ${ident(client, roles.readonly)}`);
  }

  // 4. default privileges the provisioning role set in earlier versions (it owned the tables).
  const schema = ident(client, COMMUNITY_SCHEMA);
  for (const grantee of [roles.runtime, roles.migrator]) {
    const g = ident(client, grantee);
    const dp = `ALTER DEFAULT PRIVILEGES FOR ROLE ${ident(client, me)} IN SCHEMA ${schema}`;
    await client.query(`${dp} REVOKE ALL ON TABLES FROM ${g}`);
    await client.query(`${dp} REVOKE ALL ON SEQUENCES FROM ${g}`);
  }

  // 5. grants, as the owner
  const grants = await asRole(client, roles.owner, () => syncCommunityGrants(client, roles));
  return {
    ownerCreated,
    ownerAttributesFixed,
    migratorCreated: migrator.created,
    migratorAttributesFixed,
    migratorPassword: migrator.password,
    runtimeCreated: runtime.created,
    runtimeAttributesFixed,
    runtimePassword: runtime.password,
    readonlyCreated,
    ownership,
    grants,
  };
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
  /** Direct memberships (pg_auth_members rows where this role is the member). */
  memberOf: number;
  memberships: MembershipRow[];
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
      memberships: [],
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
  const memberships = await membershipsOf(client, role);
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
    memberOf: memberships.length,
    memberships,
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

/** Booleans describing the three-role model on the current database (`--verify`). */
export interface OwnershipModelReport {
  owner: {
    exists: boolean;
    nologin: boolean;
    noAttributes: boolean;
    memberOfNothing: boolean;
    ownsSchema: boolean;
    /** Relations/routines/types in the schema not owned by the owner (extensions excluded). */
    objectsNotOwned: number;
    /** Every trigger on the append-only tables is present and enabled. */
    auditTriggersEnabled: boolean;
  };
  migrator: {
    exists: boolean;
    login: boolean;
    noinherit: boolean;
    noOtherAttributes: boolean;
    onlyMemberOfOwner: boolean;
    membershipSetTrue: boolean;
    membershipInheritFalse: boolean;
    membershipAdminFalse: boolean;
    /** No table privilege of its own (it must SET ROLE first). */
    noTablePrivileges: boolean;
    schemaCreate: boolean;
    databaseCreate: boolean;
    databaseTemporary: boolean;
  };
  runtime: {
    memberOfOwner: boolean;
    memberOfMigrator: boolean;
    canSetRoleOwner: boolean;
    canSetRoleMigrator: boolean;
    /** Default ACL entries for the runtime role set by any role other than the owner. */
    foreignDefaultAcls: number;
    /** Default ACL FOR ROLE owner: tables SELECT+INSERT, sequences USAGE+SELECT. */
    ownerDefaultAclTables: string | null;
    ownerDefaultAclSequences: string | null;
  };
}

const APPEND_ONLY_TRIGGERS = [
  ['moderation_actions', 'moderation_actions_server_time'],
  ['moderation_actions', 'moderation_actions_no_update_delete'],
  ['moderation_actions', 'moderation_actions_no_truncate'],
  ['auth_events', 'auth_events_server_time'],
  ['auth_events', 'auth_events_no_update_delete'],
  ['auth_events', 'auth_events_no_truncate'],
] as const;

export const ownershipModelReport = async (
  client: PoolClient,
  roles: CommunityRoleNames = DEFAULT_ROLE_NAMES,
): Promise<OwnershipModelReport> => {
  const q = async <T>(sql: string, params: unknown[]): Promise<T> =>
    (await client.query(sql, params)).rows[0] as T;
  const ownerAttrs = await attributes(client, roles.owner);
  const migAttrs = await attributes(client, roles.migrator);
  const ownerOid = `(SELECT oid FROM pg_roles WHERE rolname = $2)`;
  const notOwned = ownerAttrs
    ? await q<{ n: number }>(
        `SELECT ((SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                   WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m','f','S','i','c')
                     AND c.relowner <> ${ownerOid}
                     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass
                                       AND d.objid = c.oid AND d.deptype = 'e'))
               + (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                   WHERE n.nspname = $1 AND p.proowner <> ${ownerOid}
                     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass
                                       AND d.objid = p.oid AND d.deptype = 'e'))
               + (SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                   WHERE n.nspname = $1 AND t.typowner <> ${ownerOid}
                     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_type'::regclass
                                       AND d.objid = t.oid AND d.deptype = 'e')))::int AS n`,
        [COMMUNITY_SCHEMA, roles.owner],
      )
    : { n: -1 };
  const ownsSchema = ownerAttrs
    ? (
        await q<{ ok: boolean }>(
          `SELECT nspowner = ${ownerOid} AS ok FROM pg_namespace WHERE nspname = $1`,
          [COMMUNITY_SCHEMA, roles.owner],
        )
      ).ok
    : false;
  const triggers = await q<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND t.tgenabled IN ('O', 'A')
        AND (c.relname, t.tgname) IN (${APPEND_ONLY_TRIGGERS.map(
          ([tbl, tg]) => `(${client.escapeLiteral(tbl)}, ${client.escapeLiteral(tg)})`,
        ).join(', ')})`,
    [COMMUNITY_SCHEMA],
  );
  const migMemberships = migAttrs ? await membershipsOf(client, roles.migrator) : [];
  const toOwner = migMemberships.filter(m => m.role === roles.owner);
  const migReport = migAttrs ? await roleReport(client, roles.migrator) : undefined;
  const runtimeExists = (await attributes(client, roles.runtime)) !== null;
  const has = async (role: string, target: string, mode: string): Promise<boolean> => {
    if (!runtimeExists || !(await attributes(client, target))) return false;
    return (await q<{ ok: boolean }>(`SELECT pg_has_role($1, $2, $3) AS ok`, [role, target, mode]))
      .ok;
  };
  const acl = runtimeExists
    ? await client.query<{ grantor: string; objtype: string; acl: string }>(
        `SELECT pg_get_userbyid(d.defaclrole) AS grantor, d.defaclobjtype AS objtype,
                array_to_string(ARRAY(SELECT privilege_type FROM aclexplode(d.defaclacl) x
                                       WHERE x.grantee = (SELECT oid FROM pg_roles WHERE rolname = $1)
                                       ORDER BY 1), ',') AS acl
           FROM pg_default_acl d
          WHERE EXISTS (SELECT 1 FROM aclexplode(d.defaclacl) x
                         WHERE x.grantee = (SELECT oid FROM pg_roles WHERE rolname = $1))`,
        [roles.runtime],
      )
    : { rows: [] };
  const ownerAcl = (objtype: string): string | null =>
    acl.rows.find(r => r.grantor === roles.owner && r.objtype === objtype)?.acl ?? null;
  return {
    owner: {
      exists: ownerAttrs !== null,
      nologin: ownerAttrs ? !ownerAttrs.rolcanlogin : false,
      noAttributes: ownerAttrs ? wrongAttributes(ownerAttrs, false).length === 0 : false,
      memberOfNothing: ownerAttrs ? (await membershipsOf(client, roles.owner)).length === 0 : false,
      ownsSchema,
      objectsNotOwned: notOwned.n,
      auditTriggersEnabled: triggers.n === APPEND_ONLY_TRIGGERS.length,
    },
    migrator: {
      exists: migAttrs !== null,
      login: migAttrs?.rolcanlogin ?? false,
      noinherit: migAttrs ? !migAttrs.rolinherit : false,
      noOtherAttributes: migAttrs ? wrongAttributes(migAttrs, true).length === 0 : false,
      onlyMemberOfOwner:
        migMemberships.length > 0 && migMemberships.every(m => m.role === roles.owner),
      membershipSetTrue: toOwner.length > 0 && toOwner.every(m => m.set_option),
      membershipInheritFalse: toOwner.length > 0 && toOwner.every(m => !m.inherit_option),
      membershipAdminFalse: toOwner.length > 0 && toOwner.every(m => !m.admin_option),
      noTablePrivileges: migReport
        ? migReport.tables.every(
            t => !t.anyColumnSelect && TABLE_PRIVILEGES.every(p => !t.privileges[p]),
          )
        : false,
      schemaCreate: migReport?.schema.create ?? false,
      databaseCreate: migReport?.database.create ?? false,
      databaseTemporary: migReport?.database.temporary ?? false,
    },
    runtime: {
      memberOfOwner: await has(roles.runtime, roles.owner, 'MEMBER'),
      memberOfMigrator: await has(roles.runtime, roles.migrator, 'MEMBER'),
      canSetRoleOwner: await has(roles.runtime, roles.owner, 'SET'),
      canSetRoleMigrator: await has(roles.runtime, roles.migrator, 'SET'),
      foreignDefaultAcls: acl.rows.filter(r => r.grantor !== roles.owner).length,
      ownerDefaultAclTables: ownerAcl('r'),
      ownerDefaultAclSequences: ownerAcl('S'),
    },
  };
};

/** Differences between the ownership report and the intended three-role model. */
export const ownershipViolations = (r: OwnershipModelReport): string[] => {
  const out: string[] = [];
  const o = r.owner;
  if (!o.exists) return ['owner role does not exist'];
  if (!o.nologin) out.push('owner: can log in');
  if (!o.noAttributes) out.push('owner: has role attributes');
  if (!o.memberOfNothing) out.push('owner: member of another role');
  if (!o.ownsSchema) out.push('owner: does not own the schema');
  if (o.objectsNotOwned !== 0) out.push(`owner: ${o.objectsNotOwned} object(s) owned by others`);
  if (!o.auditTriggersEnabled) out.push('append-only triggers missing or disabled');
  const m = r.migrator;
  if (!m.exists) out.push('migrator role does not exist');
  else {
    if (!m.login) out.push('migrator: cannot log in');
    if (!m.noinherit) out.push('migrator: INHERIT');
    if (!m.noOtherAttributes) out.push('migrator: has role attributes');
    if (!m.onlyMemberOfOwner) out.push('migrator: membership is not exactly the owner');
    if (!m.membershipSetTrue) out.push('migrator: membership lacks SET');
    if (!m.membershipInheritFalse) out.push('migrator: membership INHERIT TRUE');
    if (!m.membershipAdminFalse) out.push('migrator: membership has ADMIN');
    if (!m.noTablePrivileges) out.push('migrator: has table privileges of its own');
    if (m.schemaCreate) out.push('migrator: CREATE on schema');
    if (m.databaseCreate) out.push('migrator: CREATE on database');
    if (m.databaseTemporary) out.push('migrator: TEMPORARY on database');
  }
  const a = r.runtime;
  if (a.memberOfOwner) out.push('runtime: member of the owner');
  if (a.memberOfMigrator) out.push('runtime: member of the migrator');
  if (a.canSetRoleOwner) out.push('runtime: can SET ROLE owner');
  if (a.canSetRoleMigrator) out.push('runtime: can SET ROLE migrator');
  if (a.foreignDefaultAcls !== 0) out.push('runtime: default ACL set by a non-owner role');
  if (a.ownerDefaultAclTables !== 'INSERT,SELECT') out.push('runtime: owner default ACL (tables)');
  if (a.ownerDefaultAclSequences !== 'SELECT,USAGE') {
    out.push('runtime: owner default ACL (sequences)');
  }
  return out;
};
