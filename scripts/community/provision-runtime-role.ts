/**
 * Provision the least-privilege Community runtime role `community_app` (ADR-001 amendment B2).
 * Idempotent. Run as the OWNER role over the DIRECT URL, once per Neon branch (development
 * first, then staging, then production), after `community:migrate up`:
 *
 *   COMMUNITY_DATABASE_URL_DIRECT=<owner, direct URL>                    \
 *   COMMUNITY_DATABASE_URL=<owner, POOLED URL: only its host/db/params are reused>  \
 *     npx ts-node scripts/community/provision-runtime-role.ts             \
 *       --runtime-env-out <private dir>/<branch>.runtime.env [--rotate-password]
 *       [--verify] [--with-readonly]
 *
 * - Creates `community_app` if missing (LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
 *   NOREPLICATION NOBYPASSRLS), with a password from crypto.randomBytes(32) (base64url). The
 *   password is written ONLY to --runtime-env-out (mode 600, created exclusively; the file must
 *   not exist) as COMMUNITY_DATABASE_URL = the pooled host + `community_app` +
 *   sslmode=verify-full. It is never printed, logged or put in any SQL statement text.
 * - If the role exists, its attributes are checked/fixed and the password is left alone, unless
 *   --rotate-password (which overwrites --runtime-env-out).
 * - Grants CONNECT; revokes TEMPORARY/CREATE on the database from PUBLIC; syncs every table
 *   grant (`syncCommunityGrants`): DML on ordinary tables, SELECT+INSERT only on append-only
 *   audit tables, SELECT on reference tables, USAGE/SELECT on sequences, no DDL/TRUNCATE/
 *   REFERENCES/TRIGGER, REVOKE CREATE on schema public, and matching default privileges.
 * - --with-readonly also defines `community_readonly` (NOLOGIN, column-limited SELECT on
 *   non-sensitive data). Refused against a non-local host unless COMMUNITY_ALLOW_REMOTE_READONLY=yes.
 * - --verify prints the privilege matrix (role, table, privilege booleans only) and exits 1 on
 *   any deviation from the intended matrix.
 *
 * Output contains role names, table names and booleans only: never a URL, host or password.
 */
import { closeSync, existsSync, openSync, renameSync, unlinkSync, writeSync } from 'fs';
import { Pool } from 'pg';
import {
  DEFAULT_ROLE_NAMES,
  generatePassword,
  provisionCommunityRoles,
  roleReport,
  RoleReport,
  runtimeViolations,
  TABLE_PRIVILEGES,
} from '../../src/community/db-roles';
import { forceVerifyFull, isRemoteDatabaseUrl, runtimeUrl } from '../../src/community/db-url';

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

const main = async (): Promise<void> => {
  const directRaw = process.env.COMMUNITY_DATABASE_URL_DIRECT;
  if (!directRaw) throw new Error('Missing COMMUNITY_DATABASE_URL_DIRECT (owner role, direct URL)');
  const direct = forceVerifyFull(directRaw, 'COMMUNITY_DATABASE_URL_DIRECT');
  const template = process.env.COMMUNITY_DATABASE_URL ?? directRaw;
  const withReadonly = flag('with-readonly');
  if (
    withReadonly &&
    isRemoteDatabaseUrl(directRaw, 'COMMUNITY_DATABASE_URL_DIRECT') &&
    process.env.COMMUNITY_ALLOW_REMOTE_READONLY !== 'yes'
  ) {
    throw new Error(
      '--with-readonly against a non-local host needs COMMUNITY_ALLOW_REMOTE_READONLY=yes',
    );
  }
  const envOut = value('runtime-env-out');
  const rotate = flag('rotate-password');
  if (envOut && existsSync(envOut) && !rotate) {
    // Harmless when the role already exists (nothing is written); checked up front so a
    // create never fails half-way.
    process.stdout.write(
      'provision-runtime-role: --runtime-env-out exists; it will not be touched\n',
    );
  }
  // The new credential goes to a pending file first (exclusive, 600) and is moved into place
  // only after the role change committed, so neither a failure nor a crash loses the only copy
  // or leaves a file whose password was never applied.
  const pending = envOut ? `${envOut}.pending` : undefined;
  let wrotePending = false;
  const pool = new Pool({ connectionString: direct, max: 1 });
  const client = await pool.connect();
  try {
    const result = await provisionCommunityRoles(client, {
      withReadonly,
      rotatePassword: rotate,
      newPassword: () => {
        if (!envOut || !pending) {
          throw new Error(
            'The runtime role must be created (or rotated) but --runtime-env-out was not given; ' +
              'refusing, because the generated password would be lost',
          );
        }
        if (existsSync(envOut) && !rotate) {
          throw new Error('--runtime-env-out already exists; refusing to overwrite it');
        }
        const password = generatePassword();
        writePrivate(
          pending,
          [
            '# Community RUNTIME role (community_app), pooled endpoint, sslmode=verify-full.',
            `# Generated ${new Date().toISOString()} by provision-runtime-role. Never commit or print.`,
            `COMMUNITY_DATABASE_URL="${runtimeUrl(template, DEFAULT_ROLE_NAMES.runtime, password)}"`,
            '',
          ].join('\n'),
        );
        wrotePending = true;
        return password;
      },
      passwordApplied: () => {
        if (pending && envOut) renameSync(pending, envOut);
        wrotePending = false;
      },
    }).catch(error => {
      // Only a password that was never applied is discarded.
      if (wrotePending && pending) unlinkSync(pending);
      throw error;
    });
    process.stdout.write(
      `provision-runtime-role: ${DEFAULT_ROLE_NAMES.runtime} ` +
        `${result.runtimeCreated ? 'CREATED (credential written to --runtime-env-out, mode 600)' : 'already existed'}` +
        `${result.runtimePassword && !result.runtimeCreated ? '; password ROTATED' : ''}` +
        `${result.runtimeAttributesFixed.length ? `; fixed attributes: ${result.runtimeAttributesFixed.join(', ')}` : ''}` +
        `${withReadonly ? `; ${DEFAULT_ROLE_NAMES.readonly} ${result.readonlyCreated ? 'created' : 'already existed'}` : ''}` +
        `; grants synced for [${result.grants.rolesSynced.join(', ')}] on ${result.grants.tables.length} tables` +
        `${result.grants.unclassified.length ? `; UNCLASSIFIED (no privilege): ${result.grants.unclassified.join(', ')}` : ''}\n`,
    );
    if (flag('verify')) {
      const runtime = await roleReport(client, DEFAULT_ROLE_NAMES.runtime);
      printReport(runtime);
      if (withReadonly) printReport(await roleReport(client, DEFAULT_ROLE_NAMES.readonly));
      const violations = runtimeViolations(runtime);
      process.stdout.write(
        violations.length
          ? `\nVIOLATIONS:\n${violations.map(v => `  ${v}`).join('\n')}\n`
          : `\n${DEFAULT_ROLE_NAMES.runtime} matches the intended privilege matrix.\n`,
      );
      if (violations.length) process.exitCode = 1;
    }
    if (result.grants.unclassified.length) process.exitCode = 1;
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
