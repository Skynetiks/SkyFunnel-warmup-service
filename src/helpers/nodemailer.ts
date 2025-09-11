import nodemailer, { Transporter } from "nodemailer";
import Mail from "nodemailer/lib/mailer/index";
import { getEmailCredentials } from "./database";

export const getNodemailerTransport = async (
  replyFrom: string
): Promise<Transporter | null> => {
  try {
    // Get the current configuration
    const config = await getEmailCredentials(replyFrom);
    if (!config) {
      console.error(
        `[GetNodemailerTransport] No config found for ${replyFrom}`
      );
      return null;
    }

    // Create a nodemailer transport based on the current configuration
    const transport = nodemailer.createTransport({
      service: config.service,
      auth: {
        user: config.emailId,
        pass: config.password,
      },
      // Add timeout settings to prevent hanging
      connectionTimeout: 10000, // 10 seconds
      greetingTimeout: 5000, // 5 seconds
      socketTimeout: 10000, // 10 seconds
    });

    console.log(`[GetNodemailerTransport] Transport created for ${replyFrom}`);
    return transport;
  } catch (error) {
    console.error(
      `[GetNodemailerTransport] Error creating transport for ${replyFrom}:`,
      error
    );
    return null;
  }
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
  try {
    const mailOptions = {
      from: replyFrom,
      to,
      subject: `${subject}`,
      text: body,
      references: [referenceId],
      inReplyTo: inReplyTo,
    } satisfies Mail.Options;

    const transport = await getNodemailerTransport(replyFrom);
    if (!transport) {
      console.error(`[SendEmail] Failed to get transport for ${replyFrom}`);
      return false;
    }

    await transport.sendMail(mailOptions);
    console.log(`[SendEmail] Successfully sent email to ${to}`);
    return true;
  } catch (error) {
    console.error(`[SendEmail] Error sending email to ${to}:`, error);
    return false;
  }
}
