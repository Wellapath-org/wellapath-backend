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
          version: '2.3',
          url: `${config.artifactBaseUrl}/kb.ng.v2.3.json`,
          hash: 'sha256:cb0e43fc20bfab4351e123e73bc997d663469a36bca3222ec7fdbe5d7dc4e9f8',
          release_date: '2026-07-23',
          country: 'ng',
        },
        rules: {
          version: '2.2',
          url: `${config.artifactBaseUrl}/rules.ng.v2.2.json`,
          hash: 'sha256:1d27e854cba95b179577a88f92445400f494a7fe8e6a53a60fcaa98b3870d1c4',
          release_date: '2026-07-26',
          country: 'ng',
        },
        facilities: {
          version: '1.1',
          url: `${config.artifactBaseUrl}/facilities.ng.v1.1.json`,
          hash: 'sha256:25684c714367abf2f3c305c8a5597b5f7eb0d11baaf658c5b9e2f8f5e2982398',
          release_date: '2026-07-26',
          country: 'ng',
        },
      },
    });
  });
};
