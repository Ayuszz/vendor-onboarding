/**
 * Outbound email port. The console mailer logs messages (local dev); implement this
 * interface over SMTP, Amazon SES, SendGrid or Microsoft Graph for production.
 */
export interface Mailer {
  send(msg: { to: string; subject: string; text: string }): Promise<void>;
}

export class ConsoleMailer implements Mailer {
  readonly sent: { to: string; subject: string; text: string }[] = [];
  constructor(private readonly log: (line: string) => void = () => {}) {}
  async send(msg: { to: string; subject: string; text: string }) {
    this.sent.push(msg);
    this.log(`[mail] to=${msg.to} subject="${msg.subject}"`);
  }
}
