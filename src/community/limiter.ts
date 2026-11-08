/**
 * The single WellaPath rate limiter for auth and Community (ADR-001 A3, contract §4).
 *
 * - Better Auth's own limiter is disabled (`rateLimit.enabled: false` in ./auth.ts).
 * - Counters are fixed windows in Postgres (`rate_limit_counters`), never per-instance memory, so
 *   limits hold across restarts and instances.
 * - The IP dimension uses only the security client IP (`ctx.ip`, `src/config/client-ip.ts`):
 *   the edge-set `CF-Connecting-IP` when `CLIENT_IP_SOURCE=cf-connecting-ip`, otherwise
 *   `request.ip`. `X-Forwarded-For`, `X-Real-IP`, `True-Client-IP` and `Forwarded` are never
 *   read for it.
 * - Until that IP identifies individual clients (`clientIpAttributed` false: socket source and no
 *   `TRUST_PROXY_HOPS`) the socket peer behind Render is the proxy itself, so the per-IP rules use
 *   the interim GLOBAL ceilings (contract F2).
 * - Bucket keys are HMACs: no plaintext email or IP is stored.
 */
import { Pool } from 'pg';
import { Hasher } from './crypto';
import { ApiError } from './http';

export interface LimitRule {
  max: number;
  windowSeconds: number;
  /** Ceiling used instead of `max` while TRUST_PROXY_HOPS is unset (IP dimensions only). */
  interimMax?: number;
}

const MIN = 60;
const HOUR = 3600;
const DAY = 86400;

/** Contract §4.2, verbatim. */
export const LIMITS = {
  otp_request_email_15m: { max: 3, windowSeconds: 15 * MIN },
  otp_request_email_24h: { max: 10, windowSeconds: DAY },
  otp_request_ip: { max: 20, windowSeconds: HOUR, interimMax: 600 },
  otp_verify_email: { max: 20, windowSeconds: HOUR },
  otp_verify_ip: { max: 60, windowSeconds: HOUR, interimMax: 1200 },
  refresh_family: { max: 10, windowSeconds: MIN },
  refresh_ip: { max: 120, windowSeconds: MIN, interimMax: 3000 },
  // Refresh-token-only logout (P6): no account is known before the lookup, so the dimensions are
  // the trusted-proxy IP and the presented token's hash. Never a client header.
  logout_ip: { max: 60, windowSeconds: MIN, interimMax: 3000 },
  logout_token: { max: 10, windowSeconds: MIN },
  totp_attempts_account: { max: 20, windowSeconds: HOUR },
  totp_enrol_account: { max: 5, windowSeconds: HOUR },
  session_routes_account: { max: 30, windowSeconds: MIN },
  create_post_hour: { max: 5, windowSeconds: HOUR },
  create_post_day: { max: 20, windowSeconds: DAY },
  create_comment_hour: { max: 30, windowSeconds: HOUR },
  create_report_day: { max: 20, windowSeconds: DAY },
  professional_claim_day: { max: 3, windowSeconds: DAY },
  put_profile_hour: { max: 10, windowSeconds: HOUR },
  export_day: { max: 3, windowSeconds: DAY },
  deletion_day: { max: 3, windowSeconds: DAY },
  identity_reveal_hour: { max: 30, windowSeconds: HOUR },
  privileged_mutation_hour: { max: 300, windowSeconds: HOUR },
  features_ip: { max: 60, windowSeconds: MIN, interimMax: 6000 },
  authenticated_default: { max: 120, windowSeconds: MIN },
} satisfies Record<string, LimitRule>;

export type LimitName = keyof typeof LIMITS;
export type LimitOverrides = Partial<Record<LimitName, Partial<LimitRule>>>;

export interface LimitCheck {
  name: LimitName;
  /** The dimension value (normalised email, IP, account id, family id). Hashed before storage. */
  key: string;
  /** Never exposed in RateLimit-* headers (per-email buckets on auth endpoints). */
  hidden?: boolean;
}

