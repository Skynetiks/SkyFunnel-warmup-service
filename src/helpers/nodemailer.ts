import nodemailer, { Transporter } from "nodemailer";
import Mail from "nodemailer/lib/mailer/index";
import { getEmailCredentials } from "./database";
import net from "net";
import Logger from "../logger";
import { GmailApiService } from "./gmailApi";

// Test network connectivity to Gmail SMTP
async function testGmailConnectivity(): Promise<{
  port587: boolean;
  port465: boolean;
}> {
  const testPort = (port: number): Promise<boolean> => {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      const timeout = 5000; // 5 seconds

      socket.setTimeout(timeout);

      socket.on("connect", () => {
        console.log(
          `[NetworkTest] Successfully connected to smtp.gmail.com:${port}`
        );
        socket.destroy();
        resolve(true);
      });

      socket.on("timeout", () => {
        console.log(
          `[NetworkTest] Connection timeout to smtp.gmail.com:${port}`
        );
        socket.destroy();
        resolve(false);
      });

      socket.on("error", (err) => {
        console.log(
          `[NetworkTest] Connection error to smtp.gmail.com:${port}:`,
          err.message
        );
        socket.destroy();
        resolve(false);
      });

      socket.connect(port, "smtp.gmail.com");
    });
  };

  const [port587, port465] = await Promise.all([testPort(587), testPort(465)]);

  return { port587, port465 };
}

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
      host: "smtp.gmail.com",
      port: 587,
      secure: false, // true for 465, false for other ports
      auth: {
        user: config.emailId,
        pass: config.password,
      },
      debug: false, // Disable verbose SMTP debug logs
      logger: false, // Disable nodemailer's built-in logger
    });
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

  // Get email credentials to check service type
  const credentials = await getEmailCredentials(replyFrom);
  if (!credentials) {
    console.error(`[SendEmail] No credentials found for ${replyFrom}`);
    return false;
  }

  // Use Gmail API if service is Gmail and OAuth credentials are available
  const gmailClientId = process.env.GMAIL_CLIENT_ID;
  const gmailClientSecret = process.env.GMAIL_CLIENT_SECRET;

  if (
    credentials.service === "gmail" &&
    credentials.accessToken &&
    credentials.refreshToken &&
    gmailClientId &&
    gmailClientSecret
  ) {
    Logger.info(`[SendEmail] Using Gmail API for ${replyFrom}`);

    try {
      const gmailService = new GmailApiService({
        clientId: gmailClientId,
        clientSecret: gmailClientSecret,
        refreshToken: credentials.refreshToken,
        accessToken: credentials.accessToken,
        emailId: credentials.emailId,
      });

      const success = await gmailService.sendReply(
        to,
        subject,
        body, // body (3rd parameter) contains the reply content
        inReplyTo,
        referenceId
      );

      if (success) {
        Logger.info(
          `[SendEmail] Successfully sent email via Gmail API to ${to} from ${replyFrom}`
        );
        return true;
      } else {
        Logger.error(
          `[SendEmail] Failed to send email via Gmail API to ${to} from ${replyFrom}, falling back to SMTP`
        );
        // Fall back to SMTP if Gmail API fails
      }
    } catch (error) {
      Logger.error(
        `[SendEmail] Gmail API error for ${replyFrom}, falling back to SMTP:`,
        { error }
      );
      // Fall back to SMTP if Gmail API fails
    }
  }

  // Fall back to SMTP (existing logic)
  Logger.info(`[SendEmail] Using SMTP for ${replyFrom}`);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const mailOptions = {
        from: replyFrom,
        to,
        subject: `Re: ${subject}`,
        text: body, // body (3rd parameter) contains the reply content
        references: referenceId,
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

      // Check if this is an authentication error
      const errorMessage = error?.toString().toLowerCase() || "";
      const isAuthError =
        errorMessage.includes("authentication") ||
        errorMessage.includes("invalid credentials") ||
        errorMessage.includes("login failed") ||
        errorMessage.includes("auth") ||
        errorMessage.includes("535") || // SMTP auth error
        errorMessage.includes("534"); // SMTP auth error

      if (isAuthError) {
        Logger.criticalError(
          "[SendEmail] Authentication failure detected:",
          {
            action: "Authentication Error",
            error,
            replyFrom,
            to,
            attempt,
          },
          ["Authentication failed - stopping retry attempts"]
        );

        return false; // Stop retrying on auth error
      }

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

/**
 * Optimized batch email sending that reuses connections for multiple emails from the same account
 */
export async function sendBatchEmails(
  replyFromEmail: string,
  messages: Array<{
    to: string;
    originalSubject: string;
    body: string;
    keyword: string;
    inReplyTo?: string;
    referenceId?: string;
    warmupId: string;
  }>
): Promise<{ success: number; failed: number }> {
  let successCount = 0;
  let failedCount = 0;

  if (messages.length === 0) {
    return { success: 0, failed: 0 };
  }

  Logger.info(
    `[SendBatchEmails] Starting batch send for ${replyFromEmail} with ${messages.length} messages`
  );

  // Get credentials once for all messages
  const credentials = await getEmailCredentials(replyFromEmail);
  if (!credentials) {
    Logger.error(
      `[SendBatchEmails] No credentials found for ${replyFromEmail}`
    );
    return { success: 0, failed: messages.length };
  }

  // Check if we can use Gmail API
  const gmailClientId = process.env.GMAIL_CLIENT_ID;
  const gmailClientSecret = process.env.GMAIL_CLIENT_SECRET;

  if (
    credentials.service === "gmail" &&
    credentials.accessToken &&
    credentials.refreshToken &&
    gmailClientId &&
    gmailClientSecret
  ) {
    // Use Gmail API for all messages
    Logger.info(`[SendBatchEmails] Using Gmail API for ${replyFromEmail}`);

    try {
      const gmailService = new GmailApiService({
        clientId: gmailClientId,
        clientSecret: gmailClientSecret,
        refreshToken: credentials.refreshToken,
        accessToken: credentials.accessToken,
        emailId: credentials.emailId,
      });

      // Send all messages using the same Gmail API instance
      // This ensures token refresh only happens once per batch, not per message
      for (const message of messages) {
        try {
          const success = await gmailService.sendReply(
            message.to,
            message.originalSubject,
            message.body, // body contains the reply content
            message.inReplyTo,
            message.referenceId
          );

          if (success) {
            successCount++;
            Logger.info(
              `[SendBatchEmails] Gmail API success: ${message.to} from ${replyFromEmail}`
            );
          } else {
            failedCount++;
            Logger.error(
              `[SendBatchEmails] Gmail API failed: ${message.to} from ${replyFromEmail}`
            );
          }
        } catch (error) {
          failedCount++;
          Logger.error(`[SendBatchEmails] Gmail API error for ${message.to}:`, {
            error,
          });
        }
      }
    } catch (gmailError) {
      Logger.error(
        `[SendBatchEmails] Gmail API setup failed for ${replyFromEmail}, falling back to SMTP:`,
        { error: gmailError }
      );
      // Fall back to SMTP for all messages
      return await sendBatchEmailsSMTP(replyFromEmail, messages, credentials);
    }
  } else {
    // Use SMTP for all messages
    return await sendBatchEmailsSMTP(replyFromEmail, messages, credentials);
  }

  Logger.info(
    `[SendBatchEmails] Completed batch for ${replyFromEmail}: ${successCount} success, ${failedCount} failed`
  );
  return { success: successCount, failed: failedCount };
}

/**
 * Send batch emails using SMTP with connection reuse
 */
async function sendBatchEmailsSMTP(
  replyFromEmail: string,
  messages: Array<{
    to: string;
    originalSubject: string;
    body: string;
    keyword: string;
    inReplyTo?: string;
    referenceId?: string;
    warmupId: string;
  }>,
  credentials: any
): Promise<{ success: number; failed: number }> {
  let successCount = 0;
  let failedCount = 0;

  Logger.info(`[SendBatchEmails] Using SMTP for ${replyFromEmail}`);

  // Create transport once for all messages
  const transport = await getNodemailerTransport(replyFromEmail);
  if (!transport) {
    Logger.error(
      `[SendBatchEmails] Failed to create SMTP transport for ${replyFromEmail}`
    );
    return { success: 0, failed: messages.length };
  }

  // Send all messages using the same transport
  for (const message of messages) {
    const maxRetries = 2;
    let success = false;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const mailOptions = {
          from: replyFromEmail,
          to: message.to,
          subject: `Re: ${message.originalSubject}`,
          text: message.body, // body contains the reply content
          references: message.referenceId,
          inReplyTo: message.inReplyTo,
        };

        await transport.sendMail(mailOptions);
        success = true;
        successCount++;
        Logger.info(
          `[SendBatchEmails] SMTP success: ${message.to} from ${replyFromEmail}`
        );
        break; // Exit retry loop on success
      } catch (error) {
        Logger.error(
          `[SendBatchEmails] SMTP attempt ${attempt}/${maxRetries} failed for ${message.to}:`,
          { error }
        );

        // Check if this is an authentication error
        const errorMessage = error?.toString().toLowerCase() || "";
        const isAuthError =
          errorMessage.includes("authentication") ||
          errorMessage.includes("invalid credentials") ||
          errorMessage.includes("login failed") ||
          errorMessage.includes("auth") ||
          errorMessage.includes("535") ||
          errorMessage.includes("534");

        if (isAuthError) {
          Logger.error(
            `[SendBatchEmails] Authentication error detected for ${replyFromEmail}, stopping batch`
          );
          // Stop processing remaining messages on auth error
          failedCount += messages.length - messages.indexOf(message);
          return { success: successCount, failed: failedCount };
        }

        if (attempt === maxRetries) {
          failedCount++;
          break; // Exit retry loop after max attempts
        }

        // Wait before retry
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }

  // Close the transport connection
  transport.close();

  Logger.info(
    `[SendBatchEmails] SMTP batch completed for ${replyFromEmail}: ${successCount} success, ${failedCount} failed`
  );
  return { success: successCount, failed: failedCount };
}
