import nodemailer from 'nodemailer';

export type SendOpts = {
  to: string;
  subject: string;
  body: string;
  attachment_path?: string;
};

export function gmailTransport() {
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });
}

export async function sendEmail(
  opts: SendOpts,
  transport: { sendMail: (msg: any) => Promise<any> } = gmailTransport()
): Promise<{ message_id: string }> {
  const msg = {
    from: process.env.GMAIL_USER,
    to: opts.to,
    subject: opts.subject,
    text: opts.body,
    attachments: opts.attachment_path ? [{ path: opts.attachment_path }] : [],
  };
  const info = await transport.sendMail(msg);
  return { message_id: info.messageId };
}
