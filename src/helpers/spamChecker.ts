import Imap, { Config } from "imap";
import { simpleParser, ParsedMail, Source } from "mailparser";
import { CONFIGURATIONS } from "../data/mail-configuration";
import { logEmailResponse } from "./database";

interface CheckEmailInSpamOptions {
  email: string;
  password: string;
  customId: string;
}

interface SpamCheckResult {
  customId: string;
  isInSpam: boolean;
  email: string;
}

/**
 * Helper function to Check if an email is in Spam or not.
 * @param {CheckEmailInSpamOptions} options - Options for checking an email in Spam.
 * @returns {Promise<SpamCheckResult | undefined>} - Promise that resolves to a SpamCheckResult object or undefined if the email is not in Spam.
 */
export async function checkEmailInSpam({
  email,
  password,
  customId,
}: CheckEmailInSpamOptions): Promise<SpamCheckResult | undefined> {
  const imapConfig: Config = {
    user: email,
    password: password,
    host: "imap.gmail.com",
    port: 993,
    tls: true,
    tlsOptions: { rejectUnauthorized: false }, // Ignore self-signed certificates
  };

  const imap = new Imap(imapConfig);

  const openInbox = (folderName: string): Promise<void> =>
    new Promise((resolve, reject) => {
      imap.openBox(folderName, false, (err) => {
        if (err) {
          return reject(new Error(`Failed to open folder: ${folderName}`));
        }
       
        resolve();
      });
    });

  const searchEmails = (): Promise<number[]> =>
    new Promise((resolve, reject) => {
      imap.search(["UNSEEN"], (err, results) => {
        if (err) {
          return reject(new Error("Failed to search emails."));
        }
        console.log(results);
        resolve(results || []);
      });
    });

  const markEmailAsRead = (seqno: number): Promise<void> =>
    new Promise((resolve, reject) => {
      // TODO: this is not working
      
      imap.addFlags(seqno, "\\Seen", (err) => {
        if (err) {
          return reject(
            new Error(`Failed to mark email as read: ${err.message}`)
          );
        }
        resolve();
      });
    });

  const fetchEmails = (results: number[]): Promise<boolean> =>
    new Promise((resolve, reject) => {
      if (results.length === 0) {
        return resolve(false);
      }

      const f = imap.fetch(results, { bodies: "", markSeen: true });
      let emailFound = false;

      f.on("message", (msg, seqno) => {
        msg.on("body", (stream: Source) => {
          simpleParser(stream, async (err: Error | null, mail: ParsedMail) => {
            if (err) {
              return reject(new Error("Failed to parse email."));
            }

            const subject = mail.subject || "";
            if (subject.includes(customId)) {
              emailFound = true;
              await markEmailAsRead(seqno);
              resolve(true);
            } else {
              resolve(false);
            }
          });
        });
      });

      f.once("error", (err) => {
        reject(new Error(`Failed to fetch messages: ${err.message}`));
      });

      // TODO: Fix this Was Getting Issue this was called before the email was found
      //   f.once("end", () => {
      //     console.log("Ending", emailFound);
      //     resolve(emailFound); // Resolve the promise with the final value of emailFound
      //   });
    });

  const connectImap = (): Promise<void> =>
    new Promise((resolve, reject) => {
      imap.once("ready", resolve);
      imap.once("error", (err: Error) =>
        reject(new Error(`IMAP connection error: ${err.message}`))
      );
      imap.connect();
    });

  const endImapConnection = (): Promise<void> =>
    new Promise((resolve) => {
      imap.once("end", () => {
        console.log("IMAP Connection ended");
        resolve();
      });
      imap.end();
    });

  try {
    await connectImap();
    // TODO: Add support for other email services
    await openInbox("[Gmail]/Spam"); // Correct path for the Spam folder
    const results = await searchEmails();
    const isInSpam = await fetchEmails(results);
    await endImapConnection();

    return {
      customId,
      isInSpam,
      email,
    };
  } catch (err) {
    console.log("Error", err);
    await endImapConnection();
    throw err;
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
) {
  try {
    if (!customId || !replyEmail) {
      return;
    }

    // Finding the correct configuration for the reply email to use is to fetch spam folder
    const emailCredentials = CONFIGURATIONS.find(
      (config) => config.user === replyEmail
    );
    if (!emailCredentials) {
      console.log("Email Credentials not found");
      return;
    }

    const { user, pass } = emailCredentials;

    // TODO: Functions is inside try still throwing errors and crashing the server
    const result = await checkEmailInSpam({
      email: user,
      password: pass,
      customId,
    });

    if (result) {
      if (result.isInSpam) {
        // await logEmailResponse(warmupId, emailTo, "SPAM");
        // TODO: Check Mark the email as read in gmail
        console.log("Email is in Spam");
      } else {
        console.log("Email is Not in Spam");
      }
    }
  } catch (error) {
    console.error("Error checking email:", error);
  }
}
