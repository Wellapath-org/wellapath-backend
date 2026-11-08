/**
 * With COMMUNITY_MODE unset, the app must not even load Better Auth or open a Community pool.
 * Every Community dependency is replaced by a module that throws on load: if the disabled path
 * imported any of them, building the app would fail.
 */
jest.mock('better-auth', () => {
  throw new Error('better-auth loaded in disabled mode');
});
jest.mock('better-auth/plugins', () => {
  throw new Error('better-auth/plugins loaded in disabled mode');
});
jest.mock('../../src/community/enabled', () => {
  throw new Error('community enabled module loaded in disabled mode');
});

import { createTestApp } from '../helpers/app';

it('builds and serves /config, /health, /v1/features without loading Community code', async () => {
  const app = await createTestApp();
  try {
    expect((await app.server.inject({ method: 'GET', url: '/config' })).statusCode).toBe(200);
    expect((await app.server.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    const features = await app.server.inject({ method: 'GET', url: '/v1/features' });
    expect(features.json()).toEqual({ community: 'disabled', community_allowed: false });
  } finally {
    await app.close();
  }
});
