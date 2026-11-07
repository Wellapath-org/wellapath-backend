/**
 * Neon connectivity PoC (ADR-001 amendment A4). Produces a markdown report.
 *
 * NOT RUN AGAINST ANY CLOUD DATABASE YET: no WellaPath Neon organisation exists (founder
 * action). It has been exercised against local PostgreSQL only. When the organisation exists,
 * run it FROM RENDER FRANKFURT (a one-off shell on the service, or a job in the same region) so
 * the latency numbers mean something, against a throwaway Neon BRANCH:
 *
 *   COMMUNITY_DATABASE_URL=<pooled URL of the branch, runtime role>          \
 *   COMMUNITY_DATABASE_URL_DIRECT=<direct URL of the branch, OWNER role>      \
 *   COMMUNITY_RESTORE_CHECK_URL=<direct URL of an EMPTY scratch database>     \
 *   NEON_POC_CONFIRM_BRANCH=yes                                               \
 *     npx ts-node scripts/community/neon-connectivity-poc.ts --runs 50 --out neon-report.md
 *
 * What it does (each step is reported; a failed step does not stop the others):
 *  1. Latency: N × (new connection + `SELECT 1`) on the pooled and the direct URL → p50/p95 of
 *     connect and query time; server version; whether the pooled URL is a PgBouncer pooler.
 *  2. Pooled connections: a pg Pool (max 10) runs 100 concurrent short queries; errors counted.
 *  3. Migrations on the branch (direct URL, owner role): down-all → up-all → down-one → up.
 *     DESTRUCTIVE on that database, hence NEON_POC_CONFIRM_BRANCH=yes and never production.
 *  4. Failure handling: the real app, built in-process with COMMUNITY_MODE=internal and a
 *     Community DB host that does not resolve ⇒ /config 200 (byte-identical to the
 *     Community-free app), /health 200, /v1/features 200 `disabled`, auth/community 503.
 *  5. Backup/export: `pg_dump -Fc` of the direct URL (pg_dump major must match the server),
 *     `pg_restore` into COMMUNITY_RESTORE_CHECK_URL, then per-table row counts compared.
 *
 * Secrets: connection strings are never printed; hosts are reported only as "pooler"/"direct".
 */
import { execFileSync } from 'child_process';
import { randomBytes } from 'crypto';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Client, Pool } from 'pg';

interface Step {
  name: string;
  ok: boolean;
  detail: string[];
}

const args = process.argv.slice(2);
const arg = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const RUNS = Number.parseInt(arg('runs', '20'), 10);
const OUT = arg('out', 'neon-connectivity-report.md');
const PG_BIN = process.env.PG_BIN ?? '';
const bin = (name: string): string => (PG_BIN ? join(PG_BIN, name) : name);

const pooledUrl = process.env.COMMUNITY_DATABASE_URL;
const directUrl = process.env.COMMUNITY_DATABASE_URL_DIRECT;
const restoreUrl = process.env.COMMUNITY_RESTORE_CHECK_URL;

