/**
 * No full email address in normal application logs (founder-approved retention rule,
 * 2026-11-07).
 *
 * - `maskEmail('jane@example.com')` → `j***@example.com`: enough for an operator to tell two
 *   addresses apart in a support conversation, not enough to recover the address.
 * - `scrubEmails(text)` masks every email-shaped substring.
 * - `scrubLogValue(value)` does that recursively for a log object (bounded depth), turning
 *   Errors into `{ type, message, code }` with the message scrubbed.
 *
 * Wired into the Pino logger in `src/app.ts` at three points: `hooks.logMethod` (message
 * strings), `formatters.log` (plain logged objects, before serialization) and, decisive,
 * `scrubbingStream` around the destination, which masks the final serialized JSON line, so
 * serializer output (req/res/err) is covered too. It applies to every log line of the service,
 * including Fastify's, Better Auth's (routed through Pino by `auth.ts`) and pg errors. Community
 * code also never passes an address to the logger in the first place.
 */

/** Deliberately loose: anything that looks like local@domain.tld. */
const EMAIL_PATTERN = /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

const MAX_DEPTH = 6;

export const maskEmail = (email: string): string => {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '***';
  return `${email[0]}***@${email.slice(at + 1)}`;
};

export const scrubEmails = (text: string): string =>
  text.includes('@') ? text.replace(EMAIL_PATTERN, match => maskEmail(match)) : text;

export const scrubLogValue = (value: unknown, depth = 0): unknown => {
  if (typeof value === 'string') return scrubEmails(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[depth]';
  if (value instanceof Error) {
    return {
      type: value.name,
      message: scrubEmails(value.message),
      ...(value.stack ? { stack: scrubEmails(value.stack) } : {}),
      ...((value as { code?: unknown }).code !== undefined
        ? { code: (value as { code?: unknown }).code }
        : {}),
    };
  }
  if (Array.isArray(value)) return value.map(v => scrubLogValue(v, depth + 1));
  // Class instances (Fastify request/reply, Date, Buffer…) are left to their serializers; the
  // serialized line is scrubbed by `scrubbingStream`.
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = scrubLogValue(v, depth + 1);
  }
  return out;
};

/** Pino `hooks.logMethod`: scrubs string arguments (the message and any interpolation args). */
export function scrubLogArgs(
  this: unknown,
  args: unknown[],
  method: (...a: unknown[]) => void,
): void {
  method.apply(
    this,
    args.map(a => (typeof a === 'string' ? scrubEmails(a) : a)),
  );
}

export interface LineSink {
  write(chunk: string): unknown;
}

/**
 * Pino destination wrapper: masks every email-shaped substring in each serialized line. The mask
 * contains no quote or backslash, so a JSON line stays valid JSON.
 */
export const scrubbingStream = (target: LineSink): LineSink => ({
  write: (chunk: string): unknown => target.write(scrubEmails(String(chunk))),
});
