import { FastifyInstance } from 'fastify';
import { config } from '../config/env';

export const configRoutes = (server: FastifyInstance): void => {
  server.get('/config', async (_request, reply) => {
    return reply.status(200).send({
      version: '1.0',
      country: 'ng',
      artifacts: {
        token_dictionary: {
          version: '1.1',
          url: `${config.artifactBaseUrl}/token_dictionary.ng.v1.1.json`,
          hash: 'sha256:0cc47ad9537c0bd4c6ef3aec8f1931eb9b4c62103a8809d16544f94a90b5c019',
          release_date: '2026-04-05',
          country: 'ng',
        },
        knowledge_base: {
          version: '2.1',
          url: `${config.artifactBaseUrl}/kb.ng.v2.1.json`,
          hash: 'sha256:e5d9fd82669b0ac52b5ed0626b4f94ebd043c520c1d4601e42bf2926e0abc515',
          release_date: '2026-07-21',
          country: 'ng',
        },
        rules: {
          version: '2.1',
          url: `${config.artifactBaseUrl}/rules.ng.v2.1.json`,
          hash: 'sha256:57da3ff543c0e2e948c196930de75b40f70edf7d40b6ef4e90b8ccbe10481b79',
          release_date: '2026-07-21',
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
