import { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { Pool } from 'pg';
import { config } from '../config/env';

declare module 'fastify' {
  interface FastifyInstance {
    db: Pool;
  }
}

async function dbPlugin(server: FastifyInstance): Promise<void> {
  const db = config.db;
  if (!db.enabled) {
    // The app factory never registers this plugin when the database is disabled, so reaching
    // this line means a caller bypassed that decision. Refuse loudly rather than building a
    // pool from fields that do not exist.
    throw new Error('Database plugin must not be registered when DATABASE_ENABLED=false');
  }

  const pool = new Pool({
    host: db.host,
    port: db.port,
    database: db.name,
    user: db.user,
    password: db.password,
    // rejectUnauthorized:false encrypts but does not verify the server certificate chain.
    // Recorded hardening item for database-enabled production use; unreachable entirely when
    // DATABASE_ENABLED=false because this plugin is never registered in that state.
    ssl: db.ssl ? { rejectUnauthorized: false } : false,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  });

  server.decorate('db', pool);

  server.addHook('onClose', async () => {
    await pool.end();
    server.log.info('Database pool closed');
  });

  server.log.info('Database plugin registered');
}

export default fp(dbPlugin, { name: 'db' });
