import nodemailer, { Transporter } from "nodemailer";
import Mail from "nodemailer/lib/mailer/index";
import { getEmailCredentials } from "./database";
import net from "net";
import { isEmailBlocked, markAuthenticationFailure, isEmailInCooldownList, addToWarmupCooldownList } from "./redis";
import Logger from "../logger";

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
  // Check if email is in cooldown list (2-day cooldown)
  const isInCooldown = await isEmailInCooldownList(replyFrom);
  if (isInCooldown) {
    Logger.info(
      `[SendEmail] Email ${replyFrom} is in cooldown list (2-day). Skipping send to ${to}.`
    );
    return false;
  }

  // Check if email is blocked due to recent authentication failure (8-hour)
  const isBlocked = await isEmailBlocked(replyFrom);
  if (isBlocked) {
    Logger.info(
      `[SendEmail] Email ${replyFrom} is blocked due to recent authentication failure. Skipping send to ${to}.`
    );
    return false;
  }

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
          "[SendEmail] Authentication failure detected, adding to cooldown list:",
          {
            action: "Authentication Error",
            error,
            replyFrom,
            to,
            attempt,
          },
          ["Email will be added to cooldown list for 2 days to prevent brute force attacks"]
        );

        // Add email to cooldown list for 2 days
        await addToWarmupCooldownList(replyFrom);
        
        // Also mark for short-term blocking (8 hours)
        await markAuthenticationFailure(replyFrom);
        
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
