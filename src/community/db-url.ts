/**
 * Community database connection-string policy (ADR-001 amendment B5).
 *
 * - Runtime (`COMMUNITY_DATABASE_URL`): any non-local host MUST say `sslmode=verify-full`
 *   explicitly, otherwise startup is refused. The runtime URL is never rewritten silently: what
 *   is configured on Render is what runs.
 * - Owner / migration / admin CLI connections: for non-local hosts the sslmode is FORCED to
 *   `verify-full` in the connection config, whatever the provided URL says (Neon's console
 *   hands out `sslmode=require`, which node-postgres 8.x treats as verify-full today but whose
 *   meaning changes in pg 9). The file the founder provided does not need editing.
 *
 * Local hosts (localhost, 127.0.0.0/8, ::1, a Unix socket) are exempt: CI and developer
 * Postgres containers have no certificate.
 *
 * No function here ever includes the URL, host, user or password in an error message.
 */

export const REQUIRED_SSLMODE = 'verify-full';

interface ParsedTarget {
  url: URL;
  host: string;
}

const parse = (raw: string, name: string): ParsedTarget => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} is not a valid postgres:// connection URL`);
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(`${name} must be a postgres:// or postgresql:// URL`);
  }
  // libpq lets `?host=` override (or supply) the host, e.g. a Unix socket directory.
  const host = url.searchParams.get('host') ?? decodeURIComponent(url.hostname);
  return { url, host };
};

/** True for hosts that never leave this machine (no TLS requirement). */
export const isLocalDatabaseHost = (host: string): boolean => {
  const h = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (h === '' || h.startsWith('/')) return true; // Unix socket
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1') return true;
  return /^127(\.\d{1,3}){3}$/.test(h);
};

/** Whether the URL points at a non-local host. Throws (without echoing) on an invalid URL. */
export const isRemoteDatabaseUrl = (raw: string, name = 'database URL'): boolean =>
  !isLocalDatabaseHost(parse(raw, name).host);

/**
 * Runtime policy: refuse a non-local URL whose sslmode is not exactly `verify-full`.
 * Returns the URL unchanged.
 */
export const assertVerifyFull = (raw: string, name: string): string => {
  const { url, host } = parse(raw, name);
  if (isLocalDatabaseHost(host)) return raw;
  const mode = url.searchParams.get('sslmode');
  if (mode !== REQUIRED_SSLMODE) {
    throw new Error(
      `${name} points at a non-local host but its sslmode is ${mode ? 'not verify-full' : 'missing'}: ` +
        `set sslmode=${REQUIRED_SSLMODE} explicitly (ADR-001 B5). Refusing to start.`,
    );
  }
  return raw;
};

/**
 * Owner/migration policy: for a non-local URL, return it with `sslmode=verify-full` (replacing
 * any other value, including `disable`). Local URLs are returned unchanged.
 */
export const forceVerifyFull = (raw: string, name: string): string => {
  const { url, host } = parse(raw, name);
  if (isLocalDatabaseHost(host)) return raw;
  url.searchParams.set('sslmode', REQUIRED_SSLMODE);
  // `uselibpqcompat` changes how pg interprets sslmode; verify-full means the same either way,
  // but drop the switch so behaviour does not depend on it.
  url.searchParams.delete('uselibpqcompat');
  return url.toString();
};

/** Pooled template URL with user/password replaced by the runtime role. Never printed. */
export const runtimeUrl = (template: string, role: string, password: string): string => {
  const url = new URL(template);
  url.username = encodeURIComponent(role);
  url.password = encodeURIComponent(password);
  url.searchParams.set('sslmode', REQUIRED_SSLMODE);
  url.searchParams.delete('uselibpqcompat');
  return url.toString();
};
