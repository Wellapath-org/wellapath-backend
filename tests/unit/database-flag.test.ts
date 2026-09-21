/**
 * `DATABASE_ENABLED` configuration semantics.
 *
 * `src/config/env.ts` is a module-level singleton, so every case here re-imports it inside
 * `jest.isolateModules` with a purpose-built environment. "Missing" variables are set to the
 * empty string rather than deleted: `requireEnv` treats `''` as absent, and a deleted variable
 * could be silently refilled from a developer's local `.env` by the `dotenv.config()` call at
 * the top of the module — the empty string cannot, because dotenv never overwrites a variable
 * that is already present.
 */

interface LoadedConfig {
  db: { enabled: boolean } & Record<string, unknown>;
  metricsEndpointEnabled: boolean;
}

const loadConfig = (overrides: Record<string, string>): LoadedConfig => {
  const saved = process.env;
  process.env = { ...saved, ...overrides };
  try {
    let loaded: LoadedConfig | undefined;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      loaded = require('../../src/config/env').config as LoadedConfig;
    });
    if (!loaded) throw new Error('config did not load');
    return loaded;
  } finally {
    process.env = saved;
  }
};

const NO_DB_VARS = {
  DB_HOST: '',
  DB_PORT: '',
  DB_NAME: '',
  DB_USER: '',
  DB_PASSWORD: '',
  DB_SSL: '',
};

describe('DATABASE_ENABLED — explicit, fail-clear database switch', () => {
  it('defaults to enabled, preserving strict validation of every DB variable', () => {
    const config = loadConfig({ DATABASE_ENABLED: '' });
    expect(config.db.enabled).toBe(true);
    expect(config.db).toHaveProperty('host');
  });

  it('when absent, a missing DB variable still refuses startup (current behaviour preserved)', () => {
    expect(() => loadConfig({ DATABASE_ENABLED: '', DB_HOST: '' })).toThrow(
      'Missing required environment variable: DB_HOST',
    );
  });

  it('explicitly enabled without required configuration fails closed', () => {
    expect(() => loadConfig({ DATABASE_ENABLED: 'true', DB_PASSWORD: '' })).toThrow(
      'Missing required environment variable: DB_PASSWORD',
    );
  });

  it('disabled requires no DB variable at all and carries no connection fields', () => {
    const config = loadConfig({ DATABASE_ENABLED: 'false', ...NO_DB_VARS });
    expect(config.db).toEqual({ enabled: false });
  });

  it('refuses any value other than "true" or "false" instead of guessing', () => {
    for (const junk of ['1', 'yes', 'off', 'disabled']) {
      expect(() => loadConfig({ DATABASE_ENABLED: junk })).toThrow(
        `Invalid value for DATABASE_ENABLED: expected "true" or "false", got "${junk}"`,
      );
    }
  });

  it('accepts case-insensitive true/false', () => {
    expect(loadConfig({ DATABASE_ENABLED: 'TRUE' }).db.enabled).toBe(true);
    expect(loadConfig({ DATABASE_ENABLED: 'False', ...NO_DB_VARS }).db.enabled).toBe(false);
  });
});

describe('metrics endpoint configuration by environment', () => {
  it('is hard-disabled in production even when the env var asks for it', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      DATABASE_ENABLED: 'false',
      ...NO_DB_VARS,
      METRICS_ENDPOINT_ENABLED: 'true',
    });
    expect(config.metricsEndpointEnabled).toBe(false);
  });

  it('still honours the env var outside production', () => {
    expect(loadConfig({ METRICS_ENDPOINT_ENABLED: 'true' }).metricsEndpointEnabled).toBe(true);
    expect(loadConfig({ METRICS_ENDPOINT_ENABLED: 'false' }).metricsEndpointEnabled).toBe(false);
  });
});
