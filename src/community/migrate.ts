/**
 * Numbered, reversible SQL migrations for the Community database (ADR-001 §8, D-007).
 *
 * Files: `src/community/migrations/NNNN_name.up.sql` and `NNNN_name.down.sql`. Each migration
 * runs in its own transaction and is recorded in `community_schema_migrations`. Run as the
 * migration owner role over the DIRECT URL, never as the runtime `community_app` role.
 *
 * After every `up` the runner re-applies the Community grants (`syncCommunityGrants`, ADR-001
 * B2), so a new table cannot silently lack, or over-grant, runtime privileges. A table that is
 * not classified in `db-roles.ts` gets no runtime privilege and `up` fails loudly.
 *
 *   COMMUNITY_DATABASE_URL_DIRECT=... npx ts-node src/community/migrate.ts up
 *   COMMUNITY_DATABASE_URL_DIRECT=... npx ts-node src/community/migrate.ts down [steps]
 *   COMMUNITY_DATABASE_URL_DIRECT=... npx ts-node src/community/migrate.ts status
 *
 * (`COMMUNITY_DATABASE_URL` is accepted when `_DIRECT` is unset, for local databases.) For a
 * non-local host the connection is forced to `sslmode=verify-full` (B5).
 */
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { Pool, PoolClient } from 'pg';
import { syncCommunityGrants } from './db-roles';
import { forceVerifyFull } from './db-url';

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

export const appliedVersions = async (pool: Pool): Promise<number[]> => {
  const client = await pool.connect();
  try {
    await ensureTable(client);
    const { rows } = await client.query<{ version: number }>(
      'SELECT version FROM community_schema_migrations ORDER BY version',
    );
    return rows.map(r => r.version);
  } finally {
    client.release();
  }
};

/** Applies every pending migration in order. Returns the versions applied. */
export const migrateUp = async (pool: Pool, migrations = loadMigrations()): Promise<number[]> => {
  const done = new Set(await appliedVersions(pool));
  const applied: number[] = [];
  for (const migration of migrations) {
    if (done.has(migration.version)) continue;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(migration.up);
      await client.query(
        'INSERT INTO community_schema_migrations (version, name) VALUES ($1, $2)',
        [migration.version, migration.name],
      );
      await client.query('COMMIT');
      applied.push(migration.version);
    } catch (error) {
      await client.query('ROLLBACK');
      throw new Error(
        `Migration ${migration.version}_${migration.name} failed: ${(error as Error).message}`,
      );
    } finally {
      client.release();
    }
  }
  const client = await pool.connect();
  try {
    const { unclassified } = await syncCommunityGrants(client);
    if (unclassified.length > 0) {
      throw new Error(
        `Unclassified Community table(s) ${unclassified.join(', ')}: add them to TABLE_CLASSES ` +
          'in src/community/db-roles.ts (they have NO runtime privilege until then)',
      );
    }
  } finally {
    client.release();
  }
  return applied;
};

/** Reverts the latest `steps` applied migrations (default: all). Returns versions reverted. */
export const migrateDown = async (
  pool: Pool,
  steps = Number.POSITIVE_INFINITY,
  migrations = loadMigrations(),
): Promise<number[]> => {
  const done = (await appliedVersions(pool)).sort((a, b) => b - a).slice(0, steps);
  const reverted: number[] = [];
  for (const version of done) {
    const migration = migrations.find(m => m.version === version);
    if (!migration) throw new Error(`Applied migration ${version} has no file`);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(migration.down);
      await client.query('DELETE FROM community_schema_migrations WHERE version = $1', [version]);
      await client.query('COMMIT');
      reverted.push(version);
    } catch (error) {
      await client.query('ROLLBACK');
      throw new Error(
        `Rollback of ${version}_${migration.name} failed: ${(error as Error).message}`,
      );
    } finally {
      client.release();
    }
  }
  return reverted;
};

/* istanbul ignore next -- CLI entry point */
if (require.main === module) {
  const [command = 'status', arg] = process.argv.slice(2);
  const name = process.env.COMMUNITY_DATABASE_URL_DIRECT
    ? 'COMMUNITY_DATABASE_URL_DIRECT'
    : 'COMMUNITY_DATABASE_URL';
  const url = process.env[name];
  if (!url) throw new Error('Missing COMMUNITY_DATABASE_URL_DIRECT (owner, direct URL)');
  const pool = new Pool({ connectionString: forceVerifyFull(url, name) });
  const run = async (): Promise<unknown> => {
    if (command === 'up') return migrateUp(pool);
    if (command === 'down') return migrateDown(pool, arg ? Number.parseInt(arg, 10) : 1);
    return appliedVersions(pool);
  };
  run()
    .then(result => process.stdout.write(`${command}: ${JSON.stringify(result)}\n`))
    .catch(error => {
      process.stderr.write(`${(error as Error).message}\n`);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
