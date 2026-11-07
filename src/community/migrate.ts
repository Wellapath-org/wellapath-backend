/**
 * Numbered, reversible SQL migrations for the Community database (ADR-001 §8, D-007).
 *
 * Files: `src/community/migrations/NNNN_name.up.sql` and `NNNN_name.down.sql`. Each migration
 * runs in its own transaction and is recorded in `community_schema_migrations`.
 *
 * Three-role model (db-roles.ts): connect as `community_migrator` over the DIRECT (unpooled)
 * URL. The runner issues `SET ROLE community_owner` inside every migration transaction (and
 * around its bookkeeping and the grant sync) and `RESET ROLE` afterwards, so every object is
 * created by, and owned by, the NOLOGIN owner. The migrator has no privilege of its own. Never
 * run as the runtime `community_app` role. A Neon pooled host (`-pooler`) is refused: session
 * state such as SET ROLE does not survive transaction pooling.
 *
 * After every `up` the runner re-applies the Community grants (`syncCommunityGrants`, ADR-001
 * B2), so a new table cannot silently lack, or over-grant, runtime privileges. A table that is
 * not classified in `db-roles.ts` gets no runtime privilege and `up` fails loudly.
 *
 *   COMMUNITY_DATABASE_URL_DIRECT=<migrator, direct> npx ts-node src/community/migrate.ts up
 *   COMMUNITY_DATABASE_URL_DIRECT=... npx ts-node src/community/migrate.ts down [steps]
 *   COMMUNITY_DATABASE_URL_DIRECT=... npx ts-node src/community/migrate.ts status
 *   [--owner-role <name>]   role to SET ROLE to (default community_owner)
 *   [--no-set-role]         legacy/unprovisioned LOCAL database: run as the session user
 *
 * (`COMMUNITY_DATABASE_URL` is accepted when `_DIRECT` is unset, for LOCAL databases only.) For
 * a non-local host the connection is forced to `sslmode=verify-full` (B5).
 */
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { Pool, PoolClient } from 'pg';
import { asRole, OWNER_ROLE, syncCommunityGrants } from './db-roles';
import { assertDirectEndpoint, forceVerifyFull, isRemoteDatabaseUrl } from './db-url';

export interface MigrateOptions {
  /**
   * Role to `SET ROLE` to for every migration transaction, the bookkeeping and the grant sync
   * (three-role model: `community_owner`). null/undefined = run as the session user (legacy).
   */
  ownerRole?: string | null;
}

/** A migration's own SQL failed (the transaction was rolled back; the connection is fine). */
class MigrationError extends Error {}

/**
 * Runs `fn` on a pooled client as `ownerRole`. After any error the client is destroyed rather
 * than returned to the pool, so a connection can never be reused with an elevated role.
 */
