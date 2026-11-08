/**
 * Trusted-proxy configuration (ADR-001 amendment A3, contract §4.1).
 *
 * `TRUST_PROXY_HOPS` is the measured number of proxies in front of the service (Cloudflare →
 * Render). Fastify then takes the client address that sits that many positions from the right of
 * `X-Forwarded-For`; whatever a client writes on the left cannot change it. Unset ⇒ no proxy is
 * trusted and `request.ip` is the socket peer. `true` (trust everything) is never accepted,
 * because it would let any client choose its own IP.
 */
export const parseTrustProxyHops = (raw: string | undefined): number | undefined => {
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = raw.trim();
  if (!/^\d+$/.test(value)) {
    throw new Error(
      'Invalid value for TRUST_PROXY_HOPS: expected an integer hop count (trustProxy: true is never used)',
    );
  }
  const hops = Number.parseInt(value, 10);
  if (hops < 1 || hops > 10) {
    throw new Error('Invalid value for TRUST_PROXY_HOPS: expected an integer in [1, 10]');
  }
  return hops;
};
