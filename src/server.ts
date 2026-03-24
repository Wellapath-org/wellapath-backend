import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { config } from './config/env';
import dbPlugin from './plugins/db';
import errorHandlerPlugin from './plugins/error-handler';
import { registerRoutes } from './routes';

const server = Fastify({
  logger: {
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    transport:
      process.env.NODE_ENV !== 'production'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
    redact: ['req.headers.authorization', 'req.headers.cookie'],
  },
});

const ALLOWED_ORIGINS =
  config.nodeEnv === 'production'
    ? ['https://wellapath.org', 'https://api-staging.wellapath.org']
    : true;

const start = async (): Promise<void> => {
  await server.register(cors, {
    origin: ALLOWED_ORIGINS,
    methods: ['GET'],
  });
  await server.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
    errorResponseBuilder: (_request, context) => ({
      error: {
        statusCode: 429,
        message: `Rate limit exceeded. Try again in ${context.after}.`,
      },
    }),
  });
  await server.register(dbPlugin);
  await server.register(errorHandlerPlugin);

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
