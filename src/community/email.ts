/**
 * Email delivery for Community OTPs.
 *
 * - `resend`: the real sender (ADR-001). One HTTPS POST to Resend's `/emails` API per OTP, with a
 *   hard timeout, NO retry (a retry after an ambiguous failure could deliver two codes) and a
 *   per-message `Idempotency-Key`. Any failure is an `EmailUnavailableError`, which the facade
 *   turns into 503 `community_unavailable` with `details.reason = "email_unavailable"`. The API
 *   key and the recipient address are never logged or put in an error message.
 * - `memory` / `outbox-file`: TEST sinks. They store the OTP where a test can read it, so
 *   `loadCommunityConfig` refuses them under NODE_ENV=production.
 *
 * Every sender exposes `purge(cutoff)` for the sign-in retention job: the test sinks drop
 * messages older than the cutoff; Resend keeps nothing here.
 */
import { randomUUID } from 'crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

export type OtpPurpose = 'sign-in' | 'email-verification' | 'forget-password' | 'change-email';

/** Better Auth email-OTP lifetime (auth.ts), shown in the email. */
export const OTP_TTL_SECONDS = 300;

export interface OtpMessage {
  to: string;
  otp: string;
  purpose: OtpPurpose;
  sentAt: string;
}

export interface EmailSender {
  readonly name: string;
  sendOtp(message: OtpMessage): Promise<void>;
  /** Deletes stored messages sent before `cutoff`. Returns how many were removed. */
  purge?(cutoff: Date): Promise<number>;
}

/** Delivery failed or is unknown. Carries no address, key, code or provider response body. */
export class EmailUnavailableError extends Error {
  constructor(
    readonly reason: 'timeout' | 'network' | 'rejected',
    readonly status?: number,
  ) {
    super(`Email provider unavailable (${reason}${status ? `, HTTP ${status}` : ''})`);
    this.name = 'EmailUnavailableError';
  }
}

/** Keeps messages in memory. Used by the jest suites. */
export class MemoryOutbox implements EmailSender {
  readonly name = 'memory';
  readonly messages: OtpMessage[] = [];

  async sendOtp(message: OtpMessage): Promise<void> {
    this.messages.push(message);
  }

  async purge(cutoff: Date): Promise<number> {
    const before = this.messages.length;
    const keep = this.messages.filter(m => new Date(m.sentAt) >= cutoff);
    this.messages.splice(0, this.messages.length, ...keep);
    return before - keep.length;
  }

  /** Most recent OTP sent to `to` (optionally for a purpose). */
  latestOtp(to: string, purpose?: OtpPurpose): string {
    const found = [...this.messages]
      .reverse()
      .find(m => m.to === to.toLowerCase() && (!purpose || m.purpose === purpose));
    if (!found) throw new Error('No OTP captured for that address');
    return found.otp;
  }
}

/** Appends one JSON line per message to `<dir>/outbox.jsonl`. Used by the Dart CLI run. */
export class FileOutbox implements EmailSender {
  readonly name = 'outbox-file';
  private readonly file: string;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = join(dir, 'outbox.jsonl');
  }

  async sendOtp(message: OtpMessage): Promise<void> {
    appendFileSync(this.file, `${JSON.stringify(message)}\n`, { mode: 0o600 });
  }

  async purge(cutoff: Date): Promise<number> {
    if (!existsSync(this.file)) return 0;
    const lines = readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
    const keep = lines.filter(line => {
      try {
        return new Date((JSON.parse(line) as OtpMessage).sentAt) >= cutoff;
      } catch {
        return false; // unreadable lines are dropped too
      }
    });
    if (keep.length === lines.length) return 0;
    writeFileSync(this.file, keep.map(l => `${l}\n`).join(''), { mode: 0o600 });
    return lines.length - keep.length;
  }
}

export const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export interface ResendOptions {
  apiKey: string;
  /** `WellaPath <no-reply@example.org>` or a bare address on a Resend-verified domain. */
  from: string;
  timeoutMs: number;
  /** Injected in tests (mocked fetch). Defaults to the global fetch (Node 22). */
  fetchImpl?: typeof fetch;
  endpoint?: string;
}

const escapeHtml = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );

/** Plain-text and HTML bodies of the OTP email. No clinical content, no tracking. */
export const otpEmailContent = (otp: string): { subject: string; text: string; html: string } => {
  const minutes = Math.round(OTP_TTL_SECONDS / 60);
  const subject = 'Your WellaPath sign-in code';
  const lines = [
    `Your WellaPath sign-in code is: ${otp}`,
    '',
    `It expires in ${minutes} minutes and can be used once.`,
    'If you did not ask to sign in, you can ignore this email.',
    'Never share this code. WellaPath will never ask you for it.',
  ];
  const code = escapeHtml(otp);
  const html = [
    '<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#1a1a1a">',
    '<p>Your WellaPath sign-in code is:</p>',
    `<p style="font-size:28px;font-weight:bold;letter-spacing:4px">${code}</p>`,
    `<p>It expires in ${minutes} minutes and can be used once.</p>`,
    '<p>If you did not ask to sign in, you can ignore this email.</p>',
    '<p>Never share this code. WellaPath will never ask you for it.</p>',
    '</body></html>',
  ].join('');
  return { subject, text: lines.join('\n'), html };
};

/** Resend HTTP API sender (no SDK). One attempt per OTP; see the module comment. */
export class ResendSender implements EmailSender {
  readonly name = 'resend';
  private readonly fetchImpl: typeof fetch;
  private readonly endpoint: string;

  constructor(private readonly options: ResendOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.endpoint = options.endpoint ?? RESEND_ENDPOINT;
  }

  async sendOtp(message: OtpMessage): Promise<void> {
    const { subject, text, html } = otpEmailContent(message.otp);
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
          // Resend de-duplicates on this key, so even a transport-level replay cannot send twice.
          'idempotency-key': randomUUID(),
        },
        body: JSON.stringify({ from: this.options.from, to: [message.to], subject, text, html }),
        redirect: 'error',
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      const name = (error as { name?: string }).name;
      throw new EmailUnavailableError(
        name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network',
      );
    }
    // The body is drained (to free the socket) but never logged: it can echo the request.
    await response.text().catch(() => '');
    if (!response.ok) throw new EmailUnavailableError('rejected', response.status);
  }

  async purge(): Promise<number> {
    return 0; // nothing is stored locally
  }
}
