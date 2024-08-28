import nodemailer, { Transporter } from "nodemailer";
import Mail from "nodemailer/lib/mailer/index";
import { getEmailCredentials } from "./database";

export const getNodemailerTransport = async (
  replyFrom: string
): Promise<Transporter | null> => {
  // Get the current configuration
  const config = await getEmailCredentials(replyFrom);
  if (!config) return null;
  // Create a nodemailer transport based on the current configuration
  const transport = nodemailer.createTransport({
    service: config.service,
    auth: {
      user: config.emailId,
      pass: config.password,
    },
  });

  return transport;
};

/**
 * Helper function to send an email.
 * @param {string} to - Recipient email address.
 * @param {string} subject - Subject of the email.
 * @param {string} text - Body text of the email.
 */
export async function sendEmail(
  to: string,
  subject: string,
  body: string,
  text: string,
  inReplyTo: string,
  referenceId: string,
  replyFrom: string
): Promise<boolean> {
  const mailOptions = {
    from: replyFrom,
    to,
    subject: `${subject}`,
    text: body,
    references: [referenceId],
    inReplyTo: inReplyTo,
  } satisfies Mail.Options;

  const transport = await getNodemailerTransport(replyFrom);
  if (!transport) return false

  await transport.sendMail(mailOptions);
  return true;
}
