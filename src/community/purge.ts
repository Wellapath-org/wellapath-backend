/**
 * Sign-in retention (founder-approved 2026-11-07): unverified or pending authentication records
 * that carry an email address are purged automatically within 24 hours.
 *
 * What holds an address before sign-in completes:
 * - Better Auth `verification` rows: one per pending email-OTP code, identifier
 *   `sign-in-otp-<email>` (the code itself is stored hashed, expires after 5 minutes). Better Auth
 *   deletes the row on successful sign-in; abandoned or failed attempts leave it behind.
 * - the test-only outbox sinks (`memory`, `outbox-file`), which store address + code.
 * Nothing else does: there is no pending sign-up state (the account row is created only when a
 * code is verified), and rate-limit buckets / auth_events hold keyed HMACs, never an address.
 * Expired `rate_limit_counters` windows are deleted here too (HMAC keys, but no reason to keep
 * them).
 *
 * Rule, per run: delete `verification` rows whose `expiresAt` has passed, and any row created
 * more than MAX_AGE_HOURS (23 h) ago whatever its expiry. With a run every ≤ 1 h the oldest row
 * that can exist is < 24 h. Delete in bounded batches (indexed by 0009), so a run is cheap and
 * never holds long locks; concurrent runs from several instances are harmless (idempotent).
 *
 * Runs as the RUNTIME role `community_app` (DELETE on `verification` and `rate_limit_counters`
 * is part of its read_write class; it needs nothing else). Two entry points:
 * - `AuthRetentionJob`: started by the Community plugin, once at boot and then every
 *   `COMMUNITY_AUTH_PURGE_INTERVAL_SECONDS` (default 900, range 60–3600), timer unref'd;
 * - CLI: `node dist/community/purge.js` (or `npx ts-node src/community/purge.ts`) with the
 *   service's own COMMUNITY_DATABASE_URL, e.g. as a Render cron job. Prints counts only.
 */
import { FastifyBaseLogger } from 'fastify';
import { Pool, PoolClient } from 'pg';
import { assertVerifyFull } from './db-url';
import type { EmailSender } from './email';

export const MAX_AGE_HOURS = 23;
export const DEFAULT_BATCH_SIZE = 1000;
const MAX_BATCHES = 100;

export interface PurgeResult {
  verification: number;
  rateLimitCounters: number;
  outbox: number;
}

export interface PurgeOptions {
  batchSize?: number;
  /** Hard cap on age, hours (default 23). */
  maxAgeHours?: number;
  /** Test sinks keep address + code; they are purged with the same cutoff. */
  email?: EmailSender;
}

const deleteInBatches = async (
  db: Pool | PoolClient,
  sql: string,
  params: unknown[],
): Promise<number> => {
  let total = 0;
  for (let i = 0; i < MAX_BATCHES; i += 1) {
    const { rowCount } = await db.query(sql, params);
    total += rowCount ?? 0;
    if ((rowCount ?? 0) < (params[params.length - 1] as number)) break;
  }
  return total;
};

/** One purge pass. Idempotent; safe to run concurrently. */
export const purgeAuthRecords = async (
  db: Pool | PoolClient,
  options: PurgeOptions = {},
): Promise<PurgeResult> => {
  const batch = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxAgeSeconds = (options.maxAgeHours ?? MAX_AGE_HOURS) * 3600;
  const verification = await deleteInBatches(
    db,
    `DELETE FROM "verification" WHERE "id" IN (
       SELECT "id" FROM "verification"
        WHERE "expiresAt" < now() OR "createdAt" < now() - make_interval(secs => $1::int)
        LIMIT $2)`,
    [maxAgeSeconds, batch],
  );
  const rateLimitCounters = await deleteInBatches(
    db,
    `DELETE FROM rate_limit_counters WHERE (bucket, window_start) IN (
       SELECT bucket, window_start FROM rate_limit_counters
        WHERE window_start < now() - interval '1 minute'
          AND window_start + make_interval(secs => window_seconds) <= now()
        LIMIT $1)`,
    [batch],
  );
  const cutoff = new Date(Date.now() - maxAgeSeconds * 1000);
  const outbox = options.email?.purge ? await options.email.purge(cutoff) : 0;
  return { verification, rateLimitCounters, outbox };
};

/** In-process timer for `purgeAuthRecords` (started by the enabled Community wiring). */
export class AuthRetentionJob {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;

  constructor(
    private readonly pool: Pool,
    private readonly log: FastifyBaseLogger,
    private readonly intervalSeconds: number,
    private readonly email?: EmailSender,
  ) {}

  /** Runs one pass now and then on the interval. No-op when the interval is 0. */
  start(): void {
    if (this.intervalSeconds <= 0 || this.timer) return;
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), this.intervalSeconds * 1000);
    this.timer.unref();
  }

  /** One pass; overlapping calls share the pass in flight. Never throws. */
  runOnce(): Promise<void> {
    if (!this.running) {
      this.running = purgeAuthRecords(this.pool, { email: this.email })
        .then(result => {
          const removed = result.verification + result.rateLimitCounters + result.outbox;
          this.log[removed > 0 ? 'info' : 'debug'](
            { event: 'community_auth_purge', ...result },
            'Community sign-in retention purge',
          );
        })
        .catch(error => {
          this.log.warn(
            { event: 'community_auth_purge_failed', code: (error as { code?: string }).code },
            'Community sign-in retention purge failed',
          );
        })
        .finally(() => {
          this.running = undefined;
        });
    }
    return this.running;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }
}

/* istanbul ignore next -- CLI entry point */
if (require.main === module) {
  const raw = process.env.COMMUNITY_DATABASE_URL;
  if (!raw) {
    process.stderr.write('Missing COMMUNITY_DATABASE_URL (community_app, pooled)\n');
    process.exit(1);
  }
  let url: string;
  try {
    url = assertVerifyFull(raw, 'COMMUNITY_DATABASE_URL');
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exit(1);
  }
  const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 10000 });
  (async (): Promise<void> => {
    const { FileOutbox } = await import('./email');
    const dir = process.env.COMMUNITY_EMAIL_OUTBOX_DIR;
    const result = await purgeAuthRecords(pool, { email: dir ? new FileOutbox(dir) : undefined });
    process.stdout.write(
      `purge: verification=${result.verification} rate_limit_counters=${result.rateLimitCounters} ` +
        `outbox=${result.outbox}\n`,
    );
  })()
    .catch(error => {
      process.stderr.write(
        `purge failed (SQLSTATE ${(error as { code?: string }).code ?? 'unknown'})\n`,
      );
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
