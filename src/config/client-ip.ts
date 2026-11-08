/**
 * The security client IP (SEC-001 / SEC-002): the ONE address every security control keys on.
 * That covers the app-wide rate limiter (and the telemetry route limiter, which inherits its key),
 * every Community per-IP limit, and the IP HMAC in auth / moderation audit events.
 *
 * Why not an X-Forwarded-For hop count (`TRUST_PROXY_HOPS`)? On Render, Cloudflare APPENDS to a
 * client-supplied X-Forwarded-For (its docs and our staging probe agree), so its left side is
 * attacker-controlled. A hop count is only safe if every path has the same number of appending
 * proxies, and that number cannot be measured from outside without running with a spoofable
 * value. Render's edge instead sets `CF-Connecting-IP` to the connecting client, and Cloudflare
 * overwrites (on our staging host: rejects with 403) any client-supplied copy. That header, and
 * only that header, is the signal used here.
 *
 * Sources (`CLIENT_IP_SOURCE`):
 * - `socket` (default): `request.ip`, i.e. the socket peer (Fastify's proxy trust is left as
 *   configured). Local development, tests and today's deployments behave exactly as before.
 * - `cf-connecting-ip`: Render only. The header must hold exactly ONE syntactically valid IPv4 or
 *   IPv6 address. A missing, duplicated, comma-separated or malformed value is never parsed for
 *   an address. The request keys on `unattributed:<socket peer>` instead, which the client cannot
 *   influence, and is not refused: Render's own health checks arrive without Cloudflare.
 *   X-Forwarded-For, Forwarded, X-Real-IP and True-Client-IP are never read.
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

/**
 * One header value → canonical address, or null. Canonical: IPv4 dotted decimal; IPv4-mapped
 * IPv6 (`::ffff:a.b.c.d`) becomes its IPv4; IPv6 is lower-case and compressed (RFC 5952 style).
 */
export const canonicalIp = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null; // missing, or an array (a duplicated header)
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

export interface SecurityClientIp {
  /** The key every security control uses for this request. */
  ip: string;
  /** Where it came from: the edge header, the socket, or the socket as an unattributed fallback. */
  via: 'cf-connecting-ip' | 'socket' | 'unattributed';
}

export const securityClientIp = (
  request: FastifyRequest,
  source: ClientIpSource,
): SecurityClientIp => {
  if (source === 'cf-connecting-ip') {
    const ip = canonicalIp(request.headers['cf-connecting-ip']);
    if (ip) return { ip, via: 'cf-connecting-ip' };
    return { ip: `unattributed:${request.ip}`, via: 'unattributed' };
  }
  return { ip: request.ip, via: 'socket' };
};
