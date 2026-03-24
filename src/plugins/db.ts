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
  const pool = new Pool({
    host: config.db.host,
    port: config.db.port,
    database: config.db.name,
    user: config.db.user,
    password: config.db.password,
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
