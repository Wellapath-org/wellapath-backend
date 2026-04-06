import { FastifyInstance } from 'fastify';
import { config } from '../config/env';

export const configRoutes = (server: FastifyInstance): void => {
  server.get('/config', async (_request, reply) => {
    return reply.status(200).send({
      version: '1.0',
      country: 'ng',
      artifacts: {
        token_dictionary: {
          version: '1.0',
          url: `${config.artifactBaseUrl}/token_dictionary.ng.v1.0.json`,
          hash: 'sha256:773006dee306a3b03312315134fe62d7abf1aa29baa1903a388854f34f24b76d',
          release_date: '2026-04-06',
          country: 'ng',
        },
        knowledge_base: {
          version: '1.0',
          url: `${config.artifactBaseUrl}/kb.ng.v1.0.json`,
          hash: 'sha256:931049ed47200fa78d4bc44fcd9f4e544795a4901df6b16f7b491811b30d1699',
          release_date: '2026-04-06',
          country: 'ng',
        },
        rules: {
          version: '1.0',
          url: `${config.artifactBaseUrl}/rules.ng.v1.0.json`,
          hash: 'sha256:1ae5f58308866b65fea137755454fc1a2aae07e1f7aff1ed730ad9dfb0941f8c',
          release_date: '2026-04-06',
          country: 'ng',
        },
      },
    });
  });
};
