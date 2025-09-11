import nodemailer, { Transporter } from "nodemailer";
import Mail from "nodemailer/lib/mailer/index";
import { getEmailCredentials } from "./database";
import net from "net";

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
      // Add timeout settings to prevent hanging
      connectionTimeout: 30000, // 30 seconds
      greetingTimeout: 15000, // 15 seconds
      socketTimeout: 30000, // 30 seconds
      // Add debug logging
      debug: true,
      logger: true,
      // Add TLS options
      tls: {
        rejectUnauthorized: false,
        ciphers: "SSLv3",
      },
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

    // Test network connectivity before returning transport
    console.log(
      "[GetNodemailerTransport] Testing network connectivity to Gmail SMTP..."
    );
    const connectivity = await testGmailConnectivity();

    if (!connectivity.port587 && !connectivity.port465) {
      console.error(
        "[GetNodemailerTransport] Network connectivity test failed - Gmail SMTP is not reachable on either port 587 or 465"
      );
      return null;
    }

    // Use the available port
    if (connectivity.port465) {
      console.log(
        "[GetNodemailerTransport] Using port 465 (SSL) for Gmail SMTP"
      );
      const sslTransport = nodemailer.createTransport({
        host: "smtp.gmail.com",
        port: 465,
        secure: true, // true for 465, false for other ports
        auth: {
          user: config.emailId,
          pass: config.password,
        },
        connectionTimeout: 30000,
        greetingTimeout: 15000,
        socketTimeout: 30000,
        debug: true,
        logger: true,
      });
      return sslTransport;
    } else {
      console.log(
        "[GetNodemailerTransport] Using port 587 (STARTTLS) for Gmail SMTP"
      );
      return transport;
    }
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
