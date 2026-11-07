/**
 * B4 latency gate (ADR-001): Community DB connection and query latency on the RUNTIME path
 * (community_app → Neon pooler, TLS verify-full). Compiled into `dist/` so it runs inside the
 * production image as a Render one-off job from Frankfurt:
 *
 *   node dist/community/latency-gate.js --runs 100 --gate
 *
 * Reads `COMMUNITY_DATABASE_URL` only (the service's own runtime URL). Read-only: each run opens a
 * new connection and executes `SELECT current_setting('server_version')`. Prints p50/p95 and
 * PASS/FAIL; never a URL, host or credential. `--gate` exits 1 unless query p95 < 20 ms and
 * new-connection p95 < 150 ms. Not imported by the app.
 */
import { Client } from 'pg';
import { assertVerifyFull } from './db-url';

export const GATE_QUERY_P95_MS = 20;
export const GATE_CONNECT_P95_MS = 150;

export interface LatencySample {
  runs: number;
  failures: number;
  serverVersion: string;
  connect: { p50: number; p95: number };
  query: { p50: number; p95: number };
}

export const percentile = (values: number[], p: number): number => {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
};

/** N × (new connection + one query). Errors are counted, never echoed. */
export const measureLatency = async (url: string, runs: number): Promise<LatencySample> => {
  const connect: number[] = [];
  const query: number[] = [];
  let failures = 0;
  let serverVersion = '?';
  for (let i = 0; i < runs; i += 1) {
    const client = new Client({ connectionString: url, connectionTimeoutMillis: 5000 });
    try {
      const t0 = performance.now();
      await client.connect();
      const t1 = performance.now();
      const res = await client.query<{ v: string }>('SELECT current_setting($1) AS v', [
        'server_version',
      ]);
      const t2 = performance.now();
      serverVersion = res.rows[0].v;
      connect.push(t1 - t0);
      query.push(t2 - t1);
    } catch {
      failures += 1;
    } finally {
      await client.end().catch(() => undefined);
    }
  }
  return {
    runs,
    failures,
    serverVersion,
    connect: { p50: percentile(connect, 50), p95: percentile(connect, 95) },
    query: { p50: percentile(query, 50), p95: percentile(query, 95) },
  };
};

export interface GateVerdict {
  pass: boolean;
  queryPass: boolean;
  connectPass: boolean;
}

export const evaluateGate = (sample: LatencySample): GateVerdict => {
  const queryPass = sample.failures === 0 && sample.query.p95 < GATE_QUERY_P95_MS;
  const connectPass = sample.failures === 0 && sample.connect.p95 < GATE_CONNECT_P95_MS;
  return { pass: queryPass && connectPass, queryPass, connectPass };
};

/* istanbul ignore next -- CLI entry point */
if (require.main === module) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--runs');
  const runs = i >= 0 ? Number.parseInt(args[i + 1] ?? '', 10) : 100;
  const gate = args.includes('--gate');
  const raw = process.env.COMMUNITY_DATABASE_URL;
  const run = async (): Promise<void> => {
    if (!raw) throw new Error('Missing COMMUNITY_DATABASE_URL (runtime role, pooled URL)');
    if (!Number.isInteger(runs) || runs < 1 || runs > 1000) throw new Error('--runs: 1..1000');
    const url = assertVerifyFull(raw, 'COMMUNITY_DATABASE_URL');
    const s = await measureLatency(url, runs);
    const v = evaluateGate(s);
    const f = (n: number): string => `${n.toFixed(1)} ms`;
    process.stdout.write(
      [
        `latency-gate: runner ${process.env.RENDER ? 'Render' : 'local'}, node ${process.versions.node}, server ${s.serverVersion}`,
        `runs ${s.runs}, failures ${s.failures}`,
        `new connection: p50 ${f(s.connect.p50)}, p95 ${f(s.connect.p95)} (gate < ${GATE_CONNECT_P95_MS} ms): ${v.connectPass ? 'PASS' : 'FAIL'}`,
        `query (warm):   p50 ${f(s.query.p50)}, p95 ${f(s.query.p95)} (gate < ${GATE_QUERY_P95_MS} ms): ${v.queryPass ? 'PASS' : 'FAIL'}`,
        `B4: ${v.pass ? 'PASS' : 'FAIL'}`,
        '',
      ].join('\n'),
    );
    if (gate && !v.pass) process.exitCode = 1;
  };
  run().catch(error => {
    process.stderr.write(
      `latency-gate failed: ${(error as Error).message.replace(/postgres(ql)?:\/\/\S+/g, '<redacted>')}\n`,
    );
    process.exitCode = 1;
  });
}
