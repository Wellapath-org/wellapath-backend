/**
 * Provision the Community three-role model (ADR-001 amendment B2): `community_owner` (NOLOGIN,
 * owns everything), `community_migrator` (LOGIN NOINHERIT, SET-only member of the owner) and the
 * runtime role `community_app`. Idempotent. Run as the Neon BRANCH OWNER (`neondb_owner`) over
 * the DIRECT URL, once per Neon branch (development first, then staging, then production):
 *
 *   DOTENV_CONFIG_QUIET=true DOTENV_CONFIG_PATH=<private>/neon/<branch>.env            \
 *     node -r dotenv/config -r ts-node/register scripts/community/provision-runtime-role.ts \
 *       --runtime-env-out  <private>/neon/<branch>.runtime.env                      \
 *       --migrator-env-out <private>/neon/<branch>.migrator.env  --verify
 *   (COMMUNITY_DATABASE_URL_DIRECT = owner, direct URL; COMMUNITY_DATABASE_URL = owner, POOLED
 *    URL: only its host/db/params are reused for the runtime credential.)
 *
 * - Creates any missing role. Passwords: crypto.randomBytes(32), base64url (43 chars), written
 *   ONLY to the matching --*-env-out file (mode 600, created exclusively: the file must not
 *   exist), never printed, logged or put in any SQL statement text:
 *     runtime  → COMMUNITY_DATABASE_URL        = pooled host, community_app, sslmode=verify-full
 *     migrator → COMMUNITY_DATABASE_URL_DIRECT = direct host, community_migrator, verify-full
 * - Existing roles: attributes and memberships checked/fixed; passwords left alone unless
 *   --rotate-password (runtime) / --rotate-migrator-password (migrator), which overwrite the file.
 * - Transfers ownership of the schema and of every object the branch owner owns in it to
 *   `community_owner`, then syncs grants AS the owner (default privileges FOR ROLE
 *   community_owner) and removes PUBLIC's TEMP/CREATE on the database.
 * - --with-readonly also defines `community_readonly`. LOCAL hosts only: never on a Neon branch
 *   (roles are branch-wide). Refused against a non-local host.
 * - --verify prints the three-role booleans and the runtime privilege matrix (role, table,
 *   privilege booleans only) and exits 1 on any deviation.
 *
 * Output contains role names, table names, counts and booleans only: never a URL, host or
 * password.
 */
import { closeSync, existsSync, openSync, renameSync, unlinkSync, writeSync } from 'fs';
import { Pool, PoolClient } from 'pg';
import {
  CredentialKind,
  DEFAULT_ROLE_NAMES,
  generatePassword,
  OwnershipModelReport,
  ownershipModelReport,
  ownershipViolations,
  provisionCommunityRoles,
  roleReport,
  RoleReport,
  runtimeViolations,
  TABLE_PRIVILEGES,
} from '../../src/community/db-roles';
import {
  assertDirectEndpoint,
  forceVerifyFull,
  isRemoteDatabaseUrl,
  runtimeUrl,
} from '../../src/community/db-url';

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(`--${name}`);
const value = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

/** Creates `path` exclusively with mode 600. */
const writePrivate = (path: string, contents: string): void => {
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeSync(fd, contents);
  } finally {
    closeSync(fd);
  }
};

const printReport = (report: RoleReport): void => {
  const out = process.stdout;
  out.write(`\nrole ${report.role}: exists=${report.exists}\n`);
  if (!report.exists) return;
  const a = report.attributes!;
  out.write(
    `  login=${a.rolcanlogin} superuser=${a.rolsuper} createdb=${a.rolcreatedb} ` +
      `createrole=${a.rolcreaterole} inherit=${a.rolinherit} replication=${a.rolreplication} ` +
      `bypassrls=${a.rolbypassrls} member_of=${report.memberOf}\n`,
  );
  out.write(
    `  database: connect=${report.database.connect} create=${report.database.create} ` +
      `temporary=${report.database.temporary}; schema public: usage=${report.schema.usage} ` +
      `create=${report.schema.create}; pg_authid select=${report.pgAuthidSelect}\n`,
  );
  out.write(`  table | ${TABLE_PRIVILEGES.join(' ')} | any-column SELECT\n`);
  for (const row of report.tables) {
    out.write(
      `  ${row.table} | ${TABLE_PRIVILEGES.map(p => (row.privileges[p] ? 'Y' : '-')).join(' ')} | ${row.anyColumnSelect ? 'Y' : '-'}\n`,
    );
  }
};

