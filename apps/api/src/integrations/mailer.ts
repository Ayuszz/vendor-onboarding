import nodemailer from 'nodemailer';
import type { Config } from '../config.js';

/**
 * Outbound email port. `SmtpMailer` works with any SMTP server: Microsoft 365 / Outlook
 * (smtp.office365.com:587), Google Workspace (smtp.gmail.com:587 with an app password),
 * Amazon SES, SendGrid, Zoho, or your own relay.
 */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface Mailer {
  send(msg: EmailMessage): Promise<void>;
}

export class SmtpMailer implements Mailer {
  private readonly transport;
  constructor(private readonly cfg: Pick<Config, 'SMTP_HOST' | 'SMTP_PORT' | 'SMTP_SECURE' | 'SMTP_USER' | 'SMTP_PASS' | 'MAIL_FROM'>) {
    this.transport = nodemailer.createTransport({
      host: cfg.SMTP_HOST,
      port: cfg.SMTP_PORT,
      secure: cfg.SMTP_SECURE, // true for 465; false uses STARTTLS on 587
      requireTLS: !cfg.SMTP_SECURE,
      ...(cfg.SMTP_USER ? { auth: { user: cfg.SMTP_USER, pass: cfg.SMTP_PASS } } : {}),
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }
  async send(msg: EmailMessage) {
    await this.transport.sendMail({ from: this.cfg.MAIL_FROM, ...msg });
  }
  /** Checks the SMTP connection and credentials at boot. */
  verify() {
    return this.transport.verify();
  }
}

/**
 * Sends nothing. Keeps messages in memory (used by tests) and, when `printToTerminal`
 * is on (development only), prints them to the server's own terminal — never to the browser.
 */
export class ConsoleMailer implements Mailer {
  readonly sent: EmailMessage[] = [];
  constructor(private readonly printToTerminal: ((line: string) => void) | null = null) {}
  async send(msg: EmailMessage) {
    this.sent.push(msg);
    this.printToTerminal?.(`\n[mail] to: ${msg.to}\n[mail] subject: ${msg.subject}\n${msg.text}\n`);
  }
}

export function createMailer(cfg: Config, log: (line: string) => void): Mailer {
  if (cfg.MAILER === 'smtp') return new SmtpMailer(cfg);
  return new ConsoleMailer(cfg.NODE_ENV === 'development' ? log : null);
}
