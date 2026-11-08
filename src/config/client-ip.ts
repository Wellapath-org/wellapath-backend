/**
 * The security client identity (SEC-001 / SEC-002 / SEC-026 / SEC-027): the ONE key every security
 * control uses. That covers the app-wide rate limiter (and the telemetry route limit, which
 * inherits its key), every Community per-IP limit, and the IP HMAC in auth / moderation audit
 * events.
 *
 * Why not an X-Forwarded-For hop count (`TRUST_PROXY_HOPS`)? On Render, Cloudflare APPENDS to a
 * client-supplied X-Forwarded-For (its docs and our staging probe agree), so its left side is
 * attacker-controlled. A hop count is only safe if every path has the same number of appending
 * proxies, and that number cannot be measured from outside without running with a spoofable
 * value. Render's edge instead sets `CF-Connecting-IP` to the connecting client, and Cloudflare
 * rejects (403 on all our hosts) or overwrites any client-supplied copy. That header, and only
 * that header, is the signal used here.
 *
 * Sources (`CLIENT_IP_SOURCE`):
 * - `socket` (default): `request.ip`, i.e. the socket peer (Fastify's proxy trust is left as
 *   configured). Local development, tests and today's deployments behave exactly as before.
 * - `cf-connecting-ip`: Render only. The header must hold exactly ONE syntactically valid IPv4 or
 *   IPv6 address. Node joins a duplicated header into one comma-separated string, so a duplicate
 *   is rejected like any list. A missing, empty, comma-separated or otherwise malformed value is
 *   never parsed for an address. The request is UNATTRIBUTED: it keys on
 *   `unattributed:<socket peer>`, which the client cannot choose, and is counted and logged
 *   (without IPs, see app.ts). Community applies the conservative interim/global ceilings to it.
 *   It is not refused, because Render's own health checks and private-network callers arrive
 *   without Cloudflare. X-Forwarded-For, Forwarded, X-Real-IP and True-Client-IP are never read.
 *
 * Identity (SEC-026): an IPv4 address keys on itself; an IPv6 address keys on its /64 network,
 * so rotating through addresses inside one /64 (a single subscriber allocation) cannot open
 * fresh buckets. IPv4-mapped IPv6 (`::ffff:a.b.c.d`) is the IPv4 identity.
 */
import { FastifyRequest } from 'fastify';
import ipaddr from 'ipaddr.js';

export type ClientIpSource = 'socket' | 'cf-connecting-ip';

export const parseClientIpSource = (raw: string | undefined): ClientIpSource => {
  const value = (raw ?? '').trim();
  if (value === '' || value === 'socket') return 'socket';
  if (value === 'cf-connecting-ip') return 'cf-connecting-ip';
  throw new Error(
    'Invalid value for CLIENT_IP_SOURCE: expected `socket` (default) or `cf-connecting-ip`',
  );
};

/** Longest textual IPv6 (incl. an embedded IPv4 tail) is 45 characters. */
const MAX_LENGTH = 45;
/** Hex digits, `:` and `.` only: no comma, whitespace, brackets, port, zone id (`%`) or `/`. */
const SHAPE = /^[0-9A-Fa-f:.]+$/;
/** IPv6 identity prefix length (SEC-026). */
export const IPV6_PREFIX = 64;
/** Prefix of every unattributed key. Never producible from a parsed address (no `u`, `n`, ...). */
export const UNATTRIBUTED_PREFIX = 'unattributed:';

export const isUnattributedKey = (key: string): boolean => key.startsWith(UNATTRIBUTED_PREFIX);

/**
 * One header value → canonical address, or null. Canonical: IPv4 dotted decimal; IPv4-mapped
 * IPv6 (`::ffff:a.b.c.d`) becomes its IPv4; IPv6 is lower-case and compressed (RFC 5952 style).
 */
export const canonicalIp = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null; // missing (undefined) or any non-string shape
  if (raw.length === 0 || raw.length > MAX_LENGTH || !SHAPE.test(raw)) return null;
  if (raw.includes(':')) {
    if (!ipaddr.IPv6.isValid(raw)) return null;
    const v6 = ipaddr.IPv6.parse(raw);
    return v6.isIPv4MappedAddress() ? v6.toIPv4Address().toString() : v6.toString();
  }
  // Four decimal octets only: rejects `1.2.3`, `0x7f.0.0.1`, `017.0.0.1`, `4294967295`.
  if (!ipaddr.IPv4.isValidFourPartDecimal(raw)) return null;
  return ipaddr.IPv4.parse(raw).toString();
};

/** Canonical address → security identity: IPv4 itself, IPv6 its canonical /64 network. */
export const securityIdentity = (canonical: string): string => {
  if (!canonical.includes(':')) return canonical;
  const network = ipaddr.IPv6.networkAddressFromCIDR(`${canonical}/${IPV6_PREFIX}`);
  return `${network.toString()}/${IPV6_PREFIX}`;
};

export interface SecurityClientIp {
  /** The key every security control uses for this request. */
  ip: string;
  /** Where it came from. `unattributed` ⇒ conservative limits, counted, never client-chosen. */
  via: 'cf-connecting-ip' | 'socket' | 'unattributed';
  /** Why an edge header was not used (unattributed only). */
  reason?: 'missing' | 'malformed';
}

export const securityClientIp = (
  request: FastifyRequest,
  source: ClientIpSource,
): SecurityClientIp => {
  if (source === 'cf-connecting-ip') {
    const raw = request.headers['cf-connecting-ip'];
    const ip = canonicalIp(raw);
    if (ip) return { ip: securityIdentity(ip), via: 'cf-connecting-ip' };
    return {
      ip: `${UNATTRIBUTED_PREFIX}${request.ip}`,
      via: 'unattributed',
      reason: raw === undefined ? 'missing' : 'malformed',
    };
  }
  return { ip: request.ip, via: 'socket' };
};
