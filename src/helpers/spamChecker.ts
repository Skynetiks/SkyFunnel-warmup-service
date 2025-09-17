import { getEmailCredentials, logEmailResponse } from "./database";
import Logger from "../logger";
import { ImapFlow } from "imapflow";

interface ProviderConfig {
  host: string;
  port: number;
  secure: boolean;
  spamFolder: string;
}

interface Email {
  subject: string;
}

// Logger class for error logging

// Mark email as read
async function markAllEmailAsRead(client: ImapFlow): Promise<boolean> {
  try {
    await client.messageFlagsAdd({ seen: false }, ["\\Seen"]);
    Logger.info(`✅ Marked all email as read`);
    return true;
  } catch (error) {
    Logger.criticalError(
      "[SpamCheck] Failed to mark all email as read",
      {
        action: "Mark Email as Read",
        error: error,
      },
      ["Check IMAP permissions", "Verify email client settings"]
    );
    return false;
  }
}

const providers: Record<string, ProviderConfig> = {
  gmail: {
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    spamFolder: "[Gmail]/Spam",
  },
  outlook: {
    host: "outlook.office365.com",
    port: 993,
    secure: true,
    spamFolder: "Spam",
  },
  skyfunnel: {
    host: "box.skyfunnel.us",
    port: 993,
    secure: true,
    spamFolder: "SPAM",
  },
};

async function checkEmailInSpam(
  email: Email,
  provider: keyof typeof providers,
  credentials: { user: string; pass: string }
): Promise<boolean> {
  let inSpam = false;
  Logger.info(`[CheckSpam] Checking email: ${email.subject}`);
  const { user, pass } = credentials;
  const providerConfig = providers[provider];

  if (!providerConfig) {
    Logger.criticalError(
      "[SpamCheck] Config for the specified provider is not defined.",
      { action: "Getting Provider Config", provider: provider },
      ["Check if the provider is correctly defined"]
    );
    return false;
  }

  const { host, port, secure, spamFolder } = providerConfig;
  const client = new ImapFlow({
    host,
    port,
    secure,
    auth: { user, pass },
    logger: false,
  });

  try {
    await client.connect();
    Logger.info(`[CheckSpam] Connected to ${provider} for user: ${user}`);

    // Lock the spam folder
    const lock = await client.getMailboxLock(spamFolder);

    try {
      const searchResult = await client.search({
        header: { Subject: email.subject },
        seen: false,
      });

      if (
        !searchResult ||
        !Array.isArray(searchResult) ||
        searchResult.length === 0
      ) {
        Logger.info(
          `[CheckSpam] No emails found in ${spamFolder} matching subject: ${email.subject}`
        );
        return false; // Email not in spam
      }

      Logger.info(
        `[CheckSpam] Found email(s) in ${spamFolder} with UID(s): ${searchResult.join(
          ", "
        )}`
      );
      const results = await client.fetch(searchResult, { envelope: true });
      // Loop through the results and check if the email subject matches

      for await (const result of results) {
        if (
          result.envelope &&
          result.envelope.subject &&
          result.envelope.subject.includes(email.subject)
        ) {
          Logger.info(
            `[CheckSpam] Email with subject "${email.subject}" found in spam.`
          );
          inSpam = true;
          // NOTE: DO NOT EARLY BREAK OR RETURN HERE. IT WILL CAUSE DEAD LOOP
          // NOTE: DO NOT USE ANY IMAP COMMANDS HERE. IT WILL CAUSE DEAD LOOP
        } else {
          Logger.info(
            `[CheckSpam] Email with UID ${result.uid} does not match subject "${email.subject}".`
          );
          inSpam = false;
        }
      }

      if (!inSpam) {
        Logger.info(
          `[CheckSpam] Email with subject "${email.subject}" not found in spam.`
        );
      } else {
        Logger.info(
          `[CheckSpam] Email with subject "${email.subject}" found in spam.`
        );
      }

      // Mark emails as read regardless of spam status
      await markAllEmailAsRead(client);
    } catch (err) {
      Logger.criticalError(
        "[SpamCheck] Error while searching emails in the spam folder.",
        {
          action: "Search in Spam Folder",
          emailSubject: email.subject,
          error: err,
          provider: provider,
          spamFolder: spamFolder,
        },
        [
          "Check if the spam folder is correctly defined",
          "Something Went Wrong While Searching Emails",
        ]
      );

      inSpam = false; // Default to false in case of error
    } finally {
      await lock.release();
    }
  } catch (err) {
    // Check if this is an authentication error
    const errorMessage = err?.toString().toLowerCase() || "";
    const isAuthError =
      errorMessage.includes("authentication") ||
      errorMessage.includes("invalid credentials") ||
      errorMessage.includes("login failed") ||
      errorMessage.includes("auth") ||
      errorMessage.includes("535") || // SMTP auth error
      errorMessage.includes("534") || // SMTP auth error
      (errorMessage.includes("no") && errorMessage.includes("authenticate")); // IMAP auth error

    if (isAuthError) {
      Logger.criticalError(
        "[SpamCheck] IMAP Authentication failure detected:",
        {
          action: "IMAP Authentication Error",
          error: err,
          provider: provider,
          user: credentials.user,
          emailSubject: email.subject,
        },
        ["IMAP authentication failed"]
      );
    } else {
      Logger.criticalError(
        "[SpamCheck] Error while connecting to the IMAP server.",
        {
          action: "Connection Error",
          emailSubject: email.subject,
          error: err,
          provider: provider,
          spamFolder: spamFolder,
        },
        ["Check credentials", "Ensure IMAP settings are correct"]
      );
    }

    inSpam = false; // Default to false in case of connection error
  } finally {
    await Promise.race([
      client.logout(),
      new Promise((_, reject) => setTimeout(() => reject("Timed out"), 5000)),
    ]);
    console.log(`Logged out from ${provider}.`);
    return inSpam;
  }
}