export interface LimitState {
  limit: number;
  remaining: number;
  resetSeconds: number;
}

export class RateLimiter {
  private calls = 0;

  constructor(
    private readonly pool: Pool,
    private readonly hasher: Hasher,
    private readonly options: {
      clientIpAttributed: boolean;
      /** SEC-027: keys the app produced as unattributed (edge header missing/malformed). */
      isUnattributedKey?: (key: string) => boolean;
      overrides?: LimitOverrides;
    },
  ) {}

  /**
   * The ceiling for `name`. The conservative interim/global ceiling applies when the IP does not
   * identify an individual client: either no per-client source is configured, or (SEC-027) this
   * particular key is unattributed, so every such request shares it.
   */
  rule(name: LimitName, key?: string): { max: number; windowSeconds: number } {
    const base: LimitRule = LIMITS[name];
    const merged = { ...base, ...(this.options.overrides?.[name] ?? {}) };
    const conservative =
      !this.options.clientIpAttributed ||
      (key !== undefined && (this.options.isUnattributedKey?.(key) ?? false));
    const max = conservative && merged.interimMax !== undefined ? merged.interimMax : merged.max;
    return { max, windowSeconds: merged.windowSeconds };
  }

  private async hit(check: LimitCheck): Promise<LimitState & { exceeded: boolean }> {
    const { max, windowSeconds } = this.rule(check.name, check.key);
    const bucket = `${check.name}:${this.hasher.lookup(check.name, check.key)}`;
    const { rows } = await this.pool.query<{ count: number; reset: string }>(
      `INSERT INTO rate_limit_counters (bucket, window_start, window_seconds, count)
       VALUES ($1, to_timestamp(floor(extract(epoch FROM now()) / $2) * $2), $2, 1)
       ON CONFLICT (bucket, window_start) DO UPDATE SET count = rate_limit_counters.count + 1
       RETURNING count,
         extract(epoch FROM (window_start + make_interval(secs => window_seconds) - now()))::text AS reset`,
      [bucket, windowSeconds],
    );
    const count = rows[0].count;
    const resetSeconds = Math.max(1, Math.ceil(Number.parseFloat(rows[0].reset)));
    return {
      exceeded: count > max,
      limit: max,
      remaining: Math.max(0, max - count),
      resetSeconds,
    };
  }

  /**
   * Counts one request against every listed dimension. If any is exceeded, throws 429
   * `rate_limited` with `Retry-After` (the longest wait among the exceeded dimensions) after
   * calling `onLimited` once per exceeded dimension. Returns the tightest visible state for the
   * RateLimit-* headers.
   */
  async consume(
    checks: LimitCheck[],
    onLimited?: (name: LimitName) => Promise<void>,
  ): Promise<LimitState | undefined> {
    this.maybePrune();
    let retryAfter = 0;
    let visible: LimitState | undefined;
    for (const check of checks) {
      const state = await this.hit(check);
      if (state.exceeded) {
        retryAfter = Math.max(retryAfter, state.resetSeconds);
        if (onLimited) await onLimited(check.name);
      } else if (!check.hidden && (!visible || state.remaining < visible.remaining)) {
        visible = state;
      }
    }
    if (retryAfter > 0) {
      throw new ApiError('rate_limited', { retry_after_seconds: retryAfter }, undefined, {
        'retry-after': String(retryAfter),
      });
    }
    return visible;
  }

  /** Expired windows are deleted occasionally; correctness never depends on it. */
  private maybePrune(): void {
    this.calls += 1;
    if (this.calls % 500 !== 0) return;
    this.pool
      .query(`DELETE FROM rate_limit_counters WHERE window_start < now() - interval '2 days'`)
      .catch(() => undefined);
  }
}

export const rateLimitHeaders = (state: LimitState | undefined): Record<string, string> =>
  state
    ? {
        'ratelimit-limit': String(state.limit),
        'ratelimit-remaining': String(state.remaining),
        'ratelimit-reset': String(state.resetSeconds),
      }
    : {};