const percentile = (values: number[], p: number): number => {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
};
const ms = (n: number): string => `${n.toFixed(1)} ms`;
const hostKind = (url: string): string => {
  try {
    const host = new URL(url).hostname;
    return host.includes('-pooler') ? 'Neon pooler (PgBouncer, transaction mode)' : 'direct';
  } catch {
    return 'unparseable';
  }
};
const redact = (text: string): string =>
  text.replace(/postgres(ql)?:\/\/[^\s'"]+/g, 'postgres://<redacted>');

const latency = async (label: string, url: string): Promise<Step> => {
  const connect: number[] = [];
  const query: number[] = [];
  let failures = 0;
  let version = '?';
  for (let i = 0; i < RUNS; i += 1) {
    const client = new Client({ connectionString: url, connectionTimeoutMillis: 5000 });
    try {
      const t0 = performance.now();
      await client.connect();
      const t1 = performance.now();
      const res = await client.query<{ v: string }>('SELECT current_setting($1) AS v', [
        'server_version',
      ]);
      const t2 = performance.now();
      version = res.rows[0].v;
      connect.push(t1 - t0);
      query.push(t2 - t1);
    } catch {
      failures += 1;
    } finally {
      await client.end().catch(() => undefined);
    }
  }
  return {
    name: `Latency — ${label} (${hostKind(url)})`,
    ok: failures === 0,
    detail: [
      `runs: ${RUNS}, failures: ${failures}, server_version: ${version}`,
      `connect: p50 ${ms(percentile(connect, 50))}, p95 ${ms(percentile(connect, 95))}`,
      `query (SELECT, warm connection): p50 ${ms(percentile(query, 50))}, p95 ${ms(percentile(query, 95))}`,
    ],
  };
};

const pooled = async (url: string): Promise<Step> => {
  const pool = new Pool({ connectionString: url, max: 10, connectionTimeoutMillis: 5000 });
  const times: number[] = [];
  let errors = 0;
  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: 100 }, async () => {
      const s = performance.now();
      try {
        await pool.query('SELECT pg_sleep(0.01)');
        times.push(performance.now() - s);
      } catch {
        errors += 1;
      }
    }),
  );
  const total = performance.now() - t0;
  await pool.end();
  return {
    name: 'Pooled connections (pg Pool max 10, 100 concurrent queries)',
    ok: errors === 0,
    detail: [
      `errors: ${errors}, wall time: ${ms(total)}`,
      `per-query (incl. queueing): p50 ${ms(percentile(times, 50))}, p95 ${ms(percentile(times, 95))}`,
      'Note: on the Neon pooler (transaction mode) session state (SET, advisory locks, LISTEN) does not persist; the app uses none. Migrations and pg_dump must use the DIRECT URL.',
    ],
  };
};

const migrations = async (url: string): Promise<Step> => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const migrate =
    require('../../src/community/migrate') as typeof import('../../src/community/migrate');
  const pool = new Pool({ connectionString: url, max: 2 });
  const detail: string[] = [];
  try {
    const before = await migrate.appliedVersions(pool);
    detail.push(`applied before: [${before.join(', ')}]`);
    const t0 = performance.now();
    detail.push(`down (all): [${(await migrate.migrateDown(pool)).join(', ')}]`);
    detail.push(`up (all): [${(await migrate.migrateUp(pool)).join(', ')}]`);
    detail.push(`down (1): [${(await migrate.migrateDown(pool, 1)).join(', ')}]`);
    detail.push(`up: [${(await migrate.migrateUp(pool)).join(', ')}]`);
    detail.push(`round trip took ${ms(performance.now() - t0)}`);
    const after = await migrate.appliedVersions(pool);
    detail.push(`applied after: [${after.join(', ')}]`);
    return { name: 'Migrations up/down on the branch (direct URL)', ok: after.length > 0, detail };
  } catch (error) {
    detail.push(`FAILED: ${redact((error as Error).message)}`);
    return { name: 'Migrations up/down on the branch (direct URL)', ok: false, detail };
  } finally {
    await pool.end();
  }
};

