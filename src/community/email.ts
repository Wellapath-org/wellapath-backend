/**
 * Email delivery for Community OTPs.
 *
 * PoC ONLY: both sinks below are test sinks. Neither sends a real email. The production sender
 * (Resend, per ADR-001) is intentionally not implemented in the PoC, and `loadCommunityConfig`
 * refuses to boot an enabled Community under NODE_ENV=production for that reason.
 */
import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';

export type OtpPurpose = 'sign-in' | 'email-verification' | 'forget-password' | 'change-email';

export interface OtpMessage {
  to: string;
  otp: string;
  purpose: OtpPurpose;
  sentAt: string;
}

export interface EmailSender {
  readonly name: string;
  sendOtp(message: OtpMessage): Promise<void>;
}

/** Keeps messages in memory. Used by the jest suites. */
export class MemoryOutbox implements EmailSender {
  readonly name = 'memory';
  readonly messages: OtpMessage[] = [];

  async sendOtp(message: OtpMessage): Promise<void> {
    this.messages.push(message);
  }

  /** Most recent OTP sent to `to` (optionally for a purpose). */
  latestOtp(to: string, purpose?: OtpPurpose): string {
    const found = [...this.messages]
      .reverse()
      .find(m => m.to === to.toLowerCase() && (!purpose || m.purpose === purpose));
    if (!found) throw new Error(`No OTP captured for ${to}`);
    return found.otp;
  }
}

/** Appends one JSON line per message to `<dir>/outbox.jsonl`. Used by the Dart CLI run. */
export class FileOutbox implements EmailSender {
  readonly name = 'outbox-file';
  private readonly file: string;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'outbox.jsonl');
  }

  async sendOtp(message: OtpMessage): Promise<void> {
    appendFileSync(this.file, `${JSON.stringify(message)}\n`, { mode: 0o600 });
  }
}