/**
 *
 * @param customId Custom Id that is in email to find the email in spam make sure to use the same customId as in subject
 * @param replyEmail Email from the configurations we are using to reply from make sure to use the same email as in user
 * @returns void
 * @error Handles errors and logs them to console.
 */
export async function CheckAndUpdateSpamInDb(
  customId: string,
  replyEmail: string | undefined,
  warmupId: string,
  emailTo: string
): Promise<{ shouldContinue: boolean; reason?: string }> {
  try {
    if (!customId || !replyEmail) {
      return {
        shouldContinue: false,
        reason: "Missing customId or replyEmail",
      };
    }

    const emailCredentials = await getEmailCredentials(replyEmail);

    // Finding the correct configuration for the reply email to use is to fetch spam folder
    if (!emailCredentials) {
      Logger.error("[CheckAndUpdateSpamInDb] Email Credentials not found", {
        email: replyEmail,
      });
      return { shouldContinue: false, reason: "Email credentials not found" };
    }

    const { emailId: user, password: pass, service } = emailCredentials;

    const result = await checkEmailInSpam(
      {
        subject: customId,
      },
      service,
      { user, pass }
    );

    if (result) {
      await logEmailResponse(warmupId, emailTo, "IN_SPAM");
    } else {
      Logger.info(`[CheckAndUpdateSpamInDb] Email is Not in Spam`);
    }

    return { shouldContinue: true };
  } catch (error) {
    // Check if this is an authentication error
    const errorMessage = error?.toString().toLowerCase() || "";
    const isAuthError =
      errorMessage.includes("authentication") ||
      errorMessage.includes("invalid credentials") ||
      errorMessage.includes("login failed") ||
      errorMessage.includes("auth") ||
      errorMessage.includes("535") || // SMTP auth error
      errorMessage.includes("534"); // SMTP auth error

    if (isAuthError && replyEmail) {
      Logger.criticalError(
        "[SpamCheck] Authentication failure detected:",
        {
          action: "Authentication Error",
          error,
          email: replyEmail,
          customId,
          emailTo,
        },
        ["Authentication failed"]
      );

      return {
        shouldContinue: false,
        reason: "Authentication failure",
      };
    }

    Logger.criticalError(
      "[SpamCheck] Error checking email:",
      {
        action: "Checking Email",
        error,
        customId,
        emailTo,
        sendingFrom: replyEmail,
      },
      ["Something Uncaught Error Happened While Checking Email"]
    );

    return { shouldContinue: false, reason: "General error occurred" };
  }
}
