import Imap, { Config } from "imap";
import { simpleParser, ParsedMail, Source } from "mailparser";
import { getEmailCredentials, logEmailResponse } from "./database";

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

  const openInbox = async (folderName: string): Promise<void> => {
    try {
      return new Promise((resolve, reject) => {
        imap.openBox(folderName, false, (err) => {
          if (err) {
            return reject(new Error(`Failed to open folder: ${folderName}`));
          }
          resolve();
        });
      });
    } catch (error: any) {
      console.error(`Error opening inbox: ${error.message}`);
    }
  };

  const searchEmails = async (): Promise<number[]> => {
    try {
      return new Promise((resolve, reject) => {
        imap.search(["UNSEEN"], (err, results) => {
          if (err) {
            return reject(new Error("Failed to search emails."));
          }
          resolve(results || []);
        });
      });
    } catch (error: any) {
      console.error(`Error searching emails: ${error.message}`);
      return [];
    }
  };


  const fetchEmails = async (results: number[]): Promise<boolean> => {
    try {
      return new Promise((resolve, reject) => {
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

   
      });
    } catch (error: any) {
      console.error(`Error fetching emails: ${error.message}`);
      return false;
    }
  };

  const connectImap = async (): Promise<void> => {
    try {
      return new Promise((resolve, reject) => {
        imap.once("ready", resolve);
        imap.once("error", (err: Error) =>
          reject(new Error(`IMAP connection error: ${err.message}`))
        );
        imap.connect();
      });
    } catch (error: any) {
      console.error(`Error connecting to IMAP: ${error.message}`);
      throw error;
    }
  };

  const endImapConnection = async (): Promise<void> => {
    try {
      return new Promise((resolve) => {
        imap.once("end", () => {
          resolve();
        });
        imap.end();
      });
    } catch (error: any) {
      console.error(`Error ending IMAP connection: ${error.message}`);
      throw error;
    }
  };

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
    console.error("Error in checkEmailInSpam:", err);
    await endImapConnection();
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

    const emailCredentials = await getEmailCredentials(replyEmail);

    // Finding the correct configuration for the reply email to use is to fetch spam folder
    if (!emailCredentials) {
      console.log("Email Credentials not found");
      return;
    }


    const { emailId: user, password: pass } = emailCredentials;

    const result = await checkEmailInSpam({
      email: user,
      password: pass,
      customId,
    });

    if (result) {
      if (result.isInSpam) {
        await logEmailResponse(warmupId, emailTo, "SPAM");
        console.log("Email is in Spam");
      } else {
        console.log("Email is Not in Spam");
      }
    }
  } catch (error) {
    console.error("Error checking email:", error);
  }
}
