import dotenv from 'dotenv';
dotenv.config();

interface TelemetryConfig {
  /**
   * Master switch. Defaults to DISABLED in every environment — telemetry has to be turned on
   * deliberately, per environment, and turning it off is the rollback path.
   */
  enabled: boolean;
  /** Sink implementation to deliver validated events to. See `src/telemetry/sinks/`. */
  sink: string;
  /** Requests per minute per client for the telemetry endpoint specifically. */
  rateLimitMax: number;
  /** How long an event ID is remembered for de-duplication. */
  dedupeTtlSeconds: number;
  /** Hard cap on remembered event IDs. Bounds the memory the dedupe store can occupy. */
  dedupeMaxEntries: number;
  /** Delivery retries after the first attempt. */
  sinkMaxRetries: number;
  /** Base delay between delivery attempts, multiplied by attempt number. */
  sinkRetryDelayMs: number;
  /** Concurrent in-flight deliveries before batches are shed rather than queued. */
  sinkMaxInFlight: number;
}

/**
 * Database configuration is a discriminated union so that disabled state is structural, not a
 * convention: when `enabled` is `false` there are no connection fields to read, and any code
 * that wants them has to prove to the compiler that the database was turned on. No current
 * product route requires the database — the only runtime query in the app is the health
 * check's `SELECT 1` — so production can run with `DATABASE_ENABLED=false` until an approved
 * feature actually needs persistence.
 */
export type DbConfig =
  | {
      enabled: true;
      host: string;
      port: number;
      name: string;
      user: string;
      password: string;
      ssl: boolean;
    }
  | { enabled: false };

interface AppConfig {
  nodeEnv: string;
  port: number;
  db: DbConfig;
  artifactBaseUrl: string;
  appVersion: string;
  telemetry: TelemetryConfig;
  /** Serves the operational metrics snapshot at `GET /internal/metrics`. */
  metricsEndpointEnabled: boolean;
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

/** Reads a boolean env var. Absent or unparseable falls back to `fallback`. */
function boolEnv(key: string, fallback: boolean): boolean {
  const value = process.env[key];
  if (value === undefined || value === '') return fallback;
  return value.toLowerCase() === 'true';
}

/**
 * Reads a boolean env var that must be exactly `true` or `false` when present. Used for
 * switches where a typo silently flipping the value would be worse than a refused boot:
 * `boolEnv` maps any junk to `false`, which for `DATABASE_ENABLED` would disable the database
 * on a misspelling. This fails clear at startup instead.
 */
function strictBoolEnv(key: string, fallback: boolean): boolean {
  const value = process.env[key];
  if (value === undefined || value === '') return fallback;
  const normalized = value.toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error(`Invalid value for ${key}: expected "true" or "false", got "${value}"`);
}

/** Reads a bounded integer env var, falling back on anything unparseable or out of range. */
function intEnv(key: string, fallback: number, min: number, max: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

const nodeEnv = process.env.NODE_ENV ?? 'development';

/**
 * Defaults to `true` so every existing deployment keeps its current behaviour — staging is
 * unchanged, and enabling the database keeps the strict `requireEnv` validation below.
 * Setting `DATABASE_ENABLED=false` is an explicit operator decision; in that state no DB_*
 * variable is read, no pool is created and `/health` reports the database as `disabled`.
 */
const databaseEnabled = strictBoolEnv('DATABASE_ENABLED', true);

export const config: AppConfig = {
  nodeEnv,
  port: parseInt(process.env.PORT ?? '3000', 10),
  db: databaseEnabled
    ? {
        enabled: true,
        host: requireEnv('DB_HOST'),
        port: parseInt(process.env.DB_PORT ?? '5432', 10),
        name: requireEnv('DB_NAME'),
        user: requireEnv('DB_USER'),
        password: requireEnv('DB_PASSWORD'),
        ssl: process.env.DB_SSL === 'true',
      }
    : { enabled: false },
  artifactBaseUrl: requireEnv('ARTIFACT_BASE_URL'),
  appVersion: process.env.APP_VERSION ?? '0.1.0',
  telemetry: {
    enabled: boolEnv('TELEMETRY_ENABLED', false),
    sink: process.env.TELEMETRY_SINK ?? 'log',
    rateLimitMax: intEnv('TELEMETRY_RATE_LIMIT_MAX', 60, 1, 10000),
    dedupeTtlSeconds: intEnv('TELEMETRY_DEDUPE_TTL_SECONDS', 3600, 60, 86400),
    dedupeMaxEntries: intEnv('TELEMETRY_DEDUPE_MAX_ENTRIES', 20000, 100, 500000),
    sinkMaxRetries: intEnv('TELEMETRY_SINK_MAX_RETRIES', 2, 0, 5),
    sinkRetryDelayMs: intEnv('TELEMETRY_SINK_RETRY_DELAY_MS', 200, 0, 10000),
    sinkMaxInFlight: intEnv('TELEMETRY_SINK_MAX_IN_FLIGHT', 50, 1, 1000),
  },
  /**
   * Hard-disabled in production regardless of the env var: the endpoint is unauthenticated,
   * no authenticated monitoring design exists yet, and the recorded pre-external-beta item
   * says it must not be publicly reachable. In production the route is simply not registered
   * and answers with the standard 404 envelope.
   */
  metricsEndpointEnabled:
    nodeEnv === 'production' ? false : boolEnv('METRICS_ENDPOINT_ENABLED', true),
};
