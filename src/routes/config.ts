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
          version: '2.0',
          url: `${config.artifactBaseUrl}/kb.ng.v2.0.json`,
          hash: 'sha256:b8a3c19e251453ffb37693dab117a11b4a9daf5b5a331b4758e5a0cc8c598db9',
          release_date: '2026-04-06',
          country: 'ng',
        },
        rules: {
          version: '2.0',
          url: `${config.artifactBaseUrl}/rules.ng.v2.0.json`,
          hash: 'sha256:b969b084974f60d76322952c85a8fffe9b2b0a0d73252d518b59078765e5f5e3',
          release_date: '2026-04-06',
          country: 'ng',
        },
        facilities: {
          version: '1.0',
          url: `${config.artifactBaseUrl}/facilities.ng.v1.0.json`,
          hash: 'sha256:1c7b939199ab4465156f4cb336910eea120fcaa70f8b1c0743fc9f7a7c03009e',
          release_date: '2026-07-06',
          country: 'ng',
        },
      },
    });
  });
};