const failureHandling = async (): Promise<Step> => {
  // The app reads its configuration at import; set the test-only knobs first.
  process.env.NODE_ENV = process.env.NODE_ENV === 'production' ? 'production' : 'development';
  process.env.DATABASE_ENABLED = 'false';
  // Public artifact base (already in CLAUDE.md); only needed so src/config/env.ts validates.
  process.env.ARTIFACT_BASE_URL ??= 'https://pub-8bc2ba0d7e7647799d89662d70f23c45.r2.dev';
  process.env.COMMUNITY_MODE = '';
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { buildApp } = require('../../src/app') as typeof import('../../src/app');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cfg = require('../../src/community/config') as typeof import('../../src/community/config');
  const { Writable } = await import('stream');
  const sink = new Writable({ write: (_c, _e, cb): void => cb() });
  const baseline = await buildApp({
    registerDatabase: false,
    telemetryEnabled: false,
    logDestination: sink,
  });
  const broken = await buildApp({
    registerDatabase: false,
    telemetryEnabled: false,
    logDestination: sink,
    community: {
      config: {
        mode: 'internal',
        databaseUrl: 'postgres://nobody@community-db.invalid:5432/none',
        authSecrets: [{ version: 1, value: randomBytes(32).toString('base64url') }],
        refreshPeppers: [{ version: 1, value: randomBytes(32).toString('base64url') }],
        baseUrl: 'http://localhost:3000',
        allowlist: new Set(),
        emailSink: 'memory',
        accessTokenTtlSeconds: 900,
        memberLifetimes: cfg.DEFAULT_MEMBER_LIFETIMES,
        privilegedLifetimes: cfg.DEFAULT_PRIVILEGED_LIFETIMES,
        stepUpTtlSeconds: 43200,
        otpRequestMinMs: 0,
      },
    },
  });
  try {
    const want = await baseline.server.inject({ method: 'GET', url: '/config' });
    const config = await broken.server.inject({ method: 'GET', url: '/config' });
    const health = await broken.server.inject({ method: 'GET', url: '/health' });
    const version = await broken.server.inject({ method: 'GET', url: '/version' });
    const features = await broken.server.inject({ method: 'GET', url: '/v1/features' });
    const t0 = performance.now();
    const otp = await broken.server.inject({
      method: 'POST',
      url: '/v1/auth/otp/request',
      payload: { email: 'probe@example.test' },
    });
    const otpMs = performance.now() - t0;
    const ok =
      config.statusCode === 200 &&
      config.body === want.body &&
      health.statusCode === 200 &&
      version.statusCode === 200 &&
      features.statusCode === 200 &&
      features.json().community === 'disabled' &&
      otp.statusCode === 503;
    return {
      name: 'Failure handling (Community DB host unresolvable)',
      ok,
      detail: [
        `/config: ${config.statusCode}, byte-identical to Community-free app: ${config.body === want.body}`,
        `/health: ${health.statusCode}, /version: ${version.statusCode}`,
        `/v1/features: ${features.statusCode} ${features.body}`,
        `/v1/auth/otp/request: ${otp.statusCode} ${otp.json().error?.code} in ${ms(otpMs)}`,
      ],
    };
  } finally {
    await baseline.server.close();
    await broken.server.close();
  }
};