const printOwnership = (r: OwnershipModelReport): void => {
  const line = (label: string, obj: Record<string, unknown>): void => {
    process.stdout.write(
      `\n${label}:\n${Object.entries(obj)
        .map(([k, v]) => `  ${k}=${v}`)
        .join('\n')}\n`,
    );
  };
  line(`role ${DEFAULT_ROLE_NAMES.owner}`, r.owner);
  line(`role ${DEFAULT_ROLE_NAMES.migrator}`, r.migrator);
  line(`role ${DEFAULT_ROLE_NAMES.runtime} (membership graph, default ACL)`, r.runtime);
};

const roleExists = async (client: PoolClient, role: string): Promise<boolean> =>
  (await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rowCount === 1;

const main = async (): Promise<void> => {
  const directRaw = process.env.COMMUNITY_DATABASE_URL_DIRECT;
  if (!directRaw) {
    throw new Error('Missing COMMUNITY_DATABASE_URL_DIRECT (branch owner, direct URL)');
  }
  assertDirectEndpoint(directRaw, 'COMMUNITY_DATABASE_URL_DIRECT');
  const direct = forceVerifyFull(directRaw, 'COMMUNITY_DATABASE_URL_DIRECT');
  const pooledTemplate = process.env.COMMUNITY_DATABASE_URL ?? directRaw;
  const withReadonly = flag('with-readonly');
  if (withReadonly && isRemoteDatabaseUrl(directRaw, 'COMMUNITY_DATABASE_URL_DIRECT')) {
    throw new Error(
      '--with-readonly is for LOCAL databases only: Neon roles are branch-wide and the approved ' +
        'model has exactly three Community roles',
    );
  }
  const outputs: Record<CredentialKind, string | undefined> = {
    runtime: value('runtime-env-out'),
    migrator: value('migrator-env-out'),
  };
  const rotate: Record<CredentialKind, boolean> = {
    runtime: flag('rotate-password'),
    migrator: flag('rotate-migrator-password'),
  };
  const roleOf: Record<CredentialKind, string> = {
    runtime: DEFAULT_ROLE_NAMES.runtime,
    migrator: DEFAULT_ROLE_NAMES.migrator,
  };

  // New credentials go to a pending file first (exclusive, 600) and are moved into place only
  // after the role change committed, so neither a failure nor a crash loses the only copy or
  // leaves a file whose password was never applied.
  const pending: Partial<Record<CredentialKind, string>> = {};
  const pool = new Pool({ connectionString: direct, max: 1 });
  const client = await pool.connect();
  try {
    // Pre-flight, before any change: every role that will get a password has a fresh file.
    for (const kind of ['runtime', 'migrator'] as const) {
      const needsPassword = rotate[kind] || !(await roleExists(client, roleOf[kind]));
      const out = outputs[kind];
      if (!needsPassword) {
        if (out && existsSync(out)) {
          process.stdout.write(`provision: --${kind}-env-out exists; it will not be touched\n`);
        }
        continue;
      }
      if (!out) {
        throw new Error(
          `${roleOf[kind]} must be created (or rotated) but --${kind}-env-out was not given; ` +
            'refusing, because the generated password would be lost',
        );
      }
      if (existsSync(out) && !rotate[kind]) {
        throw new Error(`--${kind}-env-out already exists; refusing to overwrite it`);
      }
      if (existsSync(`${out}.pending`)) {
        throw new Error(`--${kind}-env-out.pending exists (an earlier run failed); inspect it`);
      }
    }

    const result = await provisionCommunityRoles(client, {
      withReadonly,
      rotatePassword: rotate.runtime,
      rotateMigratorPassword: rotate.migrator,
      newPassword: kind => {
        const out = outputs[kind] as string;
        const password = generatePassword();
        const line =
          kind === 'runtime'
            ? [
                '# Community RUNTIME role (community_app), POOLED endpoint, sslmode=verify-full.',
                `COMMUNITY_DATABASE_URL="${runtimeUrl(pooledTemplate, roleOf.runtime, password)}"`,
              ]
            : [
                '# Community MIGRATOR role (community_migrator), DIRECT endpoint, sslmode=verify-full.',
                '# Migrations run as community_owner via SET ROLE (src/community/migrate.ts).',
                `COMMUNITY_DATABASE_URL_DIRECT="${runtimeUrl(directRaw, roleOf.migrator, password)}"`,
              ];
        writePrivate(
          `${out}.pending`,
          [
            line[0],
            `# Generated ${new Date().toISOString()} by provision-runtime-role. Never commit or print.`,
            ...line.slice(1),
            '',
          ].join('\n'),
        );
        pending[kind] = `${out}.pending`;
        return password;
      },
      passwordApplied: kind => {
        const file = pending[kind];
        if (file) renameSync(file, outputs[kind] as string);
        delete pending[kind];
      },
    });
    const status = (created: boolean, rotated: boolean, fixed: string[]): string =>
      `${created ? 'CREATED' : 'already existed'}${rotated && !created ? '; password ROTATED' : ''}` +
      `${fixed.length ? `; fixed attributes: ${fixed.join(', ')}` : ''}`;
    process.stdout.write(
      [
        `provision: ${DEFAULT_ROLE_NAMES.owner} ${status(result.ownerCreated, false, result.ownerAttributesFixed)}`,
        `provision: ${DEFAULT_ROLE_NAMES.migrator} ${status(result.migratorCreated, Boolean(result.migratorPassword), result.migratorAttributesFixed)}` +
          `${result.migratorPassword ? ' (credential written to --migrator-env-out, mode 600)' : ''}`,
        `provision: ${DEFAULT_ROLE_NAMES.runtime} ${status(result.runtimeCreated, Boolean(result.runtimePassword), result.runtimeAttributesFixed)}` +
          `${result.runtimePassword ? ' (credential written to --runtime-env-out, mode 600)' : ''}`,
        `provision: ownership: ${result.ownership.transferred} object(s) transferred to ${DEFAULT_ROLE_NAMES.owner}; ` +
          `schema transferred=${result.ownership.schemaTransferred}`,
        `provision: grants synced for [${result.grants.rolesSynced.join(', ')}] on ${result.grants.tables.length} tables` +
          `${result.grants.unclassified.length ? `; UNCLASSIFIED (no privilege): ${result.grants.unclassified.join(', ')}` : ''}`,
        `${withReadonly ? `provision: ${DEFAULT_ROLE_NAMES.readonly} ${result.readonlyCreated ? 'created' : 'already existed'}` : ''}`,
      ]
        .filter(Boolean)
        .join('\n') + '\n',
    );
    if (flag('verify')) {
      const model = await ownershipModelReport(client);
      printOwnership(model);
      const runtime = await roleReport(client, DEFAULT_ROLE_NAMES.runtime);
      printReport(runtime);
      if (withReadonly) printReport(await roleReport(client, DEFAULT_ROLE_NAMES.readonly));
      const violations = [...ownershipViolations(model), ...runtimeViolations(runtime)];
      process.stdout.write(
        violations.length
          ? `\nVIOLATIONS:\n${violations.map(v => `  ${v}`).join('\n')}\n`
          : '\nThree-role model verified: owner/migrator/runtime match the intended matrix.\n',
      );
      if (violations.length) process.exitCode = 1;
    }
    if (result.grants.unclassified.length) process.exitCode = 1;
  } catch (error) {
    // Only a password that was never applied is discarded.
    for (const file of Object.values(pending)) if (file && existsSync(file)) unlinkSync(file);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
};

/* istanbul ignore next -- CLI entry point */
if (require.main === module) {
  main().catch(error => {
    const message = (error as Error).message.replace(/postgres(ql)?:\/\/\S+/g, '<redacted>');
    process.stderr.write(`provision-runtime-role failed: ${message}\n`);
    process.exitCode = 1;
  });
}
