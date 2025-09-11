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
      connectionTimeout: 15000, // 15 seconds
      greetingTimeout: 10000, // 10 seconds
      socketTimeout: 15000, // 15 seconds
      // Add debug logging
      debug: true,
      logger: true,
    });

    console.log(
      `[GetNodemailerTransport] Transport created for ${replyFrom} using service: ${config.service}`
    );
    console.log(
      `[GetNodemailerTransport] Email: ${config.emailId}, Password length: ${config.password.length}`
    );

    // Check if password has spaces (Gmail app passwords shouldn't have spaces)
    if (config.password.includes(" ")) {
      console.warn(
        `[GetNodemailerTransport] WARNING: Password contains spaces for ${replyFrom}. Gmail app passwords should not have spaces.`
      );
    }

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
  const maxRetries = 2;
  let lastError: any;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
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

      console.log(
        `[SendEmail] Attempt ${attempt}/${maxRetries} - Sending email to ${to} from ${replyFrom}`
      );
      console.log(`[SendEmail] Mail options:`, {
        from: mailOptions.from,
        to: mailOptions.to,
        subject: mailOptions.subject,
        references: mailOptions.references,
        inReplyTo: mailOptions.inReplyTo,
      });

      await transport.sendMail(mailOptions);
      console.log(`[SendEmail] Successfully sent email to ${to}`);
      return true;
    } catch (error) {
      lastError = error;
      console.error(
        `[SendEmail] Attempt ${attempt}/${maxRetries} failed for ${to}:`,
        error
      );

      if (attempt < maxRetries) {
        console.log(`[SendEmail] Retrying in 2 seconds...`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }

  console.error(
    `[SendEmail] All ${maxRetries} attempts failed for ${to}. Last error:`,
    lastError
  );
  return false;
}