const backup = async (direct: string, restore: string | undefined): Promise<Step> => {
  const detail: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'neon-poc-'));
  const file = join(dir, 'community.dump');
  try {
    detail.push(`pg_dump: ${execFileSync(bin('pg_dump'), ['--version']).toString().trim()}`);
    const t0 = performance.now();
    execFileSync(
      bin('pg_dump'),
      ['-Fc', '--no-owner', '--no-privileges', '-d', direct, '-f', file],
      {
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    detail.push(`dump: ${statSync(file).size} bytes in ${ms(performance.now() - t0)}`);
    if (!restore) {
      detail.push('restore check SKIPPED: COMMUNITY_RESTORE_CHECK_URL not set');
      return { name: 'Backup / export (pg_dump + restore check)', ok: true, detail };
    }
    const t1 = performance.now();
    execFileSync(
      bin('pg_restore'),
      ['--no-owner', '--no-privileges', '--clean', '--if-exists', '-d', restore, file],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    detail.push(`restore: ${ms(performance.now() - t1)}`);
    const counts = async (url: string): Promise<Record<string, number>> => {
      const c = new Client({ connectionString: url });
      await c.connect();
      try {
        const tables = await c.query<{ t: string }>(
          `SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`,
        );
        const out: Record<string, number> = {};
        for (const { t } of tables.rows) {
          out[t] = (
            await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${t}"`)
          ).rows[0].n;
        }
        const triggers = await c.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_trigger WHERE NOT tgisinternal`,
        );
        out['(triggers)'] = triggers.rows[0].n;
        return out;
      } finally {
        await c.end();
      }
    };
    const [a, b] = [await counts(direct), await counts(restore)];
    const same = JSON.stringify(a) === JSON.stringify(b);
    detail.push(`row counts identical after restore: ${same}`);
    detail.push(`tables: ${Object.keys(a).length - 1}, triggers: ${a['(triggers)']}`);
    if (!same) detail.push(`source ${JSON.stringify(a)} vs restored ${JSON.stringify(b)}`);
    return { name: 'Backup / export (pg_dump + restore check)', ok: same, detail };
  } catch (error) {
    const stderr = (error as { stderr?: Buffer }).stderr?.toString() ?? (error as Error).message;
    detail.push(`FAILED: ${redact(stderr).slice(0, 500)}`);
    return { name: 'Backup / export (pg_dump + restore check)', ok: false, detail };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const main = async (): Promise<void> => {
  if (!pooledUrl || !directUrl) {
    throw new Error(
      'Set COMMUNITY_DATABASE_URL (pooled) and COMMUNITY_DATABASE_URL_DIRECT (direct, owner role)',
    );
  }
  if (process.env.NEON_POC_CONFIRM_BRANCH !== 'yes') {
    throw new Error(
      'Refusing: step 3 drops and recreates the Community schema on the DIRECT database. ' +
        'Point it at a throwaway branch and set NEON_POC_CONFIRM_BRANCH=yes. Never production.',
    );
  }
  const started = new Date().toISOString();
  const steps: Step[] = [];
  const run = async (fn: () => Promise<Step>, name: string): Promise<void> => {
    try {
      steps.push(await fn());
    } catch (error) {
      steps.push({ name, ok: false, detail: [`FAILED: ${redact((error as Error).message)}`] });
    }
  };
  await run(() => latency('pooled URL', pooledUrl), 'Latency — pooled');
  await run(() => latency('direct URL', directUrl), 'Latency — direct');
  await run(() => pooled(pooledUrl), 'Pooled connections');
  await run(() => migrations(directUrl), 'Migrations');
  await run(() => failureHandling(), 'Failure handling');
  await run(() => backup(directUrl, restoreUrl), 'Backup / export');

  const lines = [
    '# Neon connectivity PoC report (ADR-001 A4)',
    '',
    `| | |`,
    `|---|---|`,
    `| Started | ${started} |`,
    `| Runner | ${process.env.RENDER ? 'Render' : 'local'} — node ${process.versions.node} on ${process.platform} |`,
    `| Pooled URL kind | ${hostKind(pooledUrl)} |`,
    `| Direct URL kind | ${hostKind(directUrl)} |`,
    `| Runs per latency sample | ${RUNS} |`,
    `| Result | ${steps.every(s => s.ok) ? '**ALL STEPS PASSED**' : '**FAILURES — see below**'} |`,
    '',
    ...steps.flatMap(s => [
      `## ${s.ok ? 'PASS' : 'FAIL'} — ${s.name}`,
      '',
      ...s.detail.map(d => `- ${d}`),
      '',
    ]),
    '## Not measured here (record separately)',
    '',
    '- The actual configured Neon cost (plan, compute size, autosuspend, history window).',
    '- Point-in-time restore drill (Neon console/API: restore a branch to a timestamp).',
    '- Latency is only meaningful when this runs from Render Frankfurt against aws-eu-central-1.',
    '',
  ];
  writeFileSync(OUT, lines.join('\n'));
  process.stdout.write(
    `neon-connectivity-poc: wrote ${OUT} (${steps.filter(s => s.ok).length}/${steps.length} steps passed)\n`,
  );
  if (!steps.every(s => s.ok)) process.exitCode = 1;
};

main().catch(error => {
  process.stderr.write(`neon-connectivity-poc: ${redact((error as Error).message)}\n`);
  process.exitCode = 1;
});
