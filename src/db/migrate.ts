import { Pool } from 'pg';
import { config } from '../config/env';
import { logger } from '../utils/logger';

const CREATE_ARTIFACT_VERSIONS = `
  CREATE TABLE IF NOT EXISTS artifact_versions (
    id          SERIAL PRIMARY KEY,
    artifact    VARCHAR(64)  NOT NULL,
    version     VARCHAR(32)  NOT NULL,
    s3_key      VARCHAR(512) NOT NULL,
    hash        VARCHAR(128) NOT NULL,
    released_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (artifact, version)
  );
`;

const CREATE_METRICS_AGG = `
  CREATE TABLE IF NOT EXISTS metrics_agg (
    id           SERIAL PRIMARY KEY,
    metric_name  VARCHAR(128) NOT NULL,
    metric_value NUMERIC      NOT NULL,
    dimensions   JSONB        NOT NULL DEFAULT '{}',
    period_start TIMESTAMPTZ  NOT NULL,
    period_end   TIMESTAMPTZ  NOT NULL,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
  );
`;

const CREATE_AUDIT_LOGS = `
  CREATE TABLE IF NOT EXISTS audit_logs (
    id         SERIAL PRIMARY KEY,
    event_type VARCHAR(128) NOT NULL,
    actor      VARCHAR(128),
    target     VARCHAR(256),
    metadata   JSONB        NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
  );
`;

async function migrate(): Promise<void> {
  const pool = new Pool({
    host: config.db.host,
    port: config.db.port,
    database: config.db.name,
    user: config.db.user,
    password: config.db.password,
  });

  const client = await pool.connect();

  try {
    logger.info('Running migrations...');

    await client.query('BEGIN');
    await client.query(CREATE_ARTIFACT_VERSIONS);
    await client.query(CREATE_METRICS_AGG);
    await client.query(CREATE_AUDIT_LOGS);
    await client.query('COMMIT');

    logger.info('Migrations complete');
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error({ err }, 'Migration failed — rolled back');
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
