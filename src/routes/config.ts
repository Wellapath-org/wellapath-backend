import { FastifyInstance } from 'fastify';
import { config } from '../config/env';

export const configRoutes = (server: FastifyInstance): void => {
  server.get('/config', async (_request, reply) => {
    return reply.status(200).send({
      artifacts: {
        knowledgeBase: {
          version: '1.0.0',
          url: `${config.artifactBaseUrl}/kb.ng.v1.0.json`,
          hash: 'placeholder-hash-e1',
        },
        rules: {
          version: '1.0.0',
          url: `${config.artifactBaseUrl}/rules.ng.v1.0.json`,
          hash: 'placeholder-hash-e1',
        },
        facilities: {
          version: '1.0.0',
          url: `${config.artifactBaseUrl}/facilities.ng.v1.0.json`,
          hash: 'placeholder-hash-e1',
        },
      },
      featureFlags: {
        offlineModeEnabled: true,
      },
    });
  });
};
