/**
 * ESM-only dependencies of the Community PoC (better-auth 1.7.x and its graph). Node itself can
 * `require()` them (require(esm), Node >= 20.19), but Jest's module runtime cannot, so these
 * packages — and only these — are transpiled to CommonJS for tests. Nothing else changes.
 */
const ESM_PACKAGES = [
  'better-auth',
  '@better-auth',
  'better-call',
  'jose',
  'kysely',
  'nanostores',
  '@noble',
  '@better-fetch',
  'rou3',
  'defu',
  'zod',
  'uncrypto',
];

/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  setupFiles: ['<rootDir>/tests/setup-env.ts'],
  testTimeout: 30000,
  clearMocks: true,
  moduleFileExtensions: ['ts', 'js', 'mjs', 'cjs', 'json'],
  transform: {
    '^.+\\.ts$': 'ts-jest',
    '^.+\\.m?js$': [
      'ts-jest',
      {
        isolatedModules: true,
        tsconfig: { allowJs: true, module: 'commonjs', target: 'ES2022' },
      },
    ],
  },
  transformIgnorePatterns: [`/node_modules/(?!(${ESM_PACKAGES.join('|')})/)`],
  // Surface anything that keeps the loop alive — a leaked retry timer or an unclosed pool
  // would otherwise hide behind a passing run.
  detectOpenHandles: false,
  forceExit: false,
};
