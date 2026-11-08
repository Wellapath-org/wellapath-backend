/** ADR-001 B2: static parts of the runtime-role definition (the DB matrix is in tests/community). */
import {
  generatePassword,
  READONLY_COLUMNS,
  RUNTIME_PRIVILEGES,
  TABLE_CLASSES,
} from '../../src/community/db-roles';

describe('Community runtime role definition (B2)', () => {
  it('generated passwords: 32 random bytes base64url, Neon composition guidance', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      const pw = generatePassword();
      expect(pw).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(pw).toMatch(/[a-z]/);
      expect(pw).toMatch(/[A-Z]/);
      expect(pw).toMatch(/\d/);
      expect(pw).not.toMatch(/(.)\1\1/);
      seen.add(pw);
    }
    expect(seen.size).toBe(50);
  });

  it('append-only audit tables are SELECT + INSERT only; nothing gets DDL-like privileges', () => {
    expect(TABLE_CLASSES.moderation_actions).toBe('append_only');
    expect(TABLE_CLASSES.auth_events).toBe('append_only');
    expect(RUNTIME_PRIVILEGES.append_only).toEqual(['SELECT', 'INSERT']);
    for (const privs of Object.values(RUNTIME_PRIVILEGES)) {
      for (const p of ['TRUNCATE', 'REFERENCES', 'TRIGGER']) expect(privs).not.toContain(p);
    }
  });

  it('the read-only role never sees auth/session/token tables, emails or identity columns', () => {
    for (const t of [
      'session',
      'account',
      'verification',
      'jwks',
      'twoFactor',
      'refresh_token_families',
      'refresh_tokens',
      'auth_events',
      'idempotency_keys',
      'rate_limit_counters',
      'totp_lockouts',
      'notifications',
    ]) {
      expect(READONLY_COLUMNS).not.toHaveProperty(t);
    }
    expect(READONLY_COLUMNS.user).toEqual(['id', 'role', 'createdAt', 'deletedAt']);
    const all = Object.values(READONLY_COLUMNS).flat();
    for (const c of ['email', 'author_id', 'reporter_id', 'evidence', 'note', 'actor_account_id']) {
      expect(all).not.toContain(c);
    }
  });
});
