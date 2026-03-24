import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { config } from './config/env';
import { registerRoutes } from './routes';

const server = Fastify({
  logger: {
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    transport:
      process.env.NODE_ENV !== 'production'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
    redact: ['req.headers.authorization'],
  },
});

const start = async (): Promise<void> => {
  await server.register(cors, { origin: true });
  await server.register(rateLimit, { max: 100, timeWindow: '1 minute' });

  registerRoutes(server);

  try {
    await server.listen({ port: config.port, host: '0.0.0.0' });
    server.log.info(`Server running on port ${config.port}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

start();
