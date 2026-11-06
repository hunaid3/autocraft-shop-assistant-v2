/** Outgoing email (support alerts) through Amazon SES in Mumbai. The task role allows SendEmail only. */
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

export interface EmailSender { send(m: { to: string; subject: string; text: string; replyTo?: string }): Promise<void> }

export class SesEmailSender implements EmailSender {
  private readonly client: SESv2Client;
  constructor(private readonly opts: { from: string; region?: string }) {
    this.client = new SESv2Client({ region: opts.region ?? 'ap-south-1' });
  }
  async send(m: { to: string; subject: string; text: string; replyTo?: string }): Promise<void> {
    await this.client.send(new SendEmailCommand({
      FromEmailAddress: this.opts.from,
      Destination: { ToAddresses: [m.to] },
      ReplyToAddresses: m.replyTo ? [m.replyTo] : undefined,
      Content: { Simple: { Subject: { Data: m.subject.slice(0, 200), Charset: 'UTF-8' }, Body: { Text: { Data: m.text, Charset: 'UTF-8' } } } }
    }));
  }
}

export class RecordingEmail implements EmailSender {
  readonly sent: Array<{ to: string; subject: string; text: string }> = [];
  failNext = 0;
  async send(m: { to: string; subject: string; text: string }): Promise<void> {
    if (this.failNext > 0) { this.failNext--; throw new Error('simulated email failure'); }
    this.sent.push(m);
  }
}
