/**
 * Test environment.
 *
 * Set before any module import, so `src/config/env.ts` boots deterministically. `dotenv.config()`
 * does not overwrite variables that are already present, which means a developer's local `.env`
 * (with real staging credentials) cannot leak into a test run.
 *
 * The database values are intentionally unroutable: nothing in the telemetry pipeline touches
 * the database, and the tests that do exercise `/health` assert on its response shape rather
 * than on a live connection.
 */
process.env.NODE_ENV = 'test';
process.env.DB_HOST = 'localhost.invalid';
process.env.DB_PORT = '5432';
process.env.DB_NAME = 'wellapath_test';
process.env.DB_USER = 'test_user';
process.env.DB_PASSWORD = 'test_password';
process.env.DB_SSL = 'false';
process.env.ARTIFACT_BASE_URL = 'https://pub-8bc2ba0d7e7647799d89662d70f23c45.r2.dev';
process.env.APP_VERSION = '0.1.0';

// Telemetry defaults for tests. Individual tests override via buildApp options.
process.env.TELEMETRY_ENABLED = 'true';
process.env.TELEMETRY_SINK = 'none';
process.env.TELEMETRY_SINK_RETRY_DELAY_MS = '1';
process.env.METRICS_ENDPOINT_ENABLED = 'true';