const withClient = async <T>(
  pool: Pool,
  ownerRole: string | null | undefined,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> => {
  const client = await pool.connect();
  let broken = false;
  try {
    return await asRole(client, ownerRole, () => fn(client));
  } catch (error) {
    broken = true;
    throw error;
  } finally {
    client.release(broken);
  }
};

export interface Migration {
  version: number;
  name: string;
  up: string;
  down: string;
}

const resolveMigrationsDir = (): string => {
  const candidates = [
    process.env.COMMUNITY_MIGRATIONS_DIR,
    join(__dirname, 'migrations'),
    join(__dirname, '../../src/community/migrations'),
  ].filter((dir): dir is string => Boolean(dir));
  const found = candidates.find(dir => existsSync(dir));
  if (!found) throw new Error('Community migrations directory not found');
  return found;
};

export const loadMigrations = (dir: string = resolveMigrationsDir()): Migration[] => {
  const files = readdirSync(dir);
  const ups = files.filter(f => /^\d{4}_[a-z0-9_]+\.up\.sql$/.test(f)).sort();
  return ups.map(upFile => {
    const base = upFile.replace(/\.up\.sql$/, '');
    const downFile = `${base}.down.sql`;
    if (!files.includes(downFile)) throw new Error(`Migration ${base} has no down file`);
    return {
      version: Number.parseInt(base.slice(0, 4), 10),
      name: base.slice(5),
      up: readFileSync(join(dir, upFile), 'utf8'),
      down: readFileSync(join(dir, downFile), 'utf8'),
    };
  });
};

const ensureTable = async (client: PoolClient): Promise<void> => {
  await client.query(`CREATE TABLE IF NOT EXISTS community_schema_migrations (
    version integer PRIMARY KEY,
    name text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
};

export const appliedVersions = async (
  pool: Pool,
  options: MigrateOptions = {},
): Promise<number[]> =>
  withClient(pool, options.ownerRole, async client => {
    await ensureTable(client);
    const { rows } = await client.query<{ version: number }>(
      'SELECT version FROM community_schema_migrations ORDER BY version',
    );
    return rows.map(r => r.version);
  });

/** One migration step in its own transaction, as `ownerRole` (SET ROLE inside, RESET after). */
const runStep = async (
  pool: Pool,
  ownerRole: string | null | undefined,
  label: string,
  sql: string,
  bookkeeping: [string, unknown[]],
): Promise<void> => {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    try {
      if (ownerRole) await client.query(`SET ROLE ${client.escapeIdentifier(ownerRole)}`);
      await client.query(sql);
      await client.query(bookkeeping[0], bookkeeping[1]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {
        broken = true;
      });
      throw new MigrationError(`${label} failed: ${(error as Error).message}`);
    }
    // SET ROLE inside the transaction persists after COMMIT (it is session state).
    if (ownerRole) await client.query('RESET ROLE');
  } catch (error) {
    if (!(error instanceof MigrationError)) broken = true;
    throw error;
  } finally {
    client.release(broken);
  }
};

/** Applies every pending migration in order. Returns the versions applied. */
export const migrateUp = async (
  pool: Pool,
  migrations = loadMigrations(),
  options: MigrateOptions = {},
): Promise<number[]> => {
  const done = new Set(await appliedVersions(pool, options));
  const applied: number[] = [];
  for (const migration of migrations) {
    if (done.has(migration.version)) continue;
    await runStep(
      pool,
      options.ownerRole,
      `Migration ${migration.version}_${migration.name}`,
      migration.up,
      [
        'INSERT INTO community_schema_migrations (version, name) VALUES ($1, $2)',
        [migration.version, migration.name],
      ],
    );
    applied.push(migration.version);
  }
  const { unclassified } = await withClient(pool, options.ownerRole, client =>
    syncCommunityGrants(client),
  );
  if (unclassified.length > 0) {
    throw new Error(
      `Unclassified Community table(s) ${unclassified.join(', ')}: add them to TABLE_CLASSES ` +
        'in src/community/db-roles.ts (they have NO runtime privilege until then)',
    );
  }
  return applied;
};

/** Reverts the latest `steps` applied migrations (default: all). Returns versions reverted. */
export const migrateDown = async (
  pool: Pool,
  steps = Number.POSITIVE_INFINITY,
  migrations = loadMigrations(),
  options: MigrateOptions = {},
): Promise<number[]> => {
  const done = (await appliedVersions(pool, options)).sort((a, b) => b - a).slice(0, steps);
  const reverted: number[] = [];
  for (const version of done) {
    const migration = migrations.find(m => m.version === version);
    if (!migration) throw new Error(`Applied migration ${version} has no file`);
    await runStep(
      pool,
      options.ownerRole,
      `Rollback of ${version}_${migration.name}`,
      migration.down,
      ['DELETE FROM community_schema_migrations WHERE version = $1', [version]],
    );
    reverted.push(version);
  }
  return reverted;
};

/* istanbul ignore next -- CLI entry point */
if (require.main === module) {
  const args = process.argv.slice(2);
  const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--owner-role');
  const [command = 'status', arg] = positional;
  const roleFlag = args.indexOf('--owner-role');
  const ownerRole = args.includes('--no-set-role')
    ? null
    : roleFlag >= 0
      ? args[roleFlag + 1]
      : OWNER_ROLE;
  const direct = process.env.COMMUNITY_DATABASE_URL_DIRECT;
  const name = direct ? 'COMMUNITY_DATABASE_URL_DIRECT' : 'COMMUNITY_DATABASE_URL';
  const url = direct ?? process.env.COMMUNITY_DATABASE_URL;
  const fail = (message: string): void => {
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  };
  if (!url) {
    fail('Missing COMMUNITY_DATABASE_URL_DIRECT (community_migrator, DIRECT URL)');
  } else if (!direct && isRemoteDatabaseUrl(url, name)) {
    fail('Refusing: a non-local database needs COMMUNITY_DATABASE_URL_DIRECT (the DIRECT URL)');
  } else {
    try {
      assertDirectEndpoint(url, name);
      const pool = new Pool({ connectionString: forceVerifyFull(url, name), max: 1 });
      const options: MigrateOptions = { ownerRole };
      const run = async (): Promise<unknown> => {
        if (ownerRole) {
          const { rows } = await pool.query<{ ok: boolean | null }>(
            `SELECT pg_has_role(current_user, oid, 'SET') AS ok FROM pg_roles WHERE rolname = $1`,
            [ownerRole],
          );
          if (rows.length === 0) {
            throw new Error(
              `Role ${ownerRole} does not exist: run provision-runtime-role first ` +
                '(or --no-set-role on an unprovisioned LOCAL database)',
            );
          }
          if (!rows[0].ok) throw new Error(`The connecting role cannot SET ROLE ${ownerRole}`);
        }
        if (command === 'up') return migrateUp(pool, undefined, options);
        if (command === 'down') {
          return migrateDown(pool, arg ? Number.parseInt(arg, 10) : 1, undefined, options);
        }
        return appliedVersions(pool, options);
      };
      run()
        .then(result => process.stdout.write(`${command}: ${JSON.stringify(result)}\n`))
        .catch(error =>
          fail((error as Error).message.replace(/postgres(ql)?:\/\/\S+/g, '<redacted>')),
        )
        .finally(() => pool.end());
    } catch (error) {
      fail((error as Error).message);
    }
  }
}
