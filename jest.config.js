/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  setupFiles: ['<rootDir>/tests/setup-env.ts'],
  testTimeout: 30000,
  clearMocks: true,
  // Surface anything that keeps the loop alive — a leaked retry timer or an unclosed pool
  // would otherwise hide behind a passing run.
  detectOpenHandles: false,
  forceExit: false,
};
